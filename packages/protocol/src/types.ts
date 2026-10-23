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
  // GOES-East since April 2025 (replaced GOES-16).
  "goes19",
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

export type EstimateConfirmation = "single" | "persistent" | "corroborated";

export type FireCause =
  | "vehicle"
  | "powerline"
  | "lightning"
  | "structure"
  | "vegetation"
  | "human"
  /** A planned, permitted burn (WFIGS incident type RX). */
  | "prescribed"
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
  /**
   * Estimates only. "single": one satellite pass and one kind of evidence,
   * which is usually a farm or industrial burn; "persistent": heat in passes
   * at least 6 h apart; "corroborated": two independent kinds of detection
   * (e.g. satellite and dispatch). Only confirmed estimates reach the
   * household view and alerts.
   */
  confirmation?: EstimateConfirmation;
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
/* Hazard alerts (NWS / IPAWS)                                          */
/* ------------------------------------------------------------------ */

/** The NWS events FirePulse follows, most urgent first. */
export const HAZARD_EVENTS = [
  "Evacuation Immediate",
  "Fire Warning",
  "Extreme Fire Danger",
  "Red Flag Warning",
  "Fire Weather Watch",
  "Air Quality Alert",
  "Dense Smoke Advisory",
] as const;

export type HazardEvent = (typeof HAZARD_EVENTS)[number];

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Ring[][];
}

export interface HazardAlertProperties {
  /** NWS alert id (a CAP URN). */
  id: string;
  event: HazardEvent;
  severity: string;
  urgency: string;
  headline?: string;
  description?: string;
  /** What people in the area are told to do (evacuate, avoid burning, ...). */
  instruction?: string;
  areaDesc: string;
  sender: string;
  sent: string;
  effective: string;
  expires: string;
  ends?: string;
  /** Link to the full alert on api.weather.gov. */
  url: string;
}

export interface HazardAlertFeature {
  type: "Feature";
  id: string;
  geometry: PolygonGeometry | MultiPolygonGeometry;
  properties: HazardAlertProperties;
}

/* ------------------------------------------------------------------ */
/* Near a place                                                         */
/* ------------------------------------------------------------------ */

export interface NearbyFire {
  id: string;
  name: string;
  kind: IncidentKind;
  status: IncidentStatus;
  cause?: FireCause;
  /** Distance from the place to the fire's mapped edge, km; 0 when inside. */
  distanceKm: number;
  /** Bearing from the place to the fire, degrees, and its compass name. */
  bearingDeg: number;
  direction: string;
  areaAcres: number;
  containment?: number;
  confidence: number;
  growthAcresPerHour: number;
  firstDetectedAt: string;
  updatedAt: string;
  officialSince?: string;
  state?: string;
  county?: string;
  confirmation?: EstimateConfirmation;
  /** The latest next-day forecast from this place, when one has run. */
  outlook?: SpreadOutlook;
  /** The fire's centroid. */
  lat: number;
  lon: number;
}

/** One air monitor's latest PM2.5 reading (EPA AirNow). */
export interface AirQualityReading {
  site: string;
  siteName: string;
  agency: string;
  lat: number;
  lon: number;
  parameter: "PM2.5";
  aqi: number;
  /** EPA category: Good, Moderate, Unhealthy for sensitive groups, ... */
  category: string;
  observedAt: string;
}

/** Everything relevant to one point: nearby fires and alerts covering it. */
export interface NearbySummary {
  lat: number;
  lon: number;
  radiusKm: number;
  generatedAt: string;
  /** Official fires and confirmed estimates, nearest first. */
  fires: NearbyFire[];
  /**
   * Satellite heat seen in one pass only, not yet confirmed: usually a farm
   * or industrial burn. Counted, not listed.
   */
  unconfirmedHeat: number;
  /** Alerts whose area contains the point, most urgent first. */
  alerts: HazardAlertProperties[];
  /** The nearest air monitor within 40 km, when one reported recently. */
  airQuality?: AirQualityReading & { distanceKm: number };
}

/** A geocoded place a person can watch. */
export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
  source: "census" | "photon";
}

/* ------------------------------------------------------------------ */
/* Accounts and alerts                                                  */
/* ------------------------------------------------------------------ */

/** What a person can be alerted about, most urgent first. */
export const ALERT_KINDS = ["evacuation", "fire_warning", "new_fire", "fire_closer", "fire_weather", "spread"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** urgent ignores quiet hours; warning and info wait for them to end. */
export type AlertSeverity = "urgent" | "warning" | "info";

export interface AccountSettings {
  alertKinds: AlertKind[];
  /** Minutes after local midnight; both null means no quiet hours. */
  quietStartMin: number | null;
  quietEndMin: number | null;
  /** IANA zone the quiet hours are in. */
  timezone: string;
}

export interface AccountUser {
  id: string;
  username: string;
  displayName?: string;
  hasPassword: boolean;
  google: boolean;
  settings: AccountSettings;
}

export interface AccountPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusKm: number;
}

export interface AuthState {
  user: AccountUser | null;
  googleEnabled: boolean;
  /** VAPID public key for this server's push subscriptions. */
  pushPublicKey: string | null;
}

export interface AlertItem {
  id: number;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  body: string;
  url: string;
  placeId: string;
  createdAt: string;
  status: "pending" | "sent" | "no_device" | "failed" | "suppressed" | "baseline";
}

/** The JSON a push message carries to the service worker. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Replaces an earlier notification with the same tag. */
  tag: string;
  severity: AlertSeverity;
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
  /** Upstream feed health; absent when the server doesn't track it. */
  sources?: SourceHealth[];
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
      /** Active hazard alerts intersecting the viewport. */
      hazards?: HazardAlertFeature[];
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
      hazardsUpsert?: HazardAlertFeature[];
      hazardsRemove?: string[];
    }
  | { type: "stats"; seq: number; serverTime: string; stats: FeedStats }
  | { type: "pong"; t: number; serverTime: string };

/** One upstream feed's state, as shown in the UI and /api/health. */
export interface SourceHealth {
  id: string;
  label: string;
  kind: "signals" | "official" | "hazards" | "wind";
  intervalMs: number;
  /**
   * pending: no successful poll yet; ok: polled on schedule; stale: no
   * success for three intervals; error: the latest poll failed.
   */
  status: "pending" | "ok" | "stale" | "error";
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  /** Newest observation in the latest successful poll (e.g. a satellite pass). */
  lastObservedAt?: string;
  /** Records returned by the latest successful poll. */
  lastCount?: number;
  warnings?: string[];
}

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

/** A next-day forecast seen from one place, distances in km. */
export interface SpreadOutlook {
  generatedAt: string;
  /** Nearest cell burning today; null when the window has none. */
  todayKm: number | null;
  /** Nearest new cell at or above the "likely" band. */
  likelyKm: number | null;
  /** Nearest new cell at or above the "very likely" band. */
  veryLikelyKm: number | null;
  /** Likely growth comes at least 1 km closer than today's fire. */
  toward: boolean;
}

/** Display bands for spread scores. Never show scores as percentages. */
export const SPREAD_BANDS = { faint: 0.06, likely: 0.12, veryLikely: 0.5 } as const;
