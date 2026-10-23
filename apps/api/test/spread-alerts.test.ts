import { describe, expect, it } from "vitest";
import pino from "pino";
import { ALERT_KINDS, circleRing, destination, type IncidentFeature, type SpreadCell, type SpreadForecast } from "@firepulse/protocol";
import { forecastOutlook } from "../src/spread/relevance.js";
import { spreadAlerts, type Watcher } from "../src/notify/rules.js";
import { SpreadScheduler } from "../src/spread/scheduler.js";

const NOW = Date.parse("2026-10-23T20:00:00Z");
const HOME = { lon: -121.62, lat: 39.76 };

/** A 1 km cell whose centre is `km` east of home. */
function cell(km: number, score: number, burning = false): SpreadCell {
  const c = destination(HOME, 90, km);
  const d = 0.5 / 111;
  const dl = 0.5 / (111 * Math.cos((c.lat * Math.PI) / 180));
  return {
    ring: [
      [c.lon - dl, c.lat + d],
      [c.lon + dl, c.lat + d],
      [c.lon + dl, c.lat - d],
      [c.lon - dl, c.lat - d],
      [c.lon - dl, c.lat + d],
    ],
    score,
    burning,
  };
}

function forecast(cells: SpreadCell[]): SpreadForecast {
  const c = (dx: number, dy: number): [number, number] => [HOME.lon + dx, HOME.lat + dy];
  return {
    incidentId: "fire",
    status: "ready",
    generatedAt: new Date(NOW).toISOString(),
    threshold: 0.12,
    corners: { nw: c(-0.5, 0.5), ne: c(0.5, 0.5), se: c(0.5, -0.5), sw: c(-0.5, -0.5) },
    cells,
  };
}

const watcher: Watcher = {
  id: "place",
  userId: "user",
  name: "Home",
  ...HOME,
  radiusKm: 25,
  createdAt: "2026-10-01T00:00:00Z",
  settings: { alertKinds: [...ALERT_KINDS], quietStartMin: null, quietEndMin: null, timezone: "America/Los_Angeles" },
};

const fire: IncidentFeature = {
  type: "Feature",
  id: "fire",
  geometry: { type: "Polygon", coordinates: [circleRing(destination(HOME, 90, 12), 1, 24)] },
  properties: {
    id: "fire",
    kind: "official",
    name: "Ridge",
    status: "growing",
    confidence: 100,
    confidenceBreakdown: { score: 100, fused: 1, corroboration: 1, freshness: 1, distinctModalities: 1, evidenceCount: 1, rationale: "" },
    sources: [],
    firstDetectedAt: "2026-10-23T10:00:00Z",
    updatedAt: "2026-10-23T19:00:00Z",
    officialSince: "2026-10-23T11:00:00Z",
    areaAcres: 1500,
    areaSqKm: 6,
    frp: 0,
    growthAcresPerHour: 0,
    growthFrpPerHour: 0,
    growthScore: 0,
    hotspotCount: 12,
    evidence: [],
    ...destination(HOME, 90, 12),
  },
};

describe("forecast outlook for a place", () => {
  it("measures today's fire and likely growth, and says when growth heads this way", () => {
    const o = forecastOutlook(forecast([cell(12, 0.9, true), cell(8, 0.3), cell(6, 0.08), cell(16, 0.6)]), HOME)!;
    expect(o.todayKm).toBeCloseTo(11.5, 0);
    // The 0.08 cell is below the likely band and doesn't count.
    expect(o.likelyKm).toBeCloseTo(7.5, 0);
    expect(o.veryLikelyKm).toBeCloseTo(15.5, 0);
    expect(o.toward).toBe(true);
  });

  it("isn't toward when likely growth stays as far as today's fire", () => {
    const o = forecastOutlook(forecast([cell(12, 0.9, true), cell(16, 0.3)]), HOME)!;
    expect(o.toward).toBe(false);
    expect(forecastOutlook({ incidentId: "x", status: "unavailable" }, HOME)).toBeNull();
  });
});

describe("spread alerts", () => {
  it("alerts once a day when likely growth comes within the radius toward a place", () => {
    const toward = forecast([cell(12, 0.9, true), cell(8, 0.3)]);
    const [a] = spreadAlerts(fire, toward, [watcher], NOW);
    expect(a).toMatchObject({ kind: "spread", severity: "info", revision: "2026-10-23", subjectId: "fire" });
    expect(a!.title).toBe("Ridge may spread toward Home");
    expect(a!.body).toMatch(/experimental/);
    expect(spreadAlerts(fire, forecast([cell(12, 0.9, true), cell(16, 0.3)]), [watcher], NOW)).toHaveLength(0);
    expect(spreadAlerts(fire, toward, [{ ...watcher, radiusKm: 5 }], NOW)).toHaveLength(0);
  });

  it("raises the severity when likely growth reaches within 2 km", () => {
    const [a] = spreadAlerts(fire, forecast([cell(12, 0.9, true), cell(1.5, 0.2)]), [watcher], NOW);
    expect(a!.severity).toBe("warning");
  });
});

describe("spread scheduler", () => {
  const log = pino({ level: "silent" });

  it("forecasts confirmed fires near watched places, again only on new detections or after 6 h", async () => {
    let now = NOW;
    const calls: string[] = [];
    const seen: string[] = [];
    let incidents = [
      fire,
      { ...fire, id: "far", properties: { ...fire.properties, id: "far", ...destination(HOME, 90, 120) } },
      { ...fire, id: "burn", properties: { ...fire.properties, id: "burn", cause: "prescribed" as const } },
    ];
    const scheduler = new SpreadScheduler({
      forecast: async (id) => {
        calls.push(id);
        return { ...forecast([cell(12, 0.9, true), cell(8, 0.3)]), incidentId: id };
      },
      incidents: () => incidents,
      places: () => [HOME],
      onForecast: async (f) => void seen.push(f.id),
      log,
      now: () => now,
    });
    expect(await scheduler.tick()).toBe(1);
    expect(calls).toEqual(["fire"]);
    expect(seen).toEqual(["fire"]);
    expect(scheduler.latest("fire")?.status).toBe("ready");

    now += 3_600_000;
    expect(await scheduler.tick()).toBe(0);
    incidents = [{ ...fire, properties: { ...fire.properties, hotspotCount: 20 } }];
    expect(await scheduler.tick()).toBe(1);
    now += 6 * 3_600_000;
    expect(await scheduler.tick()).toBe(1);
  });

  it("runs nothing when no one watches a place", async () => {
    const scheduler = new SpreadScheduler({
      forecast: async () => null,
      incidents: () => [fire],
      places: () => [],
      onForecast: async () => undefined,
      log,
    });
    expect(await scheduler.tick()).toBe(0);
  });
});
