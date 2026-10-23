import { HAZARD_EVENTS, pointInRing, type HazardAlertFeature, type LngLat } from "@firepulse/protocol";

/** When an alert stops applying: its hazard end, else the message expiry. */
export function alertEndsAt(alert: HazardAlertFeature): number {
  const p = alert.properties;
  return Math.max(Date.parse(p.expires) || 0, p.ends ? Date.parse(p.ends) || 0 : 0);
}

export function hazardIntersectsBBox(alert: HazardAlertFeature, bbox: [number, number, number, number]): boolean {
  const b = bboxOf(alert);
  return !(b[2] < bbox[0] || b[0] > bbox[2] || b[3] < bbox[1] || b[1] > bbox[3]);
}

function bboxOf(alert: HazardAlertFeature): [number, number, number, number] {
  const polygons = alert.geometry.type === "Polygon" ? [alert.geometry.coordinates] : alert.geometry.coordinates;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const polygon of polygons) {
    for (const [lon, lat] of polygon[0] ?? []) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * The current set of hazard alerts (evacuations, fire warnings, red flags,
 * smoke). The NWS feed always returns everything active, so each poll
 * replaces the set; alerts also drop out on their own once they end.
 */
export class HazardLayer {
  private alerts = new Map<string, { feature: HazardAlertFeature; bbox: [number, number, number, number] }>();

  get count(): number {
    return this.alerts.size;
  }

  replace(next: HazardAlertFeature[]): { upserts: HazardAlertFeature[]; removes: string[] } {
    const upserts: HazardAlertFeature[] = [];
    const ids = new Set<string>();
    for (const feature of next) {
      ids.add(feature.id);
      const prev = this.alerts.get(feature.id);
      // NWS updates an alert by issuing a new id, so same id means unchanged
      // text; only the outline can differ, as zones resolve.
      if (prev && JSON.stringify(prev.feature.geometry) === JSON.stringify(feature.geometry)) continue;
      this.alerts.set(feature.id, { feature, bbox: bboxOf(feature) });
      upserts.push(feature);
    }
    const removes = [...this.alerts.keys()].filter((id) => !ids.has(id));
    for (const id of removes) this.alerts.delete(id);
    return { upserts, removes };
  }

  /** Active alerts whose area contains a point, most urgent first. */
  covering(point: LngLat, now = Date.now()): HazardAlertFeature[] {
    const box: [number, number, number, number] = [point.lon, point.lat, point.lon, point.lat];
    return this.active(box, now).filter((a) => {
      const polygons = a.geometry.type === "Polygon" ? [a.geometry.coordinates] : a.geometry.coordinates;
      return polygons.some((polygon) => polygon[0] !== undefined && pointInRing(point, polygon[0]));
    });
  }

  /** Active alerts intersecting a bbox, most urgent event first. */
  active(bbox?: [number, number, number, number], now = Date.now()): HazardAlertFeature[] {
    const out: HazardAlertFeature[] = [];
    for (const { feature, bbox: b } of this.alerts.values()) {
      if (alertEndsAt(feature) < now) continue;
      if (bbox && (b[2] < bbox[0] || b[0] > bbox[2] || b[3] < bbox[1] || b[1] > bbox[3])) continue;
      out.push(feature);
    }
    const rank = (f: HazardAlertFeature) => HAZARD_EVENTS.indexOf(f.properties.event);
    return out.sort((a, b) => rank(a) - rank(b));
  }
}
