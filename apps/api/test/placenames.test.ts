import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pino from "pino";
import type { RawSignal } from "@firepulse/protocol";
import { isGenericName, parseCensusGeographies, PlaceNamer, whereName } from "../src/fusion/placeNames.js";
import { FusionEngine } from "../src/fusion/engine.js";
import { MemoryStore } from "../src/store/memory.js";
import type { AppConfig } from "../src/config.js";

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", "census", `${name}.json`), "utf8")) as unknown;

describe("fire names from Census geographies", () => {
  it("names a fire by the town it's in, or else its county", () => {
    const paradise = parseCensusGeographies(fixture("paradise"))!;
    expect(paradise).toEqual({ state: "CA", county: "Butte County", place: "Paradise" });
    expect(whereName(paradise, true)).toBe("Fire near Paradise, CA");
    const rural = parseCensusGeographies(fixture("mccurtain"))!;
    expect(whereName(rural, false)).toBe("Satellite heat in McCurtain County, OK");
    expect(parseCensusGeographies({ result: { geographies: {} } })).toBeNull();
  });

  it("only replaces names the engine made up", () => {
    expect(isGenericName("VIIRS 375m 4.53 MW")).toBe(true);
    expect(isGenericName("Fire at 34.50N 94.94W")).toBe(true);
    expect(isGenericName("Satellite heat near Paradise, CA")).toBe(true);
    expect(isGenericName("Ridge Fire")).toBe(false);
  });

  it("looks places up in the background and names the fire on a later pass", async () => {
    const calls: string[] = [];
    const namer = new PlaceNamer({
      userAgent: "test",
      spacingMs: 0,
      fetch: (async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify(fixture("paradise")));
      }) as typeof fetch,
    });
    const cfg = { fusion: { radiusKm: 2, ttlMin: 45, matchKm: 3, hullBufferM: 220 }, ingest: { hotspotRetentionHours: 24 } } as unknown as AppConfig;
    const store = new MemoryStore();
    const engine = new FusionEngine(store, cfg, pino({ level: "silent" }), undefined, undefined, namer);
    const now = Date.parse("2026-10-23T12:00:00Z");
    const heat = (id: string, hoursAgo: number): RawSignal => ({
      id,
      source: "viirs",
      kind: "thermal",
      tier: 2,
      lon: -121.62,
      lat: 39.76,
      observedAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
      receivedAt: new Date(now).toISOString(),
      providerConfidence: 0.9,
      frp: 20,
      label: "VIIRS 375m 20 MW",
    });
    await store.insertSignals([heat("a", 14), heat("b", 1)]);
    const first = await engine.run(now);
    expect(first.upserts[0]!.properties.name).toBe("Fire at 39.76N 121.62W");
    await new Promise((r) => setTimeout(r, 10));
    const second = await engine.run(now + 60_000);
    expect(second.upserts[0]!.properties.name).toBe("Fire near Paradise, CA");
    expect(second.upserts[0]!.properties.county).toBe("Butte County");
    expect(calls).toHaveLength(1);
  });
});
