import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { PathStyleExtension } from "@deck.gl/extensions";
import { gridDisk, latLngToCell } from "h3-js";
import type { HotspotFeature, IncidentFeature } from "@firepulse/protocol";
import { ageBucket } from "./select";

/* ------------------------------------------------------------------ */
/* Thermal hotspots                                                     */
/* ------------------------------------------------------------------ */

export const AGE_COLORS = {
  fresh: [255, 236, 176] as [number, number, number],
  recent: [255, 148, 58] as [number, number, number],
  old: [198, 52, 32] as [number, number, number],
  stale: [116, 44, 42] as [number, number, number],
};

export const AGE_ALPHA = { fresh: 245, recent: 225, old: 195, stale: 120 };

interface PickableProps {
  pickItems?: HotspotFeature[];
}

/** ScatterplotLayer subclass that maps a picking index back to its feature. */
class PickableHotspots extends ScatterplotLayer<HotspotFeature, PickableProps> {
  static layerName = "PickableHotspots";

  getPickingInfo({
    info,
  }: {
    info: { index: number } & Record<string, unknown>;
  }) {
    const items = this.props.pickItems;
    const object = items && info.index >= 0 ? items[info.index] : null;
    return { ...info, object } as never;
  }
}

export function hotspotLayers(opts: {
  items: HotspotFeature[];
  now: number;
  visible: boolean;
  intensity: number;
}) {
  const { items, now, visible, intensity } = opts;
  const opaque = 0.55 + intensity * 0.45;

  return [
    new PickableHotspots({
      id: "hotspot-glow",
      data: items,
      pickable: false,
      filled: true,
      stroked: false,
      radiusUnits: "pixels",
      radiusScale: 1.65,
      opacity: 0.13 * opaque,
      getPosition: (h: HotspotFeature) => h.geometry.coordinates as [number, number],
      getRadius: (h: HotspotFeature) => hotspotRadius(h.properties.frp),
      // warm ember halo, independent of the hotspot's own age colour
      getFillColor: [255, 122, 40, 150] as [number, number, number, number],
      parameters: {
        blend: true,
        blendColorOperation: "add",
        blendColorSrcFactor: "src-alpha",
        blendColorDstFactor: "one",
      } as never,
      visible,
      updateTriggers: { getFillColor: now, getRadius: now },
    }),
    new PickableHotspots({
      id: "hotspot-core",
      data: items,
      pickable: true,
      filled: true,
      stroked: false,
      radiusUnits: "pixels",
      radiusMinPixels: 1.1,
      radiusMaxPixels: 4.2,
      opacity: opaque,
      antialiasing: true,
      getPosition: (h: HotspotFeature) => h.geometry.coordinates as [number, number],
      getRadius: (h: HotspotFeature) => hotspotRadius(h.properties.frp),
      getFillColor: (h: HotspotFeature) => hotspotColor(h, now),
      pickItems: items,
      visible,
    }),
  ] as never[];
}

/**
 * Screen-space radius, deliberately in pixels: a 500 MW pixel should not
 * cover a county when the user zooms in. Size still encodes FRP.
 */
export function hotspotRadius(frp: number): number {
  return Math.min(3.8, 1.1 + Math.sqrt(Math.max(0, frp)) * 0.25);
}

export function hotspotColor(
  h: HotspotFeature,
  now: number,
): [number, number, number, number] {
  const bucket = ageBucket(now - Date.parse(h.properties.observedAt));
  const c = AGE_COLORS[bucket];
  return [c[0], c[1], c[2], AGE_ALPHA[bucket]];
}

/* ------------------------------------------------------------------ */
/* Perimeters                                                          */
/* ------------------------------------------------------------------ */

const dashExtension = new PathStyleExtension({ dash: true });

export function estimatedZoneLayer(
  incidents: IncidentFeature[],
  pulse: number,
  visible: boolean,
) {
  const alpha = Math.round(120 + pulse * 110);
  return new PolygonLayer<IncidentFeature>({
    id: "estimated-zones",
    data: incidents,
    visible,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 55],
    filled: true,
    getPolygon: (f: IncidentFeature) => f.geometry.coordinates[0] ?? [],
    getFillColor: [255, 152, 40, 52],
    stroked: false,
  });
}

/** Dashed, pulsing perimeter for estimates — visually distinct from surveyed lines. */
export function estimatedOutlineLayer(
  incidents: IncidentFeature[],
  pulse: number,
  visible: boolean,
) {
  const alpha = Math.round(130 + pulse * 115);
  return new PathLayer<IncidentFeature>({
    // PathStyleExtension augments props at runtime; deck's generic types do
    // not include getDashArray on PathLayer, hence the cast.
    id: "estimated-outline",
    data: incidents,
    visible,
    pickable: false,
    getPath: (f: IncidentFeature) => f.geometry.coordinates[0] ?? [],
    getColor: [255, 186, 55, alpha],
    widthUnits: "pixels",
    getWidth: 2.2,
    widthMinPixels: 1.4,
    widthMaxPixels: 3,
    jointRounded: true,
    capRounded: true,
    getDashArray: [6, 4],
    extensions: [dashExtension],
    updateTriggers: { getColor: alpha },
  } as never);
}

/** Pulsing halo around estimated centroids — the "algorithmic, not surveyed" cue. */
export function estimatePulseLayer(
  incidents: IncidentFeature[],
  pulse: number,
  visible: boolean,
) {
  return new ScatterplotLayer<IncidentFeature>({
    id: "estimate-halo",
    data: incidents,
    visible,
    pickable: false,
    getPosition: (f) => [f.properties.lon, f.properties.lat],
    getRadius: (f) => 900 + f.properties.areaSqKm * 240,
    radiusUnits: "meters",
    // Keep the "algorithmic" ring visible even when the zone is sub-pixel,
    // so estimates never look like plain surveyed points at regional zoom.
    radiusMinPixels: 11,
    radiusMaxPixels: 120,
    filled: true,
    stroked: true,
    getFillColor: [255, 176, 32, 0] as [number, number, number, number],
    getLineColor: [255, 176, 32, Math.round(38 + pulse * 60)] as [number, number, number, number],
    lineWidthUnits: "pixels",
    getLineWidth: 1.2,
    opacity: 1,
    updateTriggers: { getLineColor: Math.round(pulse * 20) },
  });
}

export function incidentMarkerLayer(
  incidents: IncidentFeature[],
  kind: "estimated" | "official",
  visible: boolean,
) {
  return new ScatterplotLayer<IncidentFeature>({
    id: `marker-${kind}`,
    data: incidents.filter((f) => f.properties.kind === kind),
    visible,
    pickable: true,
    radiusUnits: "pixels",
    getRadius: kind === "official" ? 5 : 6,
    radiusMinPixels: 4,
    radiusMaxPixels: 9,
    getPosition: (f) => [f.properties.lon, f.properties.lat],
    getFillColor: kind === "official" ? [255, 69, 58, 240] : [255, 176, 32, 240],
    stroked: true,
    getLineColor: kind === "official" ? [255, 225, 220, 235] : [255, 245, 214, 235],
    lineWidthUnits: "pixels",
    getLineWidth: 1.3,
    opacity: 0.98,
  });
}

export function selectedOutlineLayer(incident: IncidentFeature | null) {
  return new PathLayer<IncidentFeature>({
    id: "selected-outline",
    data: incident ? [incident] : [],
    getPath: (f) => f.geometry.coordinates[0] ?? [],
    widthUnits: "pixels",
    getWidth: 2.4,
    getColor: [255, 255, 255, 225],
    jointRounded: true,
    capRounded: true,
    pickable: false,
  });
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

export function incidentLabelLayer(
  incidents: IncidentFeature[],
  opts: { selectedId: string | null; zoom: number; visible: boolean },
) {
  const { selectedId, zoom, visible } = opts;
  const ranked = [...incidents].sort((a, b) => {
    if (a.id === selectedId) return -1;
    if (b.id === selectedId) return 1;
    const kindDelta = (b.properties.kind === "official" ? 1 : 0) - (a.properties.kind === "official" ? 1 : 0);
    return kindDelta !== 0 ? kindDelta : b.properties.confidence - a.properties.confidence;
  });

  // Greedy collision avoidance in geographic space: labels are ~95 px wide,
  // so reject any candidate closer than that at the current zoom.
  const degPerPx = 360 / (512 * 2 ** zoom);
  const sepDeg = degPerPx * 105;
  const kept: IncidentFeature[] = [];
  for (const f of ranked) {
    if (f.id !== selectedId) {
      const p = f.properties;
      const collides = kept.some((k) => {
        const q = k.properties;
        const dLon = Math.abs(q.lon - p.lon) * Math.cos((p.lat * Math.PI) / 180);
        const dLat = Math.abs(q.lat - p.lat);
        return dLon < sepDeg && dLat < sepDeg * 0.55;
      });
      if (collides) continue;
      if (kept.length >= (zoom >= 6.2 ? 16 : 9)) continue;
    }
    kept.push(f);
  }
  const data = kept;

  return new TextLayer<IncidentFeature>({
    id: "incident-labels",
    data,
    visible,
    pickable: false,
    getPosition: (f) => [f.properties.lon, f.properties.lat],
    getText: (f) => {
      const p = f.properties;
      return p.kind === "official" ? p.name : `${p.name}`;
    },
    getColor: (f) => (f.properties.kind === "official" ? [255, 220, 215, 240] : [255, 226, 172, 235]),
    getSize: (f) => (f.id === selectedId ? 12.5 : 10.5),
    sizeUnits: "pixels",
    getPixelOffset: (f) => {
      // Lift the label just above the polygon rather than its centroid.
      const p = f.properties;
      const mPerPx = (156543 * Math.max(0.2, Math.cos((p.lat * Math.PI) / 180))) / 2 ** zoom;
      const radiusPx = ((Math.sqrt(Math.max(0.02, p.areaSqKm) / Math.PI) * 1000) / Math.max(0.5, mPerPx)) * 0.9;
      return [0, -(17 + Math.min(90, radiusPx))];
    },
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontWeight: 600,
    characterSet: "auto",
    background: true,
    getBackgroundColor: (f) =>
      f.properties.kind === "official" ? [42, 12, 10, 225] : [34, 24, 8, 222],
    getBorderColor: (f) =>
      f.properties.kind === "official" ? [255, 69, 58, 150] : [255, 176, 32, 150],
    getBorderWidth: 1,
    backgroundPadding: [7, 3, 7, 3],
    billboard: true,
    fontSettings: { sdf: true, buffer: 8, radius: 5 },
    outlineWidth: 0,
  });
}

/* ------------------------------------------------------------------ */
/* H3 density                                                          */
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
    // Official features do not carry H3 cells (they come from surveyed
    // geometry), so synthesize the cell + 1-ring from the centroid.
    const cells =
      p.cells && p.cells.length > 0
        ? p.cells
        : gridDisk(latLngToCell(p.lat, p.lon, 8), 1);
    for (const hex of cells) {
      const existing = map.get(hex);
      if (!existing) {
        map.set(hex, { hex, confidence: f.properties.confidence, kind: f.properties.kind });
      } else {
        existing.confidence = Math.max(existing.confidence, f.properties.confidence);
        if (f.properties.kind === "official") existing.kind = "official";
      }
    }
  }
  return [...map.values()];
}

export function h3Layer(hexes: HexDatum[], visible: boolean) {
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
      d.kind === "official"
        ? [255, 69, 58, 40]
        : [255, 176, 32, Math.round(26 + (d.confidence / 100) * 86)],
    getLineColor: (d) => (d.kind === "official" ? [255, 110, 100, 150] : [255, 196, 92, 165]),
    lineWidthUnits: "pixels",
    getLineWidth: 1.1,
    opacity: 0.9,
  });
}
