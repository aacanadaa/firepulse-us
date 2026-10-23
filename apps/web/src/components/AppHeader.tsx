"use client";

import type { FeedStats, PublicConfig } from "@firepulse/protocol";
import type { FeedStatus } from "@/lib/store";
import { MAP_THEMES, MAP_TYPES, type MapType } from "@/lib/places";
import type { LayerFlags } from "./MapCanvas";
import { thermalSwatches } from "@/lib/layers";
import { formatMinutes } from "@/lib/format";
import { SourceHealthList } from "./SourceHealth";
import { Icon } from "./ui";

interface Props {
  counts: { early: number; official: number; hotspots: number };
  stats: FeedStats | null;
  status: FeedStatus;
  latencyMs: number;
  mapType: MapType;
  onMapType: (type: MapType) => void;
  layers: LayerFlags;
  onToggleLayer: (key: keyof LayerFlags) => void;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  sidebarOpen: boolean;
  onSidebar: () => void;
  medianLead: number | null;
  mergeCount: number;
  config: PublicConfig | null;
  now: number;
}

const LAYER_LABELS: { key: keyof LayerFlags; label: string; note: string }[] = [
  { key: "official", label: "Official ground truth", note: "NIFC / CAL FIRE perimeters" },
  { key: "estimated", label: "Early estimates", note: "Fused active fire zones" },
  { key: "thermal", label: "Thermal detections", note: "GOES, VIIRS, MODIS" },
  { key: "spread", label: "Spread forecast", note: "Selected fire, next day · experimental" },
  { key: "wind", label: "Wind field", note: "Particle advection" },
  { key: "hex", label: "H3 cells", note: "Resolution 8 identity grid" },
  { key: "labels", label: "Place and fire labels", note: "States, cities, incidents" },
];

const STATUS_LABEL: Record<FeedStatus, string> = {
  live: "Live",
  connecting: "Linking",
  reconnecting: "Retry",
  offline: "Offline",
};

function HatchSwatch({ color }: { color: string }) {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="21" height="9" fill="none" stroke={color} strokeWidth="1" />
      <path d="M-1 11 11-1M4 11 16-1M9 11 21-1" stroke={color} strokeWidth="0.8" opacity="0.55" />
    </svg>
  );
}

export default function AppHeader({
  counts,
  stats,
  status,
  latencyMs,
  mapType,
  onMapType,
  layers,
  onToggleLayer,
  menuOpen,
  onMenu,
  sidebarOpen,
  onSidebar,
  medianLead,
  mergeCount,
  config,
  now,
}: Props) {
  const theme = MAP_THEMES[mapType];
  const type = MAP_TYPES.find((t) => t.id === mapType);

  return (
    <header className="hdr">
      <div style={{ display: "flex", alignItems: "center", paddingLeft: 8 }}>
        <button
          type="button"
          className="icon-btn"
          onClick={onSidebar}
          title={sidebarOpen ? "Hide incident feed" : "Show incident feed"}
          aria-label={sidebarOpen ? "Hide incident feed" : "Show incident feed"}
        >
          <Icon name="menu" size={15} />
        </button>
      </div>

      <div className="hdr-brand" style={{ borderRight: "1px solid var(--line)" }}>
        <div className="brand-mark">
          <Icon name="flame" size={12} strokeWidth={1.7} className="text-white" />
        </div>
        <div className="wordmark">
          FirePulse<span>US</span>
        </div>
      </div>

      <div className="hdr-title">
        <span>National fire picture</span>
        <span className="slash">/</span>
        <span className="mono" style={{ fontSize: 9.5, color: "var(--faint)", letterSpacing: "0.06em" }}>
          CONUS
        </span>
      </div>

      <div className="hdr-stats">
        <div className="hdr-stat">
          <span className="v" style={{ color: "var(--accent)" }}>{counts.early}</span>
          <span className="k">Early</span>
        </div>
        <div className="hdr-stat">
          <span className="v" style={{ color: "var(--forest)" }}>{counts.official}</span>
          <span className="k">Official</span>
        </div>
        <div className="hdr-stat hide-md">
          <span className="v">{counts.hotspots.toLocaleString("en-US")}</span>
          <span className="k">Hotspots</span>
        </div>
        <div className="hdr-stat hide-sm">
          <span className="v">{medianLead == null ? "—" : `${medianLead} min`}</span>
          <span className="k">Median lead</span>
        </div>
      </div>

      <div className="hdr-actions">
        <div className="status" title={`${latencyMs} ms websocket round trip`}>
          <span
            className={`dot ${status === "live" ? "" : status === "offline" ? "offline" : "reconnecting"}`}
          />
          <span className="label">{STATUS_LABEL[status]}</span>
        </div>

        <div className="segmented" role="group" aria-label="Basemap">
          {MAP_TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`segment ${mapType === t.id ? "active" : ""}`}
              onClick={() => onMapType(t.id)}
              title={`${t.name} — ${t.note}`}
              aria-pressed={mapType === t.id}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ position: "relative" }}>
          <button
            type="button"
            className={`btn ${menuOpen ? "btn-primary" : ""}`}
            onClick={() => onMenu(!menuOpen)}
            aria-expanded={menuOpen}
            aria-haspopup="true"
            title="Layers, legend and pipeline health"
          >
            <Icon name="layers" size={13} />
            <span className="hide-sm">Layers</span>
          </button>

          {menuOpen ? (
            <>
              <div
                onClick={() => onMenu(false)}
                style={{ position: "fixed", inset: 0, zIndex: 80 }}
                aria-hidden="true"
              />
              <div className="popover" role="dialog" aria-label="Layers and legend">
                <div className="pop-section">
                  <div className="kicker" style={{ marginBottom: 6 }}>
                    Overlays
                  </div>
                  {LAYER_LABELS.map((item) => {
                    const on = layers[item.key];
                    return (
                      <button
                        key={item.key}
                        type="button"
                        className="check-row"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => onToggleLayer(item.key)}
                      >
                        <span className={`check-box ${on ? "on" : ""}`}>
                          {on ? <Icon name="check" size={9} strokeWidth={2.6} /> : null}
                        </span>
                        <span style={{ flex: 1 }}>{item.label}</span>
                        <span
                          className="mono"
                          style={{ fontSize: 8.5, color: "var(--faint)", letterSpacing: "0.03em" }}
                        >
                          {item.note}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="pop-section">
                  <div className="kicker" style={{ marginBottom: 8 }}>
                    Legend
                  </div>
                  <div className="legend-row">
                    <HatchSwatch color={theme.official} />
                    <span>Official perimeter · surveyed</span>
                  </div>
                  <div className="legend-row">
                    <span
                      className="legend-swatch"
                      style={{
                        border: `1.5px dashed ${theme.estimated}`,
                        background: theme.estimatedFill,
                        height: 9,
                      }}
                    />
                    <span>Early estimate · algorithmic</span>
                  </div>
                  <div className="legend-row" style={{ alignItems: "flex-start", paddingTop: 7 }}>
                    <span className="legend-swatch" style={{ display: "flex", gap: 3, border: 0 }}>
                      {thermalSwatches(mapType).map((s) => (
                        <span
                          key={s.label}
                          style={{
                            width: 5,
                            height: 5,
                            marginTop: 4,
                            background: s.color,
                            display: "inline-block",
                          }}
                        />
                      ))}
                    </span>
                    <span>
                      Thermal age{" "}
                      <span className="mono" style={{ fontSize: 9, color: "var(--faint)" }}>
                        {thermalSwatches(mapType)
                          .map((s) => s.label)
                          .join(" / ")}
                      </span>
                    </span>
                  </div>
                  <div className="legend-row">
                    <span className="legend-swatch" style={{ display: "flex", alignItems: "center", gap: 3 }}>
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          style={{
                            width: 6,
                            height: 1,
                            background: theme.wind,
                            opacity: 0.5 + i * 0.15,
                            display: "inline-block",
                          }}
                        />
                      ))}
                    </span>
                    <span>Wind · direction and relative speed</span>
                  </div>
                </div>

                <div className="pop-section">
                  <div className="kicker" style={{ marginBottom: 7 }}>
                    Basemap
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-2)" }}>{type?.name}</div>
                  <div className="mono" style={{ fontSize: 9, color: "var(--faint)", marginTop: 2 }}>
                    {type?.note}
                  </div>
                </div>

                {stats?.sources && stats.sources.length > 0 ? (
                  <div className="pop-section">
                    <div className="kicker" style={{ marginBottom: 8 }}>
                      Data sources
                    </div>
                    <SourceHealthList sources={stats.sources} now={now} />
                  </div>
                ) : null}

                <div className="pop-section">
                  <div className="kicker" style={{ marginBottom: 8 }}>
                    Pipeline
                  </div>
                  <div className="pop-grid">
                    <span>Fusion radius</span>
                    <span className="v">{config?.fusionRadiusKm ?? 2} km</span>
                    <span>Evidence window</span>
                    <span className="v">up to {formatMinutes(config?.fusionWindowMin ?? 1800)}</span>
                    <span>H3 resolution</span>
                    <span className="v">r{config?.h3Resolution ?? 8}</span>
                    <span>Ingest rate</span>
                    <span className="v">{(stats?.ingestRate ?? 0).toFixed(1)}/s</span>
                    <span>Fusion latency</span>
                    <span className="v">{stats?.lastFusionMs ?? 0} ms</span>
                    <span>WebSocket RTT</span>
                    <span className="v">{latencyMs} ms</span>
                    <span>Merged precursors</span>
                    <span className="v">{mergeCount}</span>
                    <span>Live sessions</span>
                    <span className="v">{stats?.clients ?? 0}</span>
                  </div>
                  {config?.simulated ? (
                    <div
                      className="mono"
                      style={{
                        marginTop: 9,
                        fontSize: 8.5,
                        color: "var(--faint)",
                        letterSpacing: "0.03em",
                        borderTop: "1px solid var(--line)",
                        paddingTop: 7,
                      }}
                    >
                      Simulated feed · same ingestion and fusion path
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
