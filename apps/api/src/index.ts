import pino from "pino";
import { config } from "./config.js";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import { RedisCache } from "./store/redis.js";
import { FusionEngine } from "./fusion/engine.js";
import { HeatMask } from "./fusion/heatMask.js";
import { HotspotLog } from "./realtime/hotspots.js";
import { IngestMetrics } from "./realtime/metrics.js";
import { RealtimeHub } from "./realtime/hub.js";
import { Pipeline } from "./pipeline.js";
import { createServer } from "./server.js";
import { SpreadRuntime } from "./spread/index.js";
import { FireSimulation } from "./simulation/generator.js";
import { createSimulatedAdapters, createSimulatedOfficialAdapter } from "./sources/simulated.js";
import { createFirmsAdapters, createWfigsAdapter } from "./sources/live.js";
import { createNwsAdapter } from "./sources/nws.js";
import { LiveWind } from "./sources/wind.js";
import { HazardLayer } from "./realtime/hazards.js";
import { SourceHealthBoard } from "./realtime/health.js";
import type { HazardAdapter, OfficialAdapter, SourceAdapter } from "./sources/types.js";
import { MemoryAccountStore } from "./accounts/memory.js";
import { PostgresAccountStore } from "./accounts/postgres.js";
import { AlertEngine } from "./notify/engine.js";
import { PushOutbox, webPushSender, type PushSender } from "./notify/outbox.js";
import { SpreadScheduler } from "./spread/scheduler.js";
import type { Store } from "./store/types.js";

const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } },
});

async function chooseStore(): Promise<Store> {
  // Live production data (and, later, user accounts) must survive a
  // restart; never fall back to memory there.
  const requirePostgres = config.dataMode === "live" && process.env.NODE_ENV === "production";
  if (requirePostgres && !config.databaseUrl) {
    throw new Error("DATA_MODE=live in production requires DATABASE_URL");
  }
  if (config.databaseUrl) {
    const pg = new PostgresStore(config.databaseUrl);
    try {
      await pg.init();
      log.info("using Postgres/PostGIS store");
      return pg;
    } catch (err) {
      if (requirePostgres) throw err;
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "DATABASE_URL set but unreachable — falling back to in-memory store",
      );
      await pg.close().catch(() => undefined);
    }
  }
  log.warn("no DATABASE_URL — using in-memory store (dev/demo mode)");
  return new MemoryStore();
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const store = await chooseStore();

  const cache = new RedisCache(config.redisUrl);
  await cache.connect();
  if (config.redisUrl) log.info({ status: cache.status }, "redis cache");
  if (cache.available) {
    await cache.subscribe(() => undefined);
  }

  const simulation = config.simulated ? new FireSimulation(startedAt) : null;

  let adapters: SourceAdapter[] = [];
  let officialAdapter: OfficialAdapter | null = null;
  let hazardAdapter: HazardAdapter | null = null;
  let wind: LiveWind | null = null;

  if (config.dataMode === "simulation" || !config.dataMode) {
    if (!simulation) throw new Error("simulation mode requires a generator");
    adapters = createSimulatedAdapters(simulation);
    officialAdapter = createSimulatedOfficialAdapter(simulation);
  } else {
    adapters = createFirmsAdapters();
    officialAdapter = createWfigsAdapter();
    hazardAdapter = createNwsAdapter(config.userAgent);
    wind = new LiveWind({ userAgent: config.userAgent, timeoutMs: config.spread.httpTimeoutMs });
    if (adapters.length === 0) {
      log.warn("live mode with no FIRMS_MAP_KEY — no satellite detections; only WFIGS/NWS will ingest");
    }
  }

  // In hybrid mode we keep the demo alive alongside real feeds.
  if (config.dataMode === "hybrid" && simulation) {
    adapters = [...adapters, ...createSimulatedAdapters(simulation)];
    officialAdapter = officialAdapter ?? createSimulatedOfficialAdapter(simulation);
  }

  const heatMask = HeatMask.load(config.heatMaskPath);
  if (heatMask) log.info({ cells: heatMask.size }, "static heat-source mask loaded");
  else log.warn({ path: config.heatMaskPath }, "no static heat-source mask; refineries and flares may show as fires");
  const engine = new FusionEngine(store, config, log, cache.available ? cache : undefined, heatMask ?? undefined);
  const hotspots = new HotspotLog(config.ingest.hotspotRetentionHours * 3_600_000);
  const metrics = new IngestMetrics();
  const hazards = new HazardLayer();
  const health = new SourceHealthBoard();
  const hub = new RealtimeHub({
    engine,
    hotspots,
    metrics,
    config,
    publicConfig: config.publicConfig,
    log,
    cache,
    health,
    hazards,
  });

  const accounts = store instanceof PostgresStore ? new PostgresAccountStore(store.db) : new MemoryAccountStore();
  if (accounts.kind === "memory") log.warn("accounts are in memory: sign-ups and places are lost on restart");
  let sender: PushSender | null = null;
  if (config.push.publicKey && config.push.privateKey) {
    sender = await webPushSender(config.push);
  } else {
    log.warn("no VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY: alerts are recorded but not pushed");
  }
  const outbox = sender ? new PushOutbox({ accounts, sender, log }) : null;
  const alerts = new AlertEngine({
    accounts,
    log,
    incidents: () => engine.allIncidents(),
    hazards: () => hazards.active(),
    onQueued: () => void outbox?.flush(),
  });
  await alerts.reload();

  const pipeline = new Pipeline({
    store,
    engine,
    hub,
    hotspots,
    metrics,
    config,
    adapters,
    officialAdapter,
    hazardAdapter,
    hazards,
    health,
    wind,
    alerts,
    simulation,
    log,
  });

  await pipeline.bootstrap();

  const spread = new SpreadRuntime({
    config,
    log,
    cache: cache.available ? cache : null,
    incidents: engine,
    hotspots,
  });
  // Downloads (if any) happen in the background; the API serves meanwhile.
  void spread.start();
  const spreadScheduler = new SpreadScheduler({
    forecast: (id) => (spread.service ? spread.service.forecast(id) : Promise.resolve(null)),
    incidents: () => engine.allIncidents(),
    places: () => alerts.places,
    onForecast: (incident, forecast) => alerts.onSpread(incident, forecast),
    log,
  });

  const app = await createServer({
    config,
    store,
    cache: cache.available ? cache : null,
    engine,
    hub,
    hotspots,
    pipeline,
    simulation,
    spread,
    hazards,
    health,
    accounts,
    alerts,
    sender,
    spreadScheduler,
    log,
    startedAt,
  });

  await app.listen({ port: config.port, host: config.host });
  pipeline.start();
  outbox?.start();
  spreadScheduler.start();
  hub.start();
  const heartbeat = hub.heartbeat();

  log.info(
    {
      url: `http://127.0.0.1:${config.port}`,
      ws: `ws://127.0.0.1:${config.port}/ws`,
      mode: config.dataMode,
      store: store.kind,
      fusion: `${config.fusion.radiusKm}km / ${config.fusion.intervalMs}ms`,
    },
    "FirePulse API ready",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    clearInterval(heartbeat);
    hub.stop();
    outbox?.stop();
    spreadScheduler.stop();
    await pipeline.stop();
    await app.close().catch(() => undefined);
    await cache.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});
