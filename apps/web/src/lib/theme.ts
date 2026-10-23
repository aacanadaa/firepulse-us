"use client";

import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type Theme = "light" | "dark";

export const THEME_KEY = "firepulse.theme";
export const THEME_ATTR = "data-theme";

const LIGHT_CANVAS = "#f7f7f5";
const DARK_CANVAS = "#0c0c0c";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

/** Runs before paint in the document head so dark mode never flashes white. */
export const THEME_BOOT_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search).get("theme");var m=q==="light"||q==="dark"?q:localStorage.getItem(${JSON.stringify(
  THEME_KEY,
)});if(m!=="dark"&&m!=="light")m="system";var d=m==="dark"||(m==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement;e.setAttribute(${JSON.stringify(
  THEME_ATTR,
)},d?"dark":"light");e.style.colorScheme=d?"dark":"light";}catch(_){}})();`;

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function resolveTheme(mode: ThemeMode): Theme {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

/** `?theme=dark` wins over the stored choice, for embeds and screenshots. */
export function urlThemeMode(): ThemeMode | null {
  if (typeof window === "undefined") return null;
  try {
    const q = new URLSearchParams(window.location.search).get("theme");
    return q === "light" || q === "dark" ? q : null;
  } catch {
    return null;
  }
}

export function readThemeMode(): ThemeMode {
  const fromUrl = urlThemeMode();
  if (fromUrl) return fromUrl;
  if (typeof window === "undefined") return "system";
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return isThemeMode(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme, mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute(THEME_ATTR, theme);
  root.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? DARK_CANVAS : LIGHT_CANVAS);
  meta?.setAttribute("data-mode", mode);
}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
}

/**
 * Light / dark / follow-the-OS. Persisted, and kept in sync with the system
 * preference while the choice is "system".
 */
export function useTheme(): {
  mode: ThemeMode;
  theme: Theme;
  setMode: (mode: ThemeMode) => void;
  cycle: () => void;
} {
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [theme, setTheme] = useState<Theme>("light");

  // The boot script already painted the right theme; adopt it on mount.
  useEffect(() => {
    const stored = readThemeMode();
    const resolved = resolveTheme(stored);
    setModeState(stored);
    setTheme(resolved);
    applyTheme(resolved, stored);
  }, []);

  useEffect(() => {
    if (mode !== "system" || typeof window.matchMedia !== "function") return;
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const onChange = () => {
      const resolved: Theme = mql.matches ? "dark" : "light";
      setTheme(resolved);
      applyTheme(resolved, "system");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* session-only */
    }
    const resolved = resolveTheme(next);
    setTheme(resolved);
    applyTheme(resolved, next);
  }, []);

  const cycle = useCallback(() => {
    setModeState((prev) => {
      const next = nextThemeMode(prev);
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {
        /* session-only */
      }
      const resolved = resolveTheme(next);
      setTheme(resolved);
      applyTheme(resolved, next);
      return next;
    });
  }, []);

  return { mode, theme, setMode, cycle };
}
