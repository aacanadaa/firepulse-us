"use client";

import {
  MODALITY_LABEL,
  type IncidentDetail,
  type IncidentFeature,
  type SpreadForecast,
} from "@firepulse/protocol";
import { formatAcres, formatAge, formatDate, formatMw, formatNumber, plainFireStatus } from "@/lib/format";
import type { MapType } from "@/lib/places";
import { Icon, Sparkline } from "./ui";
import SpreadSection from "./SpreadSection";

interface Props {
  incident: IncidentFeature;
  detail: IncidentDetail | null;
  now: number;
  onClose: () => void;
  onFocus: () => void;
  loading: boolean;
  spread: SpreadForecast | null;
  spreadLoading: boolean;
  mapType: MapType;
}

export default function DetailPanel({
  incident,
  detail,
  now,
  onClose,
  onFocus,
  loading,
  spread,
  spreadLoading,
  mapType,
}: Props) {
  const p = incident.properties;
  const b = p.confidenceBreakdown;
  const official = p.kind === "official";
  const age = Math.max(0, now - Date.parse(p.updatedAt));
  const series = detail?.series ?? [];
  const maxEffective = Math.max(0.001, ...p.evidence.map((e) => e.effective));

  return (
    <aside className="inspector" aria-label="Incident detail">
      <div className="ins-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="kicker" style={{ color: official ? "var(--forest)" : "var(--accent)" }}>
            {official ? "Official perimeter" : "Early estimate"}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="icon-btn"
            onClick={onFocus}
            title="Frame this fire on the map"
            aria-label="Frame this fire on the map"
            style={{ width: 24, height: 24 }}
          >
            <Icon name="target" size={12} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="Close inspector"
            aria-label="Close inspector"
            style={{ width: 24, height: 24 }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>

        <h2 className="h1" style={{ marginTop: 9 }}>
          {p.name}
        </h2>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            marginTop: 5,
            fontFamily: "var(--mono)",
            fontSize: 9.5,
            color: "var(--muted)",
          }}
        >
          <span>{[p.county, p.state].filter(Boolean).join(", ") || "Location pending"}</span>
          {p.cause && p.cause !== "unknown" && p.cause !== "prescribed" ? (
            <>
              <span style={{ color: "var(--line-strong)" }}>·</span>
              <span style={{ textTransform: "capitalize" }}>{p.cause} cause</span>
            </>
          ) : null}
        </div>
        <p style={{ margin: "7px 0 0", fontSize: 11.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
          {plainFireStatus(p, now)}
        </p>
        <div className="ins-links">
          <a
            href={`https://forecast.weather.gov/MapClick.php?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}`}
            target="_blank"
            rel="noreferrer"
          >
            Alerts and weather here
          </a>
          <a href="https://inciweb.wildfire.gov/" target="_blank" rel="noreferrer">
            InciWeb incident updates
          </a>
        </div>
      </div>

      <div className="ins-scroll">
        {p.precursor ? (
          <div className="ins-section">
            <div className="lead-block">
              <div className="kicker">Warning before official mapping</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
                <span className="lead-number">{p.precursor.leadTimeMinutes}</span>
                <span style={{ fontSize: 11.5, color: "var(--muted)" }}>minutes earlier</span>
              </div>
              <p className="disclaimer" style={{ margin: "8px 0 0" }}>
                Fusion flagged this zone {formatAge(now - Date.parse(p.precursor.firstDetectedAt))} ago
                at {p.precursor.peakConfidence}% peak confidence. The official perimeter was published{" "}
                {formatAge(now - Date.parse(p.officialSince ?? p.updatedAt))} ago.
              </p>
            </div>
          </div>
        ) : !official ? (
          <div className="ins-section">
            <div style={{ borderLeft: "2px solid var(--accent)", paddingLeft: 10 }}>
              <div className="kicker" style={{ color: "var(--accent)" }}>
                Not yet confirmed
              </div>
              <p className="disclaimer" style={{ margin: "5px 0 0" }}>
                This polygon is estimated from converging early signals. It is not a surveyed fire
                perimeter and must not be used for evacuation decisions.
              </p>
            </div>
          </div>
        ) : null}

        <div className="ins-section">
          <div className="ins-section-head">
            <span className="kicker">Fire state</span>
            <span className="mono" style={{ fontSize: 9, color: "var(--faint)" }}>
              {formatAge(age)} since last signal
            </span>
          </div>
          <div className="metric-grid">
            <div className="metric">
              <div className="kicker" style={{ fontSize: 8.5 }}>Zone area</div>
              <div className="v">{formatAcres(p.areaAcres)}</div>
            </div>
            <div className="metric">
              <div className="kicker" style={{ fontSize: 8.5 }}>Radiative power</div>
              <div className="v">{formatMw(p.frp)}</div>
            </div>
            <div className="metric">
              <div className="kicker" style={{ fontSize: 8.5 }}>Growth</div>
              <div className="v" style={{ color: p.growthAcresPerHour > 100 ? "var(--accent)" : undefined }}>
                {p.growthAcresPerHour >= 0 ? "+" : "−"}
                {formatNumber(Math.abs(p.growthAcresPerHour))} ac/h
              </div>
            </div>
            <div className="metric">
              <div className="kicker" style={{ fontSize: 8.5 }}>Hotspots</div>
              <div className="v">{p.hotspotCount}</div>
            </div>
          </div>
        </div>

        <SpreadSection forecast={spread} loading={spreadLoading} mapType={mapType} now={now} />

        <div className="ins-section">
          <div className="ins-section-head">
            <span className="kicker">Confidence</span>
            <span className="mono" style={{ fontSize: 9, color: "var(--faint)" }}>
              {official ? "ground truth" : `${p.evidence.length} sources`}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
            <span
              className="mono"
              style={{
                fontSize: 34,
                fontWeight: 600,
                letterSpacing: "-0.05em",
                lineHeight: 1,
                color: official ? "var(--forest)" : "var(--ink)",
              }}
            >
              {p.confidence}
            </span>
            <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>
              / 100
            </span>
            <span className="mono" style={{ marginLeft: "auto", fontSize: 8.5, color: "var(--faint)" }}>
              {b.rationale}
            </span>
          </div>

          {official ? (
            <p className="disclaimer" style={{ margin: 0 }}>
              Surveyed and published by the responsible agency. No inference is applied; this
              perimeter is the authority.
            </p>
          ) : (
            <>
              <div className="factor">
                <span className="factor-label">Evidence fusion</span>
                <span className="factor-value">{(b.fused * 100).toFixed(1)}%</span>
                <span className="factor-track">
                  <span className="factor-fill" style={{ width: `${b.fused * 100}%` }} />
                </span>
              </div>
              <div className="factor">
                <span className="factor-label">Independent modalities</span>
                <span className="factor-value">
                  {b.distinctModalities} · ×{b.corroboration.toFixed(2)}
                </span>
                <span className="factor-track">
                  <span
                    className="factor-fill"
                    style={{ width: `${Math.min(100, ((b.corroboration - 1) / 0.1) * 100)}%` }}
                  />
                </span>
              </div>
              <div className="factor">
                <span className="factor-label">Freshness</span>
                <span className="factor-value">×{b.freshness.toFixed(2)}</span>
                <span className="factor-track">
                  <span
                    className="factor-fill"
                    style={{ width: `${Math.max(4, ((b.freshness - 0.55) / 0.45) * 100)}%` }}
                  />
                </span>
              </div>
              <div className="mono" style={{ fontSize: 8.5, color: "var(--faint)", marginTop: 10 }}>
                100 × {b.fused.toFixed(3)} × {b.corroboration.toFixed(2)} × {b.freshness.toFixed(2)}
              </div>
            </>
          )}
        </div>

        <div className="ins-section">
          <div className="ins-section-head">
            <span className="kicker">Evidence</span>
            <span className="mono" style={{ fontSize: 9, color: "var(--faint)" }}>
              {p.evidence.length} sources
            </span>
          </div>

          {p.evidence.length === 0 ? (
            <p className="disclaimer" style={{ margin: 0 }}>
              Official data only — no algorithmic evidence attached.
            </p>
          ) : (
            <>
              <div className="evidence-head">
                <span className="kicker" style={{ fontSize: 8 }}>Source</span>
                <span className="kicker" style={{ fontSize: 8, textAlign: "right" }}>Count</span>
                <span className="kicker" style={{ fontSize: 8, textAlign: "right" }}>Weight</span>
              </div>
              {p.evidence.map((e) => (
                <div key={e.source} className="evidence-row">
                  <div style={{ minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.03em", textTransform: "uppercase" }}>
                      {e.source}
                    </div>
                    <div style={{ fontSize: 9, color: "var(--faint)", marginTop: 1 }}>
                      {MODALITY_LABEL[e.modality] ?? e.modality}
                    </div>
                  </div>
                  <div className="mono" style={{ fontSize: 9.5, textAlign: "right", color: "var(--muted)" }}>
                    {e.count}
                  </div>
                  <div className="mono" style={{ fontSize: 9.5, textAlign: "right" }}>
                    {Math.round(e.contribution * 100)}%
                  </div>
                  <div className="evidence-bar">
                    <span style={{ width: `${Math.min(100, (e.effective / maxEffective) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="ins-section">
          <div className="ins-section-head">
            <span className="kicker">Evidence over 6 hours</span>
            <span className="mono" style={{ fontSize: 9, color: "var(--faint)" }}>
              {series.length > 1 ? `${series.length} samples` : "collecting"}
            </span>
          </div>

          {loading && series.length < 2 ? (
            <div style={{ height: 74, borderBottom: "1px solid var(--line)" }} />
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="kicker" style={{ fontSize: 8 }}>FRP · megawatts</span>
                <span className="mono" style={{ fontSize: 9.5 }}>{formatMw(p.frp)}</span>
              </div>
              <Sparkline
                values={series.length > 1 ? series.map((s) => s.frp) : [p.frp * 0.4, p.frp]}
                height={30}
                color="var(--accent)"
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 12 }}>
                <span className="kicker" style={{ fontSize: 8 }}>Confidence</span>
                <span className="mono" style={{ fontSize: 9.5 }}>{p.confidence}%</span>
              </div>
              <Sparkline
                values={series.length > 1 ? series.map((s) => s.confidence) : [p.confidence * 0.7, p.confidence]}
                height={26}
                color="var(--ink)"
              />
              <div
                className="mono"
                style={{ display: "flex", justifyContent: "space-between", marginTop: 5, fontSize: 8, color: "var(--faint)" }}
              >
                <span>−6h</span>
                <span>{formatDate(Date.parse(p.firstDetectedAt))}</span>
                <span>now</span>
              </div>
            </>
          )}
        </div>

        {detail && detail.neighbors.length > 0 ? (
          <div className="ins-section">
            <div className="ins-section-head">
              <span className="kicker">Nearby</span>
            </div>
            {detail.neighbors.map((n) => (
              <div key={n.id} className="neighbor">
                <span
                  style={{
                    width: 5,
                    height: 5,
                    background: n.kind === "official" ? "var(--forest)" : "var(--accent)",
                    flex: "none",
                  }}
                />
                <span className="nm">{n.name}</span>
                <span className="dist">{n.distanceKm} km</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="ins-section">
          <div className="ins-section-head">
            <span className="kicker">Provenance</span>
          </div>
          <dl className="provenance">
            <dt>First detected</dt>
            <dd>{new Date(p.firstDetectedAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour12: false })}</dd>
            <dt>Last signal</dt>
            <dd>{formatAge(age)} ago</dd>
            <dt>Official since</dt>
            <dd>
              {p.officialSince
                ? new Date(p.officialSince).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour12: false })
                : "—"}
            </dd>
            <dt>Centroid</dt>
            <dd>{p.lat.toFixed(4)}, {p.lon.toFixed(4)}</dd>
            <dt>H3 cells</dt>
            <dd>{p.cells?.length ?? 0} @ res 8</dd>
            <dt>Incident ID</dt>
            <dd title={p.id}>{p.id.slice(0, 18)}</dd>
          </dl>
        </div>

        <div className="ins-section">
          <p className="disclaimer" style={{ margin: 0 }}>
            Official perimeters are the authority. Algorithmic estimates are labelled and must not be
            used as the sole basis for evacuation or life-safety decisions.
          </p>
        </div>
      </div>
    </aside>
  );
}
