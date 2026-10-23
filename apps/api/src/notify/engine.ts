import type { HazardAlertFeature, IncidentFeature, SpreadForecast } from "@firepulse/protocol";
import type { Logger } from "pino";
import type { AccountStore, AlertDraft } from "../accounts/types.js";
import { hazardAlerts, incidentAlerts, spreadAlerts, type Watcher } from "./rules.js";

const RELOAD_MS = 5 * 60_000;

function bboxOfRing(ring: number[][]): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon! < w) w = lon!;
    if (lon! > e) e = lon!;
    if (lat! < s) s = lat!;
    if (lat! > n) n = lat!;
  }
  return [w, s, e, n];
}

/** Watchers whose radius could reach a feature's box. */
function near(watchers: Watcher[], box: [number, number, number, number]): Watcher[] {
  return watchers.filter((w) => {
    const dLat = w.radiusKm / 110.574;
    const dLon = w.radiusKm / (111.32 * Math.max(0.05, Math.cos((w.lat * Math.PI) / 180)));
    return w.lon + dLon >= box[0] && w.lon - dLon <= box[2] && w.lat + dLat >= box[1] && w.lat - dLat <= box[3];
  });
}

/**
 * Turns fire and warning changes into alerts for the places people watch.
 * Every alert is stored with a dedupe key, so restarts and repeated
 * evaluation never send the same alert twice; the outbox delivers them.
 */
export class AlertEngine {
  private watchers: Watcher[] = [];
  private loadedAt = 0;

  constructor(
    private readonly deps: {
      accounts: AccountStore;
      log: Logger;
      /** Current fires and warnings, for the silent baseline of a new place. */
      incidents: () => IncidentFeature[];
      hazards: () => HazardAlertFeature[];
      /** Called when new alerts are waiting, so the outbox can send now. */
      onQueued?: () => void;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async reload(): Promise<void> {
    this.watchers = await this.deps.accounts.watchers();
    this.loadedAt = this.now();
  }

  /** Watched places as of the last reload. */
  get places(): Watcher[] {
    return this.watchers;
  }

  /** A next-day forecast came in for a fire. */
  async onSpread(f: IncidentFeature, forecast: SpreadForecast): Promise<number> {
    const watchers = await this.current();
    if (watchers.length === 0 || !forecast.corners) return 0;
    const c = forecast.corners;
    const box: [number, number, number, number] = [
      Math.min(c.nw[0], c.sw[0]),
      Math.min(c.sw[1], c.se[1]),
      Math.max(c.ne[0], c.se[0]),
      Math.max(c.nw[1], c.ne[1]),
    ];
    const inserted = await this.insert(spreadAlerts(f, forecast, near(watchers, box), this.now()), this.now());
    const queued = inserted.filter((a) => a.status === "pending").length;
    if (queued > 0) this.deps.onQueued?.();
    return queued;
  }

  private async current(): Promise<Watcher[]> {
    if (this.now() - this.loadedAt > RELOAD_MS) await this.reload();
    return this.watchers;
  }

  async onIncidents(features: IncidentFeature[]): Promise<number> {
    const watchers = await this.current();
    if (watchers.length === 0 || features.length === 0) return 0;
    const now = this.now();
    let queued = 0;
    for (const f of features) {
      const ring = f.geometry.coordinates[0] ?? [];
      const box = ring.length > 0 ? bboxOfRing(ring) : ([f.properties.lon, f.properties.lat, f.properties.lon, f.properties.lat] as const);
      const candidates = near(watchers, [...box] as [number, number, number, number]);
      if (candidates.length === 0) continue;
      const { first, closer } = incidentAlerts(f, candidates, now);
      const fresh = await this.insert(first, now);
      queued += fresh.length;
      // The first alert already says how close the fire is; a "now within"
      // alert only follows on a later pass.
      const justAlerted = new Set(fresh.map((a) => `${a.placeId}|${a.subjectId}`));
      queued += (
        await this.insert(
          closer.map((d) => (justAlerted.has(`${d.placeId}|${d.subjectId}`) ? { ...d, status: "baseline" as const } : d)),
          now,
        )
      ).filter((a) => a.status === "pending").length;
    }
    if (queued > 0) this.deps.onQueued?.();
    return queued;
  }

  async onHazards(alerts: HazardAlertFeature[]): Promise<number> {
    const watchers = await this.current();
    if (watchers.length === 0 || alerts.length === 0) return 0;
    const now = this.now();
    let queued = 0;
    for (const a of alerts) {
      const polygons = a.geometry.type === "Polygon" ? [a.geometry.coordinates] : a.geometry.coordinates;
      const box = bboxOfRing(polygons.flatMap((p) => p[0] ?? []));
      queued += (await this.insert(hazardAlerts(a, near(watchers, box), now), now)).filter((x) => x.status === "pending").length;
    }
    if (queued > 0) this.deps.onQueued?.();
    return queued;
  }

  /**
   * A newly added place already shows its fires and warnings on screen, so
   * record them as known instead of alerting about them.
   */
  async baseline(placeId: string): Promise<number> {
    await this.reload();
    const w = this.watchers.filter((x) => x.id === placeId);
    if (w.length === 0) return 0;
    const now = this.now();
    const drafts: AlertDraft[] = [];
    for (const f of this.deps.incidents()) {
      const { first, closer } = incidentAlerts(f, w, now);
      drafts.push(...first, ...closer);
    }
    for (const a of this.deps.hazards()) drafts.push(...hazardAlerts(a, w, now));
    const rows = await this.deps.accounts.insertAlerts(drafts.map((d) => ({ ...d, status: "baseline" as const })));
    return rows.length;
  }

  private async insert(drafts: AlertDraft[], _now: number) {
    if (drafts.length === 0) return [];
    // Duplicates (same place, kind, subject, revision) are dropped here; the
    // hourly cap is applied when the outbox sends.
    const inserted = await this.deps.accounts.insertAlerts(drafts);
    for (const a of inserted) {
      if (a.status === "pending") this.deps.log.info({ kind: a.kind, place: a.placeId, severity: a.severity }, "alert queued");
    }
    return inserted;
  }
}
