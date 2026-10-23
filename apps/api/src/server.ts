import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RawSignal } from "@firepulse/protocol";
import type { AppConfig } from "./config.js";
import type { Store } from "./store/types.js";
import type { RedisCache } from "./store/redis.js";
import type { FusionEngine } from "./fusion/engine.js";
import type { RealtimeHub } from "./realtime/hub.js";
import type { HotspotLog } from "./realtime/hotspots.js";
import type { HazardLayer } from "./realtime/hazards.js";
import { Geocoder } from "./geocode.js";
import { registerAccountRoutes } from "./accounts/routes.js";
import type { AccountStore } from "./accounts/types.js";
import type { AlertEngine } from "./notify/engine.js";
import type { PushSender } from "./notify/outbox.js";
import { NEARBY_MAX_RADIUS_KM, nearbySummary } from "./nearby.js";
import type { SourceHealthBoard } from "./realtime/health.js";
import type { Pipeline } from "./pipeline.js";
import type { FireSimulation } from "./simulation/generator.js";
import type { SpreadRuntime } from "./spread/index.js";
import type { Logger } from "pino";

export interface ServerDeps {
  config: AppConfig;
  store: Store;
  cache: RedisCache | null;
  engine: FusionEngine;
  hub: RealtimeHub;
  hotspots: HotspotLog;
  pipeline: Pipeline;
  simulation: FireSimulation | null;
  spread: SpreadRuntime;
  hazards: HazardLayer;
  health: SourceHealthBoard;
  accounts: AccountStore;
  alerts: AlertEngine;
  sender: PushSender | null;
  log: Logger;
  startedAt: number;
}

function parseBBox(raw: unknown): [number, number, number, number] | null {
  const fallback: [number, number, number, number] = [-126, 22, -65, 51];
  if (typeof raw !== "string") return fallback;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [a, b, c, d] = parts as [number, number, number, number];
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/** Requests allowed per client per minute, for routes that call third parties. */
function perMinuteLimiter(limit: number): (key: string, now?: number) => boolean {
  const hits = new Map<string, number[]>();
  return (key, now = Date.now()) => {
    const recent = (hits.get(key) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear();
    return true;
  };
}

function bucket(count: number): string {
  if (count === 0) return "0";
  if (count < 10) return "1-9";
  if (count < 100) return "10-99";
  if (count < 1000) return "100-999";
  return "1000+";
}

export async function createServer(deps: ServerDeps): Promise<ReturnType<typeof Fastify>> {
  const { config, store, cache, engine, hub, hotspots, pipeline, simulation, spread, hazards, health, log } = deps;

  const app = Fastify({
    loggerInstance: log,
    bodyLimit: 512 * 1024,
    trustProxy: true,
    disableRequestLogging: true,
  });

  await app.register(cors, { origin: config.corsOrigin, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });
  await app.register(websocket, {
    options: {
      maxPayload: 256 * 1024,
      perMessageDeflate: { threshold: 1024 },
    },
  });

  app.get("/", async () => ({
    service: "firepulse-us",
    version: config.version,
    mode: config.dataMode,
    docs: "/api/v1/config",
    ws: "/ws",
    endpoints: [
      "/api/health",
      "/api/v1/config",
      "/api/v1/incidents",
      "/api/v1/incidents/:id",
      "/api/v1/incidents/:id/spread",
      "/api/v1/hotspots",
      "/api/v1/timeline",
      "/api/v1/stats",
      "/api/v1/merges",
      "/api/v1/wind",
      "/api/v1/alerts",
      "/api/v1/nearby",
      "/api/v1/geocode",
      "/ws",
    ],
  }));

  app.get("/api/health", async (_req, reply) => {
    const db = await store.ping();
    const ok = db;
    return reply.code(ok ? 200 : 503).send({
      ok,
      store: store.kind,
      redis: cache?.status ?? "disabled",
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      simulated: config.simulated,
      clients: hub.clientCount,
      spread: spread.health(),
      sources: health.snapshot(),
      hazards: hazards.count,
    });
  });

  app.get("/api/v1/config", async () => ({
    ...config.publicConfig,
    store: store.kind,
    fusionIntervalMs: config.fusion.intervalMs,
  }));

  app.get<{ Querystring: { bbox?: string; at?: string; minConfidence?: string; limit?: string } }>(
    "/api/v1/incidents",
    async (req, reply) => {
      const bbox = parseBBox(req.query.bbox);
      if (!bbox) return reply.code(400).send({ error: "bbox must be minLon,minLat,maxLon,maxLat" });
      const minConfidence = Math.max(0, Math.min(100, Number(req.query.minConfidence ?? 0) || 0));
      const at = req.query.at;
      if (at && !Number.isFinite(Date.parse(at))) {
        return reply.code(400).send({ error: "at must be an ISO-8601 timestamp" });
      }

      // Fast path: Redis spatial index. Fallback: in-process engine view
      // (which is already the authoritative live state).
      if (!at && cache?.available) {
        const cached = await cache.viewport(bbox, Number(req.query.limit ?? 900));
        if (cached && cached.length > 0) {
          const filtered = cached.filter((f) => f.properties.confidence >= minConfidence);
          return { type: "FeatureCollection", features: filtered, source: "redis" };
        }
      }

      const features = engine.view(bbox, {
        at,
        minConfidence,
        limit: Math.min(2000, Number(req.query.limit ?? 900) || 900),
      });
      return {
        type: "FeatureCollection",
        features,
        source: "engine",
        serverTime: new Date().toISOString(),
      };
    },
  );

  app.get<{ Params: { id: string } }>("/api/v1/incidents/:id", async (req, reply) => {
    const incident = engine.incident(req.params.id);
    if (!incident) return reply.code(404).send({ error: "incident not found" });

    const signals = await store.signalsForIncident(incident.id, 300).catch(() => []);
    const neighbors = engine
      .view(
        [
          incident.properties.lon - 0.7,
          incident.properties.lat - 0.7,
          incident.properties.lon + 0.7,
          incident.properties.lat + 0.7,
        ],
        { limit: 200 },
      )
      .filter((f) => f.id !== incident.id)
      .map((f) => ({
        id: f.id,
        name: f.properties.name,
        kind: f.properties.kind,
        distanceKm:
          Math.round(
            Math.hypot(
              (f.properties.lon - incident.properties.lon) * 90,
              (f.properties.lat - incident.properties.lat) * 111,
            ) * 10,
          ) / 10,
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 6);

    return {
      incident,
      signals,
      neighbors,
      series: engine.series(incident.id),
    };
  });

  app.get<{ Params: { id: string } }>("/api/v1/incidents/:id/spread", async (req, reply) => {
    const incident = engine.incident(req.params.id);
    if (!incident) return reply.code(404).send({ error: "incident not found" });
    reply.header("Cache-Control", "no-store");
    const service = spread.service;
    if (!service) {
      return {
        incidentId: incident.id,
        status: spread.state === "downloading" ? "computing" : "unavailable",
        reason:
          spread.state === "downloading"
            ? "The spread model is still loading."
            : "Spread predictions are not enabled on this server.",
      };
    }
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      service.forecast(incident.id),
      new Promise<"wait">((resolve) => {
        timer = setTimeout(() => resolve("wait"), config.spread.routeWaitMs);
      }),
    ]);
    clearTimeout(timer);
    if (result === "wait") return reply.code(202).send({ incidentId: incident.id, status: "computing" });
    if (!result) return reply.code(404).send({ error: "incident not found" });
    return result;
  });

  app.get<{ Querystring: { bbox?: string; from?: string; to?: string; limit?: string } }>(
    "/api/v1/hotspots",
    async (req, reply) => {
      const bbox = parseBBox(req.query.bbox);
      if (!bbox) return reply.code(400).send({ error: "invalid bbox" });
      const now = Date.now();
      const from = Number.isFinite(Date.parse(req.query.from ?? ""))
        ? Date.parse(req.query.from!)
        : now - 60 * 60_000;
      const to = Number.isFinite(Date.parse(req.query.to ?? "")) ? Date.parse(req.query.to!) : now;
      const features = hotspots.snapshot(bbox, from, to, Math.min(20_000, Number(req.query.limit ?? 8000)));
      return { type: "FeatureCollection", features, count: features.length };
    },
  );

  app.get<{ Querystring: { hours?: string; bucketMinutes?: string } }>(
    "/api/v1/timeline",
    async (req) => {
      const hours = Math.min(72, Math.max(1, Number(req.query.hours ?? 24) || 24));
      const bucketMin = Math.min(60, Math.max(1, Number(req.query.bucketMinutes ?? 5) || 5));
      const now = Date.now();
      const from = now - hours * 3_600_000;
      const buckets = hotspots.histogram(from, now, bucketMin * 60_000);
      const events = engine
        .allIncidents()
        .filter((f) => f.properties.officialSince)
        .map((f) => ({
          id: f.id,
          name: f.properties.name,
          officialSince: f.properties.officialSince!,
          firstDetectedAt: f.properties.firstDetectedAt,
          areaAcres: f.properties.areaAcres,
        }));
      return { from: new Date(from).toISOString(), to: new Date(now).toISOString(), buckets, events };
    },
  );

  app.get("/api/v1/stats", async () => {
    const stats = hub.computeStats();
    return {
      ...stats,
      store: store.kind,
      redis: cache?.status ?? "disabled",
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      mode: config.dataMode,
      fusion: config.fusion,
      throughputBucket: bucket(stats.totalSignals),
    };
  });

  app.get("/api/v1/merges", async () => {
    const merges = await store.merges();
    const lead = merges.map((m) => m.leadTimeMinutes).sort((a, b) => a - b);
    return {
      count: merges.length,
      medianLeadTimeMinutes: lead.length > 0 ? lead[Math.floor(lead.length / 2)] : null,
      p90LeadTimeMinutes: lead.length > 0 ? lead[Math.floor(lead.length * 0.9)] : null,
      maxLeadTimeMinutes: lead.length > 0 ? lead[lead.length - 1] : null,
      merges,
    };
  });

  app.get<{ Querystring: { lat?: string; lon?: string; radiusKm?: string } }>("/api/v1/nearby", async (req, reply) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return reply.code(400).send({ error: "lat and lon are required" });
    }
    const radiusKm = Math.min(NEARBY_MAX_RADIUS_KM, Math.max(1, Number(req.query.radiusKm ?? 25) || 25));
    return nearbySummary({ lat, lon }, radiusKm, engine.allIncidents(), hazards);
  });

  const geocoder = new Geocoder({ userAgent: config.userAgent });
  const geocodeAllowed = perMinuteLimiter(30);
  app.get<{ Querystring: { q?: string } }>("/api/v1/geocode", async (req, reply) => {
    const q = String(req.query.q ?? "");
    if (q.trim().length < 3) return { results: [] };
    if (!geocodeAllowed(req.ip)) return reply.code(429).send({ error: "too many searches, try again in a minute" });
    try {
      return { results: await geocoder.search(q) };
    } catch (err) {
      log.warn({ err }, "geocode failed");
      return reply.code(502).send({ error: "place search is unavailable right now" });
    }
  });

  app.get<{ Querystring: { bbox?: string } }>("/api/v1/alerts", async (req, reply) => {
    const bbox = parseBBox(req.query.bbox);
    if (!bbox) return reply.code(400).send({ error: "invalid bbox" });
    const features = hazards.active(bbox);
    return { type: "FeatureCollection", features, count: features.length };
  });

  app.get("/api/v1/wind", async (_req, reply) => {
    const field = hub.currentWind ?? simulation?.windField(Date.now()) ?? null;
    if (!field) return reply.code(503).send({ error: "wind field not loaded yet" });
    return field;
  });

  /* ------------------------------------------------------------------ */
  /* Tier-1 ingest webhooks                                              */
  /* ------------------------------------------------------------------ */

  function verifySignature(rawBody: string, header: string | undefined): boolean {
    const secret = process.env.INGEST_WEBHOOK_SECRET;
    if (!secret) return true;
    if (!header) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const got = Buffer.from(header.replace(/^sha256=/, ""), "utf8");
    const want = Buffer.from(expected, "utf8");
    if (got.length !== want.length) return false;
    return timingSafeEqual(got, want);
  }

  app.post<{ Body: unknown }>("/api/v1/hooks/cad", async (req, reply) => {
    const raw = JSON.stringify(req.body ?? {});
    if (!verifySignature(raw, req.headers["x-firepulse-signature"] as string | undefined)) {
      return reply.code(401).send({ error: "invalid signature" });
    }
    const payload = req.body as Record<string, unknown> | Record<string, unknown>[];
    const items = Array.isArray(payload) ? payload : [payload];
    const now = new Date().toISOString();
    const signals: RawSignal[] = [];
    for (const item of items.slice(0, 200)) {
      const lat = Number(item.lat ?? item.latitude);
      const lon = Number(item.lon ?? item.lng ?? item.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const type = String(item.type ?? item.incident_type ?? "VEGETATION FIRE");
      if (/_FIRE|FIRE|SMOKE/i.test(type) === false) continue;
      const key = String(item.incident_number ?? item.id ?? createHash("sha1").update(`${lat},${lon},${type}`).digest("hex"));
      signals.push({
        id: `cad-ext-${key}`,
        source: "cad",
        kind: "dispatch",
        tier: 1,
        lon,
        lat,
        observedAt: String(item.call_time ?? item.observedAt ?? now),
        receivedAt: now,
        providerConfidence: 0.82,
        label: `${type} - ${String(item.address ?? "unknown location")}`,
        meta: {
          dedupeKey: `cad-ext-${key}`,
          incidentName: item.name,
          county: item.county,
          state: item.state,
          units: item.units,
          channel: "CAD webhook",
        },
      });
    }
    if (signals.length === 0) return reply.code(422).send({ error: "no vegetation-fire records found" });
    const inserted = await pipeline.ingestExternal(signals);
    await pipeline.runFusion();
    return { accepted: signals.length, inserted };
  });

  app.post<{ Body: unknown }>("/api/v1/hooks/crowd", async (req, reply) => {
    const raw = JSON.stringify(req.body ?? {});
    if (!verifySignature(raw, req.headers["x-firepulse-signature"] as string | undefined)) {
      return reply.code(401).send({ error: "invalid signature" });
    }
    const body = req.body as Record<string, unknown>;
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
      return reply.code(422).send({ error: "lat/lon required" });
    }
    const now = new Date().toISOString();
    const photo = typeof body.photo === "string" && /^https?:\/\//.test(body.photo);
    const bearing = Number(body.bearing);
    const signal: RawSignal = {
      id: `crowd-ext-${createHash("sha1").update(`${lat},${lon},${now}`).digest("hex").slice(0, 16)}`,
      source: "crowd",
      kind: "crowd",
      tier: 1,
      lon,
      lat,
      observedAt: typeof body.observedAt === "string" ? body.observedAt : now,
      receivedAt: now,
      providerConfidence: photo ? 0.82 : 0.45,
      bearing: Number.isFinite(bearing) ? ((Math.round(bearing) % 360) + 360) % 360 : undefined,
      distanceM: Number.isFinite(Number(body.distanceM)) ? Number(body.distanceM) : undefined,
      label: String(body.description ?? "Smoke sighting").slice(0, 160),
      meta: {
        photo: photo ? body.photo : undefined,
        cause: body.cause,
        county: body.county,
        state: body.state,
      },
    };
    const inserted = await pipeline.ingestExternal([signal]);
    await pipeline.runFusion();
    return reply.code(202).send({ accepted: true, inserted, id: signal.id });
  });

  /* ------------------------------------------------------------------ */
  /* WebSocket                                                          */
  /* ------------------------------------------------------------------ */

  await registerAccountRoutes(app, {
    config,
    accounts: deps.accounts,
    alerts: deps.alerts,
    sender: deps.sender,
    log,
  });

  app.get("/ws", { websocket: true }, (socket) => {
    hub.handle(socket);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: "not found", path: req.url });
  });

  app.setErrorHandler((err, req, reply) => {
    log.error({ err, path: req.url }, "request failed");
    reply.code(500).send({ error: "internal error" });
  });

  // Expose a metrics-friendly summary for load balancers.
  app.get("/metrics", async (_req, reply) => {
    const stats = hub.computeStats();
    const lines = [
      "# HELP firepulse_hotspots_total Thermal hotspots retained",
      "# TYPE firepulse_hotspots_total gauge",
      `firepulse_hotspots_total ${stats.hotspots}`,
      "# HELP firepulse_incidents Incidents by kind",
      "# TYPE firepulse_incidents gauge",
      `firepulse_incidents{kind="estimated"} ${stats.estimated}`,
      `firepulse_incidents{kind="official"} ${stats.official}`,
      "# HELP firepulse_ingest_rate_signals_per_second Signals ingested per second",
      "# TYPE firepulse_ingest_rate_signals_per_second gauge",
      `firepulse_ingest_rate_signals_per_second ${stats.ingestRate}`,
      "# HELP firepulse_ws_clients Connected WebSocket clients",
      "# TYPE firepulse_ws_clients gauge",
      `firepulse_ws_clients ${hub.clientCount}`,
      "# HELP firepulse_fusion_duration_ms Last fusion pass duration",
      "# TYPE firepulse_fusion_duration_ms gauge",
      `firepulse_fusion_duration_ms ${stats.lastFusionMs}`,
    ];
    reply.type("text/plain; version=0.0.4");
    return lines.join("\n") + "\n";
  });

  return app;
}
