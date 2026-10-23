import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  circleRing,
  compassPoint,
  distanceToRingKm,
  simplifyRing,
  type HazardAlertFeature,
  type IncidentFeature,
  type Ring,
} from "@firepulse/protocol";
import { nearbySummary } from "../src/nearby.js";
import { HazardLayer } from "../src/realtime/hazards.js";
import { Geocoder, looksLikeStreetAddress, parseCensus, parsePhoton } from "../src/geocode.js";

const NOW = Date.parse("2026-10-22T20:00:00Z");
const HOME = { lon: -121.6, lat: 39.76 };

function fire(id: string, center: { lon: number; lat: number }, radiusKm: number, extra: Partial<IncidentFeature["properties"]> = {}): IncidentFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [circleRing(center, radiusKm, 48)] },
    properties: {
      id,
      kind: "official",
      name: id,
      status: "holding",
      confidence: 100,
      confidenceBreakdown: { score: 100, fused: 1, corroboration: 1, freshness: 1, distinctModalities: 1, evidenceCount: 1, rationale: "" },
      sources: [],
      firstDetectedAt: "2026-10-22T10:00:00.000Z",
      updatedAt: "2026-10-22T19:00:00.000Z",
      areaAcres: 1000,
      areaSqKm: 4,
      frp: 0,
      growthAcresPerHour: 0,
      growthFrpPerHour: 0,
      growthScore: 0,
      hotspotCount: 0,
      evidence: [],
      lat: center.lat,
      lon: center.lon,
      ...extra,
    },
  };
}

describe("geodesy helpers", () => {
  const square: Ring = [
    [-121, 39],
    [-120, 39],
    [-120, 40],
    [-121, 40],
    [-121, 39],
  ];

  it("measures to the nearest edge, and 0 inside", () => {
    expect(distanceToRingKm({ lon: -120.5, lat: 39.5 }, square)).toBe(0);
    // 0.1° of longitude west of the west edge at 39.5°N ≈ 8.6 km.
    expect(distanceToRingKm({ lon: -121.1, lat: 39.5 }, square)).toBeCloseTo(8.6, 0);
  });

  it("names compass directions", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(359)).toBe("N");
    expect(compassPoint(225)).toBe("SW");
    expect(compassPoint(-90)).toBe("W");
  });

  it("simplifies a dense ring and keeps it closed", () => {
    const dense = circleRing({ lon: -120, lat: 39 }, 10, 400);
    const simple = simplifyRing(dense, 0.01);
    expect(simple.length).toBeLessThan(dense.length / 4);
    expect(simple[0]).toEqual(simple[simple.length - 1]);
    expect(simplifyRing(square, 0.5)).toEqual(square);
  });
});

describe("nearby summary", () => {
  const evac: HazardAlertFeature = {
    type: "Feature",
    id: "evac",
    geometry: { type: "Polygon", coordinates: [circleRing(HOME, 5, 24)] },
    properties: {
      id: "evac",
      event: "Evacuation Immediate",
      severity: "Extreme",
      urgency: "Immediate",
      areaDesc: "Paradise",
      sender: "Butte County OES",
      sent: "2026-10-22T19:30:00.000Z",
      effective: "2026-10-22T19:30:00.000Z",
      expires: "2026-10-23T03:30:00.000Z",
      url: "https://api.weather.gov/alerts/evac",
    },
  };

  it("measures large fires from their edge, sorts nearest first and drops far ones", () => {
    const hazards = new HazardLayer();
    const incidents = [
      // Centre 30 km east, but 25 km across: its edge is ~5 km away.
      fire("big", { lon: HOME.lon + 0.35, lat: HOME.lat }, 25),
      fire("small", { lon: HOME.lon, lat: HOME.lat + 0.1 }, 0.5),
      fire("far", { lon: HOME.lon + 2, lat: HOME.lat }, 1),
      fire("absorbed", { lon: HOME.lon, lat: HOME.lat }, 1, { kind: "estimated", mergedInto: "big" }),
    ];
    const s = nearbySummary(HOME, 25, incidents, hazards, NOW);
    expect(s.fires.map((f) => f.id)).toEqual(["big", "small"]);
    expect(s.unconfirmedHeat).toBe(0);
    expect(s.fires[0]!.distanceKm).toBeGreaterThan(4);
    expect(s.fires[0]!.distanceKm).toBeLessThan(7);
    expect(s.fires[0]!.direction).toBe("E");
    expect(s.fires[1]!.direction).toBe("N");
  });

  it("counts single-pass satellite heat instead of listing it", () => {
    const s = nearbySummary(
      HOME,
      25,
      [
        fire("burn", { lon: HOME.lon + 0.05, lat: HOME.lat }, 0.3, { kind: "estimated", confirmation: "single", confidence: 40 }),
        fire("real", { lon: HOME.lon - 0.05, lat: HOME.lat }, 0.3, { kind: "estimated", confirmation: "persistent", confidence: 60 }),
      ],
      new HazardLayer(),
      NOW,
    );
    expect(s.fires.map((f) => f.id)).toEqual(["real"]);
    expect(s.fires[0]!.confirmation).toBe("persistent");
    expect(s.unconfirmedHeat).toBe(1);
  });

  it("reports zero distance from inside a perimeter and lists alerts covering the point", () => {
    const hazards = new HazardLayer();
    hazards.replace([evac]);
    const s = nearbySummary(HOME, 10, [fire("here", HOME, 2)], hazards, NOW);
    expect(s.fires[0]!.distanceKm).toBe(0);
    expect(s.alerts.map((a) => a.event)).toEqual(["Evacuation Immediate"]);
    const elsewhere = nearbySummary({ lon: -118, lat: 34 }, 10, [], hazards, NOW);
    expect(elsewhere.alerts).toHaveLength(0);
  });
});

describe("place search", () => {
  const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", "geocode", name), "utf8")) as unknown;

  it("routes street addresses to the Census geocoder", () => {
    expect(looksLikeStreetAddress("1600 Pennsylvania Ave NW, Washington DC")).toBe(true);
    expect(looksLikeStreetAddress("Paradise, CA")).toBe(false);
  });

  it("parses recorded Census and Photon responses", () => {
    const census = parseCensus(fixture("census-whitehouse.json"));
    expect(census[0]!.label).toMatch(/1600 PENNSYLVANIA AVE/);
    expect(census[0]!.lat).toBeCloseTo(38.8987, 3);

    const photon = parsePhoton(fixture("photon-paradise.json"));
    expect(photon.every((r) => r.source === "photon")).toBe(true);
    // Paradise, Newfoundland is filtered out; Paradise, Butte County is kept.
    expect(photon.some((r) => r.label.includes("Newfoundland"))).toBe(false);
    expect(photon.some((r) => r.label === "Paradise, Butte County, California")).toBe(true);
  });

  it("falls back to the other provider and caches results", async () => {
    const calls: string[] = [];
    const geocoder = new Geocoder({
      userAgent: "test",
      fetch: async (url) => {
        calls.push(new URL(url).host);
        if (url.includes("photon")) return new Response(JSON.stringify({ features: [] }));
        return new Response(JSON.stringify(fixture("census-whitehouse.json")));
      },
    });
    const results = await geocoder.search("White House", NOW);
    expect(calls).toEqual(["photon.komoot.io", "geocoding.geo.census.gov"]);
    expect(results[0]!.source).toBe("census");
    await geocoder.search("white  house", NOW + 1000);
    expect(calls).toHaveLength(2);
  });
});
