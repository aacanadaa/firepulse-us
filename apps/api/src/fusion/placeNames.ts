import { latLngToCell } from "h3-js";
import type { LngLat } from "@firepulse/protocol";

/* ==================================================================== */
/*  Human names for estimated fires, from US Census geographies           */
/* ==================================================================== */

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates";
/** ~36 km² cells: one lookup names every fire in it. */
const CELL_RES = 6;
const SPACING_MS = 1_000;

export interface Whereabouts {
  state?: string;
  county?: string;
  /** Town or census-designated place the point is inside, if any. */
  place?: string;
}

export function parseCensusGeographies(json: unknown): Whereabouts | null {
  const g = (json as { result?: { geographies?: Record<string, { BASENAME?: string; NAME?: string; STUSAB?: string }[]> } })
    ?.result?.geographies;
  if (!g) return null;
  const state = g.States?.[0]?.STUSAB;
  if (!state) return null;
  const county = g.Counties?.[0]?.NAME;
  const place = g["Incorporated Places"]?.[0]?.BASENAME ?? g["Census Designated Places"]?.[0]?.BASENAME;
  return { state, county, place };
}

/** "Fire near Paradise, CA" or "Fire in McCurtain County, OK". */
export function whereName(w: Whereabouts, confirmed: boolean): string | null {
  const what = confirmed ? "Fire" : "Satellite heat";
  if (w.place && w.state) return `${what} near ${w.place}, ${w.state}`;
  if (w.county && w.state) return `${what} in ${w.county}, ${w.state}`;
  return null;
}

/** Names the engine made up itself, which a better one may replace. */
export function isGenericName(name: string): boolean {
  return /^(Early Zone|Fire (near|in|at) |Satellite heat |VIIRS|MODIS|GOES)/.test(name);
}

/**
 * Looks up where estimated fires are, in the background: fusion asks
 * `describe` every pass, which answers from cache and queues a lookup on a
 * miss. Lookups run one at a time, a second apart.
 */
export class PlaceNamer {
  private cache = new Map<string, Whereabouts | null>();
  private queue: { cell: string; point: LngLat }[] = [];
  private queued = new Set<string>();
  private running = false;

  constructor(
    private readonly opts: { userAgent: string; fetch?: typeof fetch; spacingMs?: number },
  ) {}

  get size(): number {
    return this.cache.size;
  }

  describe(point: LngLat): Whereabouts | undefined {
    // The Census only covers the US and its territories.
    if (point.lat < 17 || point.lat > 72 || point.lon < -180 || point.lon > -60) return undefined;
    const cell = latLngToCell(point.lat, point.lon, CELL_RES);
    const hit = this.cache.get(cell);
    if (hit !== undefined) return hit ?? undefined;
    if (!this.queued.has(cell)) {
      this.queued.add(cell);
      this.queue.push({ cell, point });
      void this.pump();
    }
    return undefined;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const { cell, point } = this.queue.shift()!;
        const q = new URLSearchParams({
          x: point.lon.toFixed(4),
          y: point.lat.toFixed(4),
          benchmark: "Public_AR_Current",
          vintage: "Current_Current",
          layers: "Counties,Incorporated Places,Census Designated Places,States",
          format: "json",
        });
        try {
          const res = await (this.opts.fetch ?? fetch)(`${CENSUS_URL}?${q}`, {
            headers: { "user-agent": this.opts.userAgent },
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) {
            this.cache.set(cell, parseCensusGeographies(await res.json()));
          }
        } catch {
          /* try again the next time a fire there asks */
        }
        this.queued.delete(cell);
        if (this.queue.length > 0) await new Promise((r) => setTimeout(r, this.opts.spacingMs ?? SPACING_MS));
      }
    } finally {
      this.running = false;
    }
  }
}
