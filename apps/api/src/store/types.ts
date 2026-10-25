import type { IncidentFeature, RawSignal } from "@firepulse/protocol";

export interface OfficialPerimeterRecord {
  id: string;
  incidentId: string;
  geom: { type: "MultiPolygon"; coordinates: number[][][][] };
  acres: number | null;
  agency: string;
  publishedAt: string;
  validFrom: string;
  validTo: string | null;
}

export interface MergeRecord {
  estimateId: string;
  officialId: string;
  mergedAt: string;
  firstDetectedAt: string;
  officialSince: string;
  leadTimeMinutes: number;
  peakConfidence: number;
  distanceKm: number;
  matchMethod: "containment" | "proximity" | "name";
}

export interface FusionAudit {
  startedAt: string;
  durationMs: number;
  signalsConsidered: number;
  clustersFormed: number;
  incidentsCreated: number;
  incidentsUpdated: number;
  incidentsMerged: number;
  radiusM: number;
  windowMinutes: number;
}

/**
 * Persistence port. Two implementations ship:
 *   - `PostgresStore`: the production system of record (PostGIS).
 *   - `MemoryStore`: dependency-free dev/demo store with identical
 *                       semantics, used when DATABASE_URL is absent.
 */
export interface Store {
  readonly kind: "postgres" | "memory";
  init(): Promise<void>;
  ping(): Promise<boolean>;

  /** Returns the signals that were new; duplicates are skipped. */
  insertSignals(signals: RawSignal[]): Promise<RawSignal[]>;
  recentSignals(sinceMs: number, untilMs?: number): Promise<RawSignal[]>;
  signalsForIncident(id: string, limit?: number): Promise<RawSignal[]>;
  purgeSignals(olderThan: Date): Promise<number>;

  upsertIncidents(incidents: IncidentFeature[]): Promise<void>;
  deactivateIncidents(ids: string[], reason: "expired" | "merged"): Promise<void>;
  activeIncidents(): Promise<IncidentFeature[]>;
  incidentById(id: string): Promise<IncidentFeature | null>;

  insertPerimeter(p: OfficialPerimeterRecord): Promise<void>;
  perimeters(): Promise<OfficialPerimeterRecord[]>;

  recordMerge(m: MergeRecord): Promise<void>;
  merges(): Promise<MergeRecord[]>;

  recordFusionRun(audit: FusionAudit): Promise<void>;
  close(): Promise<void>;
}
