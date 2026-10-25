import type { IncidentFeature, RawSignal } from "@firepulse/protocol";
import type {
  FusionAudit,
  MergeRecord,
  OfficialPerimeterRecord,
  Store,
} from "./types.js";

/**
 * In-memory store: same contract as PostgresStore, zero infrastructure.
 * Used for local dev, unit tests and the public demo deployment. Insertion
 * order is preserved so the diff engine remains deterministic.
 */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;

  private signals = new Map<string, RawSignal>();
  private dedupe = new Map<string, string>();
  private incidents = new Map<string, IncidentFeature>();
  private inactive = new Map<string, { incident: IncidentFeature; at: number }>();
  private perimeterRows: OfficialPerimeterRecord[] = [];
  private mergeRows: MergeRecord[] = [];
  private audits: FusionAudit[] = [];
  private seq = 0;

  async init(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}

  async insertSignals(signals: RawSignal[]): Promise<RawSignal[]> {
    const inserted: RawSignal[] = [];
    for (const s of signals) {
      const key = `${s.source}:${(s.meta?.dedupeKey as string | undefined) ?? s.id}`;
      if (this.dedupe.has(key)) continue;
      this.signals.set(s.id, s);
      this.dedupe.set(key, s.id);
      inserted.push(s);
    }
    return inserted;
  }

  async recentSignals(sinceMs: number, untilMs = Number.POSITIVE_INFINITY): Promise<RawSignal[]> {
    const out: RawSignal[] = [];
    for (const s of this.signals.values()) {
      const t = Date.parse(s.observedAt);
      if (t >= sinceMs && t <= untilMs) out.push(s);
    }
    out.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    return out;
  }

  async signalsForIncident(id: string, limit = 250): Promise<RawSignal[]> {
    const inc = this.incidents.get(id) ?? this.inactive.get(id)?.incident;
    if (!inc) return [];
    const cells = new Set(inc.properties.cells ?? []);
    const t0 = Date.parse(inc.properties.firstDetectedAt);
    const t1 = Date.now();
    const out: RawSignal[] = [];
    for (const s of this.signals.values()) {
      const t = Date.parse(s.observedAt);
      if (t < t0 || t > t1) continue;
      if (s.h3 && cells.size > 0 && !cells.has(s.h3)) continue;
      out.push(s);
    }
    out.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    return out.slice(-limit);
  }

  async purgeSignals(olderThan: Date): Promise<number> {
    const cutoff = olderThan.getTime();
    let removed = 0;
    for (const [id, s] of this.signals) {
      if (Date.parse(s.observedAt) < cutoff) {
        this.signals.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      const live = new Set([...this.signals.values()].map((s) => `${s.source}:${(s.meta?.dedupeKey as string | undefined) ?? s.id}`));
      for (const [k] of this.dedupe) if (!live.has(k)) this.dedupe.delete(k);
    }
    return removed;
  }

  async upsertIncidents(upserts: IncidentFeature[]): Promise<void> {
    for (const f of upserts) {
      this.inactive.delete(f.id);
      this.incidents.set(f.id, f);
    }
  }

  async deactivateIncidents(ids: string[], reason: "expired" | "merged"): Promise<void> {
    for (const id of ids) {
      const inc = this.incidents.get(id);
      if (!inc) continue;
      this.incidents.delete(id);
      inc.properties.status = reason === "merged" ? "merged" : inc.properties.status;
      this.inactive.set(id, { incident: inc, at: Date.now() });
    }
  }

  async activeIncidents(): Promise<IncidentFeature[]> {
    return [...this.incidents.values()];
  }

  async incidentById(id: string): Promise<IncidentFeature | null> {
    return this.incidents.get(id) ?? this.inactive.get(id)?.incident ?? null;
  }

  async insertPerimeter(p: OfficialPerimeterRecord): Promise<void> {
    // WFIGS republishes every incident on every poll; only a new
    // publication time is a new revision.
    if (this.perimeterRows.some((r) => r.incidentId === p.incidentId && r.validTo === null && r.publishedAt === p.publishedAt)) {
      return;
    }
    // SCD-2: close the previous open revision for this incident.
    for (const row of this.perimeterRows) {
      if (row.incidentId === p.incidentId && row.validTo === null) row.validTo = p.validFrom;
    }
    this.perimeterRows.push(p);
  }

  async perimeters(): Promise<OfficialPerimeterRecord[]> {
    return [...this.perimeterRows];
  }

  async recordMerge(m: MergeRecord): Promise<void> {
    if (this.mergeRows.some((x) => x.estimateId === m.estimateId && x.officialId === m.officialId)) return;
    this.mergeRows.push(m);
  }

  async merges(): Promise<MergeRecord[]> {
    return [...this.mergeRows];
  }

  async recordFusionRun(audit: FusionAudit): Promise<void> {
    this.audits.push(audit);
    if (this.audits.length > 500) this.audits.shift();
    this.seq++;
  }

  auditTrail(): FusionAudit[] {
    return [...this.audits];
  }
}
