"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { IncidentDetail, IncidentFeature, NearbyFire } from "@firepulse/protocol";
import { apiGet, useLiveFeed, useSpread, type TimelineResponse } from "@/lib/store";
import { selectHotspots, selectIncidents, type FeedTab, type KindFilter } from "@/lib/select";
import type { MapType } from "@/lib/places";
import { useNearby, usePlaces, type WatchedPlace } from "@/lib/myplaces";
import { registerServiceWorker, useAccount, usePush } from "@/lib/account";
import { perfFromQuery } from "@/lib/perf";
import { useTheme } from "@/lib/theme";
import type { LayerFlags } from "./MapCanvas";
import AppHeader from "./AppHeader";
import Sidebar, { type SidebarMode } from "./Sidebar";
import NearbyPanel from "./NearbyPanel";
import AccountPanel from "./AccountPanel";
import ReportSmoke from "./ReportSmoke";
import DetailPanel from "./DetailPanel";
import Timeline from "./Timeline";
import Legend from "./Legend";
import { Icon } from "./ui";

const MapCanvas = dynamic(() => import("./MapCanvas"), {
  ssr: false,
  // A neutral canvas, not the light map paper: this must not flash white in dark mode.
  loading: () => <div style={{ position: "absolute", inset: 0, background: "var(--canvas)" }} />,
});

const DAY = 24 * 3_600_000;
const MAP_KEY = "firepulse.mapType";
const MODE_KEY = "firepulse.sidebarMode";
/** How long a fire picked from "near you" may take to arrive in the viewport feed. */
const PENDING_SELECT_MS = 15_000;

function isMapType(value: string | null): value is MapType {
  return value === "atlas" || value === "ink" || value === "topo" || value === "sat";
}

export default function FirePulseApp() {
  const feed = useLiveFeed();
  const store = feed.store;
  // Re-render on any store change (counters, feed health, geometry)…
  useSyncExternalStore(store.subscribe, store.getVersion, () => 0);
  // …but only rebuild derived geometry when the geometry itself changed. A
  // stats-only frame must not invalidate the map data and every deck.gl layer.
  const dataVersion = store.getDataVersion();

  // Device budget: decides the clock cadence and is handed to the map.
  const profile = useMemo(
    () => perfFromQuery(typeof window === "undefined" ? "" : window.location.search),
    [],
  );
  const appearance = useTheme();
  const [legendOpen, setLegendOpen] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("key"),
  );

  const [clock, setClock] = useState(() => Date.now());
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(720);
  const [tab, setTab] = useState<FeedTab>("growth");
  const [kind, setKind] = useState<KindFilter>("all");
  const [minConfidence, setMinConfidence] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth > 900,
  );
  const [layerMenuOpen, setLayerMenuOpen] = useState(false);
  const [mapType, setMapType] = useState<MapType>(() => {
    if (typeof window === "undefined") return "atlas";
    const saved = window.localStorage.getItem(MAP_KEY);
    return isMapType(saved) ? saved : "atlas";
  });
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [merges, setMerges] = useState<{ count: number; medianLeadTimeMinutes: number | null }>({
    count: 0,
    medianLeadTimeMinutes: null,
  });
  const [timeline, setTimeline] = useState<TimelineResponse>(() => {
    const now = Date.now();
    return {
      from: new Date(now - DAY).toISOString(),
      to: new Date(now).toISOString(),
      buckets: [],
      events: [],
    };
  });
  const [layers, setLayers] = useState<LayerFlags>({
    official: true,
    estimated: true,
    thermal: true,
    wind: true,
    hex: false,
    labels: true,
    spread: true,
    alerts: true,
  });
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => {
    if (typeof window === "undefined") return "near";
    try {
      return window.localStorage.getItem(MODE_KEY) === "all" ? "all" : "near";
    } catch {
      return "near";
    }
  });
  const [focusArea, setFocusArea] = useState<{ lon: number; lat: number; radiusKm: number; nonce: number } | null>(null);
  const [pendingSelect, setPendingSelect] = useState<{ id: string; at: number } | null>(null);
  const account = useAccount();
  const signedIn = Boolean(account.state?.user);
  const push = usePush(account.state?.pushPublicKey ?? null, signedIn);
  const [accountOpen, setAccountOpen] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const placesApi = usePlaces(signedIn);
  const nearby = useNearby(placesApi.places);

  const now = clock + store.serverSkewMs;

  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug")) {
    (window as unknown as { __fpStore?: unknown }).__fpStore = store;
  }

  /* ------------------------------ clocks ------------------------------- */
  // Ages are shown in minutes, so a 1 s clock bought nothing but a full app
  // re-render every second — including every card in the feed.
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), profile.clockMs);
    return () => window.clearInterval(id);
  }, [profile.clockMs]);

  useEffect(() => {
    window.localStorage.setItem(MAP_KEY, mapType);
  }, [mapType]);

  // Keep the basemap and the UI in the same register: switching to dark turns
  // the paper basemap into the carbon one (and back). An explicit pick of Topo
  // or Sat is left alone.
  const lastTheme = useRef(appearance.theme);
  useEffect(() => {
    const previous = lastTheme.current;
    lastTheme.current = appearance.theme;
    if (previous === appearance.theme) return;
    setMapType((current) => {
      if (appearance.theme === "dark" && current === "atlas") return "ink";
      if (appearance.theme === "light" && current === "ink") return "atlas";
      return current;
    });
  }, [appearance.theme]);

  // Exposed for the stylesheet and for `?perf=` diagnostics.
  useEffect(() => {
    document.documentElement.setAttribute("data-perf", profile.tier);
  }, [profile.tier]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MODE_KEY, sidebarMode);
    } catch {
      /* remembered for this visit only */
    }
  }, [sidebarMode]);

  /* ------------------------------ feeds -------------------------------- */
  useEffect(() => {
    let aborted = false;
    const load = async () => {
      try {
        const tl = await apiGet<TimelineResponse>("/api/v1/timeline?hours=24&bucketMinutes=5");
        if (!aborted) setTimeline(tl);
      } catch {
        /* keep previous histogram */
      }
    };
    void load();
    const id = window.setInterval(load, 60_000);
    return () => {
      aborted = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let aborted = false;
    const load = async () => {
      try {
        const m = await apiGet<{ count: number; medianLeadTimeMinutes: number | null }>(
          "/api/v1/merges",
        );
        if (!aborted) setMerges(m);
      } catch {
        /* ignore */
      }
    };
    void load();
    const id = window.setInterval(load, 30_000);
    return () => {
      aborted = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    let aborted = false;
    setDetailLoading(true);
    const load = async () => {
      try {
        const d = await apiGet<IncidentDetail>(
          `/api/v1/incidents/${encodeURIComponent(selectedId)}`,
          controller.signal,
        );
        if (!aborted) setDetail(d);
      } catch {
        /* may have merged away */
      } finally {
        if (!aborted) setDetailLoading(false);
      }
    };
    void load();
    const id = window.setInterval(load, 20_000);
    return () => {
      aborted = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [selectedId]);

  const spread = useSpread(selectedId);
  const selectedSpread = spread.forecast?.incidentId === selectedId ? spread.forecast : null;

  /* ---------------------------- derived data ---------------------------- */
  const incidents = useMemo(
    () => selectIncidents(store, { cursor, minConfidence, kind, tab }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataVersion, cursor, minConfidence, kind, tab],
  );

  const mapIncidents = useMemo(
    () => selectIncidents(store, { cursor, minConfidence: 0, kind: "all", tab: "all", includeUnconfirmed: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataVersion, cursor],
  );

  const hazards = useMemo(
    () =>
      [...store.hazards.values()].filter((a) => {
        const end = Math.max(Date.parse(a.properties.expires) || 0, Date.parse(a.properties.ends ?? "") || 0);
        return end >= Date.now();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataVersion],
  );

  const hotspots = useMemo(
    () => selectHotspots(store, cursor),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataVersion, cursor],
  );

  const counts = useMemo(() => {
    let early = 0;
    let official = 0;
    for (const f of mapIncidents) {
      if (f.properties.kind === "official") official++;
      // Single-pass satellite heat is on the map but isn't counted as a fire.
      else if (f.properties.confirmation !== "single") early++;
    }
    return { early, official, hotspots: hotspots.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapIncidents, hotspots.length]);

  const nearbyCounts = useMemo(() => {
    let alerts = 0;
    let fires = 0;
    for (const p of placesApi.places) {
      const summary = nearby[p.id];
      alerts += summary?.alerts.length ?? 0;
      fires += summary?.fires.filter((f) => f.cause !== "prescribed").length ?? 0;
    }
    return { alerts, fires };
  }, [nearby, placesApi.places]);

  const selectedIncident: IncidentFeature | null = selectedId
    ? (store.incidents.get(selectedId) ?? null)
    : null;

  const displayNow = cursor ?? now;

  useEffect(() => {
    if (!selectedId) return;
    if (!mapIncidents.some((i) => i.id === selectedId)) setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapIncidents, selectedId]);

  /* ------------------------------ playback ----------------------------- */
  const playingRef = useRef(false);
  playingRef.current = playing;
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setCursor((prev) => {
        const end = feed.store.now();
        const base =
          prev ?? Math.max(timeline.from ? Date.parse(timeline.from) : end - DAY, end - DAY);
        const next = base + speed * 120;
        if (next >= end - 300) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, 120);
    return () => window.clearInterval(id);
  }, [playing, speed, feed.store, timeline.from]);

  const handlePlay = useCallback(() => {
    if (playingRef.current) {
      setPlaying(false);
      return;
    }
    if (cursor == null) setCursor(Date.now() - DAY + 20 * 60_000);
    setPlaying(true);
  }, [cursor]);

  const handleLive = useCallback(() => {
    setPlaying(false);
    setCursor(null);
  }, []);

  const handleSeek = useCallback((t: number | null) => {
    setCursor(t);
    if (t == null) setPlaying(false);
  }, []);

  const handleSelect = useCallback((id: string | null, focus = false) => {
    setSelectedId(id);
    if (id && focus) setFocusNonce((n) => n + 1);
    if (id) {
      setLayerMenuOpen(false);
      if (window.innerWidth <= 900) setSidebarOpen(false);
    }
  }, []);

  const focusOn = useCallback((area: { lon: number; lat: number; radiusKm: number }) => {
    setFocusArea((prev) => ({ ...area, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // A fire picked from "near you" can be outside the current viewport, so
  // the live feed hasn't sent it yet: fly there, then select it on arrival.
  const handleNearbyFire = useCallback(
    (fire: NearbyFire) => {
      if (store.incidents.has(fire.id)) {
        handleSelect(fire.id, true);
        return;
      }
      setPendingSelect({ id: fire.id, at: Date.now() });
      focusOn({ lon: fire.lon, lat: fire.lat, radiusKm: 8 });
    },
    [store, handleSelect, focusOn],
  );

  useEffect(() => {
    if (!pendingSelect) return;
    if (store.incidents.has(pendingSelect.id)) {
      handleSelect(pendingSelect.id, true);
      setPendingSelect(null);
    } else if (Date.now() - pendingSelect.at > PENDING_SELECT_MS) {
      setPendingSelect(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion, pendingSelect]);

  const handleAddPlace = useCallback(
    (place: { name: string; lat: number; lon: number }) => {
      placesApi
        .add(place)
        .then(focusOn)
        .catch(() => undefined);
    },
    [placesApi, focusOn],
  );

  /* ---------------------- deep links (alerts, sign-in) ------------------ */
  const placesRef = useRef(placesApi.places);
  placesRef.current = placesApi.places;

  const openLink = useCallback(
    (search: string) => {
      const q = new URLSearchParams(search);
      const placeId = q.get("place");
      const incidentId = q.get("incident");
      if (placeId || incidentId) {
        setSidebarMode("near");
        setSidebarOpen(window.innerWidth > 900);
      }
      const place = placeId ? placesRef.current.find((p) => p.id === placeId) : undefined;
      if (incidentId) {
        if (store.incidents.has(incidentId)) {
          handleSelect(incidentId, true);
        } else {
          // Off screen: find where it is, fly there, select it when it arrives.
          setPendingSelect({ id: incidentId, at: Date.now() });
          apiGet<{ incident?: IncidentFeature }>(`/api/v1/incidents/${encodeURIComponent(incidentId)}`)
            .then((d) => {
              const p = d.incident?.properties;
              if (p) focusOn({ lon: p.lon, lat: p.lat, radiusKm: 8 });
            })
            .catch(() => (place ? focusOn(place) : undefined));
        }
      } else if (place) {
        focusOn(place);
      }
    },
    [store, handleSelect, focusOn],
  );

  useEffect(() => {
    void registerServiceWorker();
    const q = new URLSearchParams(window.location.search);
    const err = q.get("auth_error");
    if (err) {
      setAuthError(err);
      setAccountOpen(true);
    }
    if (q.has("place") || q.has("incident") || err) {
      // Wait for places to load before resolving a place link.
      const search = window.location.search;
      window.setTimeout(() => openLink(search), 1200);
      window.history.replaceState(null, "", window.location.pathname);
    }
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: string } | null;
      if (data?.type === "open" && data.url) openLink(new URL(data.url, window.location.origin).search);
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleLayer = useCallback((key: keyof LayerFlags) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  /* ---------------------------- keyboard ------------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        handlePlay();
      } else if (e.key.toLowerCase() === "l") {
        handleLive();
      } else if (e.key === "Escape") {
        setSelectedId(null);
        setLayerMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePlay, handleLive]);

  const booting = feed.status !== "live" && mapIncidents.length === 0;
  const showDetail = Boolean(selectedIncident);

  return (
    <div className="app">
      <AppHeader
        counts={counts}
        stats={store.stats}
        status={feed.status}
        latencyMs={feed.latencyMs}
        mapType={mapType}
        onMapType={setMapType}
        layers={layers}
        onToggleLayer={toggleLayer}
        menuOpen={layerMenuOpen}
        onMenu={setLayerMenuOpen}
        sidebarOpen={sidebarOpen}
        onSidebar={() => setSidebarOpen((v) => !v)}
        medianLead={merges.medianLeadTimeMinutes}
        mergeCount={merges.count}
        config={store.config}
        now={now}
        appearance={appearance.theme}
        themeMode={appearance.mode}
        onTheme={appearance.setMode}
        onKey={() => setLegendOpen(true)}
        accountSlot={
          <button
            type="button"
            className={`btn ${signedIn ? "" : "btn-primary"}`}
            onClick={() => setAccountOpen(true)}
            title={signedIn ? "Alerts and account" : "Sign in to get alerts"}
          >
            <Icon name="pin" size={12} />
            <span className="hide-sm">{signedIn ? (push.subscribed ? "Alerts on" : "Alerts off") : "Get alerts"}</span>
          </button>
        }
      />

      <div className={`main ${sidebarOpen ? "" : "no-sidebar"} ${showDetail ? "inspect" : ""}`}>
        {sidebarOpen ? (
          <Sidebar
            incidents={incidents}
            allCounts={counts}
            now={displayNow}
            cursor={cursor}
            tab={tab}
            kind={kind}
            minConfidence={minConfidence}
            selectedId={selectedId}
            status={feed.status}
            latencyMs={feed.latencyMs}
            ingestRate={store.stats?.ingestRate ?? 0}
            config={store.config}
            sources={store.stats?.sources}
            mode={sidebarMode}
            onMode={setSidebarMode}
            placeCount={placesApi.places.length}
            nearby={
              <NearbyPanel
                places={placesApi.places}
                nearby={nearby}
                now={now}
                full={placesApi.full}
                onAdd={handleAddPlace}
                onRemove={placesApi.remove}
                onRadius={placesApi.setRadius}
                onFocusPlace={(p: WatchedPlace) => focusOn(p)}
                onSelectFire={handleNearbyFire}
                report={<ReportSmoke signedIn={signedIn} places={placesApi.places} onSignIn={() => setAccountOpen(true)} />}
                cta={
                  account.unavailable || placesApi.places.length === 0 ? null : !signedIn ? (
                    <div className="np-cta">
                      <span>Get an alert on this device when a fire or an evacuation order comes near these places.</span>
                      <button type="button" className="btn btn-primary" onClick={() => setAccountOpen(true)}>
                        Create a free account
                      </button>
                    </div>
                  ) : !push.subscribed ? (
                    <div className="np-cta">
                      <span>
                        {push.needsInstall
                          ? "To get alerts on iPhone, add FirePulse to your home screen first."
                          : "Alerts are off on this device."}
                      </span>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => (push.needsInstall ? setAccountOpen(true) : void push.enable())}
                      >
                        {push.needsInstall ? "Show me how" : "Turn on alerts"}
                      </button>
                    </div>
                  ) : null
                }
              />
            }
            onTab={setTab}
            onKind={setKind}
            onConfidence={setMinConfidence}
            onSelect={(id) => handleSelect(id, true)}
            onClose={() => setSidebarOpen(false)}
          />
        ) : null}

        <div className="map-cell">
          <MapCanvas
            incidents={mapIncidents}
            hotspots={hotspots}
            wind={store.wind}
            spread={selectedSpread}
            selectedId={selectedId}
            cursor={cursor}
            layers={layers}
            mapType={mapType}
            focusNonce={focusNonce}
            hazards={hazards}
            places={placesApi.places}
            focusArea={focusArea}
            onSelect={(id) => handleSelect(id)}
            onViewport={feed.subscribeViewport}
          />

          {!sidebarOpen ? (
            <button
              type="button"
              className="btn"
              onClick={() => setSidebarOpen(true)}
              style={{
                position: "absolute",
                left: 12,
                top: 12,
                zIndex: 9,
                background: "var(--surface)",
              }}
            >
              {sidebarMode === "near" ? (
                <>
                  <Icon name="pin" size={12} />
                  Near you
                  {nearbyCounts.alerts > 0 ? (
                    <span className="mono" style={{ color: "var(--danger)", marginLeft: 2 }}>
                      {nearbyCounts.alerts} {nearbyCounts.alerts === 1 ? "alert" : "alerts"}
                    </span>
                  ) : placesApi.places.length > 0 ? (
                    <span className="mono" style={{ color: "var(--muted)", marginLeft: 2 }}>
                      {nearbyCounts.fires}
                    </span>
                  ) : null}
                </>
              ) : (
                <>
                  <Icon name="activity" size={12} />
                  Incident feed
                  <span className="mono" style={{ color: "var(--accent)", marginLeft: 2 }}>
                    {counts.early}
                  </span>
                </>
              )}
            </button>
          ) : null}
        </div>

        {showDetail && selectedIncident ? (
          <DetailPanel
            incident={selectedIncident}
            detail={detail}
            now={displayNow}
            onClose={() => setSelectedId(null)}
            onFocus={() => setFocusNonce((n) => n + 1)}
            loading={detailLoading}
            spread={selectedSpread}
            spreadLoading={spread.loading}
            mapType={mapType}
          />
        ) : null}
      </div>

      <Timeline
        from={Date.parse(timeline.from)}
        to={Date.parse(timeline.to)}
        cursor={cursor}
        now={now}
        playing={playing}
        speed={speed}
        buckets={timeline.buckets}
        events={timeline.events}
        onSeek={handleSeek}
        onPlay={handlePlay}
        onSpeed={setSpeed}
        onLive={handleLive}
      />

      {booting ? (
        <div
          style={{
            position: "fixed",
            inset: "var(--header-h) 0 var(--timeline-h) 0",
            zIndex: 65,
            display: "grid",
            placeItems: "center",
            background: "var(--canvas)",
          }}
        >
          <div style={{ width: 300 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <div className="brand-mark">
                <Icon name="flame" size={12} strokeWidth={1.7} className="text-white" />
              </div>
              <span className="wordmark">
                FirePulse<span>US</span>
              </span>
            </div>
            <div className="h2" style={{ marginTop: 18 }}>
              Establishing the fusion stream
            </div>
            <p className="muted" style={{ fontSize: 11.5, margin: "5px 0 16px", lineHeight: 1.55 }}>
              Normalising dispatch, satellite and weather signals into a single fire picture.
            </p>
            <div style={{ height: 1, background: "var(--line)", position: "relative", overflow: "hidden" }}>
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  height: 1,
                  width: "38%",
                  background: "var(--ink)",
                  animation: "loadingBar 1.4s ease-in-out infinite",
                }}
              />
            </div>
            <div className="mono" style={{ fontSize: 9, color: "var(--faint)", marginTop: 9 }}>
              {feed.status} · {store.stats?.totalSignals ?? 0} signals
            </div>
          </div>
        </div>
      ) : null}

      {accountOpen ? (
        <AccountPanel
          account={account}
          push={push}
          now={now}
          error={authError}
          onClose={() => {
            setAccountOpen(false);
            setAuthError(null);
          }}
        />
      ) : null}

      <Legend open={legendOpen} onClose={() => setLegendOpen(false)} mapType={mapType} />

      <style>{`@keyframes loadingBar { 0% { transform: translateX(-100%); } 100% { transform: translateX(360%); } }`}</style>
    </div>
  );
}
