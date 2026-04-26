/**
 * Rivera brand mark — renders the official PNG asset.
 *
 * This component is intentionally a thin wrapper around an `<img>` tag
 * pointed at the file in `public/brand/`:
 *
 *   * **No CSS / SVG / lucide recreation.** The visual identity comes
 *     from the brand-supplied PNG; recreating it in code would drift
 *     out of sync with the official asset.
 *   * **One swap point.** Replace `public/brand/rivera-logo.png` to
 *     refresh the mark across every consumer (sidebar today, plus any
 *     future surface that mounts this component).
 *   * **Path indirection lives in `lib/brand.ts`** so the URL string
 *     never has to be repeated. Future infra changes (e.g. moving to
 *     a CDN) are a one-line edit there.
 *
 * The plain `<img>` is preferred over `next/image` here so the wrapper
 * stays trivial — the logo is never above the fold's LCP candidate
 * (it's fixed-size brand chrome) and we want zero JS hydration cost
 * on a presentational mark.
 *
 * Variant choice — `fullLockup` vs `iconOnly`:
 *
 *   * `fullLockup` (default for the sidebar): the PNG is the
 *     icon + "Rivera" wordmark in one image. Renders wide
 *     (≈150–180 px) with `h-auto`. Consumers MUST NOT render an
 *     adjacent "Rivera" text — the wordmark is already in the PNG.
 *   * `iconOnly`: the PNG is just the rounded-square mark. Renders
 *     square (defaults to `h-9 w-9`). Consumers may add the
 *     "Rivera" wordmark next to it.
 *
 * Today both variants point at the same `RIVERA_LOGO_SRC` URL because
 * the brand ships the lockup as the canonical PNG. If a separate
 * icon-only PNG ever ships, swap one line here (see the `src`
 * resolution below) — every consumer keeps working.
 */
import { RIVERA_LOGO_ALT, RIVERA_LOGO_SRC } from "@/lib/brand";

import { cn } from "@/lib/utils";

export type RiveraLogoVariant = "fullLockup" | "iconOnly";

interface RiveraLogoProps {
  /**
   * Which artwork to render.
   *
   *   * `"fullLockup"` — icon + wordmark. Use in the sidebar header.
   *     Default sizing is `h-auto w-[150px]`.
   *   * `"iconOnly"` — square mark only. Use anywhere the wordmark
   *     is provided separately (e.g. a footer "powered by" row).
   *     Default sizing is `h-9 w-9`.
   */
  variant?: RiveraLogoVariant;
  /**
   * Tailwind sizing class. When omitted, the variant default applies
   * — `h-auto w-[150px]` for fullLockup, `h-9 w-9` for iconOnly.
   * Pass an explicit className to override (e.g. `"h-7 w-[120px]"`
   * for a more compact rendering).
   */
  className?: string;
  /** Accessible name override. Defaults to "Rivera". */
  title?: string;
}

const VARIANT_DEFAULT_CLASSNAMES: Record<RiveraLogoVariant, string> = {
  // Wide aspect — `h-auto` lets the natural aspect of the lockup PNG
  // determine height. 150 px wide fits the 240 px sidebar comfortably
  // with margin to spare.
  fullLockup: "h-auto w-[150px]",
  // Square — matches the rounded-mark aspect. Consumers add the
  // wordmark next to it as a sibling element.
  iconOnly: "h-9 w-9",
};

export function RiveraLogo({
  variant = "fullLockup",
  className,
  title = RIVERA_LOGO_ALT,
}: RiveraLogoProps) {
  const sizing = className ?? VARIANT_DEFAULT_CLASSNAMES[variant];
  return (
    // eslint-disable-next-line @next/next/no-img-element -- presentational
    // brand chrome served from /public; we want zero JS overhead and the
    // image is fixed-size, so plain <img> beats next/image here.
    <img
      src={RIVERA_LOGO_SRC}
      alt={title}
      // `object-contain` keeps the PNG aspect-correct regardless of
      // whether the variant is the icon-only square or the full
      // lockup. `select-none` + `draggable={false}` prevents accidental
      // drag when the operator is dragging files into the workspace.
      className={cn(sizing, "object-contain select-none")}
      draggable={false}
    />
  );
}
