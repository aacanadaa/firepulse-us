/**
 * Demo geography. Every fire below is fictional but placed on real terrain
 * near real towns; the signal cadences mirror the production sources.
 *
 * `officialDelayMin` is the simulated latency of government mapping:
 * the number the product exists to beat. `null` means the fire never gets
 * an official perimeter during the session (early estimates only).
 */
export type SimFireState = "seed" | "fresh";

export interface SimFireDef {
  id: string;
  name: string;
  landmark: string;
  county: string;
  state: string;
  lat: number;
  lon: number;
  /** minutes relative to server boot; negative = already burning */
  ignitionOffsetMin: number;
  heading: number;
  /** head-rate of spread, km/h */
  spreadKmph: number;
  cause: "vegetation" | "powerline" | "vehicle" | "lightning";
  /** minutes after ignition until NIFC/CAL FIRE publish a perimeter */
  officialDelayMin: number | null;
  /** never emit tier-1/2 signals (official ground truth only) */
  officialOnly?: boolean;
  /** neighbourhood names used for CAD text */
  roads: string[];
}

export const SIM_FIRES: SimFireDef[] = [
  {
    id: "ridge",
    name: "Ridge Fire",
    landmark: "Matilija Canyon",
    county: "Ventura",
    state: "CA",
    lat: 34.484,
    lon: -119.312,
    ignitionOffsetMin: -22 * 60,
    heading: 228,
    spreadKmph: 0.42,
    cause: "powerline",
    officialDelayMin: 9,
    roads: ["Matilija Canyon Rd", "N Fork Matilija Rd"],
  },
  {
    id: "coyote",
    name: "Coyote Fire",
    landmark: "Shasta Lake",
    county: "Shasta",
    state: "CA",
    lat: 40.752,
    lon: -122.318,
    ignitionOffsetMin: -17 * 60,
    heading: 48,
    spreadKmph: 0.55,
    cause: "vegetation",
    officialDelayMin: 12,
    roads: ["Oasis Rd", "Bear Mountain Rd"],
  },
  {
    id: "ponderosa",
    name: "Ponderosa Fire",
    landmark: "Oak Creek Canyon",
    county: "Coconino",
    state: "AZ",
    lat: 35.042,
    lon: -111.742,
    ignitionOffsetMin: -13 * 60,
    heading: 305,
    spreadKmph: 0.31,
    cause: "lightning",
    officialDelayMin: 7,
    roads: ["N State Route 89A", "Oak Creek Vista"],
  },
  {
    id: "blueridge",
    name: "Blue Ridge Fire",
    landmark: "Cascade Lakes",
    county: "Deschutes",
    state: "OR",
    lat: 43.918,
    lon: -121.598,
    ignitionOffsetMin: -25 * 60,
    heading: 182,
    spreadKmph: 0.62,
    cause: "vegetation",
    officialDelayMin: 14,
    roads: ["Cascade Lakes Hwy", "NF-46"],
  },
  {
    id: "drycreek",
    name: "Dry Creek Fire",
    landmark: "Dry Creek Valley",
    county: "Ada",
    state: "ID",
    lat: 43.702,
    lon: -116.084,
    ignitionOffsetMin: -3 * 60,
    heading: 92,
    spreadKmph: 0.38,
    cause: "vehicle",
    officialDelayMin: null,
    roads: ["N Bogus Basin Rd", "Dry Creek Rd"],
  },
  {
    id: "timber",
    name: "Timber Fire",
    landmark: "Rogue Valley",
    county: "Jackson",
    state: "OR",
    lat: 42.245,
    lon: -122.712,
    ignitionOffsetMin: -4.5 * 60,
    heading: 138,
    spreadKmph: 0.29,
    cause: "lightning",
    officialDelayMin: 150,
    officialOnly: true,
    roads: ["Dead Indian Memorial Rd"],
  },
  {
    id: "cedar",
    name: "Cedar Fire",
    landmark: "Lexington Reservoir",
    county: "Santa Clara",
    state: "CA",
    lat: 37.182,
    lon: -121.982,
    ignitionOffsetMin: -34,
    heading: 198,
    spreadKmph: 0.44,
    cause: "vegetation",
    officialDelayMin: 58,
    roads: ["Black Rd", "Lexington Dam Rd"],
  },
  {
    id: "cinder",
    name: "Cinder Fire",
    landmark: "Flatirons",
    county: "Boulder",
    state: "CO",
    lat: 39.982,
    lon: -105.318,
    ignitionOffsetMin: -26,
    heading: 96,
    spreadKmph: 0.39,
    cause: "lightning",
    officialDelayMin: null,
    roads: ["Flagstaff Rd", "Chautauqua Trailhead"],
  },
  // --- ignitions that happen while the user is watching -----------------
  {
    id: "antelope",
    name: "Antelope Fire",
    landmark: "Sand Canyon",
    county: "Los Angeles",
    state: "CA",
    lat: 34.462,
    lon: -118.428,
    ignitionOffsetMin: 0.4,
    heading: 252,
    spreadKmph: 0.74,
    cause: "vehicle",
    officialDelayMin: 4,
    roads: ["Sand Canyon Rd", "Soledad Canyon Rd"],
  },
  {
    id: "sage",
    name: "Sage Fire",
    landmark: "Pleasant Valley",
    county: "Washoe",
    state: "NV",
    lat: 39.428,
    lon: -119.742,
    ignitionOffsetMin: 2.2,
    heading: 68,
    spreadKmph: 0.58,
    cause: "powerline",
    officialDelayMin: 6,
    roads: ["Pleasant Valley Rd", "Sagebrush Dr"],
  },
  {
    id: "juniper",
    name: "Juniper Fire",
    landmark: "Granite Dells",
    county: "Yavapai",
    state: "AZ",
    lat: 34.612,
    lon: -112.418,
    ignitionOffsetMin: 6.5,
    heading: 312,
    spreadKmph: 0.36,
    cause: "vegetation",
    officialDelayMin: 7,
    roads: ["SR-89", "Granite Dells Pkwy"],
  },
  {
    id: "willow",
    name: "Willow Fire",
    landmark: "Butte Creek",
    county: "Butte",
    state: "CA",
    lat: 39.812,
    lon: -121.642,
    ignitionOffsetMin: 11,
    heading: 195,
    spreadKmph: 0.48,
    cause: "vegetation",
    officialDelayMin: null,
    roads: ["Honey Run Rd", "Skyway"],
  },
  {
    id: "badger",
    name: "Badger Fire",
    landmark: "Snake River Plain",
    county: "Twin Falls",
    state: "ID",
    lat: 42.482,
    lon: -114.318,
    ignitionOffsetMin: 16,
    heading: 84,
    spreadKmph: 0.66,
    cause: "lightning",
    officialDelayMin: 5,
    roads: ["US-93", "Rock Creek Rd"],
  },
  {
    id: "mesa",
    name: "Mesa Fire",
    landmark: "Colorado National Monument",
    county: "Mesa",
    state: "CO",
    lat: 39.042,
    lon: -108.692,
    ignitionOffsetMin: 23,
    heading: 128,
    spreadKmph: 0.34,
    cause: "vegetation",
    officialDelayMin: 13,
    roads: ["Rim Rock Dr", "Monument Rd"],
  },
];

export const CONUS_BBOX: [number, number, number, number] = [-126, 23, -66, 50];
export const WIND_COLS = 56;
export const WIND_ROWS = 28;
