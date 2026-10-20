"use client";

import type { IncidentFeature, PublicConfig } from "@firepulse/protocol";
import type { KindFilter, FeedTab } from "@/lib/select";
import type { FeedStatus } from "@/lib/store";
import { formatNumber } from "@/lib/format";
import IncidentCard from "./IncidentCard";
import { Icon } from "./ui";

interface Props {
  incidents: IncidentFeature[];
  allCounts: { estimated: number; official: number; hotspots: number };
  now: number;
  cursor: number | null;
  tab: FeedTab;
  kind: KindFilter;
  minConfidence: number;
  selectedId: string | null;
  status: FeedStatus;
  latencyMs: number;
  ingestRate: number;
  config: PublicConfig | null;
  onTab: (tab: FeedTab) => void;
  onKind: (kind: KindFilter) => void;
  onConfidence: (min: number) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}

const TABS: { id: FeedTab; label: string }[] = [
  { id: "growth", label: "Fastest growing" },
  { id: "new", label: "Newly detected" },
  { id: "confidence", label: "Confidence" },
];

const KINDS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "estimated", label: "Early" },
  { id: "official", label: "Official" },
];

const CONFIDENCE = [
  { v: 0, label: "Any" },
  { v: 40, label: "40%+" },
  { v: 70, label: "70%+" },
  { v: 90, label: "90%+" },
];

export default function Sidebar({
  incidents,
  allCounts,
  now,
  cursor,
  tab,
  kind,
  minConfidence,
  selectedId,
  status,
  latencyMs,
  ingestRate,
  config,
  onTab,
  onKind,
  onConfidence,
  onSelect,
  onClose,
}: Props) {
  const live = status === "live";
  const statusLabel =
    status === "live" ? "LIVE" : status === "connecting" ? "CONNECTING" : status === "reconnecting" ? "RECONNECTING" : "OFFLINE";

  return (
    <aside
      className="sidebar sidebar-enter glass"
      style={{
        position: "absolute",
        top: 16,
        left: 16,
        bottom: 16,
        width: 376,
        zIndex: 30,
        borderRadius: 16,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      aria-label="Live incident feed"
    >
      {/* ----------------------------- header ----------------------------- */}
      <header style={{ padding: "15px 16px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="brand-mark" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
              <span
                className="tight"
                style={{ fontSize: 16, fontWeight: 800, letterSpacing: "0.02em" }}
              >
                FIREPULSE
              </span>
              <span
                className="mono"
                style={{ fontSize: 9, color: "#ffb020", fontWeight: 700, letterSpacing: "0.14em" }}
              >
                US
              </span>
            </div>
            <div className="kicker" style={{ marginTop: 1 }}>
              Early-estimate fusion
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 7px",
              borderRadius: 6,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.03)",
            }}
            title={live ? `WebSocket live · ${latencyMs} ms` : "Reconnecting to the delta stream"}
          >
            <span className={`live-dot ${status === "live" ? "" : status === "offline" ? "offline" : "degraded"}`} />
            <span
              className="mono"
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.08em",
                color: live ? "#8af0b4" : status === "offline" ? "#ff8078" : "#f2c76b",
              }}
            >
              {statusLabel}
            </span>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="Hide feed"
            style={{ width: 24, height: 24, borderRadius: 6 }}
          >
            <Icon name="close" size={11} />
          </button>
        </div>

        {cursor != null ? (
          <div
            style={{
              marginTop: 11,
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "6px 8px",
              borderRadius: 7,
              background: "rgba(56,189,248,0.08)",
              border: "1px solid rgba(56,189,248,0.2)",
            }}
          >
            <Icon name="clock" size={12} className="text-sky-300" />
            <span className="mono" style={{ fontSize: 10, color: "#9ad9f8" }}>
              REPLAY MODE — showing what we knew at this moment
            </span>
          </div>
        ) : null}

        {/* ----------------------------- stats ----------------------------- */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
            marginTop: 14,
            padding: "10px 0 11px",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <StatBlock
            label="Early estimates"
            value={formatNumber(allCounts.estimated)}
            color="#ffb020"
            sub="unverified fusion"
          />
          <StatBlock
            label="Official fires"
            value={formatNumber(allCounts.official)}
            color="#ff5a4f"
            sub="NIFC / CAL FIRE"
          />
          <StatBlock
            label="Hotspots"
            value={formatNumber(allCounts.hotspots)}
            color="#c8d2e0"
            sub={`${ingestRate.toFixed(1)}/s ingest`}
          />
        </div>

        {/* ------------------------------ tabs ----------------------------- */}
        <div
          style={{
            display: "flex",
            gap: 16,
            marginTop: 2,
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab ${tab === t.id ? "active" : ""}`}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ---------------------------- filters ---------------------------- */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "9px 0 8px",
            flexWrap: "wrap",
          }}
        >
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`chip ${kind === k.id ? "active" : ""}`}
              onClick={() => onKind(k.id)}
            >
              {k.label}
            </button>
          ))}
          <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.09)", margin: "0 3px" }} />
          {CONFIDENCE.map((c) => (
            <button
              key={c.v}
              type="button"
              className={`chip ${minConfidence === c.v ? "active" : ""}`}
              onClick={() => onConfidence(c.v)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </header>

      {/* ------------------------------- list ------------------------------ */}
      <div
        className="thin-scroll"
        style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px", minHeight: 0 }}
      >
        {incidents.length === 0 ? (
          <div
            style={{
              padding: "42px 24px",
              textAlign: "center",
              color: "#6d7684",
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            <Icon name="activity" size={22} className="mx-auto mb-3 opacity-40" />
            <div style={{ fontWeight: 600, color: "#9aa4b4", marginBottom: 4 }}>
              No incidents match this view
            </div>
            <div>
              {cursor != null
                ? "The fusion engine had not detected anything at this point in the replay."
                : "Widen the confidence filter or pan the map to another region."}
            </div>
          </div>
        ) : (
          incidents.map((incident, i) => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              selected={selectedId === incident.id}
              now={now}
              index={i}
              onSelect={onSelect}
            />
          ))
        )}
      </div>

      {/* ------------------------------ footer ----------------------------- */}
      <footer
        style={{
          padding: "8px 14px 10px",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 9,
          color: "#6d7684",
        }}
      >
        <span className="mono">
          DBSCAN {config?.fusionRadiusKm ?? 2} km · {config?.fusionWindowMin ?? 30} min
        </span>
        <span style={{ opacity: 0.4 }}>|</span>
        <span className="mono">H3 r{config?.h3Resolution ?? 8}</span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5 }}>
          {config?.simulated ? (
            <span
              className="mono"
              style={{
                fontSize: 8,
                letterSpacing: "0.08em",
                border: "1px solid rgba(255,176,32,0.28)",
                color: "#d8a94a",
                padding: "1px 4px",
                borderRadius: 3,
              }}
              title="Synthetic demonstration feed — same pipeline, no API keys required"
            >
              SIMULATED FEED
            </span>
          ) : null}
          <span className="mono" title="Median warning delivered before official mapping">
            {latencyMs} ms
          </span>
        </span>
      </footer>
    </aside>
  );
}

function StatBlock({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color: string;
  sub: string;
}) {
  return (
    <div>
      <div className="kicker" style={{ fontSize: 8, letterSpacing: "0.1em" }}>
        {label}
      </div>
      <div
        className="mono tight"
        style={{ fontSize: 19, fontWeight: 700, color, lineHeight: 1.25 }}
      >
        {value}
      </div>
      <div style={{ fontSize: 8.5, color: "#5d6675", whiteSpace: "nowrap" }}>{sub}</div>
    </div>
  );
}
