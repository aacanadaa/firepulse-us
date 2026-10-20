import type { StyleSpecification } from "maplibre-gl";

/** Static cartographic context — Atlas/Ink need no glyph server or network. */

export interface PlaceLabel {
  name: string;
  lon: number;
  lat: number;
  minZoom: number;
}

export const CITY_LABELS: PlaceLabel[] = [
  { name: "Seattle", lon: -122.332, lat: 47.606, minZoom: 4.4 },
  { name: "Portland", lon: -122.676, lat: 45.523, minZoom: 4.4 },
  { name: "Sacramento", lon: -121.494, lat: 38.582, minZoom: 4.2 },
  { name: "San Francisco", lon: -122.419, lat: 37.775, minZoom: 4.2 },
  { name: "San Jose", lon: -121.886, lat: 37.338, minZoom: 5.0 },
  { name: "Los Angeles", lon: -118.244, lat: 34.052, minZoom: 4.0 },
  { name: "San Diego", lon: -117.161, lat: 32.716, minZoom: 4.6 },
  { name: "Las Vegas", lon: -115.139, lat: 36.169, minZoom: 4.2 },
  { name: "Reno", lon: -119.814, lat: 39.529, minZoom: 4.6 },
  { name: "Phoenix", lon: -112.074, lat: 33.448, minZoom: 4.2 },
  { name: "Tucson", lon: -110.974, lat: 32.222, minZoom: 4.8 },
  { name: "Albuquerque", lon: -106.65, lat: 35.084, minZoom: 4.4 },
  { name: "Denver", lon: -104.99, lat: 39.739, minZoom: 4.2 },
  { name: "Salt Lake City", lon: -111.891, lat: 40.76, minZoom: 4.4 },
  { name: "Boise", lon: -116.202, lat: 43.615, minZoom: 4.4 },
  { name: "Spokane", lon: -117.426, lat: 47.658, minZoom: 4.8 },
  { name: "Missoula", lon: -113.994, lat: 46.872, minZoom: 5.0 },
  { name: "Billings", lon: -108.5, lat: 45.783, minZoom: 4.8 },
  { name: "Cheyenne", lon: -104.82, lat: 41.14, minZoom: 4.8 },
  { name: "El Paso", lon: -106.485, lat: 31.761, minZoom: 4.6 },
  { name: "Austin", lon: -97.743, lat: 30.267, minZoom: 4.4 },
  { name: "Dallas", lon: -96.797, lat: 32.776, minZoom: 4.4 },
  { name: "Oklahoma City", lon: -97.516, lat: 35.468, minZoom: 4.8 },
  { name: "Kansas City", lon: -94.578, lat: 39.099, minZoom: 4.6 },
  { name: "Minneapolis", lon: -93.265, lat: 44.978, minZoom: 4.4 },
  { name: "Chicago", lon: -87.63, lat: 41.878, minZoom: 4.2 },
  { name: "St. Louis", lon: -90.199, lat: 38.627, minZoom: 4.6 },
];

export const STATE_LABELS: PlaceLabel[] = [
  { name: "WASHINGTON", lon: -120.5, lat: 47.4, minZoom: 3.4 },
  { name: "OREGON", lon: -120.6, lat: 43.9, minZoom: 3.4 },
  { name: "CALIFORNIA", lon: -119.7, lat: 37.2, minZoom: 3.2 },
  { name: "NEVADA", lon: -116.6, lat: 39.3, minZoom: 3.6 },
  { name: "IDAHO", lon: -114.6, lat: 44.4, minZoom: 3.6 },
  { name: "MONTANA", lon: -109.6, lat: 47.0, minZoom: 3.6 },
  { name: "WYOMING", lon: -107.5, lat: 43.0, minZoom: 3.8 },
  { name: "UTAH", lon: -111.7, lat: 39.3, minZoom: 3.8 },
  { name: "ARIZONA", lon: -111.7, lat: 34.2, minZoom: 3.4 },
  { name: "COLORADO", lon: -105.6, lat: 39.0, minZoom: 3.6 },
  { name: "NEW MEXICO", lon: -106.1, lat: 34.4, minZoom: 3.8 },
  { name: "TEXAS", lon: -99.0, lat: 31.3, minZoom: 3.4 },
  { name: "OKLAHOMA", lon: -97.5, lat: 35.5, minZoom: 4.0 },
  { name: "KANSAS", lon: -98.4, lat: 38.5, minZoom: 4.0 },
  { name: "NEBRASKA", lon: -99.8, lat: 41.5, minZoom: 4.0 },
  { name: "SOUTH DAKOTA", lon: -100.2, lat: 44.4, minZoom: 4.2 },
  { name: "MINNESOTA", lon: -94.3, lat: 46.3, minZoom: 4.2 },
  { name: "IOWA", lon: -93.5, lat: 42.0, minZoom: 4.4 },
  { name: "MISSOURI", lon: -92.4, lat: 38.3, minZoom: 4.4 },
  { name: "ARKANSAS", lon: -92.4, lat: 34.8, minZoom: 4.4 },
];

export const BASEMAP_SOURCE = "basemap";
export const BASEMAP_URL = "pmtiles:///basemap/firepulse.pmtiles";

export type MapType = "atlas" | "ink" | "topo" | "sat";

export const MAP_TYPES: { id: MapType; label: string; name: string; note: string }[] = [
  { id: "atlas", label: "Atlas", name: "Atlas", note: "Editorial light · Natural Earth" },
  { id: "ink", label: "Ink", name: "Ink", note: "Carbon plate · Natural Earth" },
  { id: "topo", label: "Topo", name: "Topographic", note: "Esri World Topographic" },
  { id: "sat", label: "Sat", name: "Satellite", note: "Esri World Imagery" },
];

export const RASTER_ATTRIBUTION = "Esri, HERE, Garmin, USGS, NOAA, Maxar, Earthstar Geographics";

export interface MapTheme {
  official: string;
  officialCasing: string;
  officialFill: string;
  officialHatch: string;
  estimated: string;
  estimatedCasing: string;
  estimatedFill: string;
  labelText: string;
  labelBg: string;
  labelBorder: string;
  labelOutline: string;
  markerStroke: string;
  wind: string;
  windOpacity: number;
  stateLabel: string;
  cityLabel: string;
  stateOpacity: number;
  cityOpacity: number;
  grid: string;
  gridOpacity: number;
}

export const MAP_THEMES: Record<MapType, MapTheme> = {
  atlas: {
    official: "#1b4332",
    officialCasing: "#fbfaf6",
    officialFill: "rgba(27, 67, 50, 0.05)",
    officialHatch: "#1b4332",
    estimated: "#ff4f00",
    estimatedCasing: "#fbfaf6",
    estimatedFill: "rgba(255, 79, 0, 0.05)",
    labelText: "#2b2b2b",
    labelBg: "rgba(255, 255, 255, 0.95)",
    labelBorder: "#d8d2c6",
    labelOutline: "#ffffff",
    markerStroke: "#ffffff",
    wind: "#3d3d3d",
    windOpacity: 0.42,
    stateLabel: "#8f8778",
    cityLabel: "#7d7466",
    stateOpacity: 0.85,
    cityOpacity: 0.9,
    grid: "#d9d3c6",
    gridOpacity: 1,
  },
  ink: {
    official: "#edeae3",
    officialCasing: "#050505",
    officialFill: "rgba(237, 234, 227, 0.035)",
    officialHatch: "#edeae3",
    estimated: "#ff5a1f",
    estimatedCasing: "#050505",
    estimatedFill: "rgba(255, 90, 31, 0.07)",
    labelText: "#ededed",
    labelBg: "rgba(10, 10, 10, 0.92)",
    labelBorder: "#333333",
    labelOutline: "#050505",
    markerStroke: "#0a0a0a",
    wind: "#e8e6e0",
    windOpacity: 0.36,
    stateLabel: "#6b6b6b",
    cityLabel: "#8a8a8a",
    stateOpacity: 0.9,
    cityOpacity: 0.9,
    grid: "#1e1e1e",
    gridOpacity: 1,
  },
  topo: {
    official: "#111111",
    officialCasing: "#ffffff",
    officialFill: "rgba(17, 17, 17, 0.035)",
    officialHatch: "#111111",
    estimated: "#ff4f00",
    estimatedCasing: "#ffffff",
    estimatedFill: "rgba(255, 79, 0, 0.035)",
    labelText: "#111111",
    labelBg: "rgba(255, 255, 255, 0.94)",
    labelBorder: "#d6d2c8",
    labelOutline: "#ffffff",
    markerStroke: "#ffffff",
    wind: "#1f1f1f",
    windOpacity: 0.4,
    stateLabel: "#3d3d3d",
    cityLabel: "#4a4a4a",
    stateOpacity: 0.7,
    cityOpacity: 0.8,
    grid: "#999999",
    gridOpacity: 0,
  },
  sat: {
    official: "#ffffff",
    officialCasing: "#111111",
    officialFill: "rgba(255, 255, 255, 0.03)",
    officialHatch: "#ffffff",
    estimated: "#ff6a2b",
    estimatedCasing: "#111111",
    estimatedFill: "rgba(255, 106, 43, 0.045)",
    labelText: "#ffffff",
    labelBg: "rgba(12, 12, 12, 0.9)",
    labelBorder: "#3a3a3a",
    labelOutline: "#0b0b0b",
    markerStroke: "#111111",
    wind: "#f0ede6",
    windOpacity: 0.4,
    stateLabel: "#d9d5cc",
    cityLabel: "#e5e1d8",
    stateOpacity: 0.55,
    cityOpacity: 0.8,
    grid: "#888888",
    gridOpacity: 0,
  },
};

/** 5° graticule clipped to the CONUS plate. */
export function graticule(): { type: "FeatureCollection"; features: unknown[] } {
  const features: unknown[] = [];
  for (let lon = -140; lon <= -50; lon += 5) {
    features.push({
      type: "Feature",
      properties: { kind: "lon" },
      geometry: { type: "LineString", coordinates: [[lon, 20], [lon, 60]] },
    });
  }
  for (let lat = 20; lat <= 60; lat += 5) {
    features.push({
      type: "Feature",
      properties: { kind: "lat" },
      geometry: { type: "LineString", coordinates: [[-140, lat], [-50, lat]] },
    });
  }
  return { type: "FeatureCollection", features };
}

function vectorLayers(ink: boolean): unknown[] {
  return [
    {
      id: "graticule",
      type: "line",
      source: "graticule",
      paint: {
        "line-color": ink ? "#222222" : "#d9d3c6",
        "line-width": 0.5,
        "line-opacity": 1,
        "line-dasharray": [2, 3],
      },
    },
    {
      id: "land",
      type: "fill",
      source: BASEMAP_SOURCE,
      "source-layer": "land",
      paint: { "fill-color": ink ? "#151515" : "#f3f0e8" },
    },
    {
      id: "lakes",
      type: "fill",
      source: BASEMAP_SOURCE,
      "source-layer": "lakes",
      paint: { "fill-color": ink ? "#0b0b0b" : "#e3e8e4" },
    },
    {
      id: "lake-outline",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "lakes",
      paint: { "line-color": ink ? "#232323" : "#cdd5d0", "line-width": 0.6 },
    },
    {
      id: "rivers",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "rivers",
      paint: {
        "line-color": ink ? "#242424" : "#c6d3cf",
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.3, 7, 0.9],
      },
    },
    {
      id: "countries",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "countries",
      paint: {
        "line-color": ink ? "#3d3d3d" : "#c4bcac",
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 8, 1.4],
      },
    },
    {
      id: "states",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "states",
      paint: {
        "line-color": ink ? "#313131" : "#dbd5c7",
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 9, 1],
      },
    },
    {
      id: "coast",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "land",
      paint: {
        "line-color": ink ? "#3a3a3a" : "#c9c1b1",
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.9, 9, 1.8],
      },
    },
  ];
}

export function styleFor(type: MapType): StyleSpecification {
  if (type === "topo" || type === "sat") {
    const topo = type === "topo";
    return {
      version: 8,
      name: topo ? "FirePulse Topographic" : "FirePulse Satellite",
      sources: {
        raster: {
          type: "raster",
          tiles: [
            topo
              ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"
              : "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg",
          ],
          tileSize: 256,
          maxzoom: topo ? 18 : 14,
          attribution: topo
            ? RASTER_ATTRIBUTION
            : "EOX Sentinel-2 cloudless (2023) — s2maps.eu",
        },
      },
      layers: [
        {
          id: "raster-bg",
          type: "background",
          paint: { "background-color": topo ? "#f0ede6" : "#0a0a0a" },
        },
        {
          id: "raster",
          type: "raster",
          source: "raster",
          paint: topo
            ? {
                "raster-saturation": -0.18,
                "raster-contrast": -0.04,
                "raster-brightness-max": 0.98,
              }
            : {
                "raster-saturation": -0.3,
                "raster-contrast": 0.02,
                "raster-brightness-max": 0.9,
              },
        },
      ],
    };
  }

  const ink = type === "ink";
  return {
    version: 8,
    name: ink ? "FirePulse Ink" : "FirePulse Atlas",
    sources: {
      graticule: { type: "geojson", data: graticule() as never },
      [BASEMAP_SOURCE]: {
        type: "vector",
        tiles: [`${BASEMAP_URL}/{z}/{x}/{y}`],
        minzoom: 0,
        maxzoom: 6,
        bounds: [-142, 3, -48, 62],
        attribution: "Natural Earth",
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": ink ? "#070707" : "#e9e5dc" },
      },
      ...(vectorLayers(ink) as never[]),
    ],
  } as StyleSpecification;
}
