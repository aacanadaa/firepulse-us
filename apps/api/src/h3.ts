import { latLngToCell, gridDisk, cellToLatLng, cellToParent } from "h3-js";

export const H3_RES = 8; // ~0.74 km² cells, ~0.5 km edge
export const H3_ROUTE_RES = 5;

/** Primary H3 cell for a coordinate. */
export function cellOf(lon: number, lat: number, res = H3_RES): string {
  return latLngToCell(lat, lon, res);
}

/** Cell plus k-ring neighbours, used for stable cluster identity. */
export function neighborhood(lon: number, lat: number, k = 1, res = H3_RES): string[] {
  return gridDisk(latLngToCell(lat, lon, res), k);
}

export function cellsOf(points: { lon: number; lat: number }[], res = H3_RES): string[] {
  const set = new Set<string>();
  for (const p of points) set.add(latLngToCell(p.lat, p.lon, res));
  return [...set];
}

export function parentCell(cell: string, res: number): string {
  return cellToParent(cell, res);
}

export function cellCenter(cell: string): { lon: number; lat: number } {
  const [lat, lon] = cellToLatLng(cell);
  return { lon, lat };
}
