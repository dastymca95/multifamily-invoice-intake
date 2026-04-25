"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  DEFAULT_THEME,
  isThemeMode,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeMode,
} from "./theme-types";

/**
 * App-wide theme controller.
 *
 * Single source of truth for "is the app currently in light or dark
 * mode?" The provider:
 *   1. Reads the operator's stored preference from localStorage.
 *   2. Resolves "system" against `matchMedia('prefers-color-scheme')`.
 *   3. Applies / removes a `dark` class on `<html>` so every Tailwind
 *      `dark:*` variant flips together.
 *   4. Listens to the OS preference media query while the selected
 *      mode is `system` so a desktop-side flip propagates instantly.
 *   5. Persists every explicit choice back to localStorage.
 *
 * Why a context (vs. a singleton hook): consumers like the topbar
 * dropdown + the settings appearance panel need to render the
 * current selection AND mutate it; sharing both via context keeps
 * the two surfaces in lockstep without a second parallel store.
 *
 * Hydration safety: an inline `<script>` in `app/layout.tsx` (see
 * `themeBootScript`) applies the correct `dark` class BEFORE React
 * hydrates, so the first paint matches the resolved theme. The
 * provider then re-asserts the same class — idempotent — and starts
 * listening for changes. We expose `mounted` via context so any
 * consumer that absolutely must wait until the client takes over
 * (e.g. a theme-conditional emoji) can short-circuit during SSR.
 */
interface ThemeContextValue {
  /** The operator's selection (`light` / `dark` / `system`). */
  theme: ThemeMode;
  /** What the page is actually rendering right now (`light` / `dark`). */
  resolvedTheme: ResolvedTheme;
  /** Setter — also writes to localStorage and re-applies the class. */
  setTheme: (next: ThemeMode) => void;
  /**
   * False during the very first render on the client (before
   * hydration completes). Most consumers can ignore this — the
   * inline boot script handles the FOUC; mounted is here for the
   * occasional component that needs to render different MARKUP per
   * theme (not just different styles).
   */
  mounted: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
  children: ReactNode;
  /**
   * Optional override of the localStorage default. Useful for tests
   * that want to assert "first-load defaults to light"; production
   * callers should leave this unset and let `DEFAULT_THEME` apply.
   */
  defaultTheme?: ThemeMode;
}

export function ThemeProvider({
  children,
  defaultTheme = DEFAULT_THEME,
}: ThemeProviderProps) {
  // Server-render and the first client paint both seed `theme` to the
  // default so there's no markup divergence. The effect below promotes
  // the value to whatever's persisted in localStorage on mount.
  const [theme, setThemeState] = useState<ThemeMode>(defaultTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");
  const [mounted, setMounted] = useState(false);

  // ---- Boot: read persisted choice ---------------------------------
  // Runs once. If the inline boot script already applied the correct
  // class, this effect just synchronises React state with what's
  // already on the DOM — it doesn't trigger a visible re-paint.
  useEffect(() => {
    setMounted(true);
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (isThemeMode(stored)) {
        setThemeState(stored);
      }
    } catch {
      // localStorage can throw under iframes / privacy modes / quota
      // exceeded; gracefully fall back to the default theme. No-op.
    }
  }, []);

  // ---- Resolve: project `theme` -> `resolvedTheme` ------------------
  // Re-runs whenever the operator flips modes OR (for `system`) when
  // the OS preference flips. Updating `resolvedTheme` triggers the
  // class-application effect below.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const compute = (): ResolvedTheme => {
      if (theme === "light") return "light";
      if (theme === "dark") return "dark";
      return media.matches ? "dark" : "light";
    };
    setResolvedTheme(compute());
    if (theme !== "system") return;
    // Only subscribe to OS changes while we're following the system —
    // an explicit selection means the operator wants to override the OS.
    const onChange = () => setResolvedTheme(compute());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  // ---- Apply: project `resolvedTheme` -> document class -------------
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolvedTheme === "dark");
    // `data-theme` is a debugging affordance + a hook for any
    // non-Tailwind CSS that needs to branch (e.g. a third-party
    // syntax-highlighter stylesheet picks its theme off this attr).
    root.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  // ---- Setter -------------------------------------------------------
  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Persistence failure is non-fatal — the in-memory state still
      // applies for the rest of the session.
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, mounted }),
    [theme, resolvedTheme, setTheme, mounted],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

/**
 * Read theme state inside any client component below the provider.
 * Throws if used outside one — that's a setup bug, not a user error,
 * so a hard error keeps it visible.
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used inside a <ThemeProvider>");
  }
  return ctx;
}
