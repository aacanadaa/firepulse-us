import pino from "pino";
import { config } from "./config.js";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import { RedisCache } from "./store/redis.js";
import { FusionEngine } from "./fusion/engine.js";
import { HotspotLog } from "./realtime/hotspots.js";
import { IngestMetrics } from "./realtime/metrics.js";
import { RealtimeHub } from "./realtime/hub.js";
import { Pipeline } from "./pipeline.js";
import { createServer } from "./server.js";
import { FireSimulation } from "./simulation/generator.js";
import { createSimulatedAdapters, createSimulatedOfficialAdapter } from "./sources/simulated.js";
import { createFirmsAdapters, createNwsAdapter, createWfigsAdapter } from "./sources/live.js";
import type { OfficialAdapter, SourceAdapter } from "./sources/types.js";
import type { Store } from "./store/types.js";

const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } },
});

async function chooseStore(): Promise<Store> {
  if (config.databaseUrl) {
    const pg = new PostgresStore(config.databaseUrl);
    try {
      await pg.init();
      log.info("using Postgres/PostGIS store");
      return pg;
    } catch (err) {
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

  if (config.dataMode === "simulation" || !config.dataMode) {
    if (!simulation) throw new Error("simulation mode requires a generator");
    adapters = createSimulatedAdapters(simulation);
    officialAdapter = createSimulatedOfficialAdapter(simulation);
  } else {
    adapters = [...createFirmsAdapters(), createNwsAdapter()];
    officialAdapter = createWfigsAdapter();
    if (adapters.length === 0) {
      log.warn("live mode with no FIRMS_MAP_KEY — only WFIGS/NWS will ingest");
    }
  }

  // In hybrid mode we keep the demo alive alongside real feeds.
  if (config.dataMode === "hybrid" && simulation) {
    adapters = [...adapters, ...createSimulatedAdapters(simulation)];
    officialAdapter = officialAdapter ?? createSimulatedOfficialAdapter(simulation);
  }

  const engine = new FusionEngine(store, config, log, cache.available ? cache : undefined);
  const hotspots = new HotspotLog(config.ingest.hotspotRetentionHours * 3_600_000);
  const metrics = new IngestMetrics();
  const hub = new RealtimeHub({
    engine,
    hotspots,
    metrics,
    config,
    publicConfig: config.publicConfig,
    log,
    cache,
  });

  const pipeline = new Pipeline({
    store,
    engine,
    hub,
    hotspots,
    metrics,
    config,
    adapters,
    officialAdapter,
    simulation,
    log,
  });

  await pipeline.bootstrap();

  const app = await createServer({
    config,
    store,
    cache: cache.available ? cache : null,
    engine,
    hub,
    hotspots,
    pipeline,
    simulation,
    log,
    startedAt,
  });

  await app.listen({ port: config.port, host: config.host });
  pipeline.start();
  hub.start();
  const heartbeat = hub.heartbeat();

  log.info(
    {
      url: `http://127.0.0.1:${config.port}`,
      ws: `ws://127.0.0.1:${config.port}/ws`,
      mode: config.dataMode,
      store: store.kind,
      fusion: `${config.fusion.radiusKm}km / ${config.fusion.windowMin}min / ${config.fusion.intervalMs}ms`,
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
