"use client";

import type { IncidentFeature, PublicConfig } from "@firepulse/protocol";
import type { KindFilter, FeedTab } from "@/lib/select";
import type { FeedStatus } from "@/lib/store";
import { formatNumber } from "@/lib/format";
import IncidentCard from "./IncidentCard";
import { Icon } from "./ui";

interface Props {
  incidents: IncidentFeature[];
  allCounts: { early: number; official: number; hotspots: number };
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
  { v: 40, label: "40%" },
  { v: 70, label: "70%" },
  { v: 90, label: "90%" },
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
  const total = allCounts.early + allCounts.official;

  return (
    <aside className="sidebar" aria-label="Live incident feed">
      <div className="sb-head">
        <div className="sb-title-row">
          <div>
            <div className="kicker">National feed</div>
            <h2 className="h2" style={{ marginTop: 3 }}>
              Incidents
            </h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ fontSize: 9.5, color: "var(--faint)" }}>
              {incidents.length}/{total}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              title="Hide incident feed"
              aria-label="Hide incident feed"
              style={{ width: 24, height: 24 }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        </div>

        <div className="sb-tabs" role="tablist" aria-label="Feed ordering">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`tab ${tab === t.id ? "active" : ""}`}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="sb-filters">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`chip ${kind === k.id ? "active" : ""}`}
              onClick={() => onKind(k.id)}
              aria-pressed={kind === k.id}
            >
              {k.label}
            </button>
          ))}
          <span className="divider" aria-hidden="true" />
          <label className="kicker" htmlFor="confidence-filter" style={{ fontSize: 8, letterSpacing: "0.08em" }}>
            Min
          </label>
          <select
            id="confidence-filter"
            className="select"
            value={minConfidence}
            onChange={(e) => onConfidence(Number(e.target.value))}
          >
            {CONFIDENCE.map((c) => (
              <option key={c.v} value={c.v}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        {cursor != null ? (
          <div className="replay-banner">
            <Icon name="clock" size={11} />
            <span>Replay — showing what was known at this moment</span>
          </div>
        ) : null}
      </div>

      <div className="feed thin" role="list">
        {incidents.length === 0 ? (
          <div className="empty">
            <h4>Nothing matches this view</h4>
            <p>
              {cursor != null
                ? "The fusion engine had not detected a fire at this point in the replay."
                : "Lower the confidence filter or pan the map to another region."}
            </p>
          </div>
        ) : (
          incidents.map((incident) => (
            <div key={incident.id} role="listitem">
              <IncidentCard
                incident={incident}
                selected={selectedId === incident.id}
                now={now}
                onSelect={onSelect}
              />
            </div>
          ))
        )}
      </div>

      <footer className="sb-foot">
        <span>
          DBSCAN {config?.fusionRadiusKm ?? 2} km / {config?.fusionWindowMin ?? 30} min
        </span>
        <span style={{ color: "var(--line-strong)" }}>·</span>
        <span>H3 r{config?.h3Resolution ?? 8}</span>
        <span style={{ color: "var(--line-strong)" }}>·</span>
        <span>{ingestRate.toFixed(1)}/s</span>
        {config?.simulated ? <span className="sim">Simulated</span> : <span className="sim">Live</span>}
      </footer>
    </aside>
  );
}
