"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type maplibregl from "maplibre-gl";
import type { HotspotFeature, IncidentFeature, SpreadForecast, WindField } from "@firepulse/protocol";
import {
  CITY_LABELS,
  MAP_THEMES,
  MAP_TYPES,
  STATE_LABELS,
  styleFor,
  type MapTheme,
  type MapType,
} from "@/lib/places";
import {
  buildHexData,
  estimatedCasingLayer,
  estimatedOutlineLayer,
  estimatedZoneLayer,
  h3Layer,
  hotspotLayers,
  incidentLabelLayer,
  markerLayer,
  officialPickLayer,
  rgba,
  selectedOutlineLayer,
  spreadLayers,
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
  spread: boolean;
}

interface Props {
  incidents: IncidentFeature[];
  hotspots: HotspotFeature[];
  wind: WindField | null;
  /** Forecast for the selected incident only. */
  spread: SpreadForecast | null;
  selectedId: string | null;
  cursor: number | null;
  layers: LayerFlags;
  mapType: MapType;
  focusNonce: number;
  onSelect: (id: string | null) => void;
  onViewport: (bbox: [number, number, number, number], zoom: number) => void;
}

const CONUS_CENTER: [number, number] = [-99.2, 38.3];
const CONUS_ZOOM = 4.0;

async function makeHatch(color: string): Promise<ImageBitmap | null> {
  const size = 18;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-5, size + 5);
  ctx.lineTo(size + 5, -5);
  ctx.moveTo(-5, 5);
  ctx.lineTo(5, -5);
  ctx.moveTo(size - 5, size + 5);
  ctx.lineTo(size + 5, size - 5);
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
  spread,
  selectedId,
  cursor,
  layers,
  mapType,
  focusNonce,
  onSelect,
  onViewport,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [zoom, setZoom] = useState(CONUS_ZOOM);
  const [pulse, setPulse] = useState(0.6);
  const [coords, setCoords] = useState<[number, number]>(CONUS_CENTER);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    incident?: IncidentFeature;
    hotspot?: HotspotFeature;
  } | null>(null);

  const theme: MapTheme = MAP_THEMES[mapType];
  const ink = mapType === "ink" || mapType === "sat";

  const interactionRef = useRef({ onSelect, onViewport });
  interactionRef.current = { onSelect, onViewport };

  const mapTypeRef = useRef(mapType);
  mapTypeRef.current = mapType;
  const mountedType = useRef<MapType>(mapType);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const officialRef = useRef<IncidentFeature[]>([]);
  const hatchRef = useRef<Record<string, ImageBitmap | null>>({});
  const installingRef = useRef(false);
  const installedThemeRef = useRef<MapType | null>(null);

  /* ----------------------------- subtle pulse -------------------------- */
  useEffect(() => {
    if (!layers.estimated) return;
    const started = performance.now();
    const timer = window.setInterval(() => {
      const t = performance.now() - started;
      setPulse(Math.round((0.5 + 0.5 * Math.sin(t / 900)) * 100) / 100);
    }, 120);
    return () => window.clearInterval(timer);
  }, [layers.estimated]);

  /* ----------------------------- official layers ------------------------ */
  const applyOfficialVisibility = useCallback((m: maplibregl.Map) => {
    const visibility = layersRef.current.official ? "visible" : "none";
    for (const id of ["official-base", "official-hatch-fill", "official-casing", "official-line"]) {
      if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", visibility);
    }
  }, []);

  const installOfficial = useCallback(
    (m: maplibregl.Map) => {
      if (installingRef.current) return;
      const type = mapTypeRef.current;
      const t = MAP_THEMES[type];
      if (!m.isStyleLoaded()) return;

      const alreadyInstalled =
        Boolean(m.getSource("official-perimeters")) && Boolean(m.getLayer("official-line"));
      if (alreadyInstalled && installedThemeRef.current === type) {
        applyOfficialVisibility(m);
        return;
      }

      installingRef.current = true;
      try {
        const hatchKey = `official-hatch-${type}`;
        const hatch = hatchRef.current[type];

        for (const id of [
          "official-base",
          "official-hatch-fill",
          "official-casing",
          "official-line",
        ]) {
          if (m.getLayer(id)) m.removeLayer(id);
        }
        if (m.getSource("official-perimeters")) m.removeSource("official-perimeters");

        if (!m.hasImage(hatchKey) && hatch) {
          m.addImage(hatchKey, hatch, { pixelRatio: 2 });
        }

        m.addSource("official-perimeters", {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: officialRef.current.map((f) => ({
              type: "Feature" as const,
              id: f.id,
              properties: { id: f.id, name: f.properties.name },
              geometry: f.geometry,
            })),
          },
        });

        m.addLayer({
          id: "official-base",
          type: "fill",
          source: "official-perimeters",
          paint: { "fill-color": t.officialFill, "fill-opacity": 1 },
        });
        m.addLayer({
          id: "official-hatch-fill",
          type: "fill",
          source: "official-perimeters",
          paint: { "fill-pattern": hatchKey, "fill-opacity": 0.55 },
        });
        m.addLayer({
          id: "official-casing",
          type: "line",
          source: "official-perimeters",
          paint: {
            "line-color": t.officialCasing,
            "line-width": ["interpolate", ["linear"], ["zoom"], 4, 3, 9, 4.2],
            "line-opacity": 0.92,
          },
        });
        m.addLayer({
          id: "official-line",
          type: "line",
          source: "official-perimeters",
          paint: {
            "line-color": t.official,
            "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.1, 9, 1.9],
            "line-opacity": 1,
          },
        });

        installedThemeRef.current = type;
        applyOfficialVisibility(m);
      } finally {
        installingRef.current = false;
      }
    },
    [applyOfficialVisibility],
  );

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
        /* already registered */
      }

      if (cancelled || !containerRef.current) return;

      // Pre-generate every hatch variant once. Installation then stays
      // synchronous, so a style swap can never race and drop the layers.
      const hatchEntries = await Promise.all(
        MAP_TYPES.map(async (t) => [t.id, await makeHatch(MAP_THEMES[t.id].officialHatch)] as const),
      );
      hatchRef.current = Object.fromEntries(hatchEntries);
      if (cancelled) return;

      const compact = window.innerWidth <= 900;
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: styleFor(mapTypeRef.current) as never,
        center: compact ? ([-119.7, 37.6] as [number, number]) : CONUS_CENTER,
        zoom: compact ? 4.55 : CONUS_ZOOM,
        minZoom: 3,
        maxZoom: 15,
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        attributionControl: false,
        fadeDuration: 100,
      });
      mapRef.current = map;

      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 80, unit: "imperial" }), "bottom-right");
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

      if (new URLSearchParams(window.location.search).has("debug")) {
        (window as unknown as { __fpMap?: maplibregl.Map }).__fpMap = map;
      }

      const emitViewport = () => {
        const b = map.getBounds();
        interactionRef.current.onViewport(
          [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
          map.getZoom(),
        );
      };

      map.on("style.load", () => {
        installOfficial(map);
      });

      // setStyle does not always emit style.load before the first frame.
      // styledata is guaranteed; guard on the layer's existence so repeated
      // data events do not rebuild the source.
      map.on("styledata", () => {
        if (!map.getLayer("official-line") || !map.getSource("official-perimeters")) {
          installOfficial(map);
        }
      });

      map.on("load", () => {
        if (cancelled) return;
        setMap(map);
        setZoom(map.getZoom());
        emitViewport();
        installOfficial(map);
      });

      let moveTimer: number | null = null;
      map.on("moveend", () => {
        setZoom(map.getZoom());
        if (moveTimer) window.clearTimeout(moveTimer);
        moveTimer = window.setTimeout(() => {
          emitViewport();
          const c = map.getCenter();
          setCoords([c.lng, c.lat]);
        }, 350);
      });

      let lastMove = 0;
      map.on("mousemove", (e) => {
        const now = performance.now();
        if (now - lastMove < 110) return;
        lastMove = now;
        setCoords([e.lngLat.lng, e.lngLat.lat]);
      });

      map.on("error", (e) => {
        const msg = String((e as { error?: Error }).error?.message ?? e);
        if (!msg.includes("AbortError") && !msg.includes("Failed to fetch")) {
          console.warn("[firepulse map]", msg);
        }
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
  }, [installOfficial]);

  /* ------------------------------ style swap ---------------------------- */
  useEffect(() => {
    if (!map) return;
    if (mountedType.current === mapType) return;
    mountedType.current = mapType;
    map.setStyle(styleFor(mapType) as never, { diff: false });
    map.once("idle", () => {
      if (!map.getLayer("official-line")) installOfficial(map);
    });
  }, [map, mapType, installOfficial]);

  const officialFeatures = useMemo(
    () => incidents.filter((f) => f.properties.kind === "official"),
    [incidents],
  );
  officialRef.current = officialFeatures;

  useEffect(() => {
    const src = map?.getSource("official-perimeters") as
      | { setData?: (data: unknown) => void }
      | undefined;
    if (!src?.setData) return;
    src.setData({
      type: "FeatureCollection",
      features: officialFeatures.map((f) => ({
        type: "Feature",
        id: f.id,
        properties: { id: f.id, name: f.properties.name },
        geometry: f.geometry,
      })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officialFeatures, map, mapType]);

  useEffect(() => {
    if (map) applyOfficialVisibility(map);
  }, [layers.official, map, mapType, applyOfficialVisibility]);

  /* -------------------------------- layers ------------------------------ */
  const estimated = useMemo(
    () => incidents.filter((f) => f.properties.kind === "estimated"),
    [incidents],
  );
  const hexes = useMemo(() => buildHexData(incidents), [incidents]);
  const selected = useMemo(
    () => incidents.find((f) => f.id === selectedId) ?? null,
    [incidents, selectedId],
  );

  const deckLayers = useMemo(() => {
    const now = cursor ?? Date.now();
    return [
      // Below every outline and hotspot.
      ...spreadLayers(spread, layers.spread, mapType, theme),
      officialPickLayer(officialFeatures, layers.official),
      selectedOutlineLayer(selected, theme),
      estimatedZoneLayer(layers.estimated ? estimated : [], layers.estimated, theme),
      estimatedCasingLayer(layers.estimated ? estimated : [], layers.estimated, theme),
      estimatedOutlineLayer(layers.estimated ? estimated : [], pulse, layers.estimated, theme),
      h3Layer(hexes, layers.hex, theme),
      markerLayer(officialFeatures, layers.official, theme, "official"),
      markerLayer(estimated, layers.estimated, theme, "estimated"),
      ...hotspotLayers({
        items: hotspots,
        now,
        visible: layers.thermal,
        mapType,
        theme,
      }),
      new TextLayer({
        id: "state-labels",
        data: layers.labels ? STATE_LABELS.filter((s) => zoom >= s.minZoom) : [],
        pickable: false,
        getPosition: (d: (typeof STATE_LABELS)[number]) => [d.lon, d.lat],
        getText: (d: (typeof STATE_LABELS)[number]) => d.name,
        getSize: 9.5,
        getColor: rgba(theme.stateLabel, Math.round(225 * theme.stateOpacity)),
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontWeight: 600,
        characterSet: "auto",
        billboard: true,
        outlineWidth: 1.1,
        outlineColor: rgba(theme.labelOutline, 200),
        fontSettings: { sdf: true, buffer: 6, radius: 4 },
      }),
      new ScatterplotLayer({
        id: "city-dots",
        data: layers.labels ? CITY_LABELS.filter((c) => zoom >= Math.max(c.minZoom, 6.2)) : [],
        pickable: false,
        getPosition: (d: (typeof CITY_LABELS)[number]) => [d.lon, d.lat],
        getRadius: 1.1,
        radiusUnits: "pixels",
        getFillColor: rgba(theme.cityLabel, Math.round(200 * theme.cityOpacity)),
      }),
      new TextLayer({
        id: "city-labels",
        data: layers.labels ? CITY_LABELS.filter((c) => zoom >= Math.max(c.minZoom, 6.2)) : [],
        pickable: false,
        getPosition: (d: (typeof CITY_LABELS)[number]) => [d.lon, d.lat],
        getText: (d: (typeof CITY_LABELS)[number]) => d.name,
        getSize: 9,
        getColor: rgba(theme.cityLabel, Math.round(215 * theme.cityOpacity)),
        getPixelOffset: [0, 10],
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontWeight: 600,
        characterSet: "auto",
        billboard: true,
        outlineWidth: 1.1,
        outlineColor: rgba(theme.labelOutline, 200),
        fontSettings: { sdf: true, buffer: 6, radius: 4 },
      }),
      incidentLabelLayer(incidents, {
        selectedId,
        zoom,
        visible: layers.labels,
        theme,
      }),
    ] as never[];
  }, [
    officialFeatures,
    estimated,
    hexes,
    selected,
    selectedId,
    zoom,
    pulse,
    cursor,
    hotspots,
    incidents,
    layers.official,
    layers.estimated,
    layers.thermal,
    layers.hex,
    layers.labels,
    layers.spread,
    spread,
    mapType,
    theme,
  ]);

  /* -------------------------------- overlay ----------------------------- */
  useEffect(() => {
    if (!map) return;
    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
      onClick: (info) => {
        const obj = info.object as
          | { properties?: { kind?: string; source?: string }; id?: string }
          | null;
        if (obj?.properties?.kind && obj.id) {
          interactionRef.current.onSelect(obj.id);
        } else {
          interactionRef.current.onSelect(null);
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
    overlayRef.current?.setProps({ layers: deckLayers });
  }, [deckLayers]);

  /* ---------------------------- selection focus ------------------------- */
  useEffect(() => {
    if (!map || !selected || focusNonce === 0) return;
    const p = selected.properties;
    const sizeKm = 2 * Math.sqrt(Math.max(0.02, p.areaSqKm) / Math.PI);
    const cosLat = Math.cos((p.lat * Math.PI) / 180);
    const target = Math.log2((156543 * Math.max(0.2, cosLat) * 240) / (sizeKm * 1000));
    const z = Math.max(8, Math.min(14, Number.isFinite(target) ? target : 9));
    map.flyTo({
      center: [p.lon, p.lat],
      zoom: z,
      duration: 1000,
      essential: true,
      padding: { left: 48, right: 48, top: 56, bottom: 72 },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  const mapName = MAP_TYPES.find((t) => t.id === mapType)?.name ?? "Atlas";
  const lat = coords[1];
  const lon = coords[0];

  return (
    <div className="map-shell">
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      <WindParticles map={map} field={wind} enabled={layers.wind} theme={theme} />
      <div className={`map-caption ${ink ? "theme-ink" : ""}`}>
        <span>{mapName}</span>
        <span className="sep" />
        <span className="coords">
          {Math.abs(lat).toFixed(2)}°{lat >= 0 ? "N" : "S"} {Math.abs(lon).toFixed(2)}°
          {lon >= 0 ? "E" : "W"}
        </span>
        <span className="sep" />
        <span>z{zoom.toFixed(1)}</span>
      </div>
      {hover ? (
        <div
          style={{
            position: "absolute",
            left: hover.x,
            top: hover.y,
            transform: "translate(-50%, calc(-100% - 10px))",
            zIndex: 20,
            pointerEvents: "none",
            background: "var(--surface)",
            border: "1px solid var(--line-strong)",
            borderRadius: 6,
            padding: "7px 9px",
            maxWidth: 270,
            whiteSpace: "nowrap",
          }}
        >
          {hover.incident ? (
            <>
              <div className="kicker" style={{ fontSize: 8.5 }}>
                {hover.incident.properties.kind === "official" ? "Official perimeter" : "Early estimate"}
              </div>
              <div style={{ fontSize: 12, fontWeight: 550, marginTop: 2 }}>
                {hover.incident.properties.name}
              </div>
              <div className="mono" style={{ fontSize: 9.5, color: "var(--muted)", marginTop: 3 }}>
                {hover.incident.properties.confidence}% ·{" "}
                {formatAcres(hover.incident.properties.areaAcres)} ·{" "}
                {hover.incident.properties.hotspotCount} hotspots
              </div>
            </>
          ) : hover.hotspot ? (
            <>
              <div className="kicker" style={{ fontSize: 8.5 }}>
                {sourceMeta(hover.hotspot.properties.source).short}
              </div>
              <div className="mono" style={{ fontSize: 10, marginTop: 2 }}>
                {formatMw(hover.hotspot.properties.frp)} ·{" "}
                {formatAge(Date.now() - Date.parse(hover.hotspot.properties.observedAt))} old
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
