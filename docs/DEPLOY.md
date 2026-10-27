# Deploying FirePulse

FirePulse is four pieces:

| Piece | What it needs | Where |
|---|---|---|
| Web app (`apps/web`) | Next.js | **Vercel** |
| API (`apps/api`) | an always-on Node process: it holds WebSocket connections, keeps fusion state in memory and runs the feed pollers, alert engine and push outbox | any container host that keeps a process running (Render, Fly.io, Railway, a VM). Not Vercel: its functions can't hold a WebSocket or run in the background |
| Database | Postgres 15+ with **PostGIS** | any managed Postgres that offers PostGIS (Neon, Supabase, Render, RDS) |
| GOES worker (`apps/goes-worker`) | a small always-on Python process | next to the API |

Redis is optional; it's only needed to run more than one API instance.

Push notifications need **HTTPS** on the web app's domain.

## 1. Database

Create a Postgres database with the PostGIS extension available. The API
applies `db/migrations/` itself on start, tracked in
`firepulse.schema_migration`. To do it by hand: `DATABASE_URL=... pnpm db:migrate`.

## 2. API

Build `apps/api/Dockerfile` from the repository root. The image includes the
migrations and the static heat-source mask. Set:

| Variable | Value |
|---|---|
| `DATA_MODE` | `live` |
| `NODE_ENV` | `production` (the image sets it; live mode then refuses to start without Postgres) |
| `DATABASE_URL` | the database above |
| `FIRMS_MAP_KEY` | NASA FIRMS map key |
| `AIRNOW_API_KEY` | EPA AirNow key |
| `FIREPULSE_USER_AGENT` | `FirePulse/1.0 (you@example.com)`; NWS and Open-Meteo ask for a contact |
| `WEB_ORIGIN` | `https://your-domain` (the web app) |
| `CORS_ORIGIN` | `https://your-domain` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | keep the pair you use in development or generate one with `npx web-push generate-vapid-keys`. **Never change it later**: every browser subscription is tied to it |
| `SESSION_SECRET` | a long random string |
| `INGEST_WEBHOOK_SECRET` | a long random string, shared with the GOES worker |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional, for Sign in with Google |
| `GOOGLE_REDIRECT_URI` | `https://your-domain/api/v1/auth/google/callback` |
| `TRUST_PROXY` | how many proxies sit in front of the API (often `1`), so rate limits see real client addresses |
| `METRICS_TOKEN` | optional; enables `/metrics` with this bearer token |
| `OPS_WEBHOOK_URL` | optional Slack/Discord webhook for failing or stale feeds |
| `SPREAD_ASSETS_URL` | optional; where the spread model files can be downloaded at build time |

Health check: `GET /api/health`. It lists every data feed with its status.

## 3. Web app on Vercel

1. Import the repository and set **Root Directory** to `apps/web`.
   `apps/web/vercel.json` installs and builds from the monorepo root.
2. The repository pins pnpm in `package.json`; set
   `ENABLE_EXPERIMENTAL_COREPACK=1` in the project's environment so Vercel uses it.
3. Environment variables:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | the API's public URL; the browser opens the WebSocket and loads map data from it |
| `API_INTERNAL_URL` | the API's URL as Vercel should reach it (usually the same); sign-in, places and alert settings are proxied through the web domain to it, so the session cookie is first-party |
| `NEXT_PUBLIC_CONTACT_EMAIL` | shown on the Privacy and Terms pages |
| `NEXT_PUBLIC_LEGAL_REVIEWED` | `true` once you've reviewed Privacy and Terms (hides the draft note) |

Rewrites are fixed at build time, so redeploy after changing `API_INTERNAL_URL`.

## 3a. Continuous deployment

Once the Vercel GitHub App is installed on the account and the project is linked
to the repository, **every push to `master` deploys production** and every pull
request gets its own preview URL. No CLI step, no token in the repository.

The build inlines `NEXT_PUBLIC_API_URL`. If the API's public URL changes, update
the project's environment variable and redeploy (Vercel → Deployments →
Redeploy, or push an empty commit): an existing build keeps the old URL forever.

## 3b. The API must not live on a laptop

**Current production:** API on Render at `https://firepulse-api.onrender.com`
(store: Postgres/PostGIS), web on `https://firepulse-us.vercel.app`. Nothing
runs on a laptop: no tunnel, no local API. The free plan sleeps after ~15 idle
minutes, so `.github/workflows/keepalive.yml` pings the health endpoint every
10 minutes; delete that workflow when the service moves to a paid plan.

The API holds WebSockets and runs timers, so it needs a host that keeps a
process alive. `render.yaml` in the repository root is a Render Blueprint that
creates the API (Docker, from `apps/api/Dockerfile`), its PostGIS database, and
optionally the GOES worker.

Render → **New +** → **Blueprint** → pick this repository → **Apply**. Values
marked `sync: false` are not in the repository; Render asks for them once.
Then point Vercel's `NEXT_PUBLIC_API_URL` and `API_INTERNAL_URL` at the Render
service URL and redeploy.

Deploying the API there removes the only laptop dependency: the Quick Tunnel and
its rotating hostname (see `firepulse-repoint.sh`) exist purely because the API
currently runs next to the web app.

## 4. GOES worker

Build `apps/goes-worker/Dockerfile` (context `apps/goes-worker`) and set
`FIREPULSE_API_URL` (the API's internal address) and the same
`INGEST_WEBHOOK_SECRET` as the API. It needs outbound HTTPS to
`noaa-goes18.s3.amazonaws.com` and `noaa-goes19.s3.amazonaws.com`.

## 5. Google sign-in

In the Google Cloud console, add `https://your-domain` to the OAuth client's
authorized JavaScript origins and
`https://your-domain/api/v1/auth/google/callback` to its redirect URIs. While
the consent screen is in **Testing**, only listed test users can sign in.
Publish it when you launch.

## 6. After deploying

- `GET /api/health`: every feed `ok` within a few minutes, and the wind field within one.
- Create an account, add a place, turn on alerts and send a test alert. Do this on
  an Android phone in Chrome, and on an iPhone after **Add to Home Screen**:
  iOS only delivers web push to installed apps.
- Review `/privacy` and `/terms`, then set `NEXT_PUBLIC_LEGAL_REVIEWED=true`.
- Place search uses the public Photon server, falling back to public Nominatim
  (throttled to one request a second). Both are meant for light use. Before a
  public launch, point `PHOTON_URL` and `NOMINATIM_URL` at your own instances
  or a paid geocoder, and set `FIREPULSE_USER_AGENT` with a contact address.
- Rebuild the static heat-source mask monthly so new gas flares are filtered:
  `FIRMS_MAP_KEY=... pnpm --filter @firepulse/api heat-mask:build`, then commit
  `apps/api/data/heat-mask.json`.
