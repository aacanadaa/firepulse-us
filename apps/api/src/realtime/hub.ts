import type { WebSocket } from "ws";
import type {
  ClientMessage,
  FeedStats,
  IncidentFeature,
  PublicConfig,
  ServerMessage,
  WindField,
} from "@firepulse/protocol";
import type { FusionEngine } from "../fusion/engine.js";
import { featureIntersectsBBox } from "../fusion/engine.js";
import type { HotspotLog } from "./hotspots.js";
import type { IngestMetrics } from "./metrics.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import type { RedisCache } from "../store/redis.js";

const CONUS: [number, number, number, number] = [-126, 22, -65, 51];

interface ClientState {
  id: number;
  socket: WebSocket;
  bbox: [number, number, number, number];
  zoom: number;
  at: string | null;
  minConfidence: number;
  lastHotspotSeq: number;
  alive: boolean;
  subscribed: boolean;
}

export interface HubDeps {
  engine: FusionEngine;
  hotspots: HotspotLog;
  metrics: IngestMetrics;
  config: AppConfig;
  publicConfig: PublicConfig;
  log: Logger;
  /** Optional: fans incident diffs out to sibling API instances. */
  cache?: RedisCache | null;
}

/**
 * WebSocket delta hub.
 *
 * Each client holds a viewport, an optional historical cursor, a confidence
 * floor and the hotspot sequence it has already received. A publish is
 * therefore O(changed features) to produce and O(clients) tiny bbox tests —
 * never a full dataset re-fetch.
 */
export class RealtimeHub {
  private clients = new Map<number, ClientState>();
  private nextId = 1;
  private seq = 0;
  private wind: WindField | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private lastStats: FeedStats;
  private instanceId = randomUUID();
  private remoteUnsubscribe: (() => void) | null = null;

  constructor(private readonly deps: HubDeps) {
    this.lastStats = this.computeStats();
    if (deps.cache) {
      this.remoteUnsubscribe = deps.cache.onRemoteDelta((raw) => this.applyRemote(raw));
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  start(): void {
    this.statsTimer = setInterval(() => this.broadcastStats(), this.deps.config.ws.statsMs);
    this.statsTimer.unref?.();
  }

  stop(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    for (const c of this.clients.values()) {
      try {
        c.socket.close(1001, "server shutting down");
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  setWind(field: WindField): void {
    const changed = !this.wind || this.wind.validAt !== field.validAt;
    this.wind = field;
    if (changed) {
      for (const c of this.clients.values()) {
        this.send(c, {
          type: "delta",
          seq: ++this.seq,
          serverTime: new Date().toISOString(),
          incidentsUpsert: [],
          incidentsRemove: [],
          hotspotsUpsert: [],
          hotspotsRemove: [],
          stats: this.lastStats,
          wind: field,
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Connection lifecycle                                                */
  /* ------------------------------------------------------------------ */

  handle(socket: WebSocket): void {
    if (this.clients.size >= this.deps.config.ws.maxClients) {
      socket.close(1013, "at capacity");
      return;
    }
    const client: ClientState = {
      id: this.nextId++,
      socket,
      bbox: [...CONUS],
      zoom: 4,
      at: null,
      minConfidence: 0,
      lastHotspotSeq: this.deps.hotspots.lastSeq,
      alive: true,
      subscribed: false,
    };
    this.clients.set(client.id, client);

    socket.on("message", (raw) => {
      try {
        this.onMessage(client, JSON.parse(raw.toString()) as ClientMessage);
      } catch (err) {
        this.deps.log.debug({ err }, "bad ws message");
      }
    });
    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("close", () => this.clients.delete(client.id));
    socket.on("error", () => this.clients.delete(client.id));

    this.send(client, {
      type: "hello",
      seq: ++this.seq,
      serverTime: new Date().toISOString(),
      config: this.deps.publicConfig,
      stats: this.computeStats(),
    });

    // Push an initial viewport immediately; the client can refine it after
    // the map has measured itself.
    this.sendSnapshot(client);
  }

  private onMessage(client: ClientState, msg: ClientMessage): void {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "subscribe":
      case "viewport": {
        const valid = Array.isArray(msg.bbox) && msg.bbox.length === 4 && msg.bbox.every((n) => Number.isFinite(n));
        if (valid) {
          client.bbox = clampBBox(msg.bbox as [number, number, number, number]);
          client.zoom = Number.isFinite(msg.zoom) ? msg.zoom : client.zoom;
        }
        if (msg.type === "subscribe" || !client.subscribed) {
          client.subscribed = true;
          this.sendSnapshot(client);
        }
        break;
      }
      case "time": {
        client.at = msg.at ?? null;
        this.sendSnapshot(client);
        break;
      }
      case "filter": {
        client.minConfidence = Math.max(0, Math.min(100, msg.minConfidence ?? 0));
        this.sendSnapshot(client);
        break;
      }
      case "ping": {
        this.send(client, { type: "pong", t: msg.t, serverTime: new Date().toISOString() });
        break;
      }
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Snapshots                                                           */
  /* ------------------------------------------------------------------ */

  buildSnapshot(client: {
    bbox: [number, number, number, number];
    at: string | null;
    minConfidence: number;
  }): Extract<ServerMessage, { type: "snapshot" }> {
    const { engine, hotspots, config } = this.deps;
    const now = Date.now();
    const atMs = client.at ? Date.parse(client.at) : now;
    const incidents = engine.view(client.bbox, {
      at: client.at ?? undefined,
      minConfidence: client.minConfidence,
      limit: config.ws.snapshotIncidentBudget,
    });
    const retentionStart = Math.max(atMs - config.ingest.hotspotRetentionHours * 3_600_000, now - 24 * 3_600_000 * 2);
    const hotspotFeatures = hotspots.snapshot(
      client.bbox,
      retentionStart,
      Number.isFinite(atMs) ? atMs : now,
      config.ws.snapshotHotspotBudget,
    );
    return {
      type: "snapshot",
      seq: ++this.seq,
      serverTime: new Date().toISOString(),
      incidents,
      hotspots: hotspotFeatures,
      wind: this.wind,
      stats: this.computeStats(),
      truncated:
        hotspotFeatures.length >= config.ws.snapshotHotspotBudget ||
        incidents.length >= config.ws.snapshotIncidentBudget,
    };
  }

  private sendSnapshot(client: ClientState): void {
    const snapshot = this.buildSnapshot(client);
    client.lastHotspotSeq = this.deps.hotspots.lastSeq;
    this.send(client, snapshot);
  }

  /* ------------------------------------------------------------------ */
  /* Delta fan-out                                                       */
  /* ------------------------------------------------------------------ */

  publish(upserts: IncidentFeature[], removes: string[], fromRemote = false): void {
    if (!fromRemote && this.deps.cache) {
      // Horizontally scaled API instances: the ingestion leader computes the
      // diff once, siblings relay it to their own WebSocket sessions.
      void this.deps.cache.publish(JSON.stringify({ instanceId: this.instanceId, upserts, removes }));
    }
    if (this.clients.size === 0) return;
    const stats = this.computeStats();
    this.lastStats = stats;
    for (const client of this.clients.values()) {
      const visibleUpserts = upserts.filter(
        (f) =>
          f.properties.confidence >= client.minConfidence &&
          featureIntersectsBBox(f, client.bbox),
      );
      const visibleRemoves = removes.filter((id) => {
        // Removal frames are tiny; send them even when the feature is out of
        // view so a stale polygon can never survive a viewport change.
        return Boolean(id);
      });
      const { features, lastSeq, truncated } = this.deps.hotspots.since(
        client.lastHotspotSeq,
        client.bbox,
        this.deps.config.ws.snapshotHotspotBudget,
      );
      client.lastHotspotSeq = lastSeq;
      if (
        visibleUpserts.length === 0 &&
        visibleRemoves.length === 0 &&
        features.length === 0 &&
        !truncated
      ) {
        continue;
      }
      this.send(client, {
        type: "delta",
        seq: ++this.seq,
        serverTime: new Date().toISOString(),
        incidentsUpsert: visibleUpserts,
        incidentsRemove: visibleRemoves,
        hotspotsUpsert: features,
        hotspotsRemove: [],
        stats,
      });
    }
  }

  private applyRemote(raw: string): void {
    try {
      const msg = JSON.parse(raw) as {
        instanceId?: string;
        upserts?: IncidentFeature[];
        removes?: string[];
      };
      if (!msg || msg.instanceId === this.instanceId) return;
      this.publish(msg.upserts ?? [], msg.removes ?? [], true);
    } catch {
      /* ignore malformed fan-out */
    }
  }

  private broadcastStats(): void {
    if (this.clients.size === 0) return;
    const stats = this.computeStats();
    this.lastStats = stats;
    const msg: ServerMessage = {
      type: "stats",
      seq: ++this.seq,
      serverTime: new Date().toISOString(),
      stats,
    };
    const payload = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.socket.readyState === c.socket.OPEN) c.socket.send(payload);
    }
  }

  computeStats(): FeedStats {
    const { engine, hotspots, metrics } = this.deps;
    const counts = engine.counts();
    const stats: FeedStats = {
      hotspots: hotspots.count,
      estimated: counts.estimated,
      official: counts.official,
      ingestRate: 0,
      sourceRate: {},
      pipelineLatencyMs: 0,
      totalSignals: 0,
      medianLeadTimeMinutes: engine.medianLeadTime(),
      fusionRuns: engine.performanceSnapshot.runs,
      lastFusionMs: engine.performanceSnapshot.durationMs,
      clients: this.clients.size,
    };
    metrics.fill(stats);
    return stats;
  }

  private send(client: ClientState, msg: ServerMessage): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    try {
      client.socket.send(JSON.stringify(msg));
    } catch (err) {
      this.deps.log.debug({ err }, "ws send failed");
    }
  }

  /** Periodic liveness sweep for half-open sockets. */
  heartbeat(intervalMs = 30_000): NodeJS.Timeout {
    const timer = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.alive) {
          client.socket.terminate();
          this.clients.delete(client.id);
          continue;
        }
        client.alive = false;
        try {
          client.socket.ping();
        } catch {
          /* ignore */
        }
      }
    }, intervalMs);
    timer.unref?.();
    return timer;
  }
}

function clampBBox(b: [number, number, number, number]): [number, number, number, number] {
  const minLon = Math.max(-180, Math.min(b[0], b[2]));
  const maxLon = Math.min(180, Math.max(b[0], b[2]));
  const minLat = Math.max(-85, Math.min(b[1], b[3]));
  const maxLat = Math.min(85, Math.max(b[1], b[3]));
  return [minLon, minLat, maxLon, maxLat];
}
