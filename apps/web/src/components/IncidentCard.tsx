"use client";

import type { IncidentFeature } from "@firepulse/protocol";
import {
  confidenceTone,
  formatAcres,
  formatAge,
  formatNumber,
} from "@/lib/format";
import { isNew } from "@/lib/select";
import { ConfidenceBadge, Sparkline, SourceTag } from "./ui";

export default function IncidentCard({
  incident,
  selected,
  now,
  onSelect,
  index,
}: {
  incident: IncidentFeature;
  selected: boolean;
  now: number;
  onSelect: (id: string) => void;
  index: number;
}) {
  const p = incident.properties;
  const lastUpdate = Date.parse(p.updatedAt);
  const firstDetected = Date.parse(p.firstDetectedAt);
  // In replay, an incident's latest update may be in the future relative to
  // the cursor. Show how old the fire already was at that moment instead of
  // a misleading "0s".
  const inReplayPast = lastUpdate > now + 1000;
  const age = inReplayPast ? Math.max(0, now - firstDetected) : Math.max(0, now - lastUpdate);
  const firstSeen = Math.max(0, now - firstDetected);
  const isEarly = p.kind === "estimated";
  const fresh = isNew(incident, now);

  return (
    <button
      type="button"
      className={`incident-card ${p.kind} ${selected ? "selected" : ""}`}
      onClick={() => onSelect(p.id)}
      aria-pressed={selected}
      style={{ animationDelay: `${Math.min(index * 18, 180)}ms` }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <ConfidenceBadge confidence={p.confidence} kind={p.kind} />
        <span
          className="kicker"
          style={{
            color: isEarly ? "#c9973f" : "#e0574f",
            fontSize: 8.5,
            letterSpacing: "0.12em",
          }}
        >
          {isEarly ? "EARLY" : "OFFICIAL"}
        </span>
        {fresh ? (
          <span
            className="mono"
            style={{
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: "#0a0d12",
              background: "#ffd27a",
              borderRadius: 3,
              padding: "0 3px",
            }}
          >
            NEW
          </span>
        ) : null}
        <span
          className="mono"
          style={{ marginLeft: "auto", fontSize: 10, color: "#77808f", whiteSpace: "nowrap" }}
          title={inReplayPast ? "Fire age at this replay moment" : "Time since last signal"}
        >
          <span style={{ color: !inReplayPast && age < 120_000 ? "#7ee2a8" : "#77808f" }}>●</span>{" "}
          {formatAge(age)}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
        <h3
          className="tight"
          style={{
            fontSize: 14.5,
            fontWeight: 650,
            color: selected ? "#fff" : "#e6ebf2",
            margin: 0,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {p.name}
        </h3>
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "#9aa4b4", whiteSpace: "nowrap" }}
        >
          {formatAcres(p.areaAcres)}
        </span>
      </div>

      <div style={{ display: "flex", gap: 4, marginTop: 7, flexWrap: "wrap" }}>
        {p.sources.slice(0, 4).map((s) => (
          <SourceTag key={s.source} source={s.source} count={s.count} />
        ))}
        {p.sources.length > 4 ? (
          <span className="source-tag" style={{ opacity: 0.7 }}>
            +{p.sources.length - 4}
          </span>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 8,
          fontSize: 10,
          color: "#8d96a5",
        }}
      >
        <span className="mono" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
            <path
              d={p.growthAcresPerHour >= 0 ? "M1 9 L5 2 L9 9 Z" : "M1 1 L5 8 L9 1 Z"}
              fill={p.growthAcresPerHour > 200 ? "#ff8a3d" : "#8d96a5"}
            />
          </svg>
          {formatNumber(Math.abs(p.growthAcresPerHour), 0)} ac/h
        </span>
        <span className="mono">{p.hotspotCount} hot</span>
        <span className="mono" title="Fire radiative power">
          {formatNumber(p.frp)} MW
        </span>
        <span
          className="mono"
          style={{ marginLeft: "auto", color: "#6d7684", fontSize: 9.5 }}
          title="Time since first detection"
        >
          first {formatAge(firstSeen)} ago
        </span>
      </div>

      <div
        className={`conf-meter ${p.kind === "official" ? "official" : ""}`}
        style={{ marginTop: 8 }}
      >
        <span
          style={{
            width: `${p.confidence}%`,
            background:
              p.kind === "official"
                ? undefined
                : `linear-gradient(90deg, ${confidenceTone(p.confidence, p.kind) === "conf-low" ? "#64748b" : "#ff4d9d"}, #ffb020)`,
          }}
        />
      </div>

      {selected && p.confidenceBreakdown ? (
        <div
          style={{
            display: "flex",
            gap: 12,
            marginTop: 8,
            fontSize: 9.5,
            color: "#9aa4b4",
            borderTop: "1px dashed rgba(255,255,255,0.07)",
            paddingTop: 7,
          }}
        >
          <span className="mono">fused {(p.confidenceBreakdown.fused * 100).toFixed(0)}%</span>
          <span className="mono">×{p.confidenceBreakdown.corroboration.toFixed(2)} corr</span>
          <span className="mono">×{p.confidenceBreakdown.freshness.toFixed(2)} fresh</span>
        </div>
      ) : null}

      {selected ? (
        <div style={{ marginTop: 6, opacity: 0.85, display: "flex", justifyContent: "flex-end" }}>
          <Sparkline
            values={[p.frp * 0.35, p.frp * 0.55, p.frp * 0.7, p.frp * 0.85, p.frp]}
            width={116}
            height={18}
          />
        </div>
      ) : null}
    </button>
  );
}
