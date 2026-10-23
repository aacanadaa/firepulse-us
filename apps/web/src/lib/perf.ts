"use client";

/**
 * Device budget for the map.
 *
 * A phone with four cores and 3 GB of RAM cannot afford the same frame budget
 * as a desktop: at devicePixelRatio 3 a full-screen deck.gl canvas is ~9x the
 * fill rate of a 1x one. Everything expensive is therefore derived from one
 * tier, decided once per session.
 */

export type PerfTier = "low" | "mid" | "high";

export interface PerfProfile {
  tier: PerfTier;
  /** Device pixel ratio handed to deck.gl and the wind canvas. */
  dpr: number;
  /** Animate the estimated-perimeter outline. */
  pulse: boolean;
  /** Bloom-free name for "is this device allowed nice MSAA". */
  antialias: boolean;
  /** Stroke every thermal detection (two draw calls instead of one). */
  hotspotStrokes: boolean;
  /** Draw the pale outline casing under estimated perimeters. */
  estimatedCasing: boolean;
  /** Draw the faint fill wash inside estimated perimeters. */
  estimatedFill: boolean;
  /** MapLibre tile cross-fade; 0 removes a per-tile animation on weak GPUs. */
  fadeDuration: number;
  /**
   * Cap for MapLibre's tile cache. Left undefined (= engine default) wherever
   * memory allows: a cap smaller than the tiles a 1080p window needs makes the
   * cache thrash, re-requesting evicted tiles forever.
   */
  maxTileCacheSize?: number;
  /** Frame-skip wind advection: 1 = every frame. */
  windFrameSkip: number;
  windParticles: number;
  /** How often clock-derived labels (ages, "x min ago") refresh. */
  clockMs: number;
  /** Distance between pointer samples on the map caption. */
  coordThrottleMs: number;
  reducedMotion: boolean;
}

interface NavigatorWithHints extends Navigator {
  deviceMemory?: number;
  connection?: { saveData?: boolean; effectiveType?: string };
}

function safeMatch(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

let cached: PerfProfile | null = null;

export function detectPerf(): PerfProfile {
  if (cached) return cached;

  const nav = (typeof navigator === "undefined" ? {} : navigator) as NavigatorWithHints;
  const cores = nav.hardwareConcurrency ?? 8;
  const memory = nav.deviceMemory ?? 8;
  const reducedMotion = safeMatch("(prefers-reduced-motion: reduce)");
  const coarse = safeMatch("(pointer: coarse)");
  const saveData = Boolean(nav.connection?.saveData);
  const slowNetwork = nav.connection?.effectiveType
    ? /(^|-)2g$/.test(nav.connection.effectiveType)
    : false;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  let tier: PerfTier;
  if (saveData || slowNetwork || cores <= 4 || memory <= 4 || reducedMotion) {
    tier = "low";
  } else if (coarse || cores <= 6 || memory <= 6 || dpr > 2.5) {
    // Phones and small tablets: fine to render, not fine to over-render.
    tier = "mid";
  } else {
    tier = "high";
  }

  const low = tier === "low";
  const high = tier === "high";

  cached = {
    tier,
    // The single biggest win on phones: a 3x canvas costs ~9x the fragments.
    dpr: low ? 1 : high ? Math.min(dpr, 2) : Math.min(dpr, 1.5),
    pulse: !low && !reducedMotion,
    antialias: high,
    hotspotStrokes: !low,
    estimatedCasing: !low,
    estimatedFill: !low,
    fadeDuration: low ? 0 : 100,
    // Only constrain genuinely small-memory devices; a wide desktop window can
    // legitimately hold >100 tiles at once.
    maxTileCacheSize: memory <= 4 ? 96 : low ? 192 : undefined,
    windFrameSkip: low ? 3 : high ? 1 : 2,
    windParticles: low ? 130 : high ? 900 : 380,
    clockMs: low ? 30_000 : 15_000,
    coordThrottleMs: low ? 400 : 180,
    reducedMotion,
  };
  return cached;
}

/** Test seam: lets `?perf=low` force a tier while developing on a fast machine. */
export function perfFromQuery(search: string): PerfProfile {
  const forced = /[?&]perf=(low|mid|high)\b/.exec(search)?.[1] as PerfTier | undefined;
  if (!forced) return detectPerf();
  const base = detectPerf();
  if (forced === base.tier) return base;
  const low = forced === "low";
  const high = forced === "high";
  return {
    ...base,
    tier: forced,
    dpr: low ? 1 : high ? 2 : 1.5,
    pulse: !low,
    antialias: high,
    hotspotStrokes: !low,
    estimatedCasing: !low,
    estimatedFill: !low,
    fadeDuration: low ? 0 : 100,
    windFrameSkip: low ? 3 : high ? 1 : 2,
    windParticles: low ? 130 : high ? 900 : 380,
  };
}
