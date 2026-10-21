import Redis from "ioredis";
import type { IncidentFeature } from "@firepulse/protocol";

const GEO_KEY = "fp:geo:incidents";
const HASH_KEY = "fp:inc:payload";
const DELTA_CHANNEL = "fp:deltas";

/**
 * Redis accelerator.
 *
 * - Spatial index: incident centroids live in a GEO set, so a viewport query
 *   is `GEOSEARCH ... BYBOX` (O(log N + M)) followed by one `HMGET`.
 * - Payload store: serialised IncidentFeatures, refreshed on every delta.
 * - Pub/Sub: every published delta is fanned out so horizontally scaled API
 *   instances keep identical in-memory state and WebSocket sessions.
 *
 * When Redis is absent every method no-ops and callers fall back to the
 * system of record. The cache is an accelerator, never a dependency.
 */
export class RedisCache {
  private client: Redis | null = null;
  private sub: Redis | null = null;
  private ready = false;
  private lastError = "";
  private listeners = new Set<(msg: string) => void>();

  constructor(private readonly url: string) {}

  get available(): boolean {
    return this.ready;
  }

  get status(): string {
    return this.ready ? "connected" : this.lastError || "disabled";
  }

  async connect(): Promise<void> {
    if (!this.url) {
      this.lastError = "no REDIS_URL";
      return;
    }
    try {
      this.client = new Redis(this.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 1200,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 300, 1500)),
      });
      this.client.on("error", (err) => {
        this.ready = false;
        this.lastError = err.message;
      });
      await this.client.connect();
      this.ready = true;
      this.lastError = "";
    } catch (err) {
      this.ready = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.client?.disconnect();
      this.client = null;
    }
  }

  async subscribe(onDelta: (raw: string) => void): Promise<void> {
    if (!this.ready || !this.url) return;
    try {
      this.sub = new Redis(this.url, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await this.sub.connect();
      await this.sub.subscribe(DELTA_CHANNEL);
      this.sub.on("message", (_channel, message) => {
        for (const fn of this.listeners) fn(message);
        onDelta(message);
      });
    } catch {
      this.sub?.disconnect();
      this.sub = null;
    }
  }

  onRemoteDelta(fn: (msg: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async publish(raw: string): Promise<void> {
    if (!this.ready || !this.client) return;
    try {
      await this.client.publish(DELTA_CHANNEL, raw);
    } catch {
      /* cache is best-effort */
    }
  }

  async upsertIncidents(features: IncidentFeature[]): Promise<void> {
    if (!this.ready || !this.client || features.length === 0) return;
    const pipeline = this.client.pipeline();
    for (const f of features) {
      pipeline.geoadd(GEO_KEY, f.properties.lon, f.properties.lat, f.id);
      pipeline.hset(HASH_KEY, f.id, JSON.stringify(f));
    }
    try {
      await pipeline.exec();
    } catch {
      /* ignore */
    }
  }

  async removeIncidents(ids: string[]): Promise<void> {
    if (!this.ready || !this.client || ids.length === 0) return;
    const pipeline = this.client.pipeline();
    pipeline.zrem(GEO_KEY, ...ids);
    pipeline.hdel(HASH_KEY, ...ids);
    try {
      await pipeline.exec();
    } catch {
      /* ignore */
    }
  }

  /**
   * Viewport fetch from the Redis spatial index.
   * Returns null when Redis is unavailable or the index is cold, signalling
   * the caller to fall back to PostGIS.
   */
  async viewport(
    bbox: [number, number, number, number],
    limit = 900,
  ): Promise<IncidentFeature[] | null> {
    if (!this.ready || !this.client) return null;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const lonSpanM = Math.max(500, (maxLon - minLon) * 111_320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180));
    const latSpanM = Math.max(500, (maxLat - minLat) * 110_574);
    try {
      const ids = (await this.client.call(
        "GEOSEARCH",
        GEO_KEY,
        "FROMLONLAT",
        String((minLon + maxLon) / 2),
        String((minLat + maxLat) / 2),
        "BYBOX",
        String(lonSpanM),
        String(latSpanM),
        "m",
        "ASC",
        "COUNT",
        String(limit),
      )) as string[];
      if (!ids || ids.length === 0) return null;
      const payloads = await this.client.hmget(HASH_KEY, ...ids);
      const out: IncidentFeature[] = [];
      for (const raw of payloads) {
        if (!raw) continue;
        try {
          out.push(JSON.parse(raw) as IncidentFeature);
        } catch {
          /* skip corrupt entry */
        }
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Best-effort JSON value with a TTL; null on miss or outage. */
  async getJson<T>(key: string): Promise<T | null> {
    if (!this.ready || !this.client) return null;
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlMs: number): Promise<void> {
    if (!this.ready || !this.client) return;
    try {
      await this.client.set(key, JSON.stringify(value), "PX", Math.max(1000, Math.round(ttlMs)));
    } catch {
      /* cache is best-effort */
    }
  }

  async close(): Promise<void> {
    this.ready = false;
    await this.client?.quit().catch(() => undefined);
    await this.sub?.quit().catch(() => undefined);
    this.client = null;
    this.sub = null;
  }
}
