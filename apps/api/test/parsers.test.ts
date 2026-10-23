import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bufferedHull,
  convexHull,
  dbscan,
  destination,
  haversineKm,
  pointInRing,
  ringAreaSqKm,
} from "@firepulse/protocol";
import {
  firmsDayRange,
  mergeOfficialBatches,
  parseFirmsCsv,
  parseFirmsTime,
  parseWfigsGeoJSON,
} from "../src/sources/live.js";
import { cellOf } from "../src/h3.js";

const now = Date.parse("2026-10-20T12:00:00Z");

describe("geometry", () => {
  it("computes great-circle distance", () => {
    const d = haversineKm({ lon: -118.24, lat: 34.05 }, { lon: -122.42, lat: 37.77 });
    expect(d).toBeGreaterThan(540);
    expect(d).toBeLessThan(580);
  });

  it("builds a convex hull that contains its inputs", () => {
    const pts = [
      { lon: -119.3, lat: 34.4 },
      { lon: -119.28, lat: 34.45 },
      { lon: -119.32, lat: 34.42 },
      { lon: -119.29, lat: 34.41 },
      { lon: -119.31, lat: 34.44 },
    ];
    const hull = convexHull(pts);
    // Vertices lie exactly on the boundary, where ray casting is ambiguous;
    // assert the interior and the bounding box instead.
    expect(pointInRing({ lon: -119.3, lat: 34.425 }, hull)).toBe(true);
    const xs = hull.map(([x]) => x);
    const ys = hull.map(([, y]) => y);
    for (const p of pts) {
      expect(p.lon).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-9);
      expect(p.lon).toBeLessThanOrEqual(Math.max(...xs) + 1e-9);
      expect(p.lat).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-9);
      expect(p.lat).toBeLessThanOrEqual(Math.max(...ys) + 1e-9);
    }
    expect(hull.length).toBeGreaterThanOrEqual(4);
    expect(hull[0]).toEqual(hull[hull.length - 1]);
  });

  it("buffers a hull outward with a Minkowski sum", () => {
    const pts = [
      { lon: -119.3, lat: 34.4 },
      { lon: -119.28, lat: 34.4 },
      { lon: -119.29, lat: 34.42 },
    ];
    const bare = ringAreaSqKm(convexHull(pts));
    const buffered = ringAreaSqKm(bufferedHull(pts, 0.4));
    expect(buffered).toBeGreaterThan(bare * 2);
    // every original vertex remains inside the buffered zone
    for (const p of pts) expect(pointInRing(p, bufferedHull(pts, 0.4))).toBe(true);
  });

  it("projects points along bearings", () => {
    const p = destination({ lon: -119, lat: 34 }, 90, 10);
    expect(p.lon).toBeGreaterThan(-119);
    expect(Math.abs(p.lat - 34)).toBeLessThan(0.01);
  });

  it("DBSCAN separates distant fires and merges nearby detections", () => {
    const points = [
      { id: "a1", lon: -119.3, lat: 34.4 },
      { id: "a2", lon: -119.301, lat: 34.401 },
      { id: "a3", lon: -119.299, lat: 34.402 },
      { id: "b1", lon: -121.0, lat: 39.0 },
      { id: "b2", lon: -121.001, lat: 39.001 },
    ];
    const { clusters, noise } = dbscan(points, { epsKm: 2, minPts: 1 });
    expect(clusters.length).toBe(2);
    expect(noise.length).toBe(0);
    const sizes = clusters.map((c) => c.members.length).sort();
    expect(sizes).toEqual([2, 3]);
  });
});

describe("FIRMS parser", () => {
  const csv = `country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
US,34.4841,-119.3124,331.2,0.4,0.4,2026-10-19,0230,NOAA-20,VIIRS,n,2.0NRT,295.1,12.4,N
US,40.7521,-122.3182,310.0,0.4,0.4,2026-10-19,0230,NOAA-21,VIIRS,h,2.0NRT,290.0,3.1,N
US,35.0,-111.7,305.0,1,1,2026-10-19,0235,Terra,MODIS,80,6.1,290,50.0,N`;

  it("parses VIIRS/MODIS rows into normalised thermal signals", () => {
    const signals = parseFirmsCsv(csv, { source: "viirs" });
    expect(signals).toHaveLength(3);
    const first = signals[0]!;
    expect(first.source).toBe("viirs");
    expect(first.kind).toBe("thermal");
    expect(first.lon).toBeCloseTo(-119.3124, 3);
    expect(first.lat).toBeCloseTo(34.4841, 3);
    expect(first.observedAt).toBe("2026-10-19T02:30:00.000Z");
    expect(first.frp).toBeCloseTo(12.4, 2);
    expect(first.providerConfidence).toBeCloseTo(0.65, 2);
    expect(first.meta?.dedupeKey).toBe(first.id);
    expect(first.meta?.satellite).toBe("NOAA-20");
  });

  it("maps nominal/high confidence letters correctly", () => {
    const signals = parseFirmsCsv(csv, { source: "viirs" });
    expect(signals[1]!.providerConfidence).toBeCloseTo(0.9, 2);
  });

  it("formats FIRMS acquisition timestamps", () => {
    expect(parseFirmsTime("2026-10-19", "0230")).toBe("2026-10-19T02:30:00.000Z");
    expect(parseFirmsTime("2026-10-19", "5")).toBe("2026-10-19T05:00:00.000Z");
    expect(parseFirmsTime("bad", "0230")).toMatch(/T/);
  });

  it("records which FIRMS product a detection came from", () => {
    const signals = parseFirmsCsv(csv, { source: "viirs", product: "VIIRS_NOAA21_NRT" });
    expect(signals[0]!.meta?.product).toBe("VIIRS_NOAA21_NRT");
  });

  it("asks FIRMS for every UTC date the poll window touches", () => {
    const noon = Date.parse("2026-10-20T12:00:00Z");
    expect(firmsDayRange(noon, noon - 10 * 60_000)).toBe(1);
    expect(firmsDayRange(noon, noon - 10 * 60_000, 2)).toBe(2);
    expect(firmsDayRange(noon, noon - 30 * 3_600_000)).toBe(2);
    // Recorded 2026-10-23T02:08Z: days=2 returned only 2026-10-22, because
    // "today" had no detections yet. A 30 h backfill needs three dates.
    const pastMidnight = Date.parse("2026-10-23T02:08:00Z");
    expect(firmsDayRange(pastMidnight, pastMidnight - 30 * 3_600_000)).toBe(3);
    expect(firmsDayRange(pastMidnight, pastMidnight - 10 * 60_000)).toBe(1);
    expect(firmsDayRange(noon, 0)).toBe(5);
  });

  it("returns nothing for an empty product", () => {
    expect(parseFirmsCsv("", { source: "modis" })).toEqual([]);
    expect(parseFirmsCsv("latitude,longitude\n", { source: "modis" })).toEqual([]);
  });
});

describe("WFIGS parser", () => {
  it("ingests official perimeter polygons", () => {
    const geo = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-119.34, 34.46],
                [-119.30, 34.46],
                [-119.30, 34.49],
                [-119.34, 34.49],
                [-119.34, 34.46],
              ],
            ],
          },
          properties: {
            IncidentName: "Ridge Fire",
            UniqueFireIdentifier: "2026-CA-VNC-001",
            CalculatedAcres: 1200,
            PercentContained: 35,
            POOState: "US-CA",
            POOCounty: "Ventura",
            FireCause: "Powerline",
            polygonDateTime: "2026-10-20T10:00:00Z",
          },
        },
      ],
    };
    const batch = parseWfigsGeoJSON(geo);
    expect(batch.features).toHaveLength(1);
    expect(batch.perimeters).toHaveLength(1);
    const p = batch.features[0]!.properties;
    expect(p.kind).toBe("official");
    expect(p.confidence).toBe(100);
    expect(p.name).toBe("Ridge Fire");
    expect(p.state).toBe("CA");
    expect(p.containment).toBe(35);
    expect(p.areaAcres).toBeGreaterThanOrEqual(1200);
    expect(batch.perimeters[0]!.agency).toBe("NIFC");
  });

  it("buffers point-only WFIGS incidents by acreage", () => {
    const geo = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-121.5, 39.5] },
          properties: {
            IncidentName: "Point Fire",
            UniqueFireIdentifier: "abc123",
            CalculatedAcres: 4000,
            POOState: "CA",
          },
        },
      ],
    };
    const batch = parseWfigsGeoJSON(geo);
    expect(batch.features).toHaveLength(1);
    expect(batch.features[0]!.geometry.coordinates[0]!.length).toBeGreaterThan(20);
    expect(batch.perimeters[0]!.acres).toBe(4000);
  });

  describe("recorded WFIGS responses", () => {
    const fixture = (name: string) =>
      JSON.parse(readFileSync(join(__dirname, "fixtures", "wfigs", name), "utf8")) as unknown;
    const perimeters = parseWfigsGeoJSON(fixture("perimeters.geojson"));
    const incidents = parseWfigsGeoJSON(fixture("incidents.geojson"));

    it("reads the attr_/poly_ prefixed fields of the perimeter layer", () => {
      expect(perimeters.features).toHaveLength(1);
      const p = perimeters.features[0]!.properties;
      expect(p.id).toBe("wfigs-2026-COLSX-001549");
      expect(p.name).toBe("Post");
      expect(p.state).toBe("CO");
      expect(p.containment).toBe(100);
      expect(p.status).toBe("contained");
      expect(p.cause).toBe("lightning");
      expect(p.areaAcres).toBeGreaterThanOrEqual(4335);
      expect(Date.parse(p.firstDetectedAt)).toBeLessThanOrEqual(Date.parse(p.officialSince!));
    });

    it("keeps the largest part of a multi-part perimeter", () => {
      const ring = perimeters.features[0]!.geometry.coordinates[0]!;
      expect(ring.length).toBeGreaterThan(40);
      expect(perimeters.perimeters[0]!.geom.coordinates[0]).toBe(ring);
    });

    it("tags prescribed burns and buffers point-only incidents", () => {
      expect(incidents.features).toHaveLength(3);
      const rx = incidents.features.find((f) => f.properties.name === "2026 Alut Ave Project RX")!;
      expect(rx.properties.cause).toBe("prescribed");
      const national = incidents.features.find((f) => f.properties.name === "National")!;
      expect(national.properties.cause).toBe("human");
      expect(national.geometry.coordinates[0]!.length).toBe(37);
    });

    it("lets a mapped perimeter win over the same incident's point", () => {
      const merged = mergeOfficialBatches(perimeters, incidents);
      expect(merged.features.map((f) => f.properties.name).sort()).toEqual(["2026 Alut Ave Project RX", "National", "Post"]);
      const post = merged.features.find((f) => f.properties.name === "Post")!;
      expect(post.geometry.coordinates[0]!.length).toBeGreaterThan(40);
      expect(merged.perimeters.filter((p) => p.incidentId === post.id)).toHaveLength(1);
    });
  });

  it("skips incidents that have been declared out and non-fire records", () => {
    const point = (props: Record<string, unknown>) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-121.5, 39.5] },
      properties: { IncidentName: "Old Fire", UniqueFireIdentifier: "x1", ...props },
    });
    const batch = parseWfigsGeoJSON({
      features: [
        point({ FireOutDateTime: 1792627621931 }),
        point({ IncidentTypeCategory: "FA" }),
        point({ IncidentTypeCategory: "WF" }),
      ],
    });
    expect(batch.features).toHaveLength(1);
  });

  it("ignores malformed collections", () => {
    expect(parseWfigsGeoJSON(null).features).toEqual([]);
    expect(parseWfigsGeoJSON({ features: [{ geometry: null }] }).features).toEqual([]);
  });
});

describe("H3", () => {
  it("maps coordinates to stable resolution-8 cells", () => {
    const a = cellOf(-119.312, 34.484);
    const b = cellOf(-119.3121, 34.4841);
    expect(a).toBe(b);
    expect(a).toHaveLength(15);
  });
});
