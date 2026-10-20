import {
  circleRing,
  destination,
  haversineKm,
  isoNoMs,
  km2ToAcres,
  ringAreaSqKm,
  SOURCE_PROFILES,
  type IncidentFeature,
  type RawSignal,
  type Ring,
  type WindField,
} from "@firepulse/protocol";
import {
  CONUS_BBOX,
  SIM_FIRES,
  WIND_COLS,
  WIND_ROWS,
  type SimFireDef,
} from "./geography.js";

/* ------------------------------------------------------------------ */
/* Deterministic RNG                                                    */
/* ------------------------------------------------------------------ */

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noise2(x: number, y: number, seed = 1): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const h = (a: number, b: number) => mulberry32(hashStr(`${a}:${b}:${seed}`))();
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface OfficialUpdate {
  feature: IncidentFeature;
  perimeter: {
    incidentId: string;
    geom: { type: "Polygon"; coordinates: number[][][] };
    acres: number;
    agency: string;
    publishedAt: string;
  };
}

/**
 * FireSimulation — deterministic, multi-tier synthetic feed.
 *
 * It exists so the entire pipeline (ingest → fuse → diff → WS) can be
 * exercised at production cadences without API keys: GOES scans every 5
 * minutes, VIIRS every 10, CAD dispatches a minute after ignition, and
 * government perimeters arrive 7–21 minutes late — exactly the latency
 * budget FirePulse is designed to beat.
 */
export class FireSimulation {
  readonly bootAt: number;
  private ignition = new Map<string, number>();
  private officialWritten = new Map<string, { at: number; revision: number; containment: number }>();
  private windCache: { validAt: string; field: WindField } | null = null;

  constructor(now = Date.now()) {
    this.bootAt = now;
    for (const def of SIM_FIRES) this.ignition.set(def.id, now + def.ignitionOffsetMin * MIN);
  }

  fireworks(): SimFireDef[] {
    return SIM_FIRES;
  }

  ignitionAt(id: string): number {
    return this.ignition.get(id) ?? this.bootAt;
  }

  /** All signals with observed_at in [from, to). */
  generate(from: number, to: number): RawSignal[] {
    const out: RawSignal[] = [];
    for (const def of SIM_FIRES) {
      const ignition = this.ignition.get(def.id)!;
      if (def.officialOnly) continue;
      if (to <= ignition) continue;
      const start = Math.max(from, ignition);
      this.thermal(def, ignition, start, to, out);
      this.dispatch(def, ignition, start, to, out);
      this.reports(def, ignition, start, to, out);
      this.context(def, ignition, start, to, out);
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Tier 2 — satellite thermal                                        */
  /* ---------------------------------------------------------------- */

  private thermal(
    def: SimFireDef,
    ignition: number,
    from: number,
    to: number,
    out: RawSignal[],
  ): void {
    const phases: { source: "goes18" | "goes16" | "viirs" | "modis"; period: number; offset: number }[] = [
      { source: def.lon < -114 ? "goes18" : "goes16", period: 5 * MIN, offset: hashStr(def.id) % (3 * MIN) },
      { source: "viirs", period: 10 * MIN, offset: 2 * MIN + (hashStr(def.id) % (5 * MIN)) },
      { source: "modis", period: 30 * MIN, offset: 7 * MIN + (hashStr(def.id) % (11 * MIN)) },
    ];
    for (const { source, period, offset } of phases) {
      const first = Math.ceil((from - offset) / period) * period + offset;
      for (let t = first; t < to; t += period) {
        if (t < ignition) continue;
        const elapsedMin = (t - ignition) / MIN;
        if (elapsedMin > 36 * 60) continue;
        const rnd = mulberry32(hashStr(`${def.id}:${source}:${t}`));
        const spread = this.spreadKm(def, elapsedMin);
        const pixels = 1 + Math.min(3, Math.floor(elapsedMin / 90) + (rnd() > 0.6 ? 1 : 0));
        for (let i = 0; i < pixels; i++) {
          const angle = def.heading + (rnd() - 0.5) * 120;
          // Satellite pixels must fall inside the fire's footprint, otherwise
          // they would legitimately seed a *second* zone beside the official one.
          const rel = ((angle - def.heading + 540) % 360) - 180;
          const elongation = 0.42 + 0.58 * (0.5 + 0.5 * Math.cos((rel * Math.PI) / 180));
          const footprint = this.officialRadiusKm(def, elapsedMin) * elongation * 0.9;
          const dist = Math.max(0.05, Math.min(spread, footprint) * (0.3 + rnd() * 0.65));
          const p = destination({ lon: def.lon, lat: def.lat }, angle, dist);
          const frp = Math.max(
            2.5,
            Math.min(
              1450,
              (source === "modis" ? 5 : source === "viirs" ? 3.5 : 8) +
                spread * 19 +
                elapsedMin * 0.08 +
                rnd() * 11,
            ),
          );
          const id = `${source}-${def.id}-${t}-${i}`;
          out.push({
            id,
            source,
            kind: "thermal",
            tier: 2,
            lon: p.lon,
            lat: p.lat,
            observedAt: isoNoMs(t),
            receivedAt: isoNoMs(Date.now()),
            frp: Math.round(frp * 10) / 10,
            providerConfidence: Math.round((0.55 + rnd() * 0.4) * 100) / 100,
            label: `${SOURCE_PROFILES[source].short} ${frp.toFixed(0)} MW`,
            meta: {
              dedupeKey: id,
              incidentName: def.name,
              county: def.county,
              state: def.state,
              sensor: source,
              scanMinutes: period / MIN,
            },
          });
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Tier 1 — dispatch, radio, public reports, cameras                 */
  /* ---------------------------------------------------------------- */

  private dispatch(
    def: SimFireDef,
    ignition: number,
    from: number,
    to: number,
    out: RawSignal[],
  ): void {
    const rnd = mulberry32(hashStr(`${def.id}:dispatch`));
    const offset = 1.2 * MIN + rnd() * 2.6 * MIN;
    const events: { t: number; kind: "cad" | "scanner"; label: string }[] = [
      { t: ignition + offset, kind: "cad", label: `VEGETATION FIRE - ${def.roads[0]}` },
      { t: ignition + offset + 40_000, kind: "scanner", label: `BC: "Responding to a vegetation fire, ${def.roads[1] ?? def.roads[0]}"` },
      { t: ignition + offset + 14 * MIN, kind: "cad", label: `VEG FIRE UPDATE - ${def.roads[0]} - 5+ ACRES, requesting air attack` },
      { t: ignition + offset + 46 * MIN, kind: "cad", label: `VEG FIRE UPDATE - ${def.roads[0]} - 20+ ACRES, evac advisories` },
    ];
    for (const ev of events) {
      if (ev.t < from || ev.t >= to || ev.t < ignition) continue;
      const id = `${ev.kind}-${def.id}-${ev.t}`;
      const jitter = (hashStr(id) % 1000) / 100_000;
      out.push({
        id,
        source: ev.kind,
        kind: "dispatch",
        tier: 1,
        lon: def.lon + jitter,
        lat: def.lat - jitter,
        observedAt: isoNoMs(ev.t),
        receivedAt: isoNoMs(Date.now()),
        providerConfidence: ev.kind === "cad" ? 0.85 : 0.65,
        label: ev.label,
        meta: {
          dedupeKey: id,
          incidentName: def.name,
          county: def.county,
          state: def.state,
          cause: def.cause,
          units: 3 + (hashStr(id) % 5),
          channel: ev.kind === "cad" ? `${def.county.toUpperCase()} CAD` : "Broadcastify AI",
        },
      });
    }
  }

  private reports(
    def: SimFireDef,
    ignition: number,
    from: number,
    to: number,
    out: RawSignal[],
  ): void {
    const rnd = mulberry32(hashStr(`${def.id}:reports`));
    const events = [
      { t: ignition + 2.4 * MIN + rnd() * MIN, verified: true, bearing: def.heading + 180 + rnd() * 20 },
      { t: ignition + 5.1 * MIN + rnd() * MIN, verified: false, bearing: def.heading + 180 },
      { t: ignition + 9.5 * MIN + rnd() * 4 * MIN, verified: true, bearing: def.heading + 195 },
    ];
    for (const ev of events) {
      if (ev.t < from || ev.t >= to || ev.t < ignition) continue;
      const distanceM = 900 + Math.round(rnd() * 2600);
      const observer = destination(
        { lon: def.lon, lat: def.lat },
        (ev.bearing + 180) % 360,
        distanceM / 1000,
      );
      const id = `crowd-${def.id}-${Math.round(ev.t / 1000)}`;
      out.push({
        id,
        source: "crowd",
        kind: "crowd",
        tier: 1,
        lon: observer.lon,
        lat: observer.lat,
        observedAt: isoNoMs(ev.t),
        receivedAt: isoNoMs(Date.now()),
        providerConfidence: ev.verified ? 0.82 : 0.45,
        bearing: Math.round((ev.bearing + 360) % 360),
        distanceM,
        label: ev.verified
          ? `Photo: heavy smoke column ${Math.round(distanceM / 100) / 10} km away`
          : "Smoke visible over the ridge",
        meta: {
          dedupeKey: id,
          incidentName: def.name,
          county: def.county,
          state: def.state,
          photo: ev.verified,
          device: "ios",
        },
      });
    }

    // ALERTCalifornia PTZ camera vector (CA/OR only)
    if (def.state === "CA" || def.state === "OR") {
      const t = ignition + 6.2 * MIN;
      if (t >= from && t < to && t >= ignition) {
        const observer = destination({ lon: def.lon, lat: def.lat }, (def.heading + 210) % 360, 7.8);
        const bearing = Math.round(
          (Math.atan2(
            (def.lon - observer.lon) * Math.cos((def.lat * Math.PI) / 180),
            def.lat - observer.lat,
          ) *
            180) /
            Math.PI +
            360,
        ) % 360;
        const id = `alertca-${def.id}-${Math.round(t / 1000)}`;
        out.push({
          id,
          source: "alertca",
          kind: "camera",
          tier: 1,
          lon: observer.lon,
          lat: observer.lat,
          observedAt: isoNoMs(t),
          receivedAt: isoNoMs(Date.now()),
          providerConfidence: 0.72,
          bearing,
          distanceM: 7800,
          label: `ALERTCA pan-tilt: smoke column detected (${def.landmark} cam)`,
          meta: {
            dedupeKey: id,
            incidentName: def.name,
            county: def.county,
            state: def.state,
            camera: `${def.landmark} 2`,
            algorithm: "smoke-cnn-v3",
          },
        });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Tier 3 — air quality + RAWS                                       */
  /* ---------------------------------------------------------------- */

  private context(
    def: SimFireDef,
    ignition: number,
    from: number,
    to: number,
    out: RawSignal[],
  ): void {
    const station = destination({ lon: def.lon, lat: def.lat }, def.heading, 1.7);
    const pmPeriod = 10 * MIN;
    const firstPm = Math.ceil((from - (ignition + 6 * MIN)) / pmPeriod) * pmPeriod + ignition + 6 * MIN;
    for (let t = firstPm; t < to; t += pmPeriod) {
      if (t < ignition + 6 * MIN) continue;
      const elapsed = (t - ignition) / MIN;
      const rnd = mulberry32(hashStr(`${def.id}:pm:${t}`));
      const pm = Math.round((18 + Math.min(340, elapsed * 1.9) + rnd() * 22) * 10) / 10;
      const id = `pa-${def.id}-${t}`;
      out.push({
        id,
        source: "purpleair",
        kind: "airquality",
        tier: 3,
        lon: station.lon + (rnd() - 0.5) * 0.004,
        lat: station.lat + (rnd() - 0.5) * 0.004,
        observedAt: isoNoMs(t),
        receivedAt: isoNoMs(Date.now()),
        providerConfidence: 0.7,
        label: `PM2.5 ${pm.toFixed(0)} µg/m³`,
        meta: {
          dedupeKey: id,
          incidentName: def.name,
          county: def.county,
          state: def.state,
          station: `${def.landmark} PA-II`,
          pm25: pm,
          downwind: true,
        },
      });
    }

    const rawsPeriod = 30 * MIN;
    const rawsStation = destination({ lon: def.lon, lat: def.lat }, (def.heading + 200) % 360, 3.4);
    const firstRaws = Math.ceil((from - ignition) / rawsPeriod) * rawsPeriod + ignition;
    for (let t = firstRaws; t < to; t += rawsPeriod) {
      if (t < ignition) continue;
      const rnd = mulberry32(hashStr(`${def.id}:raws:${t}`));
      const gust = 14 + rnd() * 22;
      const id = `raws-${def.id}-${t}`;
      out.push({
        id,
        source: "raws",
        kind: "weather",
        tier: 3,
        lon: rawsStation.lon,
        lat: rawsStation.lat,
        observedAt: isoNoMs(t),
        receivedAt: isoNoMs(Date.now()),
        providerConfidence: 0.85,
        label: `RAWS gust ${gust.toFixed(0)} mph, RH ${Math.round(12 + rnd() * 18)}%`,
        meta: {
          dedupeKey: id,
          incidentName: def.name,
          county: def.county,
          state: def.state,
          station: `${def.landmark} RAWS`,
          windMph: Math.round(gust * 0.7),
          gustMph: Math.round(gust),
          windDir: Math.round((def.heading + 180) % 360),
          rh: Math.round(12 + rnd() * 18),
          fuelMoisture: Math.round((4 + rnd() * 4) * 10) / 10,
        },
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Tier 4 — official ground truth                                    */
  /* ---------------------------------------------------------------- */

  /** Latest official state per fire whose publication falls in [from, to). */
  officialDue(from: number, to: number): OfficialUpdate[] {
    const out: OfficialUpdate[] = [];
    const now = to;
    for (const def of SIM_FIRES) {
      if (def.officialDelayMin == null) continue;
      const ignition = this.ignition.get(def.id)!;
      const publishedAt = ignition + def.officialDelayMin * MIN;
      if (publishedAt > now) continue;

      const existing = this.officialWritten.get(def.id);
      const elapsedMin = (now - ignition) / MIN;
      const revision = existing?.revision ?? 1;
      const lastRevisionAt = existing?.at ?? publishedAt;
      const dueRevision = now - lastRevisionAt >= 8 * MIN;
      if (existing && !dueRevision) continue;

      const radius = this.officialRadiusKm(def, elapsedMin);
      const ring = this.fireRing(def, radius, elapsedMin);
      const acres = Math.round(km2ToAcres(ringAreaSqKm(ring)));
      const containment = Math.min(88, Math.max(0, Math.round((elapsedMin - 20) / 22)));
      const nextRevision = existing ? revision + 1 : 1;
      this.officialWritten.set(def.id, { at: now, revision: nextRevision, containment });

      const id = `official-${def.id}`;
      const since = isoNoMs(publishedAt);
      const feature: IncidentFeature = {
        type: "Feature",
        id,
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: {
          id,
          kind: "official",
          name: def.name,
          status: containment > 65 ? "contained" : "holding",
          confidence: 100,
          confidenceBreakdown: {
            score: 100,
            fused: 1,
            corroboration: 1,
            freshness: 1,
            distinctModalities: 1,
            evidenceCount: 1,
            rationale: "Official government ground truth",
          },
          sources: [
            {
              source: "nifc",
              count: 1,
              lastSeen: since,
            },
          ],
          firstDetectedAt: isoNoMs(ignition),
          updatedAt: isoNoMs(now),
          areaAcres: acres,
          areaSqKm: Math.round(ringAreaSqKm(ring) * 100) / 100,
          frp: Math.round(40 + radius * 220),
          growthAcresPerHour: 0,
          growthFrpPerHour: 0,
          growthScore: 10,
          hotspotCount: 0,
          evidence: [],
          officialSince: since,
          containment,
          cause: def.cause,
          county: def.county,
          state: def.state,
          cells: [],
          lat: def.lat,
          lon: def.lon,
        },
      };
      out.push({
        feature,
        perimeter: {
          incidentId: id,
          geom: { type: "Polygon", coordinates: [ring] },
          acres,
          agency: def.state === "CA" ? "CAL FIRE" : "NIFC",
          publishedAt: since,
        },
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Wind field                                                        */
  /* ---------------------------------------------------------------- */

  windField(now: number): WindField {
    const validAt = isoNoMs(Math.floor(now / (10 * MIN)) * 10 * MIN);
    if (this.windCache && this.windCache.validAt === validAt) return this.windCache.field;

    const [minLon, minLat, maxLon, maxLat] = CONUS_BBOX;
    const hour = new Date(now).getUTCHours() + new Date(now).getUTCMinutes() / 60;
    const diurnal = 0.82 + 0.28 * Math.sin((hour / 24) * Math.PI * 2 - 1.1);
    const u: number[] = new Array(WIND_COLS * WIND_ROWS);
    const v: number[] = new Array(WIND_COLS * WIND_ROWS);
    let speedMax = 0;

    for (let r = 0; r < WIND_ROWS; r++) {
      const lat = maxLat - (r / (WIND_ROWS - 1)) * (maxLat - minLat);
      for (let c = 0; c < WIND_COLS; c++) {
        const lon = minLon + (c / (WIND_COLS - 1)) * (maxLon - minLon);
        // Prevailing westerly flow + synoptic eddies.
        const n1 = noise2(lon * 0.55, lat * 0.55, 7) - 0.5;
        const n2 = noise2(lon * 1.4 + 11, lat * 1.4 - 3, 13) - 0.5;
        let uu = (5.2 + n1 * 9 + n2 * 3.2) * diurnal;
        let vv = (0.9 + n1 * 5.5 - n2 * 2.4) * diurnal;

        // Offshore (Santa Ana) push across Southern California.
        const dLa = lat - 34.1;
        const dLo = lon + 118.3;
        const socal = Math.exp(-(dLa * dLa) / 9 - (dLo * dLo) / 22);
        uu -= socal * 8.5;
        vv -= socal * 2.2;

        // Diablo wind through the Bay Area / Sacramento corridor.
        const d2La = lat - 38.6;
        const d2Lo = lon + 122.1;
        const diablo = Math.exp(-(d2La * d2La) / 6 - (d2Lo * d2Lo) / 10);
        uu -= diablo * 4.4;
        vv += diablo * 3.1;

        // Afternoon upslope flow along the Rockies.
        if (lon > -113 && lon < -104) {
          const ridge = Math.exp(-Math.pow((lat - 39.5) / 6, 2));
          vv += ridge * 2.2;
        }

        const speed = Math.hypot(uu, vv);
        if (speed > speedMax) speedMax = speed;
        u[r * WIND_COLS + c] = Math.round(uu * 100) / 100;
        v[r * WIND_COLS + c] = Math.round(vv * 100) / 100;
      }
    }

    const field: WindField = {
      bbox: CONUS_BBOX,
      cols: WIND_COLS,
      rows: WIND_ROWS,
      u,
      v,
      speedMax: Math.round(speedMax * 10) / 10,
      validAt,
      model: "HRRR-sim",
    };
    this.windCache = { validAt, field };
    return field;
  }

  /** Fires whose ignition has just happened, for UI "new" badges. */
  recentlyIgnited(now: number, withinMin = 30): SimFireDef[] {
    return SIM_FIRES.filter((d) => {
      const ignite = this.ignition.get(d.id)!;
      return ignite <= now && now - ignite < withinMin * MIN;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Geometry helpers                                                  */
  /* ---------------------------------------------------------------- */

  private spreadKm(def: SimFireDef, elapsedMin: number): number {
    const head = (elapsedMin / 60) * def.spreadKmph;
    // Backing/flanking spread is slower than the head; use a bounded envelope.
    return Math.min(4.6, 0.12 + head * 0.72);
  }

  private officialRadiusKm(def: SimFireDef, elapsedMin: number): number {
    const head = (elapsedMin / 60) * def.spreadKmph;
    return Math.min(4.6, 0.16 + head * 0.82);
  }

  /** Organic teardrop polygon aligned with the spread heading. */
  private fireRing(def: SimFireDef, radiusKm: number, elapsedMin: number): Ring {
    const points = 44;
    const ring: Ring = [];
    for (let i = 0; i < points; i++) {
      const theta = (360 / points) * i;
      const rel = ((theta - def.heading + 540) % 360) - 180;
      const elongation = 0.42 + 0.58 * (0.5 + 0.5 * Math.cos((rel * Math.PI) / 180));
      const wobble =
        0.9 +
        0.14 * Math.sin((i / points) * Math.PI * 6 + elapsedMin * 0.05) +
        0.06 * Math.cos((i / points) * Math.PI * 10);
      const r = Math.max(0.05, radiusKm * elongation * wobble);
      const p = destination({ lon: def.lon, lat: def.lat }, theta, r);
      ring.push([Math.round(p.lon * 1e5) / 1e5, Math.round(p.lat * 1e5) / 1e5]);
    }
    ring.push(ring[0]!);
    return ring;
  }

  /** A small satellite false-positive, used to prove the scorer suppresses noise. */
  strayHotspots(now: number): RawSignal[] {
    const out: RawSignal[] = [];
    const bucket = Math.floor(now / (5 * MIN));
    const rnd = mulberry32(bucket * 7919);
    for (let i = 0; i < 3; i++) {
      const lon = -124 + rnd() * 40;
      const lat = 31 + rnd() * 12;
      const t = bucket * 5 * MIN;
      const id = `stray-${bucket}-${i}`;
      out.push({
        id,
        source: rnd() > 0.5 ? "goes18" : "modis",
        kind: "thermal",
        tier: 2,
        lon,
        lat,
        observedAt: isoNoMs(t),
        receivedAt: isoNoMs(Date.now()),
        frp: Math.round(rnd() * 22) / 10,
        providerConfidence: 0.4,
        label: "isolated thermal anomaly",
        meta: { dedupeKey: id, synthetic: true },
      });
    }
    return out;
  }

  /** Context: a Red Flag Warning polygon centroid is not needed; the client
   *  renders NWS alerts from the weather adapter. */
  redFlag(now: number, from: number, to: number): RawSignal[] {
    const t = Math.floor(from / HOUR) * HOUR;
    if (t < from || t >= to) return [];
    return [
      {
        id: `nws-rfw-${t}`,
        source: "nws",
        kind: "weather",
        tier: 3,
        lon: -119.7,
        lat: 34.4,
        observedAt: isoNoMs(t),
        receivedAt: isoNoMs(now),
        providerConfidence: 1,
        label: "Red Flag Warning — Los Angeles / Ventura interior",
        meta: { dedupeKey: `nws-rfw-${t}`, event: "Red Flag Warning", expires: isoNoMs(t + 12 * HOUR) },
      },
    ];
  }

  distanceToFire(def: SimFireDef, lon: number, lat: number): number {
    return haversineKm({ lon: def.lon, lat: def.lat }, { lon, lat });
  }

  /** Precomputed ring for a fire at a given wall clock, for scripts/tests. */
  ringFor(id: string, atMs: number): Ring {
    const def = SIM_FIRES.find((d) => d.id === id);
    if (!def) return circleRing({ lon: 0, lat: 0 }, 1);
    const ignition = this.ignition.get(id)!;
    return this.fireRing(def, this.officialRadiusKm(def, (atMs - ignition) / MIN), (atMs - ignition) / MIN);
  }
}
