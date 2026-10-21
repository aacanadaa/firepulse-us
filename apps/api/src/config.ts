import { fileURLToPath } from "node:url";
import type { PublicConfig } from "@firepulse/protocol";

/** apps/api/assets/spread, from both src/ (tsx) and dist/ (node). */
const SPREAD_ASSETS = fileURLToPath(new URL("../assets/spread/", import.meta.url));

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export type DataMode = "simulation" | "live" | "hybrid";

const requestedMode = process.env.DATA_MODE as DataMode | undefined;
const dataMode: DataMode =
  requestedMode && ["simulation", "live", "hybrid"].includes(requestedMode)
    ? requestedMode
    : "simulation";

export const config = {
  version: "1.0.0",
  port: num("PORT", 8790),
  host: process.env.HOST ?? "0.0.0.0",
  dataMode,
  /** In simulation mode the demo generator drives every tier. */
  simulated: dataMode !== "live",
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",

  fusion: {
    /** DBSCAN neighbourhood radius, metres. */
    radiusKm: num("FUSION_RADIUS_KM", 2),
    /** Trailing window of evidence considered by one fusion pass. */
    windowMin: num("FUSION_WINDOW_MIN", 30),
    /** Minimum points in a neighbourhood; 1 = every detector seeds. */
    minPoints: num("FUSION_MIN_POINTS", 1),
    /** How often the fusion loop runs. */
    intervalMs: num("FUSION_INTERVAL_MS", 4000),
    /** Estimated zones smaller than this are noise, not a fire. */
    minHotspots: 1,
    /** Buffer applied to the convex hull, metres. */
    hullBufferM: num("FUSION_HULL_BUFFER_M", 220),
    /** Estimate expires after this much silence. */
    ttlMin: num("FUSION_TTL_MIN", 45),
    /** Stable-ID matching distance for a fresh cluster. */
    matchKm: num("FUSION_MATCH_KM", 3),
    /** Don't publish degenerate estimates below this score. */
    publishMinConfidence: num("PUBLISH_MIN_CONFIDENCE", 8),
  },

  ingest: {
    officialRefreshMs: num("OFFICIAL_REFRESH_MS", 60_000),
    thermalPollMs: num("THERMAL_POLL_MS", 60_000),
    contextPollMs: num("CONTEXT_POLL_MS", 300_000),
    maxSignalsInMemory: num("MAX_SIGNALS", 60_000),
    hotspotRetentionHours: num("HOTSPOT_RETENTION_HOURS", 24),
    dedupeTtlMs: 6 * 60 * 60 * 1000,
  },

  ws: {
    /** Max hotspots in a single initial snapshot (bbox-bounded). */
    snapshotHotspotBudget: num("SNAPSHOT_HOTSPOT_BUDGET", 10000),
    snapshotIncidentBudget: num("SNAPSHOT_INCIDENT_BUDGET", 800),
    /** Heartbeat / stats cadence. */
    statsMs: 1000,
    maxClients: num("MAX_WS_CLIENTS", 5000),
  },

  cache: {
    viewportTtlMs: num("VIEWPORT_CACHE_TTL_MS", 5_000),
    bboxPrecision: 3,
  },

  spread: {
    enabled: bool("SPREAD_ENABLED", true),
    modelPath: process.env.SPREAD_MODEL_PATH || `${SPREAD_ASSETS}firesight-best.onnx`,
    staticDir: process.env.SPREAD_STATIC_DIR || `${SPREAD_ASSETS}static_conus`,
    /** Optional base URL holding firesight-best.onnx, firesight-model.json, static_conus.tar.gz. */
    assetsUrl: process.env.SPREAD_ASSETS_URL ?? "",
    /** Estimates below this confidence get no forecast. */
    minConfidence: num("SPREAD_MIN_CONFIDENCE", 40),
    maxConcurrent: num("SPREAD_MAX_CONCURRENT", 2),
    queueLimit: 20,
    /** Hard limit for one forecast. */
    timeoutMs: 30_000,
    /** How long the HTTP route waits before answering 202. */
    routeWaitMs: 25_000,
    cacheTtlMs: 3_600_000,
    /** Global Open-Meteo budget, in locations per minute. */
    openMeteoPerMinute: 300,
    httpTimeoutMs: 15_000,
    /** NWS asks for a contact in the User-Agent. */
    userAgent:
      process.env.SPREAD_USER_AGENT ||
      "FirePulse/1.0 (next-day spread forecasts; set SPREAD_USER_AGENT with a contact)",
  },

  h3Resolution: 8,
  publicConfig: {
    fusionRadiusKm: num("FUSION_RADIUS_KM", 2),
    fusionWindowMin: num("FUSION_WINDOW_MIN", 30),
    hotspotRetentionHours: num("HOTSPOT_RETENTION_HOURS", 24),
    officialReveal: true,
    h3Resolution: 8,
    version: "1.0.0",
    simulated: dataMode !== "live",
  } satisfies PublicConfig,
} as const;

export type AppConfig = typeof config;
