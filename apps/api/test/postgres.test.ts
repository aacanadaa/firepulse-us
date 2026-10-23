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
    expect((await store.activeIncidents()).map((f) => f.id)).toContain(estimate.id);

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
});
