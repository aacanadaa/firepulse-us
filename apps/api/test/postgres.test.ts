/**
 * Runs against a real PostGIS database when TEST_DATABASE_URL is set, e.g.
 *   TEST_DATABASE_URL=postgres://firepulse:firepulse@127.0.0.1:5432/firepulse_test pnpm test
 * The database is created if missing and its firepulse schema is rebuilt.
 */
import { describe, expect, it } from "vitest";
import pg from "pg";
import pino from "pino";
import { circleRing, type IncidentFeature, type RawSignal } from "@firepulse/protocol";
import { PostgresStore } from "../src/store/postgres.js";
import { PostgresAccountStore } from "../src/accounts/postgres.js";
import { FusionEngine } from "../src/fusion/engine.js";
import type { AppConfig } from "../src/config.js";

const url = process.env.TEST_DATABASE_URL;

async function freshDatabase(target: string): Promise<void> {
  const u = new URL(target);
  const name = u.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(target), { pathname: "/postgres" }).toString() });
  await admin.connect();
  const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [name]);
  if (!rowCount) await admin.query(`create database "${name.replace(/"/g, "")}"`);
  await admin.end();
  const db = new pg.Client({ connectionString: target });
  await db.connect();
  await db.query("drop schema if exists firepulse cascade");
  await db.end();
}

const NOW = Date.now();
const cfg = {
  fusion: { radiusKm: 2, ttlMin: 45, matchKm: 3, hullBufferM: 220 },
  ingest: { hotspotRetentionHours: 24 },
} as unknown as AppConfig;

describe.skipIf(!url)("Postgres store", () => {
  it("migrates, stores text incident ids and records a merge end to end", async () => {
    await freshDatabase(url!);
    const store = new PostgresStore(url!);
    await store.init();
    expect(await store.migrate()).toEqual([]);

    const engine = new FusionEngine(store, cfg, pino({ level: "silent" }));
    const signals: RawSignal[] = [0, 1].map((i) => ({
      id: `v${i}`,
      source: "viirs",
      kind: "thermal",
      tier: 2,
      lon: -120.5 + i * 0.002,
      lat: 38.2,
      observedAt: new Date(NOW - (14 - i * 12) * 3_600_000).toISOString(),
      receivedAt: new Date(NOW).toISOString(),
      providerConfidence: 0.9,
      frp: 20,
      meta: { dedupeKey: `v${i}` },
    }));
    expect(await store.insertSignals(signals)).toHaveLength(2);
    expect(await store.insertSignals(signals)).toHaveLength(0);

    const first = await engine.run(NOW);
    const estimate = first.upserts[0]!;
    const stored = (await store.activeIncidents()).find((f) => f.id === estimate.id);
    expect(stored?.properties.confirmation).toBe("persistent");
    // Restored estimates keep their evidence time, not the time the row was written.
    expect(stored?.properties.updatedAt).toBe(estimate.properties.updatedAt);

    const ring = circleRing({ lon: -120.5, lat: 38.2 }, 2, 24);
    const official: IncidentFeature = {
      ...estimate,
      id: "wfigs-2026-CAXXX-000001",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {
        ...estimate.properties,
        id: "wfigs-2026-CAXXX-000001",
        kind: "official",
        name: "Test Fire",
        confidence: 100,
        officialSince: new Date(NOW - 3_600_000).toISOString(),
      },
    };
    const perimeter = {
      incidentId: official.id,
      geom: { type: "Polygon" as const, coordinates: [ring] },
      acres: 2000,
      agency: "NIFC",
      publishedAt: new Date(NOW - 3_600_000).toISOString(),
    };
    await engine.ingestOfficial([official], [perimeter], NOW);
    // The same publication again is not a new revision.
    await engine.ingestOfficial([official], [perimeter], NOW);
    expect(await store.perimeters()).toHaveLength(1);

    const merged = await engine.run(NOW);
    expect(merged.merged).toBe(1);
    const merges = await store.merges();
    expect(merges[0]).toMatchObject({ estimateId: estimate.id, officialId: official.id });

    await engine.retireOfficial(new Set(), "wfigs-");
    await store.close();
  });

  it("stores accounts, places, subscriptions and deduped alerts", async () => {
    const store = new PostgresStore(url!);
    await store.init();
    const accounts = new PostgresAccountStore(store.db);
    const user = await accounts.createUser({ username: `pg${Date.now() % 100000}`, passwordHash: "scrypt$x" });
    await expect(accounts.createUser({ username: user.username.toUpperCase().toLowerCase(), passwordHash: null })).rejects.toThrow(
      /taken/,
    );
    expect((await accounts.userByUsername(user.username.toUpperCase()))?.id).toBe(user.id);

    await accounts.createSession("hash-1", user.id, new Date(Date.now() + 60_000).toISOString(), "test");
    expect((await accounts.sessionUser("hash-1", Date.now(), new Date(Date.now() + 120_000).toISOString()))?.id).toBe(user.id);
    expect(await accounts.sessionUser("hash-1", Date.now() + 600_000, new Date().toISOString())).toBeNull();

    const place = await accounts.createPlace(user.id, { name: "Home", lat: 39.76, lon: -121.62, radiusKm: 25 });
    expect(place).toMatchObject({ lat: 39.76, lon: -121.62, radiusKm: 25 });
    const updated = await accounts.updateSettings(user.id, { quietStartMin: 1320, quietEndMin: 420, timezone: "America/Denver" });
    expect(updated).toMatchObject({ quietStartMin: 1320, quietEndMin: 420, timezone: "America/Denver" });
    const watchers = await accounts.watchers();
    expect(watchers.find((w) => w.id === place.id)?.settings.timezone).toBe("America/Denver");

    await accounts.saveSubscription(user.id, { endpoint: "https://push.example/a", p256dh: "k", auth: "a", userAgent: null });
    await accounts.saveSubscription(user.id, { endpoint: "https://push.example/a", p256dh: "k2", auth: "a2", userAgent: null });
    expect(await accounts.subscriptions(user.id)).toHaveLength(1);

    const draft = {
      userId: user.id,
      placeId: place.id,
      kind: "new_fire" as const,
      subjectId: "fire-1",
      revision: "official",
      severity: "info" as const,
      title: "t",
      body: "b",
      url: "/",
    };
    expect(await accounts.insertAlerts([draft, { ...draft, subjectId: "fire-2", severity: "urgent" }])).toHaveLength(2);
    expect(await accounts.insertAlerts([draft])).toHaveLength(0);
    const due = await accounts.dueAlerts(new Date(Date.now() + 1000).toISOString(), 10);
    expect(due.map((a) => a.subjectId)).toEqual(["fire-2", "fire-1"]);
    await accounts.markAlert(due[0]!.id, { status: "sent" });
    await accounts.markAlert(due[1]!.id, { status: "pending", error: "503", retryAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(await accounts.sentCountSince(user.id, new Date(Date.now() - 60_000).toISOString())).toBe(1);
    expect(await accounts.dueAlerts(new Date(Date.now() + 1000).toISOString(), 10)).toHaveLength(0);

    await accounts.deleteUser(user.id);
    expect(await accounts.places(user.id)).toHaveLength(0);
    await store.close();
  });
});
