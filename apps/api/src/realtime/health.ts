import type { SourceHealth } from "@firepulse/protocol";

interface Entry {
  id: string;
  label: string;
  kind: SourceHealth["kind"];
  intervalMs: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  lastObservedAt?: number;
  lastCount?: number;
  warnings: string[];
}

/** Per-feed poll outcomes, so a silent upstream is visible, not just quiet. */
export class SourceHealthBoard {
  private entries = new Map<string, Entry>();

  register(id: string, label: string, kind: SourceHealth["kind"], intervalMs: number): void {
    if (!this.entries.has(id)) this.entries.set(id, { id, label, kind, intervalMs, warnings: [] });
  }

  success(id: string, opts: { now: number; count: number; observedAt?: (string | number | undefined)[]; warnings?: string[] }): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.lastSuccessAt = opts.now;
    e.lastCount = opts.count;
    e.warnings = opts.warnings ?? [];
    let newest = -Infinity;
    for (const t of opts.observedAt ?? []) {
      const ms = typeof t === "number" ? t : Date.parse(t ?? "");
      if (Number.isFinite(ms) && ms > newest) newest = ms;
    }
    // An empty poll keeps the previous pass time: "last pass 3 h ago" stays true.
    if (Number.isFinite(newest)) e.lastObservedAt = Math.max(e.lastObservedAt ?? -Infinity, newest);
  }

  failure(id: string, now: number, err: unknown): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.lastErrorAt = now;
    e.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 240);
  }

  snapshot(now = Date.now()): SourceHealth[] {
    return [...this.entries.values()].map((e) => {
      const failedLast = e.lastErrorAt !== undefined && (e.lastSuccessAt === undefined || e.lastErrorAt > e.lastSuccessAt);
      const status: SourceHealth["status"] = failedLast
        ? "error"
        : e.lastSuccessAt === undefined
          ? "pending"
          : now - e.lastSuccessAt > 3 * e.intervalMs
            ? "stale"
            : "ok";
      const iso = (t?: number) => (t === undefined ? undefined : new Date(t).toISOString());
      return {
        id: e.id,
        label: e.label,
        kind: e.kind,
        intervalMs: e.intervalMs,
        status,
        lastSuccessAt: iso(e.lastSuccessAt),
        lastErrorAt: iso(e.lastErrorAt),
        lastError: failedLast ? e.lastError : undefined,
        lastObservedAt: iso(e.lastObservedAt),
        lastCount: e.lastCount,
        warnings: e.warnings.length > 0 ? e.warnings : undefined,
      };
    });
  }
}
