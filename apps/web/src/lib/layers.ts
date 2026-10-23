import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { PathStyleExtension } from "@deck.gl/extensions";
import { gridDisk, latLngToCell } from "h3-js";
import {
  circleRing,
  SPREAD_BANDS,
  type HazardAlertFeature,
  type HazardEvent,
  type HotspotFeature,
  type IncidentFeature,
  type Ring,
  type SpreadCell,
  type SpreadForecast,
} from "@firepulse/protocol";
import { ageBucket } from "./select";
import { hazardTier, type HazardTier } from "./format";
import type { MapTheme, MapType } from "./places";

/* ------------------------------------------------------------------ */
/* Thermal hotspots                                                     */
/* ------------------------------------------------------------------ */

type RGBA = [number, number, number, number];

/** deck.gl only accepts numeric RGBA; MapLibre paint accepts CSS strings. */
export function rgba(color: string, fallbackAlpha = 255): RGBA {
  const value = color.trim();
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const full =
      hex.length === 3
        ? hex.split("").map((c) => c + c).join("")
        : hex.length === 8
          ? hex.slice(0, 6)
          : hex;
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : fallbackAlpha;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      a,
    ];
  }
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(",").map((p) => Number(p.trim()));
    return [
      parts[0] ?? 0,
      parts[1] ?? 0,
      parts[2] ?? 0,
      Math.round((parts[3] ?? 1) * 255),
    ];
  }
  return [17, 17, 17, fallbackAlpha];
}

interface Ramp {
  fresh: [number, number, number];
  recent: [number, number, number];
  old: [number, number, number];
  stale: [number, number, number];
  alpha: { fresh: number; recent: number; old: number; stale: number };
}

const LIGHT_RAMP: Ramp = {
  fresh: [255, 79, 0],
  recent: [163, 63, 11],
  old: [122, 115, 104],
  stale: [207, 200, 188],
  alpha: { fresh: 245, recent: 230, old: 200, stale: 140 },
};

const DARK_RAMP: Ramp = {
  fresh: [255, 106, 43],
  recent: [194, 65, 12],
  old: [138, 90, 59],
  stale: [90, 74, 64],
  alpha: { fresh: 245, recent: 220, old: 190, stale: 120 },
};

function rampFor(mapType: MapType): Ramp {
  return mapType === "atlas" || mapType === "topo" ? LIGHT_RAMP : DARK_RAMP;
}

export function thermalColor(h: HotspotFeature, now: number, mapType: MapType): RGBA {
  const ramp = rampFor(mapType);
  const bucket = ageBucket(now - Date.parse(h.properties.observedAt));
  const c = ramp[bucket];
  return [c[0], c[1], c[2], ramp.alpha[bucket]];
}

export function thermalSwatches(mapType: MapType): { label: string; color: string }[] {
  const ramp = rampFor(mapType);
  return [
    { label: "< 1h", color: `rgb(${ramp.fresh.join(",")})` },
    { label: "1–6h", color: `rgb(${ramp.recent.join(",")})` },
    { label: "6–24h", color: `rgb(${ramp.old.join(",")})` },
    { label: "> 24h", color: `rgb(${ramp.stale.join(",")})` },
  ];
}

export function hotspotRadius(frp: number): number {
  return Math.min(3, 0.85 + Math.sqrt(Math.max(0, frp)) * 0.17);
}

interface PickableProps {
  pickItems?: HotspotFeature[];
}

class PickableHotspots extends ScatterplotLayer<HotspotFeature, PickableProps> {
  static layerName = "PickableHotspots";

  getPickingInfo({ info }: { info: { index: number } & Record<string, unknown> }) {
    const items = this.props.pickItems;
    const object = items && info.index >= 0 ? items[info.index] : null;
    return { ...info, object } as never;
  }
}

export function hotspotLayers(opts: {
  items: HotspotFeature[];
  now: number;
  visible: boolean;
  mapType: MapType;
  theme: MapTheme;
}) {
  const { items, now, visible, mapType, theme } = opts;

  return [
    new PickableHotspots({
      id: "hotspot-core",
      data: items,
      pickable: true,
      filled: true,
      stroked: true,
      radiusUnits: "pixels",
      radiusMinPixels: 0.9,
      radiusMaxPixels: 3.2,
      lineWidthUnits: "pixels",
      getLineWidth: 0.4,
      opacity: 0.92,
      antialiasing: true,
      getPosition: (h: HotspotFeature) => h.geometry.coordinates as [number, number],
      getRadius: (h: HotspotFeature) => hotspotRadius(h.properties.frp),
      getFillColor: (h: HotspotFeature) => thermalColor(h, now, mapType),
      getLineColor: rgba(theme.markerStroke),
      pickItems: items,
      visible,
    }),
  ] as never[];
}

/* ------------------------------------------------------------------ */
/* Perimeters                                                          */
/* ------------------------------------------------------------------ */

const dashExtension = new PathStyleExtension({ dash: true });

/** Single-pass satellite heat is usually a farm or industrial burn: drawn faint, never pulsing. */
function unconfirmed(f: IncidentFeature): boolean {
  return f.properties.kind === "estimated" && f.properties.confirmation === "single";
}

function withAlpha(color: RGBA, alpha: number): RGBA {
  return [color[0], color[1], color[2], alpha];
}

export function estimatedZoneLayer(
  incidents: IncidentFeature[],
  visible: boolean,
  theme: MapTheme,
) {
  return new PolygonLayer<IncidentFeature>({
    id: "estimated-zones",
    data: incidents,
    visible,
    pickable: true,
    filled: true,
    getPolygon: (f: IncidentFeature) => f.geometry.coordinates[0] ?? [],
    getFillColor: (f: IncidentFeature) => {
      const fill = rgba(theme.estimatedFill);
      return unconfirmed(f) ? withAlpha(fill, Math.round(fill[3] * 0.4)) : fill;
    },
    stroked: false,
    updateTriggers: { getFillColor: theme.estimatedFill },
  });
}

/** Pale casing under the dashed boundary keeps it legible on every basemap. */
export function estimatedCasingLayer(
  incidents: IncidentFeature[],
  visible: boolean,
  theme: MapTheme,
) {
  return new PathLayer<IncidentFeature>({
    id: "estimated-casing",
    data: incidents,
    visible,
    pickable: false,
    getPath: (f: IncidentFeature) => f.geometry.coordinates[0] ?? [],
    getColor: rgba(theme.estimatedCasing),
    widthUnits: "pixels",
    getWidth: 3,
    widthMinPixels: 2.4,
    jointRounded: false,
    capRounded: false,
    opacity: 0.9,
  });
}

export function estimatedOutlineLayer(
  incidents: IncidentFeature[],
  pulse: number,
  visible: boolean,
  theme: MapTheme,
) {
  return new PathLayer<IncidentFeature>({
    id: "estimated-outline",
    data: incidents,
    visible,
    pickable: false,
    getPath: (f: IncidentFeature) => f.geometry.coordinates[0] ?? [],
    getColor: (f: IncidentFeature) =>
      withAlpha(rgba(theme.estimated), unconfirmed(f) ? 90 : 150 + Math.round(pulse * 90)),
    widthUnits: "pixels",
    getWidth: 1.4,
    widthMinPixels: 1.1,
    jointRounded: false,
    capRounded: false,
    getDashArray: [5, 3],
    extensions: [dashExtension],
    updateTriggers: { getColor: [Math.round(pulse * 10), theme.estimated] },
  } as never);
}

export function markerLayer(
  incidents: IncidentFeature[],
  visible: boolean,
  theme: MapTheme,
  kind: "estimated" | "official",
) {
  const estimated = kind === "estimated";
  return new ScatterplotLayer<IncidentFeature>({
    id: `marker-${kind}`,
    data: incidents.filter((f) => f.properties.kind === kind),
    visible,
    pickable: true,
    radiusUnits: "pixels",
    radiusMinPixels: 2.8,
    radiusMaxPixels: 6,
    getRadius: (f: IncidentFeature) => (unconfirmed(f) ? 2.6 : estimated ? 4 : 3.4),
    // Estimates are rings; official points are filled. This keeps the
    // provisional marker distinguishable from a thermal speck at any zoom.
    filled: !estimated,
    stroked: true,
    getLineColor: (f: IncidentFeature) =>
      unconfirmed(f) ? withAlpha(rgba(theme.estimated), 70) : rgba(estimated ? theme.estimated : theme.markerStroke),
    lineWidthUnits: "pixels",
    getLineWidth: (f: IncidentFeature) => (unconfirmed(f) ? 1 : estimated ? 1.6 : 1.2),
    getPosition: (f: IncidentFeature) => [f.properties.lon, f.properties.lat],
    getFillColor: rgba(theme.official),
  });
}

export function officialPickLayer(incidents: IncidentFeature[], visible: boolean) {
  return new PolygonLayer<IncidentFeature>({
    id: "official-pick",
    data: visible ? incidents : [],
    pickable: true,
    getPolygon: (f: IncidentFeature) => f.geometry.coordinates[0] ?? [],
    filled: true,
    getFillColor: [0, 0, 0, 1],
    stroked: false,
  });
}

export function selectedOutlineLayer(incident: IncidentFeature | null, theme: MapTheme) {
  return new PathLayer<IncidentFeature>({
    id: "selected-outline",
    data: incident ? [incident] : [],
    getPath: (f: IncidentFeature) => f.geometry.coordinates[0] ?? [],
    widthUnits: "pixels",
    getWidth: 1.6,
    widthMinPixels: 1.4,
    getColor: rgba(theme.labelText),
    jointRounded: false,
    capRounded: false,
    pickable: false,
  });
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

export function incidentLabelLayer(
  incidents: IncidentFeature[],
  opts: { selectedId: string | null; zoom: number; visible: boolean; theme: MapTheme },
) {
  const { selectedId, zoom, visible, theme } = opts;

  // Unconfirmed satellite heat is too common to label; it's named when selected.
  const ranked = incidents.filter((f) => f.id === selectedId || !unconfirmed(f)).sort((a, b) => {
    if (a.id === selectedId) return -1;
    if (b.id === selectedId) return 1;
    const kindDelta =
      (b.properties.kind === "official" ? 1 : 0) - (a.properties.kind === "official" ? 1 : 0);
    return kindDelta !== 0 ? kindDelta : b.properties.confidence - a.properties.confidence;
  });

  const degPerPx = 360 / (512 * 2 ** zoom);
  const sepDeg = degPerPx * 118;
  const kept: IncidentFeature[] = [];
  for (const f of ranked) {
    if (f.id !== selectedId) {
      const p = f.properties;
      const collides = kept.some((k) => {
        const q = k.properties;
        const dLon = Math.abs(q.lon - p.lon) * Math.cos((p.lat * Math.PI) / 180);
        const dLat = Math.abs(q.lat - p.lat);
        return dLon < sepDeg && dLat < sepDeg * 0.5;
      });
      if (collides) continue;
      if (kept.length >= (zoom >= 6.2 ? 14 : 8)) continue;
    }
    kept.push(f);
  }

  return new TextLayer<IncidentFeature>({
    id: "incident-labels",
    data: kept,
    visible,
    pickable: false,
    getPosition: (f: IncidentFeature) => {
      const ring = f.geometry.coordinates[0] ?? [];
      let maxLat = f.properties.lat;
      for (const [, lat] of ring) if (lat > maxLat) maxLat = lat;
      return [f.properties.lon, maxLat];
    },
    getText: (f: IncidentFeature) => f.properties.name,
    getColor: rgba(theme.labelText),
    getSize: (f) => (f.id === selectedId ? 12 : 10.5),
    sizeUnits: "pixels",
    getPixelOffset: (f) => [0, f.id === selectedId ? -16 : -12],
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontWeight: 600,
    characterSet: "auto",
    background: false,
    billboard: true,
    fontSettings: { sdf: true, buffer: 8, radius: 5 },
    outlineWidth: 2.2,
    outlineColor: rgba(theme.labelOutline, 230),
  });
}

/* ------------------------------------------------------------------ */
/* H3                                                                  */
/* ------------------------------------------------------------------ */

export interface HexDatum {
  hex: string;
  confidence: number;
  kind: "estimated" | "official";
}

export function buildHexData(incidents: IncidentFeature[]): HexDatum[] {
  const map = new Map<string, HexDatum>();
  for (const f of incidents) {
    const p = f.properties;
    const cells =
      p.cells && p.cells.length > 0 ? p.cells : gridDisk(latLngToCell(p.lat, p.lon, 8), 1);
    for (const hex of cells) {
      const existing = map.get(hex);
      if (!existing) {
        map.set(hex, { hex, confidence: p.confidence, kind: p.kind });
      } else {
        existing.confidence = Math.max(existing.confidence, p.confidence);
        if (p.kind === "official") existing.kind = "official";
      }
    }
  }
  return [...map.values()];
}

export function h3Layer(hexes: HexDatum[], visible: boolean, theme: MapTheme) {
  return new H3HexagonLayer<HexDatum>({
    id: "h3-density",
    data: hexes,
    visible,
    pickable: false,
    extruded: false,
    filled: true,
    stroked: true,
    getHexagon: (d) => d.hex,
    getFillColor: (d) =>
      rgba(d.kind === "official" ? theme.officialFill : theme.estimatedFill),
    getLineColor: (d) =>
      rgba(d.kind === "official" ? theme.official : theme.estimated),
    lineWidthUnits: "pixels",
    getLineWidth: 0.7,
    opacity: 0.85,
  });
}

/* ------------------------------------------------------------------ */
/* Next-day spread                                                     */
/* ------------------------------------------------------------------ */

export type SpreadBand = "faint" | "likely" | "veryLikely";

export function spreadBand(score: number): SpreadBand | null {
  if (score >= SPREAD_BANDS.veryLikely) return "veryLikely";
  if (score >= SPREAD_BANDS.likely) return "likely";
  if (score >= SPREAD_BANDS.faint) return "faint";
  return null;
}

/**
 * Bands reuse the thermal ramp (ember -> deep red) at 35-70 % opacity, so
 * the forecast reads as "more fire" without introducing a new accent.
 */
export function spreadColors(mapType: MapType): Record<SpreadBand, RGBA> {
  const ramp = rampFor(mapType);
  const mid: [number, number, number] = [
    Math.round((ramp.fresh[0] + ramp.recent[0]) / 2),
    Math.round((ramp.fresh[1] + ramp.recent[1]) / 2),
    Math.round((ramp.fresh[2] + ramp.recent[2]) / 2),
  ];
  return {
    faint: [...ramp.fresh, Math.round(0.35 * 255)],
    likely: [...mid, Math.round(0.52 * 255)],
    veryLikely: [...ramp.recent, Math.round(0.7 * 255)],
  };
}

export function spreadSwatches(mapType: MapType): { band: SpreadBand; label: string; color: string }[] {
  const c = spreadColors(mapType);
  const css = (v: RGBA) => `rgba(${v[0]}, ${v[1]}, ${v[2]}, ${(v[3] / 255).toFixed(2)})`;
  return [
    { band: "veryLikely", label: "Very likely", color: css(c.veryLikely) },
    { band: "likely", label: "Likely", color: css(c.likely) },
    { band: "faint", label: "Faint", color: css(c.faint) },
  ];
}

export function spreadLayers(
  forecast: SpreadForecast | null,
  visible: boolean,
  mapType: MapType,
  theme: MapTheme,
) {
  const ready = visible && forecast?.status === "ready" ? forecast : null;
  const colors = spreadColors(mapType);
  const cells = (ready?.cells ?? []).filter((c) => spreadBand(c.score) !== null);
  const corners = ready?.corners;
  const outline = corners ? [[corners.nw, corners.ne, corners.se, corners.sw, corners.nw]] : [];
  return [
    new PolygonLayer<SpreadCell>({
      id: "spread-cells",
      data: cells,
      pickable: false,
      filled: true,
      stroked: false,
      getPolygon: (c) => c.ring,
      getFillColor: (c) => colors[spreadBand(c.score) ?? "faint"],
      updateTriggers: { getFillColor: mapType },
    }),
    new PathLayer<[number, number][]>({
      id: "spread-window",
      data: outline,
      pickable: false,
      getPath: (d: [number, number][]) => d,
      getColor: rgba(theme.wind, 170),
      widthUnits: "pixels",
      getWidth: 1,
      widthMinPixels: 1,
      jointRounded: false,
      capRounded: false,
      getDashArray: [4, 4],
      extensions: [dashExtension],
    } as never),
  ];
}

/* ------------------------------------------------------------------ */
/* Hazard alerts (NWS)                                                  */
/* ------------------------------------------------------------------ */


/** Same hues as --danger / --warn; brighter on the dark plates. */
function hazardColor(tier: HazardTier, mapType: MapType): string {
  const dark = mapType === "ink" || mapType === "sat";
  if (tier === "act") return dark ? "#f87171" : "#b91c1c";
  if (tier === "weather") return dark ? "#f59e0b" : "#b45309";
  return dark ? "#a3a3a3" : "#6b6b6b";
}

interface HazardOutline {
  path: Ring;
  tier: HazardTier;
}

interface HazardPolygon {
  id: string;
  event: HazardEvent;
  tier: HazardTier;
  rings: Ring[];
}

function hazardPolygons(alerts: HazardAlertFeature[]): HazardPolygon[] {
  const out: HazardPolygon[] = [];
  for (const a of alerts) {
    const polygons = a.geometry.type === "Polygon" ? [a.geometry.coordinates] : a.geometry.coordinates;
    polygons.forEach((rings, i) => out.push({ id: `${a.id}:${i}`, event: a.properties.event, tier: hazardTier(a.properties.event), rings }));
  }
  // Draw conditions first so evacuation areas sit on top.
  const order: Record<HazardTier, number> = { smoke: 0, weather: 1, act: 2 };
  return out.sort((x, y) => order[x.tier] - order[y.tier]);
}

export function hazardLayers(alerts: HazardAlertFeature[], visible: boolean, mapType: MapType) {
  const data = visible ? hazardPolygons(alerts) : [];
  return [
    new PolygonLayer<HazardPolygon>({
      id: "hazard-fill",
      data,
      pickable: false,
      filled: true,
      stroked: false,
      getPolygon: (d) => d.rings,
      getFillColor: (d) => rgba(hazardColor(d.tier, mapType), d.tier === "act" ? 34 : 14),
      updateTriggers: { getFillColor: mapType },
    }),
    new PathLayer<HazardOutline>({
      id: "hazard-outline",
      data: data.flatMap((d) => d.rings.slice(0, 1).map((path) => ({ path, tier: d.tier }))),
      pickable: false,
      getPath: (d: HazardOutline) => d.path,
      getColor: (d: HazardOutline) => rgba(hazardColor(d.tier, mapType), d.tier === "act" ? 230 : 170),
      widthUnits: "pixels",
      getWidth: (d: HazardOutline) => (d.tier === "act" ? 1.6 : 1),
      // Conditions are dashed; areas told to act are solid.
      getDashArray: (d: HazardOutline) => (d.tier === "act" ? [0, 0] : [5, 3]),
      extensions: [dashExtension],
      updateTriggers: { getColor: mapType },
    } as never),
  ];
}

/* ------------------------------------------------------------------ */
/* Watched places                                                       */
/* ------------------------------------------------------------------ */

export interface MapPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusKm: number;
}

export function placeLayers(places: MapPlace[], theme: MapTheme) {
  return [
    new PathLayer<{ path: Ring }>({
      id: "place-radius",
      data: places.map((p) => ({ path: circleRing(p, p.radiusKm, 72) })),
      pickable: false,
      getPath: (d: { path: Ring }) => d.path,
      getColor: rgba(theme.labelText, 150),
      widthUnits: "pixels",
      getWidth: 1,
      getDashArray: [2, 3],
      extensions: [dashExtension],
    } as never),
    new ScatterplotLayer<MapPlace>({
      id: "place-marker",
      data: places,
      pickable: false,
      getPosition: (p) => [p.lon, p.lat],
      getRadius: 4.5,
      radiusUnits: "pixels",
      stroked: true,
      getFillColor: rgba(theme.labelBg, 255),
      getLineColor: rgba(theme.labelText, 255),
      lineWidthUnits: "pixels",
      getLineWidth: 1.5,
    }),
    new TextLayer<MapPlace>({
      id: "place-label",
      data: places,
      pickable: false,
      getPosition: (p) => [p.lon, p.lat],
      getText: (p) => p.name,
      getSize: 10,
      getColor: rgba(theme.labelText, 255),
      getPixelOffset: [0, -14],
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontWeight: 600,
      characterSet: "auto",
      outlineWidth: 1.2,
      outlineColor: rgba(theme.labelOutline, 220),
      fontSettings: { sdf: true, buffer: 6, radius: 4 },
    }),
  ];
}
