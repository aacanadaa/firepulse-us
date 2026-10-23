import {
  bearingDeg,
  compassPoint,
  distanceToRingKm,
  haversineKm,
  type IncidentFeature,
  type LngLat,
  type NearbyFire,
  type NearbySummary,
} from "@firepulse/protocol";
import { outerRings } from "./fusion/engine.js";
import type { HazardLayer } from "./realtime/hazards.js";

export const NEARBY_MAX_RADIUS_KM = 200;
const MAX_FIRES = 50;
/** No mapped fire is wider than this; cheap centroid prefilter. */
const MAX_FIRE_RADIUS_KM = 80;

/**
 * What matters to someone at one point: fires within `radiusKm` of it
 * (measured to the fire's mapped edge, so a large fire next door is near
 * even if its centre is far) and alerts whose area covers it.
 */
export function nearbySummary(
  point: LngLat,
  radiusKm: number,
  incidents: IncidentFeature[],
  hazards: HazardLayer,
  now = Date.now(),
): NearbySummary {
  const fires: NearbyFire[] = [];
  for (const f of incidents) {
    const p = f.properties;
    if (p.mergedInto) continue;
    const center = { lon: p.lon, lat: p.lat };
    if (haversineKm(point, center) > radiusKm + MAX_FIRE_RADIUS_KM) continue;
    const rings = outerRings(f);
    const distanceKm = rings.length > 0 ? Math.min(...rings.map((r) => distanceToRingKm(point, r))) : haversineKm(point, center);
    if (distanceKm > radiusKm) continue;
    const bearing = bearingDeg(point, center);
    fires.push({
      id: p.id,
      name: p.name,
      kind: p.kind,
      status: p.status,
      cause: p.cause,
      distanceKm: Math.round(distanceKm * 10) / 10,
      bearingDeg: Math.round(bearing),
      direction: compassPoint(bearing),
      areaAcres: p.areaAcres,
      containment: p.containment,
      confidence: p.confidence,
      growthAcresPerHour: p.growthAcresPerHour,
      firstDetectedAt: p.firstDetectedAt,
      updatedAt: p.updatedAt,
      officialSince: p.officialSince,
      state: p.state,
      county: p.county,
      lat: p.lat,
      lon: p.lon,
    });
  }
  fires.sort((a, b) => a.distanceKm - b.distanceKm);
  return {
    lat: point.lat,
    lon: point.lon,
    radiusKm,
    generatedAt: new Date(now).toISOString(),
    fires: fires.slice(0, MAX_FIRES),
    alerts: hazards.covering(point, now).map((a) => a.properties),
  };
}
