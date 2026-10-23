import { describe, expect, it } from "vitest";
import pino from "pino";
import { ALERT_KINDS, circleRing, destination, type HazardAlertFeature, type IncidentFeature } from "@firepulse/protocol";
import { hazardAlerts, incidentAlerts, quietUntil, type Watcher } from "../src/notify/rules.js";
import { AlertEngine } from "../src/notify/engine.js";
import { HOURLY_CAP, PushOutbox, type PushSender } from "../src/notify/outbox.js";
import { MemoryAccountStore } from "../src/accounts/memory.js";

const log = pino({ level: "silent" });
const NOW = Date.parse("2026-10-23T20:00:00Z"); // 13:00 in Los Angeles
const HOME = { lon: -121.62, lat: 39.76 };

function watcher(extra: Partial<Watcher> = {}): Watcher {
  return {
    id: "place-1",
    userId: "user-1",
    name: "Home",
    ...HOME,
    radiusKm: 25,
    createdAt: "2026-10-01T00:00:00Z",
    settings: { alertKinds: [...ALERT_KINDS], quietStartMin: null, quietEndMin: null, timezone: "America/Los_Angeles" },
    ...extra,
  };
}

/** A fire whose nearest edge is `edgeKm` east of home. */
function fire(id: string, edgeKm: number, extra: Partial<IncidentFeature["properties"]> = {}): IncidentFeature {
  const radius = 1;
  const center = destination(HOME, 90, edgeKm + radius);
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [circleRing(edgeKm === 0 ? HOME : center, edgeKm === 0 ? 3 : radius, 48)] },
    properties: {
      id,
      kind: "official",
      name: id,
      status: "holding",
      confidence: 100,
      confidenceBreakdown: { score: 100, fused: 1, corroboration: 1, freshness: 1, distinctModalities: 1, evidenceCount: 1, rationale: "" },
      sources: [],
      firstDetectedAt: "2026-10-23T18:00:00Z",
      updatedAt: "2026-10-23T19:00:00Z",
      officialSince: "2026-10-23T18:30:00Z",
      areaAcres: 900,
      areaSqKm: 3.1,
      frp: 0,
      growthAcresPerHour: 0,
      growthFrpPerHour: 0,
      growthScore: 0,
      hotspotCount: 0,
      evidence: [],
      containment: 10,
      lat: (edgeKm === 0 ? HOME : center).lat,
      lon: (edgeKm === 0 ? HOME : center).lon,
      ...extra,
    },
  };
}

function hazard(event: HazardAlertFeature["properties"]["event"], id = event): HazardAlertFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [circleRing(HOME, 10, 24)] },
    properties: {
      id,
      event,
      severity: "Extreme",
      urgency: "Immediate",
      instruction: "Leave now via Skyway. Do not wait.",
      areaDesc: "Paradise",
      sender: "Butte County OES",
      sent: "2026-10-23T19:30:00Z",
      effective: "2026-10-23T19:30:00Z",
      expires: "2026-10-24T03:30:00Z",
      url: `https://api.weather.gov/alerts/${id}`,
    },
  };
}

describe("alert rules", () => {
  it("alerts on official fires and confirmed estimates within the radius only", () => {
    const w = [watcher()];
    expect(incidentAlerts(fire("near", 12), w, NOW).first).toHaveLength(1);
    expect(incidentAlerts(fire("far", 40), w, NOW).first).toHaveLength(0);
    expect(incidentAlerts(fire("burn", 3, { cause: "prescribed" }), w, NOW).first).toHaveLength(0);
    expect(incidentAlerts(fire("heat", 3, { kind: "estimated", confirmation: "single" }), w, NOW).first).toHaveLength(0);
    const est = incidentAlerts(fire("est", 3, { kind: "estimated", confirmation: "persistent" }), w, NOW).first[0]!;
    expect(est.title).toBe("Possible fire near Home");
    expect(est.body).toMatch(/Not yet confirmed/);
  });

  it("scales severity with distance and says when a place is inside", () => {
    const w = [watcher()];
    expect(incidentAlerts(fire("a", 15), w, NOW).first[0]!.severity).toBe("info");
    expect(incidentAlerts(fire("b", 4), w, NOW).first[0]!.severity).toBe("warning");
    const inside = incidentAlerts(fire("c", 0), w, NOW);
    expect(inside.first[0]!.severity).toBe("urgent");
    expect(inside.first[0]!.body).toMatch(/Home is inside its mapped area/);
    expect(inside.closer[0]!.revision).toBe("within:0");
  });

  it("follows an estimate into its official fire as the same subject", () => {
    const official = fire("wfigs-9", 6, {
      precursor: { estimateId: "est-9", firstDetectedAt: "2026-10-23T15:00:00Z", leadTimeMinutes: 90, peakConfidence: 70 },
    });
    const a = incidentAlerts(official, [watcher()], NOW).first[0]!;
    expect(a.subjectId).toBe("est-9");
    expect(a.revision).toBe("official");
    expect(a.title).toBe("wfigs-9 is now an official fire");
  });

  it("alerts on evacuation orders always and fire weather once a day", () => {
    const w = [watcher({ settings: { ...watcher().settings, quietStartMin: 0, quietEndMin: 1439 } })];
    const evac = hazardAlerts(hazard("Evacuation Immediate"), w, NOW)[0]!;
    expect(evac.severity).toBe("urgent");
    expect(evac.body).toBe("Leave now via Skyway. Do not wait.");
    expect(evac.notBefore).toBeUndefined();
    const rfw = hazardAlerts(hazard("Red Flag Warning"), w, NOW)[0]!;
    expect(rfw.subjectId).toBe("fire_weather");
    expect(rfw.revision).toBe("2026-10-23");
    // Quiet hours hold non-urgent alerts.
    expect(rfw.notBefore).toBeDefined();
    expect(hazardAlerts(hazard("Air Quality Alert"), w, NOW)).toHaveLength(0);
  });

  it("respects the alert kinds a person chose", () => {
    const w = [watcher({ settings: { ...watcher().settings, alertKinds: ["evacuation"] } })];
    expect(incidentAlerts(fire("x", 3), w, NOW).first).toHaveLength(0);
    expect(hazardAlerts(hazard("Evacuation Immediate"), w, NOW)).toHaveLength(1);
  });

  it("computes the end of quiet hours across midnight", () => {
    const s = { alertKinds: [...ALERT_KINDS], quietStartMin: 22 * 60, quietEndMin: 7 * 60, timezone: "America/Los_Angeles" };
    // 23:30 Los Angeles → held until 07:00.
    expect(quietUntil(s, Date.parse("2026-10-24T06:30:00Z"))).toBe("2026-10-24T14:00:00.000Z");
    expect(quietUntil(s, NOW)).toBeNull();
  });
});

describe("alert engine", () => {
  async function setup() {
    const accounts = new MemoryAccountStore();
    const user = await accounts.createUser({ username: "jane", passwordHash: null });
    const place = await accounts.createPlace(user.id, { name: "Home", ...HOME, radiusKm: 25 });
    let incidents: IncidentFeature[] = [];
    const engine = new AlertEngine({ accounts, log, incidents: () => incidents, hazards: () => [], now: () => NOW });
    return { accounts, user, place, engine, setIncidents: (f: IncidentFeature[]) => (incidents = f) };
  }

  it("treats fires already burning when a place is added as known", async () => {
    const { accounts, place, engine, setIncidents } = await setup();
    setIncidents([fire("old", 8)]);
    await engine.baseline(place.id);
    expect(await engine.onIncidents([fire("old", 8)])).toBe(0);
    expect(await engine.onIncidents([fire("new", 12)])).toBe(1);
    expect((await accounts.dueAlerts(new Date(NOW).toISOString(), 10)).map((a) => a.subjectId)).toEqual(["new"]);
  });

  it("sends one alert per fire, then one more each time it crosses closer", async () => {
    const { accounts, engine } = await setup();
    await engine.reload();
    expect(await engine.onIncidents([fire("f", 4)])).toBe(1); // first alert already says 4 km
    expect(await engine.onIncidents([fire("f", 4)])).toBe(0);
    expect(await engine.onIncidents([fire("f", 1.5)])).toBe(1); // now within 2 km
    expect(await engine.onIncidents([fire("f", 0)])).toBe(1); // reached the place
    const due = await accounts.dueAlerts(new Date(NOW).toISOString(), 10);
    expect(due.map((a) => `${a.kind}:${a.revision}`)).toEqual(["new_fire:official", "fire_closer:within:2", "fire_closer:within:0"]);
  });
});

describe("push outbox", () => {
  // The store stamps sends with the real clock, so the outbox uses it too.
  const T = Date.now();

  async function setup(sender: PushSender) {
    const accounts = new MemoryAccountStore();
    const user = await accounts.createUser({ username: "jane", passwordHash: null });
    const place = await accounts.createPlace(user.id, { name: "Home", ...HOME, radiusKm: 25 });
    const outbox = new PushOutbox({ accounts, sender, log, now: () => T });
    const queue = (n: number, severity: "urgent" | "info" = "info") =>
      accounts.insertAlerts(
        Array.from({ length: n }, (_, i) => ({
          userId: user.id,
          placeId: place.id,
          kind: "new_fire" as const,
          subjectId: `f${i}-${severity}`,
          revision: "official",
          severity,
          title: "t",
          body: "b",
          url: "/",
          notBefore: new Date(T - 1000).toISOString(),
        })),
      );
    return { accounts, user, outbox, queue };
  }

  it("marks alerts for people with no device, and sends to subscribed ones", async () => {
    const sent: string[] = [];
    const { accounts, user, outbox, queue } = await setup({ send: async (sub, payload) => void sent.push(`${sub.endpoint} ${payload}`) });
    await queue(1);
    expect(await outbox.flush()).toBe(0);
    expect((await accounts.recentAlerts(user.id, 5))[0]!.status).toBe("no_device");

    await accounts.saveSubscription(user.id, { endpoint: "https://push.example/1", p256dh: "k", auth: "a", userAgent: null });
    await queue(2);
    expect(await outbox.flush()).toBe(1);
    const placeId = (await accounts.places(user.id))[0]!.id;
    expect(JSON.parse(sent[0]!.split(" ").slice(1).join(" ")).tag).toBe(`${placeId}:f1-info`);
  });

  it("drops gone subscriptions and retries other failures", async () => {
    const { accounts, user, outbox, queue } = await setup({
      send: async (sub) => {
        throw Object.assign(new Error("push failed"), { statusCode: sub.endpoint.endsWith("gone") ? 410 : 503 });
      },
    });
    await accounts.saveSubscription(user.id, { endpoint: "https://push.example/gone", p256dh: "k", auth: "a", userAgent: null });
    await accounts.saveSubscription(user.id, { endpoint: "https://push.example/flaky", p256dh: "k", auth: "a", userAgent: null });
    await queue(1);
    await outbox.flush();
    expect((await accounts.subscriptions(user.id)).map((s) => s.endpoint)).toEqual(["https://push.example/flaky"]);
    const [alert] = await accounts.recentAlerts(user.id, 1);
    expect(alert!.status).toBe("pending");
    expect(Date.parse(alert!.notBefore)).toBeGreaterThan(T);
  });

  it("holds back non-urgent alerts beyond the hourly cap but never urgent ones", async () => {
    const { accounts, user, outbox, queue } = await setup({ send: async () => undefined });
    await accounts.saveSubscription(user.id, { endpoint: "https://push.example/1", p256dh: "k", auth: "a", userAgent: null });
    await queue(HOURLY_CAP + 2);
    await queue(1, "urgent");
    await outbox.flush();
    const statuses = (await accounts.recentAlerts(user.id, 20)).map((a) => `${a.severity}:${a.status}`);
    expect(statuses.filter((s) => s === "info:sent")).toHaveLength(HOURLY_CAP);
    expect(statuses.filter((s) => s === "info:suppressed")).toHaveLength(2);
    expect(statuses).toContain("urgent:sent");
  });
});
