"use client";

import type { GeocodeResult, NearbySummary } from "@firepulse/protocol";
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "./store";

/** A place someone watches: home, work, a parent's house. */
export interface WatchedPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusKm: number;
}

export const RADIUS_CHOICES = [10, 25, 50] as const;
export const DEFAULT_RADIUS_KM = 25;
const MAX_PLACES = 5;
const STORAGE_KEY = "firepulse.places";
const NEARBY_REFRESH_MS = 60_000;

function load(): WatchedPlace[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as WatchedPlace[]) : [];
    return Array.isArray(parsed)
      ? parsed.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && typeof p.name === "string")
      : [];
  } catch {
    return [];
  }
}

function save(places: WatchedPlace[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(places));
  } catch {
    /* private mode or storage full: places last for this visit only */
  }
}

/**
 * Places kept in this browser. Accounts (later) will sync them; until then
 * they never leave the device except as coordinates in nearby queries.
 */
export function usePlaces() {
  const [places, setPlaces] = useState<WatchedPlace[]>(() => (typeof window === "undefined" ? [] : load()));

  const update = useCallback((next: (prev: WatchedPlace[]) => WatchedPlace[]) => {
    setPlaces((prev) => {
      const value = next(prev).slice(0, MAX_PLACES);
      save(value);
      return value;
    });
  }, []);

  const add = useCallback(
    (place: Omit<WatchedPlace, "id" | "radiusKm"> & { radiusKm?: number }): WatchedPlace => {
      const created: WatchedPlace = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        radiusKm: DEFAULT_RADIUS_KM,
        ...place,
        lat: Math.round(place.lat * 1e5) / 1e5,
        lon: Math.round(place.lon * 1e5) / 1e5,
      };
      update((prev) => [created, ...prev.filter((p) => p.name !== created.name)]);
      return created;
    },
    [update],
  );

  const remove = useCallback((id: string) => update((prev) => prev.filter((p) => p.id !== id)), [update]);
  const setRadius = useCallback(
    (id: string, radiusKm: number) => update((prev) => prev.map((p) => (p.id === id ? { ...p, radiusKm } : p))),
    [update],
  );

  return { places, add, remove, setRadius, full: places.length >= MAX_PLACES };
}

/** Nearby summaries for every watched place, refreshed every minute. */
export function useNearby(places: WatchedPlace[]): Record<string, NearbySummary | undefined> {
  const [byPlace, setByPlace] = useState<Record<string, NearbySummary | undefined>>({});
  const key = places.map((p) => `${p.id}:${p.lat},${p.lon},${p.radiusKm}`).join("|");

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const entries = await Promise.all(
        places.map(async (p) => {
          try {
            const q = new URLSearchParams({ lat: String(p.lat), lon: String(p.lon), radiusKm: String(p.radiusKm) });
            return [p.id, await apiGet<NearbySummary>(`/api/v1/nearby?${q}`, controller.signal)] as const;
          } catch {
            return [p.id, undefined] as const;
          }
        }),
      );
      if (controller.signal.aborted) return;
      setByPlace((prev) => {
        const next: Record<string, NearbySummary | undefined> = {};
        // Keep the last good summary through a failed refresh.
        for (const [id, summary] of entries) next[id] = summary ?? prev[id];
        return next;
      });
    };
    void load();
    const timer = window.setInterval(load, NEARBY_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return byPlace;
}

/** Debounced place search through the API's geocoder. */
export function usePlaceSearch(query: string): { results: GeocodeResult[]; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ results: GeocodeResult[]; loading: boolean; error: string | null }>({
    results: [],
    loading: false,
    error: null,
  });

  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setState({ results: [], loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    const timer = window.setTimeout(async () => {
      try {
        const body = await apiGet<{ results: GeocodeResult[] }>(
          `/api/v1/geocode?q=${encodeURIComponent(q)}`,
          controller.signal,
        );
        setState({ results: body.results, loading: false, error: null });
      } catch {
        if (!controller.signal.aborted) {
          setState({ results: [], loading: false, error: "Search isn't available right now." });
        }
      }
    }, 350);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  return state;
}
