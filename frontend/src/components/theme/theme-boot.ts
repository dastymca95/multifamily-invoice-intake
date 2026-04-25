import { DEFAULT_THEME, THEME_STORAGE_KEY } from "./theme-types";

/**
 * Source for the inline FOUC-prevention script, injected into the
 * `<head>` by `app/layout.tsx` via `dangerouslySetInnerHTML` so it
 * runs synchronously BEFORE React hydrates and before the first
 * paint.
 *
 * Strategy:
 *   1. Try to read the persisted theme from localStorage.
 *   2. If absent or invalid, fall back to DEFAULT_THEME.
 *   3. Resolve to "light" / "dark" — `system` consults
 *      `matchMedia('prefers-color-scheme: dark')`.
 *   4. Apply the `dark` class on `<html>` accordingly.
 *
 * Wrapped in a try/catch so a thrown localStorage access (private
 * mode, sandbox iframe, etc.) leaves the document on its
 * server-rendered defaults rather than crashing the boot.
 *
 * IMPORTANT: this script runs BEFORE any module bundle, so it
 * cannot import anything. The constants are inlined at build time
 * via template strings instead of `import` statements at runtime.
 */
export function buildThemeBootScript(): string {
  // The script body is intentionally written as a plain string and
  // never reaches the React tree — keeping it small and readable
  // matters more than parametric flexibility.
  return `(function () {
  try {
    var storageKey = ${JSON.stringify(THEME_STORAGE_KEY)};
    var defaultTheme = ${JSON.stringify(DEFAULT_THEME)};
    var stored = window.localStorage.getItem(storageKey);
    var theme = (stored === "light" || stored === "dark" || stored === "system")
      ? stored
      : defaultTheme;
    var resolved = theme;
    if (theme === "system") {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    var root = document.documentElement;
    if (resolved === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  } catch (err) {
    // No-op: leave the document on its server-rendered defaults.
  }
})();`;
}
