/**
 * FirePulse US: dependency-free geodesy + clustering primitives.
 *
 * Everything here is small, deterministic and testable. Production spatial
 * predicates live in PostGIS (see db/migrations/001_init.sql); these functions
 * back the in-process fallback, the simulation and the client-side hit tests.
 */

import type { Ring } from "./types.js";

export const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

export interface LngLat {
  lon: number;
  lat: number;
}

/** Great-circle distance in kilometres. */
export function haversineKm(a: LngLat, b: LngLat): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a -> b, degrees clockwise from north, 0..360. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Project a point along a bearing (degrees) for a distance (km). */
export function destination(p: LngLat, bearing: number, distanceKm: number): LngLat {
  const d = distanceKm / EARTH_RADIUS_KM;
  const br = bearing * DEG;
  const lat1 = p.lat * DEG;
  const lon1 = p.lon * DEG;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lon: (((lon2 / DEG + 540) % 360) - 180), lat: lat2 / DEG };
}

/** Meters per degree of longitude at a given latitude. */
export function metersPerDegLon(lat: number): number {
  return 111_320 * Math.cos(lat * DEG);
}

export const metersPerDegLat = 110_574;

export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export function bboxOf(points: LngLat[]): BBox {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const p of points) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return !(a.maxLon < b.minLon || a.minLon > b.maxLon || a.maxLat < b.minLat || a.minLat > b.maxLat);
}

export function bboxContainsPoint(b: BBox, p: LngLat): boolean {
  return p.lon >= b.minLon && p.lon <= b.maxLon && p.lat >= b.minLat && p.lat <= b.maxLat;
}

/** Pad a bbox by kilometres. */
export function expandBBox(b: BBox, km: number): BBox {
  const dLat = km / metersPerDegLat;
  const dLon = km / Math.max(1, metersPerDegLon((b.minLat + b.maxLat) / 2));
  return {
    minLon: b.minLon - dLon,
    minLat: b.minLat - dLat,
    maxLon: b.maxLon + dLon,
    maxLat: b.maxLat + dLat,
  };
}

export function centroid(points: LngLat[]): LngLat {
  if (points.length === 0) return { lon: 0, lat: 0 };
  let lon = 0;
  let lat = 0;
  for (const p of points) {
    lon += p.lon;
    lat += p.lat;
  }
  return { lon: lon / points.length, lat: lat / points.length };
}

/** Andrew's monotone chain convex hull. Returns closed ring, CCW. */
export function convexHull(points: LngLat[]): Ring {
  const pts = points
    .map((p) => [p.lon, p.lat] as [number, number])
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));

  if (pts.length < 3) {
    const ring: Ring = pts.map((p) => [p[0], p[1]]);
    if (ring.length > 0) ring.push([ring[0]![0], ring[0]![1]]);
    return ring;
  }

  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);

  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const ring: Ring = [...lower, ...upper].map((p) => [p[0], p[1]]);
  if (ring.length > 0) ring.push([ring[0]![0], ring[0]![1]]);
  return ring;
}

/**
 * Minkowski-sum buffer: convex hull of discs of radius `radiusKm` placed at
 * every hull vertex. Produces a smooth, outward-offset convex polygon, the
 * "buffered convex hull" used for Estimated Active Fire Zones.
 */
export function bufferedHull(points: LngLat[], radiusKm: number, segments = 12): Ring {
  if (points.length === 0) return [];
  const hull = convexHull(points);
  if (hull.length < 4) {
    // Degenerate (1-2 points): emit a circle.
    const c = centroid(points);
    return circleRing(c, radiusKm, segments * 2);
  }
  const verts = hull.slice(0, -1).map(([lon, lat]) => ({ lon, lat }));
  const samples: LngLat[] = [];
  for (const v of verts) {
    for (let i = 0; i < segments; i++) {
      const brg = (360 / segments) * i;
      samples.push(destination(v, brg, radiusKm));
    }
  }
  return convexHull([...verts, ...samples]);
}

export function circleRing(center: LngLat, radiusKm: number, segments = 32): Ring {
  const ring: Ring = [];
  for (let i = 0; i < segments; i++) {
    const p = destination(center, (360 / segments) * i, radiusKm);
    ring.push([p.lon, p.lat]);
  }
  ring.push([ring[0]![0], ring[0]![1]]);
  return ring;
}

/** Ray-casting point-in-polygon on the outer ring (lng/lat planar approx). */
export function pointInRing(p: LngLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    const intersect =
      yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Distance from a point to a ring's boundary in km, or 0 when the point is
 * inside. Local equirectangular projection: accurate to well under 1% at
 * the tens-of-kilometres scale this is used for.
 */
export function distanceToRingKm(p: LngLat, ring: Ring): number {
  if (ring.length === 0) return Infinity;
  if (ring.length >= 4 && pointInRing(p, ring)) return 0;
  const kx = metersPerDegLon(p.lat) / 1000;
  const ky = metersPerDegLat / 1000;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[Math.min(i + 1, ring.length - 1)]!;
    const x1 = (ax - p.lon) * kx;
    const y1 = (ay - p.lat) * ky;
    const dx = (bx - ax) * kx;
    const dy = (by - ay) * ky;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
  }
  return best;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** 16-point compass name for a bearing in degrees. */
export function compassPoint(bearing: number): string {
  const i = Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS[i]!;
}

/**
 * Douglas-Peucker simplification of a closed ring, tolerance in degrees.
 * Keeps the first and last vertex, so the ring stays closed.
 */
export function simplifyRing(ring: Ring, toleranceDeg: number): Ring {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  const tol2 = toleranceDeg * toleranceDeg;
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const [ax, ay] = ring[first]!;
    const [bx, by] = ring[last]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = ring[i]!;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const ex = px - (ax + t * dx);
      const ey = py - (ay + t * dy);
      const d = ex * ex + ey * ey;
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (index >= 0 && maxD > tol2) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = ring.filter((_, i) => keep[i] === 1);
  // A ring needs at least four positions; fall back to the original.
  return out.length >= 4 ? out : ring;
}

/** Approximate spherical area of a ring, km². */
export function ringAreaSqKm(ring: Ring): number {
  if (ring.length < 3) return 0;
  const meanLat = centroid(ring.map(([lon, lat]) => ({ lon, lat }))).lat;
  const kx = metersPerDegLon(meanLat) / 1000;
  const ky = metersPerDegLat / 1000;
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    area += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky);
  }
  return Math.abs(area) / 2;
}

export function km2ToAcres(km2: number): number {
  return km2 * 247.105;
}

/* ------------------------------------------------------------------ */
/* DBSCAN                                                              */
/* ------------------------------------------------------------------ */

export interface DBScanOptions {
  /** neighbourhood radius in km */
  epsKm: number;
  /** minimum points to form a core cluster */
  minPts: number;
}

export interface DBScanResult<T> {
  clusters: { id: number; members: T[]; centroid: LngLat }[];
  noise: T[];
}

/**
 * Haversine DBSCAN with a spatial hash pre-filter. O(n·k) for realistic
 * hotspot densities; the PostGIS deployment uses ST_ClusterDBSCAN instead.
 */
export function dbscan<T extends LngLat>(
  points: T[],
  { epsKm, minPts }: DBScanOptions,
): DBScanResult<T> {
  const n = points.length;
  const labels = new Int32Array(n).fill(-1); // -1 unvisited, -2 noise, >=0 cluster
  const cell = Math.max(0.05, epsKm / 111); // degrees
  const grid = new Map<string, number[]>();
  const key = (lon: number, lat: number) =>
    `${Math.floor(lon / cell)}:${Math.floor(lat / cell)}`;

  points.forEach((p, i) => {
    const k = key(p.lon, p.lat);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });

  const neighbours = (i: number): number[] => {
    const p = points[i]!;
    const cx = Math.floor(p.lon / cell);
    const cy = Math.floor(p.lat / cell);
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(`${cx + dx}:${cy + dy}`);
        if (!list) continue;
        for (const j of list) {
          if (j === i) continue;
          if (haversineKm(p, points[j]!) <= epsKm) out.push(j);
        }
      }
    }
    return out;
  };

  let clusterId = 0;

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;
    const nbrs = neighbours(i);
    if (nbrs.length + 1 < minPts) {
      labels[i] = -2;
      continue;
    }
    labels[i] = clusterId;
    const queue = [...nbrs];
    let head = 0;
    while (head < queue.length) {
      const j = queue[head++]!;
      if (labels[j] === -2) labels[j] = clusterId;
      if (labels[j] !== -1) continue;
      labels[j] = clusterId;
      const jn = neighbours(j);
      if (jn.length + 1 >= minPts) queue.push(...jn);
    }
    clusterId++;
  }

  const clusters = new Map<number, T[]>();
  const noise: T[] = [];
  points.forEach((p, i) => {
    const l = labels[i]!;
    if (l < 0) {
      noise.push(p);
      return;
    }
    const list = clusters.get(l);
    if (list) list.push(p);
    else clusters.set(l, [p]);
  });

  return {
    clusters: [...clusters.entries()].map(([id, members]) => ({
      id,
      members,
      centroid: centroid(members),
    })),
    noise,
  };
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function fmtCoord(v: number, digits = 4): string {
  return v.toFixed(digits);
}

/** Compact age label: "42s", "7m", "3h 12m". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function isoNoMs(d: Date | number): string {
  return new Date(d).toISOString();
}
