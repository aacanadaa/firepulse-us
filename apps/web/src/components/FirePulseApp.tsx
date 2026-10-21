"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { IncidentDetail, IncidentFeature } from "@firepulse/protocol";
import { apiGet, useLiveFeed, useSpread, type TimelineResponse } from "@/lib/store";
import { selectHotspots, selectIncidents, type FeedTab, type KindFilter } from "@/lib/select";
import type { MapType } from "@/lib/places";
import type { LayerFlags } from "./MapCanvas";
import AppHeader from "./AppHeader";
import Sidebar from "./Sidebar";
import DetailPanel from "./DetailPanel";
import Timeline from "./Timeline";
import { Icon } from "./ui";

const MapCanvas = dynamic(() => import("./MapCanvas"), {
  ssr: false,
  loading: () => <div style={{ position: "absolute", inset: 0, background: "#e9e5dc" }} />,
});

const DAY = 24 * 3_600_000;
const MAP_KEY = "firepulse.mapType";

function isMapType(value: string | null): value is MapType {
  return value === "atlas" || value === "ink" || value === "topo" || value === "sat";
}

export default function FirePulseApp() {
  const feed = useLiveFeed();
  const store = feed.store;
  const version = useSyncExternalStore(store.subscribe, store.getVersion, () => 0);

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
  });

  const now = clock + store.serverSkewMs;

  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug")) {
    (window as unknown as { __fpStore?: unknown }).__fpStore = store;
  }

  /* ------------------------------ clocks ------------------------------- */
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(MAP_KEY, mapType);
  }, [mapType]);

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
    [version, cursor, minConfidence, kind, tab],
  );

  const mapIncidents = useMemo(
    () => selectIncidents(store, { cursor, minConfidence: 0, kind: "all", tab: "all" }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, cursor],
  );

  const hotspots = useMemo(
    () => selectHotspots(store, cursor),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, cursor],
  );

  const counts = useMemo(() => {
    let early = 0;
    let official = 0;
    for (const f of mapIncidents) {
      if (f.properties.kind === "official") official++;
      else early++;
    }
    return { early, official, hotspots: hotspots.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapIncidents, hotspots.length]);

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
              <Icon name="activity" size={12} />
              Incident feed
              <span className="mono" style={{ color: "var(--accent)", marginLeft: 2 }}>
                {counts.early}
              </span>
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

      <style>{`@keyframes loadingBar { 0% { transform: translateX(-100%); } 100% { transform: translateX(360%); } }`}</style>
    </div>
  );
}
