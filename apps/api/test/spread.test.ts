import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { HotspotFeature, IncidentFeature, SourceId } from "@firepulse/protocol";
import { config } from "../src/config.js";
import { CHANNELS, OnnxSpreadModel, WIN, type ModelMeta, type Predictor } from "../src/spread/model.js";
import { StaticLayers } from "../src/spread/static.js";
import { buildFireMask } from "../src/spread/fireMask.js";
import { summarize } from "../src/spread/summary.js";
import { cellLonLat, insideConus, makeWindow, windowCorners } from "../src/spread/window.js";
import {
  dailyWeather,
  localDay,
  parseGridmetCsv,
  weatherCard,
  weatherFields,
  type OpenMeteoPoint,
} from "../src/spread/weather.js";
import { REASONS, SpreadService, type SpreadSettings } from "../src/spread/service.js";

const FIX = join(__dirname, "fixtures", "spread");
const manifest = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8"));

function bin<T extends Float32Array | Float64Array | Uint8Array>(
  file: string,
  Type: { new (b: ArrayBuffer): T },
): T {
  const buf = readFileSync(join(FIX, file));
  const copy = new ArrayBuffer(buf.length);
  new Uint8Array(copy).set(buf);
  return new Type(copy);
}

const openMeteo = JSON.parse(readFileSync(join(FIX, "open_meteo.json"), "utf8")) as OpenMeteoPoint[];

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

const modelPresent = existsSync(config.spread.modelPath);

describe.skipIf(!modelPresent)("ONNX model", () => {
  it("matches PyTorch to < 1e-4", async () => {
    const model = new OnnxSpreadModel(config.spread.modelPath);
    expect(model.meta.threshold).toBe(0.12);
    const input = bin(manifest.onnx.input.file, Float32Array);
    const expected = bin(manifest.onnx.expected.file, Float32Array);
    const got = await model.predict(input, 2);
    expect(got.length).toBe(expected.length);
    let worst = 0;
    for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i]! - expected[i]!));
    expect(worst).toBeLessThan(1e-4);
  });
});

if (!modelPresent) {
  console.warn(`ONNX parity skipped: ${config.spread.modelPath} not found (see README "Spread forecasts").`);
}

/* ------------------------------------------------------------------ */
/* Weather                                                             */
/* ------------------------------------------------------------------ */

describe("weather", () => {
  const day = manifest.weather.localDay as string;

  it("picks the fire's local calendar day", () => {
    // 19:00 UTC is noon in Los Angeles; 05:00 UTC the next day is still the 20th there.
    expect(localDay(openMeteo[0]!, Date.parse("2026-10-20T19:00:00Z"))).toBe(day);
    expect(localDay(openMeteo[0]!, Date.parse("2026-10-21T05:00:00Z"))).toBe(day);
  });

  it("daily values match the reference to < 1e-6", () => {
    const expected = manifest.weather.daily as Record<string, number>[];
    openMeteo.forEach((pt, i) => {
      const got = dailyWeather(pt, day);
      for (const [k, v] of Object.entries(expected[i]!)) {
        expect(Math.abs(got[k as keyof typeof got] - v), `${i}.${k}`).toBeLessThan(1e-6);
      }
    });
  });

  it("upsampled 64x64 fields match the reference to < 1e-6", () => {
    const fields = weatherFields(openMeteo.map((pt) => dailyWeather(pt, day)));
    const expected = bin(manifest.weather.fields.file, Float64Array);
    (manifest.weather.fields.channels as (keyof typeof fields)[]).forEach((ch, c) => {
      let worst = 0;
      for (let i = 0; i < WIN * WIN; i++) {
        worst = Math.max(worst, Math.abs(fields[ch][i]! - expected[c * WIN * WIN + i]!));
      }
      expect(worst, ch).toBeLessThan(1e-6);
    });
  });

  it("refuses a day with fewer than 12 hours", () => {
    expect(() => dailyWeather(openMeteo[0]!, "2026-10-25")).toThrow(/hours/);
  });

  it("builds the weather card in plain units", () => {
    const card = weatherCard(openMeteo.map((pt) => dailyWeather(pt, day)), 80.4, -1.33, true);
    expect(card.erc).toBe(80);
    expect(card.pdsi).toBe(-1.3);
    expect(card.redFlag).toBe(true);
    expect(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]).toContain(card.windFrom);
    expect(card.tmaxF).toBeGreaterThan(card.tminF);
  });
});

describe("GRIDMET CSV", () => {
  const head = (v: string) => `time,latitude[unit="degrees_north"],longitude[unit="degrees_east"],${v}[unit=""]`;
  const pdsi = (rows: number[]) =>
    [head("daily_mean_palmer_drought_severity_index"), ...rows.map((r, i) => `2026-10-0${i + 1}T00:00:00Z,34.2,-117.3,${r}`)].join("\n");

  it("unpacks PDSI: 1367 -> -1.33", () => {
    expect(parseGridmetCsv(pdsi([1392, 1367]), "pdsi")).toBeCloseTo(-1.33, 10);
  });

  it("treats 32767 as no data", () => {
    expect(parseGridmetCsv(pdsi([32767]), "pdsi")).toBeNull();
    expect(parseGridmetCsv(pdsi([1367, 32767]), "pdsi")).toBeCloseTo(-1.33, 10);
  });

  it("finds the value column by header name and range-checks ERC", () => {
    const erc = [
      `daily_mean_energy_release_component-g[unit="Unitless"],time,latitude,longitude`,
      "38.0,2026-10-18T00:00:00Z,34.2,-117.3",
      "44.0,2026-10-19T00:00:00Z,34.2,-117.3",
      "32767,2026-10-20T00:00:00Z,34.2,-117.3",
      "400,2026-10-20T00:00:00Z,34.2,-117.3",
    ].join("\n");
    expect(parseGridmetCsv(erc, "erc")).toBe(44);
    expect(parseGridmetCsv("time,lat,lon,other\n1,2,3,4", "erc")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Window + fire mask                                                   */
/* ------------------------------------------------------------------ */

let hotspotSeq = 0;
function hotspot(lon: number, lat: number, source: SourceId = "viirs", observedAt = "2026-10-20T18:00:00Z"): HotspotFeature {
  const id = `${source}-${hotspotSeq++}`;
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { id, source, observedAt, receivedAt: observedAt, confidence: 80, frp: 10, lon, lat, tier: 2 },
  };
}

function incident(
  id: string,
  lon: number,
  lat: number,
  opts: { kind?: "estimated" | "official"; confidence?: number; modalities?: string[]; halfKm?: number } = {},
): IncidentFeature {
  const d = (opts.halfKm ?? 1.5) / 111;
  const ring: [number, number][] = [
    [lon - d, lat - d],
    [lon + d, lat - d],
    [lon + d, lat + d],
    [lon - d, lat + d],
    [lon - d, lat - d],
  ];
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {
      id,
      kind: opts.kind ?? "estimated",
      name: id,
      status: "growing",
      confidence: opts.confidence ?? 80,
      confidenceBreakdown: { score: 80, fused: 0.8, corroboration: 1, freshness: 1, distinctModalities: 2, evidenceCount: 3, rationale: "" },
      sources: [],
      firstDetectedAt: "2026-10-20T12:00:00Z",
      updatedAt: "2026-10-20T18:00:00Z",
      areaAcres: 100,
      areaSqKm: 0.4,
      frp: 10,
      growthAcresPerHour: 0,
      growthFrpPerHour: 0,
      growthScore: 0,
      hotspotCount: 3,
      evidence: (opts.modalities ?? ["satellite-thermal", "dispatch"]).map((m) => ({
        source: m === "dispatch" ? "cad" : "viirs",
        modality: m as never,
        count: 1,
        contribution: 0.5,
        effective: 0.5,
        firstSeen: "2026-10-20T12:00:00Z",
        lastSeen: "2026-10-20T18:00:00Z",
      })),
      lat,
      lon,
    },
  };
}

describe("window", () => {
  const fx = manifest.window;
  const w = makeWindow(fx.center[0], fx.center[1]);

  it("corners match the reference", () => {
    const got = windowCorners(w);
    for (const k of ["nw", "ne", "se", "sw"] as const) {
      expect(got[k][0]).toBeCloseTo(fx.corners[k][0], 9);
      expect(got[k][1]).toBeCloseTo(fx.corners[k][1], 9);
    }
  });

  it("cell centres match the reference", () => {
    for (const [r, c, lon, lat] of fx.cellCenters as number[][]) {
      const [gl, ga] = cellLonLat(w, r!, c!);
      expect(gl).toBeCloseTo(lon!, 9);
      expect(ga).toBeCloseTo(lat!, 9);
    }
  });

  it("fire mask matches the reference", () => {
    const now = Date.parse("2026-10-20T19:00:00Z");
    const hs = (fx.hotspots as number[][]).map(([lon, lat]) => hotspot(lon!, lat!));
    const inc = incident("mask", fx.center[0], fx.center[1]);
    const { mask } = buildFireMask({ window: w, incident: inc, ownHotspots: hs, windowHotspots: hs, officials: [], now });
    const expected = bin(fx.mask.file, Uint8Array);
    expect(Array.from(mask)).toEqual(Array.from(expected));
    expect(mask.reduce((a, b) => a + b, 0)).toBe(fx.burningCells);
  });

  it("checks CONUS against an outline with stray points and lines", () => {
    const outline = {
      type: "GeometryCollection" as const,
      geometries: [
        { type: "Point" as const, coordinates: [-100, 40] },
        { type: "LineString" as const, coordinates: [[-100, 40], [-99, 41]] },
        { type: "Polygon" as const, coordinates: [[[-120, 35], [-110, 35], [-110, 45], [-120, 45], [-120, 35]]] },
      ],
    };
    expect(insideConus(-115, 40, outline)).toBe(true);
    expect(insideConus(-100, 40, outline)).toBe(false);
    expect(insideConus(-150, 61, outline)).toBe(false);
  });

  it("uses only viirs/modis from the last 24 h", () => {
    const now = Date.parse("2026-10-20T19:00:00Z");
    const [lon0, lat0] = fx.center as [number, number];
    const hs = [
      hotspot(lon0, lat0, "goes18"),
      hotspot(lon0, lat0, "modis", "2026-10-19T12:00:00Z"), // 31 h old
    ];
    const inc = incident("old", lon0, lat0);
    const { mask } = buildFireMask({ window: w, incident: inc, ownHotspots: [], windowHotspots: hs, officials: [], now });
    expect(mask.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("fills official perimeters only when a thermal detection confirms them", () => {
    const now = Date.parse("2026-10-20T19:00:00Z");
    const [lon0, lat0] = fx.center as [number, number];
    const official = incident("off", lon0 + 0.15, lat0, { kind: "official", halfKm: 4 });
    const count = (hs: HotspotFeature[]) =>
      buildFireMask({ window: w, incident: incident("x", lon0, lat0), ownHotspots: [], windowHotspots: hs, officials: [official], now })
        .mask.reduce((a, b) => a + b, 0);
    expect(count([])).toBe(0);
    expect(count([hotspot(lon0 + 0.15, lat0)])).toBeGreaterThan(40); // ~8x8 km perimeter
  });
});

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

describe("summary", () => {
  const fx = manifest.summary;
  const fire = bin(fx.fire.file, Uint8Array);
  const scores = bin(fx.scores.file, Float32Array);

  for (const [k, c] of (fx.cases as { name: string; expected: Record<string, unknown> }[]).entries()) {
    it(`matches the reference: ${c.name}`, () => {
      const s = summarize(scores.subarray(k * WIN * WIN, (k + 1) * WIN * WIN), fire, fire, fx.threshold);
      const e = c.expected;
      expect(s.cellsToday).toBe(e.cellsToday);
      expect(s.cellsTomorrow).toBe(e.cellsTomorrow);
      expect(s.newCells).toBe(e.newCells);
      expect(s.direction).toBe(e.direction ?? null);
      expect(s.bearing).toBe(e.bearing ?? null);
      expect(s.km).toBeCloseTo(e.km as number, 6);
      expect(s.text).toBe(e.text);
      expect(s.level).toBe(e.level);
    });
  }

  it("covers all 8 compass directions", () => {
    const dirs = (fx.cases as { expected: { direction: string | null } }[]).map((c) => c.expected.direction);
    for (const d of ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]) {
      expect(dirs).toContain(d);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Static layers                                                        */
/* ------------------------------------------------------------------ */

describe("static layers", () => {
  // One 1-degree synthetic tile: elevation = 100 * col, NDVI nodata in the
  // top-left corner, population encoded log1p.
  const dir = mkdtempSync(join(tmpdir(), "fp-static-"));
  const size = 12;
  const res = 0.1;
  const n = size * size;
  const elev = new Int16Array(n);
  const ndvi = new Int16Array(n);
  const pop = new Uint16Array(n);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      elev[r * size + c] = 100 * c;
      ndvi[r * size + c] = r < 3 && c < 3 ? -32768 : 5000;
      pop[r * size + c] = Math.round(Math.log1p(250) * 4000);
    }
  }
  mkdirSync(join(dir, "tiles"));
  writeFileSync(
    join(dir, "tiles", "t.bin.gz"),
    gzipSync(Buffer.concat([Buffer.from(elev.buffer), Buffer.from(ndvi.buffer), Buffer.from(pop.buffer)])),
  );
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({
      version: 1,
      tileDeg: 1,
      res,
      width: size,
      height: size,
      bands: [
        { name: "elevation", dtype: "int16", encoding: "linear", scale: 1, offset: 0, nodata: -32768 },
        { name: "NDVI", dtype: "int16", encoding: "linear", scale: 1, offset: 0, nodata: -32768 },
        { name: "population", dtype: "uint16", encoding: "log1p", scale: 1 / 4000, offset: 0, nodata: 65535 },
      ],
      tiles: [{ id: "t", west: -118, south: 34, east: -117, north: 35, file: "tiles/t.bin.gz" }],
    }),
  );
  const layers = new StaticLayers(dir, 2);

  it("samples bilinearly between pixel centres", async () => {
    // col = (lon - west) / res + 0.5 -> lon -117.75 is col 3.0, -117.7 is col 3.5
    const s = await layers.sample([-117.75, -117.7], [34.5, 34.5]);
    expect(s.elevation[0]).toBeCloseTo(300, 4);
    expect(s.elevation[1]).toBeCloseTo(350, 4);
  });

  it("decodes log1p population", async () => {
    const s = await layers.sample([-117.5], [34.5]);
    expect(s.population[0]).toBeCloseTo(250, 0);
  });

  it("returns NaN for no data and for points outside every tile", async () => {
    const s = await layers.sample([-117.99, -100], [34.99, 40]);
    expect(Number.isNaN(s.NDVI[0])).toBe(true);
    expect(Number.isNaN(s.elevation[1])).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

const NOW = Date.parse("2026-10-20T19:00:00Z");
const LON = -117.29;
const LAT = 34.19;

const META: ModelMeta = { name: "FireSight U-Net", run: "test", threshold: 0.12, testAucPr: 0.357, channels: [...CHANNELS] };

class FakeModel implements Predictor {
  readonly meta = META;
  calls = 0;
  inputs: Float32Array[] = [];
  gate: Promise<void> | null = null;

  async predict(raw: Float32Array): Promise<Float32Array> {
    this.calls++;
    this.inputs.push(raw);
    if (this.gate) await this.gate;
    // Growth blob 7 km east of the window centre.
    const out = new Float32Array(WIN * WIN);
    for (let r = 0; r < WIN; r++) {
      for (let c = 0; c < WIN; c++) {
        out[r * WIN + c] = 0.8 * Math.exp(-((r - 31.5) ** 2 + (c - 38.5) ** 2) / 20);
      }
    }
    return out;
  }
}

const CSV = {
  erc: `time,latitude,longitude,daily_mean_energy_release_component-g[unit="Unitless"]\n2026-10-19T00:00:00Z,34.2,-117.3,40.0\n`,
  pdsi: `time,latitude,longitude,daily_mean_palmer_drought_severity_index[unit=""]\n2026-10-12T00:00:00Z,34.2,-117.3,1392.0\n`,
};

function makeFetch(overrides: { openMeteo?: number; thredds?: number } = {}) {
  const calls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes("open-meteo")) {
      return overrides.openMeteo
        ? new Response("down", { status: overrides.openMeteo })
        : new Response(JSON.stringify(openMeteo), { status: 200 });
    }
    if (url.includes("thredds")) {
      if (overrides.thredds) return new Response("down", { status: overrides.thredds });
      return new Response(url.includes("erc") ? CSV.erc : CSV.pdsi, { status: 200 });
    }
    if (url.includes("weather.gov")) return new Response(JSON.stringify({ features: [{ id: "rfw" }] }), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

const SETTINGS: SpreadSettings = {
  minConfidence: 40,
  maxConcurrent: 2,
  queueLimit: 20,
  timeoutMs: 5_000,
  cacheTtlMs: 3_600_000,
  openMeteoPerMinute: 300,
  httpTimeoutMs: 1_000,
  userAgent: "FirePulse test",
  retryBaseMs: 1,
};

function setup(opts: {
  incidents?: IncidentFeature[];
  hotspots?: HotspotFeature[];
  population?: number;
  fetch?: ReturnType<typeof makeFetch>;
  settings?: Partial<SpreadSettings>;
  simulated?: boolean;
} = {}) {
  const incidents = opts.incidents ?? [incident("fire", LON, LAT)];
  const hotspots = opts.hotspots ?? [hotspot(LON, LAT), hotspot(LON + 0.01, LAT), hotspot(LON, LAT + 0.01, "modis")];
  const model = new FakeModel();
  const http = opts.fetch ?? makeFetch();
  const service = new SpreadService({
    predictor: model,
    statics: {
      getIndex: async () => ({}),
      sample: async (lons) => ({
        elevation: new Float32Array(lons.length).fill(500),
        NDVI: new Float32Array(lons.length).fill(5000),
        population: new Float32Array(lons.length).fill(opts.population ?? 12),
      }),
    },
    incidents: {
      incident: (id) => incidents.find((f) => f.id === id) ?? null,
      allIncidents: () => incidents,
    },
    hotspots: {
      snapshot: (bbox, from, to) =>
        hotspots.filter((h) => {
          const [lon, lat] = h.geometry.coordinates;
          const t = Date.parse(h.properties.observedAt);
          return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3] && t >= from && t <= to;
        }),
    },
    fetch: http.fetch,
    settings: { ...SETTINGS, ...opts.settings },
    simulated: opts.simulated ?? false,
    now: () => NOW,
  });
  return { service, model, http };
}

describe("spread service", () => {
  it("returns null for an unknown incident", async () => {
    expect(await setup().service.forecast("nope")).toBeNull();
  });

  it("no thermal detections -> unavailable", async () => {
    const { service, model } = setup({ hotspots: [hotspot(LON, LAT, "goes18"), hotspot(LON, LAT, "cad" as SourceId)] });
    const f = await service.forecast("fire");
    expect(f).toMatchObject({ status: "unavailable", reason: REASONS.noThermal });
    expect(model.calls).toBe(0);
  });

  it("low-confidence estimate -> unavailable", async () => {
    const { service } = setup({ incidents: [incident("fire", LON, LAT, { confidence: 30 })] });
    expect(await service.forecast("fire")).toMatchObject({ status: "unavailable", reason: REASONS.lowConfidence });
  });

  it("outside CONUS -> unavailable", async () => {
    const { service } = setup({
      incidents: [incident("fire", -150, 61)],
      hotspots: [hotspot(-150, 61)],
    });
    expect(await service.forecast("fire")).toMatchObject({ status: "unavailable", reason: REASONS.outsideConus });
  });

  it("unconfirmed thermal-only heat in a dense city -> unavailable", async () => {
    const { service, model } = setup({
      incidents: [incident("fire", LON, LAT, { modalities: ["satellite-thermal", "air-quality"] })],
      population: 3000,
    });
    expect(await service.forecast("fire")).toMatchObject({ status: "unavailable", reason: REASONS.industrial });
    expect(model.calls).toBe(0);
  });

  it("a corroborated fire in a city still gets a forecast", async () => {
    const { service } = setup({ population: 3000 });
    expect((await service.forecast("fire"))?.status).toBe("ready");
  });

  it("happy path -> ready", async () => {
    const { service, model, http } = setup();
    const f = await service.forecast("fire");
    expect(f?.status).toBe("ready");
    expect(f?.summary?.direction).toBe("east");
    expect(f?.summary?.text).toBe("The model leans toward growth to the east.");
    expect(f?.weather?.redFlag).toBe(true);
    expect(f?.weather?.erc).toBe(40);
    expect(f?.weather?.pdsi).toBeCloseTo(-1.1, 6);
    expect(f?.missingInputs).toEqual([]);
    expect(f?.demo).toBe(false);
    expect(f?.threshold).toBe(0.12);
    expect(f?.model).toEqual({ name: "FireSight U-Net", run: "test", testAucPr: 0.357 });
    expect(Date.parse(f!.validFor!) - Date.parse(f!.generatedAt!)).toBe(24 * 3_600_000);
    // Cells: everything >= threshold / 2, plus burning cells.
    expect(f!.cells!.every((c) => c.score >= 0.06 || c.burning)).toBe(true);
    expect(f!.cells!.some((c) => c.burning)).toBe(true);
    expect(f!.cells![0]!.ring).toHaveLength(5);
    // One Open-Meteo request for all 16 points.
    expect(http.calls.filter((u) => u.includes("open-meteo"))).toHaveLength(1);
    // Inputs: raw channels, packed PDSI unpacked, fire mask set.
    const raw = model.inputs[0]!;
    const ch = (name: (typeof CHANNELS)[number]) => raw.subarray(CHANNELS.indexOf(name) * 4096, (CHANNELS.indexOf(name) + 1) * 4096);
    expect(ch("erc")[0]).toBe(40);
    expect(ch("pdsi")[0]).toBeCloseTo(-1.08, 5);
    expect(ch("fire_today").reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2);
    expect(ch("tmmx")[0]).toBeGreaterThan(250);
  });

  it("flags simulator fires as demo", async () => {
    const { service } = setup({ simulated: true });
    expect((await service.forecast("fire"))?.demo).toBe(true);
  });

  it("serves repeat requests from cache", async () => {
    const { service, model, http } = setup();
    const a = await service.forecast("fire");
    const before = http.calls.length;
    const b = await service.forecast("fire");
    expect(b).toEqual(a);
    expect(model.calls).toBe(1);
    expect(http.calls.length).toBe(before);
  });

  it("dedupes identical in-flight requests", async () => {
    const { service, model } = setup();
    const [a, b] = await Promise.all([service.forecast("fire"), service.forecast("fire")]);
    expect(a?.status).toBe("ready");
    expect(b).toEqual(a);
    expect(model.calls).toBe(1);
  });

  it("queues beyond max concurrency and rejects beyond the queue", async () => {
    const fires = ["a", "b", "c"].map((id, i) => incident(id, LON + i * 0.5, LAT));
    const hs = fires.map((f) => hotspot(f.properties.lon, f.properties.lat));
    const { service, model } = setup({ incidents: fires, hotspots: hs, settings: { maxConcurrent: 1, queueLimit: 1 } });
    let release!: () => void;
    model.gate = new Promise((r) => (release = r));
    const a = service.forecast("a");
    const b = service.forecast("b");
    await new Promise((r) => setTimeout(r, 20));
    expect(service.status()).toMatchObject({ running: 1, queued: 1 });
    expect(await service.forecast("c")).toMatchObject({ status: "unavailable", reason: REASONS.busy });
    release();
    expect((await a)?.status).toBe("ready");
    expect((await b)?.status).toBe("ready");
    expect(model.calls).toBe(2);
  });

  it("times out slow forecasts", async () => {
    const { service, model } = setup({ settings: { timeoutMs: 30 } });
    model.gate = new Promise(() => undefined);
    expect(await service.forecast("fire")).toMatchObject({ status: "unavailable", reason: REASONS.timeout });
  });

  it("enforces the global Open-Meteo budget", async () => {
    const fires = ["a", "b"].map((id, i) => incident(id, LON + i * 0.5, LAT));
    const hs = fires.map((f) => hotspot(f.properties.lon, f.properties.lat));
    const { service } = setup({ incidents: fires, hotspots: hs, settings: { openMeteoPerMinute: 20 } });
    expect((await service.forecast("a"))?.status).toBe("ready");
    expect(await service.forecast("b")).toMatchObject({ status: "unavailable", reason: REASONS.busy });
  });

  it("Open-Meteo 500 -> unavailable after retries, and is not cached", async () => {
    const http = makeFetch({ openMeteo: 500 });
    const { service, model } = setup({ fetch: http });
    expect(await service.forecast("fire")).toMatchObject({ status: "unavailable", reason: REASONS.noWeather });
    expect(http.calls.filter((u) => u.includes("open-meteo"))).toHaveLength(4);
    expect(model.calls).toBe(0);
    expect(service.status().cached).toBe(0);
  });

  it("THREDDS down -> ready with missing inputs", async () => {
    const { service, model } = setup({ fetch: makeFetch({ thredds: 503 }) });
    const f = await service.forecast("fire");
    expect(f?.status).toBe("ready");
    expect(f?.missingInputs).toEqual(["fuel dryness (ERC)", "drought index"]);
    expect(f?.weather?.erc).toBeNull();
    const raw = model.inputs[0]!;
    expect(Number.isNaN(raw[CHANNELS.indexOf("erc") * 4096])).toBe(true);
    expect(Number.isNaN(raw[CHANNELS.indexOf("pdsi") * 4096])).toBe(true);
  });
});
