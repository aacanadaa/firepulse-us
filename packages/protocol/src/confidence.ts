/**
 * FirePulse US — Early-Estimate Fusion confidence model.
 *
 * Design goals
 * ------------
 * 1. A single unverified human report must land near 20% (low trust).
 * 2. Two *independent* modalities (dispatch + thermal) must land near 85%.
 * 3. Official ground truth is 100% by definition (it short-circuits).
 * 4. Correlated sensors must not be double counted (two satellites see the
 *    same pixel of flame — that is one detection family, not two).
 * 5. Evidence must decay: a 4-hour-old CAD dispatch is weak corroboration.
 *
 * The model is a log-odds-free, explainable noisy-OR:
 *
 *     fused      = 1 - Π_m (1 - c_m)          // c_m = within-modality confidence
 *     score      = 100 · fused · corroboration · freshness
 *
 * Within a modality, the strongest signal contributes fully and every further
 * signal is discounted by ρ (default 0.35) because it is partially redundant:
 *
 *     c_m = 1 - (1 - w_max) · Π_i (1 - ρ·w_i)
 *
 * Corroboration rewards *independent* families, not volume:
 *
 *     corroboration = 1 + 0.035·(distinctModalities - 1), capped at 1.10
 *
 * Freshness averages an exponential decay over every evidence item:
 *
 *     freshness = mean_i ( 0.55 + 0.45 · 2^(-age_i / halfLife_i) )
 *
 * This file is dependency-free and is imported by both the API and the web
 * client (the client re-derives per-signal confidence for tooltips).
 */

import type {
  ConfidenceBreakdown,
  EvidenceContribution,
  Modality,
  RawSignal,
  SourceId,
  SourceProfile,
  Tier,
} from "./types.js";

export const CORRELATION_DISCOUNT = 0.35;
export const CORROBORATION_STEP = 0.035;
export const CORROBORATION_MAX = 0.1;
export const FRESHNESS_FLOOR = 0.55;
export const ESTIMATE_MAX = 99;

interface ProfileSeed {
  label: string;
  short: string;
  tier: Tier;
  modality: Modality;
  weight: number;
  halfLifeMin: number;
  detector: boolean;
  color: string;
}

const SEEDS: Record<SourceId, ProfileSeed> = {
  // ---- Tier 4: official ground truth (short-circuits to 100) -------------
  nifc: {
    label: "NIFC Perimeter",
    short: "NIFC",
    tier: 4,
    modality: "official",
    weight: 1,
    halfLifeMin: 10080,
    detector: true,
    color: "#ff3b30",
  },
  wfigs: {
    label: "WFIGS Incident",
    short: "WFIGS",
    tier: 4,
    modality: "official",
    weight: 1,
    halfLifeMin: 10080,
    detector: true,
    color: "#ff453a",
  },
  calfire: {
    label: "CAL FIRE",
    short: "CALFIRE",
    tier: 4,
    modality: "official",
    weight: 1,
    halfLifeMin: 10080,
    detector: true,
    color: "#ff6b00",
  },

  // ---- Tier 2: satellite thermal -----------------------------------------
  goes18: {
    label: "GOES-18 ABI Fire",
    short: "GOES-18",
    tier: 2,
    modality: "satellite-thermal",
    weight: 0.60,
    halfLifeMin: 45,
    detector: true,
    color: "#ffd166",
  },
  goes16: {
    label: "GOES-16 ABI Fire",
    short: "GOES-16",
    tier: 2,
    modality: "satellite-thermal",
    weight: 0.58,
    halfLifeMin: 45,
    detector: true,
    color: "#ffcf5c",
  },
  viirs: {
    label: "VIIRS 375m",
    short: "VIIRS",
    tier: 2,
    modality: "satellite-thermal",
    weight: 0.56,
    halfLifeMin: 180,
    detector: true,
    color: "#ffb84d",
  },
  modis: {
    label: "MODIS Thermal",
    short: "MODIS",
    tier: 2,
    modality: "satellite-thermal",
    weight: 0.46,
    halfLifeMin: 240,
    detector: true,
    color: "#ff9f1c",
  },

  // ---- Tier 1: sub-5-minute signals --------------------------------------
  cad: {
    label: "CAD Vegetation Fire",
    short: "CAD",
    tier: 1,
    modality: "dispatch",
    weight: 0.55,
    halfLifeMin: 210,
    detector: true,
    color: "#ff5ea8",
  },
  scanner: {
    label: "Scanner / Radio AI",
    short: "SCANNER",
    tier: 1,
    modality: "dispatch",
    weight: 0.38,
    halfLifeMin: 120,
    detector: true,
    color: "#ff77c8",
  },
  alertca: {
    label: "ALERTCalifornia Camera",
    short: "ALERTCA",
    tier: 1,
    modality: "camera",
    weight: 0.50,
    halfLifeMin: 90,
    detector: true,
    color: "#8b5cf6",
  },
  crowd: {
    label: "Crowdsourced Report",
    short: "CROWD",
    tier: 1,
    modality: "crowd",
    // Tuned so an unverified text report (providerConfidence 0.45) lands at
    // ~20%, and a geotagged photo + bearing (0.9) lands at ~25%.
    weight: 0.26,
    halfLifeMin: 240,
    detector: true,
    color: "#38bdf8",
  },

  // ---- Tier 3: environmental context (cannot seed an incident alone) ------
  purpleair: {
    label: "PurpleAir PM2.5",
    short: "PA-II",
    tier: 3,
    modality: "air-quality",
    weight: 0.22,
    halfLifeMin: 60,
    detector: false,
    color: "#a3e635",
  },
  airnow: {
    label: "EPA AirNow PM2.5",
    short: "AIRNOW",
    tier: 3,
    modality: "air-quality",
    weight: 0.20,
    halfLifeMin: 90,
    detector: false,
    color: "#84cc16",
  },
  raws: {
    label: "RAWS Wind Shift",
    short: "RAWS",
    tier: 3,
    modality: "weather",
    weight: 0.12,
    halfLifeMin: 120,
    detector: false,
    color: "#22d3ee",
  },
  nws: {
    label: "NWS Red Flag",
    short: "NWS",
    tier: 3,
    modality: "weather",
    weight: 0.06,
    halfLifeMin: 720,
    detector: false,
    color: "#0ea5e9",
  },
};

export const SOURCE_PROFILES: Record<SourceId, SourceProfile> = Object.fromEntries(
  Object.entries(SEEDS).map(([id, seed]) => [id, { id: id as SourceId, ...seed }]),
) as Record<SourceId, SourceProfile>;

export const TIER_LABELS: Record<Tier, string> = {
  1: "Tier 1 · Dispatch & crowdsource",
  2: "Tier 2 · Satellite thermal",
  3: "Tier 3 · Weather & air quality",
  4: "Tier 4 · Official ground truth",
};

export function sourceProfile(id: SourceId): SourceProfile {
  return SOURCE_PROFILES[id];
}

/** Provider confidence modulates a signal's own weight (0.6x .. 1.0x). */
export function signalWeight(signal: Pick<RawSignal, "source" | "providerConfidence" | "frp">): number {
  const base = SOURCE_PROFILES[signal.source].weight;
  const pc = signal.providerConfidence;
  if (pc == null || !Number.isFinite(pc)) return base;
  const clamped = Math.max(0, Math.min(1, pc));
  return base * (0.6 + 0.4 * clamped);
}

/** Weighted Fire Radiative Power boost for satellite thermal detections. */
export function frpBoost(frp: number | undefined): number {
  if (!frp || frp <= 0) return 1;
  // log scale: 1 MW ≈ 1.0x, 100 MW ≈ 1.19x, 1000 MW ≈ 1.36x
  return 1 + Math.min(0.4, 0.18 * Math.log10(1 + frp));
}

export interface FusedEvidence {
  breakdown: ConfidenceBreakdown;
  contributions: EvidenceContribution[];
}

interface Aggregated {
  modality: Modality;
  source: SourceId;
  weight: number;
  contribution: number;
  count: number;
  firstSeen: number;
  lastSeen: number;
  sample?: string;
}

function combineWithinModality(items: { weight: number }[]): number {
  if (items.length === 0) return 0;
  const sorted = [...items].sort((a, b) => b.weight - a.weight);
  const top = sorted[0]!.weight;
  let rest = 1;
  for (let i = 1; i < sorted.length; i++) {
    rest *= 1 - CORRELATION_DISCOUNT * sorted[i]!.weight;
  }
  return 1 - (1 - top) * rest;
}

/**
 * Fuse clustered evidence into a 0..100 confidence score.
 *
 * @param signals Evidence items in a cluster (already spatially filtered).
 * @param official When true the incident is official ground truth -> 100.
 * @param at Reference time for decay (defaults to newest evidence).
 */
export function fuseConfidence(
  signals: Array<
    Pick<RawSignal, "source" | "observedAt" | "providerConfidence" | "frp" | "label">
  >,
  opts: { official?: boolean; at?: number } = {},
): FusedEvidence {
  if (opts.official) {
    return {
      breakdown: {
        score: 100,
        fused: 1,
        corroboration: 1,
        freshness: 1,
        distinctModalities: 1,
        evidenceCount: signals.length,
        rationale: "Official government ground truth",
      },
      contributions: [],
    };
  }

  const now = opts.at ?? Date.now();

  // --- 1. group by modality, tracking the strongest contributing source ----
  const groups = new Map<Modality, Aggregated[]>();
  for (const signal of signals) {
    const profile = SOURCE_PROFILES[signal.source];
    if (!profile) continue;

    const observed = Date.parse(signal.observedAt);
    const ageMin = Number.isFinite(observed) ? Math.max(0, (now - observed) / 60_000) : 0;
    // provider confidence + FRP are folded into the per-signal weight
    const weight = Math.min(0.95, signalWeight(signal) * frpBoost(signal.frp));

    let bucket = groups.get(profile.modality);
    if (!bucket) {
      bucket = [];
      groups.set(profile.modality, bucket);
    }
    const existing = bucket.find((b) => b.source === signal.source);
    if (existing) {
      existing.count += 1;
      existing.weight = Math.max(existing.weight, weight);
      existing.firstSeen = Math.min(existing.firstSeen, observed || now);
      existing.lastSeen = Math.max(existing.lastSeen, observed || now);
      if (!existing.sample && signal.label) existing.sample = signal.label;
    } else {
      bucket.push({
        modality: profile.modality,
        source: signal.source,
        weight,
        contribution: 0,
        count: 1,
        firstSeen: observed || now,
        lastSeen: observed || now,
        sample: signal.label,
      });
    }
  }

  // --- 2. within-modality fusion ------------------------------------------
  const contributions: EvidenceContribution[] = [];
  const perModality: { modality: Modality; c: number }[] = [];
  let freshnessSum = 0;
  let freshnessCount = 0;
  let totalCount = 0;

  for (const [modality, items] of groups) {
    const c = combineWithinModality(items);
    perModality.push({ modality, c });
    for (const item of items) {
      totalCount += item.count;
      const profile = SOURCE_PROFILES[item.source];
      const ageMin = Math.max(0, (now - item.lastSeen) / 60_000);
      const decay = Math.pow(2, -ageMin / profile.halfLifeMin);
      freshnessSum += FRESHNESS_FLOOR + (1 - FRESHNESS_FLOOR) * decay;
      freshnessCount += 1;
      contributions.push({
        source: item.source,
        modality,
        count: item.count,
        // The source's own standalone strength; the modality total is what
        // enters the noisy-OR and is reported separately by the UI.
        contribution: +item.weight.toFixed(4),
        effective: +(item.weight * Math.pow(2, -ageMin / profile.halfLifeMin)).toFixed(4),
        firstSeen: new Date(item.firstSeen).toISOString(),
        lastSeen: new Date(item.lastSeen).toISOString(),
        sample: item.sample,
      });
    }
  }

  if (perModality.length === 0) {
    return {
      breakdown: {
        score: 0,
        fused: 0,
        corroboration: 1,
        freshness: 0,
        distinctModalities: 0,
        evidenceCount: 0,
        rationale: "No evidence",
      },
      contributions: [],
    };
  }

  // --- 3. cross-modality noisy-OR -----------------------------------------
  let miss = 1;
  for (const { c } of perModality) miss *= 1 - c;
  const fused = 1 - miss;

  // --- 4. corroboration + freshness ---------------------------------------
  const distinctModalities = perModality.length;
  const corroboration = Math.min(
    1 + CORROBORATION_MAX,
    1 + CORROBORATION_STEP * Math.max(0, distinctModalities - 1),
  );
  const freshness = freshnessCount > 0 ? freshnessSum / freshnessCount : FRESHNESS_FLOOR;

  let score = Math.round(100 * fused * corroboration * freshness);
  // Never claim certainty for an inference; official data is the only 100.
  score = Math.max(1, Math.min(ESTIMATE_MAX, score));

  contributions.sort((a, b) => b.effective - a.effective);

  return {
    breakdown: {
      score,
      fused: +fused.toFixed(4),
      corroboration: +corroboration.toFixed(3),
      freshness: +freshness.toFixed(4),
      distinctModalities,
      evidenceCount: totalCount,
      rationale: rationaleFor(perModality, corroboration),
    },
    contributions,
  };
}

function rationaleFor(perModality: { modality: Modality; c: number }[], corroboration: number): string {
  const sorted = [...perModality].sort((a, b) => b.c - a.c);
  const names = sorted.map((p) => MODALITY_LABEL[p.modality]);
  if (names.length === 1) return `${names[0]} only`;
  if (names.length === 2) return `${names[0]} + ${names[1]} corroboration`;
  return `${names.slice(0, 3).join(" + ")} convergence`;
}

export const MODALITY_LABEL: Record<Modality, string> = {
  "satellite-thermal": "satellite thermal",
  dispatch: "CAD dispatch",
  camera: "camera vector",
  crowd: "human report",
  "air-quality": "PM2.5 spike",
  weather: "weather",
  official: "official",
};

/** Individual hotspot display confidence (not a cluster score). */
export function hotspotConfidence(signal: Pick<RawSignal, "source" | "providerConfidence" | "frp">): number {
  return Math.round(
    Math.max(5, Math.min(99, 100 * signalWeight(signal) * frpBoost(signal.frp))),
  );
}
