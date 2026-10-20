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
}

export interface OfficialAdapter {
  id: string;
  label: string;
  intervalMs: number;
  enabled: boolean;
  poll(ctx: PollContext): Promise<OfficialBatch>;
}
