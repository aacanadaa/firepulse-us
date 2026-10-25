"use client";

import { useCallback, useRef } from "react";
import type { TimelineBucket, TimelineEvent } from "@/lib/store";
import { formatAge, formatClock } from "@/lib/format";
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
}: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const live = cursor == null;
  const effective = live ? now : cursor;
  const fraction = live
    ? 1
    : Math.max(0, Math.min(1, (effective - from) / Math.max(1, to - from)));
  const max = Math.max(1, ...buckets.map((b) => b.hotspots));
  const offset = Math.max(0, now - effective);

  const seek = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      if (f > 0.997) {
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
    seek(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging.current) seek(e.clientX);
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
    <div className="timeline" role="group" aria-label="Timeline and replay">
      <div className="tl-controls">
        <button
          type="button"
          className={`play-btn ${playing ? "" : "paused"}`}
          onClick={onPlay}
          title={playing ? "Pause replay" : "Replay the last 24 hours"}
          aria-label={playing ? "Pause replay" : "Play replay"}
        >
          <Icon name={playing ? "pause" : "play"} size={12} strokeWidth={1.8} />
        </button>

        <div className="tl-time">
          <span className="t">
            {formatClock(effective)}
            <span className="mono" style={{ fontSize: 10, color: "var(--faint)", marginLeft: 5 }}>
              PT
            </span>
          </span>
          <span className="d">
            {live ? "Live · trailing 24 hours" : `−${formatAge(offset)} from live`}
          </span>
        </div>
      </div>

      <div
        ref={trackRef}
        className="scrub"
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
          {buckets.map((b) => {
            const t = Date.parse(b.t);
            const height =
              b.hotspots === 0
                ? 2
                : 2 + (Math.log1p(b.hotspots) / Math.log1p(max)) * 20;
            const past = t <= effective;
            const hot = b.hotspots > max * 0.55;
            return (
              <div
                key={b.t}
                className={`scrub-bar ${past ? "past" : ""} ${hot ? "hot" : ""}`}
                style={{ height: `${height}px` }}
                title={`${formatClock(t)} · ${b.hotspots} hotspots · ${Math.round(b.frp)} MW`}
              />
            );
          })}
        </div>

        <div className="scrub-base" />

        {events.map((ev) => {
          const t = Date.parse(ev.officialSince);
          if (t < from || t > to) return null;
          const left = ((t - from) / Math.max(1, to - from)) * 100;
          return (
            <div
              key={ev.id + ev.officialSince}
              className="event-tick"
              style={{ left: `${left}%` }}
              title={`${ev.name} officially mapped at ${formatClock(t)}`}
            />
          );
        })}

        <div className="scrub-head" style={{ left: `${fraction * 100}%` }} />
      </div>

      <div className="tl-right">
        {SPEEDS.map((s) => (
          <button
            key={s.value}
            type="button"
            className={`speed ${speed === s.value ? "active" : ""}`}
            onClick={() => onSpeed(s.value)}
            title={`Advance ${s.label.replace("/s", " minutes")} per real second`}
            aria-pressed={speed === s.value}
          >
            {s.label}
          </button>
        ))}
        <button
          type="button"
          className={`live-btn ${live ? "on" : ""}`}
          onClick={onLive}
          title="Return to the live feed"
        >
          <span className="dot" />
          Live
        </button>
      </div>
    </div>
  );
}
