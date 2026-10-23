# GOES fire worker

Posts geostationary fire detections to the FirePulse API every few minutes,
so a new fire can show up minutes after it starts instead of after the next
polar-orbiting satellite pass.

It polls NOAA's public buckets (`noaa-goes18`, `noaa-goes19`) for the ABI
Fire/Hot Spot Characterization product over CONUS (`ABI-L2-FDCC`, one file
every 5 minutes per satellite), reads the fire pixels, converts their scan
angles to latitude/longitude, and posts them to `POST /api/v1/hooks/thermal`.
Each post is signed with `INGEST_WEBHOOK_SECRET`. No NOAA account or key is
needed.

GOES-18 is GOES-West and GOES-19 is GOES-East (it replaced GOES-16 in 2025).
Pixels are about 2 km across, so a GOES detection marks the area a fire is
in, not its exact position. Low-probability pixels (mask 15/35) are skipped;
the API maps the other fire classes to a confidence.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
FIREPULSE_API_URL=http://127.0.0.1:8790 INGEST_WEBHOOK_SECRET=... .venv/bin/python -m firepulse_goes.worker
.venv/bin/python -m unittest discover -s tests     # tests
```

| Variable | Default | |
|---|---|---|
| `FIREPULSE_API_URL` | `http://127.0.0.1:8790` | where to post |
| `INGEST_WEBHOOK_SECRET` | none | must match the API's |
| `GOES_SATELLITES` | `goes18,goes19` | |
| `GOES_POLL_SECONDS` | `60` | |
| `GOES_BACKFILL_MINUTES` | `120` | how far back to read on start (the API's GOES evidence window) |

`--once` processes what's new and exits.
