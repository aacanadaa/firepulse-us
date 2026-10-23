import { haversineKm, isConfirmedFire, type IncidentFeature, type SpreadForecast } from "@firepulse/protocol";
import type { Logger } from "pino";

/** Fires this close to a watched place get forecasts without anyone asking. */
export const WATCH_REACH_KM = 50;
/** Without new detections, a fire's forecast is refreshed this often. */
const REFRESH_MS = 6 * 3_600_000;
/** Forecasts run one after another, a few per tick, to stay inside the service's queue. */
const PER_TICK = 6;

interface Place {
  lat: number;
  lon: number;
}

/**
 * Runs next-day spread forecasts ahead of time for confirmed fires near
 * places people watch: again whenever new satellite detections arrive,
 * otherwise every 6 hours. Forecasts no one needs are never run.
 */
export class SpreadScheduler {
  private last = new Map<string, { at: number; hotspots: number }>();
  private latestById = new Map<string, SpreadForecast>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      /** null while forecasts are switched off. */
      forecast: (incidentId: string) => Promise<SpreadForecast | null>;
      incidents: () => IncidentFeature[];
      places: () => Place[];
      onForecast: (incident: IncidentFeature, forecast: SpreadForecast) => Promise<unknown>;
      log: Logger;
      now?: () => number;
      intervalMs?: number;
    },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 10 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The newest ready forecast for an incident, from here or from a viewer asking for it. */
  latest(incidentId: string): SpreadForecast | undefined {
    return this.latestById.get(incidentId);
  }

  remember(forecast: SpreadForecast): void {
    if (forecast.status === "ready") this.latestById.set(forecast.incidentId, forecast);
  }

  /** Fires near watched places, nearest first. */
  candidates(): IncidentFeature[] {
    const places = this.deps.places();
    if (places.length === 0) return [];
    const scored: { f: IncidentFeature; km: number }[] = [];
    for (const f of this.deps.incidents()) {
      const p = f.properties;
      if (p.mergedInto || p.cause === "prescribed" || !isConfirmedFire(p)) continue;
      let km = Infinity;
      for (const place of places) km = Math.min(km, haversineKm(place, { lon: p.lon, lat: p.lat }));
      if (km <= WATCH_REACH_KM) scored.push({ f, km });
    }
    return scored.sort((a, b) => a.km - b.km).map((s) => s.f);
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const now = this.deps.now?.() ?? Date.now();
    let ran = 0;
    try {
      const live = new Set<string>();
      for (const f of this.candidates()) {
        live.add(f.id);
        if (ran >= PER_TICK) continue;
        const prev = this.last.get(f.id);
        const due = !prev || prev.hotspots !== f.properties.hotspotCount || now - prev.at >= REFRESH_MS;
        if (!due) continue;
        const forecast = await this.deps.forecast(f.id);
        ran++;
        if (!forecast) continue;
        // "computing" means another caller started it; check again next tick.
        if (forecast.status === "computing") continue;
        this.last.set(f.id, { at: now, hotspots: f.properties.hotspotCount });
        if (forecast.status !== "ready") continue;
        this.remember(forecast);
        await this.deps.onForecast(f, forecast);
      }
      // Forget fires that are gone or no longer near anyone.
      for (const id of [...this.last.keys()]) if (!live.has(id)) this.last.delete(id);
      for (const id of [...this.latestById.keys()]) {
        if (!live.has(id) && now - Date.parse(this.latestById.get(id)!.generatedAt ?? "") > REFRESH_MS * 2) {
          this.latestById.delete(id);
        }
      }
    } catch (err) {
      this.deps.log.warn({ err }, "spread scheduling failed");
    } finally {
      this.running = false;
    }
    return ran;
  }
}
