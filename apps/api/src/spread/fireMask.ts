import {
  haversineKm,
  pointInRing,
  type HotspotFeature,
  type IncidentFeature,
  type Ring,
} from "@firepulse/protocol";
import { WIN } from "./model.js";
import { cellLonLat, inWindow, nearestCell, windowBBox, type SpreadWindow } from "./window.js";

/**
 * The model was trained on MODIS active-fire masks, so "fire today" only
 * ever comes from polar-orbiting thermal sensors. GOES pixels are too
 * coarse; dispatch, crowd and camera reports are not fire maps.
 */
export const MASK_SOURCES = new Set(["viirs", "modis"]);
export const MASK_WINDOW_MS = 24 * 3_600_000;
/** A detection this close to an incident's outline belongs to it. */
export const ASSOCIATE_KM = 3;

export function isMaskHotspot(h: HotspotFeature, now: number): boolean {
  if (!MASK_SOURCES.has(h.properties.source)) return false;
  const t = Date.parse(h.properties.observedAt);
  return Number.isFinite(t) && t >= now - MASK_WINDOW_MS && t <= now + 5 * 60_000;
}

function outerRing(f: IncidentFeature): Ring {
  return f.geometry.coordinates[0] ?? [];
}

/** Viirs/modis detections from the last 24 h that belong to an incident. */
export function thermalForIncident(
  incident: IncidentFeature,
  hotspots: HotspotFeature[],
  now: number,
): HotspotFeature[] {
  const ring = outerRing(incident);
  const center = { lon: incident.properties.lon, lat: incident.properties.lat };
  return hotspots.filter((h) => {
    if (!isMaskHotspot(h, now)) return false;
    const p = { lon: h.properties.lon, lat: h.properties.lat };
    if (ring.length > 3 && pointInRing(p, ring)) return true;
    if (haversineKm(p, center) <= ASSOCIATE_KM) return true;
    return ring.some(([lon, lat]) => haversineKm(p, { lon, lat }) <= ASSOCIATE_KM);
  });
}

export function centroidOf(hotspots: HotspotFeature[]): { lon: number; lat: number } {
  let lon = 0;
  let lat = 0;
  for (const h of hotspots) {
    lon += h.properties.lon;
    lat += h.properties.lat;
  }
  return { lon: lon / hotspots.length, lat: lat / hotspots.length };
}

function markPoints(w: SpreadWindow, mask: Uint8Array, points: { lon: number; lat: number }[]): void {
  for (const p of points) {
    const [r, c] = nearestCell(w, p.lon, p.lat);
    if (inWindow(r, c)) mask[r * WIN + c] = 1;
  }
}

function markPerimeter(w: SpreadWindow, mask: Uint8Array, ring: Ring): void {
  if (ring.length < 4) return;
  for (let r = 0; r < WIN; r++) {
    for (let c = 0; c < WIN; c++) {
      const [lon, lat] = cellLonLat(w, r, c);
      if (pointInRing({ lon, lat }, ring)) mask[r * WIN + c] = 1;
    }
  }
}

export interface FireMask {
  /** Every burning cell in the window (model input). */
  mask: Uint8Array;
  /** Cells that belong to the selected incident (for the summary). */
  own: Uint8Array;
}

/**
 * fire_today for a window: every recent viirs/modis detection, snapped to
 * its nearest cell, plus the inside of official perimeters that a thermal
 * detection confirmed burning within the last 24 h.
 */
export function buildFireMask(opts: {
  window: SpreadWindow;
  incident: IncidentFeature;
  ownHotspots: HotspotFeature[];
  windowHotspots: HotspotFeature[];
  officials: IncidentFeature[];
  now: number;
}): FireMask {
  const { window: w, incident, ownHotspots, windowHotspots, officials, now } = opts;
  const mask = new Uint8Array(WIN * WIN);
  const own = new Uint8Array(WIN * WIN);
  const pts = (hs: HotspotFeature[]) => hs.map((h) => ({ lon: h.properties.lon, lat: h.properties.lat }));

  markPoints(w, mask, pts(windowHotspots.filter((h) => isMaskHotspot(h, now))));
  markPoints(w, own, pts(ownHotspots));

  const [minLon, minLat, maxLon, maxLat] = windowBBox(w);
  for (const o of officials) {
    if (o.properties.kind !== "official") continue;
    const ring = outerRing(o);
    const touches = ring.some(([lon, lat]) => lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat);
    if (!touches && o.id !== incident.id) continue;
    const confirmed = o.id === incident.id ? ownHotspots : thermalForIncident(o, windowHotspots, now);
    if (confirmed.length === 0) continue;
    markPerimeter(w, mask, ring);
    if (o.id === incident.id) markPerimeter(w, own, ring);
  }
  for (let i = 0; i < own.length; i++) if (own[i]) mask[i] = 1;
  return { mask, own };
}
