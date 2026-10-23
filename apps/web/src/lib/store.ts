"use client";

import type {
  FeedStats,
  HazardAlertFeature,
  HotspotFeature,
  IncidentFeature,
  PublicConfig,
  ServerMessage,
  SpreadForecast,
  WindField,
} from "@firepulse/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_API_PORT = "8790";

export function apiBase(): string {
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env) return env.replace(/\/$/, "");
  if (typeof window === "undefined") return `http://127.0.0.1:${DEFAULT_API_PORT}`;
  const host = window.location.hostname || "127.0.0.1";
  return `${window.location.protocol}//${host}:${DEFAULT_API_PORT}`;
}

export function wsUrl(): string {
  return `${apiBase().replace(/^http/, "ws")}/ws`;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface TimelineBucket {
  t: string;
  hotspots: number;
  frp: number;
}

export interface TimelineEvent {
  id: string;
  name: string;
  officialSince: string;
  firstDetectedAt: string;
  areaAcres: number;
}

export interface TimelineResponse {
  from: string;
  to: string;
  buckets: TimelineBucket[];
  events: TimelineEvent[];
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/**
 * Client-side mirror of the server's live state.
 *
 * Snapshots replace the viewport; deltas patch it. Everything downstream
 * (sidebar, map, timeline) reads these Maps, so a WebSocket frame that
 * changes one incident touches exactly one entry — never the whole dataset.
 */
export class LiveStore {
  incidents = new Map<string, IncidentFeature>();
  hotspots = new Map<string, HotspotFeature>();
  /** Active NWS alerts (evacuations, fire warnings, red flags, smoke). */
  hazards = new Map<string, HazardAlertFeature>();
  wind: WindField | null = null;
  config: PublicConfig | null = null;
  stats: FeedStats | null = null;
  serverSkewMs = 0;
  seq = 0;
  version = 0;
  lastMessageAt = 0;
  /** seq of the last applied hotspot frame, for debugging/diagnostics */
  hotspotSeq = 0;

  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private bump(): void {
    this.version++;
    this.lastMessageAt = Date.now();
    for (const fn of this.listeners) fn();
  }

  /** Server-corrected wall clock. */
  now(): number {
    return Date.now() + this.serverSkewMs;
  }

  apply(msg: ServerMessage): void {
    if (msg.type !== "pong") this.seq = Math.max(this.seq, msg.seq);
    if (msg.type === "hello") {
      this.config = msg.config;
      this.stats = msg.stats;
      this.serverSkewMs = Date.parse(msg.serverTime) - Date.now();
      this.bump();
      return;
    }

    if (msg.type === "snapshot") {
      this.serverSkewMs = Date.parse(msg.serverTime) - Date.now();
      for (const f of msg.incidents) this.incidents.set(f.id, f);
      for (const f of msg.hotspots) this.hotspots.set(f.id, f);
      if (msg.hazards) for (const a of msg.hazards) this.hazards.set(a.id, a);
      if (msg.wind) this.wind = msg.wind;
      this.stats = msg.stats;
      this.hotspotSeq = this.stats.hotspots;
      this.prune(this.now());
      this.bump();
      return;
    }

    if (msg.type === "delta") {
      this.serverSkewMs = Date.parse(msg.serverTime) - Date.now();
      for (const f of msg.incidentsUpsert) this.incidents.set(f.id, f);
      for (const id of msg.incidentsRemove) this.incidents.delete(id);
      for (const f of msg.hotspotsUpsert) this.hotspots.set(f.id, f);
      for (const id of msg.hotspotsRemove) this.hotspots.delete(id);
      for (const a of msg.hazardsUpsert ?? []) this.hazards.set(a.id, a);
      for (const id of msg.hazardsRemove ?? []) this.hazards.delete(id);
      if (msg.wind) this.wind = msg.wind;
      this.stats = msg.stats;
      if (this.hotspots.size > 40_000) this.prune(this.now());
      this.bump();
      return;
    }

    if (msg.type === "stats") {
      this.stats = msg.stats;
      this.serverSkewMs = Date.parse(msg.serverTime) - Date.now();
      this.bump();
    }
  }

  prune(now: number, retentionMs = 26 * 3_600_000): void {
    if (this.hotspots.size < 8000) return;
    const cutoff = now - retentionMs;
    for (const [id, h] of this.hotspots) {
      if (Date.parse(h.properties.observedAt) < cutoff) this.hotspots.delete(id);
    }
  }

  counts(): { hotspots: number; estimated: number; official: number } {
    let estimated = 0;
    let official = 0;
    for (const f of this.incidents.values()) {
      if (f.properties.kind === "official") official++;
      else estimated++;
    }
    return { hotspots: this.hotspots.size, estimated, official };
  }
}

/* ------------------------------------------------------------------ */
/* WebSocket hook                                                      */
/* ------------------------------------------------------------------ */

export type FeedStatus = "connecting" | "live" | "reconnecting" | "offline";

export interface LiveFeed {
  store: LiveStore;
  status: FeedStatus;
  latencyMs: number;
  lastUpdate: number;
  send: (msg: unknown) => void;
  subscribeViewport: (bbox: [number, number, number, number], zoom: number) => void;
  attempts: number;
}

export function useLiveFeed(): LiveFeed {
  const storeRef = useRef<LiveStore | null>(null);
  if (!storeRef.current) storeRef.current = new LiveStore();
  const store = storeRef.current;

  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [latencyMs, setLatency] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [lastUpdate, setLastUpdate] = useState(0);
  const retryRef = useRef(0);
  const closedRef = useRef(false);
  const pingRef = useRef<number | null>(null);
  const pendingViewport = useRef<{ bbox: [number, number, number, number]; zoom: number } | null>(null);

  const connect = useCallback(() => {
    if (closedRef.current) return;
    const url = wsUrl();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      setStatus("offline");
      return;
    }
    socketRef.current = ws;
    setStatus((s) => (s === "live" ? s : retryRef.current === 0 ? "connecting" : "reconnecting"));

    ws.onopen = () => {
      retryRef.current = 0;
      setAttempts(0);
      setStatus("live");
      // Ask for the current viewport immediately; MapCanvas refines it.
      const vp = pendingViewport.current ?? { bbox: [-126, 22, -65, 51], zoom: 4 };
      ws.send(JSON.stringify({ type: "subscribe", bbox: vp.bbox, zoom: vp.zoom }));

      ws.send(JSON.stringify({ type: "ping", t: performance.now() }));

      if (pingRef.current) window.clearInterval(pingRef.current);
      pingRef.current = window.setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "ping", t: performance.now() }));
        }
      }, 20_000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        if (msg.type === "pong") {
          setLatency(Math.round(performance.now() - msg.t));
          return;
        }
        store.apply(msg);
        setLastUpdate(Date.now());
      } catch {
        /* ignore malformed frame */
      }
    };

    ws.onclose = () => {
      if (pingRef.current) window.clearInterval(pingRef.current);
      if (closedRef.current) return;
      setStatus((s) => (s === "live" ? "reconnecting" : s === "connecting" ? "connecting" : "offline"));
      retryRef.current += 1;
      setAttempts(retryRef.current);
      const delay = Math.min(15_000, 700 * 2 ** Math.min(retryRef.current, 4)) + Math.random() * 400;
      window.setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [store]);

  useEffect(() => {
    closedRef.current = false;
    connect();
    return () => {
      closedRef.current = true;
      if (pingRef.current) window.clearInterval(pingRef.current);
      socketRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: unknown) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const subscribeViewport = useCallback(
    (bbox: [number, number, number, number], zoom: number) => {
      pendingViewport.current = { bbox, zoom };
      send({ type: "viewport", bbox, zoom });
    },
    [send],
  );

  return { store, status, latencyMs, lastUpdate, send, subscribeViewport, attempts };
}

/* ------------------------------------------------------------------ */
/* Spread forecast hook                                                */
/* ------------------------------------------------------------------ */

const SPREAD_POLL_MS = 3_000;
const SPREAD_MAX_WAIT_MS = 60_000;

export interface SpreadState {
  forecast: SpreadForecast | null;
  loading: boolean;
}

/**
 * Next-day spread forecast for the selected incident. The API answers 202
 * while it works; poll every 3 s for up to 60 s, and abort the moment the
 * selection changes so a slow forecast never lands on the wrong fire.
 */
export function useSpread(selectedId: string | null): SpreadState {
  const [state, setState] = useState<SpreadState>({ forecast: null, loading: false });

  useEffect(() => {
    if (!selectedId) {
      setState({ forecast: null, loading: false });
      return;
    }
    const controller = new AbortController();
    const started = Date.now();
    let timer: number | undefined;
    setState({ forecast: null, loading: true });

    const load = async () => {
      try {
        const res = await fetch(`${apiBase()}/api/v1/incidents/${encodeURIComponent(selectedId)}/spread`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (controller.signal.aborted) return;
        if (res.status === 404) {
          setState({
            forecast: { incidentId: selectedId, status: "unavailable", reason: "This fire is no longer tracked." },
            loading: false,
          });
          return;
        }
        if (!res.ok && res.status !== 202) throw new Error(String(res.status));
        const body = (await res.json()) as SpreadForecast;
        if (controller.signal.aborted) return;
        if (body.status === "computing") {
          if (Date.now() - started >= SPREAD_MAX_WAIT_MS) {
            setState({
              forecast: { incidentId: selectedId, status: "unavailable", reason: "The prediction is taking too long. Try again in a minute." },
              loading: false,
            });
            return;
          }
          setState({ forecast: body, loading: true });
          timer = window.setTimeout(load, SPREAD_POLL_MS);
          return;
        }
        setState({ forecast: body, loading: false });
      } catch {
        if (controller.signal.aborted) return;
        setState({
          forecast: { incidentId: selectedId, status: "unavailable", reason: "Couldn't reach the prediction service." },
          loading: false,
        });
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [selectedId]);

  return state;
}
