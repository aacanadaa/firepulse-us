import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { destination, type RawSignal } from "@firepulse/protocol";
import { AirQualityLayer, parseAirNowData, SMOKE_AQI, smokeSignals } from "../src/sources/airnow.js";
import { FusionEngine } from "../src/fusion/engine.js";
import { MemoryStore } from "../src/store/memory.js";
import type { AppConfig } from "../src/config.js";

// Recorded 2026-10-23 from /aq/data: one site twice, four others, two smoke readings.
const rows = JSON.parse(readFileSync(join(__dirname, "fixtures", "airnow", "data.json"), "utf8")) as Record<string, unknown>[];

describe("AirNow", () => {
  it("keeps the latest PM2.5 reading per monitor", () => {
    const readings = parseAirNowData(rows);
    const sites = new Set(rows.map((r) => r.FullAQSCode));
    expect(readings).toHaveLength(sites.size);
    const repeated = readings.find((r) => r.site === rows[0]!.FullAQSCode)!;
    expect(repeated.observedAt).toBe(`${[rows[0]!.UTC, rows[1]!.UTC].sort().at(-1)}:00.000Z`);
    expect(readings.every((r) => r.parameter === "PM2.5" && r.category.length > 0)).toBe(true);
  });

  it("turns only unhealthy readings into smoke context", () => {
    const signals = smokeSignals(parseAirNowData(rows), "2026-10-23T10:00:00Z");
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.kind === "airquality" && Number(s.meta?.aqi) >= SMOKE_AQI)).toBe(true);
  });

  it("finds the nearest recent monitor within 40 km", () => {
    const layer = new AirQualityLayer();
    const reading = { site: "a", siteName: "A", agency: "", lat: 39.76, lon: -121.62, parameter: "PM2.5" as const, aqi: 160, category: "Unhealthy", observedAt: "2026-10-23T09:00:00.000Z" };
    layer.replace([reading]);
    const now = Date.parse("2026-10-23T10:00:00Z");
    expect(layer.nearest(destination(reading, 0, 10), now)?.distanceKm).toBeCloseTo(10, 0);
    expect(layer.nearest(destination(reading, 0, 60), now)).toBeNull();
    expect(layer.nearest(reading, now + 5 * 3_600_000)).toBeNull();
  });

  it("lets smoke at a monitor up to 25 km away support a nearby cluster", async () => {
    const cfg = { fusion: { radiusKm: 2, ttlMin: 45, matchKm: 3, hullBufferM: 220 }, ingest: { hotspotRetentionHours: 24 } } as unknown as AppConfig;
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, pino({ level: "silent" }));
    const now = Date.parse("2026-10-23T10:00:00Z");
    const fire = { lon: -121.62, lat: 39.76 };
    const monitor = destination(fire, 45, 18);
    const [smoke] = smokeSignals(
      [{ site: "m", siteName: "M", agency: "", ...monitor, parameter: "PM2.5", aqi: 180, category: "Unhealthy", observedAt: "2026-10-23T09:00:00.000Z" }],
      "2026-10-23T09:30:00Z",
    );
    const heat: RawSignal = { id: "v", source: "viirs", kind: "thermal", tier: 2, ...fire, observedAt: "2026-10-23T08:00:00.000Z", receivedAt: "2026-10-23T09:00:00.000Z", providerConfidence: 0.9, frp: 30 };
    await store.insertSignals([smoke!, heat]);
    const { upserts } = await engine.run(now);
    expect(upserts[0]!.properties.sources.map((s) => s.source)).toContain("airnow");
  });
});
