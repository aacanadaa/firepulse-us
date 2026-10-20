#!/usr/bin/env node
/**
 * Build the FirePulse basemap as a PMTiles v3 vector archive.
 *
 *   Natural Earth (public domain)
 *        ↓ filter to North America
 *   geojson-vt  →  MVT (vt-pbf)  →  gzip
 *        ↓
 *   PMTiles v3 (hand-rolled writer, validated by reading it back)
 *
 * Output: apps/web/public/basemap/firepulse.pmtiles (~0.5 MB)
 *
 * The npm `pmtiles` package is read-only, so the archive writer lives here:
 * 127-byte header + gzipped root directory + gzipped metadata + tiles.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import { PMTiles, zxyToTileId } from "pmtiles";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CACHE = join(ROOT, ".cache", "natural-earth");
const OUT = join(ROOT, "apps", "web", "public", "basemap", "firepulse.pmtiles");

const BBOX = [-142, 3, -48, 62];
const MIN_ZOOM = 0;
const MAX_ZOOM = 6;
const BASE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";

const LAYERS = [
  { name: "land", file: "ne_50m_land", minzoom: 0, maxzoom: 6 },
  { name: "countries", file: "ne_50m_admin_0_boundary_lines_land", minzoom: 1, maxzoom: 6 },
  { name: "states", file: "ne_50m_admin_1_states_provinces_lines", minzoom: 2, maxzoom: 6 },
  { name: "lakes", file: "ne_50m_lakes", minzoom: 2, maxzoom: 6 },
  { name: "rivers", file: "ne_50m_rivers_lake_centerlines", minzoom: 3, maxzoom: 6 },
  { name: "places", file: "ne_50m_populated_places", minzoom: 3, maxzoom: 6 },
];

function fetchGeoJSON(file) {
  const cached = join(CACHE, `${file}.geojson`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
  const res = spawnSync("curl", ["-sL", `${BASE}/${file}.geojson`]);
  if (res.status !== 0) throw new Error(`download failed: ${file}`);
  const text = res.stdout.toString("utf8");
  writeFileSync(cached, text);
  return JSON.parse(text);
}

import { spawnSync } from "node:child_process";

function intersects(bbox, geom) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      if (c[0] < minLon) minLon = c[0];
      if (c[0] > maxLon) maxLon = c[0];
      if (c[1] < minLat) minLat = c[1];
      if (c[1] > maxLat) maxLat = c[1];
    } else for (const x of c) walk(x);
  };
  walk(geom.coordinates);
  return !(maxLon < bbox[0] || minLon > bbox[2] || maxLat < bbox[1] || minLat > bbox[3]);
}

function tileRange(bbox, z) {
  const n = 2 ** z;
  const lon2x = (lon) => Math.floor(((lon + 180) / 360) * n);
  const lat2y = (lat) => {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  };
  return {
    minX: Math.max(0, lon2x(bbox[0])),
    maxX: Math.min(n - 1, lon2x(bbox[2])),
    minY: Math.max(0, lat2y(bbox[3])),
    maxY: Math.min(n - 1, lat2y(bbox[1])),
  };
}

/* ---------------- PMTiles v3 writer ---------------- */

function varint(n) {
  const out = [];
  let v = BigInt(n);
  if (v < 0n) throw new Error("negative varint");
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

function serializeDirectory(entries) {
  // PMTiles v3 directories are columnar: all tile-id deltas, then all
  // run lengths, then all lengths, then all offsets. Each u64 is a varint.
  const bytes = [];
  bytes.push(...varint(entries.length));
  let prev = 0n;
  for (const e of entries) {
    const id = BigInt(e.tileId);
    bytes.push(...varint(id - prev));
    prev = id;
  }
  for (const e of entries) bytes.push(...varint(e.runLength));
  for (const e of entries) bytes.push(...varint(e.length));
  for (const e of entries) bytes.push(...varint(BigInt(e.offset) + 1n));
  return Buffer.from(bytes);
}

function writeU64(buf, offset, value) {
  buf.writeBigUInt64LE(BigInt(value), offset);
}

function writeI32(buf, offset, value) {
  buf.writeInt32LE(value, offset);
}

function assemblePMTiles({ entries, tiles, metadata, minZoom, maxZoom, bbox }) {
  const root = gzipSync(serializeDirectory(entries), { level: 9 });
  const meta = gzipSync(Buffer.from(JSON.stringify(metadata)), { level: 9 });
  const tileData = Buffer.concat(tiles.map((t) => t.data));

  const headerSize = 127;
  const rootDirOffset = headerSize;
  const rootDirLength = root.length;
  const metadataOffset = rootDirOffset + rootDirLength;
  const metadataLength = meta.length;
  const tileDataOffset = metadataOffset + metadataLength;
  const tileDataLength = tileData.length;

  const header = Buffer.alloc(headerSize);
  header.write("PMTiles", 0, "ascii");
  header.writeUInt8(3, 7);
  writeU64(header, 8, rootDirOffset);
  writeU64(header, 16, rootDirLength);
  writeU64(header, 24, metadataOffset);
  writeU64(header, 32, metadataLength);
  writeU64(header, 40, 0); // leaf dirs
  writeU64(header, 48, 0);
  writeU64(header, 56, tileDataOffset);
  writeU64(header, 64, tileDataLength);
  writeU64(header, 72, entries.length);
  writeU64(header, 80, entries.length);
  writeU64(header, 88, entries.length);
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(2, 97); // internal compression: gzip
  header.writeUInt8(2, 98); // tile compression: gzip
  header.writeUInt8(1, 99); // tile type: MVT
  header.writeUInt8(minZoom, 100);
  header.writeUInt8(maxZoom, 101);
  writeI32(header, 102, Math.round(bbox[0] * 1e7));
  writeI32(header, 106, Math.round(bbox[1] * 1e7));
  writeI32(header, 110, Math.round(bbox[2] * 1e7));
  writeI32(header, 114, Math.round(bbox[3] * 1e7));
  header.writeUInt8(Math.min(5, maxZoom), 118);
  writeI32(header, 119, Math.round(((bbox[0] + bbox[2]) / 2) * 1e7));
  writeI32(header, 123, Math.round(((bbox[1] + bbox[3]) / 2) * 1e7));

  return Buffer.concat([header, root, meta, tileData]);
}

/* ---------------- main ---------------- */

async function main() {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(dirname(OUT), { recursive: true });

  const indexes = [];
  const vectorLayers = [];

  for (const layer of LAYERS) {
    const raw = fetchGeoJSON(layer.file);
    let features = raw.features.filter((f) => f.geometry && intersects(BBOX, f.geometry));
    if (layer.name === "places") {
      features = features
        .filter((f) => Number(f.properties?.POP_MAX ?? 0) >= 250000)
        .map((f) => ({
          type: "Feature",
          geometry: f.geometry,
          properties: {
            name: f.properties?.NAME ?? "",
            pop: Number(f.properties?.POP_MAX ?? 0),
            capital: f.properties?.FEATURECLA?.includes("capital") ? 1 : 0,
          },
        }));
    }
    if (layer.name === "states") {
      features = features.map((f) => ({
        type: "Feature",
        geometry: f.geometry,
        properties: { name: f.properties?.name ?? f.properties?.NAME ?? "" },
      }));
    }
    console.log(`  ${layer.name}: ${features.length} features`);
    const index = geojsonvt(
      { type: "FeatureCollection", features },
      { maxZoom: MAX_ZOOM, indexMaxZoom: 4, tolerance: 2.2, buffer: 64, generateId: true },
    );
    indexes.push({ ...layer, index });
    vectorLayers.push({
      id: layer.name,
      fields: layer.name === "places" ? { name: "String", pop: "Number", capital: "Number" } : {},
      minzoom: layer.minzoom,
      maxzoom: layer.maxzoom,
    });
  }

  const tiles = [];
  const entries = [];

  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const { minX, maxX, minY, maxY } = tileRange(BBOX, z);
    let count = 0;
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const layers = {};
        for (const { name, index, minzoom, maxzoom } of indexes) {
          if (z < minzoom || z > maxzoom) continue;
          const tile = index.getTile(z, x, y);
          if (tile && tile.features.length > 0) layers[name] = tile;
        }
        if (Object.keys(layers).length === 0) continue;
        const encoded = vtpbf.fromGeojsonVt(layers, { version: 2 });
        const gz = gzipSync(Buffer.from(encoded), { level: 9 });
        tiles.push({ z, x, y, data: gz, tileId: zxyToTileId(z, x, y) });
        count++;
      }
    }
    console.log(`  zoom ${z}: ${count} tiles`);
  }

  // PMTiles requires entries and tile data in tile-id order. Offsets must be
  // assigned after sorting, otherwise every directory entry points at the
  // wrong tile.
  tiles.sort((a, b) => a.tileId - b.tileId);
  let cursor = 0;
  for (const t of tiles) {
    entries.push({ tileId: t.tileId, runLength: 1, length: t.data.length, offset: cursor });
    cursor += t.data.length;
  }
  const archive = assemblePMTiles({
    entries,
    tiles,
    metadata: {
      name: "FirePulse US basemap",
      description: "Natural Earth 1:110m/1:50m — public domain",
      attribution: "Natural Earth",
      type: "vector",
      format: "pbf",
      vector_layers: vectorLayers,
    },
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    bbox: BBOX,
  });

  writeFileSync(OUT, archive);
  console.log(`\nwrote ${OUT} (${(archive.length / 1024 / 1024).toFixed(2)} MB, ${tiles.length} tiles)`);

  /* ---- validate by reading the archive back through the pmtiles reader ---- */
  const source = {
    getKey: () => "basemap",
    async getBytes(offset, length) {
      const slice = archive.subarray(offset, offset + length);
      return { data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
    },
  };
  const pm = new PMTiles(source);
  const header = await pm.getHeader();
  console.log(
    `validated header: v${header.specVersion} type=${header.tileType} zoom=${header.minZoom}-${header.maxZoom} entries=${header.numTileEntries}`,
  );
  const sample = tiles[Math.floor(tiles.length / 2)];
  const got = await pm.getZxy(sample.z, sample.x, sample.y);
  if (!got) throw new Error("validation failed: sample tile missing");
  // getZxy already applies tile decompression, so this is raw MVT.
  const raw = Buffer.from(got.data);
  if (raw[0] !== 0x1a) throw new Error(`unexpected MVT payload magic: 0x${raw[0]?.toString(16)}`);
  console.log(
    `sample tile z${sample.z}/${sample.x}/${sample.y}: ${raw.length} bytes MVT (first layer tag 0x1a)`,
  );
  const meta = await pm.getMetadata();
  console.log(`metadata layers: ${(meta.vector_layers ?? []).map((l) => l.id).join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
