import {
  HAZARD_EVENTS,
  type HazardAlertFeature,
  type HazardEvent,
  type MultiPolygonGeometry,
  type PolygonGeometry,
  type RawSignal,
  type Ring,
  simplifyRing,
} from "@firepulse/protocol";
import type { HazardAdapter } from "./types.js";

/* ==================================================================== */
/*  NWS active alerts → hazard polygons + fire-weather context           */
/* ==================================================================== */

type AlertGeometry = PolygonGeometry | MultiPolygonGeometry;

const NWS_HOST = "api.weather.gov";
const NWS_ALERTS_URL =
  process.env.NWS_URL ??
  `https://${NWS_HOST}/alerts/active?status=actual&event=${encodeURIComponent(HAZARD_EVENTS.join(","))}`;

/** ~100 m: zone outlines are drawn for counties, not property lines. */
const ZONE_SIMPLIFY_DEG = 0.001;

/** Events that describe fire weather and so count as fusion context. */
const FIRE_WEATHER: ReadonlySet<HazardEvent> = new Set(["Red Flag Warning", "Extreme Fire Danger"]);

const ZONE_TTL_MS = 7 * 24 * 3_600_000;
/** A zone that failed is not retried on every poll. */
const ZONE_RETRY_MS = 3_600_000;
const ZONE_CONCURRENCY = 4;

interface NwsFeature {
  id?: string;
  geometry?: { type: string; coordinates: unknown } | null;
  properties?: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toIso(v: unknown, fallback: string): string {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

function asGeometry(g: NwsFeature["geometry"]): AlertGeometry | null {
  if (!g) return null;
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) return g as PolygonGeometry;
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) return g as MultiPolygonGeometry;
  // Some coastal zones come back as a collection of polygons.
  const parts = (g as { geometries?: NwsFeature["geometry"][] }).geometries;
  if (g.type === "GeometryCollection" && Array.isArray(parts)) {
    const polygons = parts.map(asGeometry).filter((p): p is AlertGeometry => Boolean(p)).flatMap(polygonsOf);
    return polygons.length > 0 ? { type: "MultiPolygon", coordinates: polygons } : null;
  }
  return null;
}

function polygonsOf(g: AlertGeometry): Ring[][] {
  return g.type === "Polygon" ? [g.coordinates] : g.coordinates;
}

/** Zone geometries we will fetch: only NWS's own zone endpoints. */
export function isNwsZoneUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === NWS_HOST && u.pathname.startsWith("/zones/");
  } catch {
    return false;
  }
}

/** Zones referenced by alerts that carry no polygon of their own. */
export function zonesToResolve(json: unknown): string[] {
  const out = new Set<string>();
  for (const f of featuresOf(json)) {
    if (asGeometry(f.geometry)) continue;
    const zones = f.properties?.affectedZones;
    if (!Array.isArray(zones)) continue;
    for (const z of zones) if (typeof z === "string" && isNwsZoneUrl(z)) out.add(z);
  }
  return [...out];
}

function featuresOf(json: unknown): NwsFeature[] {
  const collection = json as { features?: unknown[] } | null;
  return collection && Array.isArray(collection.features) ? (collection.features as NwsFeature[]) : [];
}

/**
 * NWS alerts GeoJSON → hazard alert features. Most fire-weather products
 * are issued for forecast or fire-weather zones rather than drawn polygons,
 * so alerts without geometry take the union of their zones' outlines.
 * Alerts with neither are dropped.
 */
export function parseNwsHazards(
  json: unknown,
  zones: ReadonlyMap<string, AlertGeometry> = new Map(),
  now = Date.now(),
): HazardAlertFeature[] {
  const out: HazardAlertFeature[] = [];
  const nowIso = new Date(now).toISOString();
  for (const f of featuresOf(json)) {
    const p = f.properties;
    if (!p) continue;
    const event = str(p.event) as HazardEvent | undefined;
    if (!event || !HAZARD_EVENTS.includes(event)) continue;

    let geometry = asGeometry(f.geometry);
    if (!geometry && Array.isArray(p.affectedZones)) {
      const parts = p.affectedZones
        .map((z) => (typeof z === "string" ? zones.get(z) : undefined))
        .filter((g): g is AlertGeometry => Boolean(g))
        .flatMap(polygonsOf)
        .map((polygon) => polygon.map((ring) => simplifyRing(ring, ZONE_SIMPLIFY_DEG)));
      if (parts.length > 0) geometry = { type: "MultiPolygon", coordinates: parts };
    }
    if (!geometry) continue;

    const id = str(p.id) ?? str(f.id);
    if (!id) continue;
    const sent = toIso(p.sent, nowIso);
    out.push({
      type: "Feature",
      id,
      geometry,
      properties: {
        id,
        event,
        severity: str(p.severity) ?? "Unknown",
        urgency: str(p.urgency) ?? "Unknown",
        headline: str(p.headline),
        description: str(p.description),
        instruction: str(p.instruction),
        areaDesc: str(p.areaDesc) ?? "",
        sender: str(p.senderName) ?? "National Weather Service",
        sent,
        effective: toIso(p.effective ?? p.onset, sent),
        expires: toIso(p.expires, sent),
        ends: p.ends ? toIso(p.ends, sent) : undefined,
        url: str(f.id) ?? `https://${NWS_HOST}/alerts/${encodeURIComponent(id)}`,
      },
    });
  }
  return out;
}

function ringCentroid(ring: Ring): [number, number] {
  let lon = 0;
  let lat = 0;
  const n = Math.max(1, ring.length - 1);
  for (let i = 0; i < n; i++) {
    lon += ring[i]![0];
    lat += ring[i]![1];
  }
  return [lon / n, lat / n];
}

/**
 * Fire-weather alerts as tier-3 context. One signal per polygon, carrying
 * the outline so fusion attaches it to clusters inside the area rather than
 * to clusters near its centroid.
 */
export function hazardContextSignals(alerts: HazardAlertFeature[], receivedAt: string): RawSignal[] {
  const out: RawSignal[] = [];
  for (const alert of alerts) {
    const p = alert.properties;
    if (!FIRE_WEATHER.has(p.event)) continue;
    polygonsOf(alert.geometry).forEach((polygon, i) => {
      const ring = polygon[0];
      if (!ring || ring.length < 4) return;
      const [lon, lat] = ringCentroid(ring);
      const id = `nws-${p.id}-${i}`;
      out.push({
        id,
        source: "nws",
        kind: "weather",
        tier: 3,
        lon,
        lat,
        observedAt: p.effective,
        receivedAt,
        providerConfidence: 1,
        label: `${p.event}: ${p.areaDesc.slice(0, 80)}`,
        meta: {
          dedupeKey: id,
          event: p.event,
          severity: p.severity,
          expires: p.ends ?? p.expires,
          polygon: ring,
        },
      });
    });
  }
  return out;
}

/** Forecast and fire-weather zone outlines; they change a few times a year. */
export class NwsZoneCache {
  private zones = new Map<string, { geometry: AlertGeometry | null; fetchedAt: number }>();

  constructor(private readonly fetchJson: (url: string) => Promise<unknown>) {}

  get size(): number {
    return this.zones.size;
  }

  async resolve(urls: string[], now = Date.now()): Promise<{ zones: Map<string, AlertGeometry>; failed: number }> {
    const stale = urls.filter((u) => {
      const hit = this.zones.get(u);
      return !hit || now - hit.fetchedAt > (hit.geometry ? ZONE_TTL_MS : ZONE_RETRY_MS);
    });
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < stale.length) {
        const url = stale[next++]!;
        try {
          const json = (await this.fetchJson(url)) as NwsFeature;
          const geometry = asGeometry(json?.geometry);
          // Keep an outline we already have if a refresh fails.
          if (geometry || !this.zones.get(url)?.geometry) this.zones.set(url, { geometry, fetchedAt: now });
          if (!geometry) failed++;
        } catch {
          if (!this.zones.get(url)?.geometry) this.zones.set(url, { geometry: null, fetchedAt: now });
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ZONE_CONCURRENCY, stale.length) }, worker));

    const zones = new Map<string, AlertGeometry>();
    for (const u of urls) {
      const geometry = this.zones.get(u)?.geometry;
      if (geometry) zones.set(u, geometry);
    }
    return { zones, failed };
  }
}

export function createNwsAdapter(userAgent: string): HazardAdapter {
  const fetchJson = async (url: string): Promise<unknown> => {
    const res = await fetch(url, {
      // NWS rejects requests without an identifying User-Agent.
      headers: { accept: "application/geo+json", "user-agent": userAgent },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.json();
  };
  const zoneCache = new NwsZoneCache(fetchJson);

  return {
    id: "nws-alerts",
    label: "NWS fire weather, evacuation and smoke alerts",
    intervalMs: 5 * 60_000,
    enabled: true,
    async poll({ now }) {
      const json = await fetchJson(NWS_ALERTS_URL);
      const { zones, failed } = await zoneCache.resolve(zonesToResolve(json), now);
      return {
        alerts: parseNwsHazards(json, zones, now),
        // Partial results beat none: an alert missing one zone still shows.
        warnings: failed > 0 ? [`${failed} zone outline(s) could not be fetched`] : [],
      };
    },
  };
}
