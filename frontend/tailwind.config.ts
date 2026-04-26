import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  // Class-based dark mode: a `dark` class on `<html>` flips every
  // `dark:*` variant. The class is applied by `ThemeProvider` + a
  // small FOUC-prevention script in the root layout. Tailwind v3.4
  // honours `"class"` directly; future v4 migration would swap this
  // for the new `@variant` directive without touching the consumers.
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // ---- Rivera brand palette ----------------------------------
        //
        // Authoritative brand hexes, exposed in two ways:
        //
        //   1. The `brand` scale (50–900) is the primary action color
        //      family — Rivera Real Estate Blue #165DFF — bound to
        //      the existing `bg-brand-600`, `text-brand-700`,
        //      `bg-brand-900` classes already used across the app.
        //      Updating values here automatically restyles every
        //      consumer.
        //
        //      `brand-500` is bound to **Sky Cyan #16C7F2** so every
        //      `focus:ring-brand-500` / `focus-visible:ring-brand-500`
        //      class in the codebase (~70 occurrences across inputs,
        //      buttons, switches, links) automatically renders the
        //      brand cyan focus ring without per-component edits. This
        //      is the single biggest "free" lift for cyan visibility.
        //
        //   2. The `rivera-*` aliases let new code reach for the named
        //      brand colors directly:
        //        * `bg-rivera-blue`        — Real Estate Blue (#165DFF)
        //        * `bg-rivera-navy`        — Deep Navy (#061B33)
        //        * `bg-rivera-cyan`        — Sky Cyan (#16C7F2)
        //        * `bg-rivera-lime`        — Electric Lime (#B7F20A)
        //        * `bg-rivera-soft-lime`   — Soft Lime Background (#ECFFD2)
        //        * `bg-rivera-ice`         — Ice Blue Background (#F3F8FF)
        //
        // Brand colors do NOT swap between light and dark — Rivera
        // Blue stays Rivera Blue across both palettes; tinting it
        // would compromise the brand mark.
        brand: {
          50: "#EFF6FF", // Tailwind blue-50 — soft chip backgrounds
          100: "#DBEAFE", // light hover surfaces
          400: "#3B82F6", // legacy mid blue (kept for divider hover)
          500: "#16C7F2", // Sky Cyan — focus rings, cyan accents
          600: "#165DFF", // Real Estate Blue — primary action
          700: "#1D4ED8", // Real Estate Blue hover
          900: "#061B33", // Deep Navy — sidebar foundation in light mode
        },
        rivera: {
          blue: "#165DFF",       // Real Estate Blue — primary action
          navy: "#061B33",       // Foundation / dark backdrops
          cyan: "#16C7F2",       // Support / info / focus / hover accents
          lime: "#B7F20A",       // Validation / ready / selected accent
          "soft-lime": "#ECFFD2",// Soft callout chips / hover wash (light)
          ice: "#F3F8FF",        // Ice Blue Background (light page bg)
        },

        // ---- Surface tokens (CSS-var backed, theme-aware) ----------
        //
        // These map to the variables in `globals.css`. The whole point
        // of this layer is theme-awareness without touching every
        // consumer — `bg-surface` swaps automatically when the `dark`
        // class flips. All surface/ink/line VALUES are aligned with
        // the Rivera palette; the token NAMES stay stable so consumer
        // code never had to change.
        //
        // The `<alpha-value>` placeholder is Tailwind's convention for
        // letting `bg-surface/80` style still work; the CSS variables
        // are stored as raw `r g b` triples for that reason.
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          muted: "rgb(var(--surface-muted) / <alpha-value>)",
          subtle: "rgb(var(--surface-subtle) / <alpha-value>)",
          inverted: "rgb(var(--surface-inverted) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--ink) / <alpha-value>)",
          muted: "rgb(var(--ink-muted) / <alpha-value>)",
          subtle: "rgb(var(--ink-subtle) / <alpha-value>)",
          inverted: "rgb(var(--ink-inverted) / <alpha-value>)",
        },
        line: {
          DEFAULT: "rgb(var(--line) / <alpha-value>)",
          strong: "rgb(var(--line-strong) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
