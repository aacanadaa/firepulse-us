"use client";

import { useCallback, useRef } from "react";
import type { TimelineBucket, TimelineEvent } from "@/lib/store";
import { formatAge, formatClock, formatClockShort } from "@/lib/format";
import { Icon } from "./ui";

interface Props {
  from: number;
  to: number;
  cursor: number | null;
  now: number;
  playing: boolean;
  speed: number;
  buckets: TimelineBucket[];
  events: TimelineEvent[];
  onSeek: (t: number | null) => void;
  onPlay: () => void;
  onSpeed: (speed: number) => void;
  onLive: () => void;
  hasSelection: boolean;
  sidebarOpen: boolean;
}

const SPEEDS = [
  { value: 60, label: "1m/s" },
  { value: 240, label: "4m/s" },
  { value: 720, label: "12m/s" },
  { value: 2880, label: "48m/s" },
];

export default function Timeline({
  from,
  to,
  cursor,
  now,
  playing,
  speed,
  buckets,
  events,
  onSeek,
  onPlay,
  onSpeed,
  onLive,
  hasSelection,
  sidebarOpen,
}: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const effective = cursor ?? now;
  const live = cursor == null;
  const fraction = live
    ? 1
    : Math.max(0, Math.min(1, (effective - from) / Math.max(1, to - from)));
  const max = Math.max(1, ...buckets.map((b) => b.hotspots));
  const offset = Math.max(0, now - effective);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      if (f > 0.995) {
        onSeek(null);
        return;
      }
      onSeek(from + f * (to - from));
    },
    [from, to, onSeek],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromEvent(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    seekFromEvent(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  return (
    <div
      className={`glass timeline ${sidebarOpen ? "" : "mobile-visible"}`}
      style={{
        position: "absolute",
        left: sidebarOpen ? 408 : 16,
        right: 16,
        bottom: 16,
        zIndex: 25,
        borderRadius: 14,
        padding: "10px 14px 8px",
        transition: "left 0.28s cubic-bezier(0.2,0.9,0.25,1)",
        pointerEvents: "auto",
      }}
      role="group"
      aria-label="Timeline and replay"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          onClick={onPlay}
          className="icon-btn"
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            color: playing ? "#0a0d12" : "#e8edf5",
            background: playing ? "#ffb020" : "rgba(255,255,255,0.05)",
            borderColor: playing ? "#ffb020" : "var(--hairline)",
          }}
          title={playing ? "Pause replay" : "Replay the last 24 hours"}
          aria-label={playing ? "Pause replay" : "Play replay"}
        >
          <Icon name={playing ? "pause" : "play"} size={13} />
        </button>

        <div style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="mono" style={{ fontSize: 13, fontWeight: 700 }}>
            {formatClock(effective)}
          </span>
          <span className="mono" style={{ fontSize: 9.5, color: "#7d8797" }}>
            PT
          </span>
          {!live ? (
            <span
              className="mono"
              style={{
                fontSize: 9.5,
                color: "#9ad9f8",
                padding: "1px 5px",
                borderRadius: 4,
                background: "rgba(56,189,248,0.09)",
                border: "1px solid rgba(56,189,248,0.18)",
              }}
            >
              −{formatAge(offset)} from live
            </span>
          ) : (
            <span
              className="mono"
              style={{
                fontSize: 9,
                color: live ? "#8af0b4" : "#9ad9f8",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span className="live-dot" style={{ width: 5, height: 5 }} />
              LIVE
            </span>
          )}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
          {SPEEDS.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`chip ${speed === s.value ? "active" : ""}`}
              style={{ fontSize: 9, padding: "2px 6px" }}
              onClick={() => onSpeed(s.value)}
              title={`Replay ${s.label} of simulated time per second`}
            >
              {s.label}
            </button>
          ))}
          <button
            type="button"
            className={`chip ${live ? "active" : ""}`}
            style={{ fontSize: 9, padding: "2px 7px", marginLeft: 4 }}
            onClick={onLive}
            title="Return to the live feed"
          >
            LIVE
          </button>
        </div>
      </div>

      <div
        ref={trackRef}
        className="scrub-track"
        style={{ marginTop: 6 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="slider"
        aria-label="Time scrubber"
        aria-valuemin={from}
        aria-valuemax={to}
        aria-valuenow={effective}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") onSeek(Math.max(from, effective - 5 * 60_000));
          if (e.key === "ArrowRight") onSeek(Math.min(now, effective + 5 * 60_000));
        }}
      >
        <div className="scrub-bars">
          {buckets.map((b, i) => {
            const t = Date.parse(b.t);
            const height =
              b.hotspots === 0
                ? 2
                : 3 + (Math.log1p(b.hotspots) / Math.log1p(max)) * 28;
            return (
              <div
                key={b.t}
                className={`scrub-bar ${t > effective ? "cool" : b.hotspots > max * 0.4 ? "hot" : ""}`}
                style={{ height: `${height}px` }}
                title={`${formatClockShort(t)} · ${b.hotspots} hotspots · ${Math.round(b.frp)} MW`}
                data-index={i}
              />
            );
          })}
        </div>

        {events
          .map((ev) => {
            const t = Date.parse(ev.officialSince);
            if (t < from || t > to) return null;
            const left = ((t - from) / Math.max(1, to - from)) * 100;
            return (
              <div
                key={ev.id + ev.officialSince}
                className="official-tick"
                style={{ left: `${left}%` }}
                title={`${ev.name} mapped officially at ${formatClockShort(t)}`}
              />
            );
          })
          .filter(Boolean)}

        {!live ? <div className="scrub-head" style={{ left: `${fraction * 100}%` }} /> : null}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 8.5,
          color: "#5d6675",
          marginTop: 2,
        }}
      >
        <span className="mono">24H AGO</span>
        <span className="mono" style={{ color: "#7d8797" }}>
          {formatClockShort(from)} — {formatClockShort(to)} PT · hotspots coloured by age at cursor
        </span>
        <span className="mono">NOW</span>
      </div>

      {hasSelection ? (
        <div
          style={{
            position: "absolute",
            right: 14,
            top: -22,
            fontSize: 8.5,
            color: "#8d96a5",
          }}
        />
      ) : null}
    </div>
  );
}
