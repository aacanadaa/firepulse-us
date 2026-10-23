import type { WindField } from "@firepulse/protocol";
import { getWithRetry, type FetchFn } from "../spread/weather.js";

/* ==================================================================== */
/*  Live 10 m wind from Open-Meteo (HRRR/GFS blend over CONUS)           */
/* ==================================================================== */

/** West, south, east, north. Matches the client's sampling bbox. */
export const WIND_BBOX: [number, number, number, number] = [-126, 22, -66, 50];
/** 2° keeps the grid at 465 points: synoptic flow, not canyon winds. */
export const WIND_STEP_DEG = 2;
/** Locations per Open-Meteo request; keeps URLs short and calls paced. */
const CHUNK = 100;
const HOURS_AHEAD = 30;

export interface WindGrid {
  bbox: [number, number, number, number];
  cols: number;
  rows: number;
  /** Row-major from the north-west corner, like WindField. */
  lats: number[];
  lons: number[];
}

export function windGrid(bbox = WIND_BBOX, step = WIND_STEP_DEG): WindGrid {
  const [west, south, east, north] = bbox;
  const cols = Math.round((east - west) / step) + 1;
  const rows = Math.round((north - south) / step) + 1;
  const lats: number[] = [];
  const lons: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      lats.push(north - r * step);
      lons.push(west + c * step);
    }
  }
  return { bbox, cols, rows, lats, lons };
}

export interface OpenMeteoWindPoint {
  hourly: {
    time: number[];
    wind_speed_10m: (number | null)[];
    wind_direction_10m: (number | null)[];
  };
}

export function openMeteoWindUrl(lats: number[], lons: number[]): string {
  const q = new URLSearchParams({
    latitude: lats.map((v) => v.toFixed(2)).join(","),
    longitude: lons.map((v) => v.toFixed(2)).join(","),
    hourly: "wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "ms",
    timeformat: "unixtime",
    past_hours: "1",
    forecast_hours: String(HOURS_AHEAD),
  });
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`;
}

/**
 * Grid points (row-major, one per grid cell) → one WindField per forecast
 * hour. Direction is meteorological (where the wind blows from), so
 * u = −speed·sin(dir) and v = −speed·cos(dir).
 */
export function windFieldsFromPoints(points: OpenMeteoWindPoint[], grid: WindGrid): WindField[] {
  const n = grid.cols * grid.rows;
  if (points.length !== n) throw new Error(`expected ${n} wind points, got ${points.length}`);
  const times = points[0]!.hourly.time;
  const fields: WindField[] = [];
  for (let h = 0; h < times.length; h++) {
    const u = new Array<number>(n);
    const v = new Array<number>(n);
    let speedMax = 0;
    for (let i = 0; i < n; i++) {
      const hourly = points[i]!.hourly;
      const speed = hourly.wind_speed_10m[h] ?? 0;
      const dir = ((hourly.wind_direction_10m[h] ?? 0) * Math.PI) / 180;
      u[i] = Math.round(-speed * Math.sin(dir) * 100) / 100;
      v[i] = Math.round(-speed * Math.cos(dir) * 100) / 100;
      if (speed > speedMax) speedMax = speed;
    }
    fields.push({
      bbox: grid.bbox,
      cols: grid.cols,
      rows: grid.rows,
      u,
      v,
      speedMax: Math.round(speedMax * 10) / 10,
      validAt: new Date(times[h]! * 1000).toISOString(),
      model: "Open-Meteo 10 m wind (HRRR/GFS)",
    });
  }
  return fields;
}

/**
 * Hourly wind fields for the next day, refreshed a few times a day. Between
 * refreshes `current()` steps through the cached forecast hours, so the map
 * follows the diurnal cycle without extra requests.
 */
export class LiveWind {
  readonly id = "open-meteo-wind";
  readonly label = "Open-Meteo 10 m wind";
  readonly intervalMs = 6 * 3_600_000;
  private fields: WindField[] = [];

  constructor(
    private readonly opts: {
      fetch?: FetchFn;
      userAgent: string;
      timeoutMs: number;
      /** Pause between chunks, to stay well inside Open-Meteo's per-minute limit. */
      pauseMs?: number;
      grid?: WindGrid;
    },
  ) {}

  async refresh(): Promise<number> {
    const grid = this.opts.grid ?? windGrid();
    const points: OpenMeteoWindPoint[] = [];
    for (let i = 0; i < grid.lats.length; i += CHUNK) {
      if (i > 0) await new Promise((r) => setTimeout(r, this.opts.pauseMs ?? 30_000));
      const url = openMeteoWindUrl(grid.lats.slice(i, i + CHUNK), grid.lons.slice(i, i + CHUNK));
      const res = await getWithRetry(url, {
        fetch: this.opts.fetch ?? fetch,
        userAgent: this.opts.userAgent,
        timeoutMs: this.opts.timeoutMs,
      });
      const body = (await res.json()) as OpenMeteoWindPoint | OpenMeteoWindPoint[];
      points.push(...(Array.isArray(body) ? body : [body]));
    }
    this.fields = windFieldsFromPoints(points, grid);
    return this.fields.length;
  }

  /** The latest forecast hour at or before now; null once the cache runs out. */
  current(now = Date.now()): WindField | null {
    let best: WindField | null = null;
    for (const f of this.fields) {
      if (Date.parse(f.validAt) <= now) best = f;
    }
    if (!best || now - Date.parse(best.validAt) > 2 * 3_600_000) return null;
    return best;
  }
}
