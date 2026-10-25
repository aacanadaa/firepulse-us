import type { HotspotFeature, IncidentFeature } from "@firepulse/protocol";

/**
 * "Is this fire still there?"
 *
 * A fire on a wildfire map is not a fact, it is an inference from the last
 * signal we received. Agricultural burns look like fires for a day; official
 * perimeters stay published for weeks after the last flame. This module turns
 * evidence timestamps into one honest state per fire, so the map can stop
 * shouting about something that is probably a smouldering edge or a plough.
 *
 * Thresholds are deliberately generous: calling a live fire "out" is far worse
 * than leaving a dead one on screen.
 */

export type Liveness = "active" | "cooling" | "quiet" | "dormant" | "presumed_out";

export interface FireLiveness {
  state: Liveness;
  /** Newest signal we have for this fire, epoch ms. */
  lastSignalAt: number;
  ageMs: number;
  /** True when the freshest thing we know is thermal heat, not a feed update. */
  fromHeat: boolean;
  /** Short badge, e.g. "Cooling". */
  label: string;
  /** One clause of evidence, e.g. "no new heat for 3 h". */
  detail: string;
}

const ACTIVE_MS = 90 * 60_000;
const COOLING_MS = 6 * 3_600_000;
const QUIET_MS = 24 * 3_600_000;

/** Cell size for the heat index, ~5.5 km at the equator. */
const CELL = 0.05;

function cellKey(lon: number, lat: number): string {
  return `${Math.round(lon / CELL)}:${Math.round(lat / CELL)}`;
}

/**
 * Buckets hotspot timestamps on a coarse grid so "was there heat near this
 * fire recently?" is a handful of lookups instead of a scan over 6 000 points
 * per fire per frame.
 */
export class HeatIndex {
  private cells = new Map<string, number>();

  constructor(hotspots: Iterable<HotspotFeature>) {
    for (const h of hotspots) {
      const t = Date.parse(h.properties.observedAt);
      if (!Number.isFinite(t)) continue;
      const key = cellKey(h.properties.lon, h.properties.lat);
      const prev = this.cells.get(key);
      if (prev === undefined || t > prev) this.cells.set(key, t);
    }
  }

  /** Newest thermal detection within `radiusKm` of a point, or null. */
  lastHeatAt(lon: number, lat: number, radiusKm = 3): number | null {
    const span = Math.max(1, Math.ceil(radiusKm / 111 / CELL));
    const cx = Math.round(lon / CELL);
    const cy = Math.round(lat / CELL);
    let best: number | null = null;
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        const t = this.cells.get(`${cx + dx}:${cy + dy}`);
        if (t !== undefined && (best === null || t > best)) best = t;
      }
    }
    return best;
  }
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function since(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** Newest timestamp in the incident's own evidence list. */
function lastEvidenceAt(incident: IncidentFeature): number {
  let best = Date.parse(incident.properties.updatedAt);
  for (const e of incident.properties.evidence) {
    const t = Date.parse(e.lastSeen);
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best;
}

export function livenessFor(
  incident: IncidentFeature,
  heat: HeatIndex | null,
  now: number,
): FireLiveness {
  const p = incident.properties;
  const evidenceAt = lastEvidenceAt(incident);
  const heatAt = heat ? heat.lastHeatAt(p.lon, p.lat) : null;
  const lastSignalAt = Math.max(evidenceAt, heatAt ?? 0);
  const ageMs = Math.max(0, now - lastSignalAt);
  const fromHeat = heatAt !== null && heatAt >= evidenceAt;

  const containedNow =
    p.status === "contained" || (p.containment != null && p.containment >= 100);

  // Estimates are ephemeral by construction: the fusion TTL removes them once
  // their evidence ages out, so an old estimate is a data problem, not a fire.
  if (p.kind === "estimated") {
    if (ageMs < ACTIVE_MS) {
      return { state: "active", lastSignalAt, ageMs, fromHeat, label: "Active", detail: `heat ${ago(ageMs)}` };
    }
    return {
      state: "cooling",
      lastSignalAt,
      ageMs,
      fromHeat,
      label: "Fading",
      detail: `no new heat for ${since(ageMs)}`,
    };
  }

  if (containedNow && ageMs >= COOLING_MS) {
    return {
      state: "presumed_out",
      lastSignalAt,
      ageMs,
      fromHeat,
      label: "Presumed out",
      detail: `contained, no heat for ${since(ageMs)}`,
    };
  }
  if (ageMs < ACTIVE_MS) {
    return {
      state: "active",
      lastSignalAt,
      ageMs,
      fromHeat,
      label: "Active",
      detail: fromHeat ? `heat ${ago(ageMs)}` : `feed updated ${ago(ageMs)}`,
    };
  }
  if (ageMs < COOLING_MS) {
    return {
      state: "cooling",
      lastSignalAt,
      ageMs,
      fromHeat,
      label: "Cooling",
      detail: `no new heat for ${since(ageMs)}`,
    };
  }
  if (ageMs < QUIET_MS) {
    return {
      state: "quiet",
      lastSignalAt,
      ageMs,
      fromHeat,
      label: "Quiet",
      detail: `no new heat for ${since(ageMs)}`,
    };
  }
  return {
    state: "dormant",
    lastSignalAt,
    ageMs,
    fromHeat,
    label: "No recent heat",
    detail: `nothing detected for ${since(ageMs)}`,
  };
}

/** Fires we should stop shouting about on the map. */
export function isStale(state: Liveness): boolean {
  return state === "dormant" || state === "presumed_out";
}

/** Build the per-fire liveness map once per data change. */
export function buildLiveness(
  incidents: IncidentFeature[],
  hotspots: HotspotFeature[],
  now: number,
): Map<string, FireLiveness> {
  const heat = new HeatIndex(hotspots);
  const out = new Map<string, FireLiveness>();
  for (const f of incidents) out.set(f.id, livenessFor(f, heat, now));
  return out;
}
