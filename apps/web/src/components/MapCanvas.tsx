"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type maplibregl from "maplibre-gl";
import type { HotspotFeature, IncidentFeature, WindField } from "@firepulse/protocol";
import { basemapStyle, CITY_LABELS, STATE_LABELS } from "@/lib/places";
import {
  buildHexData,
  estimatePulseLayer,
  estimatedOutlineLayer,
  estimatedZoneLayer,
  h3Layer,
  hotspotLayers,
  incidentLabelLayer,
  incidentMarkerLayer,
  selectedOutlineLayer,
} from "@/lib/layers";
import { formatAcres, formatAge, formatMw, sourceMeta } from "@/lib/format";
import WindParticles from "./WindParticles";

export interface LayerFlags {
  official: boolean;
  estimated: boolean;
  thermal: boolean;
  wind: boolean;
  hex: boolean;
  labels: boolean;
}

interface Props {
  incidents: IncidentFeature[];
  hotspots: HotspotFeature[];
  wind: WindField | null;
  selectedId: string | null;
  cursor: number | null;
  layers: LayerFlags;
  focusNonce: number;
  onSelect: (id: string | null) => void;
  onViewport: (bbox: [number, number, number, number], zoom: number) => void;
}

const CONUS_CENTER: [number, number] = [-119.6, 37.6];
const CONUS_ZOOM = 4.85;

async function makeHatch(): Promise<ImageBitmap | null> {
  const size = 18;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(255, 92, 78, 0.7)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-4, size + 4);
  ctx.lineTo(size + 4, -4);
  ctx.moveTo(-4, 4);
  ctx.lineTo(4, -4);
  ctx.moveTo(size - 4, size + 4);
  ctx.lineTo(size + 4, size - 4);
  ctx.stroke();
  try {
    return await createImageBitmap(canvas);
  } catch {
    return null;
  }
}

export default function MapCanvas({
  incidents,
  hotspots,
  wind,
  selectedId,
  cursor,
  layers,
  focusNonce,
  onSelect,
  onViewport,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [zoom, setZoom] = useState(CONUS_ZOOM);
  const [pulse, setPulse] = useState(0.5);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    incident?: IncidentFeature;
    hotspot?: HotspotFeature;
  } | null>(null);

  const interactionRef = useRef({ onSelect, onViewport });
  interactionRef.current = { onSelect, onViewport };

  /* ----------------------------- pulse clock ---------------------------- */
  useEffect(() => {
    if (!layers.estimated) return;
    const started = performance.now();
    const timer = window.setInterval(() => {
      const t = performance.now() - started;
      setPulse(Math.round((0.5 + 0.5 * Math.sin(t / 760)) * 100) / 100);
    }, 90);
    return () => window.clearInterval(timer);
  }, [layers.estimated]);

  /* ----------------------------- map bootstrap -------------------------- */
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      const { Protocol } = await import("pmtiles");

      try {
        maplibregl.addProtocol("pmtiles", new Protocol().tile);
      } catch {
        /* already registered by a previous mount */
      }

      if (cancelled || !containerRef.current) return;

      const map = new maplibregl.Map({
        container: containerRef.current,
        style: basemapStyle() as never,
        center: CONUS_CENTER,
        zoom: CONUS_ZOOM,
        minZoom: 3,
        maxZoom: 15,
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        attributionControl: false,
        fadeDuration: 120,
      });
      mapRef.current = map;
      if (new URLSearchParams(window.location.search).has("debug")) {
        (window as unknown as { __fpMap?: maplibregl.Map }).__fpMap = map;
      }

      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

      map.on("load", async () => {
        if (cancelled) return;

        const hatch = await makeHatch();
        if (hatch && !map.hasImage("official-hatch")) {
          map.addImage("official-hatch", hatch, { pixelRatio: 2 });
        }

        map.addSource("official-perimeters", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "official-base",
          type: "fill",
          source: "official-perimeters",
          paint: { "fill-color": "#ff453a", "fill-opacity": 0.06 },
        });
        map.addLayer({
          id: "official-fill",
          type: "fill",
          source: "official-perimeters",
          paint: {
            "fill-pattern": "official-hatch",
            "fill-opacity": 0.55,
          },
        });
        map.addLayer({
          id: "official-glow",
          type: "line",
          source: "official-perimeters",
          paint: {
            "line-color": "#ff453a",
            "line-width": 8,
            "line-opacity": 0.18,
            "line-blur": 6,
          },
        });
        map.addLayer({
          id: "official-line",
          type: "line",
          source: "official-perimeters",
          paint: {
            "line-color": "#ff5147",
            "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.4, 9, 2.6],
            "line-opacity": 0.95,
          },
        });

        setMap(map);
        setZoom(map.getZoom());

        const emitViewport = () => {
          const b = map.getBounds();
          interactionRef.current.onViewport(
            [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
            map.getZoom(),
          );
        };
        emitViewport();
        let timer: number | null = null;
        map.on("moveend", () => {
          setZoom(map.getZoom());
          if (timer) window.clearTimeout(timer);
          timer = window.setTimeout(emitViewport, 400);
        });

        map.on("error", (e) => {
          const msg = String((e as { error?: Error }).error?.message ?? e);
          if (!msg.includes("AbortError")) console.warn("[firepulse map]", msg);
        });
      });

      cleanup = () => {
        map.remove();
        mapRef.current = null;
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  /* --------------------------- official GeoJSON ------------------------- */
  const officialFeatures = useMemo(
    () =>
      incidents
        .filter((f) => f.properties.kind === "official")
        .map((f) => ({
          type: "Feature" as const,
          id: f.id,
          properties: { id: f.id, name: f.properties.name },
          geometry: f.geometry,
        })),
    [incidents],
  );

  useEffect(() => {
    const src = mapRef.current?.getSource("official-perimeters") as
      | { setData?: (data: unknown) => void }
      | undefined;
    src?.setData?.({ type: "FeatureCollection", features: officialFeatures });
  }, [officialFeatures, map]);

  useEffect(() => {
    const m = mapRef.current;
    if (!m || !m.getLayer("official-fill")) return;
    const visibility = layers.official ? "visible" : "none";
    for (const id of ["official-base", "official-fill", "official-glow", "official-line"]) {
      m.setLayoutProperty(id, "visibility", visibility);
    }
  }, [layers.official, map]);

  /* ------------------------------ deck layers --------------------------- */
  const estimated = useMemo(
    () => incidents.filter((f) => f.properties.kind === "estimated"),
    [incidents],
  );
  const official = useMemo(
    () => incidents.filter((f) => f.properties.kind === "official"),
    [incidents],
  );
  const hexes = useMemo(() => buildHexData(incidents), [incidents]);
  const selected = useMemo(
    () => incidents.find((f) => f.id === selectedId) ?? null,
    [incidents, selectedId],
  );

  const deckLayers = useMemo(() => {
    const pulseLayers = hotspotLayers({
      items: hotspots,
      now: cursor ?? Date.now(),
      visible: layers.thermal,
      intensity: 0.9,
    });

    return [
      // Invisible official polygons exist purely so deck can pick them
      // through the MapLibre hatch fill.
      new PolygonLayer<IncidentFeature>({
        id: "official-pick",
        data: layers.official ? official : [],
        pickable: true,
        getPolygon: (f) => f.geometry.coordinates[0] ?? [],
        filled: true,
        getFillColor: [0, 0, 0, 2],
        stroked: false,
      }),
      selectedOutlineLayer(selected),
      estimatedZoneLayer(layers.estimated ? estimated : [], pulse, layers.estimated),
      estimatedOutlineLayer(layers.estimated ? estimated : [], pulse, layers.estimated),
      estimatePulseLayer(layers.estimated ? estimated : [], pulse, layers.estimated),
      h3Layer(hexes, layers.hex),
      ...pulseLayers,
      new TextLayer({
        id: "state-labels",
        data: layers.labels ? STATE_LABELS.filter((s) => zoom >= s.minZoom) : [],
        pickable: false,
        getPosition: (d: (typeof STATE_LABELS)[number]) => [d.lon, d.lat],
        getText: (d: (typeof STATE_LABELS)[number]) => d.name,
        getSize: 9.5,
        getColor: [120, 138, 158, 96],
        fontFamily: "ui-monospace, Menlo, monospace",
        fontWeight: 600,
        characterSet: "auto",
        billboard: true,
        fontSettings: { sdf: true, buffer: 4, radius: 3 },
      }),
      new ScatterplotLayer({
        id: "city-dots",
        data: layers.labels ? CITY_LABELS.filter((c) => zoom >= c.minZoom) : [],
        pickable: false,
        getPosition: (d: (typeof CITY_LABELS)[number]) => [d.lon, d.lat],
        getRadius: 1.4,
        radiusUnits: "pixels",
        getFillColor: [150, 168, 190, 140],
      }),
      new TextLayer({
        id: "city-labels",
        data: layers.labels ? CITY_LABELS.filter((c) => zoom >= c.minZoom) : [],
        pickable: false,
        getPosition: (d: (typeof CITY_LABELS)[number]) => [d.lon, d.lat],
        getText: (d: (typeof CITY_LABELS)[number]) => d.name,
        getSize: 9.5,
        getColor: [142, 158, 178, 150],
        getPixelOffset: [0, 11],
        fontFamily: "ui-monospace, Menlo, monospace",
        characterSet: "auto",
        billboard: true,
        fontSettings: { sdf: true, buffer: 4, radius: 3 },
      }),
      incidentMarkerLayer(official, "official", layers.official),
      incidentMarkerLayer(estimated, "estimated", layers.estimated),
      incidentLabelLayer(incidents, {
        selectedId,
        zoom,
        visible: layers.labels,
      }),
    ];
  }, [
    hotspots,
    estimated,
    official,
    hexes,
    selected,
    selectedId,
    zoom,
    pulse,
    layers.thermal,
    layers.estimated,
    layers.hex,
    layers.labels,
    layers.official,
    incidents,
  ]);

  /* ------------------------------ overlay ------------------------------- */
  const handlersRef = useRef<{
    onSelect: (id: string | null) => void;
  }>({ onSelect });
  handlersRef.current.onSelect = onSelect;

  useEffect(() => {
    if (!map) return;
    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
      onClick: (info) => {
        const obj = info.object as
          | { properties?: { kind?: string; source?: string } ; id?: string }
          | null;
        if (obj?.properties?.kind && obj.id) {
          handlersRef.current.onSelect(obj.id);
        } else {
          handlersRef.current.onSelect(null);
        }
      },
      onHover: (info) => {
        if (!info.object || info.x == null || info.y == null) {
          setHover(null);
          return;
        }
        const obj = info.object as IncidentFeature | HotspotFeature;
        if (obj.type === "Feature" && "properties" in obj) {
          if ("kind" in obj.properties) {
            setHover({ x: info.x, y: info.y, incident: obj as IncidentFeature });
          } else {
            setHover({ x: info.x, y: info.y, hotspot: obj as HotspotFeature });
          }
        }
      },
      getCursor: ({ isHovering, isDragging }) =>
        isDragging ? "grabbing" : isHovering ? "pointer" : "grab",
    });
    map.addControl(overlay as never);
    overlayRef.current = overlay;
    if (new URLSearchParams(window.location.search).has("debug")) {
      (window as unknown as { __fpDeck?: unknown }).__fpDeck = overlay;
    }
    return () => {
      overlay.finalize();
      overlayRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    overlayRef.current?.setProps({ layers: deckLayers as never[] });
    if (new URLSearchParams(window.location.search).has("debug")) {
      (window as unknown as { __fpDebug?: unknown }).__fpDebug = {
        hotspots: hotspots.length,
        layers: deckLayers.map((l) => {
          const props = l.props as unknown as { visible?: boolean; data?: { length?: number } | unknown[] };
          const len = Array.isArray(props.data)
            ? props.data.length
            : (props.data as { length?: number } | undefined)?.length;
          return { id: l.id, visible: props.visible, len };
        }),
      };
    }
  }, [deckLayers, hotspots.length]);

  /* --------------------------- selection focus -------------------------- */
  useEffect(() => {
    if (!map || !selected || focusNonce === 0) return;
    const p = selected.properties;
    // Frame the fire by its actual footprint instead of a fixed zoom:
    // a 15-acre start and a 30 000-acre complex need very different scales.
    const sizeKm = 2 * Math.sqrt(Math.max(0.02, p.areaSqKm) / Math.PI);
    const cosLat = Math.cos((p.lat * Math.PI) / 180);
    const target = Math.log2((156543 * Math.max(0.2, cosLat) * 340) / (sizeKm * 1000));
    const zoom = Math.max(8, Math.min(14, Number.isFinite(target) ? target : 9));
    map.flyTo({
      center: [p.lon, p.lat],
      zoom,
      duration: 1100,
      essential: true,
      padding: { left: 320, right: 80, top: 80, bottom: 180 },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  const tooltip = hover ? (
    <div className="map-tooltip" style={{ left: hover.x, top: hover.y }}>
      {hover.incident ? (
        <div>
          <div className="kicker" style={{ color: "#8a94a6" }}>
            {hover.incident.properties.kind === "official" ? "OFFICIAL PERIMETER" : "EARLY ESTIMATE"}
          </div>
          <div style={{ fontWeight: 700, marginTop: 2 }}>{hover.incident.properties.name}</div>
          <div className="mono" style={{ color: "#a7b2c2", marginTop: 3, fontSize: 10 }}>
            {hover.incident.properties.confidence}% confidence ·{" "}
            {formatAcres(hover.incident.properties.areaAcres)} ·{" "}
            {hover.incident.properties.hotspotCount} hotspots
          </div>
        </div>
      ) : hover.hotspot ? (
        <div>
          <div className="kicker" style={{ color: sourceMeta(hover.hotspot.properties.source).color }}>
            {sourceMeta(hover.hotspot.properties.source).short}
          </div>
          <div className="mono" style={{ marginTop: 2, fontSize: 11 }}>
            {formatMw(hover.hotspot.properties.frp)} ·{" "}
            {formatAge(Date.now() - Date.parse(hover.hotspot.properties.observedAt))} old
          </div>
          <div style={{ color: "#8a94a6", fontSize: 10, marginTop: 2 }}>
            {hover.hotspot.properties.label ?? "thermal anomaly"}
          </div>
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div className="map-shell">
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      <WindParticles map={map} field={wind} enabled={layers.wind} />
      {tooltip}
      <MapVignette />
    </div>
  );
}

function MapVignette() {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        boxShadow: "inset 0 0 140px 6px rgba(0,0,0,0.24)",
        zIndex: 7,
      }}
    />
  );
}
