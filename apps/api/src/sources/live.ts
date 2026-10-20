import {
  circleRing,
  km2ToAcres,
  ringAreaSqKm,
  type IncidentFeature,
  type RawSignal,
} from "@firepulse/protocol";
import type { OfficialAdapter, OfficialBatch, SourceAdapter } from "./types.js";

/* ==================================================================== */
/*  Parsers (exported for tests; no network required)                    */
/* ==================================================================== */

const FIRMS_COLUMNS = [
  "latitude",
  "longitude",
  "bright_ti4",
  "acq_date",
  "acq_time",
  "confidence",
  "frp",
  "satellite",
  "instrument",
];

/**
 * NASA FIRMS area CSV → RawSignal[].
 * Works for VIIRS (SNPP/NOAA-20/NOAA-21, 375 m) and MODIS (1 km) products.
 * Confidence is numeric (0-100) for MODIS and l/n/h for VIIRS.
 */
export function parseFirmsCsv(
  csv: string,
  opts: { source: "viirs" | "modis"; receivedAt?: string } = { source: "viirs" },
): RawSignal[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const latIdx = idx("latitude");
  const lonIdx = idx("longitude");
  if (latIdx < 0 || lonIdx < 0) return [];

  const dateIdx = idx("acq_date");
  const timeIdx = idx("acq_time");
  const frpIdx = idx("frp");
  const confIdx = idx("confidence");
  const satIdx = idx("satellite");
  const brightIdx = idx("bright_ti4") >= 0 ? idx("bright_ti4") : idx("brightness");

  const receivedAt = opts.receivedAt ?? new Date().toISOString();
  const out: RawSignal[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsv(lines[i]!);
    if (cols.length < 4) continue;
    const lat = Number(cols[latIdx]);
    const lon = Number(cols[lonIdx]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const date = dateIdx >= 0 ? cols[dateIdx]!.trim() : "";
    const time = timeIdx >= 0 ? cols[timeIdx]!.trim().padStart(4, "0") : "";
    const observedAt = parseFirmsTime(date, time);
    const rawConf = confIdx >= 0 ? cols[confIdx]!.trim().toLowerCase() : "";
    const providerConfidence =
      rawConf === "h" ? 0.9 : rawConf === "n" ? 0.65 : rawConf === "l" ? 0.35 : clamp01(Number(rawConf) / 100);

    const frp = frpIdx >= 0 ? Number(cols[frpIdx]) : NaN;
    const satellite = satIdx >= 0 ? cols[satIdx]!.trim() : "";
    const brightness = brightIdx >= 0 ? Number(cols[brightIdx]) : NaN;
    const id = `firms-${opts.source}-${lat.toFixed(4)}-${lon.toFixed(4)}-${date}-${time}`;

    out.push({
      id,
      source: opts.source,
      kind: "thermal",
      tier: 2,
      lon,
      lat,
      observedAt,
      receivedAt,
      frp: Number.isFinite(frp) ? frp : undefined,
      providerConfidence,
      label: `${opts.source === "viirs" ? "VIIRS 375m" : "MODIS"}${Number.isFinite(frp) ? ` ${frp} MW` : ""}`,
      meta: {
        dedupeKey: id,
        satellite,
        brightness: Number.isFinite(brightness) ? brightness : undefined,
        product: opts.source === "viirs" ? "VIIRS_SNPP_NRT" : "MODIS_NRT",
      },
    });
  }
  return out;
}

function splitCsv(line: string): string[] {
  // FIRMS does not quote fields; this keeps a cheap fast path.
  return line.split(",");
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

/** "2026-10-19" + "1430" → ISO UTC. */
export function parseFirmsTime(date: string, hhmm: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return new Date().toISOString();
  const hh = hhmm.slice(0, 2) || "00";
  const mm = hhmm.slice(2, 4) || "00";
  const iso = `${m[1]}-${m[2]}-${m[3]}T${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:00.000Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

/* -------------------------------------------------------------------- */
/* NIFC WFIGS                                                           */
/* -------------------------------------------------------------------- */

function pick(props: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = props[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  // case-insensitive fallback
  const lower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), props[k]]));
  for (const k of keys) {
    const v = lower.get(k.toLowerCase());
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/**
 * WFIGS current incidents/perimeters GeoJSON → official incidents.
 * Accepts Point incidents (buffered by reported acreage for display) and
 * Polygon/MultiPolygon perimeters (used as-is for containment).
 */
export function parseWfigsGeoJSON(json: unknown): OfficialBatch {
  const features: IncidentFeature[] = [];
  const perimeters: OfficialBatch["perimeters"] = [];
  const collection = json as { features?: unknown[] };
  if (!collection || !Array.isArray(collection.features)) return { features, perimeters };

  for (const raw of collection.features) {
    const feature = raw as {
      geometry?: { type: string; coordinates: unknown };
      properties?: Record<string, unknown>;
    };
    if (!feature.geometry || !feature.properties) continue;
    const props = feature.properties;
    const name = String(
      pick(props, ["IncidentName", "polygonName", "name", "IRWINName", "FireName"]) ?? "Unnamed Incident",
    );
    const extId = String(
      pick(props, ["UniqueFireIdentifier", "IrwinID", "GlobalID", "OBJECTID", "IncidentNumber"]) ?? name,
    );
    if (!name || name === "Unnamed Incident") continue;

    const acres = Number(pick(props, ["CalculatedAcres", "GISAcres", "DailyAcres", "acres"]) ?? 0) || 0;
    const containment = Number(pick(props, ["PercentContained", "Containment"]) ?? NaN);
    const state = String(pick(props, ["POOState", "State"]) ?? "").replace(/^US-/, "");
    const county = String(pick(props, ["POOCounty", "County"]) ?? "");
    const cause = String(pick(props, ["FireCause", "Cause"]) ?? "");
    const since = toIso(pick(props, ["polygonDateTime", "DateCurrent", "FireDiscoveryDateTime", "ModifiedOnDateTime_dt"]));
    const id = `wfigs-${extId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

    if (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon") {
      const coords = feature.geometry.coordinates as [number, number] | undefined;
      if (feature.geometry.type !== "Point" || !coords) continue;
      const [lon, lat] = coords;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const radius = Math.max(0.3, Math.min(6, Math.sqrt(Math.max(acres, 40) / 247 / Math.PI)));
      const ring = circleRing({ lon, lat }, radius, 36);
      features.push(
        officialFeature({
          id,
          name,
          extId,
          ring,
          lon,
          lat,
          acres: Math.max(acres, km2ToAcres(ringAreaSqKm(ring))),
          containment,
          state,
          county,
          cause,
          since,
        }),
      );
      perimeters.push({
        incidentId: id,
        geom: { type: "Polygon", coordinates: [ring] },
        acres,
        agency: "NIFC",
        publishedAt: since,
      });
      continue;
    }

    const rings =
      feature.geometry.type === "Polygon"
        ? [(feature.geometry.coordinates as number[][][])[0]!]
        : ((feature.geometry.coordinates as number[][][][]).map((p) => p[0]!) as number[][][]);
    const outer = rings[0];
    if (!outer || outer.length < 4) continue;
    const ring = outer as unknown as [number, number][];
    const centroid = ringCentroid(ring);
    const polygonAcres = km2ToAcres(ringAreaSqKm(ring));
    features.push(
      officialFeature({
        id,
        name,
        extId,
        ring,
        lon: centroid[0],
        lat: centroid[1],
        acres: Math.max(acres, polygonAcres),
        containment,
        state,
        county,
        cause,
        since,
      }),
    );
    perimeters.push({
      incidentId: id,
      geom: { type: "Polygon", coordinates: [ring] },
      acres: Math.max(acres, polygonAcres),
      agency: "NIFC",
      publishedAt: since,
    });
  }
  return { features, perimeters };
}

function officialFeature(input: {
  id: string;
  name: string;
  extId: string;
  ring: [number, number][];
  lon: number;
  lat: number;
  acres: number;
  containment: number;
  state: string;
  county: string;
  cause: string;
  since: string;
}): IncidentFeature {
  return {
    type: "Feature",
    id: input.id,
    geometry: { type: "Polygon", coordinates: [input.ring] },
    properties: {
      id: input.id,
      kind: "official",
      name: input.name,
      status: Number.isFinite(input.containment) && input.containment >= 100 ? "contained" : "holding",
      confidence: 100,
      confidenceBreakdown: {
        score: 100,
        fused: 1,
        corroboration: 1,
        freshness: 1,
        distinctModalities: 1,
        evidenceCount: 1,
        rationale: "Official government ground truth",
      },
      sources: [{ source: "wfigs", count: 1, lastSeen: input.since }],
      firstDetectedAt: input.since,
      updatedAt: new Date().toISOString(),
      areaAcres: Math.round(input.acres),
      areaSqKm: Math.round(ringAreaSqKm(input.ring) * 100) / 100,
      frp: 0,
      growthAcresPerHour: 0,
      growthFrpPerHour: 0,
      growthScore: 5,
      hotspotCount: 0,
      evidence: [],
      officialSince: input.since,
      containment: Number.isFinite(input.containment) ? input.containment : undefined,
      cause: (input.cause || "unknown").toLowerCase() as IncidentFeature["properties"]["cause"],
      county: input.county || undefined,
      state: input.state || undefined,
      cells: [],
      lat: input.lat,
      lon: input.lon,
    },
  };
}

function ringCentroid(ring: [number, number][]): [number, number] {
  let lon = 0;
  let lat = 0;
  const n = Math.max(1, ring.length - 1);
  for (let i = 0; i < n; i++) {
    lon += ring[i]![0];
    lat += ring[i]![1];
  }
  return [lon / n, lat / n];
}

function toIso(v: unknown): string {
  if (typeof v === "number") return new Date(v).toISOString();
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

/* -------------------------------------------------------------------- */
/* NWS Red Flag alerts                                                  */
/* -------------------------------------------------------------------- */

export function parseNwsAlerts(json: unknown): RawSignal[] {
  const out: RawSignal[] = [];
  const collection = json as { features?: unknown[] };
  if (!collection || !Array.isArray(collection.features)) return out;
  for (const raw of collection.features) {
    const f = raw as {
      id?: string;
      geometry?: { type: string; coordinates: unknown };
      properties?: Record<string, unknown>;
    };
    if (!f.properties || !f.geometry) continue;
    const event = String(f.properties.event ?? "");
    if (!/red flag/i.test(event)) continue;
    const ring = firstRing(f.geometry);
    if (!ring) continue;
    const [lon, lat] = ringCentroid(ring);
    const id = `nws-${String(f.id ?? f.properties.id ?? `${lon},${lat}`)}`;
    out.push({
      id,
      source: "nws",
      kind: "weather",
      tier: 3,
      lon,
      lat,
      observedAt: toIso(f.properties.sent ?? f.properties.effective),
      receivedAt: new Date().toISOString(),
      providerConfidence: 1,
      label: `${event} — ${String(f.properties.areaDesc ?? "").slice(0, 80)}`,
      meta: {
        dedupeKey: id,
        event,
        severity: f.properties.severity,
        expires: f.properties.expires,
        polygon: ring,
      },
    });
  }
  return out;
}

function firstRing(geometry: { type: string; coordinates: unknown }): [number, number][] | null {
  if (geometry.type === "Polygon") {
    const ring = (geometry.coordinates as number[][][])[0];
    return ring ? (ring as [number, number][]) : null;
  }
  if (geometry.type === "MultiPolygon") {
    const poly = (geometry.coordinates as number[][][][])[0];
    return poly?.[0] ? (poly[0] as [number, number][]) : null;
  }
  return null;
}

/* ==================================================================== */
/*  Live adapters                                                       */
/* ==================================================================== */

const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const WFIGS_URL =
  process.env.WFIGS_URL ??
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson";
const NWS_URL =
  process.env.NWS_URL ?? "https://api.weather.gov/alerts/active?event=Red%20Flag%20Warning&status=actual";

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/geo+json, application/json", ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export function createFirmsAdapters(): SourceAdapter[] {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return [];
  const [west, south, east, north] = (process.env.FIRMS_BBOX ?? "-126,23,-66,50").split(",");
  const days = process.env.FIRMS_DAYS ?? "1";
  const bbox = `${west},${south},${east},${north}`;

  const make = (product: "VIIRS_SNPP_NRT" | "MODIS_NRT", source: "viirs" | "modis"): SourceAdapter => ({
    id: `firms-${source}`,
    label: `NASA FIRMS ${product}`,
    sources: [source],
    tier: 2,
    intervalMs: 5 * 60_000,
    enabled: true,
    async poll() {
      const url = `${FIRMS_BASE}/${key}/${product}/${bbox}/${days}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`FIRMS ${res.status}`);
      const csv = await res.text();
      return parseFirmsCsv(csv, { source, receivedAt: new Date().toISOString() });
    },
  });

  return [make("VIIRS_SNPP_NRT", "viirs"), make("MODIS_NRT", "modis")];
}

export function createWfigsAdapter(): OfficialAdapter {
  return {
    id: "wfigs",
    label: "NIFC WFIGS current perimeters",
    intervalMs: 2 * 60_000,
    enabled: true,
    async poll(): Promise<OfficialBatch> {
      return parseWfigsGeoJSON(await getJson(WFIGS_URL));
    },
  };
}

export function createNwsAdapter(): SourceAdapter {
  return {
    id: "nws-alerts",
    label: "NWS Red Flag Warnings",
    sources: ["nws"],
    tier: 3,
    intervalMs: 5 * 60_000,
    enabled: true,
    async poll() {
      return parseNwsAlerts(await getJson(NWS_URL));
    },
  };
}
