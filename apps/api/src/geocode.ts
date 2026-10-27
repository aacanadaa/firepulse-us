import type { GeocodeResult } from "@firepulse/protocol";

/* ==================================================================== */
/*  Place search: Census for addresses, Photon (then Nominatim) for names */
/* ==================================================================== */

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const PHOTON_URL = process.env.PHOTON_URL ?? "https://photon.komoot.io/api/";
const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org/search";
/** The public Nominatim usage policy allows at most one request per second. */
const NOMINATIM_MIN_INTERVAL_MS = 1_100;
const MAX_RESULTS = 6;
const CACHE_TTL_MS = 24 * 3_600_000;
const CACHE_MAX = 1000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** "123 Main St ..." goes to the Census geocoder first; names go to Photon. */
export function looksLikeStreetAddress(q: string): boolean {
  return /^\s*\d+[a-z]?\s+\S+/i.test(q);
}

export function parseCensus(json: unknown): GeocodeResult[] {
  const matches = (json as { result?: { addressMatches?: unknown[] } })?.result?.addressMatches;
  if (!Array.isArray(matches)) return [];
  const out: GeocodeResult[] = [];
  for (const m of matches as { matchedAddress?: string; coordinates?: { x?: number; y?: number } }[]) {
    const lon = Number(m.coordinates?.x);
    const lat = Number(m.coordinates?.y);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !m.matchedAddress) continue;
    out.push({ label: m.matchedAddress, lat, lon, source: "census" });
  }
  return out;
}

export function parsePhoton(json: unknown): GeocodeResult[] {
  const features = (json as { features?: unknown[] })?.features;
  if (!Array.isArray(features)) return [];
  const out: GeocodeResult[] = [];
  const seen = new Set<string>();
  for (const f of features as {
    geometry?: { coordinates?: [number, number] };
    properties?: Record<string, string | undefined>;
  }[]) {
    const p = f.properties ?? {};
    // FirePulse covers the US (feeds, alerts and forecasts are all US-only).
    if (p.countrycode !== "US") continue;
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street;
    const parts = [p.name ?? street, p.city !== p.name ? p.city : undefined, p.county ? countyLabel(p.county) : undefined, p.state];
    const label = parts.filter((x, i, all): x is string => Boolean(x) && all.indexOf(x) === i).join(", ");
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, lat: lat!, lon: lon!, source: "photon" });
  }
  return out;
}

export function parseNominatim(json: unknown): GeocodeResult[] {
  if (!Array.isArray(json)) return [];
  const out: GeocodeResult[] = [];
  const seen = new Set<string>();
  for (const r of json as { lat?: string; lon?: string; name?: string; address?: Record<string, string | undefined> }[]) {
    const a = r.address ?? {};
    if (a.country_code !== "us") continue;
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const street = a.house_number && a.road ? `${a.house_number} ${a.road}` : a.road;
    const city = a.city ?? a.town ?? a.village ?? a.hamlet;
    const name = r.name || street;
    const parts = [name, city !== name ? city : undefined, a.county ? countyLabel(a.county) : undefined, a.state];
    const label = parts.filter((x, i, all): x is string => Boolean(x) && all.indexOf(x) === i).join(", ");
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, lat, lon, source: "nominatim" });
  }
  return out;
}

function countyLabel(county: string): string {
  return /county|parish|borough/i.test(county) ? county : `${county} County`;
}

export class Geocoder {
  private cache = new Map<string, { at: number; results: GeocodeResult[] }>();
  private nominatimQueue: Promise<unknown> = Promise.resolve();
  private nominatimLastAt = 0;

  constructor(
    private readonly opts: { userAgent: string; fetch?: Fetch; timeoutMs?: number },
  ) {}

  async search(query: string, now = Date.now()): Promise<GeocodeResult[]> {
    const q = query.trim().replace(/\s+/g, " ").slice(0, 200);
    if (q.length < 3) return [];
    const key = q.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.results;

    // Photon's public server is light-use only and rejects some cloud hosts, so
    // Nominatim backs it up for place names.
    const order = looksLikeStreetAddress(q)
      ? [this.census, this.photon, this.nominatim]
      : [this.photon, this.nominatim, this.census];
    let results: GeocodeResult[] = [];
    let lastErr: unknown;
    for (const provider of order) {
      try {
        results = await provider.call(this, q);
        if (results.length > 0) break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (results.length === 0 && lastErr) throw lastErr;

    results = results.slice(0, MAX_RESULTS);
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: now, results });
    return results;
  }

  private async get(url: string): Promise<unknown> {
    const res = await (this.opts.fetch ?? fetch)(url, {
      headers: { accept: "application/json", "user-agent": this.opts.userAgent },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000),
    });
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return res.json();
  }

  private async census(q: string): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({ address: q, benchmark: "Public_AR_Current", format: "json" });
    return parseCensus(await this.get(`${CENSUS_URL}?${params}`));
  }

  private async photon(q: string): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({ q, limit: "10", lang: "en" });
    return parsePhoton(await this.get(`${PHOTON_URL}?${params}`));
  }

  private async nominatim(q: string): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({
      q,
      format: "jsonv2",
      addressdetails: "1",
      countrycodes: "us",
      limit: "10",
      "accept-language": "en",
    });
    // Queue calls so they go out no faster than the usage policy allows.
    const run = this.nominatimQueue.then(async () => {
      const wait = this.nominatimLastAt + NOMINATIM_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.nominatimLastAt = Date.now();
      return this.get(`${NOMINATIM_URL}?${params}`);
    });
    this.nominatimQueue = run.catch(() => undefined);
    return parseNominatim(await run);
  }
}
