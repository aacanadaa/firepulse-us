import { destination, EVIDENCE_WINDOW_MAX_MIN, type RawSignal } from "@firepulse/protocol";
import type { AppConfig } from "./config.js";
import type { Store } from "./store/types.js";
import type { FusionEngine } from "./fusion/engine.js";
import type { RealtimeHub } from "./realtime/hub.js";
import type { HotspotLog } from "./realtime/hotspots.js";
import type { IngestMetrics } from "./realtime/metrics.js";
import type { OfficialAdapter, SourceAdapter } from "./sources/types.js";
import type { FireSimulation } from "./simulation/generator.js";
import { cellOf } from "./h3.js";
import type { Logger } from "pino";

/** Debounce between a batch landing and the fusion pass it triggers. */
const FUSION_DEBOUNCE_MS = 1_000;

interface Task {
  name: string;
  intervalMs: number;
  timer: NodeJS.Timeout | null;
  running: boolean;
}

/**
 * Ingestion + fusion orchestrator.
 *
 * Adapters pull on their own cadence; every batch is normalised (H3 cell,
 * stable id, received-at) and appended to the store + hotspot log. A single
 * fusion loop at 4 s turns the evidence window into diffs. Adapters never
 * talk to the WebSocket layer — that separation is what makes back-pressure
 * and replay possible.
 */
export class Pipeline {
  private tasks: Task[] = [];
  private fusionTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private windTimer: NodeJS.Timeout | null = null;
  private fusionSoon: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private stopped = false;

  constructor(
    private readonly deps: {
      store: Store;
      engine: FusionEngine;
      hub: RealtimeHub;
      hotspots: HotspotLog;
      metrics: IngestMetrics;
      config: AppConfig;
      adapters: SourceAdapter[];
      officialAdapter: OfficialAdapter | null;
      simulation: FireSimulation | null;
      log: Logger;
    },
  ) {}

  async bootstrap(): Promise<void> {
    const { store, engine, hotspots, metrics, config, simulation, log } = this.deps;
    const now = Date.now();

    if (simulation) {
      // 24 h of history so the time scrubber has something real to replay.
      const from = now - Math.max(24, config.ingest.hotspotRetentionHours) * 3_600_000;
      const historical = simulation.generate(from, now);
      log.info({ signals: historical.length }, "seeding historical signals");
      const normalized = historical.map((s) => this.normalize(s, now));
      await store.insertSignals(normalized);
      hotspots.add(normalized, now);
      metrics.record(normalized, now);

      const official = simulation.officialDue(from, now);
      if (official.length > 0) {
        await engine.ingestOfficial(
          official.map((o) => o.feature),
          official.map((o) => o.perimeter),
          now,
        );
        log.info({ incidents: official.length }, "seeded official perimeters");
      }
    }

    await engine.hydrate();
    await this.runFusion(now);
    log.info(
      { hotspots: hotspots.count, incidents: engine.allIncidents().length },
      "pipeline bootstrap complete",
    );
  }

  start(): void {
    const { adapters, config, log } = this.deps;

    for (const adapter of adapters) {
      if (!adapter.enabled) continue;
      this.tasks.push(this.schedule(adapter.id, adapter.intervalMs, () => this.pollSource(adapter)));
    }

    if (this.deps.officialAdapter?.enabled) {
      const official = this.deps.officialAdapter;
      this.tasks.push(this.schedule("official", official.intervalMs, () => this.pollOfficial(official)));
    }

    this.fusionTimer = setInterval(() => {
      void this.runFusion();
    }, config.fusion.intervalMs);
    this.fusionTimer.unref?.();

    this.purgeTimer = setInterval(() => void this.purge(), 10 * 60_000);
    this.purgeTimer.unref?.();

    if (this.deps.simulation) {
      const sim = this.deps.simulation;
      const tick = () => {
        const field = sim.windField(Date.now());
        this.deps.hub.setWind(field);
      };
      tick();
      this.windTimer = setInterval(tick, 5 * 60_000);
      this.windTimer.unref?.();
    }

    log.info(
      { adapters: adapters.length, fusionMs: config.fusion.intervalMs },
      "ingestion pipeline started",
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.tasks) if (t.timer) clearInterval(t.timer);
    if (this.fusionTimer) clearInterval(this.fusionTimer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    if (this.windTimer) clearInterval(this.windTimer);
    if (this.fusionSoon) clearTimeout(this.fusionSoon);
  }

  /**
   * Signals are kept for the longer of the hotspot display window and the
   * longest fusion evidence window; anything older is never used again.
   */
  get retentionMs(): number {
    return Math.max(
      this.deps.config.ingest.hotspotRetentionHours * 3_600_000,
      EVIDENCE_WINDOW_MAX_MIN * 60_000,
    );
  }

  /** Coalesces a burst of inserts into one fusion pass. */
  private requestFusion(): void {
    if (!this.deps.config.fusion.onIngest || this.stopped || this.fusionSoon) return;
    this.fusionSoon = setTimeout(() => {
      this.fusionSoon = null;
      void this.runFusion();
    }, FUSION_DEBOUNCE_MS);
    this.fusionSoon.unref?.();
  }

  /** Used by the crowd-sourced and CAD webhook endpoints. */
  async ingestExternal(signals: RawSignal[]): Promise<number> {
    const now = Date.now();
    const normalized = signals.map((s) => this.normalize(s, now));
    const inserted = await this.deps.store.insertSignals(normalized);
    if (inserted > 0) {
      this.deps.hotspots.add(normalized, now);
      this.deps.metrics.record(normalized, now);
      this.requestFusion();
    }
    return inserted;
  }

  normalize(signal: RawSignal, now: number): RawSignal {
    // Reject nonsense coordinates before they reach PostGIS.
    let lon = Math.max(-180, Math.min(180, signal.lon));
    let lat = Math.max(-85, Math.min(85, signal.lat));
    let meta = { ...(signal.meta ?? {}) };

    // Bearings describe where the *fire* is, not where the observer stands.
    // Project range-bearing observations (PTZ cameras, crowd reports) onto
    // the estimated target so the cluster forms at the smoke column instead
    // of at the camera mast.
    if (
      (signal.kind === "camera" || signal.kind === "crowd") &&
      Number.isFinite(signal.bearing) &&
      Number.isFinite(signal.distanceM) &&
      (signal.distanceM ?? 0) > 0
    ) {
      const target = destination({ lon, lat }, signal.bearing!, (signal.distanceM ?? 0) / 1000);
      meta = {
        ...meta,
        observer: [lon, lat],
        bearing: signal.bearing,
        distanceM: signal.distanceM,
        projected: true,
      };
      lon = target.lon;
      lat = target.lat;
    }

    const h3 = cellOf(lon, lat);
    const dedupeKey =
      (meta.dedupeKey as string | undefined) ??
      `${signal.source}:${signal.observedAt}:${lon.toFixed(4)},${lat.toFixed(4)}`;
    return {
      ...signal,
      lon,
      lat,
      h3,
      receivedAt: new Date(now).toISOString(),
      meta: { ...meta, dedupeKey },
    };
  }

  async runFusion(now = Date.now()): Promise<void> {
    if (this.stopped) return;
    try {
      const result = await this.deps.engine.run(now);
      this.deps.hub.publish(result.upserts, result.removes);
    } catch (err) {
      this.deps.log.error({ err }, "fusion pass failed");
    }
  }

  private async pollSource(adapter: SourceAdapter): Promise<void> {
    const now = Date.now();
    try {
      const cutoff = now - this.retentionMs;
      const signals = (await adapter.poll({ now, since: now - adapter.intervalMs - 2_000 })).filter(
        (s) => Date.parse(s.observedAt) >= cutoff,
      );
      if (signals.length === 0) return;
      const normalized = signals.map((s) => this.normalize(s, now));
      const inserted = await this.deps.store.insertSignals(normalized);
      if (inserted < normalized.length) {
        this.deps.metrics.recordDrop(normalized.length - inserted);
      }
      if (inserted > 0) {
        this.deps.hotspots.add(normalized, now);
        this.deps.metrics.record(normalized, now);
        // Hotspots are pushed immediately on the next fusion tick; if the
        // fusion loop is idle, publish an empty delta so heat still streams.
        this.deps.hub.publish([], []);
        this.requestFusion();
      }
    } catch (err) {
      this.deps.log.warn({ err, adapter: adapter.id }, "source poll failed");
    }
  }

  private async pollOfficial(adapter: OfficialAdapter): Promise<void> {
    const now = Date.now();
    try {
      const batch = await adapter.poll({ now, since: this.startedAt - 24 * 3_600_000 });
      if (batch.features.length === 0) return;
      const delta = await this.deps.engine.ingestOfficial(batch.features, batch.perimeters, now);
      if (delta.upserts.length > 0) this.deps.hub.publish(delta.upserts, delta.removes);
      // Estimates fold into new perimeters on the next pass.
      this.requestFusion();
      this.deps.log.info(
        { incidents: batch.features.length, adapter: adapter.id },
        "official ground truth ingested",
      );
    } catch (err) {
      this.deps.log.warn({ err, adapter: adapter.id }, "official poll failed");
    }
  }

  private async purge(): Promise<void> {
    const cutoff = new Date(Date.now() - this.retentionMs);
    try {
      const removed = await this.deps.store.purgeSignals(cutoff);
      this.deps.hotspots.trim();
      if (removed > 0) this.deps.log.info({ removed }, "purged aged signals");
    } catch (err) {
      this.deps.log.warn({ err }, "purge failed");
    }
  }

  private schedule(name: string, intervalMs: number, fn: () => Promise<void>): Task {
    const task: Task = { name, intervalMs, timer: null, running: false };
    const tick = async () => {
      if (task.running) return;
      task.running = true;
      try {
        await fn();
      } finally {
        task.running = false;
      }
    };
    // Stagger the first poll so adapters do not fire in lockstep.
    setTimeout(() => void tick(), Math.random() * Math.min(intervalMs, 3000));
    task.timer = setInterval(() => void tick(), intervalMs);
    task.timer.unref?.();
    return task;
  }
}
