-- =====================================================================
--  FirePulse US — core schema
--  PostgreSQL 15+ / PostGIS 3.3+
--
--  Conventions
--    * Geometry is stored in EPSG:4326 for transport; every table that
--      does distance/area work also carries a generated EPSG:5070
--      (CONUS Albers, metres) column so buffers, areas and DBSCAN run in
--      metric space without per-query transforms.
--    * Time is always timestamptz. `observed_at` is when the phenomenon
--      happened, `received_at` is when FirePulse saw it. The gap between
--      them is the pipeline latency we optimise.
--    * Confidence is computed in TypeScript (single source of truth,
--      packages/protocol/src/confidence.ts) and persisted with its full
--      breakdown. The database is the system of record, not the scorer.
--    * Official perimeters are revisioned (SCD-2) so the time scrubber
--      can ask "what did we know at 14:05?" without a replay log.
-- =====================================================================

create extension if not exists postgis;
create extension if not exists pgcrypto;      -- gen_random_uuid()
create extension if not exists pg_trgm;       -- incident name search

create schema if not exists firepulse;
set search_path = firepulse, public;

-- ---------------------------------------------------------------------
-- Enumerated domains
-- ---------------------------------------------------------------------
do $$ begin
  create domain firepulse.signal_source as text
    check (value in (
      'cad','scanner','alertca','crowd',
      'goes16','goes18','viirs','modis',
      'purpleair','airnow','raws','nws',
      'wfigs','nifc','calfire'
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  create domain firepulse.incident_kind as text
    check (value in ('estimated','official'));
exception when duplicate_object then null; end $$;

do $$ begin
  create domain firepulse.incident_status as text
    check (value in ('detected','growing','holding','contained','merged'));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 1. Raw signals — the immutable firehose
--    Every tier lands here first, normalised but unopinionated.
-- ---------------------------------------------------------------------
create table if not exists firepulse.raw_signal (
  id                  uuid primary key default gen_random_uuid(),
  source              firepulse.signal_source not null,
  kind                text not null check (kind in (
                        'thermal','dispatch','camera','crowd',
                        'airquality','weather','official-point','official-perimeter')),
  tier                smallint not null check (tier between 1 and 4),
  geom                geometry(Point, 4326) not null,
  geom_5070           geometry(Point, 5070)
                        generated always as (st_transform(geom, 5070)) stored,
  h3                  text,                       -- H3 res 8 cell (~0.74 km²)
  observed_at         timestamptz not null,
  received_at         timestamptz not null default now(),
  ingested_at         timestamptz not null default now(),
  frp                 real,                       -- MW, thermal only
  provider_confidence real check (provider_confidence between 0 and 1),
  bearing             smallint check (bearing between 0 and 359),
  distance_m          integer,
  label               text,
  dedupe_key          text not null,              -- e.g. "goes18:2026-10-20T02:10Z:34.12,-118.44"
  payload             jsonb not null default '{}'::jsonb,
  -- fusion bookkeeping
  cluster_id          uuid,
  clustered_at        timestamptz,
  expires_at          timestamptz not null default now() + interval '24 hours',
  unique (source, dedupe_key)
);

create index if not exists raw_signal_geom_gix    on firepulse.raw_signal using gist (geom_5070);
create index if not exists raw_signal_obs_brin    on firepulse.raw_signal using brin (observed_at) with (pages_per_range = 32);
create index if not exists raw_signal_source_obs  on firepulse.raw_signal (source, observed_at desc);
create index if not exists raw_signal_unclustered on firepulse.raw_signal (observed_at desc)
  where cluster_id is null;
create index if not exists raw_signal_h3          on firepulse.raw_signal (h3) where h3 is not null;
create index if not exists raw_signal_expiry      on firepulse.raw_signal (expires_at);

comment on table firepulse.raw_signal is
  'Immutable normalised signals from all four ingestion tiers. Retained 24h hot, then rolled into signal_rollup_hourly.';

-- ---------------------------------------------------------------------
-- 2. Incidents — fused estimates and official ground truth in one table
--    Keeping both in one relation means the feed, the map and the diff
--    engine never need a union: `kind` is the discriminator.
-- ---------------------------------------------------------------------
create table if not exists firepulse.fire_incident (
  id                  uuid primary key default gen_random_uuid(),
  kind                firepulse.incident_kind not null,
  status              firepulse.incident_status not null default 'detected',
  name                text not null,
  geom                geometry(Polygon, 4326) not null,
  geom_5070           geometry(Polygon, 5070)
                        generated always as (st_transform(geom, 5070)) stored,
  centroid            geometry(Point, 4326) not null,
  centroid_5070       geometry(Point, 5070)
                        generated always as (st_transform(centroid, 5070)) stored,

  confidence          numeric(5,2) not null check (confidence between 0 and 100),
  confidence_breakdown jsonb not null default '{}'::jsonb,
  sources             jsonb not null default '[]'::jsonb,  -- [{source,count,lastSeen}]
  h3_cells            text[] not null default '{}',

  area_sq_km          numeric(10,3) not null default 0,
  area_acres          numeric(12,2)  not null default 0,
  frp                 real not null default 0,
  hotspot_count       integer not null default 0,
  growth_acres_hour   real not null default 0,
  growth_frp_hour     real not null default 0,
  growth_score        real not null default 0,

  first_detected_at   timestamptz not null,
  last_signal_at      timestamptz not null,
  updated_at          timestamptz not null default now(),
  official_since      timestamptz,
  merged_into         uuid references firepulse.fire_incident (id) on delete set null,
  is_active           boolean not null default true,

  -- official-only attributes
  agency              text,
  external_id         text,          -- WFIGS / CAL FIRE incident id
  containment         smallint check (containment between 0 and 100),
  cause               text,
  county              text,
  state               text,

  -- temporal validity for the time scrubber (open-ended while active)
  active_from         timestamptz not null,
  active_to           timestamptz,

  constraint fire_incident_official_has_since
    check (kind <> 'official' or official_since is not null),
  constraint fire_incident_external_unique unique (kind, external_id)
);

create index if not exists fire_incident_geom_gix     on firepulse.fire_incident using gist (geom_5070);
create index if not exists fire_incident_centroid_gix on firepulse.fire_incident using gist (centroid_5070);
create index if not exists fire_incident_feed         on firepulse.fire_incident (is_active, kind, growth_score desc);
create index if not exists fire_incident_detected_brin on firepulse.fire_incident using brin (first_detected_at);
create index if not exists fire_incident_h3_gin       on firepulse.fire_incident using gin (h3_cells);
create index if not exists fire_incident_name_trgm    on firepulse.fire_incident using gin (name gin_trgm_ops);
create index if not exists fire_incident_merge        on firepulse.fire_incident (merged_into)
  where merged_into is not null;

comment on table firepulse.fire_incident is
  'Fused fire objects. kind=estimated are algorithmic Early Active Fire Zones; kind=official are NIFC/WFIGS/CAL FIRE ground truth.';

-- ---------------------------------------------------------------------
-- 3. Evidence — why the engine believes an incident exists
-- ---------------------------------------------------------------------
create table if not exists firepulse.incident_evidence (
  incident_id         uuid not null references firepulse.fire_incident (id) on delete cascade,
  source              firepulse.signal_source not null,
  modality            text not null,
  signal_count        integer not null default 1,
  contribution        numeric(6,4) not null,
  effective           numeric(6,4) not null,
  first_seen          timestamptz not null,
  last_seen           timestamptz not null,
  sample              text,
  primary key (incident_id, source)
);

create index if not exists incident_evidence_last_seen
  on firepulse.incident_evidence (last_seen desc);

-- ---------------------------------------------------------------------
-- 4. Signal ↔ cluster membership (many-to-many, retention-bounded)
-- ---------------------------------------------------------------------
create table if not exists firepulse.incident_signal (
  incident_id         uuid not null references firepulse.fire_incident (id) on delete cascade,
  signal_id           uuid not null,
  added_at            timestamptz not null default now(),
  primary key (incident_id, signal_id)
);

create index if not exists incident_signal_signal on firepulse.incident_signal (signal_id);

-- ---------------------------------------------------------------------
-- 5. Official perimeters — SCD-2 revision history
--    Each revision closes the previous row's validity. The scrubber
--    joins on the evaluated-at timestamp to show when a perimeter was
--    actually drawn vs. when we detected heat.
-- ---------------------------------------------------------------------
create table if not exists firepulse.official_perimeter (
  id                  bigserial primary key,
  incident_id         uuid not null references firepulse.fire_incident (id) on delete cascade,
  geom                geometry(MultiPolygon, 4326) not null,
  geom_5070           geometry(MultiPolygon, 5070)
                        generated always as (st_transform(geom, 5070)) stored,
  area_acres          numeric(12,2),
  agency              text not null,
  source              firepulse.signal_source not null default 'nifc',
  revision            integer not null default 1,
  published_at        timestamptz not null,
  valid_from          timestamptz not null,
  valid_to            timestamptz,
  raw                 jsonb not null default '{}'::jsonb,
  unique (incident_id, revision)
);

create index if not exists official_perimeter_gix
  on firepulse.official_perimeter using gist (geom_5070);
create index if not exists official_perimeter_time
  on firepulse.official_perimeter (incident_id, valid_from desc);

-- Only one open revision per incident.
create unique index if not exists official_perimeter_one_open
  on firepulse.official_perimeter (incident_id) where valid_to is null;

-- ---------------------------------------------------------------------
-- 6. Early-estimate → official merge ledger
--    This table is the product's proof: how many minutes of warning did
--    the fusion engine give before the government mapped the fire?
-- ---------------------------------------------------------------------
create table if not exists firepulse.estimate_merge (
  id                  bigserial primary key,
  estimate_id         uuid not null references firepulse.fire_incident (id) on delete cascade,
  official_id         uuid not null references firepulse.fire_incident (id) on delete cascade,
  merged_at           timestamptz not null default now(),
  first_detected_at   timestamptz not null,
  official_since      timestamptz not null,
  lead_time_minutes   integer not null,
  peak_confidence     numeric(5,2) not null,
  distance_km         real not null,
  match_method        text not null check (match_method in ('containment','proximity','name')),
  unique (estimate_id, official_id)
);

create index if not exists estimate_merge_lead_idx
  on firepulse.estimate_merge (lead_time_minutes desc);

-- ---------------------------------------------------------------------
-- 7. Fusion audit trail
-- ---------------------------------------------------------------------
create table if not exists firepulse.fusion_run (
  id                  bigserial primary key,
  started_at          timestamptz not null default now(),
  duration_ms         integer not null,
  signals_considered  integer not null,
  clusters_formed     integer not null,
  incidents_created   integer not null,
  incidents_updated   integer not null,
  incidents_merged    integer not null,
  radius_m            integer not null,
  window_minutes      integer not null,
  notes               text
);

-- ---------------------------------------------------------------------
-- 8. Environmental grids (HRRR wind, stored as a coarse JSON grid)
-- ---------------------------------------------------------------------
create table if not exists firepulse.wind_field (
  id                  bigserial primary key,
  model               text not null default 'HRRR',
  valid_at            timestamptz not null,
  bbox                geometry(Polygon, 4326) not null,
  cols                smallint not null,
  rows                smallint not null,
  u                   real[] not null,
  v                   real[] not null,
  speed_max           real,
  created_at          timestamptz not null default now(),
  unique (model, valid_at)
);

-- ---------------------------------------------------------------------
-- 9. Hourly rollup — keeps 7 days of density data for the scrubber
--    without scanning 10^8 raw rows.
-- ---------------------------------------------------------------------
create table if not exists firepulse.signal_rollup_hourly (
  bucket              timestamptz not null,
  source              firepulse.signal_source not null,
  h3                  text not null,
  signal_count        integer not null default 0,
  frp_sum             real not null default 0,
  frp_max             real not null default 0,
  first_seen          timestamptz not null,
  last_seen           timestamptz not null,
  primary key (bucket, source, h3)
);

create index if not exists signal_rollup_bucket on firepulse.signal_rollup_hourly (bucket desc);

-- =====================================================================
--  Triggers
-- =====================================================================

create or replace function firepulse.touch_incident()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_touch_incident on firepulse.fire_incident;
create trigger trg_touch_incident
  before update on firepulse.fire_incident
  for each row execute function firepulse.touch_incident();

-- Close the previous perimeter revision whenever a new one is inserted.
create or replace function firepulse.close_perimeter_revision()
returns trigger language plpgsql as $$
begin
  update firepulse.official_perimeter
     set valid_to = new.valid_from
   where incident_id = new.incident_id
     and valid_to is null
     and id <> new.id;
  return new;
end $$;

drop trigger if exists trg_close_perimeter on firepulse.official_perimeter;
create trigger trg_close_perimeter
  before insert on firepulse.official_perimeter
  for each row execute function firepulse.close_perimeter_revision();

-- =====================================================================
--  Fusion queries
-- =====================================================================

-- 9a. Spatial DBSCAN over unclustered signals in metric space.
--     eps is metres (EPSG:5070). Signals older than the window are ignored
--     because a 2-hour-old GOES pixel must not join a fresh dispatch.
create or replace function firepulse.cluster_signals(
  p_radius_m      integer default 2000,
  p_window_min    integer default 30,
  p_min_points    integer default 1
)
returns table (
  cluster_no   bigint,
  members      uuid[],
  centroid     geometry(Point, 4326),
  sources      text[],
  signal_count integer,
  frp_sum      real,
  first_seen   timestamptz,
  last_seen    timestamptz
)
language sql stable as $$
  with candidates as (
    select s.id,
           s.geom,
           s.geom_5070,
           s.source::text as source,
           s.observed_at,
           s.frp
      from firepulse.raw_signal s
     where s.cluster_id is null
       and s.observed_at > now() - make_interval(mins => p_window_min)
       and s.expires_at > now()
  ),
  clustered as (
    select c.*,
           st_clusterdbscan(c.geom_5070, p_radius_m, p_min_points)
             over () as cluster_no
      from candidates c
  )
  select cluster_no,
         array_agg(id)                       as members,
         st_centroid(st_collect(geom))::geometry(Point,4326) as centroid,
         array_agg(distinct source)          as sources,
         count(*)::int                        as signal_count,
         coalesce(sum(frp), 0)::real          as frp_sum,
         min(observed_at)                     as first_seen,
         max(observed_at)                     as last_seen
    from clustered
   where cluster_no is not null
   group by cluster_no;
$$;

comment on function firepulse.cluster_signals is
  'ST_ClusterDBSCAN over the last N minutes of unclustered signals, in EPSG:5070 metres. cluster_no is NULL for noise.';

-- 9b. Existing estimates that a fresh cluster should fold into.
--     Matching is centroid distance + H3 overlap, so IDs stay stable
--     across fusion ticks (no flicker in the client diff stream).
create or replace function firepulse.match_estimate(
  p_centroid  geometry(Point, 4326),
  p_h3_cells  text[],
  p_max_km    integer default 3
)
returns table (incident_id uuid, distance_km real, cell_overlap integer)
language sql stable as $$
  select i.id,
         (st_distance(i.centroid_5070, st_transform(p_centroid, 5070)) / 1000.0)::real as distance_km,
         cardinality(array(select unnest(i.h3_cells) intersect select unnest(p_h3_cells))) as cell_overlap
    from firepulse.fire_incident i
   where i.kind = 'estimated'
     and i.is_active
     and i.merged_into is null
     and st_dwithin(i.centroid_5070, st_transform(p_centroid, 5070), p_max_km * 1000)
   order by cell_overlap desc, distance_km asc
   limit 1;
$$;

-- 9c. Merge every estimate that is now inside (or adjacent to) an official
--     perimeter. Idempotent; safe to run on every official ingest.
create or replace function firepulse.merge_estimates_into_official()
returns integer language plpgsql as $$
declare
  merged integer := 0;
  rec record;
begin
  for rec in
    select e.id           as estimate_id,
           e.first_detected_at,
           e.confidence,
           o.id           as official_id,
           o.official_since,
           st_distance(e.centroid_5070, o.centroid_5070) / 1000.0 as distance_km,
           case
             when st_intersects(o.geom_5070, e.centroid_5070) then 'containment'
             when st_dwithin(o.geom_5070, e.centroid_5070, 3000) then 'proximity'
             else 'name'
           end as method
      from firepulse.fire_incident e
      join lateral (
        select oi.id, oi.geom_5070, oi.centroid_5070, oi.official_since
          from firepulse.fire_incident oi
         where oi.kind = 'official'
           and oi.is_active
           and st_dwithin(oi.geom_5070, e.centroid_5070, 3000)
         order by st_distance(oi.centroid_5070, e.centroid_5070)
         limit 1
      ) o on true
     where e.kind = 'estimated'
       and e.is_active
       and e.merged_into is null
  loop
    update firepulse.fire_incident
       set merged_into = rec.official_id,
           status = 'merged',
           is_active = false,
           active_to = now()
     where id = rec.estimate_id;

    insert into firepulse.estimate_merge
      (estimate_id, official_id, first_detected_at, official_since,
       lead_time_minutes, peak_confidence, distance_km, match_method)
    values
      (rec.estimate_id, rec.official_id, rec.first_detected_at, rec.official_since,
       greatest(0, (extract(epoch from rec.official_since - rec.first_detected_at) / 60)::int),
       rec.confidence, rec.distance_km, rec.method)
    on conflict (estimate_id, official_id) do nothing;

    -- roll the early evidence up onto the official incident
    insert into firepulse.incident_evidence
      (incident_id, source, modality, signal_count, contribution, effective,
       first_seen, last_seen, sample)
    select rec.official_id, ev.source, ev.modality, ev.signal_count,
           ev.contribution, ev.effective, ev.first_seen, ev.last_seen,
           'precursor: ' || coalesce(ev.sample, ev.source::text)
      from firepulse.incident_evidence ev
     where ev.incident_id = rec.estimate_id
    on conflict (incident_id, source) do nothing;

    merged := merged + 1;
  end loop;
  return merged;
end $$;

-- 9d. Expire estimates whose evidence has gone cold.
create or replace function firepulse.expire_incidents(p_ttl_min integer default 180)
returns integer language plpgsql as $$
declare n integer;
begin
  update firepulse.fire_incident
     set is_active = false,
         status = case when kind = 'estimated' then 'merged' else status end,
         active_to = now()
   where is_active
     and kind = 'estimated'
     and merged_into is null
     and last_signal_at < now() - make_interval(mins => p_ttl_min);
  get diagnostics n = row_count;
  return n;
end $$;

-- 9e. Retain 24h of raw signals; roll the rest into hourly H3 buckets.
create or replace function firepulse.rollup_and_purge(p_keep_hours integer default 24)
returns integer language plpgsql as $$
declare n integer;
begin
  insert into firepulse.signal_rollup_hourly
    (bucket, source, h3, signal_count, frp_sum, frp_max, first_seen, last_seen)
  select date_trunc('hour', observed_at), source, coalesce(h3, ''),
         count(*), coalesce(sum(frp),0), coalesce(max(frp),0), min(observed_at), max(observed_at)
    from firepulse.raw_signal
   where observed_at < now() - make_interval(hours => p_keep_hours)
     and observed_at > now() - interval '8 days'
     and h3 is not null
   group by 1,2,3
  on conflict (bucket, source, h3) do update
     set signal_count = firepulse.signal_rollup_hourly.signal_count + excluded.signal_count,
         frp_sum = firepulse.signal_rollup_hourly.frp_sum + excluded.frp_sum,
         frp_max = greatest(firepulse.signal_rollup_hourly.frp_max, excluded.frp_max),
         last_seen = greatest(firepulse.signal_rollup_hourly.last_seen, excluded.last_seen);

  delete from firepulse.raw_signal
   where observed_at < now() - make_interval(hours => p_keep_hours);
  get diagnostics n = row_count;
  return n;
end $$;

-- =====================================================================
--  Views
-- =====================================================================

create or replace view firepulse.v_active_incidents as
select i.id, i.kind, i.name, i.confidence, i.area_acres, i.growth_score,
       i.first_detected_at, i.last_signal_at, i.official_since, i.sources,
       st_x(i.centroid) as lon, st_y(i.centroid) as lat
  from firepulse.fire_incident i
 where i.is_active
 order by i.growth_score desc;

create or replace view firepulse.v_lead_time as
select date_trunc('day', official_since) as day,
       count(*)                          as merges,
       round(avg(lead_time_minutes)::numeric, 1) as avg_lead_min,
       percentile_cont(0.5) within group (order by lead_time_minutes) as median_lead_min,
       max(lead_time_minutes)            as max_lead_min
  from firepulse.estimate_merge
 group by 1
 order by 1 desc;

-- =====================================================================
--  Ingestion helper: upsert a signal idempotently
-- =====================================================================
create or replace function firepulse.ingest_signal(
  p_source text, p_kind text, p_tier smallint,
  p_lon double precision, p_lat double precision,
  p_observed_at timestamptz, p_dedupe_key text,
  p_frp real default null, p_confidence real default null,
  p_bearing smallint default null, p_distance_m integer default null,
  p_label text default null, p_h3 text default null,
  p_payload jsonb default '{}'::jsonb
) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into firepulse.raw_signal
    (source, kind, tier, geom, observed_at, frp, provider_confidence,
     bearing, distance_m, label, h3, dedupe_key, payload)
  values
    (p_source::firepulse.signal_source, p_kind, p_tier,
     st_setsrid(st_makepoint(p_lon, p_lat), 4326), p_observed_at,
     p_frp, p_confidence, p_bearing, p_distance_m, p_label, p_h3,
     p_dedupe_key, p_payload)
  on conflict (source, dedupe_key) do update
     set observed_at = least(firepulse.raw_signal.observed_at, excluded.observed_at)
  returning id into v_id;
  return v_id;
end $$;
