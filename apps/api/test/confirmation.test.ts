import { describe, expect, it } from "vitest";
import pino from "pino";
import { latLngToCell } from "h3-js";
import { estimateConfirmation, isConfirmedFire, type RawSignal } from "@firepulse/protocol";
import { FusionEngine } from "../src/fusion/engine.js";
import { HeatMask } from "../src/fusion/heatMask.js";
import { MemoryStore } from "../src/store/memory.js";
import { accumulate, maskedCells } from "../scripts/build-heat-mask.js";
import type { AppConfig } from "../src/config.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const HOUR = 3_600_000;
const cfg = {
  fusion: { radiusKm: 2, ttlMin: 45, matchKm: 3, hullBufferM: 220 },
  ingest: { hotspotRetentionHours: 24 },
} as unknown as AppConfig;

function viirs(id: string, hoursAgo: number, lon = -91.2, lat = 30.4): RawSignal {
  return {
    id,
    source: "viirs",
    kind: "thermal",
    tier: 2,
    lon,
    lat,
    observedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    receivedAt: new Date(NOW).toISOString(),
    providerConfidence: 0.65,
    frp: 8,
  };
}

describe("estimate confirmation", () => {
  it("is single for one pass, persistent across passes, corroborated across kinds", () => {
    expect(estimateConfirmation([viirs("a", 3), viirs("b", 2.2)])).toBe("single");
    expect(estimateConfirmation([viirs("a", 14), viirs("b", 2)])).toBe("persistent");
    const cad = { ...viirs("c", 1), source: "cad" as const, kind: "dispatch" as const };
    expect(estimateConfirmation([viirs("a", 1), cad])).toBe("corroborated");
    // Context (weather, air quality) is not a second kind of detection.
    const nws = { ...viirs("n", 1), source: "nws" as const, kind: "weather" as const };
    expect(estimateConfirmation([viirs("a", 1), nws])).toBe("single");
  });

  it("never downgrades a track once confirmed", () => {
    expect(estimateConfirmation([viirs("a", 1)], "persistent")).toBe("persistent");
    expect(estimateConfirmation([viirs("a", 1)], "corroborated")).toBe("corroborated");
  });

  it("treats only official fires and confirmed estimates as household-relevant", () => {
    expect(isConfirmedFire({ kind: "official" })).toBe(true);
    expect(isConfirmedFire({ kind: "estimated", confirmation: "persistent" })).toBe(true);
    expect(isConfirmedFire({ kind: "estimated", confirmation: "single" })).toBe(false);
  });

  it("marks a farm-burn-like cluster single, then persistent when the next pass sees it", async () => {
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, pino({ level: "silent" }));
    await store.insertSignals([viirs("day1", 15), viirs("day1b", 14.2)]);
    const first = await engine.run(NOW - 12 * HOUR);
    expect(first.upserts[0]!.properties.confirmation).toBe("single");
    await store.insertSignals([viirs("night", 2)]);
    await engine.run(NOW);
    expect(engine.incident(first.upserts[0]!.id)!.properties.confirmation).toBe("persistent");
  });
});

describe("static heat-source mask", () => {
  const refinery = { lon: -95.1, lat: 29.7 };
  const cell = latLngToCell(refinery.lat, refinery.lon, 7);

  it("drops satellite-only clusters on a masked site but keeps corroborated ones", async () => {
    const mask = new HeatMask(new Set([cell]), 7);
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, pino({ level: "silent" }), undefined, mask);
    await store.insertSignals([viirs("flare1", 3, refinery.lon, refinery.lat), viirs("flare2", 2, refinery.lon, refinery.lat)]);
    expect((await engine.run(NOW)).upserts).toHaveLength(0);

    await store.insertSignals([{ ...viirs("call", 1, refinery.lon, refinery.lat), source: "cad", kind: "dispatch" }]);
    expect((await engine.run(NOW)).upserts).toHaveLength(1);
  });

  it("builds the mask from FIRMS static classes and year-round heat", () => {
    const cells = new Map();
    const header = "latitude,longitude,acq_date,type";
    const flare = ["31.9,-102.3,2025-08-01,2", "31.9,-102.3,2025-08-02,2"];
    // A steel mill seen on 40 days over six months, FIRMS type 0.
    const mill = Array.from({ length: 40 }, (_, i) => `41.6,-87.4,2025-${String(7 + Math.floor(i / 7)).padStart(2, "0")}-${String(1 + (i % 7)).padStart(2, "0")},0`);
    // A wildfire burning 12 days in one month.
    const wildfire = Array.from({ length: 12 }, (_, i) => `39.7,-121.6,2025-08-${String(1 + i).padStart(2, "0")},0`);
    accumulate([header, ...flare, ...mill, ...wildfire].join("\n"), cells);
    const masked = new Set(maskedCells(cells));
    expect(masked.has(latLngToCell(31.9, -102.3, 7))).toBe(true);
    expect(masked.has(latLngToCell(41.6, -87.4, 7))).toBe(true);
    expect(masked.has(latLngToCell(39.7, -121.6, 7))).toBe(false);
  });

  it("ships a built mask", () => {
    const mask = HeatMask.load(new URL("../data/heat-mask.json", import.meta.url).pathname)!;
    expect(mask.size).toBeGreaterThan(500);
  });
});
