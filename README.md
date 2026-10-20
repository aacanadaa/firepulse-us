# FirePulse US

**Real-time wildfire detection that does not wait for the paperwork.**

Traditional wildfire maps show you fires the government has already surveyed and
published — often hours after ignition. FirePulse ingests the signals that exist
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

The headline metric — **median head start** — is shown in the HUD and computed
from the merge ledger: `official_since − first_detected_at`.

---

## Feature tour

- **Editorial cartography.** A warm alabaster interface with 1px structural
  hairlines, Inter + JetBrains Mono, and exactly two data accents: **Forest**
  for surveyed ground truth, **International Orange** for provisional early
  estimates. Official perimeters are solid, forest-green and hatched; early
  zones are dashed orange with a north-edge label. Thermal detections fade from
  ember to stone over 24 hours and scale with Fire Radiative Power.
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
  ignitions, late official perimeters and real merges — through the *same*
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
                                          DBSCAN 2 km / 30 min
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
psql "$DATABASE_URL" -f db/migrations/001_init.sql
psql "$DATABASE_URL" -f db/seed/dev_seed.sql
pnpm dev
```

### Live feeds

```bash
export DATA_MODE=live
export FIRMS_MAP_KEY=...      # NASA FIRMS area API
# WFIGS and NWS need no key
pnpm dev:api
```

`DATA_MODE=hybrid` keeps the demo running alongside real feeds, which is useful
for development when an upstream is flaky.

**Tier-1 push webhooks** (PulsePoint-shaped CAD, crowd reports):

```bash
curl -X POST localhost:8790/api/v1/hooks/crowd \
  -H 'content-type: application/json' \
  -d '{"lat":34.46,"lon":-118.43,"bearing":240,"distanceM":1800,
       "description":"Large smoke column","photo":"https://example.com/smoke.jpg"}'
```

Set `INGEST_WEBHOOK_SECRET` to require `x-firepulse-signature: sha256=<hmac>`.

---

## Project layout

```
firepulse/
├── apps/
│   ├── api/                  Fastify + WebSocket ingestion & fusion service
│   │   ├── src/
│   │   │   ├── fusion/       engine.ts — clustering, confidence, merge, diff
│   │   │   ├── sources/      adapters: live (FIRMS, WFIGS, NWS) + simulated
│   │   │   ├── simulation/   deterministic multi-tier generator + geography
│   │   │   ├── store/        MemoryStore / PostgresStore / RedisCache
│   │   │   ├── realtime/     hub, hotspot sequence log, metrics
│   │   │   ├── pipeline.ts   ingest → fuse → publish orchestration
│   │   │   └── server.ts     HTTP API + WS + webhooks + metrics
│   │   └── test/             31 tests: model, parsers, DBSCAN, merge, replay
│   └── web/                  Next.js App Router client
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
| GET | `/api/health` | store, Redis, uptime, sessions |
| GET | `/api/v1/incidents?bbox=&at=&minConfidence=` | viewport FeatureCollection |
| GET | `/api/v1/incidents/:id` | signals, neighbours, series |
| GET | `/api/v1/hotspots?bbox=&from=&to=` | thermal window |
| GET | `/api/v1/timeline?hours=24` | histogram + official draws |
| GET | `/api/v1/stats` | rates, latency, fusion config |
| GET | `/api/v1/merges` | lead-time ledger |
| GET | `/api/v1/wind` | u/v grid |
| POST | `/api/v1/hooks/cad` | Tier-1 dispatch |
| POST | `/api/v1/hooks/crowd` | Tier-1 sighting |
| GET | `/metrics` | Prometheus text |
| GET | `/ws` | delta stream |

---

## Verification

```bash
pnpm typecheck                  # protocol + API + web
pnpm test                       # 31 tests
node scripts/shot.mjs           # headless screenshot + console/WebGL diagnostics
node scripts/build-basemap.mjs  # PMTiles writer, validated by reading it back
```

The PMTiles writer is hand-rolled (the npm reader is read-only) and validated by
re-opening the archive through `pmtiles` and decoding a sample MVT tile.

---

## Limitations

- Demo mode is **synthetic**; the UI labels it. It is not live fire data.
- Single-bearing observations are range-bearing projections. Multi-camera ray
  intersection (weighted least squares) is the next accuracy improvement.
- GOES geolocation (~2 km) sets a floor on cluster radius; below it, one fire can
  fragment into multiple zones.
- No read-API authentication in this build. Production needs keys, rate limits,
  CSP and an evacuation disclaimer.
- **Not for evacuation decisions.** Algorithmic estimates are labelled as such;
  official perimeters are the authority.

---

## License

MIT (code). Natural Earth basemap data is public domain. Official fire data
remains subject to the terms of NIFC/WFIGS and CAL FIRE.
