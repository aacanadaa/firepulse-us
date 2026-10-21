import { createHash } from "node:crypto";
import type {
  HotspotFeature,
  IncidentFeature,
  SpreadCell,
  SpreadForecast,
} from "@firepulse/protocol";
import { CHANNELS, WIN, type Channel, type Predictor } from "./model.js";
import type { StaticSample } from "./static.js";
import { buildFireMask, centroidOf, thermalForIncident } from "./fireMask.js";
import { summarize } from "./summary.js";
import {
  cellCenters,
  cellRing,
  insideConus,
  makeWindow,
  windowBBox,
  windowCorners,
  type Outline,
} from "./window.js";
import {
  dailyWeather,
  fetchGridmet,
  fetchOpenMeteo,
  fetchRedFlag,
  GRIDMET,
  localDay,
  weatherCard,
  weatherFields,
  WX_POINTS,
  type FetchFn,
  type HttpOptions,
} from "./weather.js";

export const REASONS = {
  outsideConus: "Spread predictions cover the contiguous US only.",
  noThermal: "No satellite fire detections yet.",
  lowConfidence: "This early estimate isn't confident enough yet for a spread prediction.",
  industrial: "Likely an industrial heat source, not a wildfire.",
  busy: "Busy, try again in a minute",
  noWeather: "Weather data is unavailable right now, so no prediction was made.",
  timeout: "The prediction took too long. Try again in a minute.",
  failed: "The prediction failed. Try again in a minute.",
} as const;

/** Unconfirmed thermal-only detections in places this dense are usually industrial. */
export const URBAN_PEOPLE_PER_KM2 = 1500;

export interface SpreadSettings {
  minConfidence: number;
  maxConcurrent: number;
  queueLimit: number;
  timeoutMs: number;
  cacheTtlMs: number;
  openMeteoPerMinute: number;
  httpTimeoutMs: number;
  userAgent: string;
  /** Test hook: first retry delay. */
  retryBaseMs?: number;
}

export interface StaticSource {
  getIndex(): Promise<{ conus?: Outline }>;
  sample(lons: ArrayLike<number>, lats: ArrayLike<number>): Promise<StaticSample>;
  readonly cachedTiles?: number;
}

export interface IncidentSource {
  incident(id: string): IncidentFeature | null;
  allIncidents(): IncidentFeature[];
}

export interface HotspotSource {
  snapshot(bbox: [number, number, number, number], fromMs: number, toMs: number, limit: number): HotspotFeature[];
}

export interface JsonCache {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlMs: number): Promise<void>;
}

export interface SpreadServiceDeps {
  predictor: Predictor;
  statics: StaticSource;
  incidents: IncidentSource;
  hotspots: HotspotSource;
  fetch: FetchFn;
  settings: SpreadSettings;
  /** Shared cache across pods (Redis); optional. */
  cache?: JsonCache | null;
  /** Simulator incidents are flagged as demo fires. */
  simulated: boolean;
  now?: () => number;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

class Busy extends Error {}
class Timeout extends Error {}

const MEMORY_ENTRIES = 200;

/**
 * On-demand next-day spread forecasts.
 *
 * One forecast = one 64 x 64 km window around the incident's recent
 * satellite detections, one Open-Meteo request (16 points), two GRIDMET
 * point lookups and an NWS alert check, then one ONNX inference. Results
 * are cached per incident, hour and set of detections.
 */
export class SpreadService {
  private memory = new Map<string, { value: SpreadForecast; expires: number }>();
  private inflight = new Map<string, Promise<SpreadForecast>>();
  private running = 0;
  private waiting: (() => void)[] = [];
  private openMeteoLog: { t: number; n: number }[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: SpreadServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  status() {
    return {
      running: this.running,
      queued: this.waiting.length,
      cached: this.memory.size,
      staticTiles: this.deps.statics.cachedTiles ?? 0,
    };
  }

  /** null when the incident is unknown. Never rejects. */
  async forecast(incidentId: string): Promise<SpreadForecast | null> {
    const incident = this.deps.incidents.incident(incidentId);
    if (!incident) return null;
    try {
      return await this.forIncident(incident);
    } catch (err) {
      this.deps.log?.warn({ err: err instanceof Error ? err.message : err, incidentId }, "spread forecast failed");
      return unavailable(incident.id, REASONS.failed);
    }
  }

  private async forIncident(incident: IncidentFeature): Promise<SpreadForecast> {
    const { settings } = this.deps;
    const now = this.now();
    const p = incident.properties;

    if (p.kind === "estimated" && p.confidence < settings.minConfidence) {
      return unavailable(incident.id, REASONS.lowConfidence);
    }

    const nearby = this.deps.hotspots.snapshot(
      [p.lon - 1, p.lat - 1, p.lon + 1, p.lat + 1],
      now - 24 * 3_600_000,
      now + 5 * 60_000,
      20_000,
    );
    const own = thermalForIncident(incident, nearby, now);
    const demo = this.deps.simulated && !own.some((h) => h.id.startsWith("firms-"));
    if (own.length === 0) return unavailable(incident.id, REASONS.noThermal, demo);

    const center = centroidOf(own);
    const index = await this.deps.statics.getIndex().catch(() => ({ conus: undefined }));
    if (!insideConus(center.lon, center.lat, index.conus ?? null)) {
      return unavailable(incident.id, REASONS.outsideConus, demo);
    }

    const ids = own.map((h) => h.id).sort();
    const hash = createHash("sha1").update(ids.join("|")).digest("hex").slice(0, 12);
    const key = `fp:spread:${incident.id}:${Math.floor(now / 3_600_000)}:${hash}`;

    const cached = await this.fromCache(key, now);
    if (cached) return cached;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.queued(() => this.compute(incident, own, nearby, center, demo, now))
        .then(async (result) => {
          if (result.status === "ready" || result.reason === REASONS.industrial) {
            await this.toCache(key, result);
          }
          return result;
        })
        .catch((err) => {
          if (err instanceof Busy) return unavailable(incident.id, REASONS.busy, demo);
          if (err instanceof Timeout) return unavailable(incident.id, REASONS.timeout, demo);
          throw err;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  /* ---------------------------- cache ---------------------------------- */

  private async fromCache(key: string, now: number): Promise<SpreadForecast | null> {
    const hit = this.memory.get(key);
    if (hit) {
      if (hit.expires > now) {
        this.memory.delete(key);
        this.memory.set(key, hit);
        return hit.value;
      }
      this.memory.delete(key);
    }
    const shared = await this.deps.cache?.getJson<SpreadForecast>(key);
    if (shared) {
      this.remember(key, shared, now);
      return shared;
    }
    return null;
  }

  private remember(key: string, value: SpreadForecast, now: number): void {
    this.memory.set(key, { value, expires: now + this.deps.settings.cacheTtlMs });
    while (this.memory.size > MEMORY_ENTRIES) {
      this.memory.delete(this.memory.keys().next().value as string);
    }
  }

  private async toCache(key: string, value: SpreadForecast): Promise<void> {
    this.remember(key, value, this.now());
    await this.deps.cache?.setJson(key, value, this.deps.settings.cacheTtlMs);
  }

  /* ---------------------------- limits --------------------------------- */

  private async queued<T>(task: () => Promise<T>): Promise<T> {
    const { maxConcurrent, queueLimit, timeoutMs } = this.deps.settings;
    if (this.running >= maxConcurrent) {
      if (this.waiting.length >= queueLimit) throw new Busy();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        task(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Timeout()), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Global Open-Meteo budget, in locations per minute. */
  private takeOpenMeteo(n: number): boolean {
    const now = this.now();
    this.openMeteoLog = this.openMeteoLog.filter((e) => e.t > now - 60_000);
    const used = this.openMeteoLog.reduce((s, e) => s + e.n, 0);
    if (used + n > this.deps.settings.openMeteoPerMinute) return false;
    this.openMeteoLog.push({ t: now, n });
    return true;
  }

  /* ---------------------------- compute -------------------------------- */

  private async compute(
    incident: IncidentFeature,
    own: HotspotFeature[],
    nearby: HotspotFeature[],
    center: { lon: number; lat: number },
    demo: boolean,
    now: number,
  ): Promise<SpreadForecast> {
    const { predictor, settings } = this.deps;
    const w = makeWindow(center.lon, center.lat);
    const bbox = windowBBox(w);
    const inBox = (lon: number, lat: number) =>
      lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
    const windowHotspots = nearby.filter((h) => inBox(h.properties.lon, h.properties.lat));
    const officials = this.deps.incidents.allIncidents().filter((f) => f.properties.kind === "official");
    const { mask, own: ownCells } = buildFireMask({
      window: w,
      incident,
      ownHotspots: own,
      windowHotspots,
      officials,
      now,
    });

    const missing: string[] = [];
    const { lons, lats } = cellCenters(w);
    const cells = WIN * WIN;
    let statics: StaticSample;
    try {
      statics = await this.deps.statics.sample(lons, lats);
    } catch {
      const empty = () => new Float32Array(cells).fill(NaN);
      statics = { elevation: empty(), NDVI: empty(), population: empty() };
    }
    if (statics.elevation.every(Number.isNaN)) missing.push("terrain");
    if (statics.NDVI.every(Number.isNaN)) missing.push("vegetation (NDVI)");

    if (incident.properties.kind === "estimated" && thermalOnly(incident)) {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < cells; i++) {
        const v = statics.population[i]!;
        if (ownCells[i] && Number.isFinite(v)) {
          sum += v;
          n++;
        }
      }
      if (n > 0 && sum / n >= URBAN_PEOPLE_PER_KM2) return unavailable(incident.id, REASONS.industrial, demo);
    }

    if (!this.takeOpenMeteo(WX_POINTS)) throw new Busy();
    const http: HttpOptions = {
      fetch: this.deps.fetch,
      userAgent: settings.userAgent,
      timeoutMs: settings.httpTimeoutMs,
      retryBaseMs: settings.retryBaseMs,
    };
    const [om, erc, pdsi, redFlag] = await Promise.all([
      fetchOpenMeteo(w, http).catch(() => null),
      fetchGridmet("erc", center.lat, center.lon, now, http),
      fetchGridmet("pdsi", center.lat, center.lon, now, http),
      fetchRedFlag(center.lat, center.lon, http),
    ]);
    let daily;
    try {
      if (!om) throw new Error("no weather");
      const day = localDay(om[0]!, now);
      daily = om.map((pt) => dailyWeather(pt, day));
    } catch {
      // Never predict with made-up weather.
      return unavailable(incident.id, REASONS.noWeather, demo);
    }
    if (erc == null) missing.push(GRIDMET.erc.missing);
    if (pdsi == null) missing.push(GRIDMET.pdsi.missing);

    const wx = weatherFields(daily);
    const raw = new Float32Array(CHANNELS.length * cells).fill(NaN);
    const put = (ch: Channel, value: (i: number) => number) => {
      const off = CHANNELS.indexOf(ch) * cells;
      for (let i = 0; i < cells; i++) raw[off + i] = value(i);
    };
    put("elevation", (i) => finiteOr(statics.elevation[i]!, 0));
    put("wind_u", (i) => wx.wind_u[i]!);
    put("wind_v", (i) => wx.wind_v[i]!);
    put("tmmn", (i) => wx.tmmn[i]!);
    put("tmmx", (i) => wx.tmmx[i]!);
    put("sph", (i) => wx.sph[i]!);
    put("pr", (i) => wx.pr[i]!);
    put("pdsi", () => pdsi ?? NaN);
    put("NDVI", (i) => statics.NDVI[i]!);
    put("population", (i) => finiteOr(statics.population[i]!, 0));
    put("erc", () => erc ?? NaN);
    put("fire_today", (i) => mask[i]!);

    const score = await predictor.predict(raw, 1);
    const threshold = predictor.meta.threshold;
    const summary = summarize(score, mask, ownCells, threshold);
    const out: SpreadCell[] = [];
    for (let r = 0; r < WIN; r++) {
      for (let c = 0; c < WIN; c++) {
        const i = r * WIN + c;
        const s = score[i]!;
        const burning = mask[i] === 1;
        if (s >= threshold / 2 || burning) {
          out.push({ ring: cellRing(w, r, c), score: Math.round(s * 1000) / 1000, burning });
        }
      }
    }

    const generatedAt = new Date(now).toISOString();
    return {
      incidentId: incident.id,
      status: "ready",
      generatedAt,
      validFor: new Date(now + 24 * 3_600_000).toISOString(),
      corners: windowCorners(w),
      threshold,
      cells: out,
      summary,
      weather: weatherCard(daily, erc, pdsi, redFlag),
      missingInputs: missing,
      model: { name: predictor.meta.name, run: predictor.meta.run, testAucPr: predictor.meta.testAucPr },
      demo,
    };
  }
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

const CORROBORATING = new Set(["dispatch", "camera", "crowd", "official"]);

/** Only satellite heat has seen this "fire": no dispatch, camera or human report. */
function thermalOnly(f: IncidentFeature): boolean {
  return !f.properties.evidence.some((e) => CORROBORATING.has(e.modality));
}

export function unavailable(incidentId: string, reason: string, demo?: boolean): SpreadForecast {
  return { incidentId, status: "unavailable", reason, ...(demo ? { demo } : {}) };
}
