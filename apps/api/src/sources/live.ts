import {
  circleRing,
  km2ToAcres,
  ringAreaSqKm,
  type FireCause,
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
export type FirmsProduct = "VIIRS_SNPP_NRT" | "VIIRS_NOAA20_NRT" | "VIIRS_NOAA21_NRT" | "MODIS_NRT";

export function parseFirmsCsv(
  csv: string,
  opts: { source: "viirs" | "modis"; product?: FirmsProduct; receivedAt?: string } = { source: "viirs" },
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
        product: opts.product ?? (opts.source === "viirs" ? "VIIRS_SNPP_NRT" : "MODIS_NRT"),
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
  // The perimeter layer prefixes incident attributes with `attr_` and
  // polygon attributes with `poly_`; the incident-location layer does not.
  const variants = keys.flatMap((k) => [k, `attr_${k}`, `poly_${k}`]);
  for (const k of variants) {
    const v = props[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  // case-insensitive fallback
  const lower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), props[k]]));
  for (const k of variants) {
    const v = lower.get(k.toLowerCase());
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** Wildfire, prescribed fire and complex; other record types are not fires. */
const WFIGS_FIRE_TYPES = new Set(["WF", "RX", "CX"]);

const KNOWN_CAUSES = new Set<FireCause>(["vehicle", "powerline", "lightning", "structure", "vegetation", "human"]);

function fireCause(raw: unknown): FireCause {
  const cause = String(raw ?? "").trim().toLowerCase();
  if (cause === "natural") return "lightning";
  return KNOWN_CAUSES.has(cause as FireCause) ? (cause as FireCause) : "unknown";
}

/**
 * WFIGS current incidents/perimeters GeoJSON → official incidents.
 * Accepts Point incidents (buffered by reported acreage for display) and
 * Polygon/MultiPolygon perimeters (used as-is for containment). Incidents
 * already declared out are skipped; prescribed burns are kept and tagged.
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
    if (!feature?.geometry || !feature.properties) continue;
    const props = feature.properties;
    if (pick(props, ["FireOutDateTime"]) !== undefined) continue;
    const type = String(pick(props, ["IncidentTypeCategory"]) ?? "WF").toUpperCase();
    if (!WFIGS_FIRE_TYPES.has(type)) continue;

    const name = String(
      pick(props, ["IncidentName", "polygonName", "name", "IRWINName", "FireName"]) ?? "Unnamed Incident",
    );
    const extId = String(
      pick(props, ["UniqueFireIdentifier", "IrwinID", "GlobalID", "OBJECTID", "IncidentNumber"]) ?? name,
    );
    if (!name || name === "Unnamed Incident") continue;

    const acres =
      Number(pick(props, ["IncidentSize", "CalculatedAcres", "GISAcres", "DailyAcres", "acres"]) ?? 0) || 0;
    const containment = Number(pick(props, ["PercentContained", "Containment"]) ?? NaN);
    const state = String(pick(props, ["POOState", "State"]) ?? "").replace(/^US-/, "");
    const county = String(pick(props, ["POOCounty", "County"]) ?? "");
    const cause = type === "RX" ? "prescribed" : fireCause(pick(props, ["FireCause", "Cause"]));
    const polygonAt = pick(props, ["PolygonDateTime", "polygonDateTime", "DateCurrent"]);
    // Officially known from the moment the incident record was created.
    const since = toIso(
      pick(props, ["CreatedOnDateTime_dt", "FireDiscoveryDateTime"]) ?? polygonAt ?? pick(props, ["ModifiedOnDateTime_dt"]),
    );
    const discoveredAt = toIso(pick(props, ["FireDiscoveryDateTime"]) ?? since);
    const updatedAt = toIso(pick(props, ["ModifiedOnDateTime_dt"]) ?? polygonAt ?? since);
    const id = `wfigs-${extId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const common = { id, name, extId, containment, state, county, cause, since, discoveredAt, updatedAt };

    if (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon") {
      const coords = feature.geometry.coordinates as [number, number] | undefined;
      if (feature.geometry.type !== "Point" || !coords) continue;
      const [lon, lat] = coords;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const radius = Math.max(0.3, Math.min(6, Math.sqrt(Math.max(acres, 40) / 247 / Math.PI)));
      const ring = circleRing({ lon, lat }, radius, 36);
      features.push(
        officialFeature({ ...common, ring, lon, lat, acres: Math.max(acres, km2ToAcres(ringAreaSqKm(ring))) }),
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

    const outers = (
      feature.geometry.type === "Polygon"
        ? [(feature.geometry.coordinates as number[][][])[0]]
        : (feature.geometry.coordinates as number[][][][]).map((p) => p[0])
    ).filter((r): r is number[][] => Array.isArray(r) && r.length >= 4) as unknown as [number, number][][];
    if (outers.length === 0) continue;
    // An incident carries one outline; keep the largest part of a
    // multi-part perimeter and count every part toward the area.
    let ring = outers[0]!;
    let largest = 0;
    let totalSqKm = 0;
    for (const part of outers) {
      const area = ringAreaSqKm(part);
      totalSqKm += area;
      if (area > largest) {
        largest = area;
        ring = part;
      }
    }
    const centroid = ringCentroid(ring);
    const totalAcres = Math.max(acres, km2ToAcres(totalSqKm));
    features.push(officialFeature({ ...common, ring, lon: centroid[0], lat: centroid[1], acres: totalAcres }));
    perimeters.push({
      incidentId: id,
      geom: { type: "Polygon", coordinates: [ring] },
      acres: totalAcres,
      agency: "NIFC",
      publishedAt: polygonAt !== undefined ? toIso(polygonAt) : since,
    });
  }
  return { features, perimeters };
}

/** One record per incident: a mapped perimeter wins over its point location. */
export function mergeOfficialBatches(primary: OfficialBatch, fallback: OfficialBatch): OfficialBatch {
  const ids = new Set(primary.features.map((f) => f.id));
  return {
    features: [...primary.features, ...fallback.features.filter((f) => !ids.has(f.id))],
    perimeters: [...primary.perimeters, ...fallback.perimeters.filter((p) => !ids.has(p.incidentId))],
  };
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
  cause: FireCause;
  since: string;
  discoveredAt: string;
  updatedAt: string;
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
      sources: [{ source: "wfigs", count: 1, lastSeen: input.updatedAt }],
      firstDetectedAt: input.discoveredAt,
      updatedAt: input.updatedAt,
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
      cause: input.cause,
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

/* ==================================================================== */
/*  Live adapters                                                       */
/* ==================================================================== */

const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const WFIGS_SERVICES = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services";
const WFIGS_PERIMETERS_URL =
  process.env.WFIGS_PERIMETERS_URL ?? `${WFIGS_SERVICES}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0`;
const WFIGS_INCIDENTS_URL =
  process.env.WFIGS_INCIDENTS_URL ?? `${WFIGS_SERVICES}/WFIGS_Incident_Locations_Current/FeatureServer/0`;
/** Only what the parser reads; `outFields=*` is 13x larger. */
const WFIGS_FIELDS = [
  "IncidentName",
  "UniqueFireIdentifier",
  "IrwinID",
  "IncidentSize",
  "PercentContained",
  "POOState",
  "POOCounty",
  "FireCause",
  "IncidentTypeCategory",
  "FireDiscoveryDateTime",
  "CreatedOnDateTime_dt",
  "ModifiedOnDateTime_dt",
  "FireOutDateTime",
];
const WFIGS_PERIMETER_FIELDS = [
  ...WFIGS_FIELDS.map((f) => `attr_${f}`),
  "poly_IncidentName",
  "poly_GISAcres",
  "poly_PolygonDateTime",
  "poly_DateCurrent",
];
const ARCGIS_PAGE = 2000;

async function getJson(url: string, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/geo+json, application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** FIRMS counts whole UTC days back from today; it accepts 1 to 5. */
export function firmsDayRange(now: number, since: number, minDays = 1): number {
  const days = Math.ceil((now - since) / 86_400_000);
  return Math.max(minDays, Math.min(5, Number.isFinite(days) ? days : 1));
}

export function createFirmsAdapters(): SourceAdapter[] {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return [];
  const [west, south, east, north] = (process.env.FIRMS_BBOX ?? "-126,23,-66,50").split(",");
  // Two days so a poll just after 00:00 UTC still covers the previous
  // evening's passes; dedupe absorbs the overlap.
  const minDays = Number(process.env.FIRMS_DAYS ?? 2) || 2;
  const bbox = `${west},${south},${east},${north}`;

  const make = (product: FirmsProduct, source: "viirs" | "modis"): SourceAdapter => ({
    id: `firms-${product.toLowerCase().replace(/_nrt$/, "")}`,
    label: `NASA FIRMS ${product}`,
    sources: [source],
    tier: 2,
    // Each product is a few hundred kB for CONUS; four of them every ten
    // minutes is far inside the FIRMS map-key allowance.
    intervalMs: 10 * 60_000,
    enabled: true,
    backfill: true,
    async poll({ now, since }) {
      const url = `${FIRMS_BASE}/${key}/${product}/${bbox}/${firmsDayRange(now, since, minDays)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`FIRMS ${product} ${res.status}`);
      const csv = await res.text();
      // A bad key or exceeded quota comes back as 200 with a plain-text message.
      if (!/^\s*(country_id,)?latitude,/i.test(csv) && csv.trim().length > 0) {
        throw new Error(`FIRMS ${product}: ${csv.trim().slice(0, 120)}`);
      }
      return parseFirmsCsv(csv, { source, product, receivedAt: new Date(now).toISOString() });
    },
  });

  return [
    make("VIIRS_SNPP_NRT", "viirs"),
    make("VIIRS_NOAA20_NRT", "viirs"),
    make("VIIRS_NOAA21_NRT", "viirs"),
    make("MODIS_NRT", "modis"),
  ];
}

/** Every feature of an ArcGIS layer as one GeoJSON collection, page by page. */
export async function fetchArcgisLayer(
  layerUrl: string,
  params: Record<string, string>,
  maxPages = 20,
): Promise<{ type: "FeatureCollection"; features: unknown[] }> {
  const features: unknown[] = [];
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({
      where: "1=1",
      outSR: "4326",
      f: "geojson",
      orderByFields: "OBJECTID",
      resultOffset: String(features.length),
      resultRecordCount: String(ARCGIS_PAGE),
      ...params,
    });
    const json = (await getJson(`${layerUrl}/query?${query}`, {}, 45_000)) as {
      features?: unknown[];
      error?: { message?: string };
      exceededTransferLimit?: boolean;
      properties?: { exceededTransferLimit?: boolean };
    };
    // ArcGIS reports query errors as HTTP 200 with an error body.
    if (json.error) throw new Error(`ArcGIS ${layerUrl}: ${json.error.message ?? "query failed"}`);
    const batch = Array.isArray(json.features) ? json.features : [];
    features.push(...batch);
    const more = json.properties?.exceededTransferLimit ?? json.exceededTransferLimit ?? false;
    if (!more || batch.length === 0) break;
  }
  return { type: "FeatureCollection", features };
}

export function createWfigsAdapter(): OfficialAdapter {
  return {
    id: "wfigs",
    label: "NIFC WFIGS current incidents and perimeters",
    intervalMs: 5 * 60_000,
    enabled: true,
    async poll(): Promise<OfficialBatch> {
      const [perimeters, incidents] = await Promise.all([
        fetchArcgisLayer(WFIGS_PERIMETERS_URL, {
          outFields: WFIGS_PERIMETER_FIELDS.join(","),
          // ~1 m coordinates and ~20 m simplification: 19 MB → 1.4 MB.
          geometryPrecision: "5",
          maxAllowableOffset: "0.0002",
        }),
        fetchArcgisLayer(WFIGS_INCIDENTS_URL, { outFields: WFIGS_FIELDS.join(",") }),
      ]);
      const batch = mergeOfficialBatches(parseWfigsGeoJSON(perimeters), parseWfigsGeoJSON(incidents));
      // Both layers list every current incident, so anything missing is out.
      return { ...batch, complete: { idPrefix: "wfigs-" } };
    },
  };
}
