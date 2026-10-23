-- =====================================================================
--  002 — incident ids are text
--
--  Official incidents keep their source id (e.g. "wfigs-2026-CABDU-001234"),
--  which is not a UUID, so every insert of a live WFIGS incident failed.
--  Estimates still get random UUIDs, now stored as text.
-- =====================================================================

drop view if exists firepulse.v_active_incidents;
drop function if exists firepulse.match_estimate(geometry, text[], integer);

alter table firepulse.incident_signal    drop constraint if exists incident_signal_incident_id_fkey;
alter table firepulse.incident_evidence  drop constraint if exists incident_evidence_incident_id_fkey;
alter table firepulse.fire_incident      drop constraint if exists fire_incident_merged_into_fkey;
alter table firepulse.official_perimeter drop constraint if exists official_perimeter_incident_id_fkey;
alter table firepulse.estimate_merge     drop constraint if exists estimate_merge_estimate_id_fkey;
alter table firepulse.estimate_merge     drop constraint if exists estimate_merge_official_id_fkey;

alter table firepulse.fire_incident
  alter column id drop default,
  alter column id type text using id::text,
  alter column id set default gen_random_uuid()::text,
  alter column merged_into type text using merged_into::text;
alter table firepulse.incident_signal    alter column incident_id type text using incident_id::text;
alter table firepulse.incident_evidence  alter column incident_id type text using incident_id::text;
alter table firepulse.official_perimeter alter column incident_id type text using incident_id::text;
alter table firepulse.estimate_merge
  alter column estimate_id type text using estimate_id::text,
  alter column official_id type text using official_id::text;

alter table firepulse.fire_incident
  add constraint fire_incident_merged_into_fkey
  foreign key (merged_into) references firepulse.fire_incident (id) on delete set null;
alter table firepulse.incident_signal
  add constraint incident_signal_incident_id_fkey
  foreign key (incident_id) references firepulse.fire_incident (id) on delete cascade;
alter table firepulse.incident_evidence
  add constraint incident_evidence_incident_id_fkey
  foreign key (incident_id) references firepulse.fire_incident (id) on delete cascade;
alter table firepulse.official_perimeter
  add constraint official_perimeter_incident_id_fkey
  foreign key (incident_id) references firepulse.fire_incident (id) on delete cascade;
alter table firepulse.estimate_merge
  add constraint estimate_merge_estimate_id_fkey
  foreign key (estimate_id) references firepulse.fire_incident (id) on delete cascade,
  add constraint estimate_merge_official_id_fkey
  foreign key (official_id) references firepulse.fire_incident (id) on delete cascade;

-- Fusion passes take fractions of a millisecond more or less; keep them.
alter table firepulse.fusion_run alter column duration_ms type real;

create or replace function firepulse.match_estimate(
  p_centroid  geometry(Point, 4326),
  p_h3_cells  text[],
  p_max_km    integer default 3
)
returns table (incident_id text, distance_km real, cell_overlap integer)
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

create or replace view firepulse.v_active_incidents as
select i.id, i.kind, i.name, i.confidence, i.area_acres, i.growth_score,
       i.first_detected_at, i.last_signal_at, i.official_since, i.sources,
       st_x(i.centroid) as lon, st_y(i.centroid) as lat
  from firepulse.fire_incident i
 where i.is_active
 order by i.growth_score desc;
