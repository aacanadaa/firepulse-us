"use client";

import type { SpreadForecast, SpreadLevel } from "@firepulse/protocol";
import { formatAge, formatClockShort, formatDate, timeZoneAbbr } from "@/lib/format";
import { spreadSwatches } from "@/lib/layers";
import type { MapType } from "@/lib/places";

interface Props {
  forecast: SpreadForecast | null;
  loading: boolean;
  mapType: MapType;
  now: number;
}

const LEVEL_LABEL: Record<SpreadLevel, string> = {
  none: "No growth",
  low: "Low growth",
  moderate: "Moderate growth",
  high: "High growth",
};

export const SPREAD_WARNING =
  "For learning only. Never use this to decide whether to evacuate. Satellite data can be hours old and the model doesn't know about firefighting. Follow local officials and call 911 in an emergency.";

function when(ms: number): string {
  return `${formatDate(ms)} ${formatClockShort(ms)} ${timeZoneAbbr()}`;
}

export default function SpreadSection({ forecast, loading, mapType, now }: Props) {
  const ready = forecast?.status === "ready" ? forecast : null;
  const w = ready?.weather;

  return (
    <div className="ins-section" aria-live="polite">
      <div className="ins-section-head">
        <span className="kicker">Next-day spread · Experimental</span>
        {forecast?.demo ? <span className="spread-tag">Demo fire</span> : null}
      </div>

      {loading && !ready ? (
        <div>
          <p className="disclaimer" style={{ margin: "0 0 8px" }}>
            Running the spread model with today&apos;s satellite detections and weather…
          </p>
          <div className="spread-progress">
            <span />
          </div>
        </div>
      ) : !ready ? (
        <p className="disclaimer" style={{ margin: 0 }}>
          {forecast?.reason ?? "No prediction for this fire."}
        </p>
      ) : (
        <>
          <div className="spread-summary">
            <p>{ready.summary?.text}</p>
            {ready.summary ? (
              <span className={`spread-level ${ready.summary.level}`}>{LEVEL_LABEL[ready.summary.level]}</span>
            ) : null}
          </div>

          {w ? (
            <div className="spread-weather">
              <span>
                High {w.tmaxF}°F · RH {w.rhMin}% · Wind {w.windFrom} {w.windMph} mph, gusts {w.gustMph}
                {w.erc != null ? ` · ERC ${w.erc}` : ""}
              </span>
              {w.redFlag ? <span className="spread-tag danger">Red Flag Warning</span> : null}
            </div>
          ) : null}

          {ready.missingInputs && ready.missingInputs.length > 0 ? (
            <p className="disclaimer" style={{ margin: "6px 0 0" }}>
              Ran without {ready.missingInputs.join(", ")}; the model used typical values instead.
            </p>
          ) : null}

          <div className="spread-legend" aria-label="Spread forecast legend">
            {spreadSwatches(mapType).map((s) => (
              <span key={s.band} className="spread-legend-item">
                <span className="legend-swatch" style={{ background: s.color, width: 14 }} />
                {s.label}
              </span>
            ))}
            <span className="spread-legend-item">
              <span className="spread-window-swatch" />
              64 km window
            </span>
          </div>

          <dl className="provenance" style={{ marginTop: 10 }}>
            <dt>Valid until</dt>
            <dd>{ready.validFor ? when(Date.parse(ready.validFor)) : "—"}</dd>
            <dt>Updated</dt>
            <dd>
              {ready.generatedAt
                ? `${formatAge(Math.max(0, now - Date.parse(ready.generatedAt)))} ago`
                : "—"}
            </dd>
            <dt>Model</dt>
            <dd title="Area under the precision-recall curve on held-out fires. Higher is better.">
              {ready.model?.name} · AUC-PR {ready.model?.testAucPr.toFixed(3)}
            </dd>
          </dl>
          <p className="disclaimer" style={{ margin: "6px 0 0" }}>
            Shading ranks where the model expects fire tomorrow. It is not a probability. On held-out
            fires the model beats &ldquo;tomorrow looks like today&rdquo; (AUC-PR 0.115) and the
            original research baseline (0.284).
          </p>
        </>
      )}

      <p className="spread-warning">{SPREAD_WARNING}</p>
    </div>
  );
}
