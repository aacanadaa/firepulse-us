"use client";

import { useEffect, useRef } from "react";
import type maplibregl from "maplibre-gl";
import type { WindField } from "@firepulse/protocol";
import type { MapTheme } from "@/lib/places";
import type { PerfProfile } from "@/lib/perf";

interface Props {
  map: maplibregl.Map | null;
  field: WindField | null;
  enabled: boolean;
  theme: MapTheme;
  profile: PerfProfile;
}

function sampleField(
  field: WindField,
  lon: number,
  lat: number,
): { u: number; v: number; speed: number } | null {
  const [w, s, e, n] = field.bbox;
  if (lon < w || lon > e || lat < s || lat > n) return null;
  const fx = ((lon - w) / (e - w)) * (field.cols - 1);
  const fy = ((n - lat) / (n - s)) * (field.rows - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(field.cols - 1, x0 + 1);
  const y1 = Math.min(field.rows - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (arr: number[], x: number, y: number) => arr[y * field.cols + x] ?? 0;
  const u =
    at(field.u, x0, y0) * (1 - tx) * (1 - ty) +
    at(field.u, x1, y0) * tx * (1 - ty) +
    at(field.u, x0, y1) * (1 - tx) * ty +
    at(field.u, x1, y1) * tx * ty;
  const v =
    at(field.v, x0, y0) * (1 - tx) * (1 - ty) +
    at(field.v, x1, y0) * tx * (1 - ty) +
    at(field.v, x0, y1) * (1 - tx) * ty +
    at(field.v, x1, y1) * tx * ty;
  return { u, v, speed: Math.hypot(u, v) };
}

/**
 * Monochrome wind texture. Particles exist to show direction and relative
 * velocity — not to become a second colour system. Short graphite strokes,
 * alpha by speed, no glow.
 */
export default function WindParticles({ map, field, enabled, theme, profile }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const fieldRef = useRef(field);
  fieldRef.current = field;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    // The wind layer is a full-screen compositing canvas; at DPR 3 it costs as
    // much as the rest of the map together on a phone.
    let dpr = Math.min(2, profile.dpr || 1);
    let running = true;

    const resize = () => {
      const el = map.getContainer();
      dpr = Math.min(2, profile.dpr || 1);
      canvas.width = Math.max(1, Math.floor(el.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(el.clientHeight * dpr));
      canvas.style.width = `${el.clientWidth}px`;
      canvas.style.height = `${el.clientHeight}px`;
    };
    resize();
    map.on("resize", resize);

    const maxParticles = () => {
      const area = canvas.width * canvas.height;
      const ceiling = profile.windParticles;
      return Math.max(60, Math.min(ceiling, Math.round(area / 6800)));
    };

    let count = maxParticles();
    let lon = new Float32Array(count);
    let lat = new Float32Array(count);
    let px = new Float32Array(count);
    let py = new Float32Array(count);
    let age = new Uint16Array(count);
    let life = new Uint16Array(count);
    let ready = new Uint8Array(count);

    const respawn = (i: number) => {
      const f = fieldRef.current;
      const b = map.getBounds();
      const w = Math.max(f?.bbox[0] ?? b.getWest(), b.getWest());
      const e = Math.min(f?.bbox[2] ?? b.getEast(), b.getEast());
      const s = Math.max(f?.bbox[1] ?? b.getSouth(), b.getSouth());
      const n = Math.min(f?.bbox[3] ?? b.getNorth(), b.getNorth());
      lon[i] = w + Math.random() * Math.max(0.0001, e - w);
      lat[i] = s + Math.random() * Math.max(0.0001, n - s);
      age[i] = 0;
      life[i] = 80 + Math.floor(Math.random() * 200);
      ready[i] = 0;
    };

    for (let i = 0; i < count; i++) {
      respawn(i);
      age[i] = Math.floor(Math.random() * life[i]!);
    }

    let last = performance.now();
    let frame = 0;
    let carry = 0;

    const tick = (now: number) => {
      if (!running) return;
      frameRef.current = requestAnimationFrame(tick);
      if (!enabled || !fieldRef.current) return;
      // Nothing to animate behind a background tab.
      if (document.hidden) {
        last = now;
        return;
      }

      carry += Math.min(64, now - last);
      last = now;
      frame++;

      // Advection reads better at a steady rate than at whatever the GPU can
      // manage: on weak hardware, draw every Nth frame with the accumulated dt.
      if (profile.windFrameSkip > 1 && frame % profile.windFrameSkip !== 0) return;
      const dt = Math.min(96, carry);
      carry = 0;

      const target = maxParticles();
      if (Math.abs(target - count) > count * 0.35) {
        count = target;
        lon = new Float32Array(count);
        lat = new Float32Array(count);
        px = new Float32Array(count);
        py = new Float32Array(count);
        age = new Uint16Array(count);
        life = new Uint16Array(count);
        ready = new Uint8Array(count);
        for (let i = 0; i < count; i++) respawn(i);
      }

      const f = fieldRef.current;
      const width = canvas.width;
      const height = canvas.height;

      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.19)";
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = Math.max(0.7, 0.7 * dpr);
      ctx.lineCap = "round";

      const zoomScale = Math.min(1.4, Math.pow(1.85, 5.2 - map.getZoom()));
      const step = (dt / 1000) * 0.06 * zoomScale;
      const t = themeRef.current;

      for (let i = 0; i < count; i++) {
        const sample = sampleField(f, lon[i]!, lat[i]!);
        if (!sample || age[i]! > life[i]!) {
          respawn(i);
          continue;
        }

        const cosLat = Math.max(0.25, Math.cos((lat[i]! * Math.PI) / 180));
        const prevLon = lon[i]!;
        const prevLat = lat[i]!;
        lon[i] = prevLon + (sample.u * step) / cosLat;
        lat[i] = prevLat + sample.v * step;
        age[i] = age[i]! + 1;

        const p0 = map.project([prevLon, prevLat]);
        const p1 = map.project([lon[i]!, lat[i]!]);
        const x1 = p1.x * dpr;
        const y1 = p1.y * dpr;
        const margin = 40;
        if (x1 < -margin || x1 > width + margin || y1 < -margin || y1 > height + margin) {
          respawn(i);
          continue;
        }
        if (!ready[i]) {
          px[i] = x1;
          py[i] = y1;
          ready[i] = 1;
          continue;
        }

        const relative = Math.min(1, sample.speed / Math.max(4, f.speedMax));
        const fadeIn = Math.min(1, age[i]! / 16);
        const fadeOut = Math.min(1, (life[i]! - age[i]!) / 40);
        ctx.globalAlpha = Math.max(
          0,
          Math.min(0.5, (0.1 + relative * 0.3) * fadeIn * fadeOut * t.windOpacity),
        );
        ctx.strokeStyle = t.wind;
        ctx.beginPath();
        ctx.moveTo(px[i]!, py[i]!);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        px[i] = x1;
        py[i] = y1;
      }
      ctx.globalAlpha = 1;

      if (frame % 90 === 0) {
        const b = map.getBounds();
        for (let i = 0; i < count; i += 7) {
          if (
            lon[i]! < b.getWest() - 2 ||
            lon[i]! > b.getEast() + 2 ||
            lat[i]! < b.getSouth() - 2 ||
            lat[i]! > b.getNorth() + 2
          ) {
            respawn(i);
          }
        }
      }
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => {
      running = false;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      map.off("resize", resize);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [map, enabled, profile]);

  useEffect(() => {
    if (!enabled) {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [enabled]);

  return <canvas id="wind-canvas" ref={canvasRef} aria-hidden />;
}
