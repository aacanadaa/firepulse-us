import type { Ring } from "@firepulse/protocol";
import { WIN } from "./model.js";

/**
 * A local north-up 64 x 64 grid of 1 km cells centred on (lon0, lat0).
 * Row 0 is the north edge, column 0 the west edge (the model's convention).
 * The centre falls on the corner shared by cells 31 and 32, as in training.
 */
export interface SpreadWindow {
  lon0: number;
  lat0: number;
  /** km per degree of longitude at lat0. */
  kmPerLon: number;
}

export const KM_PER_LAT = 110.574;
const HALF = (WIN - 1) / 2; // 31.5

export function makeWindow(lon0: number, lat0: number): SpreadWindow {
  return { lon0, lat0, kmPerLon: 111.32 * Math.cos((lat0 * Math.PI) / 180) };
}

/** Lon/lat of a (possibly fractional) cell position; integers are cell centres. */
export function cellLonLat(w: SpreadWindow, r: number, c: number): [number, number] {
  return [w.lon0 + (c - HALF) / w.kmPerLon, w.lat0 + (HALF - r) / KM_PER_LAT];
}

/** Nearest cell to a point; may fall outside 0..63. */
export function nearestCell(w: SpreadWindow, lon: number, lat: number): [number, number] {
  return [
    Math.round(HALF - (lat - w.lat0) * KM_PER_LAT),
    Math.round(HALF + (lon - w.lon0) * w.kmPerLon),
  ];
}

export function inWindow(r: number, c: number): boolean {
  return r >= 0 && r < WIN && c >= 0 && c < WIN;
}

/** Outer corners of the window. */
export function windowCorners(w: SpreadWindow) {
  const edge = WIN - 0.5;
  return {
    nw: cellLonLat(w, -0.5, -0.5),
    ne: cellLonLat(w, -0.5, edge),
    se: cellLonLat(w, edge, edge),
    sw: cellLonLat(w, edge, -0.5),
  };
}

/** [minLon, minLat, maxLon, maxLat] of the window. */
export function windowBBox(w: SpreadWindow): [number, number, number, number] {
  const { nw, se } = windowCorners(w);
  return [nw[0], se[1], se[0], nw[1]];
}

export function cellRing(w: SpreadWindow, r: number, c: number): Ring {
  const nw = cellLonLat(w, r - 0.5, c - 0.5);
  const ne = cellLonLat(w, r - 0.5, c + 0.5);
  const se = cellLonLat(w, r + 0.5, c + 0.5);
  const sw = cellLonLat(w, r + 0.5, c - 0.5);
  const round = (p: [number, number]): [number, number] => [
    Math.round(p[0] * 1e6) / 1e6,
    Math.round(p[1] * 1e6) / 1e6,
  ];
  return [round(nw), round(ne), round(se), round(sw), round(nw)];
}

/** Centres of all 4096 cells, row-major. */
export function cellCenters(w: SpreadWindow): { lons: Float64Array; lats: Float64Array } {
  const lons = new Float64Array(WIN * WIN);
  const lats = new Float64Array(WIN * WIN);
  for (let r = 0; r < WIN; r++) {
    for (let c = 0; c < WIN; c++) {
      const [lon, lat] = cellLonLat(w, r, c);
      lons[r * WIN + c] = lon;
      lats[r * WIN + c] = lat;
    }
  }
  return { lons, lats };
}

/* ------------------------------------------------------------------ */
/* Contiguous US                                                       */
/* ------------------------------------------------------------------ */

export type Outline =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] }
  | { type: "GeometryCollection"; geometries: Outline[] };

/** Fallback when the static index has no outline. */
const CONUS_BBOX: [number, number, number, number] = [-124.85, 24.4, -66.85, 49.4];

function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lon: number, lat: number, rings: number[][][]): boolean {
  if (!rings[0] || !inRing(lon, lat, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(lon, lat, rings[k]!)) return false;
  return true;
}

function inOutline(lon: number, lat: number, g: Outline): boolean {
  if (g.type === "Polygon") return inPolygon(lon, lat, g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.some((p) => inPolygon(lon, lat, p));
  return g.geometries.some((child) => inOutline(lon, lat, child));
}

export function insideConus(lon: number, lat: number, outline: Outline | null): boolean {
  const [w, s, e, n] = CONUS_BBOX;
  if (lon < w || lon > e || lat < s || lat > n) return false;
  if (!outline) return true;
  // The outline is simplified (~3 km), so accept points within ~5 km of it.
  const d = 0.05;
  const probes: [number, number][] = [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]];
  return probes.some(([dx, dy]) => inOutline(lon + dx, lat + dy, outline));
}
