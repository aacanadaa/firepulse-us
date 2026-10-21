import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { Outline } from "./window.js";

const gunzipAsync = promisify(gunzip);

export interface StaticBand {
  name: string;
  dtype: "int16" | "uint16";
  encoding: "linear" | "log1p";
  scale: number;
  offset: number;
  nodata: number;
}

export interface StaticTile {
  id: string;
  west: number;
  south: number;
  east: number;
  north: number;
  file: string;
}

/** static_conus/index.json */
export interface StaticIndex {
  version: number;
  tileDeg: number;
  /** Degrees per pixel. */
  res: number;
  /** Pixels per tile side, including the 1-pixel border. */
  width: number;
  height: number;
  bands: StaticBand[];
  tiles: StaticTile[];
  conus?: Outline;
  ndviDate?: string;
  exported?: string;
}

export interface StaticSample {
  elevation: Float32Array;
  NDVI: Float32Array;
  population: Float32Array;
}

type Raw = Int16Array | Uint16Array;
interface LoadedTile {
  meta: StaticTile;
  bands: Raw[];
}

/**
 * Slow-changing layers (terrain, vegetation, population) for CONUS.
 *
 * 5-degree tiles are loaded on first use and kept in a small LRU (~2 MB
 * each, still encoded). Pixel (row, col) of a tile is centred at
 *   lon = west + (col - 0.5) * res,  lat = north - (row - 0.5) * res
 * and every tile carries a 1-pixel border, so bilinear sampling never
 * crosses into a neighbour. No data -> NaN.
 */
export class StaticLayers {
  private index: StaticIndex | null = null;
  private indexLoad: Promise<StaticIndex> | null = null;
  private tiles = new Map<string, LoadedTile | null>();
  private loading = new Map<string, Promise<LoadedTile | null>>();

  constructor(
    private readonly dir: string,
    private readonly cacheSize = 12,
  ) {}

  get cachedTiles(): number {
    return this.tiles.size;
  }

  async getIndex(): Promise<StaticIndex> {
    if (this.index) return this.index;
    this.indexLoad ??= readFile(join(this.dir, "index.json"), "utf8").then((text) => {
      const index = JSON.parse(text) as StaticIndex;
      for (const name of ["elevation", "NDVI", "population"]) {
        if (!index.bands.some((b) => b.name === name)) throw new Error(`static index has no ${name} band`);
      }
      this.index = index;
      return index;
    });
    try {
      return await this.indexLoad;
    } catch (err) {
      this.indexLoad = null;
      throw err;
    }
  }

  private tileFor(index: StaticIndex, lon: number, lat: number): StaticTile | undefined {
    return index.tiles.find((t) => lon >= t.west && lon < t.east && lat > t.south && lat <= t.north);
  }

  private async loadTile(index: StaticIndex, tile: StaticTile): Promise<LoadedTile | null> {
    const hit = this.tiles.get(tile.id);
    if (hit !== undefined) {
      // Refresh LRU position.
      this.tiles.delete(tile.id);
      this.tiles.set(tile.id, hit);
      return hit;
    }
    let pending = this.loading.get(tile.id);
    if (!pending) {
      pending = (async () => {
        try {
          const gz = await readFile(join(this.dir, tile.file));
          const buf = await gunzipAsync(gz);
          const n = index.width * index.height;
          if (buf.length !== n * 2 * index.bands.length) {
            throw new Error(`tile ${tile.id} has ${buf.length} bytes, expected ${n * 2 * index.bands.length}`);
          }
          // Copy into an aligned buffer so typed views are valid.
          const aligned = new ArrayBuffer(buf.length);
          new Uint8Array(aligned).set(buf);
          const bands = index.bands.map((b, i) =>
            b.dtype === "int16"
              ? new Int16Array(aligned, i * n * 2, n)
              : new Uint16Array(aligned, i * n * 2, n),
          );
          return { meta: tile, bands };
        } catch {
          return null; // missing tile -> NaN, never an error
        }
      })();
      this.loading.set(tile.id, pending);
    }
    const loaded = await pending;
    this.loading.delete(tile.id);
    this.tiles.set(tile.id, loaded);
    while (this.tiles.size > this.cacheSize) {
      const oldest = this.tiles.keys().next().value as string;
      this.tiles.delete(oldest);
    }
    return loaded;
  }

  /** Bilinear samples of every band at the given points. */
  async sample(lons: ArrayLike<number>, lats: ArrayLike<number>): Promise<StaticSample> {
    const index = await this.getIndex();
    const n = lons.length;
    const out: StaticSample = {
      elevation: new Float32Array(n).fill(NaN),
      NDVI: new Float32Array(n).fill(NaN),
      population: new Float32Array(n).fill(NaN),
    };
    const byTile = new Map<StaticTile, number[]>();
    for (let i = 0; i < n; i++) {
      const tile = this.tileFor(index, lons[i]!, lats[i]!);
      if (!tile) continue;
      let list = byTile.get(tile);
      if (!list) byTile.set(tile, (list = []));
      list.push(i);
    }
    for (const [meta, points] of byTile) {
      const tile = await this.loadTile(index, meta);
      if (!tile) continue;
      index.bands.forEach((band, b) => {
        const target = out[band.name as keyof StaticSample];
        if (!target) return;
        const raw = tile.bands[b]!;
        for (const i of points) target[i] = bilinear(index, meta, raw, band, lons[i]!, lats[i]!);
      });
    }
    return out;
  }
}

export function decode(band: StaticBand, raw: number): number {
  if (raw === band.nodata) return NaN;
  const v = raw * band.scale + band.offset;
  return band.encoding === "log1p" ? Math.expm1(v) : v;
}

function bilinear(
  index: StaticIndex,
  tile: StaticTile,
  raw: Raw,
  band: StaticBand,
  lon: number,
  lat: number,
): number {
  const col = (lon - tile.west) / index.res + 0.5;
  const row = (tile.north - lat) / index.res + 0.5;
  const c0 = Math.min(index.width - 2, Math.max(0, Math.floor(col)));
  const r0 = Math.min(index.height - 2, Math.max(0, Math.floor(row)));
  const fx = Math.min(1, Math.max(0, col - c0));
  const fy = Math.min(1, Math.max(0, row - r0));
  let sum = 0;
  let wsum = 0;
  const corners: [number, number, number][] = [
    [r0, c0, (1 - fy) * (1 - fx)],
    [r0, c0 + 1, (1 - fy) * fx],
    [r0 + 1, c0, fy * (1 - fx)],
    [r0 + 1, c0 + 1, fy * fx],
  ];
  for (const [r, c, w] of corners) {
    if (w === 0) continue;
    const v = decode(band, raw[r * index.width + c]!);
    if (Number.isNaN(v)) continue;
    sum += v * w;
    wsum += w;
  }
  // Renormalise over the valid neighbours (coastlines, cloud gaps).
  return wsum > 0 ? sum / wsum : NaN;
}
