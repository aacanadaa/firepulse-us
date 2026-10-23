import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pino from "pino";
import type { HazardAlertFeature, RawSignal } from "@firepulse/protocol";
import {
  hazardContextSignals,
  isNwsZoneUrl,
  NwsZoneCache,
  parseNwsHazards,
  zonesToResolve,
} from "../src/sources/nws.js";
import { HazardLayer } from "../src/realtime/hazards.js";
import { FusionEngine } from "../src/fusion/engine.js";
import { MemoryStore } from "../src/store/memory.js";
import type { AppConfig } from "../src/config.js";

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", "nws", name), "utf8")) as unknown;

// Recorded 2026-10-22: one zone-based Red Flag Warning (WYZ281) and one
// zone-based Air Quality Alert. Neither carries its own polygon.
const ALERTS = fixture("alerts.json");
const WYZ281 = fixture("zone-WYZ281.json") as { geometry: HazardAlertFeature["geometry"] };
const RFW_ZONE = "https://api.weather.gov/zones/fire/WYZ281";
const NOW = Date.parse("2026-10-22T23:00:00Z");

describe("NWS hazard alerts", () => {
  it("lists the zones of alerts that have no polygon", () => {
    const zones = zonesToResolve(ALERTS);
    expect(zones).toContain(RFW_ZONE);
    expect(zones.some((z) => z.includes("/zones/forecast/TXZ213"))).toBe(true);
  });

  it("only fetches NWS zone endpoints", () => {
    expect(isNwsZoneUrl(RFW_ZONE)).toBe(true);
    expect(isNwsZoneUrl("https://example.com/zones/fire/WYZ281")).toBe(false);
    expect(isNwsZoneUrl("http://api.weather.gov/zones/fire/WYZ281")).toBe(false);
    expect(isNwsZoneUrl("https://api.weather.gov/alerts/active")).toBe(false);
  });

  it("outlines a zone-based alert with its zones and drops unresolved ones", () => {
    const alerts = parseNwsHazards(ALERTS, new Map([[RFW_ZONE, WYZ281.geometry]]), NOW);
    expect(alerts).toHaveLength(1);
    const rfw = alerts[0]!;
    expect(rfw.properties.event).toBe("Red Flag Warning");
    expect(rfw.geometry.type).toBe("MultiPolygon");
    expect(rfw.properties.areaDesc).toBe("Johnson County/Casper BLM");
    expect(rfw.properties.expires).toBe("2026-10-23T13:00:00.000Z");
    expect(rfw.properties.url).toMatch(/^https:\/\/api\.weather\.gov\/alerts\//);
  });

  it("keeps drawn polygons and ignores events FirePulse does not follow", () => {
    const ring = [
      [-119.9, 34.2],
      [-118.5, 34.2],
      [-118.5, 35.1],
      [-119.9, 35.1],
      [-119.9, 34.2],
    ];
    const alerts = parseNwsHazards({
      features: [
        {
          id: "https://api.weather.gov/alerts/urn:oid:evac",
          geometry: { type: "Polygon", coordinates: [ring] },
          properties: { id: "urn:oid:evac", event: "Evacuation Immediate", sent: "2026-10-20T06:00:00Z" },
        },
        {
          id: "https://api.weather.gov/alerts/urn:oid:flood",
          geometry: { type: "Polygon", coordinates: [ring] },
          properties: { id: "urn:oid:flood", event: "Flood Watch" },
        },
      ],
    });
    expect(alerts.map((a) => a.properties.event)).toEqual(["Evacuation Immediate"]);
    expect(alerts[0]!.geometry.type).toBe("Polygon");
  });

  it("turns fire-weather alerts, not smoke alerts, into context signals", () => {
    const alerts = parseNwsHazards(ALERTS, new Map([[RFW_ZONE, WYZ281.geometry]]), NOW);
    const signals = hazardContextSignals(alerts, new Date(NOW).toISOString());
    expect(signals).toHaveLength(1);
    expect(signals[0]!.source).toBe("nws");
    expect(signals[0]!.kind).toBe("weather");
    expect(Array.isArray(signals[0]!.meta?.polygon)).toBe(true);
  });
});

describe("NWS zone cache", () => {
  it("fetches each zone once and retries failures only after a pause", async () => {
    const calls: string[] = [];
    const cache = new NwsZoneCache(async (url) => {
      calls.push(url);
      if (url.endsWith("BAD")) throw new Error("404");
      return WYZ281;
    });
    const bad = "https://api.weather.gov/zones/fire/BAD";
    const first = await cache.resolve([RFW_ZONE, bad], NOW);
    expect(first.zones.size).toBe(1);
    expect(first.failed).toBe(1);

    const second = await cache.resolve([RFW_ZONE, bad], NOW + 60_000);
    expect(second.zones.size).toBe(1);
    expect(calls).toHaveLength(2);

    await cache.resolve([bad], NOW + 2 * 3_600_000);
    expect(calls).toHaveLength(3);
  });

  it("flattens zones that come back as a geometry collection", async () => {
    const square = (x: number) => [[[x, 29], [x + 0.1, 29], [x + 0.1, 29.1], [x, 29]]];
    const cache = new NwsZoneCache(async () => ({
      geometry: {
        type: "GeometryCollection",
        geometries: [
          { type: "Polygon", coordinates: square(-95) },
          { type: "MultiPolygon", coordinates: [square(-94.8), square(-94.6)] },
        ],
      },
    }));
    const { zones, failed } = await cache.resolve(["https://api.weather.gov/zones/forecast/TXZ213"], NOW);
    expect(failed).toBe(0);
    const g = zones.get("https://api.weather.gov/zones/forecast/TXZ213")!;
    expect(g.type).toBe("MultiPolygon");
    expect(g.coordinates).toHaveLength(3);
  });
});

describe("hazard layer", () => {
  const alert = (id: string, event: HazardAlertFeature["properties"]["event"], expires: string): HazardAlertFeature => ({
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [[[-120, 38], [-119, 38], [-119, 39], [-120, 38]]] },
    properties: {
      id,
      event,
      severity: "Severe",
      urgency: "Immediate",
      areaDesc: "",
      sender: "NWS",
      sent: "2026-10-22T20:00:00.000Z",
      effective: "2026-10-22T20:00:00.000Z",
      expires,
      url: `https://api.weather.gov/alerts/${id}`,
    },
  });

  it("replaces the active set and reports what changed", () => {
    const layer = new HazardLayer();
    const first = layer.replace([alert("a", "Red Flag Warning", "2026-10-23T06:00:00Z")]);
    expect(first.upserts).toHaveLength(1);
    const second = layer.replace([
      alert("a", "Red Flag Warning", "2026-10-23T06:00:00Z"),
      alert("b", "Evacuation Immediate", "2026-10-23T06:00:00Z"),
    ]);
    expect(second.upserts.map((a) => a.id)).toEqual(["b"]);
    expect(layer.replace([alert("b", "Evacuation Immediate", "2026-10-23T06:00:00Z")]).removes).toEqual(["a"]);
  });

  it("lists active alerts most urgent first and hides ended ones", () => {
    const layer = new HazardLayer();
    layer.replace([
      alert("rfw", "Red Flag Warning", "2026-10-23T06:00:00Z"),
      alert("evac", "Evacuation Immediate", "2026-10-23T06:00:00Z"),
      alert("old", "Fire Warning", "2026-10-22T21:00:00Z"),
    ]);
    const active = layer.active(undefined, NOW);
    expect(active.map((a) => a.id)).toEqual(["evac", "rfw"]);
    expect(layer.active([-80, 30, -70, 40], NOW)).toHaveLength(0);
  });
});

describe("red flag context in fusion", () => {
  it("attaches an area alert to a cluster anywhere inside it", async () => {
    const cfg = {
      fusion: { radiusKm: 2, ttlMin: 45, matchKm: 3, hullBufferM: 220 },
      ingest: { hotspotRetentionHours: 24 },
    } as unknown as AppConfig;
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, pino({ level: "silent" }));
    const alerts = parseNwsHazards(ALERTS, new Map([[RFW_ZONE, WYZ281.geometry]]), NOW);
    const [context] = hazardContextSignals(alerts, new Date(NOW).toISOString());
    const ring = context!.meta!.polygon as [number, number][];
    // A point inside the zone, well away from its centroid.
    const inside = { lon: (ring[0]![0] * 3 + context!.lon) / 4, lat: (ring[0]![1] * 3 + context!.lat) / 4 };
    const viirs: RawSignal = {
      id: "v1",
      source: "viirs",
      kind: "thermal",
      tier: 2,
      ...inside,
      observedAt: new Date(NOW - 3_600_000).toISOString(),
      receivedAt: new Date(NOW).toISOString(),
      providerConfidence: 0.9,
      frp: 20,
    };
    await store.insertSignals([{ ...context!, observedAt: new Date(NOW - 7_200_000).toISOString() }, viirs]);
    const { upserts } = await engine.run(NOW);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.properties.sources.map((s) => s.source)).toContain("nws");
  });
});
