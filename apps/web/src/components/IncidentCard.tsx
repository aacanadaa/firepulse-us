"use client";

import type { IncidentFeature } from "@firepulse/protocol";
import { formatAcres, formatAge, formatNumber } from "@/lib/format";
import { isNew } from "@/lib/select";
import { SourceLabel } from "./ui";

export default function IncidentCard({
  incident,
  selected,
  now,
  onSelect,
}: {
  incident: IncidentFeature;
  selected: boolean;
  now: number;
  onSelect: (id: string) => void;
}) {
  const p = incident.properties;
  const lastUpdate = Date.parse(p.updatedAt);
  const firstDetected = Date.parse(p.firstDetectedAt);
  const inReplayPast = lastUpdate > now + 1000;
  const age = inReplayPast
    ? Math.max(0, now - firstDetected)
    : Math.max(0, now - lastUpdate);
  const early = p.kind === "estimated";
  const fresh = isNew(incident, now);
  const place = [p.county, p.state].filter(Boolean).join(", ");
  const growth = p.growthAcresPerHour;
  const sources = p.sources.slice(0, 3);

  return (
    <button
      type="button"
      className={`row ${selected ? "sel" : ""}`}
      onClick={() => onSelect(p.id)}
      aria-pressed={selected}
    >
      <div className="row-top">
        <span className={`kind-sq ${early ? "" : "official"}`} aria-hidden="true" />
        <span className="row-name">{p.name}</span>
        {fresh ? <span className="new-flag">New</span> : null}
        <span className="row-age" title={inReplayPast ? "Fire age at this replay moment" : "Time since last signal"}>
          {formatAge(age)}
        </span>
      </div>

      <div className="row-place">
        {place || "Location pending"}
        <span style={{ color: "var(--line-strong)" }}> · </span>
        {p.cause ?? "unknown cause"}
        <span style={{ color: "var(--line-strong)" }}> · </span>
        {p.status}
      </div>

      <div className="row-metrics">
        <span>{formatAcres(p.areaAcres)}</span>
        <span className="sep">/</span>
        <span className="metric-grow" title="Area change over the trailing window">
          {growth >= 0 ? "+" : "−"}
          {formatNumber(Math.abs(growth))} ac/h
        </span>
        <span className="sep">/</span>
        <span>{p.hotspotCount} hot</span>
      </div>

      <div className="row-bottom">
        <div className="sources">
          {sources.map((s) => (
            <SourceLabel key={s.source} source={s.source} />
          ))}
          {p.sources.length > 3 ? (
            <span className="source">+{p.sources.length - 3}</span>
          ) : null}
        </div>
        <div className="conf" title={`Fusion confidence ${p.confidence}%`}>
          <span className={`conf-num ${early ? "" : "official"}`}>{p.confidence}</span>
          <span className="conf-track">
            <span
              className={`conf-fill ${early ? "" : "official"}`}
              style={{ width: `${p.confidence}%` }}
            />
          </span>
        </div>
      </div>
    </button>
  );
}
