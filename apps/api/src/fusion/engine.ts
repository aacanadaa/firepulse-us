import {
  bufferedHull,
  centroid,
  dbscan,
  estimateConfirmation,
  EVIDENCE_WINDOW_MAX_MIN,
  fuseConfidence,
  inEvidenceWindow,
  haversineKm,
  km2ToAcres,
  pointInRing,
  ringAreaSqKm,
  SOURCE_PROFILES,
  type IncidentFeature,
  type IncidentProperties,
  type RawSignal,
  type Ring,
  type SourceTag,
} from "@firepulse/protocol";
import { destination } from "@firepulse/protocol";
import type { MergeRecord, Store } from "../store/types.js";
import type { RedisCache } from "../store/redis.js";
import { cellOf, cellsOf, neighborhood } from "../h3.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "pino";
import { HeatMask } from "./heatMask.js";
import { isGenericName, whereName, type PlaceNamer } from "./placeNames.js";

const DETECTION_KINDS = new Set<RawSignal["kind"]>(["thermal", "dispatch", "camera", "crowd"]);
const CONTEXT_KINDS = new Set<RawSignal["kind"]>(["airquality", "weather"]);
const GROWTH_REF_MS = 10 * 60_000;
/** Smoke at an air monitor this close counts as context for a cluster. */
const AIR_MONITOR_REACH_KM = 25;
/** Farthest an official fire can be from a cluster and still cover it (name match). */
const OFFICIAL_REACH_KM = 12;
const MAX_HISTORY = 288;
const MAX_CELLS = 220;

interface Track {
  feature: IncidentFeature;
  signature: string;
  firstSeen: number;
  lastSignalAt: number;
  peakConfidence: number;
  memberIds: Set<string>;
  history: { t: number; area: number; frp: number; confidence: number; hotspots: number }[];
  rings: Ring[];
  mergedAt?: number;
}

export interface FusionDelta {
  upserts: IncidentFeature[];
  removes: string[];
}

export interface FusionResult extends FusionDelta {
  durationMs: number;
  clusters: number;
  signals: number;
  created: number;
  updated: number;
  merged: number;
}

/**
 * Early-Estimate Fusion Engine.
 *
 * One pass:
 *   1. Load the trailing evidence window. Each source has its own (see
 *      `windowMin` in the source profiles): an hour for dispatch, two for
 *      GOES, 30 h for polar-orbiting VIIRS/MODIS.
 *   2. Spatial DBSCAN over *detection* signals in metric space (2 km).
 *   3. Attach tier-3 context (PM2.5, RAWS) to the nearest cluster.
 *   4. Match each cluster to an existing estimate (H3 overlap → signal
 *      membership → centroid distance) so IDs never flicker.
 *   5. Score with the noisy-OR confidence model and rebuild the buffered
 *      convex hull.
 *   6. Fold estimates into official incidents the moment a perimeter covers
 *      them, and record the warning lead time.
 *   7. Emit a minimal GeoJSON diff.
 *
 * The engine is deliberately stateful in memory (fast, 4s cadence) while the
 * store remains the system of record. `hydrate()` rebuilds state after a
 * restart.
 */
export class FusionEngine {
  private tracks = new Map<string, Track>();
  private cellIndex = new Map<string, Set<string>>();
  private lastStats = { durationMs: 0, clusters: 0, signals: 0, runs: 0 };
  private leadTimes: number[] = [];

  constructor(
    private readonly store: Store,
    private readonly cfg: AppConfig,
    private readonly log: Logger,
    private readonly cache?: RedisCache,
    private readonly heatMask: HeatMask = HeatMask.empty(),
    private readonly namer?: PlaceNamer,
  ) {}

  async hydrate(now = Date.now()): Promise<void> {
    const active = await this.store.activeIncidents();
    for (const f of active) {
      const p = f.properties;
      const track: Track = {
        feature: f,
        signature: signatureOf(f),
        firstSeen: Date.parse(p.firstDetectedAt),
        // "Last seen by fusion", not last evidence: satellite evidence is
        // often hours old, and the next pass must still match this track.
        // Tracks whose evidence is older than any window expire right away.
        lastSignalAt:
          Date.parse(p.updatedAt) >= now - EVIDENCE_WINDOW_MAX_MIN * 60_000 || p.kind === "official"
            ? now
            : Date.parse(p.updatedAt),
        peakConfidence: p.confidence,
        memberIds: new Set(),
        history: [
          {
            t: Date.parse(p.updatedAt),
            area: p.areaAcres,
            frp: p.frp,
            confidence: p.confidence,
            hotspots: p.hotspotCount,
          },
        ],
        rings: outerRings(f),
      };
      this.tracks.set(f.id, track);
      this.lastPersisted.set(f.id, track.signature);
      this.indexTrack(track);
    }
    const merges = await this.store.merges().catch(() => []);
    this.leadTimes = merges.map((m) => m.leadTimeMinutes);
    this.log.info({ incidents: active.length, merges: merges.length }, "fusion engine hydrated");
  }

  size(): number {
    return this.tracks.size;
  }

  get performanceSnapshot() {
    return { ...this.lastStats };
  }

  counts(): { estimated: number; official: number } {
    let estimated = 0;
    let official = 0;
    for (const t of this.tracks.values()) {
      if (t.feature.properties.kind === "official") official++;
      else estimated++;
    }
    return { estimated, official };
  }

  medianLeadTime(): number | null {
    if (this.leadTimes.length === 0) return null;
    const s = [...this.leadTimes].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* Main pass                                                           */
  /* ------------------------------------------------------------------ */

  async run(now = Date.now()): Promise<FusionResult> {
    const started = performance.now();
    const windowMs = EVIDENCE_WINDOW_MAX_MIN * 60_000;
    // Never let future-dated observations (clock skew, bad sensor time)
    // influence the current estimate.
    const signals = (await this.store.recentSignals(now - windowMs, now + 5_000)).filter((s) =>
      inEvidenceWindow(s, now),
    );
    const officialFeatures = [...this.tracks.values()]
      .map((t) => t.feature)
      .filter((f) => f.properties.kind === "official");
    // Every "already covered" rule below needs the cluster within 12 km of
    // the official fire; boxes padded by that much rule most pairs out
    // before any polygon test.
    const officialBoxes = officialFeatures.map((o) => padBBoxKm(featureBBox(o), OFFICIAL_REACH_KM));

    const detections = signals.filter((s) => DETECTION_KINDS.has(s.kind));
    const context = signals.filter((s) => CONTEXT_KINDS.has(s.kind));

    const { clusters } = dbscan(
      detections.map((s) => ({ id: s.id, lon: s.lon, lat: s.lat, signal: s })),
      { epsKm: this.cfg.fusion.radiusKm, minPts: 1 },
    );

    const seen = new Set<string>();
    const upserts: IncidentFeature[] = [];
    let created = 0;
    let updated = 0;
    let qualified = 0;

    for (const cluster of clusters) {
      const members = cluster.members.map((m) => m.signal);
      if (members.length === 0) continue;
      const attached = attachContext(cluster.centroid, context, this.cfg.fusion.radiusKm * 2);
      if (!isPublishable(members, attached, this.cfg)) continue;
      // Satellite-only heat on a refinery or gas flare is not a fire.
      if (isThermalOnly(members) && this.heatMask.coversMost(members)) continue;

      const c = centroid(members);
      const clusterName = nameFor(members, c);
      const clusterBox = bboxOfPoints(members);
      const insideOfficial = officialFeatures.find((o, i) => {
        if (!bboxesIntersect(clusterBox, officialBoxes[i]!)) return false;
        const rings = outerRings(o);
        if (pointInRings(c, rings)) return true;
        // An official polygon's own detections must never seed a "new" zone,
        // even when the cluster centroid drifts outside the mapped perimeter.
        if (members.some((m) => pointInRings(m, rings))) return true;
        const distanceKm = haversineKm(c, { lon: o.properties.lon, lat: o.properties.lat });
        if (
          distanceKm < OFFICIAL_REACH_KM &&
          normalizeName(clusterName) === normalizeName(o.properties.name)
        ) {
          return true;
        }
        const radiusKm = Math.sqrt(Math.max(0.2, o.properties.areaSqKm) / Math.PI);
        return distanceKm < Math.min(7, radiusKm + 1.2);
      });
      if (insideOfficial) continue; // ground truth already covers it

      qualified++;
      const evidence = [...members, ...attached];
      const track = this.matchTrack(c, members);
      const evidenceSignals = evidence.map((s) => ({
        source: s.source,
        observedAt: s.observedAt,
        providerConfidence: s.providerConfidence,
        frp: s.frp,
        label: s.label,
      }));
      const fused = fuseConfidence(evidenceSignals, { at: now });

      const cells = new Set<string>(track?.feature.properties.cells ?? []);
      for (const cell of cellsOf(members)) cells.add(cell);
      if (cells.size === 0) cells.add(cellOf(c.lon, c.lat));
      for (const ringCell of neighborhood(c.lon, c.lat, 1)) cells.add(ringCell);
      const cellList = [...cells].slice(0, MAX_CELLS);

      const spreadKm = maxSpreadKm(members);
      const bufferKm = Math.max(
        this.cfg.fusion.hullBufferM / 1000,
        Math.min(1.2, spreadKm * 0.35 + 0.12),
      );
      const polygon = bufferedHull(members, bufferKm, 14);
      const areaSqKm = ringAreaSqKm(polygon);

      // The estimate's clock starts at its earliest supporting observation,
      // not at the fusion tick — otherwise lead-time reporting is dishonest.
      const earliestEvidence = Math.min(
        ...evidence.map((s) => Date.parse(s.observedAt)).filter((t) => Number.isFinite(t)),
        now,
      );
      const firstDetectedAt =
        track?.feature.properties.firstDetectedAt ?? new Date(earliestEvidence).toISOString();
      const latestEvidence = Math.max(
        ...evidence.map((s) => Date.parse(s.observedAt)).filter((t) => Number.isFinite(t)),
        earliestEvidence,
      );
      const sources = aggregateSources(evidence);
      const history = track?.history ?? [];
      const sample = {
        t: now,
        area: km2ToAcres(areaSqKm),
        frp: sumFrp(members),
        confidence: fused.breakdown.score,
        hotspots: members.filter((m) => m.kind === "thermal").length,
      };
      const nextHistory = [...history, sample].slice(-MAX_HISTORY);
      const growth = growthRates(nextHistory, now);

      const confirmation = estimateConfirmation(members, track?.feature.properties.confirmation);
      const where = this.namer?.describe(c);
      const previous = track?.feature.properties.name;
      // Keep a real name (dispatch, simulator); replace ones the engine made up.
      const name =
        previous && !isGenericName(previous)
          ? previous
          : ((where && whereName(where, confirmation !== "single")) ?? previous ?? nameFor(members, c));
      const props: IncidentProperties = {
        id: track?.feature.id ?? crypto.randomUUID(),
        kind: "estimated",
        name,
        status: statusFor(growth, fused.breakdown.score),
        confidence: fused.breakdown.score,
        confidenceBreakdown: fused.breakdown,
        sources,
        firstDetectedAt,
        // "Updated" means new evidence arrived, not that the fusion loop ran.
        updatedAt: new Date(latestEvidence).toISOString(),
        areaAcres: Math.round(km2ToAcres(areaSqKm) * 10) / 10,
        areaSqKm: Math.round(areaSqKm * 100) / 100,
        frp: Math.round(sumFrp(members) * 10) / 10,
        growthAcresPerHour: growth.acresPerHour,
        growthFrpPerHour: growth.frpPerHour,
        growthScore: growthScore(growth, fused.breakdown.score, members),
        hotspotCount: members.filter((m) => m.kind === "thermal").length,
        evidence: fused.contributions,
        confirmation,
        cause: causeFor(members),
        county: stringMeta(members, "county") ?? where?.county,
        state: stringMeta(members, "state") ?? where?.state,
        cells: cellList,
        lat: c.lat,
        lon: c.lon,
      };

      const feature: IncidentFeature = {
        type: "Feature",
        id: props.id,
        geometry: { type: "Polygon", coordinates: [ensureRing(polygon)] },
        properties: props,
      };

      const next: Track = {
        feature,
        signature: signatureOf(feature),
        firstSeen: track?.firstSeen ?? now,
        lastSignalAt: now,
        peakConfidence: Math.max(track?.peakConfidence ?? 0, props.confidence),
        memberIds: new Set([...(track?.memberIds ?? []), ...members.map((m) => m.id)]),
        history: nextHistory,
        rings: [ensureRing(polygon)],
        mergedAt: track?.mergedAt,
      };
      this.tracks.set(props.id, next);
      this.indexTrack(next);
      seen.add(props.id);
      if (track) updated++;
      else created++;
    }

    // ---- persist estimates that changed (the store is the system of record) --
    const changed = [...seen]
      .map((id) => this.tracks.get(id))
      .filter((t): t is Track => Boolean(t) && t!.signature !== this.lastPersisted.get(t!.feature.id));
    if (changed.length > 0) {
      await this.store.upsertIncidents(changed.map((t) => t.feature));
      for (const t of changed) this.lastPersisted.set(t.feature.id, t.signature);
    }

    // ---- official merge pass: ground truth absorbs its precursors --------
    const merged = await this.mergeEstimatesIntoOfficial(officialFeatures, now);
    for (const f of this.drainPendingOfficialUpserts()) upserts.push(f);

    // ---- expire stale estimates -----------------------------------------
    const expires: string[] = [];
    const ttlMs = this.cfg.fusion.ttlMin * 60_000;
    for (const [id, track] of this.tracks) {
      if (track.feature.properties.kind !== "estimated") continue;
      if (!seen.has(id) && now - track.lastSignalAt > ttlMs) expires.push(id);
    }
    if (expires.length > 0) {
      await this.store.deactivateIncidents(expires, "expired");
      if (this.cache) await this.cache.removeIncidents(expires);
      for (const id of expires) this.dropTrack(id);
    }

    // ---- diff ------------------------------------------------------------
    for (const id of [...this.tracks.keys()]) {
      if (!seen.has(id) && this.tracks.get(id)?.feature.properties.kind === "estimated") continue;
      const track = this.tracks.get(id);
      if (!track) continue;
      if (track.signature !== this.lastPublished.get(id)) {
        upserts.push(track.feature);
        this.lastPublished.set(id, track.signature);
      }
    }

    const removes = new Set<string>(expires);
    for (const id of merged.removed) removes.add(id);

    const result: FusionResult = {
      upserts,
      removes: [...removes],
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      clusters: qualified,
      signals: signals.length,
      created,
      updated,
      merged: merged.count,
    };

    this.lastStats = {
      durationMs: result.durationMs,
      clusters: qualified,
      signals: signals.length,
      runs: this.lastStats.runs + 1,
    };

    if (upserts.length > 0 && this.cache) await this.cache.upsertIncidents(upserts);
    await this.store.recordFusionRun({
      startedAt: new Date(now).toISOString(),
      durationMs: result.durationMs,
      signalsConsidered: signals.length,
      clustersFormed: result.clusters,
      incidentsCreated: created,
      incidentsUpdated: updated,
      incidentsMerged: result.merged,
      radiusM: Math.round(this.cfg.fusion.radiusKm * 1000),
      windowMinutes: EVIDENCE_WINDOW_MAX_MIN,
    });
    if (created > 0) {
      this.log.info({ created, clusters: qualified, ms: result.durationMs }, "fusion pass created estimates");
    }
    return result;
  }

  private lastPublished = new Map<string, string>();
  /** Signature last written to the store, per track. */
  private lastPersisted = new Map<string, string>();

  /* ------------------------------------------------------------------ */
  /* Official ingestion (called by the official adapter)                  */
  /* ------------------------------------------------------------------ */

  /**
   * Register official incidents/perimeters. They are persisted and then
   * pushed through the normal delta stream with kind=official.
   */
  async ingestOfficial(
    features: IncidentFeature[],
    perimeters: {
      incidentId: string;
      geom: { type: "Polygon"; coordinates: number[][][] };
      acres: number | null;
      agency: string;
      publishedAt: string;
    }[],
    now = Date.now(),
  ): Promise<FusionDelta> {
    const upserts: IncidentFeature[] = [];
    await this.store.upsertIncidents(features);
    for (const p of perimeters) {
      await this.store.insertPerimeter({
        id: `${p.incidentId}:${p.publishedAt}`,
        incidentId: p.incidentId,
        geom: { type: "MultiPolygon", coordinates: [p.geom.coordinates as Ring[]] },
        acres: p.acres,
        agency: p.agency,
        publishedAt: p.publishedAt,
        validFrom: p.publishedAt,
        validTo: null,
      });
    }
    for (const f of features) {
      const rings = outerRings(f);
      const existing = this.tracks.get(f.id);
      if (existing) {
        // Official revisions must not erase the early-detection provenance.
        const prev = existing.feature.properties;
        f.properties.precursor = prev.precursor ?? f.properties.precursor;
        f.properties.containment = f.properties.containment ?? prev.containment;
        const sources = [...f.properties.sources];
        for (const s of prev.sources) {
          if (!sources.some((x) => x.source === s.source)) sources.push(s);
        }
        f.properties.sources = sources;
        const evidence = [...f.properties.evidence];
        for (const e of prev.evidence) {
          if (!evidence.some((x) => x.source === e.source)) evidence.push(e);
        }
        f.properties.evidence = evidence;
      }
      const track: Track = {
        feature: f,
        signature: signatureOf(f),
        firstSeen: Date.parse(f.properties.officialSince ?? f.properties.firstDetectedAt),
        lastSignalAt: now,
        peakConfidence: 100,
        memberIds: existing?.memberIds ?? new Set(),
        history: existing?.history ?? [],
        rings: rings.length > 0 ? rings : [circleRingFor(f, 1.2)],
        mergedAt: existing?.mergedAt,
      };
      this.tracks.set(f.id, track);
      this.indexTrack(track);
      upserts.push(f);
      this.lastPublished.set(f.id, track.signature);
    }
    if (this.cache) await this.cache.upsertIncidents(upserts);
    return { upserts, removes: [] };
  }

  /**
   * Drops official incidents that a complete feed snapshot no longer lists
   * (declared out or withdrawn). A snapshot that suddenly lost more than
   * half of them is treated as an upstream glitch and ignored.
   */
  async retireOfficial(present: Set<string>, idPrefix: string): Promise<string[]> {
    const current: string[] = [];
    for (const [id, track] of this.tracks) {
      if (track.feature.properties.kind === "official" && id.startsWith(idPrefix)) current.push(id);
    }
    const gone = current.filter((id) => !present.has(id));
    if (gone.length === 0) return [];
    if (gone.length > current.length / 2 && current.length >= 10) {
      this.log.warn(
        { missing: gone.length, current: current.length, idPrefix },
        "official snapshot is missing most incidents; not retiring any",
      );
      return [];
    }
    await this.store.deactivateIncidents(gone, "expired");
    if (this.cache) await this.cache.removeIncidents(gone);
    for (const id of gone) this.dropTrack(id);
    this.log.info({ retired: gone.length, idPrefix }, "official incidents no longer listed");
    return gone;
  }

  private async mergeEstimatesIntoOfficial(
    official: IncidentFeature[],
    now: number,
  ): Promise<{ count: number; removed: string[] }> {
    if (official.length === 0) return { count: 0, removed: [] };
    let count = 0;
    const removed: string[] = [];
    const touchedOfficial = new Map<string, IncidentFeature>();
    const mergedEstimates: IncidentFeature[] = [];
    const records: MergeRecord[] = [];

    for (const officialFeature of official) {
      const o = officialFeature.properties;
      const oRings = outerRings(officialFeature);
      const oCentroid = { lon: o.lon, lat: o.lat };
      // A merge needs the estimate inside the perimeter or within matchKm.
      const reach = padBBoxKm(featureBBox(officialFeature), this.cfg.fusion.matchKm);

      for (const [id, track] of this.tracks) {
        const e = track.feature.properties;
        if (e.kind !== "estimated" || e.mergedInto) continue;
        const eCentroid = { lon: e.lon, lat: e.lat };
        if (!bboxesIntersect([e.lon, e.lat, e.lon, e.lat], reach)) continue;
        const distance = haversineKm(eCentroid, oCentroid);
        const inside = pointInRings(eCentroid, oRings);
        if (!inside && distance > this.cfg.fusion.matchKm) continue;

        const leadTimeMinutes = Math.max(
          0,
          Math.round((Date.parse(o.officialSince ?? new Date(now).toISOString()) - Date.parse(e.firstDetectedAt)) / 60_000),
        );

        e.mergedInto = o.id;
        e.status = "merged";
        track.mergedAt = now;
        track.rings = oRings;
        this.unindexTrack(track);
        this.lastPublished.delete(id);
        track.signature = signatureOf(track.feature);

        // Attach the early sources to the official incident so the UI can
        // show "NIFC + GOES-18 + CAD" and the full evidence trail.
        const mergedSources: SourceTag[] = [...o.sources];
        for (const s of e.sources) {
          const hit = mergedSources.find((x) => x.source === s.source);
          if (hit) {
            hit.count = Math.max(hit.count, s.count);
            if (s.lastSeen > hit.lastSeen) hit.lastSeen = s.lastSeen;
          } else {
            mergedSources.push({ ...s });
          }
        }
        o.sources = mergedSources;
        o.evidence = [...o.evidence, ...e.evidence.filter((ev) => !o.evidence.some((x) => x.source === ev.source))];
        o.precursor = {
          estimateId: e.id,
          firstDetectedAt: e.firstDetectedAt,
          leadTimeMinutes,
          peakConfidence: track.peakConfidence,
        };
        track.signature = signatureOf(track.feature);
        touchedOfficial.set(officialFeature.id, officialFeature);
        mergedEstimates.push(track.feature);

        records.push({
          estimateId: e.id,
          officialId: o.id,
          mergedAt: new Date(now).toISOString(),
          firstDetectedAt: e.firstDetectedAt,
          officialSince: o.officialSince ?? new Date(now).toISOString(),
          leadTimeMinutes,
          peakConfidence: Math.round(track.peakConfidence),
          distanceKm: Math.round(distance * 100) / 100,
          matchMethod: inside ? "containment" : "proximity",
        });
        this.leadTimes.push(leadTimeMinutes);
        removed.push(e.id);
        this.tracks.delete(id);
        count++;

        this.log.info(
          { estimate: e.name, official: o.name, leadTimeMinutes, method: inside ? "containment" : "proximity" },
          "estimate merged into official ground truth",
        );
      }
    }

    if (records.length > 0) {
      const official = [...touchedOfficial.values()];
      // Estimates and official fires first, so the merge ledger's keys exist.
      await this.store.upsertIncidents([...mergedEstimates, ...official]);
      for (const r of records) await this.store.recordMerge(r);
      for (const f of official) {
        const track = this.tracks.get(f.id);
        if (track) track.signature = signatureOf(f);
        this.lastPublished.set(f.id, signatureOf(f));
        this.lastPersisted.set(f.id, signatureOf(f));
      }
      if (this.cache) await this.cache.upsertIncidents(official);
      // official features must be re-published with the precursor attached
      this.pendingOfficialUpserts.push(...official);
    }

    if (removed.length > 0) {
      await this.store.deactivateIncidents(removed, "merged");
      if (this.cache) await this.cache.removeIncidents(removed);
    }
    return { count, removed };
  }

  private pendingOfficialUpserts: IncidentFeature[] = [];

  /** Merge-pass side effects that must reach the delta stream. */
  drainPendingOfficialUpserts(): IncidentFeature[] {
    const out = this.pendingOfficialUpserts;
    this.pendingOfficialUpserts = [];
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                             */
  /* ------------------------------------------------------------------ */

  allIncidents(): IncidentFeature[] {
    return [...this.tracks.values()].map((t) => t.feature);
  }

  incident(id: string): IncidentFeature | null {
    return this.tracks.get(id)?.feature ?? null;
  }

  series(id: string): { t: string; frp: number; hotspots: number; confidence: number }[] {
    const track = this.tracks.get(id);
    if (!track) return [];
    return track.history.map((s) => ({
      t: new Date(s.t).toISOString(),
      frp: s.frp,
      hotspots: s.hotspots,
      confidence: s.confidence,
    }));
  }

  /** Viewport snapshot with optional historical cursor (time scrubber). */
  view(
    bbox: [number, number, number, number],
    opts: { at?: string; minConfidence?: number; limit?: number } = {},
  ): IncidentFeature[] {
    const atMs = opts.at ? Date.parse(opts.at) : Date.now();
    const minConfidence = opts.minConfidence ?? 0;
    const out: IncidentFeature[] = [];
    for (const track of this.tracks.values()) {
      const f = track.feature;
      const p = f.properties;
      const t0 = Date.parse(p.firstDetectedAt);
      if (t0 > atMs) continue;
      if (p.kind === "official" && p.officialSince && Date.parse(p.officialSince) > atMs) continue;
      if (p.mergedInto) {
        const official = this.tracks.get(p.mergedInto);
        const since = official?.feature.properties.officialSince;
        if (!since || Date.parse(since) <= atMs) continue;
      }
      if (p.confidence < minConfidence) continue;
      if (!featureIntersectsBBox(f, bbox)) continue;
      out.push(f);
    }
    // When the budget can't hold everything, keep what matters most:
    // official fires, then confirmed estimates, then single-pass heat.
    const limit = opts.limit ?? 900;
    if (out.length <= limit) return out;
    const rank = (f: IncidentFeature) =>
      f.properties.kind === "official" ? 0 : f.properties.confirmation === "single" ? 2 : 1;
    return out.sort((a, b) => rank(a) - rank(b) || b.properties.confidence - a.properties.confidence).slice(0, limit);
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private matchTrack(c: { lon: number; lat: number }, members: RawSignal[]): Track | undefined {
    const candidates = new Map<string, number>();
    for (const cell of cellsOf(members)) {
      for (const id of this.cellIndex.get(cell) ?? []) {
        const track = this.tracks.get(id);
        if (!track || track.feature.properties.kind !== "estimated") continue;
        candidates.set(id, (candidates.get(id) ?? 0) + 1);
      }
    }
    let best: { track: Track; score: number } | undefined;
    for (const [id, overlap] of candidates) {
      const track = this.tracks.get(id);
      if (!track) continue;
      // No staleness check: expiry runs at the end of every pass, so any
      // track still here is alive, even if the last pass was hours ago.
      if (track.mergedAt) continue;
      const distance = haversineKm(c, { lon: track.feature.properties.lon, lat: track.feature.properties.lat });
      if (distance > this.cfg.fusion.matchKm) continue;
      const memberHits = members.filter((m) => track.memberIds.has(m.id)).length;
      const score = overlap * 10 + memberHits * 25 - distance;
      if (!best || score > best.score) best = { track, score };
    }
    return best?.track;
  }

  private indexTrack(track: Track): void {
    for (const cell of track.feature.properties.cells ?? []) {
      let set = this.cellIndex.get(cell);
      if (!set) {
        set = new Set();
        this.cellIndex.set(cell, set);
      }
      set.add(track.feature.id);
    }
  }

  private unindexTrack(track: Track): void {
    for (const cell of track.feature.properties.cells ?? []) {
      this.cellIndex.get(cell)?.delete(track.feature.id);
    }
  }

  private dropTrack(id: string): void {
    const track = this.tracks.get(id);
    if (!track) return;
    this.unindexTrack(track);
    this.tracks.delete(id);
    this.lastPublished.delete(id);
    this.lastPersisted.delete(id);
  }
}

/* -------------------------------------------------------------------- */
/* Pure helpers                                                          */
/* -------------------------------------------------------------------- */

function isPublishable(
  members: RawSignal[],
  context: RawSignal[],
  cfg: AppConfig,
): boolean {
  const profiles = members.map((m) => SOURCE_PROFILES[m.source]);
  const modalities = new Set(profiles.map((p) => p.modality));
  const thermal = members.filter((m) => m.kind === "thermal");
  const strong = members.some((m) =>
    ["cad", "goes16", "goes18", "goes19", "viirs", "alertca", "calfire"].includes(m.source),
  );
  const frp = thermal.reduce((sum, m) => sum + (m.frp ?? 0), 0);

  // A lone weak hotspot (< 3 MW) with no corroboration is noise.
  if (members.length === 1 && modalities.size === 1 && thermal.length === 1 && frp < 3 && context.length === 0) {
    return false;
  }
  if (strong || modalities.size >= 2) return true;
  // A single human report is only published when it carries a photo +
  // bearing (providerConfidence >= 0.5); otherwise it waits for corroboration.
  const onlyCrowd = modalities.size === 1 && modalities.has("crowd");
  if (onlyCrowd) {
    return members.some((m) => (m.providerConfidence ?? 0) >= 0.5) || context.length > 0;
  }
  return members.length + context.length >= 2;
}

function isThermalOnly(members: RawSignal[]): boolean {
  return members.every((m) => m.kind === "thermal");
}

function attachContext(
  c: { lon: number; lat: number },
  context: RawSignal[],
  radiusKm: number,
): RawSignal[] {
  return context.filter((s) => {
    // Area alerts (red flag zones) apply to everything inside them.
    const polygon = s.meta?.polygon;
    if (Array.isArray(polygon) && polygon.length >= 4) return pointInRing(c, polygon as Ring);
    // Air monitors are sparse; smoke reaches them from further away.
    return haversineKm(c, s) <= (s.kind === "airquality" ? AIR_MONITOR_REACH_KM : radiusKm);
  });
}

function aggregateSources(signals: RawSignal[]): SourceTag[] {
  const map = new Map<RawSignal["source"], SourceTag>();
  for (const s of signals) {
    const hit = map.get(s.source);
    if (hit) {
      hit.count++;
      if (s.observedAt > hit.lastSeen) hit.lastSeen = s.observedAt;
    } else {
      map.set(s.source, { source: s.source, count: 1, lastSeen: s.observedAt });
    }
  }
  return [...map.values()].sort((a, b) => (b.lastSeen > a.lastSeen ? 1 : -1));
}

function sumFrp(signals: RawSignal[]): number {
  return signals.reduce((sum, s) => sum + (s.frp ?? 0), 0);
}

function maxSpreadKm(points: { lon: number; lat: number }[]): number {
  if (points.length < 2) return 0;
  const c = centroid(points);
  let max = 0;
  for (const p of points) max = Math.max(max, haversineKm(c, p));
  return max;
}

function ensureRing(ring: Ring): Ring {
  if (ring.length === 0) return [];
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) return [...ring, [first[0], first[1]]];
  return ring;
}

function growthRates(
  history: { t: number; area: number; frp: number }[],
  now: number,
): { acresPerHour: number; frpPerHour: number } {
  if (history.length < 2) return { acresPerHour: 0, frpPerHour: 0 };
  const latest = history[history.length - 1]!;
  let ref = history[0]!;
  for (let i = history.length - 2; i >= 0; i--) {
    const item = history[i]!;
    if (now - item.t >= GROWTH_REF_MS) {
      ref = item;
      break;
    }
  }
  const hours = Math.max(1 / 60, (latest.t - ref.t) / 3_600_000);
  return {
    acresPerHour: Math.round(((latest.area - ref.area) / hours) * 10) / 10,
    frpPerHour: Math.round(((latest.frp - ref.frp) / hours) * 10) / 10,
  };
}

function growthScore(
  growth: { acresPerHour: number; frpPerHour: number },
  confidence: number,
  members: RawSignal[],
): number {
  const raw =
    Math.max(0, growth.acresPerHour) * 0.6 +
    Math.max(0, growth.frpPerHour) * 0.35 +
    confidence * 0.8 +
    members.length * 1.5;
  return Math.round(raw * 10) / 10;
}

function statusFor(growth: { acresPerHour: number }, confidence: number): IncidentProperties["status"] {
  if (growth.acresPerHour > 120) return "growing";
  if (confidence > 55) return "holding";
  return "detected";
}

function causeFor(signals: RawSignal[]): IncidentProperties["cause"] {
  for (const s of signals) {
    const cause = s.meta?.cause;
    if (typeof cause === "string") return cause as IncidentProperties["cause"];
  }
  return "vegetation";
}

function stringMeta(signals: RawSignal[], key: string): string | undefined {
  for (const s of signals) {
    const v = s.meta?.[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function nameFor(signals: RawSignal[], c: { lon: number; lat: number }): string {
  for (const s of signals) {
    const named = s.meta?.incidentName;
    if (typeof named === "string" && named.length > 0) return named;
  }
  // Satellite labels ("VIIRS 375m 4 MW") describe a pixel, not a fire.
  for (const s of signals) {
    if (s.kind !== "thermal" && s.label && s.label.length > 2) return s.label;
  }
  const ns = c.lat >= 0 ? "N" : "S";
  const ew = c.lon >= 0 ? "E" : "W";
  return `Fire at ${Math.abs(c.lat).toFixed(2)}${ns} ${Math.abs(c.lon).toFixed(2)}${ew}`;
}

export function outerRings(f: IncidentFeature): Ring[] {
  if (f.geometry.type !== "Polygon") return [];
  const rings = f.geometry.coordinates;
  if (rings.length === 0) return [];
  return [rings[0]!];
}

export function pointInRings(c: { lon: number; lat: number }, rings: Ring[]): boolean {
  for (const ring of rings) if (pointInRing(c, ring)) return true;
  return false;
}

export function circleRingFor(f: IncidentFeature, radiusKm: number): Ring {
  const center = { lon: f.properties.lon, lat: f.properties.lat };
  const ring: Ring = [];
  for (let i = 0; i < 28; i++) {
    const p = destination(center, (360 / 28) * i, radiusKm);
    ring.push([p.lon, p.lat]);
  }
  ring.push(ring[0]!);
  return ring;
}

export function featureBBox(f: IncidentFeature): [number, number, number, number] {
  if (f.geometry.type !== "Polygon") return [f.properties.lon, f.properties.lat, f.properties.lon, f.properties.lat];
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const ring of f.geometry.coordinates) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minLon)) return [f.properties.lon, f.properties.lat, f.properties.lon, f.properties.lat];
  return [minLon, minLat, maxLon, maxLat];
}

type BBox = [number, number, number, number];

function bboxOfPoints(points: { lon: number; lat: number }[]): BBox {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const p of points) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

function padBBoxKm(b: BBox, km: number): BBox {
  const dLat = km / 110.574;
  const dLon = km / (111.32 * Math.max(0.05, Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180)));
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

function bboxesIntersect(a: BBox, b: BBox): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

export function featureIntersectsBBox(f: IncidentFeature, bbox: [number, number, number, number]): boolean {
  const [minLon, minLat, maxLon, maxLat] = featureBBox(f);
  return !(maxLon < bbox[0] || minLon > bbox[2] || maxLat < bbox[1] || minLat > bbox[3]);
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function signatureOf(f: IncidentFeature): string {
  const p = f.properties;
  const ev = p.evidence.map((e) => `${e.source}:${e.count}`).join(",");
  return [
    p.kind,
    p.name,
    p.status,
    p.confidence,
    Math.round(p.areaAcres),
    p.hotspotCount,
    Math.round(p.frp),
    p.sources.map((s) => s.source).join(","),
    ev,
    p.precursor?.leadTimeMinutes ?? "",
    p.mergedInto ?? "",
    p.confirmation ?? "",
    Math.round(p.confidenceBreakdown.freshness * 100),
  ].join("|");
}

