import {
  bearingDeg,
  compassPoint,
  distanceToRingKm,
  isConfirmedFire,
  pointInRing,
  type AlertKind,
  type AlertSeverity,
  type HazardAlertFeature,
  type IncidentFeature,
  type SpreadForecast,
} from "@firepulse/protocol";
import { forecastOutlook } from "../spread/relevance.js";
import type { AlertDraft, PlaceRecord, UserSettings } from "../accounts/types.js";

/** A watched place with its owner's alert settings. */
export interface Watcher extends PlaceRecord {
  settings: UserSettings;
}

/** Thresholds a known fire can cross on its way toward a place, km. */
export const CLOSER_THRESHOLDS_KM = [10, 5, 2, 0];

const NOT_ORDER = "Not an evacuation order: follow local officials.";

function km(d: number): string {
  if (d === 0) return "0 km";
  return d < 10 ? `${d.toFixed(1)} km` : `${Math.round(d)} km`;
}

function acres(a: number): string {
  return a >= 1000 ? `${(a / 1000).toFixed(a >= 10_000 ? 0 : 1)}k acres` : `${Math.round(a)} acres`;
}

function localDate(now: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

function localMinutes(now: number, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return h * 60 + m;
  } catch {
    return new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes();
  }
}

/**
 * When quiet hours hold a non-urgent alert, the time they end; otherwise
 * null. Windows may wrap midnight (22:00 → 07:00).
 */
export function quietUntil(settings: UserSettings, now: number): string | null {
  const { quietStartMin: start, quietEndMin: end, timezone } = settings;
  if (start == null || end == null || start === end) return null;
  const minute = localMinutes(now, timezone);
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return null;
  const wait = (end - minute + 1440) % 1440;
  return new Date(now + wait * 60_000 - (now % 60_000)).toISOString();
}

function draft(
  w: Watcher,
  kind: AlertKind,
  severity: AlertSeverity,
  subjectId: string,
  revision: string,
  title: string,
  body: string,
  url: string,
  now: number,
): AlertDraft | null {
  if (!w.settings.alertKinds.includes(kind)) return null;
  const notBefore = severity === "urgent" ? null : quietUntil(w.settings, now);
  return {
    userId: w.userId,
    placeId: w.id,
    kind,
    subjectId,
    revision,
    severity,
    title: title.slice(0, 120),
    body: body.slice(0, 300),
    url,
    ...(notBefore ? { notBefore } : {}),
  };
}

export interface IncidentAlerts {
  /** "A fire within your radius": sent once per fire and confirmation step. */
  first: AlertDraft[];
  /** "The fire is now within N km": sent only if `first` was already sent. */
  closer: AlertDraft[];
}

/**
 * Fires a household should hear about: official fires that aren't planned
 * burns, and estimates confirmed by a second pass or a second kind of
 * evidence, within the place's radius (measured to the fire's edge).
 */
export function incidentAlerts(f: IncidentFeature, watchers: Watcher[], now: number): IncidentAlerts {
  const p = f.properties;
  const out: IncidentAlerts = { first: [], closer: [] };
  if (p.mergedInto || p.cause === "prescribed" || !isConfirmedFire(p)) return out;
  const ring = f.geometry.coordinates[0] ?? [];
  // An official fire that grew out of an estimate is the same fire.
  const subject = p.kind === "official" && p.precursor ? p.precursor.estimateId : p.id;

  for (const w of watchers) {
    const distance = ring.length >= 4 ? distanceToRingKm(w, ring) : Infinity;
    if (distance > w.radiusKm) continue;
    const direction = compassPoint(bearingDeg(w, { lon: p.lon, lat: p.lat }));
    const where = distance === 0 ? `${w.name} is inside its mapped area` : `${km(distance)} ${direction} of ${w.name}`;
    const url = `/?incident=${encodeURIComponent(p.id)}&place=${encodeURIComponent(w.id)}`;
    const severity: AlertSeverity = distance === 0 ? "urgent" : distance <= 5 ? "warning" : "info";

    const first =
      p.kind === "official"
        ? draft(
            w,
            "new_fire",
            severity,
            subject,
            "official",
            p.precursor ? `${p.name} is now an official fire` : `Fire near ${w.name}: ${p.name}`,
            `${where}. ${p.containment != null ? `${p.containment}% contained, ` : ""}${acres(p.areaAcres)}. ${NOT_ORDER}`,
            url,
            now,
          )
        : draft(
            w,
            "new_fire",
            severity,
            subject,
            "seen",
            `Possible fire near ${w.name}`,
            `Satellite heat ${where}. Not yet confirmed by fire agencies. ${NOT_ORDER}`,
            url,
            now,
          );
    if (first) out.first.push(first);

    const threshold = CLOSER_THRESHOLDS_KM.filter((t) => t < w.radiusKm && distance <= t).at(-1);
    if (threshold !== undefined) {
      const closer = draft(
        w,
        "fire_closer",
        threshold === 0 ? "urgent" : threshold <= 2 ? "warning" : "info",
        subject,
        `within:${threshold}`,
        threshold === 0 ? `${p.name} has reached ${w.name}` : `${p.name} is within ${threshold} km of ${w.name}`,
        `${where}. ${threshold === 0 ? "Check local evacuation orders now." : NOT_ORDER}`,
        url,
        now,
      );
      if (closer) out.closer.push(closer);
    }
  }
  return out;
}

/**
 * The experimental next-day forecast expects a fire to grow toward a place:
 * likely cells within the place's radius and closer than today's fire.
 * Never urgent; at most once per fire, place and local day.
 */
export function spreadAlerts(f: IncidentFeature, forecast: SpreadForecast, watchers: Watcher[], now: number): AlertDraft[] {
  const p = f.properties;
  if (p.mergedInto || p.cause === "prescribed" || !isConfirmedFire(p) || forecast.status !== "ready") return [];
  const subject = p.kind === "official" && p.precursor ? p.precursor.estimateId : p.id;
  const out: AlertDraft[] = [];
  for (const w of watchers) {
    const o = forecastOutlook(forecast, w);
    if (!o || !o.toward || o.likelyKm === null || o.likelyKm > w.radiusKm) continue;
    const today = o.todayKm === null ? "" : ` (today's fire is ${km(o.todayKm)} away)`;
    const d = draft(
      w,
      "spread",
      o.likelyKm <= 2 || (o.veryLikelyKm !== null && o.veryLikelyKm <= 5) ? "warning" : "info",
      subject,
      localDate(now, w.settings.timezone),
      `${p.name} may spread toward ${w.name}`,
      `The experimental next-day forecast shows likely growth ${o.likelyKm === 0 ? `reaching ${w.name}` : `about ${km(o.likelyKm)} from ${w.name}`}${today}. ${NOT_ORDER}`,
      `/?incident=${encodeURIComponent(p.id)}&place=${encodeURIComponent(w.id)}`,
      now,
    );
    if (d) out.push(d);
  }
  return out;
}

function covers(alert: HazardAlertFeature, point: { lon: number; lat: number }): boolean {
  const polygons = alert.geometry.type === "Polygon" ? [alert.geometry.coordinates] : alert.geometry.coordinates;
  return polygons.some((polygon) => polygon[0] !== undefined && pointInRing(point, polygon[0]));
}

function until(iso: string | undefined, timezone: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  try {
    return ` until ${new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(t)}`;
  } catch {
    return "";
  }
}

/** Evacuation orders and fire warnings always; fire weather once a day. */
export function hazardAlerts(a: HazardAlertFeature, watchers: Watcher[], now: number): AlertDraft[] {
  const p = a.properties;
  const out: AlertDraft[] = [];
  for (const w of watchers) {
    if (!covers(a, w)) continue;
    const url = `/?place=${encodeURIComponent(w.id)}`;
    const ends = until(p.ends ?? p.expires, w.settings.timezone);
    let d: AlertDraft | null = null;
    if (p.event === "Evacuation Immediate" || p.event === "Fire Warning") {
      const instruction = (p.instruction ?? p.headline ?? "").replace(/\s+/g, " ").trim();
      d = draft(
        w,
        p.event === "Evacuation Immediate" ? "evacuation" : "fire_warning",
        "urgent",
        p.id,
        "issued",
        `${p.event === "Evacuation Immediate" ? "Evacuation order" : "Fire warning"} for ${w.name}`,
        `${instruction || `Issued by ${p.sender} for ${p.areaDesc}.`}`,
        url,
        now,
      );
    } else if (p.event === "Red Flag Warning" || p.event === "Extreme Fire Danger") {
      // Fire weather is daily context: at most one per place per local day.
      d = draft(
        w,
        "fire_weather",
        p.event === "Extreme Fire Danger" ? "warning" : "info",
        "fire_weather",
        localDate(now, w.settings.timezone),
        `${p.event} at ${w.name}${ends}`,
        "Fires can start and spread fast. Avoid anything that sparks: mowing, grilling, towing chains.",
        url,
        now,
      );
    }
    if (d) out.push(d);
  }
  return out;
}
