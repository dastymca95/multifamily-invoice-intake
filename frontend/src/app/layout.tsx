import type { Metadata } from "next";

import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { buildThemeBootScript } from "@/components/theme/theme-boot";

import "./globals.css";

export const metadata: Metadata = {
  title: "BillsIQ — Property Accounting",
  description:
    "Utility bill and vendor invoice processing for multifamily accounting teams.",
};

/**
 * Root layout — global wiring that needs to be present on every
 * route, regardless of which app section the user is on.
 *
 * Two pieces of theme plumbing live here:
 *
 *   1. `<script>` injected into `<head>` via dangerouslySetInnerHTML.
 *      Reads the persisted theme + applies the `dark` class on
 *      `<html>` BEFORE React hydrates and before the first paint.
 *      Without this step the page would briefly render with the
 *      default (light) palette before the React effect catches up
 *      — visible as a flash on dark-mode reloads. The script is
 *      tiny, dependency-free, and wrapped in a try/catch so a
 *      throwing localStorage call doesn't crash the app boot.
 *
 *   2. <ThemeProvider> wraps the tree so every client component
 *      below can read theme state via `useTheme()`. The provider
 *      itself is idempotent on mount — it observes whatever class
 *      the boot script already set instead of forcing its own
 *      defaults.
 *
 * `suppressHydrationWarning` on `<html>` is required because the
 * boot script mutates `class` + `data-theme` on the document element
 * before React reconciliation runs. Without it React would log a
 * (harmless) warning on every dark-mode load.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          // eslint-disable-next-line react/no-danger -- Trusted, build-time
          // string assembled in `theme-boot.ts`. Required to run before
          // React hydration to prevent a theme-flash on dark-mode reload.
          dangerouslySetInnerHTML={{ __html: buildThemeBootScript() }}
        />
      </head>
      <body className="antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
