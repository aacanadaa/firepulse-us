import type { IncidentFeature, RawSignal, SourceId, Tier } from "@firepulse/protocol";

export interface PollContext {
  now: number;
  /** Signals observed at or after this timestamp are new. */
  since: number;
}

export interface SourceAdapter {
  id: string;
  label: string;
  sources: SourceId[];
  tier: Tier;
  intervalMs: number;
  enabled: boolean;
  /**
   * Poll once at boot with `since` set to the full retention window, so a
   * fresh process starts with the last day of real data. The simulator
   * seeds its own history and leaves this off.
   */
  backfill?: boolean;
  poll(ctx: PollContext): Promise<RawSignal[]>;
}

export interface OfficialBatch {
  features: IncidentFeature[];
  perimeters: {
    incidentId: string;
    geom: { type: "Polygon"; coordinates: number[][][] };
    acres: number;
    agency: string;
    publishedAt: string;
  }[];
  /**
   * Set when the batch lists every current incident from this feed, so
   * official incidents with this id prefix that are missing have been
   * declared out or withdrawn.
   */
  complete?: { idPrefix: string };
}

export interface OfficialAdapter {
  id: string;
  label: string;
  intervalMs: number;
  enabled: boolean;
  poll(ctx: PollContext): Promise<OfficialBatch>;
}
