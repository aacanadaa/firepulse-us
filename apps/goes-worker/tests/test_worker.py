import hashlib
import hmac
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

import h5py
import numpy as np

from firepulse_goes import worker
from firepulse_goes.fdc import FireFile, Detection, read_fire_file, scan_to_latlon

GOES_EAST = dict(lon0_deg=-75.0, h_sat=35786023.0, r_eq=6378137.0, r_pol=6356752.31414)


class Projection(unittest.TestCase):
    def test_matches_the_product_user_guide_example(self):
        # GOES-R PUG vol. 5, 4.2.8.1: x=-0.024052, y=0.095340 rad from GOES-East.
        lat, lon = scan_to_latlon(np.array([-0.024052]), np.array([0.095340]), **GOES_EAST)
        self.assertAlmostEqual(lat[0], 33.846162, places=3)
        self.assertAlmostEqual(lon[0], -84.690932, places=3)

    def test_off_earth_angles_are_nan(self):
        lat, _ = scan_to_latlon(np.array([0.2]), np.array([0.2]), **GOES_EAST)
        self.assertTrue(np.isnan(lat[0]))


def synthetic_file(path):
    """A 2x3 FDC file: a processed fire, a high-probability fire, a low-probability pixel."""
    with h5py.File(path, "w") as f:
        f.attrs["time_coverage_start"] = np.bytes_(b"2026-10-23T20:01:17.2Z")
        f.attrs["platform_ID"] = np.bytes_(b"G19")
        mask = np.array([[0, 10, 15], [13, 0, 0]], dtype=np.int16)
        f.create_dataset("Mask", data=mask)
        f.create_dataset("Power", data=np.array([[-9, 42.5, 3.0], [-9, -9, -9]], dtype=np.float32))
        f["Power"].attrs["_FillValue"] = np.array([-9.0], dtype=np.float32)
        x = f.create_dataset("x", data=np.array([0, 1, 2], dtype=np.int16))
        x.attrs["scale_factor"] = np.array([0.001], dtype=np.float32)
        x.attrs["add_offset"] = np.array([-0.0250], dtype=np.float32)
        y = f.create_dataset("y", data=np.array([0, 1], dtype=np.int16))
        y.attrs["scale_factor"] = np.array([-0.001], dtype=np.float32)
        y.attrs["add_offset"] = np.array([0.0960], dtype=np.float32)
        p = f.create_dataset("goes_imager_projection", data=np.int32(-2147483647))
        p.attrs["longitude_of_projection_origin"] = np.array([-75.0])
        p.attrs["perspective_point_height"] = np.array([35786023.0])
        p.attrs["semi_major_axis"] = np.array([6378137.0])
        p.attrs["semi_minor_axis"] = np.array([6356752.31414])


class ReadFile(unittest.TestCase):
    def test_reads_fire_pixels_and_skips_low_probability(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "fdcc.nc")
            synthetic_file(path)
            fire = read_fire_file(path)
        self.assertEqual(fire.platform, "G19")
        self.assertEqual(fire.scan_start, datetime(2026, 10, 23, 20, 1, 17, tzinfo=timezone.utc))
        self.assertEqual(sorted(d.mask for d in fire.detections), [10, 13])
        processed = next(d for d in fire.detections if d.mask == 10)
        self.assertEqual(processed.frp, 42.5)
        self.assertTrue(30 < processed.lat < 40 and -90 < processed.lon < -80)
        self.assertIsNone(next(d for d in fire.detections if d.mask == 13).frp)


class Worker(unittest.TestCase):
    def test_reads_scan_start_from_file_names(self):
        key = "ABI-L2-FDCC/2026/296/09/OR_ABI-L2-FDCC-M6_G19_s20262960901180_e2026296_c2026296.nc"
        self.assertEqual(worker.file_start(key), datetime(2026, 10, 23, 9, 1, 18, tzinfo=timezone.utc))

    def test_lists_every_hour_in_the_window_across_midnight(self):
        now = datetime(2026, 10, 24, 0, 30, tzinfo=timezone.utc)
        self.assertEqual(
            worker.hour_prefixes(now, 120),
            ["ABI-L2-FDCC/2026/296/22/", "ABI-L2-FDCC/2026/296/23/", "ABI-L2-FDCC/2026/297/00/"],
        )

    def test_payloads_are_compact_batched_and_signed(self):
        fire = FireFile("G18", datetime(2026, 10, 23, 20, 1, tzinfo=timezone.utc), [Detection(38.1, -120.2, 10, 12.5)] * 5001)
        bodies = worker.payloads("goes18", fire)
        self.assertEqual(len(bodies), 2)
        first = json.loads(bodies[0])
        self.assertEqual(first["source"], "goes18")
        self.assertEqual(first["scanStart"], "2026-10-23T20:01:00Z")
        self.assertEqual(len(first["detections"]), 5000)
        self.assertNotIn(b" ", bodies[0])
        expected = "sha256=" + hmac.new(b"s3cret", bodies[0], hashlib.sha256).hexdigest()
        self.assertEqual(worker.sign(bodies[0], "s3cret"), expected)

    def test_due_skips_sent_and_too_old_files(self):
        w = worker.Worker("http://api", None, ["goes19"], backfill_min=30)
        now = datetime(2026, 10, 23, 20, 30, tzinfo=timezone.utc)
        keys = [
            "ABI-L2-FDCC/2026/296/19/x_s20262961955000_e.nc",
            "ABI-L2-FDCC/2026/296/20/x_s20262962010000_e.nc",
            "ABI-L2-FDCC/2026/296/20/x_s20262962025000_e.nc",
        ]
        with mock.patch.object(worker, "list_keys", side_effect=lambda sat, prefix: [k for k in keys if k.startswith(prefix)]):
            w.done[keys[1]] = now
            self.assertEqual(w.due("goes19", now), [keys[2]])


if __name__ == "__main__":
    unittest.main()
