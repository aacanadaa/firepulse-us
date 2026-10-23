"""Polls NOAA's public GOES buckets for new CONUS fire files and posts the
fire pixels to the FirePulse API (POST /api/v1/hooks/thermal).

Environment:
  FIREPULSE_API_URL       default http://127.0.0.1:8790
  INGEST_WEBHOOK_SECRET   signs each post (required by the API in production)
  GOES_SATELLITES         default "goes18,goes19"
  GOES_POLL_SECONDS       default 60
  GOES_BACKFILL_MINUTES   default 120 (the API's GOES evidence window)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from .fdc import FireFile, read_fire_file

PRODUCT = "ABI-L2-FDCC"
USER_AGENT = os.environ.get("FIREPULSE_USER_AGENT", "FirePulse GOES worker")
FILE_START = re.compile(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})")
BATCH = 5000

log = logging.getLogger("firepulse.goes")


def file_start(key: str) -> datetime | None:
    """Scan start encoded in a GOES file name: _sYYYYJJJHHMMSS."""
    m = FILE_START.search(key)
    if not m:
        return None
    year, doy, hh, mm, ss = (int(g) for g in m.groups())
    return datetime(year, 1, 1, hh, mm, ss, tzinfo=timezone.utc) + timedelta(days=doy - 1)


def hour_prefixes(now: datetime, minutes: int) -> list[str]:
    """Bucket prefixes covering the last `minutes`, oldest first."""
    out = []
    t = (now - timedelta(minutes=minutes)).replace(minute=0, second=0, microsecond=0)
    while t <= now:
        out.append(f"{PRODUCT}/{t:%Y}/{t.timetuple().tm_yday:03d}/{t:%H}/")
        t += timedelta(hours=1)
    return out


def _get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def list_keys(satellite: str, prefix: str) -> list[str]:
    body = _get(f"https://noaa-{satellite}.s3.amazonaws.com/?list-type=2&prefix={prefix}").decode()
    return re.findall(r"<Key>([^<]+\.nc)</Key>", body)


def download(satellite: str, key: str) -> str:
    data = _get(f"https://noaa-{satellite}.s3.amazonaws.com/{key}", timeout=120)
    fd, path = tempfile.mkstemp(suffix=".nc", prefix="fdcc-")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


def sign(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def payloads(satellite: str, fire: FireFile) -> list[bytes]:
    """The API request bodies for one file, in batches."""
    dets = [{"lat": d.lat, "lon": d.lon, "mask": d.mask, **({"frp": d.frp} if d.frp is not None else {})} for d in fire.detections]
    start = fire.scan_start.strftime("%Y-%m-%dT%H:%M:%SZ")
    chunks = [dets[i : i + BATCH] for i in range(0, len(dets), BATCH)] or [[]]
    return [json.dumps({"source": satellite, "scanStart": start, "detections": c}, separators=(",", ":")).encode() for c in chunks]


def post(api: str, body: bytes, secret: str | None) -> dict:
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    if secret:
        headers["X-FirePulse-Signature"] = sign(body, secret)
    req = urllib.request.Request(f"{api}/api/v1/hooks/thermal", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read() or b"{}")


class Worker:
    def __init__(self, api: str, secret: str | None, satellites: list[str], backfill_min: int) -> None:
        self.api = api.rstrip("/")
        self.secret = secret
        self.satellites = satellites
        self.backfill = timedelta(minutes=backfill_min)
        self.done: dict[str, datetime] = {}

    def due(self, satellite: str, now: datetime) -> list[str]:
        """New files for one satellite, oldest first, within the backfill window."""
        oldest = now - self.backfill
        keys = []
        for prefix in hour_prefixes(now, int(self.backfill.total_seconds() // 60)):
            keys += list_keys(satellite, prefix)
        out = []
        for key in sorted(set(keys)):
            start = file_start(key)
            if start is None or start < oldest or key in self.done:
                continue
            out.append(key)
        return out

    def run_once(self, now: datetime | None = None) -> int:
        now = now or datetime.now(timezone.utc)
        sent = 0
        for satellite in self.satellites:
            try:
                keys = self.due(satellite, now)
            except (urllib.error.URLError, TimeoutError) as err:
                log.warning("listing %s failed: %s", satellite, err)
                continue
            for key in keys:
                path = None
                try:
                    path = download(satellite, key)
                    fire = read_fire_file(path)
                    for body in payloads(satellite, fire):
                        result = post(self.api, body, self.secret)
                        sent += int(result.get("accepted", 0))
                    self.done[key] = file_start(key) or now
                    log.info("%s %s: %d fire pixels", satellite, fire.scan_start.isoformat(), len(fire.detections))
                except urllib.error.HTTPError as err:
                    log.warning("%s %s: API answered %s; will retry", satellite, key, err.code)
                    break
                except (urllib.error.URLError, TimeoutError, OSError) as err:
                    log.warning("%s %s: %s; will retry", satellite, key, err)
                    break
                except Exception as err:  # a corrupt file must not stop the feed
                    log.warning("%s %s: unreadable (%s); skipping", satellite, key, err)
                    self.done[key] = file_start(key) or now
                finally:
                    if path:
                        os.unlink(path)
        # Remember only what can still come back in a listing.
        cutoff = now - self.backfill - timedelta(hours=1)
        self.done = {k: t for k, t in self.done.items() if t >= cutoff}
        return sent


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(levelname)s %(message)s")
    worker = Worker(
        api=os.environ.get("FIREPULSE_API_URL", "http://127.0.0.1:8790"),
        secret=os.environ.get("INGEST_WEBHOOK_SECRET") or None,
        satellites=[s.strip() for s in os.environ.get("GOES_SATELLITES", "goes18,goes19").split(",") if s.strip()],
        backfill_min=int(os.environ.get("GOES_BACKFILL_MINUTES", "120")),
    )
    interval = int(os.environ.get("GOES_POLL_SECONDS", "60"))
    log.info("watching %s every %ds, posting to %s", ",".join(worker.satellites), interval, worker.api)
    while True:
        try:
            worker.run_once()
        except Exception:  # keep the loop alive; the next poll retries
            log.exception("poll failed")
        if "--once" in sys.argv:
            return
        time.sleep(interval)


if __name__ == "__main__":
    main()
