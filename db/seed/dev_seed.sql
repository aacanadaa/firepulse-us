-- ---------------------------------------------------------------------------
-- FirePulse US — minimal development seed
-- Two official incidents with SOHO-style perimeters and a little raw evidence.
-- Run after 001_init.sql:  psql "$DATABASE_URL" -f db/seed/dev_seed.sql
-- ---------------------------------------------------------------------------
set search_path = firepulse, public;

insert into firepulse.fire_incident
  (id, kind, status, name, geom, centroid, confidence, confidence_breakdown,
   sources, h3_cells, area_sq_km, area_acres, frp, hotspot_count,
   growth_acres_hour, growth_frp_hour, growth_score,
   first_detected_at, last_signal_at, official_since, is_active,
   agency, external_id, containment, cause, county, state, active_from)
values
  (
    '11111111-1111-4111-8111-111111111111',
    'official', 'holding', 'Ridge Fire',
    st_setsrid(st_geomfromgeojson('{
      "type": "Polygon",
      "coordinates": [[
        [-119.360,34.450],[-119.330,34.438],[-119.280,34.452],
        [-119.268,34.486],[-119.300,34.514],[-119.348,34.506],
        [-119.362,34.478],[-119.360,34.450]
      ]]
    }'), 4326),
    st_setsrid(st_makepoint(-119.311, 34.478), 4326),
    100, '{"score":100,"fused":1,"corroboration":1,"freshness":1,"distinctModalities":1,"evidenceCount":1,"rationale":"Official government ground truth"}',
    '[{"source":"nifc","count":1,"lastSeen":"2026-10-20T09:00:00Z"}]',
    array['88283082a9fffff','88283082abfffff'],
    12.4, 3064, 0, 0, 40, 0, 18,
    now() - interval '9 hours', now() - interval '8 minutes',
    now() - interval '8 hours 30 minutes', true,
    'NIFC', '2026-CA-VNC-0001', 35, 'powerline', 'Ventura', 'CA',
    now() - interval '8 hours 30 minutes'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'official', 'holding', 'Cedar Fire',
    st_setsrid(st_geomfromgeojson('{
      "type": "Polygon",
      "coordinates": [[
        [-122.030,37.160],[-121.990,37.150],[-121.955,37.176],
        [-121.962,37.208],[-122.005,37.214],[-122.032,37.190],
        [-122.030,37.160]
      ]]
    }'), 4326),
    st_setsrid(st_makepoint(-121.992, 37.183), 4326),
    100, '{"score":100,"fused":1,"corroboration":1,"freshness":1,"distinctModalities":1,"evidenceCount":1,"rationale":"Official government ground truth"}',
    '[{"source":"calfire","count":1,"lastSeen":"2026-10-20T10:15:00Z"}]',
    array['8828308281fffff'],
    5.1, 1260, 0, 0, 12, 0, 9,
    now() - interval '4 hours', now() - interval '12 minutes',
    now() - interval '3 hours 20 minutes', true,
    'CAL FIRE', '2026-CA-SCU-0007', 20, 'vegetation', 'Santa Clara', 'CA',
    now() - interval '3 hours 20 minutes'
  )
on conflict (id) do nothing;

-- SCD-2 perimeter revisions
insert into firepulse.official_perimeter
  (incident_id, geom, area_acres, agency, source, revision, published_at, valid_from, valid_to)
values
  (
    '11111111-1111-4111-8111-111111111111',
    st_setsrid(st_geomfromgeojson('{
      "type": "MultiPolygon",
      "coordinates": [[[
        [-119.360,34.450],[-119.330,34.438],[-119.280,34.452],
        [-119.268,34.486],[-119.300,34.514],[-119.348,34.506],
        [-119.362,34.478],[-119.360,34.450]
      ]]]
    }'), 4326),
    3064, 'NIFC', 'nifc', 1,
    now() - interval '8 hours 30 minutes',
    now() - interval '8 hours 30 minutes',
    null
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    st_setsrid(st_geomfromgeojson('{
      "type": "MultiPolygon",
      "coordinates": [[[
        [-122.030,37.160],[-121.990,37.150],[-121.955,37.176],
        [-121.962,37.208],[-122.005,37.214],[-122.032,37.190],
        [-122.030,37.160]
      ]]]
    }'), 4326),
    1260, 'CAL FIRE', 'calfire', 1,
    now() - interval '3 hours 20 minutes',
    now() - interval '3 hours 20 minutes',
    null
  )
on conflict (incident_id, revision) do nothing;

-- A few thermal and dispatch observations around the Ridge Fire.
select firepulse.ingest_signal(
  'goes18', 'thermal', 2, -119.31, 34.48, now() - interval '6 minutes',
  'seed-goes-1', 42.5, 0.88, null, null, 'GOES-18 ABI hotspot', '88283082a9fffff',
  '{"synthetic": true}'::jsonb
);
select firepulse.ingest_signal(
  'viirs', 'thermal', 2, -119.30, 34.49, now() - interval '18 minutes',
  'seed-viirs-1', 26.0, 0.82, null, null, 'VIIRS 375m', '88283082a9fffff',
  '{"synthetic": true}'::jsonb
);
select firepulse.ingest_signal(
  'cad', 'dispatch', 1, -119.31, 34.48, now() - interval '7 hours 55 minutes',
  'seed-cad-1', null, 0.85, null, null, 'VEGETATION FIRE - Matilija Canyon Rd',
  '88283082a9fffff', '{"units": 4, "county": "Ventura", "state": "CA"}'::jsonb
);

insert into firepulse.incident_evidence
  (incident_id, source, modality, signal_count, contribution, effective, first_seen, last_seen, sample)
values
  ('11111111-1111-4111-8111-111111111111', 'goes18', 'satellite-thermal', 6, 0.60, 0.57,
   now() - interval '30 minutes', now() - interval '6 minutes', 'GOES-18 ABI hotspot'),
  ('11111111-1111-4111-8111-111111111111', 'viirs', 'satellite-thermal', 3, 0.56, 0.54,
   now() - interval '40 minutes', now() - interval '18 minutes', 'VIIRS 375m'),
  ('11111111-1111-4111-8111-111111111111', 'cad', 'dispatch', 2, 0.55, 0.51,
   now() - interval '8 hours', now() - interval '7 hours 55 minutes', 'VEGETATION FIRE')
on conflict (incident_id, source) do nothing;

select 'seeded' as status,
       (select count(*) from firepulse.fire_incident) as incidents,
       (select count(*) from firepulse.raw_signal) as signals;
