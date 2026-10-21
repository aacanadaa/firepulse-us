import type { SpreadWeather } from "@firepulse/protocol";
import { WIN } from "./model.js";
import { cellLonLat, type SpreadWindow } from "./window.js";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch: FetchFn;
  userAgent: string;
  timeoutMs: number;
  /** First retry delay; doubles each time. */
  retryBaseMs?: number;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}`);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });

/** GET with a per-attempt timeout; 429/5xx and network errors retry 3 times. */
export async function getWithRetry(
  url: string,
  opts: HttpOptions,
  headers: Record<string, string> = {},
): Promise<Response> {
  const retries = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    const signals = [AbortSignal.timeout(opts.timeoutMs)];
    if (opts.signal) signals.push(opts.signal);
    try {
      const res = await opts.fetch(url, {
        headers: { "User-Agent": opts.userAgent, ...headers },
        signal: AbortSignal.any(signals),
      });
      if (res.ok) return res;
      lastErr = new HttpError(res.status, url);
      if (res.status !== 429 && res.status < 500) throw lastErr;
    } catch (err) {
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
      if (opts.signal?.aborted) throw err;
      lastErr = err;
    }
    if (attempt < retries) await sleep((opts.retryBaseMs ?? 500) * 2 ** attempt, opts.signal);
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/* Open-Meteo                                                          */
/* ------------------------------------------------------------------ */

/** Weather sample positions along each axis (centres of 16 km blocks). */
export const WX_CELLS = [7.5, 23.5, 39.5, 55.5];
export const WX_POINTS = WX_CELLS.length * WX_CELLS.length;

export interface OpenMeteoPoint {
  latitude: number;
  longitude: number;
  utc_offset_seconds: number;
  hourly: Record<string, (number | null)[]> & { time: string[] };
}

export function weatherPoints(w: SpreadWindow): { lats: number[]; lons: number[] } {
  const lats: number[] = [];
  const lons: number[] = [];
  for (const r of WX_CELLS) {
    for (const c of WX_CELLS) {
      const [lon, lat] = cellLonLat(w, r, c);
      lats.push(lat);
      lons.push(lon);
    }
  }
  return { lats, lons };
}

export function openMeteoUrl(lats: number[], lons: number[]): string {
  const q = new URLSearchParams({
    latitude: lats.map((v) => v.toFixed(4)).join(","),
    longitude: lons.map((v) => v.toFixed(4)).join(","),
    hourly:
      "temperature_2m,relative_humidity_2m,surface_pressure,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    wind_speed_unit: "ms",
    timezone: "auto",
    past_days: "1",
    forecast_days: "2",
  });
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`;
}

/** ONE request for all 16 points, row-major from the north-west. */
export async function fetchOpenMeteo(w: SpreadWindow, opts: HttpOptions): Promise<OpenMeteoPoint[]> {
  const { lats, lons } = weatherPoints(w);
  const res = await getWithRetry(openMeteoUrl(lats, lons), opts);
  const body = (await res.json()) as OpenMeteoPoint | OpenMeteoPoint[];
  const points = Array.isArray(body) ? body : [body];
  if (points.length !== WX_POINTS) throw new Error(`Open-Meteo returned ${points.length} points`);
  return points;
}

/** The fire's local calendar day, YYYY-MM-DD. */
export function localDay(point: OpenMeteoPoint, now: number): string {
  return new Date(now + point.utc_offset_seconds * 1000).toISOString().slice(0, 10);
}

/** GRIDMET-style daily values (SI units) for one point. */
export interface DailyWeather {
  tmmn: number;
  tmmx: number;
  sph: number;
  pr: number;
  /** Mean of hourly wind speeds, m/s. */
  vs: number;
  /** Mean hourly wind vector (direction it blows toward). */
  u_mean: number;
  v_mean: number;
  rh_min: number;
  gust_max: number;
}

export function specificHumidity(tC: number, rh: number, pHpa: number): number {
  const es = 6.112 * Math.exp((17.67 * tC) / (tC + 243.5));
  const e = (rh / 100) * es;
  return (0.622 * e) / (pHpa - 0.378 * e);
}

function nan(values: number[], fn: "min" | "max" | "mean" | "sum"): number {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return NaN;
  if (fn === "min") return Math.min(...v);
  if (fn === "max") return Math.max(...v);
  const sum = v.reduce((a, b) => a + b, 0);
  return fn === "sum" ? sum : sum / v.length;
}

export function dailyWeather(point: OpenMeteoPoint, day: string): DailyWeather {
  const h = point.hourly;
  const keep: number[] = [];
  h.time.forEach((t, i) => {
    if (t.startsWith(day)) keep.push(i);
  });
  if (keep.length < 12) throw new Error(`only ${keep.length} hours of weather for ${day}`);
  const arr = (k: string) => keep.map((i) => h[k]?.[i] ?? NaN) as number[];
  const t = arr("temperature_2m");
  const rh = arr("relative_humidity_2m");
  const p = arr("surface_pressure");
  const ws = arr("wind_speed_10m");
  const wd = arr("wind_direction_10m");
  const pr = arr("precipitation");
  const gust = h.wind_gusts_10m ? arr("wind_gusts_10m") : ws;
  const u = wd.map((d, i) => -ws[i]! * Math.sin((d * Math.PI) / 180));
  const v = wd.map((d, i) => -ws[i]! * Math.cos((d * Math.PI) / 180));
  return {
    tmmn: nan(t, "min") + 273.15,
    tmmx: nan(t, "max") + 273.15,
    sph: nan(t.map((tc, i) => specificHumidity(tc, rh[i]!, p[i]!)), "mean"),
    pr: nan(pr, "sum"),
    vs: nan(ws, "mean"),
    u_mean: nan(u, "mean"),
    v_mean: nan(v, "mean"),
    rh_min: nan(rh, "min"),
    gust_max: nan(gust, "max"),
  };
}

/** numpy.interp: linear between samples, clamped at the ends. */
function interp(x: number, xp: number[], fp: number[]): number {
  const last = xp.length - 1;
  if (x <= xp[0]!) return fp[0]!;
  if (x >= xp[last]!) return fp[last]!;
  let j = 0;
  while (x >= xp[j + 1]!) j++;
  const slope = (fp[j + 1]! - fp[j]!) / (xp[j + 1]! - xp[j]!);
  return slope * (x - xp[j]!) + fp[j]!;
}

/** Bilinear 4 x 4 -> 64 x 64 (columns first, then rows, like the reference). */
export function upsample(coarse: number[]): Float64Array {
  const n = WX_CELLS.length;
  const pos = WX_CELLS;
  const cols: number[][] = []; // [64][n]
  for (let r = 0; r < WIN; r++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      row.push(interp(r, pos, pos.map((_, i) => coarse[i * n + j]!)));
    }
    cols.push(row);
  }
  const out = new Float64Array(WIN * WIN);
  for (let r = 0; r < WIN; r++) {
    for (let c = 0; c < WIN; c++) out[r * WIN + c] = interp(c, pos, cols[r]!);
  }
  return out;
}

export interface WeatherFields {
  wind_u: Float64Array;
  wind_v: Float64Array;
  tmmn: Float64Array;
  tmmx: Float64Array;
  sph: Float64Array;
  pr: Float64Array;
}

/**
 * Daily point values -> model channels. Direction comes from the mean
 * hourly vector, speed from the mean hourly speed (GRIDMET's convention).
 */
export function weatherFields(daily: DailyWeather[]): WeatherFields {
  const field = (k: keyof DailyWeather) => upsample(daily.map((d) => d[k]));
  const u = field("u_mean");
  const v = field("v_mean");
  const speed = field("vs");
  const wind_u = new Float64Array(WIN * WIN);
  const wind_v = new Float64Array(WIN * WIN);
  for (let i = 0; i < u.length; i++) {
    const norm = Math.hypot(u[i]!, v[i]!) || 1;
    wind_u[i] = (speed[i]! * u[i]!) / norm;
    wind_v[i] = (speed[i]! * v[i]!) / norm;
  }
  return { wind_u, wind_v, tmmn: field("tmmn"), tmmx: field("tmmx"), sph: field("sph"), pr: field("pr") };
}

/* ------------------------------------------------------------------ */
/* GRIDMET (THREDDS NCSS)                                              */
/* ------------------------------------------------------------------ */

export const GRIDMET = {
  erc: {
    file: "agg_met_erc_1979_CurrentYear_CONUS.nc",
    variable: "daily_mean_energy_release_component-g",
    days: 10,
    unpack: (raw: number) => raw,
    valid: [0, 150] as const,
    missing: "fuel dryness (ERC)",
  },
  pdsi: {
    file: "agg_met_pdsi_1979_CurrentYear_CONUS.nc",
    variable: "daily_mean_palmer_drought_severity_index",
    days: 30,
    // Stored packed: value = raw * 0.01 - 15.
    unpack: (raw: number) => raw * 0.01 - 15,
    valid: [-15, 15] as const,
    missing: "drought index",
  },
} as const;
export type GridmetVar = keyof typeof GRIDMET;

const GRIDMET_NODATA = 32767;

/** Latest valid value from an NCSS point CSV, or null. */
export function parseGridmetCsv(text: string, kind: GridmetVar): number | null {
  const spec = GRIDMET[kind];
  const lines = text.trim().split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((h) => h.replace(/\[.*$/, "").trim());
  const col = header.indexOf(spec.variable);
  if (col < 0) return null;
  let value: number | null = null;
  for (const line of lines.slice(1)) {
    const raw = Number(line.split(",")[col]);
    if (!Number.isFinite(raw) || raw === GRIDMET_NODATA) continue;
    const v = spec.unpack(raw);
    if (v < spec.valid[0] || v > spec.valid[1]) continue;
    value = v;
  }
  return value;
}

export function gridmetUrl(kind: GridmetVar, lat: number, lon: number, now: number): string {
  const spec = GRIDMET[kind];
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return (
    `http://thredds.northwestknowledge.net:8080/thredds/ncss/${spec.file}` +
    `?var=${spec.variable}&latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&time_start=${day(now - spec.days * 86_400_000)}T00:00:00Z&time_end=${day(now)}T00:00:00Z&accept=csv`
  );
}

export async function fetchGridmet(
  kind: GridmetVar,
  lat: number,
  lon: number,
  now: number,
  opts: HttpOptions,
): Promise<number | null> {
  try {
    const res = await getWithRetry(gridmetUrl(kind, lat, lon, now), opts);
    return parseGridmetCsv(await res.text(), kind);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* NWS                                                                 */
/* ------------------------------------------------------------------ */

/** true/false, or null if NWS could not be reached. */
export async function fetchRedFlag(lat: number, lon: number, opts: HttpOptions): Promise<boolean | null> {
  try {
    const url = `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}&event=Red%20Flag%20Warning`;
    const res = await getWithRetry(url, opts, { Accept: "application/geo+json" });
    const body = (await res.json()) as { features?: unknown[] };
    return Array.isArray(body.features) && body.features.length > 0;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Weather card                                                        */
/* ------------------------------------------------------------------ */

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const COMPASS_SHORT = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function compass(deg: number): string {
  return COMPASS[Math.floor((((deg % 360) + 360) % 360 + 22.5) / 45) % 8]!;
}

export function compassShort(deg: number): string {
  return COMPASS_SHORT[Math.floor((((deg % 360) + 360) % 360 + 22.5) / 45) % 8]!;
}

/** Plain units for the panel, from the four points around the fire. */
export function weatherCard(
  daily: DailyWeather[],
  erc: number | null,
  pdsi: number | null,
  redFlag: boolean | null,
): SpreadWeather {
  const n = WX_CELLS.length;
  const inner = [n + 1, n + 2, 2 * n + 1, 2 * n + 2].map((i) => daily[i]!);
  const mean = (k: keyof DailyWeather) => inner.reduce((s, d) => s + d[k], 0) / inner.length;
  const u = mean("u_mean");
  const v = mean("v_mean");
  const from = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
  const f = (k: number) => ((k - 273.15) * 9) / 5 + 32;
  return {
    tmaxF: Math.round(f(mean("tmmx"))),
    tminF: Math.round(f(mean("tmmn"))),
    rhMin: Math.round(Math.min(...inner.map((d) => d.rh_min))),
    windMph: Math.round(mean("vs") * 2.23694),
    gustMph: Math.round(Math.max(...inner.map((d) => d.gust_max)) * 2.23694),
    windFrom: compassShort(from),
    windFromDeg: Math.round(from),
    rainIn: Math.round((mean("pr") / 25.4) * 100) / 100,
    erc: erc == null ? null : Math.round(erc),
    pdsi: pdsi == null ? null : Math.round(pdsi * 10) / 10,
    redFlag,
  };
}
