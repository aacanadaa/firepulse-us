import type { RawSignal, SourceId, Tier } from "@firepulse/protocol";
import type { FireSimulation } from "../simulation/generator.js";
import type { OfficialAdapter, OfficialBatch, SourceAdapter } from "./types.js";

/**
 * Simulation-backed adapters. Each one exposes exactly the same interface as
 * its live counterpart, so swapping DATA_MODE=live changes nothing upstream:
 * the ingestion bus, dedupe, fusion, diff and WebSocket layers are identical.
 */
export function createSimulatedAdapters(sim: FireSimulation): SourceAdapter[] {
  const filter = (ids: SourceId[]) => (signals: RawSignal[]) =>
    signals.filter((s) => ids.includes(s.source));

  const adapter = (
    id: string,
    label: string,
    sources: SourceId[],
    tier: Tier,
    intervalMs: number,
    extra?: (ctx: { now: number; since: number }) => RawSignal[],
  ): SourceAdapter => ({
    id,
    label,
    sources,
    tier,
    intervalMs,
    enabled: true,
    async poll({ now, since }) {
      const generated = sim.generate(since, now);
      const selected = filter(sources)(generated);
      return extra ? [...selected, ...extra({ now, since })] : selected;
    },
  });

  const thermalSources: SourceId[] = ["goes16", "goes18", "viirs", "modis"];
  const dispatchSources: SourceId[] = ["cad", "scanner"];
  const contextSources: SourceId[] = ["purpleair", "airnow", "raws"];

  return [
    adapter("sim-thermal", "GOES ABI + VIIRS/MODIS thermal", thermalSources, 2, 20_000, ({ now }) =>
      // Noise suppression is a product requirement: a handful of stray
      // low-FRP anomalies must not become incidents.
      Math.random() < 0.25 ? sim.strayHotspots(now) : [],
    ),
    adapter("sim-dispatch", "CAD / radio dispatch", dispatchSources, 1, 4_000),
    adapter("sim-crowd", "Crowdsourced reports", ["crowd"], 1, 6_000),
    adapter("sim-camera", "ALERTCalifornia PTZ", ["alertca"], 1, 15_000),
    adapter("sim-air", "PurpleAir / AirNow", ["purpleair", "airnow"], 3, 25_000),
    adapter(
      "sim-weather",
      "RAWS + NWS Red Flag",
      contextSources.concat("nws"),
      3,
      45_000,
      ({ now, since }) => sim.redFlag(now, since, now),
    ),
  ];
}

export function createSimulatedOfficialAdapter(sim: FireSimulation): OfficialAdapter {
  return {
    id: "sim-nifc",
    label: "NIFC / CAL FIRE perimeters",
    intervalMs: 8_000,
    enabled: true,
    async poll({ now, since }): Promise<OfficialBatch> {
      const updates = sim.officialDue(since, now);
      return {
        features: updates.map((u) => u.feature),
        perimeters: updates.map((u) => u.perimeter),
      };
    },
  };
}
