# FirePulse US

**Real-time wildfire detection that does not wait for the paperwork.**

Traditional wildfire maps show you fires the government has already surveyed and
published, often hours after ignition. FirePulse ingests the signals that exist
*now*: CAD dispatch, scanner audio, PTZ cameras, crowdsourced sightings, GOES and
VIIRS thermal anomalies, PM2.5 spikes and RAWS wind. It clusters them, scores
their convergence, and publishes **Early Active Fire Zones** alongside official
NIFC / CAL FIRE perimeters. When ground truth catches up, the estimate is absorbed
and the minutes of warning are recorded.

![FirePulse US](./docs/screenshot-global.png)

---

## Why it is different

| | Conventional wildfire map | FirePulse US |
|---|---|---|
| First signal | official perimeter (hours) | CAD / GOES / crowd (< 5 min) |
| Unknown fire | invisible | **Early Active Fire Zone** with 1–99% confidence |
| Confidence | binary | explainable noisy-OR with a full evidence breakdown |
| Official merge | n/a | automatic, with **lead-time ledger** |
| Transport | full dataset refetch | sequenced GeoJSON deltas over WebSocket |
| Thermal rendering | JSON markers | WebGL attribute layers, 20 k+ points |
| Time | "now" only | 24 h scrubber replaying heat vs. mapped perimeters |

The headline metric, **median head start**, is shown in the HUD and computed
from the merge ledger: `official_since − first_detected_at`.

---

## Feature tour

- **Editorial cartography.** A warm alabaster interface with 1px structural
  hairlines, Inter + JetBrains Mono, and exactly two data accents: **Forest**
  for surveyed ground truth, **International Orange** for provisional early
  estimates. Official perimeters are solid, forest-green and hatched; early
  zones are dashed orange with a north-edge label. Thermal detections fade from
  ember to stone over 24 hours and scale with Fire Radiative Power.
- **Near you.** Watch up to five places (search an address or town, or use
  your location). For each, FirePulse lists fires within 10, 25 or 50 km,
  measured to the fire's mapped edge and labelled with direction, alongside
  any evacuation order, fire warning, red flag or smoke alert covering it.
  Every fire gets a plain-language status ("Official fire · 35% contained",
  "Possible fire · not confirmed by fire agencies", "Planned burn") and links
  to the official sources. Places are kept in the browser.
- **Alerts on your devices.** Create an account with a username and password,
  or Sign in with Google, then turn on alerts in the browser (or in the app added to
  an iPhone's home screen). FirePulse pushes a notification when an evacuation
  order or fire warning covers a watched place, when a fire is confirmed within
  its radius or crosses 10, 5 or 2 km toward it, and (once a day) when red flag
  conditions start. Quiet hours hold everything except evacuations and fire
  warnings, and each alert is sent once.
- **Warnings on the map.** NWS alert areas are drawn under the fire data: solid
  red for evacuations and fire warnings, dashed amber for fire weather, grey
  for smoke and air quality.
- **Live incident feed.** Sorted by fastest-growing / newly-detected /
  confidence, with source tags (`GOES-18`, `CAD`, `NIFC`, …), a confidence score
  and bar, area, growth rate, hotspot count and a second-level age.
- **Evidence-first detail panel.** The confidence equation, each factor, every
  source's weight, the merge head start, a 6 h FRP/confidence sparkline,
  provenance and neighbouring incidents.
- **Four basemaps, one variable.** *Atlas* (local Natural Earth vector plate),
  *Ink* (carbon night plate), *Topographic* (Esri) and *Satellite*
  (EOX Sentinel-2 cloudless). The selected map is persisted; overlays, labels
  and hatches re-theme to stay legible.
- **Animated wind.** Monochrome graphite particles advected through a
  synthetic HRRR u/v field, so wind never becomes a second colour system.
- **24 h scrubber.** Replay thermal progression against the moment each official
  perimeter was drawn; official ticks on the timeline mark those publications.
- **H3 density.** Toggle the hexagonal cells that give every fused zone its
  stable identity.
- **No-key demo.** The default simulation produces 24 h of history, live
  ignitions, late official perimeters and real merges, all through the *same*
  ingestion, fusion and transport code as production.

| Detail panel | Replay mode |
|---|---|
| ![Detail](./docs/screenshot-detail.png) | ![Replay](./docs/screenshot-replay.png) |

| Official perimeter | H3 identity cells | Mobile |
|---|---|---|
| ![Map](./docs/screenshot-map.png) | ![H3](./docs/screenshot-h3.png) | ![Mobile](./docs/screenshot-mobile.png) |

| Ink plate | Topographic | Satellite |
|---|---|---|
| ![Ink](./docs/screenshot-ink.png) | ![Topo](./docs/screenshot-topo.png) | ![Satellite](./docs/screenshot-satellite.png) |

---

## Design system

A deliberate light interface rather than a dashboard template.

| Token | Value | Use |
|---|---|---|
| Canvas | `#F7F7F5` | warm alabaster app background |
| Surface | `#FFFFFF` | panels, header, inspector |
| Ink | `#111111` | primary type, primary buttons |
| Muted | `#6B6B6B` | secondary type and metadata |
| Hairline | `#E5E5E5` | every structural boundary |
| Forest | `#1B4332` | official / surveyed data |
| International Orange | `#FF4F00` | early estimates and provisional actions |

- **Type:** Inter variable for UI, JetBrains Mono for labels, numbers and
  timestamps. Headings are 550–600 weight with `-0.03em` tracking; section
  kickers are 9.5px uppercase mono.
- **Structure:** exposed hairlines and a fixed app grid. The sidebar, map and
  inspector are columns, not floating cards. The timeline is a full-width dock.
- **Controls:** 6px radii, 1px borders, 150ms ease-out. Primary actions are
  solid carbon; no pills, glows, gradients or hover scale.
- **Charts:** single-weight lines and 2px factor bars. No area gradients.
- **Basemaps:** Atlas and Ink are self-hosted PMTiles; Topographic and
  Satellite are CORS-safe raster providers with muted raster paint.

The only animation is functional: the dashed estimate boundary breathes
slightly, the boot progress line advances, and wind particles move.

---

## Architecture

![Architecture](./docs/architecture.svg)

Deep dive: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) ·
[mermaid source](./docs/architecture.mmd) · [schema diagram](./docs/schema.svg) ·
[schema source](./docs/schema.mmd) · [PostGIS DDL](./db/migrations/001_init.sql).

```
Tier 1  CAD · scanner · PTZ · crowd     ┐
Tier 2  GOES-16/18 · VIIRS · MODIS      ├─▶ ingestion bus ─▶ PostGIS (+ Redis)
Tier 3  PM2.5 · RAWS · Red Flag         │        │
Tier 4  NIFC WFIGS · CAL FIRE ──────────┘        ▼
                                          fusion engine (4 s)
                                          DBSCAN 2 km / per-source windows
                                          noisy-OR confidence
                                          buffered convex hull
                                          H3 identity · merge · diff
                                                 │
                                                 ▼
                                          WS hub ─▶ MapLibre + deck.gl
                                          snapshot + deltas · PMTiles
```

### The confidence model

```
c_m       = 1 − (1 − w_max) · Π(1 − ρ·w_i)      within a modality (ρ = 0.35)
fused     = 1 − Π_m (1 − c_m)                    across modalities
score     = 100 · fused · corroboration · freshness
```

| Evidence | Score |
|---|---|
| single unverified crowd report | **20%** |
| photo-verified crowd report | ~25% |
| single GOES hotspot | ~48% |
| CAD dispatch + GOES | **85%** |
| 5 independent modalities | ~96% |
| NIFC perimeter | **100%** |

Correlated sensors are discounted (two satellites see the same flame); FRP is
log-scaled; evidence decays with per-source half-lives. Every factor is returned
with the score and rendered in the UI.

---

## Quick start

Requires Node 20+ and pnpm 9+.

```bash
pnpm install
pnpm dev
```

- Web: <http://localhost:3000>
- API: <http://localhost:8790>
- WS: `ws://localhost:8790/ws`
- Health: <http://localhost:8790/api/health>

No database or API keys are required: without `DATABASE_URL` the API uses the
in-memory store, and without `DATA_MODE=live` a deterministic multi-tier
simulator drives the feed.

```bash
# unit + integration tests (confidence, parsers, DBSCAN, merge behaviour)
pnpm test

# typecheck every workspace
pnpm typecheck

# production build
pnpm build

# rebuild the PMTiles basemap from Natural Earth (optional)
pnpm basemap:build
```

### Run with real PostGIS + Redis

```bash
cp .env.example .env
docker compose up --build
```

Or point at your own services:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/firepulse
export REDIS_URL=redis://localhost:6379
pnpm db:migrate               # also runs automatically when the API starts
psql "$DATABASE_URL" -f db/seed/dev_seed.sql
pnpm dev
```

The database needs PostGIS. Migrations in `db/migrations/` apply in order,
once each, and are tracked in `firepulse.schema_migration`. Set
`TEST_DATABASE_URL` (a throwaway database, rebuilt by the test) to include
the Postgres integration test in `pnpm test`.

### Live feeds

```bash
export DATA_MODE=live
export FIRMS_MAP_KEY=...      # NASA FIRMS area API (free key)
export FIREPULSE_USER_AGENT="FirePulse/1.0 (you@example.com)"
# WFIGS, NWS and Open-Meteo need no key
pnpm dev:api
```

| Feed | What it provides | Cadence |
|---|---|---|
| NASA FIRMS VIIRS (S-NPP, NOAA-20, NOAA-21) + MODIS | satellite heat detections, 1-3 h after each pass | 10 min |
| NIFC WFIGS incidents + perimeters | official fires, perimeters, containment, prescribed burns | 5 min |
| NWS alerts | evacuation orders, fire warnings, red flag / fire weather, smoke and air quality, with zone outlines | 5 min |
| Open-Meteo | 10 m wind on a 2° CONUS grid, 30 forecast hours | 6 h |
| NOAA GOES-18/19 ([worker](./apps/goes-worker)) | geostationary fire pixels, minutes after a scan | 5 min |
| EPA AirNow | PM2.5 at about 900 monitors: smoke context, air quality at your places | 30 min |
| US Census geocoder | names for estimated fires ("Fire near Paradise, CA") | as needed |

At startup the API backfills the last 30 h from each feed, so the map isn't
empty after a restart. Each feed's status, last success and newest observation
show in the Layers popover and at `/api/health`. In production
(`NODE_ENV=production`), live mode refuses to start without `DATABASE_URL`.

VIIRS and MODIS pass a few times a day and FIRMS publishes their detections
1-3 h later; GOES scans every 5 minutes. Each source carries its own evidence
window (30 h for polar orbiters, 2 h for GOES, about an hour for dispatch and
crowd reports).

Satellite heat seen in one pass is usually a farm or industrial burn, so an
estimate is **single** until heat is seen again 6 h or more later
(**persistent**) or another kind of evidence agrees (**corroborated**). Single
heat is drawn faintly, listed under Unconfirmed, and never reaches Near you or
alerts. Refineries, gas flares and steel mills are dropped using
`apps/api/data/heat-mask.json`, built from a year of FIRMS data by
`pnpm --filter @firepulse/api heat-mask:build`.

The GOES worker is a separate Python process; see
[`apps/goes-worker`](./apps/goes-worker/README.md).

`DATA_MODE=hybrid` keeps the demo running alongside real feeds, which is useful
for development when an upstream is flaky.

**Tier-1 push webhooks** (PulsePoint-shaped CAD, crowd reports):

```bash
curl -X POST localhost:8790/api/v1/hooks/crowd \
  -H 'content-type: application/json' \
  -d '{"lat":34.46,"lon":-118.43,"bearing":240,"distanceM":1800,
       "description":"Large smoke column","photo":"https://example.com/smoke.jpg"}'
```

Set `INGEST_WEBHOOK_SECRET` to require `x-firepulse-signature: sha256=<hmac>`
over the raw request body. In production, hooks refuse unsigned posts.

### Accounts and alerts

Accounts are a username and password, or Sign in with Google
(`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`). People watch up to five places
and turn on alerts per browser with Web Push (`VAPID_PUBLIC_KEY` /
`VAPID_PRIVATE_KEY`; generate a pair with `npx web-push generate-vapid-keys`).

| Alert | When | Severity |
|---|---|---|
| Evacuation order, fire warning | an NWS alert area covers the place | urgent: ignores quiet hours |
| New fire | an official fire (not a planned burn) or confirmed estimate within the place's radius, measured to the fire's edge | by distance |
| Fire closer | a known fire crosses 10, 5 or 2 km, or reaches the place | by distance |
| Spread | the experimental next-day forecast expects growth toward the place | info / warning |
| Fire weather | red flag or extreme fire danger, once a day | info / warning |

Every alert is stored once per (place, kind, fire, revision), so restarts never
resend one. Fires already present when a place is added are recorded as
known, not alerted. Non-urgent alerts wait out quiet hours, and each person
gets at most 6 an hour. Forecasts run ahead of time only for fires within
50 km of a watched place. Account routes are proxied through the web app's
origin (`API_INTERNAL_URL`), so the session cookie is first-party.

Signed-in people can report smoke or fire. Reports are low-weight evidence and
never confirm a fire or send an alert on their own.

### Deploying

See [`docs/DEPLOY.md`](./docs/DEPLOY.md): the web app on Vercel; the API, the
GOES worker and Postgres + PostGIS on always-on hosts.

### Next-day spread forecasts (experimental)

Click any fire in the contiguous US and the detail panel shows where the
**FireSight U-Net** expects it to be burning in about 24 hours. The map shades
the predicted 1 km cells for the selected fire only, inside a dashed outline
of the model's 64 × 64 km input window.

How one forecast is made (`apps/api/src/spread/`):

1. **Window.** A north-up 64 × 64 grid of 1 km cells centred on the incident's
   VIIRS/MODIS detections from the last 24 h (the model pulls predictions toward
   the centre, so it is always fire-centred).
2. **Fire today.** Only VIIRS and MODIS hotspots, never GOES, CAD, crowd or
   cameras. Official perimeters are filled in only when a thermal detection
   confirms them.
3. **Inputs.** Terrain, vegetation (NDVI) and population from 5° CONUS tiles;
   one 16-point Open-Meteo request turned into GRIDMET-style daily values for the
   fire's local day; ERC and PDSI from GRIDMET (THREDDS); Red Flag Warnings from
   NWS. If Open-Meteo fails there is no forecast. FirePulse never predicts with
   made-up weather. Missing ERC/PDSI are listed in the panel.
4. **Model.** ONNX via `onnxruntime-node`; normalisation is inside the graph.
   Test AUC-PR 0.357 (research baseline 0.284, "tomorrow = today" 0.115).
5. **Output.** Scores are **not probabilities** (Dice loss), so the UI shows
   bands only: faint ≥ 0.06, likely ≥ 0.12 (the threshold), very likely ≥ 0.5,
   plus a one-line summary of the growth direction.

Guards: estimates below `SPREAD_MIN_CONFIDENCE` (40) and unconfirmed
thermal-only heat in places with ≥ 1500 people/km² ("likely an industrial heat
source") get no forecast. Results are cached per incident, hour and set of
detections (memory, plus Redis when `REDIS_URL` is set). At most 2 run at once
with 20 queued, and each is capped at 30 s. `GET /api/v1/incidents/:id/spread`
waits up to 25 s, then answers `202 {"status":"computing"}` and the client
polls.

**Assets.** The model and static layers are too large for git. They come from
the [wildfire-spread-predictor](https://github.com/Rydenb/wildfire-spread-predictor)
repo:

```bash
# in wildfire-spread-predictor
python -m firesight.firepulse_export onnx           # models/firesight-best.onnx + firesight-model.json
python ee/export_static_conus.py --project <gcp>     # static_conus/ (Earth Engine, ~60 MB)
tar -czf static_conus.tar.gz static_conus

# in FirePulse, for local development
mkdir -p apps/api/assets/spread
cp <predictor>/models/firesight-best.onnx <predictor>/models/firesight-model.json apps/api/assets/spread/
cp -r <predictor>/static_conus apps/api/assets/spread/
```

Or upload `firesight-best.onnx`, `firesight-model.json` and
`static_conus.tar.gz` to one URL (a GitHub release works) and set
`SPREAD_ASSETS_URL`: the Dockerfile downloads them at build time
(`docker build --build-arg SPREAD_ASSETS_URL=...`), and the API downloads any
missing file at startup. Without the files, spread switches off with a single
warning and the rest of FirePulse is unaffected. `/api/health` reports
`spread.state`.

**Hosting.** The API needs an always-on Node host (Render, Railway, Fly.io).
Vercel's serverless functions can't hold the WebSocket hub, the in-memory
fusion state, or a warm ONNX session, so deploy only `apps/web` there and point
`NEXT_PUBLIC_API_URL` at the API. Set `SPREAD_USER_AGENT` to include a
contact, as NWS asks.

> **For learning only.** Never use this to decide whether to evacuate. Satellite
> data can be hours old and the model doesn't know about firefighting. Follow
> local officials and call 911 in an emergency.

---

## Project layout

```
firepulse/
├── apps/
│   ├── api/                  Fastify + WebSocket ingestion & fusion service
│   │   ├── src/
│   │   │   ├── fusion/       engine.ts: clustering, confidence, merge, diff
│   │   │   ├── sources/      adapters: FIRMS, WFIGS, NWS, AirNow, wind + simulated
│   │   │   ├── accounts/     users, sessions, places, Google sign-in, routes
│   │   │   ├── notify/       alert rules, alert engine, Web Push outbox
│   │   │   ├── simulation/   deterministic multi-tier generator + geography
│   │   │   ├── store/        MemoryStore / PostgresStore / RedisCache
│   │   │   ├── realtime/     hub, hotspot sequence log, metrics
│   │   │   ├── spread/       next-day spread: ONNX model, static tiles, weather, summary
│   │   │   ├── pipeline.ts   ingest → fuse → publish orchestration
│   │   │   └── server.ts     HTTP API + WS + webhooks + metrics
│   │   ├── data/             static heat-source mask
│   │   └── test/             model, parsers, fusion, Postgres, accounts, alerts, spread, feeds
│   ├── goes-worker/          Python: GOES-18/19 fire pixels → the API
│   └── web/                  Next.js App Router client (installable, with a service worker)
│       ├── src/components/   AppHeader, MapCanvas, Sidebar, DetailPanel, Timeline
│       ├── src/lib/          places.ts (4 basemaps), layers.ts, store.ts, select.ts
│       └── public/basemap/   PMTiles v3 (built from Natural Earth)
├── packages/protocol/        shared types, confidence model, geodesy, DBSCAN
├── db/migrations/            PostGIS schema, clustering SQL, merge functions
├── db/seed/                  dev seed
├── scripts/                  PMTiles writer, headless verification harness
└── docs/                     architecture, diagrams, screenshots
```

### Shared code, one source of truth

`@firepulse/protocol` is imported by both the API and the client:

- domain types and the realtime message contract
- the **confidence model** (calibration tables, noisy-OR, decay)
- dependency-free geodesy: haversine, bearing destination, convex hull,
  Minkowski buffer, spherical area, DBSCAN

The Python equivalent in production would mirror
[`confidence.ts`](./packages/protocol/src/confidence.ts) and
[`engine.ts`](./apps/api/src/fusion/engine.ts).

---

## Realtime protocol

```jsonc
// server → client, first frame
{ "type": "snapshot", "seq": 42, "incidents": [...], "hotspots": [...],
  "wind": {...}, "stats": {...} }

// server → client, every fusion change
{ "type": "delta", "seq": 43,
  "incidentsUpsert": [ { "type": "Feature", "id": "...", "properties": {...} } ],
  "incidentsRemove": ["uuid"],
  "hotspotsUpsert": [ { "type": "Feature", "geometry": {...} } ],
  "stats": { "ingestRate": 4.7, "medianLeadTimeMinutes": 4 } }
```

The client keeps `Map<id, feature>`; deltas patch maps, never re-fetch the
dataset. Thermal frames are sequenced so a client only receives points newer
than its `lastHotspotSeq` inside its viewport. See
[`docs/ARCHITECTURE.md` §6](./docs/ARCHITECTURE.md#6-real-time-transport).

---

## API surface

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/health` | store, Redis, uptime, sessions, spread state |
| GET | `/api/v1/incidents?bbox=&at=&minConfidence=` | viewport FeatureCollection |
| GET | `/api/v1/incidents/:id` | signals, neighbours, series |
| GET | `/api/v1/incidents/:id/spread` | next-day spread forecast (202 while computing) |
| GET | `/api/v1/hotspots?bbox=&from=&to=` | thermal window |
| GET | `/api/v1/alerts?bbox=` | active NWS fire, evacuation and smoke alerts |
| GET | `/api/v1/nearby?lat=&lon=&radiusKm=` | fires near a point and alerts covering it |
| GET | `/api/v1/geocode?q=` | US place search (Census for addresses, Photon for names) |
| GET | `/api/v1/timeline?hours=24` | histogram + official draws |
| GET | `/api/v1/stats` | rates, latency, fusion config |
| GET | `/api/v1/merges` | lead-time ledger |
| GET | `/api/v1/wind` | u/v grid |
| POST | `/api/v1/hooks/cad` | Tier-1 dispatch |
| POST | `/api/v1/hooks/crowd` | Tier-1 sighting |
| POST | `/api/v1/hooks/thermal` | GOES fire pixels from the worker (signed) |
| GET | `/api/v1/auth/me` | signed-in user, Google availability, push key |
| POST | `/api/v1/auth/signup`, `/login`, `/logout` | username and password |
| GET | `/api/v1/auth/google/start`, `/callback` | Sign in with Google |
| GET, POST, PATCH, DELETE | `/api/v1/me/places[/:id]` | watched places (`/import` moves browser-kept places in) |
| GET, PUT | `/api/v1/me/settings` | alert kinds, quiet hours, time zone |
| GET | `/api/v1/me/alerts` | alert history |
| POST | `/api/v1/me/reports` | smoke report |
| POST | `/api/v1/me/password`; DELETE `/api/v1/me` | change password; delete account |
| POST, DELETE | `/api/v1/push/subscribe`; POST `/api/v1/push/test` | this device's alerts |
| GET | `/metrics` | Prometheus text (`METRICS_TOKEN` bearer) |
| GET | `/ws` | delta stream |

---

## Verification

```bash
pnpm typecheck                  # protocol + API + web
pnpm test                       # API tests; TEST_DATABASE_URL adds the Postgres ones
(cd apps/goes-worker && .venv/bin/python -m unittest discover -s tests)
node scripts/shot.mjs           # headless screenshot + console/WebGL diagnostics
node scripts/build-basemap.mjs  # PMTiles writer, validated by reading it back
```

The PMTiles writer is hand-rolled (the npm reader is read-only) and validated by
re-opening the archive through `pmtiles` and decoding a sample MVT tile.

---

## Limitations

- Demo mode is **synthetic**; the UI labels it. It is not live fire data.
- Polar-orbiter detections are 1-3 h old when they arrive; GOES is minutes
  old but only locates a fire to about 2 km.
- Alerts depend on browsers and push services. iPhones only deliver web push
  to the app added to the home screen, and any device can miss one.
- The heat-source mask is a yearly statistical filter: a new gas flare shows
  as satellite heat until it has burned for about a month.
- Single-bearing observations are range-bearing projections. Multi-camera ray
  intersection (weighted least squares) is the next accuracy improvement.
- GOES geolocation (~2 km) sets a floor on cluster radius; below it, one fire can
  fragment into multiple zones.
- The public read API has no keys; it is rate limited per client.
- Spread forecasts cover the contiguous US only, use satellite detections that
  can be hours old, and know nothing about suppression. They are experimental.
- **Not for evacuation decisions.** Algorithmic estimates are labelled as such;
  official perimeters are the authority.

---

## License

MIT (code). Natural Earth basemap data is public domain. Official fire data
remains subject to the terms of NIFC/WFIGS and CAL FIRE.
