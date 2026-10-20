"use client";

import { MODALITY_LABEL, type IncidentDetail, type IncidentFeature } from "@firepulse/protocol";
import {
  formatAcres,
  formatAge,
  formatDate,
  formatMw,
  formatNumber,
} from "@/lib/format";
import { Icon, ConfidenceBadge, Sparkline, SourceTag } from "./ui";

interface Props {
  incident: IncidentFeature;
  detail: IncidentDetail | null;
  now: number;
  onClose: () => void;
  onFocus: () => void;
  loading: boolean;
}

export default function DetailPanel({
  incident,
  detail,
  now,
  onClose,
  onFocus,
  loading,
}: Props) {
  const p = incident.properties;
  const b = p.confidenceBreakdown;
  const isOfficial = p.kind === "official";
  const age = now - Date.parse(p.updatedAt);
  const series = detail?.series ?? [];
  const maxEffective = Math.max(0.001, ...p.evidence.map((e) => e.effective));

  return (
    <aside
      className="detail-panel detail-enter glass"
      style={{
        position: "absolute",
        top: 60,
        right: 16,
        bottom: 112,
        width: 372,
        zIndex: 32,
        borderRadius: 16,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      aria-label="Incident detail"
    >
      <div
        style={{
          padding: "13px 15px 12px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          background: isOfficial
            ? "linear-gradient(180deg, rgba(255,69,58,0.08), transparent)"
            : "linear-gradient(180deg, rgba(255,176,32,0.07), transparent)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ConfidenceBadge confidence={p.confidence} kind={p.kind} />
          <span
            className="kicker"
            style={{ color: isOfficial ? "#e0574f" : "#c9973f", fontSize: 8.5 }}
          >
            {isOfficial ? "OFFICIAL PERIMETER" : "EARLY ACTIVE FIRE ZONE"}
          </span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
            <button type="button" className="icon-btn" onClick={onFocus} title="Zoom to fire" style={{ width: 24, height: 24 }}>
              <Icon name="target" size={12} />
            </button>
            <button type="button" className="icon-btn" onClick={onClose} title="Close" style={{ width: 24, height: 24 }}>
              <Icon name="close" size={11} />
            </button>
          </span>
        </div>

        <h2
          className="tight"
          style={{ margin: "8px 0 0", fontSize: 20, fontWeight: 750, lineHeight: 1.15 }}
        >
          {p.name}
        </h2>
        <div style={{ display: "flex", gap: 7, alignItems: "center", marginTop: 4, fontSize: 10 }}>
          <span className="mono" style={{ color: "#8a94a6" }}>
            {[p.county, p.state].filter(Boolean).join(", ") || "Location pending"}
          </span>
          <span style={{ color: "#3d4553" }}>·</span>
          <span className="mono" style={{ color: "#8a94a6", textTransform: "capitalize" }}>
            {p.cause ?? "unknown cause"}
          </span>
          <span style={{ color: "#3d4553" }}>·</span>
          <span
            className="mono"
            style={{ color: p.status === "growing" ? "#ff9f5a" : "#8a94a6", textTransform: "capitalize" }}
          >
            {p.status}
          </span>
        </div>
      </div>

      <div className="thin-scroll" style={{ flex: 1, overflowY: "auto", padding: "13px 15px 18px" }}>
        {p.precursor ? (
          <div
            style={{
              padding: "10px 11px",
              borderRadius: 10,
              background: "linear-gradient(135deg, rgba(255,176,32,0.12), rgba(255,77,157,0.06))",
              border: "1px solid rgba(255,176,32,0.26)",
              marginBottom: 13,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="clock" size={12} className="text-amber-300" />
              <span className="kicker" style={{ color: "#e5b869" }}>
                Warning delivered before official mapping
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 7, marginTop: 4 }}>
              <span
                className="mono tight"
                style={{ fontSize: 27, fontWeight: 800, color: "#ffd27a", lineHeight: 1 }}
              >
                {p.precursor.leadTimeMinutes}
              </span>
              <span style={{ fontSize: 11, color: "#c9a46a" }}>minutes earlier</span>
            </div>
            <div style={{ fontSize: 9.5, color: "#9c8a6d", marginTop: 5, lineHeight: 1.5 }}>
              Fusion flagged this zone at{" "}
              <span className="mono">{formatAge(now - Date.parse(p.precursor.firstDetectedAt))}</span>{" "}
              ago with {p.precursor.peakConfidence}% peak confidence. NIFC published the
              perimeter {formatAge(now - Date.parse(p.officialSince ?? p.updatedAt))} ago.
            </div>
          </div>
        ) : null}

        {!isOfficial ? (
          <div
            style={{
              padding: "9px 11px",
              borderRadius: 9,
              border: "1px dashed rgba(255,176,32,0.26)",
              background: "rgba(255,176,32,0.035)",
              marginBottom: 13,
              fontSize: 10,
              lineHeight: 1.55,
              color: "#a99a80",
            }}
          >
            <strong style={{ color: "#e8c98a" }}>Not yet confirmed.</strong> This polygon is
            algorithmically estimated from converging early signals. It is not a surveyed
            fire perimeter and must not be used for evacuation decisions.
          </div>
        ) : null}

        {/* metrics */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 1,
            background: "rgba(255,255,255,0.055)",
            border: "1px solid rgba(255,255,255,0.055)",
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          <Metric label="Zone area" value={formatAcres(p.areaAcres)} />
          <Metric label="Fire radiative power" value={formatMw(p.frp)} />
          <Metric
            label="Growth"
            value={`${p.growthAcresPerHour >= 0 ? "+" : ""}${formatNumber(p.growthAcresPerHour)} ac/h`}
            accent={p.growthAcresPerHour > 100 ? "#ff9f5a" : undefined}
          />
          <Metric label="Hotspots" value={`${p.hotspotCount}`} />
        </div>

        {/* confidence model */}
        <SectionTitle>Confidence model</SectionTitle>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "11px 12px",
            borderRadius: 10,
            background: "rgba(255,255,255,0.025)",
            border: "1px solid rgba(255,255,255,0.055)",
          }}
        >
          <div style={{ textAlign: "center", flex: "none" }}>
            <div
              className="mono tight"
              style={{
                fontSize: 30,
                lineHeight: 1,
                fontWeight: 800,
                color: isOfficial ? "#ff6b61" : "#ffc25c",
              }}
            >
              {isOfficial ? "100" : p.confidence}
              <span style={{ fontSize: 13, opacity: 0.6 }}>%</span>
            </div>
            <div className="kicker" style={{ marginTop: 3, fontSize: 7.5 }}>
              fused score
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <FactorRow
              label="evidence fusion"
              value={b.fused}
              display={`${(b.fused * 100).toFixed(1)}%`}
              tone="#ff4d9d"
            />
            <FactorRow
              label="independent modalities"
              value={(b.corroboration - 1) / 0.1}
              display={`${b.distinctModalities} ·×${b.corroboration.toFixed(2)}`}
              tone="#a78bfa"
            />
            <FactorRow
              label="freshness"
              value={(b.freshness - 0.55) / 0.45}
              display={`×${b.freshness.toFixed(2)}`}
              tone="#38bdf8"
            />
          </div>
        </div>
        <div className="mono" style={{ fontSize: 8.5, color: "#5d6675", marginTop: 5, lineHeight: 1.5 }}>
          {b.rationale} · 100 × {b.fused.toFixed(3)} × {b.corroboration.toFixed(2)} ×{" "}
          {b.freshness.toFixed(2)}
        </div>

        {/* evidence */}
        <SectionTitle>Evidence ({p.evidence.length} sources)</SectionTitle>
        <div
          style={{
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.055)",
            background: "rgba(255,255,255,0.02)",
            padding: "3px 10px",
          }}
        >
          {p.evidence.length === 0 ? (
            <div style={{ padding: "10px 0", fontSize: 10.5, color: "#6d7684" }}>
              Official data only — no algorithmic evidence attached.
            </div>
          ) : (
            p.evidence.map((e) => (
              <div key={e.source} className="evidence-row">
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <SourceTag source={e.source} count={e.count} />
                    <span style={{ fontSize: 9.5, color: "#7d8797" }}>
                      {MODALITY_LABEL[e.modality] ?? e.modality}
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: 3,
                      height: 2.5,
                      borderRadius: 99,
                      background: "rgba(255,255,255,0.06)",
                      overflow: "hidden",
                      width: "100%",
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.min(100, (e.effective / maxEffective) * 100)}%`,
                        height: "100%",
                        background: "linear-gradient(90deg, #ff8a3d, #ffd27a)",
                      }}
                    />
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="mono" style={{ fontSize: 10, color: "#d5dbe5" }}>
                    {Math.round(e.contribution * 100)}%
                  </div>
                  <div className="mono" style={{ fontSize: 8, color: "#5d6675" }}>
                    {e.lastSeen ? formatAge(now - Date.parse(e.lastSeen)) : "—"} ago
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* series */}
        <SectionTitle>Last 6 hours of evidence</SectionTitle>
        <div
          style={{
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.055)",
            background: "rgba(255,255,255,0.02)",
            padding: 10,
          }}
        >
          {loading && series.length < 2 ? (
            <div className="shimmer" style={{ height: 46 }} />
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                <div>
                  <div className="kicker" style={{ fontSize: 7.5 }}>
                    FRP (MW)
                  </div>
                  <div className="mono" style={{ fontSize: 12, color: "#ffd27a" }}>
                    {formatMw(p.frp)}
                  </div>
                </div>
                <Sparkline
                  values={series.length > 1 ? series.map((s) => s.frp) : [p.frp * 0.4, p.frp]}
                  width={190}
                  height={38}
                  color="#ff9f45"
                />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 8 }}>
                <div>
                  <div className="kicker" style={{ fontSize: 7.5 }}>
                    confidence
                  </div>
                  <div className="mono" style={{ fontSize: 12, color: "#c4b5fd" }}>
                    {p.confidence}%
                  </div>
                </div>
                <Sparkline
                  values={series.length > 1 ? series.map((s) => s.confidence) : [p.confidence * 0.7, p.confidence]}
                  width={190}
                  height={30}
                  color="#a78bfa"
                  fill={false}
                />
              </div>
            </>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 6,
              fontSize: 8,
              color: "#4f5765",
            }}
            className="mono"
          >
            <span>-6h</span>
            <span>first detected {formatDate(Date.parse(p.firstDetectedAt))}</span>
            <span>now</span>
          </div>
        </div>

        {detail && detail.neighbors.length > 0 ? (
          <>
            <SectionTitle>Nearby incidents</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {detail.neighbors.map((n) => (
                <div
                  key={n.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    fontSize: 10.5,
                    padding: "6px 8px",
                    borderRadius: 7,
                    background: "rgba(255,255,255,0.022)",
                    border: "1px solid rgba(255,255,255,0.045)",
                  }}
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 99,
                      background: n.kind === "official" ? "#ff4d4d" : "#ffb020",
                    }}
                  />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {n.name}
                  </span>
                  <span className="mono" style={{ color: "#7d8797", fontSize: 9.5 }}>
                    {n.distanceKm} km
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <SectionTitle>Provenance</SectionTitle>
        <div style={{ display: "grid", gap: 5, fontSize: 9.5, color: "#8a94a6" }}>
          <Row k="First detected" v={new Date(p.firstDetectedAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} />
          <Row k="Last signal" v={`${formatAge(age)} ago`} />
          <Row k="Official since" v={p.officialSince ? new Date(p.officialSince).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }) : "—"} />
          <Row k="Centroid" v={`${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`} />
          <Row k="H3 cells" v={`${p.cells?.length ?? 0} @ res 8`} />
          <Row k="Incident id" v={p.id.slice(0, 18)} />
        </div>
      </div>
    </aside>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ background: "rgba(10,13,18,0.72)", padding: "9px 11px" }}>
      <div className="kicker" style={{ fontSize: 7.5 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 14, fontWeight: 700, marginTop: 2, color: accent ?? "#e8edf5" }}>
        {value}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="kicker"
      style={{ margin: "16px 0 7px", display: "flex", alignItems: "center", gap: 7 }}
    >
      {children}
      <span style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
    </div>
  );
}

function FactorRow({
  label,
  value,
  display,
  tone,
}: {
  label: string;
  value: number;
  display: string;
  tone: string;
}) {
  return (
    <div style={{ marginBottom: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8.5, color: "#8a94a6" }}>
        <span>{label}</span>
        <span className="mono" style={{ color: "#d5dbe5" }}>{display}</span>
      </div>
      <div
        style={{
          height: 2.5,
          borderRadius: 99,
          background: "rgba(255,255,255,0.07)",
          marginTop: 2,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.max(2, Math.min(100, value * 100))}%`,
            height: "100%",
            background: tone,
          }}
        />
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
      <span>{k}</span>
      <span className="mono" style={{ color: "#b6c0ce", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis" }}>
        {v}
      </span>
    </div>
  );
}
