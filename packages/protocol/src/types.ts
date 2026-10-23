/**
 * FirePulse US — shared domain types.
 *
 * These types are the contract between the ingestion/fusion backend and the
 * WebGL map client. Every signal that enters the system is normalised into a
 * `RawSignal`; every published object is either an `IncidentFeature`
 * (estimated or official) or a `HotspotFeature`.
 */

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

export const SOURCE_IDS = [
  // Tier 1 — sub-5-minute, unverified
  "cad",
  "scanner",
  "alertca",
  "crowd",
  // Tier 2 — satellite thermal
  "goes16",
  "goes18",
  "viirs",
  "modis",
  // Tier 3 — environmental context
  "purpleair",
  "airnow",
  "raws",
  "nws",
  // Tier 4 — official ground truth
  "wfigs",
  "nifc",
  "calfire",
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

export type SignalKind =
  | "thermal"
  | "dispatch"
  | "camera"
  | "crowd"
  | "airquality"
  | "weather"
  | "official-point"
  | "official-perimeter";

export type Tier = 1 | 2 | 3 | 4;

/** Coarse sensor family, used for correlation discounts in the fusion model. */
export type Modality =
  | "satellite-thermal"
  | "dispatch"
  | "camera"
  | "crowd"
  | "air-quality"
  | "weather"
  | "official";

export interface SourceProfile {
  id: SourceId;
  label: string;
  short: string;
  tier: Tier;
  modality: Modality;
  /** Base standalone confidence contribution, 0..1. */
  weight: number;
  /** Evidence half-life in minutes (how fast this signal loses weight). */
  halfLifeMin: number;
  /**
   * How long after observation a signal still counts as evidence for a
   * current estimate. Polar orbiters revisit about twice a day and arrive
   * hours late, so their window is far longer than a dispatch call's.
   */
  windowMin: number;
  /** Whether a signal of this source can independently seed an incident. */
  detector: boolean;
  color: string;
}

/* ------------------------------------------------------------------ */
/* Raw signals                                                         */
/* ------------------------------------------------------------------ */

export interface RawSignal {
  id: string;
  source: SourceId;
  kind: SignalKind;
  /** Ingestion tier (1 = dispatch/crowd, 2 = satellite, 3 = context, 4 = official). */
  tier?: Tier;
  lon: number;
  lat: number;
  /** ISO-8601. When the phenomenon was observed (sensor scan time). */
  observedAt: string;
  /** ISO-8601. When FirePulse received it. */
  receivedAt: string;
  /** Fire Radiative Power, MW (thermal sources). */
  frp?: number;
  /** Provider-native confidence, 0..1. */
  providerConfidence?: number;
  /** Compass bearing from a human/camera observer toward the smoke column. */
  bearing?: number;
  /** Observer-to-target distance estimate, metres. */
  distanceM?: number;
  /** Short human label: CAD incident type, camera name, report text, ... */
  label?: string;
  /** H3 cell at the configured resolution. */
  h3?: string;
  meta?: Record<string, unknown>;
}

/** Evidence attached to a fused incident, with its computed contribution. */
export interface EvidenceContribution {
  source: SourceId;
  modality: Modality;
  count: number;
  /** Fused within-modality confidence after correlation discount. */
  contribution: number;
  /** Weighted contribution to the final noisy-OR product. */
  effective: number;
  firstSeen: string;
  lastSeen: string;
  sample?: string;
}

export interface SourceTag {
  source: SourceId;
  count: number;
  lastSeen: string;
}

export interface ConfidenceBreakdown {
  /** Final 0..100 score. */
  score: number;
  /** Pre-multiplier noisy-OR probability, 0..1. */
  fused: number;
  /** Extra credit for independent modalities: 1.0 .. 1.10. */
  corroboration: number;
  /** Recency multiplier from the evidence half-lives: 0.55 .. 1.0. */
  freshness: number;
  distinctModalities: number;
  evidenceCount: number;
  /** Human readable reason, e.g. "GOES-18 + CAD-Dispatch corroboration". */
  rationale: string;
}

/* ------------------------------------------------------------------ */
/* Incidents                                                           */
/* ------------------------------------------------------------------ */

export type IncidentKind = "estimated" | "official";

export type IncidentStatus =
  | "detected"
  | "growing"
  | "holding"
  | "contained"
  | "merged";

export type FireCause =
  | "vehicle"
  | "powerline"
  | "lightning"
  | "structure"
  | "vegetation"
  | "unknown";

export interface IncidentProperties {
  id: string;
  kind: IncidentKind;
  name: string;
  status: IncidentStatus;
  /** 0..100. Official incidents are pinned at 100. */
  confidence: number;
  confidenceBreakdown: ConfidenceBreakdown;
  sources: SourceTag[];
  firstDetectedAt: string;
  updatedAt: string;
  areaAcres: number;
  areaSqKm: number;
  /** Summed Fire Radiative Power of clustered detections, MW. */
  frp: number;
  /** d(area)/dt over the trailing window, acres/hour. */
  growthAcresPerHour: number;
  /** d(FRP)/dt, MW/hour. */
  growthFrpPerHour: number;
  /** Composite ranking used by the "fastest growing" feed. */
  growthScore: number;
  hotspotCount: number;
  evidence: EvidenceContribution[];
  /** Present only on official incidents that absorbed an early estimate. */
  precursor?: {
    estimateId: string;
    firstDetectedAt: string;
    /** Minutes of warning delivered before the official perimeter existed. */
    leadTimeMinutes: number;
    /** Confidence the estimate had reached before the merge. */
    peakConfidence: number;
  };
  /** Present only on estimates that were absorbed by an official incident. */
  mergedInto?: string;
  /** ISO time the official perimeter/incident was first published. */
  officialSince?: string;
  containment?: number;
  cause?: FireCause;
  county?: string;
  state?: string;
  /** H3 cells covered, for hex density rendering. */
  cells?: string[];
  /** Centroid, duplicating geometry for cheap sorting. */
  lat: number;
  lon: number;
}

export type Ring = [number, number][];

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Ring[];
}

export interface PointGeometry {
  type: "Point";
  coordinates: [number, number];
}

export interface IncidentFeature {
  type: "Feature";
  id: string;
  geometry: PolygonGeometry;
  properties: IncidentProperties;
}

export interface HotspotProperties {
  id: string;
  source: SourceId;
  observedAt: string;
  receivedAt: string;
  /** 0..100, source-level trust before clustering. */
  confidence: number;
  frp: number;
  lon: number;
  lat: number;
  tier: Tier;
  label?: string;
}

export interface HotspotFeature {
  type: "Feature";
  id: string;
  geometry: PointGeometry;
  properties: HotspotProperties;
}

/* ------------------------------------------------------------------ */
/* Wind field                                                          */
/* ------------------------------------------------------------------ */

export interface WindField {
  /** coarsened lon/lat grid, row-major, north-west origin */
  bbox: [number, number, number, number];
  cols: number;
  rows: number;
  /** u (eastward m/s), v (northward m/s), row-major */
  u: number[];
  v: number[];
  speedMax: number;
  validAt: string;
  model: string;
}

/* ------------------------------------------------------------------ */
/* Realtime protocol                                                   */
/* ------------------------------------------------------------------ */

export interface FeedStats {
  hotspots: number;
  estimated: number;
  official: number;
  /** signals/second ingested over the trailing 60s */
  ingestRate: number;
  /** per-source counters in the trailing 60s */
  sourceRate: Partial<Record<SourceId, number>>;
  /** ms from observation to client publish, p50 */
  pipelineLatencyMs: number;
  /** cumulative raw signals since boot */
  totalSignals: number;
  /** cumulative per-minute-of-warning delivered before official mapping */
  medianLeadTimeMinutes: number | null;
  fusionRuns: number;
  lastFusionMs: number;
  clients: number;
}

export interface ViewQuery {
  bbox: [number, number, number, number];
  zoom: number;
  /** ISO cursor for time-scrub; omitted/undefined forces live mode. */
  at?: string;
  minConfidence?: number;
}

export type ClientMessage =
  | { type: "subscribe"; bbox: [number, number, number, number]; zoom: number }
  | { type: "viewport"; bbox: [number, number, number, number]; zoom: number }
  | { type: "time"; at: string | null }
  | { type: "filter"; minConfidence: number }
  | { type: "ping"; t: number };

export type ServerMessage =
  | {
      type: "hello";
      seq: number;
      serverTime: string;
      config: PublicConfig;
      stats: FeedStats;
    }
  | {
      type: "snapshot";
      seq: number;
      serverTime: string;
      incidents: IncidentFeature[];
      hotspots: HotspotFeature[];
      wind: WindField | null;
      stats: FeedStats;
      /** true when the payload was truncated to the viewport budget */
      truncated?: boolean;
    }
  | {
      type: "delta";
      seq: number;
      serverTime: string;
      incidentsUpsert: IncidentFeature[];
      incidentsRemove: string[];
      hotspotsUpsert: HotspotFeature[];
      hotspotsRemove: string[];
      stats: FeedStats;
      wind?: WindField;
    }
  | { type: "stats"; seq: number; serverTime: string; stats: FeedStats }
  | { type: "pong"; t: number; serverTime: string };

export interface PublicConfig {
  fusionRadiusKm: number;
  /** Longest per-source evidence window (polar-orbiting thermal). */
  fusionWindowMin: number;
  hotspotRetentionHours: number;
  officialReveal: boolean;
  h3Resolution: number;
  version: string;
  simulated: boolean;
}

/* ------------------------------------------------------------------ */
/* API payloads                                                        */
/* ------------------------------------------------------------------ */

export interface IncidentDetail {
  incident: IncidentFeature;
  signals: RawSignal[];
  /** Nearby official incidents when kind === "estimated". */
  neighbors: { id: string; name: string; kind: IncidentKind; distanceKm: number }[];
  /** Hotspot history for the incident's footprint, for the evidence chart. */
  series: { t: string; frp: number; hotspots: number; confidence: number }[];
}

/* ------------------------------------------------------------------ */
/* Next-day spread forecast                                            */
/* ------------------------------------------------------------------ */

export type SpreadStatus = "ready" | "computing" | "unavailable";

export type SpreadLevel = "none" | "low" | "moderate" | "high";

export interface SpreadCell {
  /** Closed ring of the 1 km cell's corners, [lon, lat]. */
  ring: Ring;
  /** Model score 0..1. Ranks cells; it is NOT a calibrated probability. */
  score: number;
  /** Satellite saw fire in this cell today (model input). */
  burning: boolean;
}

export interface SpreadSummary {
  cellsToday: number;
  /** Cells near the fire at or above the threshold. */
  cellsTomorrow: number;
  /** Of those, cells not burning today. */
  newCells: number;
  /** 8-point compass word toward the expected growth, or null. */
  direction: string | null;
  /** Degrees clockwise from north, or null. */
  bearing: number | null;
  /** Distance from today's fire to the centre of expected growth. */
  km: number;
  text: string;
  level: SpreadLevel;
}

export interface SpreadWeather {
  tmaxF: number;
  tminF: number;
  rhMin: number;
  windMph: number;
  gustMph: number;
  /** 8-point compass word the wind blows FROM. */
  windFrom: string;
  windFromDeg: number;
  rainIn: number;
  erc: number | null;
  pdsi: number | null;
  /** null when the NWS lookup failed. */
  redFlag: boolean | null;
}

export interface SpreadForecast {
  incidentId: string;
  status: SpreadStatus;
  /** Plain-English reason when status !== "ready". */
  reason?: string;
  generatedAt?: string;
  /** ISO time the forecast stops being meaningful (~24 h after generation). */
  validFor?: string;
  /** Outer corners of the 64 x 64 km input window, [lon, lat]. */
  corners?: { nw: [number, number]; ne: [number, number]; se: [number, number]; sw: [number, number] };
  threshold?: number;
  cells?: SpreadCell[];
  summary?: SpreadSummary;
  weather?: SpreadWeather;
  /** Inputs the model ran without (it substitutes the training mean). */
  missingInputs?: string[];
  model?: { name: string; run: string; testAucPr: number };
  /** True for simulator incidents. */
  demo?: boolean;
}

/** Display bands for spread scores. Never show scores as percentages. */
export const SPREAD_BANDS = { faint: 0.06, likely: 0.12, veryLikely: 0.5 } as const;
