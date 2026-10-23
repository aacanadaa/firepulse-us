import { describe, expect, it } from "vitest";
import pino from "pino";
import {
  circleRing,
  type IncidentFeature,
  type IncidentProperties,
  type RawSignal,
} from "@firepulse/protocol";
import { FusionEngine } from "../src/fusion/engine.js";
import { MemoryStore } from "../src/store/memory.js";
import type { AppConfig } from "../src/config.js";

const log = pino({ level: "silent" });

const cfg = {
  fusion: {
    radiusKm: 2,
    minPoints: 1,
    intervalMs: 4000,
    minHotspots: 1,
    hullBufferM: 220,
    ttlMin: 45,
    matchKm: 3,
    publishMinConfidence: 8,
  },
  ingest: { hotspotRetentionHours: 24 },
  h3Resolution: 8,
} as unknown as AppConfig;

const NOW = Date.parse("2026-10-20T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function signal(partial: Partial<RawSignal> & Pick<RawSignal, "id" | "source" | "lon" | "lat">): RawSignal {
  return {
    kind: partial.source === "cad" || partial.source === "alertca" ? "dispatch" : "thermal",
    tier: partial.source === "cad" ? 1 : 2,
    observedAt: iso(60_000),
    receivedAt: iso(30_000),
    providerConfidence: 0.9,
    frp: 30,
    ...partial,
  } as RawSignal;
}

function officialFeature(opts: {
  id: string;
  name: string;
  lon: number;
  lat: number;
  firstDetectedAt: string;
  officialSince: string;
}): IncidentFeature {
  const ring = circleRing({ lon: opts.lon, lat: opts.lat }, 1.5, 24);
  const properties: IncidentProperties = {
    id: opts.id,
    kind: "official",
    name: opts.name,
    status: "holding",
    confidence: 100,
    confidenceBreakdown: {
      score: 100,
      fused: 1,
      corroboration: 1,
      freshness: 1,
      distinctModalities: 1,
      evidenceCount: 1,
      rationale: "Official government ground truth",
    },
    sources: [{ source: "nifc", count: 1, lastSeen: opts.officialSince }],
    firstDetectedAt: opts.firstDetectedAt,
    updatedAt: opts.officialSince,
    areaAcres: 1000,
    areaSqKm: 4,
    frp: 0,
    growthAcresPerHour: 0,
    growthFrpPerHour: 0,
    growthScore: 5,
    hotspotCount: 0,
    evidence: [],
    officialSince: opts.officialSince,
    containment: 10,
    cause: "vegetation",
    county: "Ventura",
    state: "CA",
    cells: [],
    lat: opts.lat,
    lon: opts.lon,
  };
  return { type: "Feature", id: opts.id, geometry: { type: "Polygon", coordinates: [ring] }, properties };
}

describe("fusion engine", () => {
  it("creates one estimate from converging CAD + GOES evidence", async () => {
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, log);
    await store.insertSignals([
      signal({ id: "cad1", source: "cad", lon: -119.31, lat: 34.48, observedAt: iso(10 * 60_000) }),
      signal({ id: "goes1", source: "goes18", lon: -119.312, lat: 34.482, observedAt: iso(9 * 60_000) }),
    ]);

    const result = await engine.run(NOW);
    expect(result.upserts).toHaveLength(1);
    const incident = result.upserts[0]!;
    expect(incident.properties.kind).toBe("estimated");
    expect(incident.properties.confidence).toBeGreaterThanOrEqual(75);
    expect(incident.properties.confidence).toBeLessThanOrEqual(95);
    expect(incident.properties.sources.map((s) => s.source).sort()).toEqual(["cad", "goes18"]);
    expect(incident.geometry.coordinates[0]!.length).toBeGreaterThan(3);
    // firstDetectedAt is the earliest evidence, not the fusion tick
    expect(incident.properties.firstDetectedAt).toBe(iso(10 * 60_000));
    expect(incident.properties.updatedAt).toBe(iso(9 * 60_000));
  });

  it("keeps incident IDs stable across fusion passes", async () => {
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, log);
    await store.insertSignals([
      signal({ id: "cad1", source: "cad", lon: -119.31, lat: 34.48, observedAt: iso(10 * 60_000) }),
      signal({ id: "goes1", source: "goes18", lon: -119.312, lat: 34.482, observedAt: iso(9 * 60_000) }),
    ]);
    const first = await engine.run(NOW);
    const id = first.upserts[0]!.id;

    await store.insertSignals([
      signal({ id: "goes2", source: "goes18", lon: -119.309, lat: 34.479, observedAt: iso(2 * 60_000) }),
    ]);
    const second = await engine.run(NOW);
    expect(second.upserts).toHaveLength(1);
    expect(second.upserts[0]!.id).toBe(id);
    expect(second.upserts[0]!.properties.firstDetectedAt).toBe(iso(10 * 60_000));
    expect(second.upserts[0]!.properties.confidence).toBeGreaterThan(first.upserts[0]!.properties.confidence - 1);
  });

  it("keeps two far-apart clusters separate", async () => {
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, log);
    await store.insertSignals([
      signal({ id: "cad1", source: "cad", lon: -119.31, lat: 34.48 }),
      signal({ id: "goes1", source: "goes18", lon: -119.312, lat: 34.482 }),
      signal({ id: "cad2", source: "cad", lon: -121.9, lat: 39.7 }),
      signal({ id: "goes2", source: "goes18", lon: -121.902, lat: 39.702 }),
    ]);
    const result = await engine.run(NOW);
    expect(result.upserts).toHaveLength(2);
  });

  it("suppresses a lone weak thermal anomaly", async () => {
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, log);
    await store.insertSignals([
      signal({ id: "weak", source: "modis", lon: -110, lat: 35, frp: 1.4, providerConfidence: 0.4 }),
    ]);
    const result = await engine.run(NOW);
    expect(result.upserts).toHaveLength(0);
  });

  it("merges an estimate into official ground truth and records the lead time", async () => {
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, log);
    await store.insertSignals([
      signal({ id: "cad1", source: "cad", lon: -119.31, lat: 34.48, observedAt: iso(20 * 60_000) }),
      signal({ id: "goes1", source: "goes18", lon: -119.312, lat: 34.482, observedAt: iso(19 * 60_000) }),
    ]);
    const first = await engine.run(NOW);
    const estimate = first.upserts[0]!;

    const official = officialFeature({
      id: "official-ridge",
      name: "Ridge Fire",
      lon: -119.311,
      lat: 34.481,
      firstDetectedAt: iso(21 * 60_000),
      officialSince: iso(60_000),
    });
    await engine.ingestOfficial([official], []);
    const merged = await engine.run(NOW);

    expect(merged.removes).toContain(estimate.id);
    expect(merged.merged).toBe(1);
    // The official fire is re-published with its precursor, not the estimate.
    const republished = merged.upserts.find((f) => f.id === "official-ridge");
    expect(republished?.properties.precursor?.estimateId).toBe(estimate.id);
    expect(merged.upserts.some((f) => f.id === estimate.id)).toBe(false);
    // The estimate reached the store, marked as merged.
    expect((await store.incidentById(estimate.id))?.properties.mergedInto).toBe("official-ridge");
    const liveOfficial = engine.incident("official-ridge")!;
    expect(liveOfficial.properties.precursor).toBeTruthy();
    expect(liveOfficial.properties.precursor!.leadTimeMinutes).toBeGreaterThanOrEqual(18);
    expect(liveOfficial.properties.precursor!.leadTimeMinutes).toBeLessThanOrEqual(21);

    const merges = await store.merges();
    expect(merges).toHaveLength(1);
    expect(merges[0]!.matchMethod).toBe("containment");
    expect(merges[0]!.peakConfidence).toBeGreaterThan(70);
    expect(engine.medianLeadTime()).toBe(merges[0]!.leadTimeMinutes);
  });

  it("does not resurrect an estimate inside an official perimeter", async () => {
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, log);
    const official = officialFeature({
      id: "official-1",
      name: "Official Fire",
      lon: -119.31,
      lat: 34.48,
      firstDetectedAt: iso(60 * 60_000),
      officialSince: iso(30 * 60_000),
    });
    await engine.ingestOfficial([official], []);
    await store.insertSignals([
      signal({ id: "cad1", source: "cad", lon: -119.311, lat: 34.481 }),
      signal({ id: "goes1", source: "goes18", lon: -119.312, lat: 34.482 }),
    ]);
    const result = await engine.run(NOW);
    expect(result.upserts.filter((f) => f.properties.kind === "estimated")).toHaveLength(0);
  });

  it("does not publish an estimate before its first evidence exists", async () => {
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, log);
    await store.insertSignals([
      signal({ id: "future", source: "goes18", lon: -110, lat: 35, observedAt: iso(-5 * 60_000), frp: 80 }),
    ]);
    const result = await engine.run(NOW);
    // observedAt in the future is outside the trailing window
    expect(result.upserts).toHaveLength(0);
  });

  it("exposes a time-cursor view that hides not-yet-detected incidents", async () => {
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, log);
    await store.insertSignals([
      signal({ id: "cad1", source: "cad", lon: -119.31, lat: 34.48, observedAt: iso(20 * 60_000) }),
      signal({ id: "goes1", source: "goes18", lon: -119.312, lat: 34.482, observedAt: iso(19 * 60_000) }),
    ]);
    await engine.run(NOW);
    const bbox: [number, number, number, number] = [-120, 34, -119, 35];
    expect(engine.view(bbox, { at: iso(25 * 60_000) })).toHaveLength(0);
    expect(engine.view(bbox, { at: iso(15 * 60_000) }).length).toBe(1);
    expect(engine.view(bbox, { at: iso(0) }).length).toBe(1);
  });

  describe("per-source evidence windows", () => {
    const HOUR = 3_600_000;

    it("builds an estimate from VIIRS detections that arrived hours after the pass", async () => {
      const store = new MemoryStore();
      const engine = new FusionEngine(store, cfg, log);
      await store.insertSignals([
        signal({ id: "v1", source: "viirs", lon: -120.5, lat: 38.2, observedAt: iso(3 * HOUR) }),
        signal({ id: "v2", source: "viirs", lon: -120.503, lat: 38.201, observedAt: iso(3 * HOUR) }),
      ]);
      const result = await engine.run(NOW);
      expect(result.upserts).toHaveLength(1);
      expect(result.upserts[0]!.properties.hotspotCount).toBe(2);
      expect(result.upserts[0]!.properties.firstDetectedAt).toBe(iso(3 * HOUR));
    });

    it("keeps one ID across a twelve-hour gap between satellite passes", async () => {
      const store = new MemoryStore();
      const engine = new FusionEngine(store, cfg, log);
      await store.insertSignals([
        signal({ id: "day", source: "viirs", lon: -120.5, lat: 38.2, observedAt: iso(14 * HOUR) }),
      ]);
      const first = await engine.run(NOW - 12 * HOUR);
      expect(first.upserts).toHaveLength(1);

      await store.insertSignals([
        signal({ id: "night", source: "viirs", lon: -120.502, lat: 38.2, observedAt: iso(2 * HOUR) }),
      ]);
      const second = await engine.run(NOW);
      expect(second.removes).toHaveLength(0);
      expect(engine.incident(first.upserts[0]!.id)?.properties.hotspotCount).toBe(2);
    });

    it("ignores VIIRS older than its window and CAD older than an hour and a half", async () => {
      const store = new MemoryStore();
      const engine = new FusionEngine(store, cfg, log);
      await store.insertSignals([
        signal({ id: "old-viirs", source: "viirs", lon: -120.5, lat: 38.2, observedAt: iso(31 * HOUR) }),
        signal({ id: "old-cad", source: "cad", lon: -119.31, lat: 34.48, observedAt: iso(2 * HOUR) }),
      ]);
      const result = await engine.run(NOW);
      expect(result.upserts).toHaveLength(0);
    });

    it("expires an estimate once its evidence has aged out and the grace period passes", async () => {
      const store = new MemoryStore();
      const engine = new FusionEngine(store, cfg, log);
      await store.insertSignals([
        signal({ id: "v1", source: "viirs", lon: -120.5, lat: 38.2, observedAt: iso(0) }),
      ]);
      const first = await engine.run(NOW);
      const id = first.upserts[0]!.id;

      // Still inside the 30 h window: kept, with lower freshness.
      const later = await engine.run(NOW + 29.9 * HOUR);
      expect(later.removes).toHaveLength(0);
      expect(engine.incident(id)!.properties.confidenceBreakdown.freshness).toBeLessThan(
        first.upserts[0]!.properties.confidenceBreakdown.freshness,
      );

      // Out of the window, but last seen less than the grace period ago.
      const grace = await engine.run(NOW + 30.2 * HOUR);
      expect(grace.removes).toHaveLength(0);

      const gone = await engine.run(NOW + 29.9 * HOUR + (cfg.fusion.ttlMin + 1) * 60_000);
      expect(gone.removes).toContain(id);
      expect(engine.incident(id)).toBeNull();
    });
  });

  describe("official incidents that leave the feed", () => {
    const official = (i: number) =>
      officialFeature({
        id: `wfigs-${i}`,
        name: `Fire ${i}`,
        lon: -120 + i * 0.5,
        lat: 40,
        firstDetectedAt: iso(3_600_000),
        officialSince: iso(3_600_000),
      });

    it("retires official incidents missing from a complete snapshot", async () => {
      const engine = new FusionEngine(new MemoryStore(), cfg, log);
      await engine.ingestOfficial([official(1), official(2), official(3)], []);
      const gone = await engine.retireOfficial(new Set(["wfigs-1", "wfigs-2"]), "wfigs-");
      expect(gone).toEqual(["wfigs-3"]);
      expect(engine.incident("wfigs-3")).toBeNull();
      expect(engine.incident("wfigs-1")).not.toBeNull();
    });

    it("ignores a snapshot that lost most incidents at once", async () => {
      const engine = new FusionEngine(new MemoryStore(), cfg, log);
      await engine.ingestOfficial(Array.from({ length: 12 }, (_, i) => official(i)), []);
      expect(await engine.retireOfficial(new Set(["wfigs-0"]), "wfigs-")).toEqual([]);
      expect(engine.counts().official).toBe(12);
    });
  });
});
