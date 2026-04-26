/**
 * Rivera brand asset constants.
 *
 * Central source for paths/labels and authoritative brand hex values.
 * Concentrating them here means the rest of the app references stable
 * identifiers — swapping the logo PNG, the alt text, or a brand
 * color is a one-file change with no component edits.
 *
 * The logo PNG itself lives at `public/brand/rivera-logo.png` and is
 * served by Next.js at the URL below. Replace the file in-place to
 * update the logo across every consumer.
 */

/** Public URL for the official Rivera logo PNG. */
export const RIVERA_LOGO_SRC = "/brand/rivera-logo.png";

/** Accessible name surfaced to assistive tech for the logo image. */
export const RIVERA_LOGO_ALT = "Rivera";

/**
 * Authoritative Rivera brand colors. Mirrors the Tailwind palette in
 * `tailwind.config.ts` + the CSS variables in `globals.css`.
 *
 * Use Tailwind classes (`bg-brand-600`, `bg-rivera-cyan`, etc.) for
 * styling and only reach for these constants when raw hex is
 * unavoidable (e.g. inline `style` props for chart libraries, region
 * overlays drawn with arbitrary colors).
 *
 * Roles in the design system:
 *
 *   * `realEstateBlue` — primary action color. Buttons, sidebar
 *     active backgrounds, primary CTAs.
 *   * `navy`           — foundation. Sidebar light-mode bg, dark-mode
 *     page bg, foreground for high-contrast accents on lime.
 *   * `cyan`           — support / focus / hover / info accents.
 *     Focus rings, secondary tab hovers, info badges.
 *   * `lime`           — validation / ready / selected accent.
 *     Active indicators, satisfied stats, "Linked" region badges.
 *   * `softLime`       — soft callout chips and hover washes (light).
 *   * `iceBlue`        — Ice Blue Background (light page bg).
 */
export const RIVERA_COLORS = {
  // --- Core brand ----------------------------------------------------
  realEstateBlue: "#165DFF",
  navy: "#061B33",
  cyan: "#16C7F2",
  lime: "#B7F20A",
  // --- Supporting backgrounds ---------------------------------------
  softLime: "#ECFFD2",
  iceBlue: "#F3F8FF",
  white: "#FFFFFF",
  // --- Neutral text / structural ------------------------------------
  ink: "#111827",
  muted: "#64748B",
  border: "#DCE7F5",

  // --- Legacy aliases (kept for backwards compatibility) ------------
  // The previous export used `blue` as the primary action color name.
  // Keep it pointing at the new Real Estate Blue so any existing
  // imports (e.g. `RIVERA_COLORS.blue`) resolve correctly.
  blue: "#165DFF",
} as const;
