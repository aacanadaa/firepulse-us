"use client";

import type { SourceHealth } from "@firepulse/protocol";
import { formatAgeShort } from "@/lib/format";

const STATUS_COLOR: Record<SourceHealth["status"], string> = {
  ok: "var(--forest)",
  pending: "var(--line-strong)",
  stale: "var(--warn)",
  error: "var(--danger)",
};

/** "2 of 7 feeds down", or null when every feed is healthy. */
export function feedProblem(sources: SourceHealth[] | undefined): string | null {
  if (!sources || sources.length === 0) return null;
  const down = sources.filter((s) => s.status === "error" || s.status === "stale").length;
  return down > 0 ? `${down} of ${sources.length} feeds down` : null;
}

function freshness(s: SourceHealth, now: number): string {
  if (s.status === "pending") return "waiting for first poll";
  const observed = s.lastObservedAt ? Date.parse(s.lastObservedAt) : NaN;
  if (Number.isFinite(observed)) {
    const noun = s.kind === "signals" ? "newest detection" : s.kind === "wind" ? "valid" : "updated";
    return `${noun} ${formatAgeShort(now - observed)} ago`;
  }
  const checked = s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : NaN;
  return Number.isFinite(checked) ? `checked ${formatAgeShort(now - checked)} ago` : "";
}

/** Each upstream feed with a status dot and how fresh its data is. */
export function SourceHealthList({ sources, now }: { sources: SourceHealth[]; now: number }) {
  return (
    <div style={{ display: "grid", gap: 7 }}>
      {sources.map((s) => (
        <div key={s.id} title={s.lastError ?? s.warnings?.join("; ")} style={{ display: "flex", gap: 8 }}>
          <span
            aria-hidden
            style={{
              width: 5,
              height: 5,
              marginTop: 5,
              borderRadius: "50%",
              background: STATUS_COLOR[s.status],
              flex: "none",
            }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "var(--ink-2)" }}>{s.label}</div>
            <div className="mono" style={{ fontSize: 10, color: "var(--faint)", marginTop: 1 }}>
              {s.status === "error" ? (
                <span style={{ color: "var(--danger)" }}>Failing · {s.lastError ?? "poll failed"}</span>
              ) : s.status === "stale" ? (
                <span style={{ color: "var(--warn)" }}>No update in a while · {freshness(s, now)}</span>
              ) : (
                freshness(s, now)
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
