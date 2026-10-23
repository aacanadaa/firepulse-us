import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EVIDENCE_WINDOW_MAX_MIN, type PublicConfig } from "@firepulse/protocol";

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
/** NWS and other public APIs ask callers to identify themselves with a contact. */
const userAgent =
  process.env.FIREPULSE_USER_AGENT ||
  process.env.SPREAD_USER_AGENT ||
  "FirePulse/1.0 (wildfire tracker; set FIREPULSE_USER_AGENT with a contact)";

const webOrigin = (process.env.WEB_ORIGIN || "http://localhost:3000").replace(/\/$/, "");

function vapidSubject(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (!v) return "mailto:admin@localhost";
  return /^(mailto:|https:)/.test(v) ? v : `mailto:${v}`;
}

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
  userAgent,

  fusion: {
    /** DBSCAN neighbourhood radius, metres. */
    radiusKm: num("FUSION_RADIUS_KM", 2),
    /** Minimum points in a neighbourhood; 1 = every detector seeds. */
    minPoints: num("FUSION_MIN_POINTS", 1),
    /**
     * How often the fusion loop runs. Live feeds arrive in batches minutes
     * apart, so live mode fuses right after each batch and this timer only
     * keeps decay and expiry moving.
     */
    intervalMs: num("FUSION_INTERVAL_MS", dataMode === "simulation" ? 4000 : 60_000),
    /** Run a fusion pass shortly after any poll that inserts new signals. */
    onIngest: dataMode !== "simulation",
    /** Estimated zones smaller than this are noise, not a fire. */
    minHotspots: 1,
    /** Buffer applied to the convex hull, metres. */
    hullBufferM: num("FUSION_HULL_BUFFER_M", 220),
    /**
     * Grace period after a cluster's last evidence leaves its source window
     * (see `windowMin` in the source profiles) before the estimate expires.
     */
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
    snapshotIncidentBudget: num("SNAPSHOT_INCIDENT_BUDGET", 1500),
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
    userAgent,
  },

  /** Where the web app lives; sign-in redirects and cookies follow it. */
  webOrigin,

  auth: {
    google:
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            // Must match an Authorized redirect URI in the Google client.
            redirectUri:
              process.env.GOOGLE_REDIRECT_URI ||
              `${process.env.PUBLIC_API_URL || "http://localhost:8790"}/api/v1/auth/google/callback`,
          }
        : null,
    /** Signs the short-lived sign-in state cookie; set it when running several API instances. */
    secret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
    /** Secure cookies whenever the site is served over HTTPS. */
    secureCookies: webOrigin.startsWith("https://"),
  },

  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
    /** Push services contact this address about problems; it must be mailto: or https:. */
    subject: vapidSubject(process.env.VAPID_SUBJECT),
  },

  /** Static heat sources (refineries, flares) that fusion ignores. */
  heatMaskPath: process.env.HEAT_MASK_PATH || fileURLToPath(new URL("../data/heat-mask.json", import.meta.url)),

  h3Resolution: 8,
  publicConfig: {
    fusionRadiusKm: num("FUSION_RADIUS_KM", 2),
    fusionWindowMin: EVIDENCE_WINDOW_MAX_MIN,
    hotspotRetentionHours: num("HOTSPOT_RETENTION_HOURS", 24),
    officialReveal: true,
    h3Resolution: 8,
    version: "1.0.0",
    simulated: dataMode !== "live",
  } satisfies PublicConfig,
} as const;

export type AppConfig = typeof config;
