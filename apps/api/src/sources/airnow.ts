import { haversineKm, type AirQualityReading, type LngLat, type RawSignal } from "@firepulse/protocol";
import type { SourceAdapter } from "./types.js";

/* ==================================================================== */
/*  EPA AirNow PM2.5: smoke context for fusion, air quality for places   */
/* ==================================================================== */

const AIRNOW_DATA_URL = "https://www.airnowapi.org/aq/data/";
/** Readings at or above this AQI (unhealthy for sensitive groups) count as smoke. */
export const SMOKE_AQI = 101;
/** A monitor further than this doesn't describe the air at a place. */
const NEAREST_KM = 40;

export const AQI_CATEGORIES = [
  "",
  "Good",
  "Moderate",
  "Unhealthy for sensitive groups",
  "Unhealthy",
  "Very unhealthy",
  "Hazardous",
] as const;

interface AirNowRow {
  Latitude?: number;
  Longitude?: number;
  UTC?: string;
  Parameter?: string;
  AQI?: number;
  Category?: number;
  SiteName?: string;
  AgencyName?: string;
  FullAQSCode?: string;
}

/** AirNow /aq/data rows → the latest PM2.5 reading per monitor. */
export function parseAirNowData(json: unknown): AirQualityReading[] {
  if (!Array.isArray(json)) return [];
  const latest = new Map<string, AirQualityReading>();
  for (const row of json as AirNowRow[]) {
    const lat = Number(row.Latitude);
    const lon = Number(row.Longitude);
    const aqi = Number(row.AQI);
    // AirNow times are UTC without a zone suffix.
    const t = Date.parse(`${row.UTC ?? ""}:00Z`);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(aqi) || aqi < 0 || !Number.isFinite(t)) continue;
    if (row.Parameter !== "PM2.5") continue;
    const site = row.FullAQSCode || `${lat.toFixed(3)},${lon.toFixed(3)}`;
    const observedAt = new Date(t).toISOString();
    const prev = latest.get(site);
    if (prev && prev.observedAt >= observedAt) continue;
    const category = Math.max(1, Math.min(6, Number(row.Category) || 1));
    latest.set(site, {
      site,
      siteName: row.SiteName ?? "Air monitor",
      agency: row.AgencyName ?? "",
      lat,
      lon,
      parameter: "PM2.5",
      aqi,
      category: AQI_CATEGORIES[category] ?? "Unknown",
      observedAt,
    });
  }
  return [...latest.values()];
}

/** The latest reading at every monitor, for "air quality at this place". */
export class AirQualityLayer {
  private readings: AirQualityReading[] = [];

  get count(): number {
    return this.readings.length;
  }

  replace(readings: AirQualityReading[]): void {
    this.readings = readings;
  }

  nearest(point: LngLat, now = Date.now()): (AirQualityReading & { distanceKm: number }) | null {
    let best: (AirQualityReading & { distanceKm: number }) | null = null;
    for (const r of this.readings) {
      // Hours-old readings no longer describe the air.
      if (now - Date.parse(r.observedAt) > 4 * 3_600_000) continue;
      const d = haversineKm(point, r);
      if (d <= NEAREST_KM && (!best || d < best.distanceKm)) best = { ...r, distanceKm: Math.round(d * 10) / 10 };
    }
    return best;
  }
}

export function smokeSignals(readings: AirQualityReading[], receivedAt: string): RawSignal[] {
  return readings
    .filter((r) => r.aqi >= SMOKE_AQI)
    .map((r) => {
      const id = `airnow-${r.site}-${r.observedAt}`;
      return {
        id,
        source: "airnow" as const,
        kind: "airquality" as const,
        tier: 3 as const,
        lon: r.lon,
        lat: r.lat,
        observedAt: r.observedAt,
        receivedAt,
        // AQI 101 → 0.5, 300+ → 1.
        providerConfidence: Math.min(1, 0.5 + (r.aqi - SMOKE_AQI) / 400),
        label: `PM2.5 AQI ${r.aqi} at ${r.siteName}`,
        meta: { dedupeKey: id, aqi: r.aqi, site: r.siteName },
      };
    });
}

export function createAirNowAdapter(apiKey: string, layer: AirQualityLayer, bbox = "-126,23,-66,50"): SourceAdapter {
  return {
    id: "airnow",
    label: "EPA AirNow PM2.5",
    sources: ["airnow"],
    tier: 3,
    // Monitors report hourly; two polls an hour catch each report promptly.
    intervalMs: 30 * 60_000,
    enabled: true,
    backfill: true,
    async poll({ now }) {
      const hour = (t: number) => new Date(t).toISOString().slice(0, 13);
      const q = new URLSearchParams({
        startDate: hour(now - 3 * 3_600_000),
        endDate: hour(now),
        parameters: "PM25",
        BBOX: bbox,
        dataType: "A",
        format: "application/json",
        verbose: "1",
        monitorType: "0",
        includerawconcentrations: "0",
        API_KEY: apiKey,
      });
      const res = await fetch(`${AIRNOW_DATA_URL}?${q}`, { signal: AbortSignal.timeout(45_000) });
      if (!res.ok) throw new Error(`AirNow ${res.status}`);
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) {
        const message = (body as { WebServiceError?: { Message?: string }[] })?.WebServiceError?.[0]?.Message;
        throw new Error(`AirNow: ${message ?? "unexpected response"}`);
      }
      const readings = parseAirNowData(body);
      layer.replace(readings);
      return smokeSignals(readings, new Date(now).toISOString());
    },
  };
}
