/**
 * Shared theme vocabulary.
 *
 * Three SELECTABLE modes:
 *   * `light`   — force the light palette regardless of OS
 *   * `dark`    — force the dark palette regardless of OS
 *   * `system`  — follow `prefers-color-scheme` and react to changes
 *
 * Two RESOLVED modes — what the document actually renders right now:
 *   * `light`
 *   * `dark`
 *
 * Storage key is namespaced (`rivera-theme`) so it can't collide with
 * a third-party widget that also persists a "theme" key.
 */
export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "rivera-theme";
export const DEFAULT_THEME: ThemeMode = "system";

/** True when the value is one of the accepted ThemeMode strings. */
export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}
