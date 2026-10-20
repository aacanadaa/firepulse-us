import {
  hotspotConfidence,
  type HotspotFeature,
  type HotspotProperties,
  type RawSignal,
} from "@firepulse/protocol";

interface Entry {
  seq: number;
  feature: HotspotFeature;
  t: number;
}

/**
 * Sequenced ring buffer of thermal detections.
 *
 * Clients receive the 24 h window once in their snapshot, then only hotspots
 * with `seq > lastSeq` that intersect their viewport. This is what keeps a
 * 20 000-point layer cheap: no re-fetch, no re-send, monotonic sequencing.
 */
export class HotspotLog {
  private entries: Entry[] = [];
  private seq = 0;

  constructor(
    private readonly retentionMs: number,
    private readonly maxEntries = 120_000,
  ) {}

  get lastSeq(): number {
    return this.seq;
  }

  get count(): number {
    return this.entries.length;
  }

  add(signals: RawSignal[], now = Date.now()): HotspotFeature[] {
    const added: HotspotFeature[] = [];
    for (const s of signals) {
      if (s.kind !== "thermal") continue;
      this.seq++;
      const properties: HotspotProperties = {
        id: s.id,
        source: s.source,
        observedAt: s.observedAt,
        receivedAt: s.receivedAt,
        confidence: hotspotConfidence(s),
        frp: s.frp ?? 0,
        lon: s.lon,
        lat: s.lat,
        tier: s.tier ?? 2,
        label: s.label,
      };
      const feature: HotspotFeature = {
        type: "Feature",
        id: s.id,
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties,
      };
      this.entries.push({ seq: this.seq, feature, t: Date.parse(s.observedAt) || now });
      added.push(feature);
    }
    this.trim(now);
    return added;
  }

  /**
   * Hotspots in a viewport and time window, bounded but time-representative.
   *
   * A 24 h window can exceed the client budget; returning only the newest N
   * would silently destroy replay depth. Keep every recent detection and
   * sample older ones uniformly, so the scrubber still has the full day.
   */
  snapshot(
    bbox: [number, number, number, number],
    fromMs: number,
    toMs: number,
    limit: number,
  ): HotspotFeature[] {
    const matches: Entry[] = [];
    for (const e of this.entries) {
      if (e.t < fromMs || e.t > toMs) continue;
      const [lon, lat] = e.feature.geometry.coordinates;
      if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
      matches.push(e);
    }
    if (matches.length <= limit) return matches.map((e) => e.feature);

    const keepRecent = Math.min(2200, Math.floor(limit * 0.3));
    const older = matches.slice(0, matches.length - keepRecent);
    const recent = matches.slice(-keepRecent);
    const room = Math.max(1, limit - keepRecent);
    const stride = Math.max(1, Math.ceil(older.length / room));
    const sampled: Entry[] = [];
    for (let i = 0; i < older.length; i += stride) sampled.push(older[i]!);
    return [...sampled, ...recent].map((e) => e.feature);
  }

  /** New hotspots after a client sequence, filtered to its viewport. */
  since(
    seq: number,
    bbox: [number, number, number, number],
    limit = 4000,
  ): { features: HotspotFeature[]; lastSeq: number; truncated: boolean } {
    const features: HotspotFeature[] = [];
    let lastSeq = seq;
    let truncated = false;
    for (const e of this.entries) {
      if (e.seq <= seq) continue;
      lastSeq = e.seq;
      const [lon, lat] = e.feature.geometry.coordinates;
      if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
      if (features.length >= limit) {
        truncated = true;
        continue;
      }
      features.push(e.feature);
    }
    return { features, lastSeq, truncated };
  }

  /** Time histogram for the scrubber: hotspot count + summed FRP per bucket. */
  histogram(
    fromMs: number,
    toMs: number,
    bucketMs: number,
  ): { t: string; hotspots: number; frp: number }[] {
    const buckets = Math.max(1, Math.ceil((toMs - fromMs) / bucketMs));
    const counts = new Array<number>(buckets).fill(0);
    const frp = new Array<number>(buckets).fill(0);
    for (const e of this.entries) {
      if (e.t < fromMs || e.t > toMs) continue;
      const idx = Math.min(buckets - 1, Math.floor((e.t - fromMs) / bucketMs));
      counts[idx] = (counts[idx] ?? 0) + 1;
      frp[idx] = (frp[idx] ?? 0) + e.feature.properties.frp;
    }
    return counts.map((c, i) => ({
      t: new Date(fromMs + i * bucketMs).toISOString(),
      hotspots: c,
      frp: Math.round((frp[i] ?? 0) * 10) / 10,
    }));
  }

  countInBBox(bbox: [number, number, number, number]): number {
    let n = 0;
    for (const e of this.entries) {
      const [lon, lat] = e.feature.geometry.coordinates;
      if (lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]) n++;
    }
    return n;
  }

  trim(now = Date.now()): void {
    const cutoff = now - this.retentionMs;
    let i = 0;
    while (i < this.entries.length && this.entries[i]!.t < cutoff) i++;
    if (i > 0) this.entries.splice(0, i);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }
}
