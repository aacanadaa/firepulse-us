/** Static cartographic context — avoids a glyph server and keeps the map offline. */

export interface PlaceLabel {
  name: string;
  lon: number;
  lat: number;
  minZoom: number;
  kind: "city" | "state";
  weight?: number;
}

export const CITY_LABELS: PlaceLabel[] = [
  { name: "Seattle", lon: -122.332, lat: 47.606, minZoom: 4.6, kind: "city" },
  { name: "Portland", lon: -122.676, lat: 45.523, minZoom: 4.6, kind: "city" },
  { name: "Sacramento", lon: -121.494, lat: 38.582, minZoom: 4.4, kind: "city" },
  { name: "San Francisco", lon: -122.419, lat: 37.775, minZoom: 4.4, kind: "city" },
  { name: "San Jose", lon: -121.886, lat: 37.338, minZoom: 5.2, kind: "city" },
  { name: "Los Angeles", lon: -118.244, lat: 34.052, minZoom: 4.2, kind: "city" },
  { name: "San Diego", lon: -117.161, lat: 32.716, minZoom: 4.8, kind: "city" },
  { name: "Las Vegas", lon: -115.139, lat: 36.169, minZoom: 4.4, kind: "city" },
  { name: "Reno", lon: -119.814, lat: 39.529, minZoom: 4.8, kind: "city" },
  { name: "Phoenix", lon: -112.074, lat: 33.448, minZoom: 4.4, kind: "city" },
  { name: "Tucson", lon: -110.974, lat: 32.222, minZoom: 5.0, kind: "city" },
  { name: "Albuquerque", lon: -106.65, lat: 35.084, minZoom: 4.6, kind: "city" },
  { name: "Denver", lon: -104.99, lat: 39.739, minZoom: 4.4, kind: "city" },
  { name: "Salt Lake City", lon: -111.891, lat: 40.76, minZoom: 4.6, kind: "city" },
  { name: "Boise", lon: -116.202, lat: 43.615, minZoom: 4.6, kind: "city" },
  { name: "Spokane", lon: -117.426, lat: 47.658, minZoom: 5.0, kind: "city" },
  { name: "Missoula", lon: -113.994, lat: 46.872, minZoom: 5.2, kind: "city" },
  { name: "Billings", lon: -108.5, lat: 45.783, minZoom: 5.0, kind: "city" },
  { name: "Cheyenne", lon: -104.82, lat: 41.14, minZoom: 5.0, kind: "city" },
  { name: "El Paso", lon: -106.485, lat: 31.761, minZoom: 4.8, kind: "city" },
  { name: "Austin", lon: -97.743, lat: 30.267, minZoom: 4.6, kind: "city" },
  { name: "Dallas", lon: -96.797, lat: 32.776, minZoom: 4.6, kind: "city" },
  { name: "Oklahoma City", lon: -97.516, lat: 35.468, minZoom: 5.0, kind: "city" },
  { name: "Kansas City", lon: -94.578, lat: 39.099, minZoom: 4.8, kind: "city" },
  { name: "Minneapolis", lon: -93.265, lat: 44.978, minZoom: 4.6, kind: "city" },
  { name: "Chicago", lon: -87.63, lat: 41.878, minZoom: 4.4, kind: "city" },
  { name: "St. Louis", lon: -90.199, lat: 38.627, minZoom: 4.8, kind: "city" },
];

export const STATE_LABELS: PlaceLabel[] = [
  { name: "WASHINGTON", lon: -120.5, lat: 47.4, minZoom: 3.4, kind: "state" },
  { name: "OREGON", lon: -120.6, lat: 43.9, minZoom: 3.4, kind: "state" },
  { name: "CALIFORNIA", lon: -119.7, lat: 37.2, minZoom: 3.2, kind: "state" },
  { name: "NEVADA", lon: -116.6, lat: 39.3, minZoom: 3.6, kind: "state" },
  { name: "IDAHO", lon: -114.6, lat: 44.4, minZoom: 3.6, kind: "state" },
  { name: "MONTANA", lon: -109.6, lat: 47.0, minZoom: 3.6, kind: "state" },
  { name: "WYOMING", lon: -107.5, lat: 43.0, minZoom: 3.8, kind: "state" },
  { name: "UTAH", lon: -111.7, lat: 39.3, minZoom: 3.8, kind: "state" },
  { name: "ARIZONA", lon: -111.7, lat: 34.2, minZoom: 3.4, kind: "state" },
  { name: "COLORADO", lon: -105.6, lat: 39.0, minZoom: 3.6, kind: "state" },
  { name: "NEW MEXICO", lon: -106.1, lat: 34.4, minZoom: 3.8, kind: "state" },
  { name: "TEXAS", lon: -99.0, lat: 31.3, minZoom: 3.4, kind: "state" },
  { name: "OKLAHOMA", lon: -97.5, lat: 35.5, minZoom: 4.0, kind: "state" },
  { name: "KANSAS", lon: -98.4, lat: 38.5, minZoom: 4.0, kind: "state" },
  { name: "NEBRASKA", lon: -99.8, lat: 41.5, minZoom: 4.0, kind: "state" },
  { name: "SOUTH DAKOTA", lon: -100.2, lat: 44.4, minZoom: 4.2, kind: "state" },
  { name: "MINNESOTA", lon: -94.3, lat: 46.3, minZoom: 4.2, kind: "state" },
  { name: "IOWA", lon: -93.5, lat: 42.0, minZoom: 4.4, kind: "state" },
  { name: "MISSOURI", lon: -92.4, lat: 38.3, minZoom: 4.4, kind: "state" },
  { name: "ARKANSAS", lon: -92.4, lat: 34.8, minZoom: 4.4, kind: "state" },
];

export const BASEMAP_SOURCE = "basemap";
export const BASEMAP_URL = "pmtiles:///basemap/firepulse.pmtiles";

export function basemapStyle() {
  return {
    version: 8 as const,
    name: "FirePulse Dark",
    sources: {
      [BASEMAP_SOURCE]: {
        type: "vector" as const,
        // Explicit tile template + zoom range: avoids a TileJSON round-trip
        // and guarantees MapLibre does not overzoom the z0 tile.
        tiles: [`${BASEMAP_URL}/{z}/{x}/{y}`],
        minzoom: 0,
        maxzoom: 6,
        bounds: [-142, 3, -48, 62],
        attribution: "Natural Earth · FirePulse US",
      },
    },
    layers: [
      {
        id: "void",
        type: "background" as const,
        paint: { "background-color": "#05070a" },
      },
      {
        id: "ocean-sheen",
        type: "background" as const,
        paint: {
          "background-color": "#05070a",
          "background-opacity": 1,
        },
      },
      {
        id: "land",
        type: "fill" as const,
        source: BASEMAP_SOURCE,
        "source-layer": "land",
        paint: { "fill-color": "#16212d", "fill-opacity": 1 },
      },
      {
        id: "lakes",
        type: "fill" as const,
        source: BASEMAP_SOURCE,
        "source-layer": "lakes",
        paint: { "fill-color": "#0a1520", "fill-opacity": 1 },
      },
      {
        id: "lake-outline",
        type: "line" as const,
        source: BASEMAP_SOURCE,
        "source-layer": "lakes",
        paint: { "line-color": "#1d3446", "line-width": 0.7 },
      },
      {
        id: "rivers",
        type: "line" as const,
        source: BASEMAP_SOURCE,
        "source-layer": "rivers",
        paint: {
          "line-color": "#1b3d52",
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 7, 1.3],
          "line-opacity": 0.75,
        },
      },
      {
        id: "countries",
        type: "line" as const,
        source: BASEMAP_SOURCE,
        "source-layer": "countries",
        paint: {
          "line-color": "#2c4256",
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 8, 1.6],
          "line-opacity": 0.9,
        },
      },
      {
        id: "states",
        type: "line" as const,
        source: BASEMAP_SOURCE,
        "source-layer": "states",
        paint: {
          "line-color": "#263a4c",
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.55, 9, 1.3],
          "line-opacity": 0.95,
        },
      },
      {
        id: "coast-glow",
        type: "line" as const,
        source: BASEMAP_SOURCE,
        "source-layer": "land",
        paint: {
          "line-color": "#3a5b73",
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1, 9, 2.4],
          "line-opacity": 0.45,
          "line-blur": 3,
        },
      },
    ],
  };
}
