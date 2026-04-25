/**
 * Rivera brand mark — inline SVG so the sidebar can render it without
 * needing an external image asset round-trip. Reproduces the:
 *   * Blue (#2563eb / brand-600) rounded square
 *   * White stylised "R" with three horizontal speed lines feeding
 *     into its vertical stem
 *   * Lime-green (#a3e635) accent dot at the foot of the diagonal leg
 *
 * Why inline SVG (vs. <Image src="/rivera-logo.png">):
 *   * Zero asset wiring — drops in cleanly with no `public/` file to
 *     ship or version.
 *   * Inherits text color via `currentColor` where useful and scales
 *     crisply at any size on any DPI.
 *   * Theming is one fill swap away if Rivera ever updates the brand
 *     palette.
 *
 * If a future polish pass wants pixel-perfect parity with the brand
 * PNG, swap this component out for a `next/image` that points at
 * `/rivera-logo.png` — the call sites only consume `className`, so
 * the API stays drop-in compatible.
 */
interface RiveraLogoProps {
  /** Tailwind sizing class (e.g. `"h-9 w-9"`). Defaults to `h-8 w-8`. */
  className?: string;
  /** Accessible name surfaced to assistive tech. */
  title?: string;
}

export function RiveraLogo({
  className = "h-8 w-8",
  title = "Rivera",
}: RiveraLogoProps) {
  return (
    <svg
      viewBox="0 0 200 200"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      {/* Brand square — corner radius matches the Rivera mark. */}
      <rect width="200" height="200" rx="44" fill="#2563eb" />
      {/* Stylised "R": three horizontal speed lines on the left flow
          into a vertical stem, capped by an arc at the top and a
          diagonal leg at the bottom. Stroke widths picked so each
          glyph component reads at sidebar scale (≈32 px) without
          merging visually. */}
      <g
        fill="none"
        stroke="#ffffff"
        strokeWidth="20"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Three speed lines */}
        <line x1="38" y1="78" x2="124" y2="78" />
        <line x1="38" y1="118" x2="104" y2="118" />
        <line x1="38" y1="158" x2="104" y2="158" />
        {/* Top arc of the R — curves from the top of the stem rightward
            and back down to the mid-stem. */}
        <path d="M 124 78 Q 162 78 162 108 Q 162 138 128 138" />
        {/* Vertical stem of the R */}
        <line x1="124" y1="78" x2="124" y2="138" />
        {/* Diagonal leg dropping toward the green accent dot */}
        <line x1="128" y1="138" x2="150" y2="172" />
      </g>
      {/* Lime accent dot at the foot of the leg — the brand "moving" cue. */}
      <circle cx="150" cy="172" r="14" fill="#a3e635" />
    </svg>
  );
}
