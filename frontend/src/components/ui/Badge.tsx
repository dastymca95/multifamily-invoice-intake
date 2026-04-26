import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * Tone palette for badges / status pills. Two Rivera-aligned tones
 * are layered on top of the original tone set:
 *
 *   * `lime` — Electric Lime #B7F20A. Use for VALIDATION / READY /
 *     ACTIVE accents (e.g. "Validated", "Ready to Export", "Active"
 *     when surfaced as a pill rather than a checkbox). Distinct
 *     from `green` (which keeps the emerald success palette for
 *     legacy callers); new validation surfaces should prefer `lime`
 *     so the brand accent shows up across the app.
 *   * `cyan` — Sky Cyan #16C7F2. Use for SUPPORT / INFO accents —
 *     "info" notes, system metadata, cross-references. Distinct from
 *     `blue` (which keeps Rivera Blue's primary-action role).
 *
 * Each tone has a paired dark variant: a translucent tinted
 * background on the slate page surface plus a lifted text color so
 * the chip stays readable. Lime's dark-mode background uses the
 * brand-recommended `rgba(183, 242, 10, 0.14)` and a dark navy
 * foreground so the accent reads bright without burning out.
 */
const colors = {
  gray: "bg-gray-100 text-gray-700 dark:bg-surface-muted dark:text-ink-muted",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-200",
  green:
    "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-200",
  yellow:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-200",
  red: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-200",
  purple:
    "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-200",
  // Electric Lime — validation/ready/active accent. Light: soft lime
  // background (≈18% alpha) with the brand navy as foreground for
  // strong contrast. Dark: same alpha at 14%, brand navy text stays
  // legible on the lime tint. The hex is anchored to the rivera
  // palette in tailwind.config.ts.
  lime:
    "bg-[rgba(183,242,10,0.18)] text-rivera-navy ring-1 ring-[rgba(183,242,10,0.45)] " +
    "dark:bg-[rgba(183,242,10,0.14)] dark:text-rivera-lime dark:ring-[rgba(183,242,10,0.55)]",
  // Sky Cyan — info/support accent. Same pattern: tinted background +
  // ring so the chip pops against either light Ice Blue or dark
  // navy surfaces.
  cyan:
    "bg-[rgba(22,199,242,0.16)] text-[#0E7490] ring-1 ring-[rgba(22,199,242,0.40)] " +
    "dark:bg-[rgba(22,199,242,0.14)] dark:text-rivera-cyan dark:ring-[rgba(22,199,242,0.45)]",
};

interface BadgeProps {
  children: ReactNode;
  color?: keyof typeof colors;
  className?: string;
}

export function Badge({ children, color = "gray", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        colors[color],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function statusBadgeColor(status: string): keyof typeof colors {
  switch (status) {
    case "approved":
      // Approval is a brand-validation moment — use Electric Lime so
      // the brand accent shows up on every approved batch.
      return "lime";
    case "extracted":
      return "blue";
    case "processing":
      return "yellow";
    case "failed":
      return "red";
    case "rejected":
      return "red";
    case "pending":
      return "gray";
    case "completed":
      // Completion = ready/validated state — same lime treatment.
      return "lime";
    default:
      return "gray";
  }
}
