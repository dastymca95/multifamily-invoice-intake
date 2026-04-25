/**
 * Theme system barrel.
 *
 * Re-exports keep the import sites short:
 *
 *   import { ThemeProvider, useTheme, ThemeToggle } from "@/components/theme";
 *
 * The boot script + raw type module are intentionally NOT re-exported
 * here — they're used by a single caller each (`app/layout.tsx` and
 * the provider itself) and surfacing them through the barrel would
 * suggest they're meant for general consumption.
 */
export { ThemeProvider, useTheme } from "./ThemeProvider";
export { ThemeToggle, ThemeSegmentedControl } from "./ThemeToggle";
export type { ResolvedTheme, ThemeMode } from "./theme-types";
