# FirePulse US: System Architecture

> Real-time wildfire detection that treats *unverified, fast signals* as first-class
> evidence and fuses them into **Early Active Fire Zones** long before a government
> perimeter exists.

FirePulse ingests four tiers of data, clusters them in metric space, scores
convergence with an explainable noisy-OR model, and streams **GeoJSON diffs** to a
WebGL map. Official perimeters are never replaced by estimates: estimates are
absorbed the moment ground truth catches up, and the minutes of warning are
recorded as a first-class product metric.

---

## 1. The latency problem, quantified

| Tier | Source | Native cadence | Observed→client | Trust | Detector? |
|---|---|---|---|---|---|
| 1 | CAD / PulsePoint vegetation dispatch | 30–90 s | < 5 s | High (human dispatch) | yes |
| 1 | Radio scanner AI transcription | 30–120 s | < 5 s | Medium | yes |
| 1 | ALERTCalifornia PTZ smoke detection | 1–3 min | < 5 s | Medium-high | yes |
| 1 | Crowdsourced photo + bearing | seconds | < 5 s | Low (single report) | yes, with caveats |
| 2 | GOES-16/18 ABI fire/hotspot | 5 min | < 10 s | High for heat, coarse for location | yes |
| 2 | NASA FIRMS VIIRS 375 m | 5–15 min | < 10 s | High | yes |
| 2 | NASA FIRMS MODIS 1 km | 15–60 min | < 10 s | Medium | yes |
| 3 | PurpleAir / AirNow PM2.5 | 1–10 min | < 15 s | Context only | no |
| 3 | RAWS wind / RH / fuel moisture | 10–60 min | < 30 s | Context only | no |
| 3 | NWS Red Flag polygons | hours | < 60 s | Context only | no |
| 4 | NIFC WFIGS incident + perimeter | 15 min–hours | < 60 s | **Ground truth** | official |
| 4 | CAL FIRE / InciWeb | hours | < 60 s | **Ground truth** | official |

The product's headline metric is **median head start**: how many minutes before
`official_since` did the fusion engine publish a zone whose centroid was later
covered by the official perimeter? It is measured per merge, stored in
`firepulse.estimate_merge`, and surfaced in the HUD.

---

## 2. System diagram

![FirePulse architecture](./architecture.svg)

Mermaid source for editing: [`architecture.mmd`](./architecture.mmd).

```
 Tier 1 ── CAD/PulsePoint ─┐
        ── Scanner AI ────┤
        ── PTZ cameras ───┤
        ── Crowd reports ─┤
 Tier 2 ── GOES ABI ──────┤      ┌──────────────────┐
        ── FIRMS VIIRS ───┼─────▶│  Ingestion bus   │
        ── FIRMS MODIS ───┤      │ normalize · H3   │
 Tier 3 ── PurpleAir ─────┤      │ dedupe · tier    │
        ── RAWS / NWS ────┤      └────────┬─────────┘
 Tier 4 ── WFIGS/NIFC ────┤               │
        ── CAL FIRE ──────┘               ▼
                                  ┌──────────────┐       ┌────────────────┐
                                  │  PostgreSQL  │◀─────▶│  PostGIS       │
                                  │  system of   │       │  GiST · 5070   │
                                  │  record      │       │  DBSCAN        │
                                  └──────┬───────┘       └────────────────┘
                                         │
                                         ▼
                                  ┌──────────────┐       ┌────────────────┐
                                  │ Fusion engine│◀─────▶│ Redis          │
                                  │ cluster      │       │ GEO bbox cache │
                                  │ score        │       │ Pub/Sub        │
                                  │ hull · diff  │       └────────────────┘
                                  └──────┬───────┘
                                         │ minimal GeoJSON deltas
                                         ▼
                                  ┌──────────────┐
                                  │ WS / SSE hub │── per-client bbox filters
                                  └──────┬───────┘
                                         ▼
                                  MapLibre GL + deck.gl (WebGL2)
                                  GPU attributes · delta patching · 24 h scrubber
```

### Two deployment shapes

| | **Dev / demo (default)** | **Production** |
|---|---|---|
| Store | `MemoryStore` | `PostgresStore` + PostGIS |
| Cache | none | Redis GEO + Pub/Sub |
| Signals | deterministic simulator (24 h history + live ignitions) | real adapters + Tier-1 webhooks |
| Fusion | same engine, same code path | same engine, same code path |
| Transport | WebSocket | WebSocket, Redis fan-out across API pods |

`DATA_MODE=simulation|live|hybrid` switches the adapters only. The fusion,
diffing, confidence and client code are identical; the simulator is a
contract-compatible adapter, not a mock of the pipeline.

---

## 3. Ingestion

### 3.1 Adapter contract

```ts
interface SourceAdapter {
  id: string;
  sources: SourceId[];
  tier: 1 | 2 | 3 | 4;
  intervalMs: number;
  poll(ctx: { now: number; since: number }): Promise<RawSignal[]>;
}
```

Adapters only fetch and normalise. They never touch the fusion engine or the
WebSocket hub, which is what makes replay, back-pressure and per-source health
possible. Official perimeters use a sibling `OfficialAdapter` contract because
they produce incidents, not point evidence.

Implemented:

- [`sources/live.ts`](../apps/api/src/sources/live.ts): NASA FIRMS CSV
  (VIIRS/MODIS), NIFC WFIGS GeoJSON (points buffered by acreage, polygons used
  as-is), NWS Red Flag alerts.
- [`sources/simulated.ts`](../apps/api/src/sources/simulated.ts): six adapters
  driven by a deterministic generator with production cadences
  ([`simulation/generator.ts`](../apps/api/src/simulation/generator.ts)).
- Tier-1 push webhooks: `POST /api/v1/hooks/cad` (PulsePoint-shaped) and
  `POST /api/v1/hooks/crowd` (photo + bearing). Both support HMAC-SHA256 via
  `INGEST_WEBHOOK_SECRET` and re-run fusion immediately.

### 3.2 Normalisation invariants

Every signal, regardless of source:

1. becomes a `RawSignal` with `observedAt` (phenomenon) and `receivedAt`
   (pipeline) separated;
2. receives an **H3 res-8 cell** (~0.74 km²) for dedupe, identity and roll-ups;
3. receives a `dedupeKey` and is written with `ON CONFLICT DO NOTHING`, so
   overlapping poll windows cannot double-count;
4. has **range-bearing observations projected** to the estimated target:
   a PTZ camera 8 km away reports where the *fire* is, not where the mast is.
   This single step removes the most common false-incident class
   ([`pipeline.ts`](../apps/api/src/pipeline.ts));
5. is rejected if coordinates are non-finite or outside ±85° latitude.

Dedupe is enforced twice: in the store (`unique (source, dedupe_key)`) and in
the in-memory dedupe map used by the dev store.

---

## 4. Data model (PostGIS)

Full DDL: [`db/migrations/001_init.sql`](../db/migrations/001_init.sql).
ER diagram: [`schema.svg`](./schema.svg) (source: [`schema.mmd`](./schema.mmd)).

```
firepulse.raw_signal            append-only evidence firehose (24 h hot)
firepulse.fire_incident         one relation for estimates AND official fires
firepulse.incident_evidence     per-source contribution to a fused incident
firepulse.incident_signal       signal ↔ incident membership
firepulse.official_perimeter    SCD-2 revision history of surveyed perimeters
firepulse.estimate_merge        early estimate → official merge ledger
firepulse.fusion_run            per-pass audit (latency, cluster counts)
firepulse.wind_field            HRRR-style u/v grid snapshots
firepulse.signal_rollup_hourly  7-day H3 density rollup
```

Key decisions:

**One incident table for both kinds.** `kind in ('estimated','official')` is the
discriminator. The feed, viewport query, diff engine and client never need a
`UNION`, and a merge is a pointer (`merged_into`) rather than a copy.

**Metric-space generated columns.** Every geometry table carries
`geom_5070 = ST_Transform(geom, 5070)` (CONUS Albers, metres). Buffers, areas,
DBSCAN and `ST_DWithin` all run in metres without per-query transforms.

**Indexes that match the access patterns.**

| Query | Index |
|---|---|
| viewport bbox | `GiST (geom_5070)`, `GiST (centroid_5070)` |
| feed sort | `btree (is_active, kind, growth_score desc)` |
| time scrub | `BRIN (first_detected_at)` |
| unclustered signals | partial `btree (observed_at desc) where cluster_id is null` |
| H3 rollup / UI hex | `GIN (h3_cells)` |
| perimeter lookup | `GiST (geom_5070)`, unique open revision |

**Official perimeters are revisioned (SCD-2).** Inserting a new revision closes
the previous one (`valid_to = new.valid_from`). The scrubber can therefore ask
*"what perimeter existed at 14:05?"* without a separate event log.

**Merge ledger is the product evidence.** `lead_time_minutes` is computed from
the estimate's `first_detected_at` (earliest supporting observation, not the
fusion tick) to the official `official_since`. A unique constraint keeps merges
idempotent.

### Redis (production)

- `fp:geo:incidents`: GEO set of incident centroids; viewport reads use
  `GEOSEARCH ... BYBOX ... ASC` then one `HMGET` of serialised features. This is
  the sub-50 ms bbox path.
- `fp:inc:payload`: hash of incident ID → GeoJSON.
- `fp:deltas`: Pub/Sub channel. The ingestion leader computes a diff once;
  sibling API pods relay it to their own WebSocket sessions. Cache is always
  best-effort: a Redis outage degrades to PostGIS/engine reads, never errors.

---

## 5. The Early-Estimate Fusion Engine

Source: [`apps/api/src/fusion/engine.ts`](../apps/api/src/fusion/engine.ts).

Every 4 s in simulation, and in live mode after each batch arrives (plus a 60 s timer), one pass:

```
load each source's evidence window (30 h VIIRS/MODIS, 2 h GOES, ~1 h dispatch)
        │
        ├─▶ DBSCAN(eps=2 km, minPts=1) over detection signals (5070 meters)
        │       thermal · dispatch · camera · crowd
        │
        ├─▶ attach tier-3 context: PM2.5, RAWS within 4 km; red flag areas containing the cluster
        │
        ├─▶ publishability gate
        │       · drop lone thermal < 3 MW with no corroboration
        │       · drop lone crowd report unless photo/bearing verified
        │       · context-only clusters never seed a fire
        │
        ├─▶ match existing estimate
        │       H3 cell overlap → signal membership → centroid ≤ 3 km
        │
        ├─▶ score evidence (noisy-OR, below)
        ├─▶ geometry = Minkowski buffered convex hull
        ├─▶ growth from 10-min history window
        ├─▶ suppress if official perimeter already covers any member
        └─▶ diff vs last published state → WebSocket upserts/removes
```

### 5.1 Geometry: buffered convex hull

The zone is the **Minkowski sum of the convex hull of all detections with a disc**
(`bufferedHull` in [`packages/protocol/src/geo.ts`](../packages/protocol/src/geo.ts)).
This is a true outward buffer, not a scaled hull: sample a circle of radius *r*
at every hull vertex and take the convex hull again.

- `r = max(220 m, min(1.2 km, 0.35·spread + 120 m))`
- area is spherical (km² → acres); the same ring is used for containment tests
- estimated IDs are stable across ticks, so the client patches one feature
  rather than deleting and re-adding it

### 5.2 Confidence: explainable noisy-OR

```
c_m       = 1 − (1 − w_max) · Π (1 − ρ · w_i)        within a modality
fused     = 1 − Π_m (1 − c_m)                        across modalities
score     = 100 · fused · corroboration · freshness

corroboration = min(1.10, 1 + 0.035 · (distinct_modalities − 1))
freshness     = mean(0.55 + 0.45 · 2^(−age / half_life))
w             = base_weight · (0.6 + 0.4 · provider_confidence) · frp_boost
```

- `ρ = 0.35` is the **correlation discount**: GOES + VIIRS see the same flame,
  so the second sensor is corroboration, not a second independent detection.
- FRP boost is logarithmic (`1 + min(0.4, 0.18·log10(1+FRP))`): a 1000 MW pixel
  is not 1000× more certain than 1 MW.
- Estimates are clamped to **99**. Only official data reaches 100.

Calibration (see [`confidence.test.ts`](../apps/api/test/confidence.test.ts)):

| Evidence | Score |
|---|---|
| one unverified crowd report | **~20%** |
| one photo-verified crowd report | ~25% |
| one GOES hotspot | ~48% |
| CAD dispatch + GOES | **~85%** |
| CAD + GOES + camera + crowd + PM2.5 (5 modalities) | ~96% |
| NIFC perimeter | **100%** |

The UI exposes the full equation, every factor, and each source's own weight, so
confidence is auditable, not a black box.

### 5.3 Absorbing estimates into ground truth

The merge pass runs on every fusion tick. An estimate is absorbed when its
centroid is inside an active official perimeter, or within `matchKm` (3 km) of
one. On merge:

1. estimate gets `merged_into`, `status='merged'`, `is_active=false`;
2. official incident receives `precursor { estimateId, firstDetectedAt,
   leadTimeMinutes, peakConfidence }`;
3. early evidence sources are unioned onto the official incident (`NIFC + GOES +
   CAD` is a legitimate source list);
4. a row is written to `estimate_merge`;
5. the delta stream removes the estimate and upserts the official fire in the
   same frame; the client transitions atomically, with no flicker.

Official revisions preserve `precursor` (see `ingestOfficial`), so the warning
story survives every subsequent perimeter update.

---

## 6. Real-time transport

Source: [`apps/api/src/realtime/hub.ts`](../apps/api/src/realtime/hub.ts),
[`apps/web/src/lib/store.ts`](../apps/web/src/lib/store.ts).

### Messages

```ts
// client → server
{ type: "subscribe", bbox: [w,s,e,n], zoom }
{ type: "viewport",  bbox: [w,s,e,n], zoom }   // snapshot only when expanded
{ type: "time",      at: string | null }
{ type: "filter",    minConfidence: number }
{ type: "ping",      t: number }

// server → client
{ type: "hello",    seq, config, stats }
{ type: "snapshot", seq, incidents[], hotspots[], wind, stats }
{ type: "delta",    seq, incidentsUpsert[], incidentsRemove[],
                    hotspotsUpsert[], hotspotsRemove[], stats, wind? }
{ type: "stats",    seq, stats }               // 1 Hz, no geometry
{ type: "pong",     t, serverTime }
```

### Why diffs, not re-fetches

- Fusion computes a **signature** per incident (kind, confidence, area bucket,
  source set, evidence counts, lead time). Only changed signatures are sent.
- Thermal detections are appended to a **sequenced ring buffer**
  ([`realtime/hotspots.ts`](../apps/api/src/realtime/hotspots.ts)). Each client
  stores `lastHotspotSeq`; a delta contains only `seq > lastSeq` inside that
  client's bbox. Panning never re-sends history; it requests one bbox-scoped
  snapshot only when the new viewport is **not contained** in the previously
  covered one.
- `stats` is sent at 1 Hz with **no geometry**, so the HUD can tick without
  touching the map. Ages are computed client-side from `observedAt`.
- The initial snapshot budget is 10 000 hotspots. When a 24 h window exceeds it,
  `HotspotLog.snapshot` keeps the newest 2 200 and samples older entries
  uniformly by time, so replay still spans the full day instead of collapsing
  to the last few hours.
- Messages are JSON + `permessage-deflate`; the initial payload compresses to a
  few hundred KB, then only increments flow.

### Fan-out and scale

Per tick cost is `O(changed_features + clients × bbox_test)`, with no full dataset
scan. In multi-pod deployments, Redis Pub/Sub carries incident diffs to sibling
pods (`Hub.publish(..., fromRemote)`), while a single ingestion leader owns the
hotspot sequence. Heartbeat every 30 s terminates half-open sockets; caps are
configurable (`MAX_WS_CLIENTS`, snapshot budgets).

---

## 7. Frontend rendering

Source: [`components/MapCanvas.tsx`](../apps/web/src/components/MapCanvas.tsx),
[`lib/layers.ts`](../apps/web/src/lib/layers.ts).

| Layer | Engine | Technique |
|---|---|---|
| Land, states, lakes, rivers, cities | **MapLibre GL** | PMTiles v3 vector archive, self-hosted, byte-range fetched |
| Basemaps | **MapLibre / raster** | Atlas + Ink (self-hosted PMTiles), Topographic (Esri), Satellite (EOX Sentinel-2 cloudless) |
| Official perimeters | **MapLibre** | forest **hatch pattern** + base fill + contrasting casing + solid line |
| Estimated zones | **deck.gl** | PolygonLayer fill + dashed `PathLayer` outline (PathStyleExtension) + pale casing |
| Thermal hotspots | **deck.gl** | `ScatterplotLayer` accessors packed into GPU attribute buffers, ember→stone age ramp, radius by √FRP |
| H3 cells | **deck.gl** | `H3HexagonLayer` from incident cell arrays |
| Labels / beacons | **deck.gl** | SDF `TextLayer` with per-basemap outline colour; labels sit at the polygon's north edge |
| Wind particles | **Canvas 2D** | ~950 graphite particles advected through a bilinear u/v field, screen-space streaks |

**Design system.** Warm alabaster canvas (`#F7F7F5`), white surfaces, 1px
`#E5E5E5` hairlines, carbon type, Forest (`#1B4332`) for official data and
International Orange (`#FF4F00`) for provisional data. Inter for UI, JetBrains
Mono for metadata. No shadows, gradients, glow or pill controls; 6px radii,
150ms ease-out.

**Basemap switching.** Four styles share one overlay contract. Switching calls
`map.setStyle`, then re-installs the official source/layers synchronously from
pre-generated hatch bitmaps (one per theme). A `styledata` fallback plus an
idle retry makes the install resilient to MapLibre's event ordering; the
existing `official-perimeters` source is updated in place as data arrives.

**MapLibre + deck.gl integration** uses `MapboxOverlay` in non-interleaved mode.
Deck owns picking for estimates, hotspots and beacons; MapLibre owns the hatched
official fill and the basemap.

**Performance rules**

- Hotspot accessors read pre-filtered features; deck.gl packs positions, radii
  and colours into contiguous typed GPU attributes once per data change, so the
  per-frame cost stays with the camera, not the 20 000 points.
- Incident labels are ranked and capped; text is only rebuilt on zoom/selection
  changes.
- The 24 h time scrubber filters client-side. Playback updates the cursor at
  8 Hz, not 60 Hz, so the 5 000–20 000 hotspot pass stays under a frame.
- Wind particles live on their own canvas and never enter deck's attribute
  pipeline; count adapts to viewport area (~950 max).

**PMTiles.** The basemap is a 0.5 MB PMTiles v3 archive built from Natural Earth
by [`scripts/build-basemap.mjs`](../scripts/build-basemap.mjs). The npm `pmtiles`
package is read-only, so the writer implements the v3 header, columnar
directories, gzipped metadata and tile offsets directly, then validates the
archive by reading it back through the official reader. Tiles are served with
HTTP Range support (Next static serving or any CDN/S3).

---

## 7b. Household alerts

Sources: [`apps/api/src/notify/`](../apps/api/src/notify/),
[`apps/api/src/accounts/`](../apps/api/src/accounts/).

```
fusion upserts ─┐
official ingest ┼─▶ AlertEngine ── rules.ts ──▶ alert_delivery (deduped) ──▶ PushOutbox ──▶ Web Push
NWS alert set  ─┤      ▲ watched places + settings     (place, kind, subject, revision)   retries, 404/410 cleanup,
spread forecast ┘      │ (reloaded every 5 min and on change)                                hourly cap, quiet hours
```

- **What reaches a household.** Official fires that aren't planned burns, and
  estimates that are *persistent* (heat in passes 6 h or more apart) or
  *corroborated* (two independent kinds of evidence). Single-pass satellite
  heat never alerts.
- **Distance** is measured from the place to the fire's mapped edge, not its
  centroid.
- **Dedupe key** `(place, kind, subject, revision)`: an estimate and the
  official fire it becomes share a subject, so the second message is "now
  official" rather than "new fire". Fire weather uses the local date as its
  revision, giving one alert a day.
- **Baseline.** When a place is added or widened, fires and warnings already
  around it are stored with status `baseline`: known, never sent.
- **Spread** forecasts are scheduled only for confirmed fires within 50 km of a
  watched place, rerun on new detections or every 6 h.

## 8. HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | store/redis/uptime/clients |
| GET | `/api/v1/config` | public fusion config |
| GET | `/api/v1/incidents?bbox=&at=&minConfidence=` | viewport FeatureCollection (Redis GEO fast path) |
| GET | `/api/v1/incidents/:id` | incident + signals + neighbours + series |
| GET | `/api/v1/hotspots?bbox=&from=&to=&limit=` | thermal window |
| GET | `/api/v1/timeline?hours=24&bucketMinutes=5` | histogram + official-draw events |
| GET | `/api/v1/stats` | feed stats, fusion config, Redis status |
| GET | `/api/v1/merges` | merge ledger + median/p90 lead time |
| GET | `/api/v1/wind` | current u/v grid |
| POST | `/api/v1/hooks/cad` | Tier-1 dispatch webhook (HMAC optional) |
| POST | `/api/v1/hooks/crowd` | Tier-1 crowd report (HMAC optional) |
| GET | `/metrics` | Prometheus text metrics |
| GET | `/ws` | WebSocket delta stream |

`/api/v1/incidents` returns 503/empty rather than stale data if the store is
down; the client shows connection state instead of silently freezing.

---

## 9. Operations

### Environment

```bash
# API
PORT=8790
DATA_MODE=simulation            # simulation | live | hybrid
DATABASE_URL=postgres://...     # omit → MemoryStore
REDIS_URL=redis://...           # omit → no cache/fan-out
FUSION_RADIUS_KM=2
FUSION_INTERVAL_MS=4000
HOTSPOT_RETENTION_HOURS=24
INGEST_WEBHOOK_SECRET=...       # enables HMAC verification
FIRMS_MAP_KEY=...               # live Tier-2
FIREPULSE_USER_AGENT=...        # contact for NWS / Open-Meteo
# Web
NEXT_PUBLIC_API_URL=http://127.0.0.1:8790
```

### Scaling path

1. **Ingestion**: one leader per source group (advisory lock or Kubernetes
   Lease) so `dedupe_key` remains authoritative; stateless API replicas relay
   diffs over Redis.
2. **Storage**: PostGIS with monthly `raw_signal` partitions (BRIN + local
   GiST), read replicas for viewport queries, `signal_rollup_hourly` for >24 h
   density, TimescaleDB optional for the firehose.
3. **Transport**: one WS process per pod, sticky sessions not required because
   every pod can serve any viewport from its own snapshot + shared deltas.
4. **Geometry**: for >10⁵ simultaneous polygons, precompute vector tiles per
   zoom (`ST_AsMVT` materialized views) and render perimeters in MapLibre;
   deck keeps points/wind.

### Retention

- raw signals: 24 h hot, rolled into `signal_rollup_hourly`, purge job every 10 min
- estimates: 45 min of silence → expired (`is_active=false`)
- official perimeters: full revision history
- merge ledger: permanent (it is the product KPI)
- hotspots in the client: 24 h window, pruned above 40 000 entries

---

## 10. Honest limitations

- **Simulation is synthetic.** `DATA_MODE=simulation` generates plausible
  geography and cadences; it is not live fire data. The UI labels it.
- **Single-bearer triangulation.** PTZ/crowd bearings are range-bearing
  projections; multi-camera ray intersection (weighted least squares) is the
  next accuracy step.
- **GOES geolocation error** is ~2 km; clustering radius must stay above it or
  one fire fragments into several zones.
- **WFIGS polygons vary by agency**, and some incidents publish points first.
  Point incidents are buffered by reported acreage as an explicit approximation.
- **No authentication** on the read API in this build. Production needs API
  keys/rate limits, signed webhooks (implemented), CORS allowlists, and CSP.
- **Not an evacuation tool.** Estimates are algorithmic and labelled as such in
  the UI; official perimeters remain the authority.
