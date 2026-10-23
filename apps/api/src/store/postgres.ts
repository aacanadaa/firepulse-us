import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { IncidentFeature, RawSignal } from "@firepulse/protocol";
import type { FusionAudit, MergeRecord, OfficialPerimeterRecord, Store } from "./types.js";

const { Pool } = pg;

/** db/migrations, from both src/store (tsx) and dist/store (node). */
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));

type IncidentRow = {
  id: string;
  kind: "estimated" | "official";
  status: string;
  name: string;
  geom: string;
  confidence: string;
  confidence_breakdown: unknown;
  sources: unknown;
  h3_cells: string[];
  area_sq_km: string;
  area_acres: string;
  frp: number;
  hotspot_count: number;
  growth_acres_hour: number;
  growth_frp_hour: number;
  growth_score: number;
  first_detected_at: Date;
  last_signal_at: Date;
  updated_at: Date;
  official_since: Date | null;
  merged_into: string | null;
  agency: string | null;
  external_id: string | null;
  containment: number | null;
  cause: string | null;
  county: string | null;
  state: string | null;
  confirmation: string | null;
  lon: number;
  lat: number;
  evidence: unknown;
};

/**
 * PostGIS-backed store. Batch writes go through `jsonb_to_recordset` — one
 * round trip per flush regardless of batch size. The fusion engine is the
 * only writer of incidents; signals are append-only.
 */
export class PostgresStore implements Store {
  readonly kind = "postgres" as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 12,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 4_000,
      application_name: "firepulse-api",
    });
  }

  async init(): Promise<void> {
    await this.pool.query("select 1");
    await this.migrate();
  }

  /**
   * Applies db/migrations/*.sql in name order, once each, each in its own
   * transaction. A database set up by hand or by the Docker init folder
   * before this table existed already has 001.
   */
  /** Shared with the account store, so both use one connection pool. */
  get db(): pg.Pool {
    return this.pool;
  }

  async migrate(dir = MIGRATIONS_DIR): Promise<string[]> {
    const files = readdirSync(dir)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    const client = await this.pool.connect();
    const applied: string[] = [];
    try {
      // One API instance migrates at a time.
      await client.query("select pg_advisory_lock(hashtext('firepulse.migrate'))");
      await client.query(`create schema if not exists firepulse;
        create table if not exists firepulse.schema_migration (
          name text primary key,
          applied_at timestamptz not null default now()
        )`);
      const { rows } = await client.query<{ name: string }>("select name from firepulse.schema_migration");
      const done = new Set(rows.map((r) => r.name));
      if (done.size === 0) {
        const { rows: existing } = await client.query("select to_regclass('firepulse.fire_incident') as t");
        if (existing[0]?.t && files[0]) {
          await client.query("insert into firepulse.schema_migration (name) values ($1)", [files[0]]);
          done.add(files[0]);
        }
      }
      for (const file of files) {
        if (done.has(file)) continue;
        await client.query("begin");
        try {
          await client.query(readFileSync(`${dir}/${file}`, "utf8"));
          await client.query("insert into firepulse.schema_migration (name) values ($1)", [file]);
          await client.query("commit");
          applied.push(file);
        } catch (err) {
          await client.query("rollback");
          throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      await client.query("select pg_advisory_unlock(hashtext('firepulse.migrate'))").catch(() => undefined);
      client.release();
    }
    return applied;
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("select 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async insertSignals(signals: RawSignal[]): Promise<RawSignal[]> {
    if (signals.length === 0) return [];
    const rows = signals.map((s) => ({
      source: s.source,
      kind: s.kind,
      tier: s.tier ?? 1,
      lon: s.lon,
      lat: s.lat,
      observed_at: s.observedAt,
      frp: s.frp ?? null,
      provider_confidence: s.providerConfidence ?? null,
      bearing: s.bearing ?? null,
      distance_m: s.distanceM ?? null,
      label: s.label ?? null,
      h3: s.h3 ?? null,
      dedupe_key: (s.meta?.dedupeKey as string | undefined) ?? s.id,
      payload: s.meta ?? {},
    }));
    const res = await this.pool.query(
      `insert into firepulse.raw_signal
         (source, kind, tier, geom, observed_at, frp, provider_confidence,
          bearing, distance_m, label, h3, dedupe_key, payload)
       select x.source::firepulse.signal_source, x.kind, x.tier,
              st_setsrid(st_makepoint(x.lon, x.lat), 4326),
              x.observed_at, x.frp, x.provider_confidence, x.bearing,
              x.distance_m, x.label, x.h3, x.dedupe_key, x.payload
         from jsonb_to_recordset($1::jsonb) as x(
           source text, kind text, tier smallint,
           lon double precision, lat double precision, observed_at timestamptz,
           frp real, provider_confidence real, bearing smallint, distance_m integer,
           label text, h3 text, dedupe_key text, payload jsonb)
       on conflict (source, dedupe_key) do nothing
       returning source, dedupe_key`,
      [JSON.stringify(rows)],
    );
    const fresh = new Set(res.rows.map((r: { source: string; dedupe_key: string }) => `${r.source}:${r.dedupe_key}`));
    return signals.filter((s, i) => fresh.delete(`${s.source}:${rows[i]!.dedupe_key}`));
  }

  async recentSignals(sinceMs: number, untilMs?: number): Promise<RawSignal[]> {
    const { rows } = await this.pool.query(
      `select id, source, kind, tier,
              st_x(geom) as lon, st_y(geom) as lat,
              observed_at, received_at, frp, provider_confidence,
              bearing, distance_m, label, h3, payload
         from firepulse.raw_signal
        where observed_at >= to_timestamp($1 / 1000.0)
          and ($2::timestamptz is null or observed_at <= $2::timestamptz)
        order by observed_at asc`,
      [sinceMs, untilMs ? new Date(untilMs).toISOString() : null],
    );
    return rows.map(mapSignal);
  }

  async signalsForIncident(id: string, limit = 250): Promise<RawSignal[]> {
    const { rows } = await this.pool.query(
      `select s.id, s.source, s.kind, s.tier,
              st_x(s.geom) as lon, st_y(s.geom) as lat,
              s.observed_at, s.received_at, s.frp, s.provider_confidence,
              s.bearing, s.distance_m, s.label, s.h3, s.payload
         from firepulse.incident_signal ins
         join firepulse.raw_signal s on s.id = ins.signal_id
        where ins.incident_id = $1
        order by s.observed_at asc
        limit $2`,
      [id, limit],
    );
    return rows.map(mapSignal);
  }

  async purgeSignals(olderThan: Date): Promise<number> {
    const { rowCount } = await this.pool.query(
      `delete from firepulse.raw_signal where observed_at < $1`,
      [olderThan.toISOString()],
    );
    return rowCount ?? 0;
  }

  async upsertIncidents(incidents: IncidentFeature[]): Promise<void> {
    if (incidents.length === 0) return;
    const rows = incidents.map((f) => {
      const p = f.properties;
      return {
        id: p.id,
        kind: p.kind,
        status: p.status,
        name: p.name,
        geom: f.geometry,
        lon: p.lon,
        lat: p.lat,
        confidence: p.confidence,
        confidence_breakdown: p.confidenceBreakdown,
        sources: p.sources,
        h3_cells: p.cells ?? [],
        area_sq_km: p.areaSqKm,
        area_acres: p.areaAcres,
        frp: p.frp,
        hotspot_count: p.hotspotCount,
        growth_acres_hour: p.growthAcresPerHour,
        growth_frp_hour: p.growthFrpPerHour,
        growth_score: p.growthScore,
        first_detected_at: p.firstDetectedAt,
        last_signal_at: p.updatedAt,
        official_since: p.officialSince ?? null,
        merged_into: p.mergedInto ?? null,
        agency: p.kind === "official" ? (p.sources[0]?.source ?? null) : null,
        external_id: null,
        containment: p.containment ?? null,
        cause: p.cause ?? null,
        county: p.county ?? null,
        state: p.state ?? null,
        confirmation: p.confirmation ?? null,
        active_from: p.officialSince ?? p.firstDetectedAt,
        active_to: p.kind === "estimated" && p.status === "merged" ? p.updatedAt : null,
        evidence: p.evidence,
      };
    });

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into firepulse.fire_incident as i
           (id, kind, status, name, geom, centroid, confidence, confidence_breakdown,
            sources, h3_cells, area_sq_km, area_acres, frp, hotspot_count,
            growth_acres_hour, growth_frp_hour, growth_score, first_detected_at,
            last_signal_at, official_since, merged_into, is_active, agency,
            external_id, containment, cause, county, state, confirmation, active_from, active_to)
         select x.id, x.kind::firepulse.incident_kind, x.status::firepulse.incident_status,
                x.name,
                st_setsrid(st_geomfromgeojson(x.geom::text), 4326),
                st_setsrid(st_makepoint(x.lon, x.lat), 4326),
                x.confidence, x.confidence_breakdown, x.sources, x.h3_cells,
                x.area_sq_km, x.area_acres, x.frp, x.hotspot_count,
                x.growth_acres_hour, x.growth_frp_hour, x.growth_score,
                x.first_detected_at, x.last_signal_at, x.official_since,
                x.merged_into, true, x.agency, x.external_id, x.containment,
                x.cause, x.county, x.state, x.confirmation, x.active_from, x.active_to
           from jsonb_to_recordset($1::jsonb) as x(
             id text, kind text, status text, name text, geom jsonb,
             lon double precision, lat double precision,
             confidence numeric, confidence_breakdown jsonb, sources jsonb,
             h3_cells text[], area_sq_km numeric, area_acres numeric, frp real,
             hotspot_count integer, growth_acres_hour real, growth_frp_hour real,
             growth_score real, first_detected_at timestamptz, last_signal_at timestamptz,
             official_since timestamptz, merged_into text, agency text, external_id text,
             containment smallint, cause text, county text, state text, confirmation text,
             active_from timestamptz, active_to timestamptz, evidence jsonb)
         on conflict (id) do update set
           status = excluded.status,
           name = excluded.name,
           geom = excluded.geom,
           centroid = excluded.centroid,
           confidence = excluded.confidence,
           confidence_breakdown = excluded.confidence_breakdown,
           sources = excluded.sources,
           h3_cells = excluded.h3_cells,
           area_sq_km = excluded.area_sq_km,
           area_acres = excluded.area_acres,
           frp = excluded.frp,
           hotspot_count = excluded.hotspot_count,
           growth_acres_hour = excluded.growth_acres_hour,
           growth_frp_hour = excluded.growth_frp_hour,
           growth_score = excluded.growth_score,
           first_detected_at = least(i.first_detected_at, excluded.first_detected_at),
           last_signal_at = excluded.last_signal_at,
           official_since = coalesce(i.official_since, excluded.official_since),
           merged_into = excluded.merged_into,
           is_active = excluded.is_active,
           containment = excluded.containment,
           cause = excluded.cause,
           county = coalesce(excluded.county, i.county),
           state = coalesce(excluded.state, i.state),
           confirmation = excluded.confirmation,
           active_to = excluded.active_to`,
        [JSON.stringify(rows)],
      );

      // Evidence is rewritten per incident, cheapest correct approach.
      const evidenceRows = incidents.flatMap((f) =>
        f.properties.evidence.map((e) => ({
          incident_id: f.properties.id,
          source: e.source,
          modality: e.modality,
          signal_count: e.count,
          contribution: e.contribution,
          effective: e.effective,
          first_seen: e.firstSeen,
          last_seen: e.lastSeen,
          sample: e.sample ?? null,
        })),
      );
      if (evidenceRows.length > 0) {
        await client.query(
          `delete from firepulse.incident_evidence
            where incident_id = any($1::text[])`,
          [incidents.map((f) => f.properties.id)],
        );
        await client.query(
          `insert into firepulse.incident_evidence
             (incident_id, source, modality, signal_count, contribution, effective,
              first_seen, last_seen, sample)
           select x.incident_id, x.source::firepulse.signal_source, x.modality,
                  x.signal_count, x.contribution, x.effective, x.first_seen,
                  x.last_seen, x.sample
             from jsonb_to_recordset($1::jsonb) as x(
               incident_id text, source text, modality text, signal_count integer,
               contribution numeric, effective numeric, first_seen timestamptz,
               last_seen timestamptz, sample text)
           on conflict (incident_id, source) do update set
             signal_count = excluded.signal_count,
             contribution = excluded.contribution,
             effective = excluded.effective,
             last_seen = excluded.last_seen,
             sample = excluded.sample`,
          [JSON.stringify(evidenceRows)],
        );
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  async deactivateIncidents(ids: string[], reason: "expired" | "merged"): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      `update firepulse.fire_incident
          set is_active = false,
              active_to = now(),
              status = case when $2 = 'merged' then 'merged'::firepulse.incident_status else status end
        where id = any($1::text[])`,
      [ids, reason],
    );
  }

  async activeIncidents(): Promise<IncidentFeature[]> {
    const { rows } = await this.pool.query<IncidentRow>(
      `select i.*, st_asgeojson(i.geom) as geom,
              st_x(i.centroid) as lon, st_y(i.centroid) as lat,
              coalesce((select jsonb_agg(jsonb_build_object(
                         'source', e.source, 'modality', e.modality,
                         'count', e.signal_count, 'contribution', e.contribution,
                         'effective', e.effective, 'firstSeen', e.first_seen,
                         'lastSeen', e.last_seen, 'sample', e.sample))
                        from firepulse.incident_evidence e
                       where e.incident_id = i.id), '[]'::jsonb) as evidence
         from firepulse.fire_incident i
        where i.is_active
        order by i.growth_score desc`,
    );
    return rows.map(mapIncident);
  }

  async incidentById(id: string): Promise<IncidentFeature | null> {
    const { rows } = await this.pool.query<IncidentRow>(
      `select i.*, st_asgeojson(i.geom) as geom,
              st_x(i.centroid) as lon, st_y(i.centroid) as lat
         from firepulse.fire_incident i where i.id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? mapIncident(row) : null;
  }

  async insertPerimeter(p: OfficialPerimeterRecord): Promise<void> {
    const { rows } = await this.pool.query<{ revision: number; unchanged: boolean }>(
      `select coalesce(max(revision), 0) + 1 as revision,
              coalesce(bool_or(valid_to is null and published_at = $2::timestamptz), false) as unchanged
         from firepulse.official_perimeter where incident_id = $1`,
      [p.incidentId, p.publishedAt],
    );
    // WFIGS republishes every incident on every poll; only a new
    // publication time is a new revision.
    if (rows[0]?.unchanged) return;
    const revision = rows[0]?.revision ?? 1;
    await this.pool.query(
      `insert into firepulse.official_perimeter
         (incident_id, geom, area_acres, agency, source, revision,
          published_at, valid_from, valid_to)
       values ($1, st_setsrid(st_geomfromgeojson($2), 4326), $3, $4, 'nifc',
               $5, $6, $7, $8)`,
      [
        p.incidentId,
        JSON.stringify(p.geom),
        p.acres,
        p.agency,
        revision,
        p.publishedAt,
        p.validFrom,
        p.validTo,
      ],
    );
  }

  async perimeters(): Promise<OfficialPerimeterRecord[]> {
    const { rows } = await this.pool.query(
      `select id, incident_id, st_asgeojson(geom) as geom, area_acres, agency,
              published_at, valid_from, valid_to
         from firepulse.official_perimeter
        order by published_at asc`,
    );
    return rows.map((r) => ({
      id: String(r.id),
      incidentId: r.incident_id,
      geom: JSON.parse(r.geom),
      acres: r.area_acres == null ? null : Number(r.area_acres),
      agency: r.agency,
      publishedAt: new Date(r.published_at).toISOString(),
      validFrom: new Date(r.valid_from).toISOString(),
      validTo: r.valid_to ? new Date(r.valid_to).toISOString() : null,
    }));
  }

  async recordMerge(m: MergeRecord): Promise<void> {
    await this.pool.query(
      `insert into firepulse.estimate_merge
         (estimate_id, official_id, merged_at, first_detected_at, official_since,
          lead_time_minutes, peak_confidence, distance_km, match_method)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (estimate_id, official_id) do nothing`,
      [
        m.estimateId,
        m.officialId,
        m.mergedAt,
        m.firstDetectedAt,
        m.officialSince,
        m.leadTimeMinutes,
        m.peakConfidence,
        m.distanceKm,
        m.matchMethod,
      ],
    );
  }

  async merges(): Promise<MergeRecord[]> {
    const { rows } = await this.pool.query(
      `select estimate_id, official_id, merged_at, first_detected_at, official_since,
              lead_time_minutes, peak_confidence, distance_km, match_method
         from firepulse.estimate_merge order by merged_at asc`,
    );
    return rows.map((r) => ({
      estimateId: r.estimate_id,
      officialId: r.official_id,
      mergedAt: new Date(r.merged_at).toISOString(),
      firstDetectedAt: new Date(r.first_detected_at).toISOString(),
      officialSince: new Date(r.official_since).toISOString(),
      leadTimeMinutes: Number(r.lead_time_minutes),
      peakConfidence: Number(r.peak_confidence),
      distanceKm: Number(r.distance_km),
      matchMethod: r.match_method,
    }));
  }

  async recordFusionRun(a: FusionAudit): Promise<void> {
    await this.pool.query(
      `insert into firepulse.fusion_run
         (started_at, duration_ms, signals_considered, clusters_formed,
          incidents_created, incidents_updated, incidents_merged,
          radius_m, window_minutes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        a.startedAt,
        a.durationMs,
        a.signalsConsidered,
        a.clustersFormed,
        a.incidentsCreated,
        a.incidentsUpdated,
        a.incidentsMerged,
        a.radiusM,
        a.windowMinutes,
      ],
    );
  }
}

function mapSignal(r: Record<string, unknown>): RawSignal {
  return {
    id: r.id as string,
    source: r.source as RawSignal["source"],
    kind: r.kind as RawSignal["kind"],
    tier: Number(r.tier) as RawSignal["tier"],
    lon: Number(r.lon),
    lat: Number(r.lat),
    observedAt: new Date(r.observed_at as string).toISOString(),
    receivedAt: new Date(r.received_at as string).toISOString(),
    frp: r.frp == null ? undefined : Number(r.frp),
    providerConfidence: r.provider_confidence == null ? undefined : Number(r.provider_confidence),
    bearing: r.bearing == null ? undefined : Number(r.bearing),
    distanceM: r.distance_m == null ? undefined : Number(r.distance_m),
    label: (r.label as string) ?? undefined,
    h3: (r.h3 as string) ?? undefined,
    meta: (r.payload as Record<string, unknown>) ?? {},
  };
}

function mapIncident(r: IncidentRow): IncidentFeature {
  const geom = typeof r.geom === "string" ? JSON.parse(r.geom) : r.geom;
  return {
    type: "Feature",
    id: r.id,
    geometry: geom,
    properties: {
      id: r.id,
      kind: r.kind,
      name: r.name,
      status: r.status as IncidentFeature["properties"]["status"],
      confidence: Number(r.confidence),
      confidenceBreakdown: r.confidence_breakdown as IncidentFeature["properties"]["confidenceBreakdown"],
      sources: (r.sources as IncidentFeature["properties"]["sources"]) ?? [],
      firstDetectedAt: new Date(r.first_detected_at).toISOString(),
      // updated_at is when the row was last written; last_signal_at is the newest evidence.
      updatedAt: new Date(r.last_signal_at).toISOString(),
      areaAcres: Number(r.area_acres),
      areaSqKm: Number(r.area_sq_km),
      frp: Number(r.frp),
      growthAcresPerHour: Number(r.growth_acres_hour),
      growthFrpPerHour: Number(r.growth_frp_hour),
      growthScore: Number(r.growth_score),
      hotspotCount: Number(r.hotspot_count),
      evidence: (r.evidence as IncidentFeature["properties"]["evidence"]) ?? [],
      mergedInto: r.merged_into ?? undefined,
      officialSince: r.official_since ? new Date(r.official_since).toISOString() : undefined,
      containment: r.containment ?? undefined,
      cause: (r.cause as IncidentFeature["properties"]["cause"]) ?? undefined,
      county: r.county ?? undefined,
      state: r.state ?? undefined,
      confirmation: (r.confirmation as IncidentFeature["properties"]["confirmation"]) ?? undefined,
      cells: r.h3_cells ?? [],
      lat: Number(r.lat),
      lon: Number(r.lon),
    },
  };
}
