"""Reads GOES-R ABI Fire/Hot Spot Characterization (FDC) NetCDF files.

The files are NetCDF4, which is HDF5 underneath, so h5py reads them
without the netCDF stack. Pixel positions are scan angles in the
geostationary projection; ``scan_to_latlon`` converts them with the
formulas in the GOES-R Product User Guide, volume 5, section 4.2.8.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import h5py
import numpy as np

# Fire mask classes: 10-15 instantaneous, 30-35 temporally filtered.
# 15/35 are low probability and are not sent.
FIRE_MASKS = (10, 11, 12, 13, 14, 30, 31, 32, 33, 34)


@dataclass(frozen=True)
class Detection:
    lat: float
    lon: float
    mask: int
    frp: float | None


@dataclass(frozen=True)
class FireFile:
    platform: str
    scan_start: datetime
    detections: list[Detection]


def scan_to_latlon(
    x: np.ndarray,
    y: np.ndarray,
    lon0_deg: float,
    h_sat: float,
    r_eq: float,
    r_pol: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Scan angles (radians) to geodetic latitude and longitude (degrees)."""
    h = h_sat + r_eq
    lon0 = np.radians(lon0_deg)
    sin_x, cos_x = np.sin(x), np.cos(x)
    sin_y, cos_y = np.sin(y), np.cos(y)
    a = sin_x**2 + cos_x**2 * (cos_y**2 + (r_eq**2 / r_pol**2) * sin_y**2)
    b = -2.0 * h * cos_x * cos_y
    c = h**2 - r_eq**2
    disc = b**2 - 4.0 * a * c
    with np.errstate(invalid="ignore"):
        r_s = (-b - np.sqrt(disc)) / (2.0 * a)
    s_x = r_s * cos_x * cos_y
    s_y = -r_s * sin_x
    s_z = r_s * cos_x * sin_y
    lat = np.degrees(np.arctan((r_eq**2 / r_pol**2) * (s_z / np.sqrt((h - s_x) ** 2 + s_y**2))))
    lon = np.degrees(lon0 - np.arctan(s_y / (h - s_x)))
    # Off-earth pixels have no solution.
    bad = disc < 0
    return np.where(bad, np.nan, lat), np.where(bad, np.nan, lon)


def _attr(var, name, default=None):
    v = var.attrs.get(name, default)
    if isinstance(v, np.ndarray):
        v = v.item() if v.size == 1 else v
    return v


def _text(v) -> str:
    return v.decode() if isinstance(v, (bytes, np.bytes_)) else str(v)


def read_fire_file(path: str) -> FireFile:
    with h5py.File(path, "r") as f:
        mask = f["Mask"][:]
        rows, cols = np.nonzero(np.isin(mask, FIRE_MASKS))
        xv, yv = f["x"], f["y"]
        x = xv[:][cols] * _attr(xv, "scale_factor", 1.0) + _attr(xv, "add_offset", 0.0)
        y = yv[:][rows] * _attr(yv, "scale_factor", 1.0) + _attr(yv, "add_offset", 0.0)
        proj = f["goes_imager_projection"]
        lat, lon = scan_to_latlon(
            x.astype(np.float64),
            y.astype(np.float64),
            float(_attr(proj, "longitude_of_projection_origin")),
            float(_attr(proj, "perspective_point_height")),
            float(_attr(proj, "semi_major_axis")),
            float(_attr(proj, "semi_minor_axis")),
        )
        power = f["Power"]
        frp = power[:][rows, cols] if len(rows) else np.array([])
        fill = _attr(power, "_FillValue", None)
        start = _text(f.attrs["time_coverage_start"])
        platform = _text(f.attrs.get("platform_ID", b"G00"))

    detections = []
    for i in range(len(rows)):
        if not (np.isfinite(lat[i]) and np.isfinite(lon[i])):
            continue
        p = float(frp[i])
        valid = np.isfinite(p) and p > 0 and (fill is None or p != float(fill))
        detections.append(
            Detection(lat=round(float(lat[i]), 4), lon=round(float(lon[i]), 4), mask=int(mask[rows[i], cols[i]]), frp=round(p, 2) if valid else None)
        )
    scan_start = datetime.strptime(start.rstrip("Z")[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    return FireFile(platform=platform, scan_start=scan_start, detections=detections)
