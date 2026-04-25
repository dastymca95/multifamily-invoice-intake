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
        // Brand stays hardcoded — Rivera blue does NOT change between
        // light and dark mode (the brand square + accent buttons read
        // the same in both palettes).
        brand: {
          50: "#eff6ff",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          900: "#1e3a8a",
        },
        // Surface tokens map to CSS variables defined in globals.css.
        // The whole point of this layer is theme-awareness without
        // touching every consumer — `bg-surface` swaps automatically
        // when the `dark` class flips.
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
