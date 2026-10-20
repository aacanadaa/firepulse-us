import type { RawSignal, SourceId, FeedStats } from "@firepulse/protocol";

/**
 * Sliding-window ingest telemetry (60 s). Used by the HUD to prove the
 * pipeline is live and to surface per-source health.
 */
export class IngestMetrics {
  private events: { t: number; source: SourceId }[] = [];
  private latencies: number[] = [];
  private total = 0;
  private dropped = 0;

  record(signals: RawSignal[], now = Date.now()): void {
    for (const s of signals) {
      this.events.push({ t: now, source: s.source });
      const observed = Date.parse(s.observedAt);
      // Ignore historical backfill (24 h replay seed) when measuring latency.
      if (Number.isFinite(observed) && now - observed < 3_600_000) {
        this.latencies.push(Math.max(0, now - observed));
        if (this.latencies.length > 500) this.latencies.shift();
      }
    }
    this.total += signals.length;
    this.trim(now);
  }

  recordDrop(n = 1): void {
    this.dropped += n;
  }

  private trim(now: number): void {
    const cutoff = now - 60_000;
    let i = 0;
    while (i < this.events.length && this.events[i]!.t < cutoff) i++;
    if (i > 0) this.events.splice(0, i);
  }

  ingestRate(now = Date.now()): number {
    this.trim(now);
    return Math.round((this.events.length / 60) * 10) / 10;
  }

  sourceRate(now = Date.now()): Partial<Record<SourceId, number>> {
    this.trim(now);
    const counts: Partial<Record<SourceId, number>> = {};
    for (const e of this.events) counts[e.source] = (counts[e.source] ?? 0) + 1;
    return counts;
  }

  p50Latency(): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0);
  }

  get totals(): { total: number; dropped: number } {
    return { total: this.total, dropped: this.dropped };
  }

  fill(stats: Partial<FeedStats>, now = Date.now()): void {
    stats.ingestRate = this.ingestRate(now);
    stats.sourceRate = this.sourceRate(now);
    stats.pipelineLatencyMs = this.p50Latency();
    stats.totalSignals = this.total;
  }
}
