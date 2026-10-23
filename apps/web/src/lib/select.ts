import type { HotspotFeature, IncidentFeature } from "@firepulse/protocol";
import type { LiveStore } from "./store";

export type FeedTab = "growth" | "new" | "confidence" | "all";
/** "unconfirmed": single-pass satellite heat, kept out of the other lists. */
export type KindFilter = "all" | "estimated" | "official" | "unconfirmed";

export interface SelectOptions {
  /** epoch ms; null = live */
  cursor: number | null;
  minConfidence: number;
  kind: KindFilter;
  tab: FeedTab;
  /** exclude merged precursors (used by the map, not the feed) */
  excludeMerged?: boolean;
  /** Keep single-pass satellite heat even when kind isn't "unconfirmed" (the map draws it faintly). */
  includeUnconfirmed?: boolean;
}

/**
 * Applies the temporal cursor + filters to the live store.
 *
 * This is the heart of the time scrubber: a fire is only visible if it had
 * been detected by the cursor, official perimeters only appear once the
 * government published them, and a merged early estimate hides exactly when
 * its official successor appears — so replaying the last 24 h shows the
 * warning lead time instead of hindsight.
 */
export function selectIncidents(store: LiveStore, opts: SelectOptions): IncidentFeature[] {
  const now = opts.cursor ?? store.now();
  const out: IncidentFeature[] = [];

  for (const f of store.incidents.values()) {
    const p = f.properties;
    if (Date.parse(p.firstDetectedAt) > now) continue;
    if (p.officialSince && Date.parse(p.officialSince) > now) continue;
    if (p.mergedInto) {
      const official = store.incidents.get(p.mergedInto);
      const since = official?.properties.officialSince;
      if (since && Date.parse(since) <= now) continue;
      if (opts.excludeMerged) continue;
    }
    if (p.confidence < opts.minConfidence) continue;
    const single = p.kind === "estimated" && p.confirmation === "single";
    if (opts.kind === "unconfirmed") {
      if (!single) continue;
    } else {
      if (single && !opts.includeUnconfirmed) continue;
      if (opts.kind !== "all" && p.kind !== opts.kind) continue;
    }
    out.push(f);
  }

  out.sort((a, b) => {
    switch (opts.tab) {
      case "new":
        return Date.parse(b.properties.firstDetectedAt) - Date.parse(a.properties.firstDetectedAt);
      case "confidence":
        return b.properties.confidence - a.properties.confidence;
      case "growth":
        return b.properties.growthScore - a.properties.growthScore;
      default:
        return b.properties.confidence - a.properties.confidence;
    }
  });
  return out;
}

export function selectHotspots(
  store: LiveStore,
  cursor: number | null,
  retentionMs = 24 * 3_600_000,
): HotspotFeature[] {
  const now = cursor ?? store.now();
  const from = now - retentionMs;
  const out: HotspotFeature[] = [];
  for (const h of store.hotspots.values()) {
    const t = Date.parse(h.properties.observedAt);
    if (t > now || t < from) continue;
    out.push(h);
  }
  return out;
}

/** Age bucket used by the thermal colour ramp. */
export function ageBucket(ageMs: number): "fresh" | "recent" | "old" | "stale" {
  const h = ageMs / 3_600_000;
  if (h < 1) return "fresh";
  if (h < 6) return "recent";
  if (h < 24) return "old";
  return "stale";
}

export function isNew(incident: IncidentFeature, now: number): boolean {
  return now - Date.parse(incident.properties.firstDetectedAt) < 15 * 60_000;
}

export function toBBox(map: { getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number } }): [number, number, number, number] {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}
