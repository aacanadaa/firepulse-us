import type { SourceId } from "@firepulse/protocol";
import { sourceMeta } from "@/lib/format";

export type IconName =
  | "sun"
  | "moon"
  | "auto"
  | "key"
  | "flame"
  | "wind"
  | "layers"
  | "hex"
  | "tag"
  | "close"
  | "play"
  | "pause"
  | "target"
  | "info"
  | "activity"
  | "clock"
  | "arrow"
  | "menu"
  | "chevron"
  | "check"
  | "minus"
  | "pin"
  | "search";

const PATHS: Record<IconName, string> = {
  sun: "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4",
  moon: "M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8Z",
  auto: "M4 5.5h16v10H4zM9 19.5h6M12 15.5v4",
  key: "M15.5 3.5a5 5 0 0 0-4.8 6.4L3.5 17.1V20.5h3.4l1.3-1.3v-2h2v-2h2l1.3-1.3A5 5 0 1 0 15.5 3.5Z",
  pin: "M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 1 1 13 0C18.5 14.8 12 21 12 21ZM12 12.3a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  search: "M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6ZM20 20l-4.4-4.4",
  flame:
    "M12 3c.4 3-1 4.4-2.3 5.7C8.3 10 7 11.5 7 13.4a5 5 0 0 0 10 0c0-1.6-.5-2.8-1.2-3.9-.5 1-1.2 1.5-2 1.6.6-2.3.4-5-1.8-8.1Z",
  wind: "M3 8h10.5a2.5 2.5 0 1 0-2.5-2.5M3 12h14a2.5 2.5 0 1 1-2.5 2.5M3 16h6.5",
  layers: "M12 3.5 20 8l-8 4.5L4 8l8-4.5Zm8 8.5-8 4.5L4 12m16 3.5-8 4.5-8-4.5",
  hex: "M12 3.2 19.5 7.5v8.4L12 20.2 4.5 15.9V7.5L12 3.2Z",
  tag: "M20.2 13 12 21.2 3.5 12.7V4h8.7l8 8a1.4 1.4 0 0 1 0 1ZM7.3 7.3h.01",
  close: "M6 6l12 12M18 6 6 18",
  play: "M8.5 5.8v12.4L18.5 12 8.5 5.8Z",
  pause: "M9 5.5v13M15 5.5v13",
  target:
    "M12 3v2.5m0 13V21M3 12h2.5m13 0H21M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z",
  info: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 11v5M12 8h.01",
  activity: "M3 12h3.5l2.5-7 4 14 2.5-7H21",
  clock: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 7.5V12l3 2",
  arrow: "M5 12h13M12.5 6.5 19 12l-6.5 5.5",
  menu: "M4 7h16M4 12h16M4 17h16",
  chevron: "m6.5 9.5 5.5 5 5.5-5",
  check: "m5 12.5 4.5 4.5L19 6.5",
  minus: "M5 12h14",
};

export function Icon({
  name,
  size = 14,
  strokeWidth = 1.5,
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

export function Sparkline({
  values,
  height = 34,
  color = "var(--ink)",
  baseline = true,
}: {
  values: number[];
  height?: number;
  color?: string;
  baseline?: boolean;
}) {
  const width = 300;
  if (values.length < 2) {
    return (
      <div
        style={{
          height,
          width: "100%",
          borderBottom: baseline ? "1px solid var(--line)" : undefined,
        }}
      />
    );
  }
  const max = Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const span = Math.max(0.0001, max - min);
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 2) + 1;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height, display: "block" }}
      aria-hidden="true"
    >
      {baseline ? (
        <line x1="0" y1={height - 0.5} x2={width} y2={height - 0.5} stroke="var(--line)" />
      ) : null}
      <path
        d={`M${points.join(" L")}`}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function SourceLabel({ source, count }: { source: SourceId; count?: number }) {
  const meta = sourceMeta(source);
  return (
    <span className="source" title={`${meta.short} signal`}>
      {meta.short}
      {count && count > 1 ? ` ${count}` : ""}
    </span>
  );
}
