"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { IncidentDetail, IncidentFeature } from "@firepulse/protocol";
import { apiGet, useLiveFeed, type TimelineResponse } from "@/lib/store";
import { selectHotspots, selectIncidents, type FeedTab, type KindFilter } from "@/lib/select";
import type { LayerFlags } from "./MapCanvas";
import Sidebar from "./Sidebar";
import DetailPanel from "./DetailPanel";
import Timeline from "./Timeline";
import HUD from "./HUD";
import { Icon } from "./ui";

const MapCanvas = dynamic(() => import("./MapCanvas"), {
  ssr: false,
  loading: () => <div style={{ position: "absolute", inset: 0, background: "#05070a" }} />,
});

const DAY = 24 * 3_600_000;

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
    typeof window === "undefined" ? true : window.innerWidth > 720,
  );
  const [legendOpen, setLegendOpen] = useState(false);
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
  });

  const now = clock + store.serverSkewMs;

  /* --------------------------- clocks & feeds --------------------------- */
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

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
        /* incident may have merged away */
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
    let estimated = 0;
    let official = 0;
    for (const f of mapIncidents) {
      if (f.properties.kind === "official") official++;
      else estimated++;
    }
    return { estimated, official, hotspots: hotspots.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapIncidents, hotspots.length]);

  const selectedIncident: IncidentFeature | null = selectedId
    ? (store.incidents.get(selectedId) ?? null)
    : null;

  // In replay, "time since" must be relative to what the user is looking at.
  const displayNow = cursor ?? now;

  useEffect(() => {
    if (!selectedId) return;
    if (!mapIncidents.some((i) => i.id === selectedId)) setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapIncidents, selectedId]);

  /* ----------------------------- playback ------------------------------ */
  const playingRef = useRef(false);
  playingRef.current = playing;
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setCursor((prev) => {
        const end = feed.store.now();
        const base = prev ?? Math.max(timeline.from ? Date.parse(timeline.from) : end - DAY, end - DAY);
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
    if (id) setLegendOpen(false);
  }, []);

  const toggleLayer = useCallback((key: keyof LayerFlags) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  /* --------------------------- keyboard -------------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        handlePlay();
      } else if (e.key.toLowerCase() === "l") {
        handleLive();
      } else if (e.key === "Escape") {
        setSelectedId(null);
        setLegendOpen(false);
      } else if (e.key === "0") {
        setLayers((p) => ({ ...p, thermal: !p.thermal }));
      } else if (e.key === "1") {
        setLayers((p) => ({ ...p, official: !p.official }));
      } else if (e.key === "2") {
        setLayers((p) => ({ ...p, estimated: !p.estimated }));
      } else if (e.key === "3") {
        setLayers((p) => ({ ...p, wind: !p.wind }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePlay, handleLive]);

  const booting = feed.status !== "live" && mapIncidents.length === 0;
  const showDetail = Boolean(selectedIncident);

  return (
    <main style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#05070a" }}>
      <MapCanvas
        incidents={mapIncidents}
        hotspots={hotspots}
        wind={store.wind}
        selectedId={selectedId}
        cursor={cursor}
        layers={layers}
        focusNonce={focusNonce}
        onSelect={(id) => handleSelect(id)}
        onViewport={feed.subscribeViewport}
      />

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

      <HUD
        layers={layers}
        onToggle={toggleLayer}
        legendOpen={legendOpen}
        onLegend={() => setLegendOpen((v) => !v)}
        medianLeadTime={merges.medianLeadTimeMinutes}
        mergeCount={merges.count}
        latencyMs={feed.latencyMs}
        ingestRate={store.stats?.ingestRate ?? 0}
        clients={store.stats?.clients ?? 0}
        sidebarOpen={sidebarOpen}
        onSidebar={() => setSidebarOpen(true)}
      />

      {showDetail && selectedIncident ? (
        <DetailPanel
          incident={selectedIncident}
          detail={detail}
          now={displayNow}
          onClose={() => setSelectedId(null)}
          onFocus={() => setFocusNonce((n) => n + 1)}
          loading={detailLoading}
        />
      ) : null}

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
        hasSelection={showDetail}
        sidebarOpen={sidebarOpen}
      />

      {!sidebarOpen ? (
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className="glass"
          style={{
            position: "absolute",
            left: 16,
            bottom: 112,
            zIndex: 30,
            borderRadius: 10,
            padding: "8px 11px",
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontSize: 10.5,
            color: "#e2e8f2",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <Icon name="menu" size={13} />
          Incident feed
          <span className="mono" style={{ color: "#ffb020" }}>{counts.estimated}</span>
        </button>
      ) : null}

      {booting ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 60,
            display: "grid",
            placeItems: "center",
            background:
              "radial-gradient(ellipse at center, rgba(255,138,61,0.06), rgba(5,7,10,0.96) 62%)",
            pointerEvents: "none",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <div className="brand-mark" style={{ margin: "0 auto 16px", width: 44, height: 44 }} />
            <div className="tight" style={{ fontSize: 19, fontWeight: 800, letterSpacing: "0.04em" }}>
              FIREPULSE <span style={{ color: "#ffb020" }}>US</span>
            </div>
            <div className="kicker" style={{ marginTop: 8, fontSize: 9 }}>
              Establishing fusion stream
            </div>
            <div style={{ marginTop: 16, width: 190 }}>
              <div className="conf-meter">
                <span style={{ width: "42%", animation: "shimmer 1.4s infinite" }} />
              </div>
            </div>
            <div className="mono" style={{ marginTop: 10, fontSize: 9, color: "#5d6675" }}>
              {feed.status} · {store.stats?.totalSignals ?? 0} signals
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
