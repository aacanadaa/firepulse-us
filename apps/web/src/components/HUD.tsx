"use client";

import type { LayerFlags } from "./MapCanvas";
import { Icon, Toggle } from "./ui";
import { timeZoneAbbr } from "@/lib/format";

interface Props {
  layers: LayerFlags;
  onToggle: (key: keyof LayerFlags) => void;
  legendOpen: boolean;
  onLegend: () => void;
  medianLeadTime: number | null;
  mergeCount: number;
  latencyMs: number;
  ingestRate: number;
  clients: number;
  sidebarOpen: boolean;
  onSidebar: () => void;
}

export default function HUD({
  layers,
  onToggle,
  legendOpen,
  onLegend,
  medianLeadTime,
  mergeCount,
  latencyMs,
  ingestRate,
  clients,
  sidebarOpen,
  onSidebar,
}: Props) {
  return (
    <>
      <div className="hud-actions">
        {!sidebarOpen ? (
          <button
            type="button"
            className="icon-btn glass"
            onClick={onSidebar}
            title="Show incident feed"
            style={{ height: 30, width: 32 }}
          >
            <Icon name="menu" size={13} />
          </button>
        ) : null}

        <div
          className="glass"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: 4,
            borderRadius: 10,
          }}
        >
          <Toggle
            className="hud-toggle"
            active={layers.official}
            onClick={() => onToggle("official")}
            icon="layers"
            label="Official"
            title="Official NIFC / CAL FIRE perimeters"
          />
          <Toggle
            className="hud-toggle"
            active={layers.estimated}
            onClick={() => onToggle("estimated")}
            icon="flame"
            label="Early"
            title="Algorithmic Early Active Fire Zones"
          />
          <Toggle
            className="hud-toggle"
            active={layers.thermal}
            onClick={() => onToggle("thermal")}
            icon="activity"
            label="Thermal"
            title="Satellite thermal anomalies, coloured by age"
          />
          <Toggle
            className="hud-toggle"
            active={layers.wind}
            onClick={() => onToggle("wind")}
            icon="wind"
            label="Wind"
            title="Animated HRRR wind field"
          />
          <Toggle
            className="hud-toggle"
            active={layers.hex}
            onClick={() => onToggle("hex")}
            icon="hex"
            label="H3"
            title="H3 hexagonal cells behind each fused zone"
          />
          <Toggle
            className="hud-toggle"
            active={layers.labels}
            onClick={() => onToggle("labels")}
            icon="tag"
            label="Labels"
            title="Incident and place labels"
          />
          <div style={{ width: 1, height: 18, background: "rgba(255,255,255,0.1)", margin: "0 2px" }} />
          <button
            type="button"
            className={`icon-btn ${legendOpen ? "on" : ""}`}
            onClick={onLegend}
            title="Map legend and pipeline health"
            style={{ width: 28, height: 26 }}
            aria-expanded={legendOpen}
          >
            <Icon name="info" size={13} />
          </button>
        </div>

        <div
          className="glass hud-median"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            borderRadius: 10,
            flex: "none",
          }}
          title={`Median warning across ${mergeCount} early-estimate → official merges`}
        >
          <Icon name="clock" size={12} className="text-amber-300" />
          <div style={{ lineHeight: 1 }}>
            <div className="kicker" style={{ fontSize: 7.5 }}>
              median head start
            </div>
            <div className="mono tight" style={{ fontSize: 13, fontWeight: 700, color: "#ffd27a" }}>
              {medianLeadTime == null ? "—" : `${medianLeadTime} min`}
            </div>
          </div>
        </div>
      </div>

      {legendOpen ? (
        <div
          className="glass"
          style={{
            position: "absolute",
            top: 62,
            right: 16,
            zIndex: 37,
            width: 272,
            borderRadius: 13,
            padding: "13px 14px",
            fontSize: 10,
          }}
        >
          <div className="kicker" style={{ marginBottom: 9 }}>
            Layer semantics
          </div>

          <LegendRow
            swatch={
              <span
                style={{
                  width: 26,
                  height: 15,
                  borderRadius: 3,
                  border: "1.5px solid #ff5147",
                  background:
                    "repeating-linear-gradient(135deg, rgba(255,74,62,0.55) 0 1.5px, rgba(255,74,62,0.06) 1.5px 5px)",
                }}
              />
            }
            title="Official perimeter"
            sub="NIFC / CAL FIRE · surveyed · 100%"
          />
          <LegendRow
            swatch={
              <span
                style={{
                  width: 26,
                  height: 15,
                  borderRadius: 3,
                  border: "1.5px dashed #ffb020",
                  background: "rgba(255,176,32,0.1)",
                  boxShadow: "0 0 12px rgba(255,176,32,0.35)",
                }}
              />
            }
            title="Early active fire zone"
            sub="Fusion estimate · pulsing · 1–99%"
          />

          <div
            style={{
              height: 1,
              background: "rgba(255,255,255,0.07)",
              margin: "9px 0",
            }}
          />

          <div className="kicker" style={{ marginBottom: 7 }}>
            Thermal age
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <ThermalDot color="#fff3cd" size={7} label="<1h" glow />
            <ThermalDot color="#ff943a" size={6} label="1–6h" glow />
            <ThermalDot color="#c63420" size={5} label="6–24h" glow />
            <ThermalDot color="#742c2a" size={4.5} label=">24h" />
          </div>
          <div style={{ fontSize: 8.5, color: "#6d7684", marginTop: 6, lineHeight: 1.5 }}>
            Dot area encodes Fire Radiative Power (FRP). Bright dots are the freshest
            detections — the earliest evidence the system can act on.
          </div>

          <div style={{ height: 1, background: "rgba(255,255,255,0.07)", margin: "9px 0" }} />

          <div className="kicker" style={{ marginBottom: 6 }}>
            Wind speed
          </div>
          <div
            style={{
              height: 4,
              borderRadius: 99,
              background: "linear-gradient(90deg, #3f6b86, #7dd3fc, #fcd34d, #fb7185)",
            }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 8,
              color: "#6d7684",
              marginTop: 3,
            }}
            className="mono"
          >
            <span>calm</span>
            <span>critical spread</span>
          </div>

          <div style={{ height: 1, background: "rgba(255,255,255,0.07)", margin: "9px 0" }} />

          <div style={{ display: "grid", gap: 4, fontSize: 9, color: "#8a94a6" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>WebSocket latency</span>
              <span className="mono" style={{ color: "#c8d2e0" }}>{latencyMs} ms</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Ingest rate</span>
              <span className="mono" style={{ color: "#c8d2e0" }}>{ingestRate.toFixed(1)} sig/s</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Live sessions</span>
              <span className="mono" style={{ color: "#c8d2e0" }}>{clients}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Merges tracked</span>
              <span className="mono" style={{ color: "#c8d2e0" }}>{mergeCount}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Timescale</span>
              <span className="mono" style={{ color: "#c8d2e0" }}>{timeZoneAbbr()}</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function LegendRow({
  swatch,
  title,
  sub,
}: {
  swatch: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 7 }}>
      {swatch}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: "#e2e8f2" }}>{title}</div>
        <div className="mono" style={{ fontSize: 8, color: "#6d7684" }}>{sub}</div>
      </div>
    </div>
  );
}

function ThermalDot({
  color,
  size,
  label,
  glow,
}: {
  color: string;
  size: number;
  label: string;
  glow?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          width: size,
          height: size,
          borderRadius: 99,
          background: color,
          boxShadow: glow ? `0 0 ${size}px ${color}` : undefined,
        }}
      />
      <span className="mono" style={{ fontSize: 8, color: "#8a94a6" }}>
        {label}
      </span>
    </span>
  );
}
