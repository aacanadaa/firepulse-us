"use client";

import type { AccountPlace, AccountSettings, AlertItem, AuthState } from "@firepulse/protocol";
import { useCallback, useEffect, useState } from "react";

/**
 * Account calls go to the web app's own origin; next.config rewrites them to
 * the API, so the session cookie is first-party.
 */
export async function accountFetch<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal: init.signal,
    headers: init.method && init.method !== "GET" ? { "content-type": "application/json" } : undefined,
    body: init.method && init.method !== "GET" ? JSON.stringify(init.body ?? {}) : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export function googleSignInUrl(returnPath = "/", link = false): string {
  const q = new URLSearchParams({ return: returnPath });
  if (link) q.set("link", "1");
  return `/api/v1/auth/google/start?${q}`;
}

export interface Account {
  state: AuthState | null;
  loading: boolean;
  /** The API isn't reachable or accounts are off. */
  unavailable: boolean;
  refresh: () => Promise<void>;
  signup: (username: string, password: string) => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  saveSettings: (s: Partial<AccountSettings>) => Promise<void>;
}

export function useAccount(): Account {
  const [state, setState] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await accountFetch<AuthState>("/api/v1/auth/me"));
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signup = useCallback(
    async (username: string, password: string) => {
      await accountFetch("/api/v1/auth/signup", { method: "POST", body: { username, password } });
      await refresh();
    },
    [refresh],
  );

  const login = useCallback(
    async (username: string, password: string) => {
      await accountFetch("/api/v1/auth/login", { method: "POST", body: { username, password } });
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await accountFetch("/api/v1/auth/logout", { method: "POST" });
    await refresh();
  }, [refresh]);

  const saveSettings = useCallback(
    async (s: Partial<AccountSettings>) => {
      await accountFetch("/api/v1/me/settings", { method: "PUT", body: s });
      await refresh();
    },
    [refresh],
  );

  return { state, loading, unavailable, refresh, signup, login, logout, saveSettings };
}

/* ------------------------------------------------------------------ */
/* Push notifications on this device                                    */
/* ------------------------------------------------------------------ */

function keyBytes(base64url: string): Uint8Array {
  const padded = (base64url + "===".slice((base64url.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function isIos(): boolean {
  return typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export interface PushState {
  /** This browser can receive push at all. */
  supported: boolean;
  /** iOS only allows push from an app added to the home screen. */
  needsInstall: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  busy: boolean;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  test: () => Promise<string>;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

export function usePush(publicKey: string | null, signedIn: boolean): PushState {
  const supported =
    typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const needsInstall = typeof window !== "undefined" && isIos() && !isStandalone();
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    supported ? Notification.permission : "unsupported",
  );
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    void (async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setSubscribed(Boolean(sub));
      // Re-register a subscription the browser kept but the server lost.
      if (sub && signedIn) {
        await accountFetch("/api/v1/push/subscribe", { method: "POST", body: sub.toJSON() }).catch(() => undefined);
      }
    })();
  }, [supported, signedIn]);

  const enable = useCallback(async () => {
    setError(null);
    if (!supported || !publicKey) {
      setError("This browser can't receive alerts.");
      return;
    }
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        setError("Notifications are blocked. Allow them for this site in your browser settings.");
        return;
      }
      const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource }));
      await accountFetch("/api/v1/push/subscribe", { method: "POST", body: sub.toJSON() });
      setSubscribed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't turn on alerts.");
    } finally {
      setBusy(false);
    }
  }, [supported, publicKey]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await accountFetch("/api/v1/push/subscribe", { method: "DELETE", body: { endpoint: sub.endpoint } }).catch(() => undefined);
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } finally {
      setBusy(false);
    }
  }, []);

  const test = useCallback(async () => {
    const r = await accountFetch<{ sent: number; devices: number }>("/api/v1/push/test", { method: "POST" });
    return r.sent > 0 ? `Sent to ${r.sent} ${r.sent === 1 ? "device" : "devices"}.` : "No device received it. Turn alerts off and on again.";
  }, []);

  return { supported, needsInstall, permission, subscribed, busy, error, enable, disable, test };
}

/* ------------------------------------------------------------------ */
/* Alert history                                                        */
/* ------------------------------------------------------------------ */

export function useAlertHistory(signedIn: boolean, open: boolean): AlertItem[] {
  const [items, setItems] = useState<AlertItem[]>([]);
  useEffect(() => {
    if (!signedIn || !open) return;
    const controller = new AbortController();
    accountFetch<AlertItem[]>("/api/v1/me/alerts", { signal: controller.signal })
      .then(setItems)
      .catch(() => undefined);
    return () => controller.abort();
  }, [signedIn, open]);
  return items;
}

export type { AccountPlace };
