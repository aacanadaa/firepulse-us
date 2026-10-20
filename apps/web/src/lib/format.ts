import type { SourceId } from "@firepulse/protocol";
import { SOURCE_PROFILES } from "@firepulse/protocol";

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatAgeShort(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

export function formatClockShort(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/Los_Angeles",
  });
}

export function formatNumber(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function formatAcres(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 100_000) return `${Math.round(n / 1000)}k ac`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k ac`;
  return `${Math.round(n)} ac`;
}

export function formatMw(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)} GW`;
  return `${Math.round(n)} MW`;
}

export function confidenceTone(confidence: number, kind: "estimated" | "official"): string {
  if (kind === "official") return "conf-official";
  if (confidence >= 75) return "conf-high";
  if (confidence >= 40) return "conf-mid";
  return "conf-low";
}

export function sourceMeta(source: SourceId) {
  return SOURCE_PROFILES[source] ?? { short: source.toUpperCase(), color: "#94a3b8" };
}

export function timeZoneAbbr(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "short",
  }).formatToParts(new Date());
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "PT";
}
