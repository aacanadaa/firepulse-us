import type { SourceId } from "@firepulse/protocol";
import { sourceMeta } from "@/lib/format";

type IconName =
  | "flame"
  | "wind"
  | "layers"
  | "hex"
  | "tag"
  | "close"
  | "play"
  | "pause"
  | "live"
  | "target"
  | "info"
  | "activity"
  | "clock"
  | "arrow"
  | "menu"
  | "chevron";

const PATHS: Record<IconName, string> = {
  flame:
    "M12 2c.5 3.2-1.2 4.2-2.4 5.6C8.2 9.2 7 10.6 7 13a5 5 0 0 0 10 0c0-1.5-.5-2.6-1.2-3.7-.6 1-1.4 1.4-2.2 1.5.6-2.2.3-5-1.6-8.8Z",
  wind: "M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7",
  layers: "m12 3 9 5-9 5-9-5 9-5Zm9 9-9 5-9-5m18 4-9 5-9-5",
  hex: "M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4l8-4.6Z",
  tag: "M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8ZM7.5 7.5h.01",
  close: "M6 6l12 12M18 6 6 18",
  play: "M8 5.5v13l11-6.5-11-6.5Z",
  pause: "M9 5v14M15 5v14",
  live: "M12 12h.01M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13",
  target: "M12 3v3m0 12v3M3 12h3m12 0h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  arrow: "M5 12h14M13 6l6 6-6 6",
  menu: "M4 7h16M4 12h16M4 17h16",
  chevron: "m6 9 6 6 6-6",
};

export function Icon({
  name,
  size = 14,
  strokeWidth = 1.7,
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function ConfidenceBadge({
  confidence,
  kind,
  size = "md",
}: {
  confidence: number;
  kind: "estimated" | "official";
  size?: "sm" | "md";
}) {
  const tone =
    kind === "official"
      ? "conf-official"
      : confidence >= 75
        ? "conf-high"
        : confidence >= 40
          ? "conf-mid"
          : "conf-low";
  return (
    <span
      className={`conf-badge ${tone}`}
      style={size === "sm" ? { fontSize: 10, padding: "1px 5px" } : undefined}
      title={
        kind === "official"
          ? "Official government ground truth"
          : `Fusion confidence ${confidence}%`
      }
    >
      <i className="conf-dot" />
      {kind === "official" ? "100%" : `${confidence}%`}
    </span>
  );
}

export function SourceTag({ source, count }: { source: SourceId; count?: number }) {
  const meta = sourceMeta(source);
  return (
    <span className="source-tag" title={`${meta.short} signal`}>
      <i style={{ background: meta.color, boxShadow: `0 0 5px ${meta.color}` }} />
      {meta.short}
      {count && count > 1 ? ` ×${count}` : ""}
    </span>
  );
}

export function Sparkline({
  values,
  width = 120,
  height = 26,
  color = "#ffb020",
  fill = true,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
}) {
  if (values.length < 2) {
    return <div style={{ width, height }} className="shimmer" />;
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(1e-6, max - min);
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / span) * (height - 3) - 1.5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${points.join(" L")}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      {fill ? (
        <path
          d={`${line} L${width},${height} L0,${height} Z`}
          fill={color}
          opacity={0.1}
        />
      ) : null}
      <path d={line} fill="none" stroke={color} strokeWidth={1.3} strokeLinejoin="round" />
    </svg>
  );
}

export function Stat({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: string;
  accent?: string;
  hint?: string;
}) {
  return (
    <div style={{ minWidth: 0 }} title={hint}>
      <div className="kicker" style={{ fontSize: 8.5 }}>
        {label}
      </div>
      <div
        className="mono tight"
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: accent ?? "#e8edf5",
          marginTop: 2,
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}

export function Toggle({
  active,
  onClick,
  icon,
  label,
  title,
  className = "",
}: {
  active: boolean;
  onClick: () => void;
  icon: IconName;
  label: string;
  title: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`icon-btn ${active ? "on" : ""} ${className}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      style={{ width: "auto", gap: 6, padding: "0 9px", height: 28, fontSize: 10, fontWeight: 600 }}
    >
      <Icon name={icon} size={12} />
      <span style={{ letterSpacing: "0.02em" }}>{label}</span>
    </button>
  );
}

export function Dot({ color = "#43e08a", pulse = true }: { color?: string; pulse?: boolean }) {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: 99,
        background: color,
        boxShadow: `0 0 8px ${color}`,
        display: "inline-block",
        flex: "none",
        animation: pulse ? "livePulse 2s infinite" : undefined,
      }}
    />
  );
}
