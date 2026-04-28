/**
 * Single source of truth for the "rounded box with a colored background and
 * an icon" pattern that Dashboard, Batch Detail, Review, and Exports were
 * each rolling by hand. Keeping all four tones (error/warning/info/success)
 * in one place means a tone tweak (color, padding, icon) propagates without
 * a sweep.
 *
 * Use the `action` slot for retry buttons or compact CTAs that should sit on
 * the right edge of the alert.
 *
 * Rivera-aligned tones:
 *
 *   * `error`   — Coral red. Stays on Tailwind red palette so the
 *                  destructive-action signal reads consistently with
 *                  delete buttons and `Modal` danger variants.
 *   * `warning` — Amber. Same Tailwind yellow palette as before.
 *   * `info`    — **Sky Cyan #16C7F2** (Rivera support color). Replaces
 *                  the previous Tailwind blue tone so info messages
 *                  visibly use the brand cyan instead of competing with
 *                  Rivera Blue (which is reserved for primary actions).
 *   * `success` — **Electric Lime #B7F20A** (Rivera validation accent).
 *                  Replaces the previous Tailwind green tone so success
 *                  / validated / ready messages surface the brand lime.
 */

import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type AlertTone = "error" | "warning" | "info" | "success";

// Dark-mode tones nudge each tinted background from the bright /-50
// shade down to a translucent variant of the same hue (`/15` on a
// slate surface) — keeps the emotional read (red = error, yellow =
// warning, cyan = info, lime = success) without burning eyes against
// a dark page. Border + text colors lift toward the lighter end of
// the same palette so the alert stays legible.
const STYLES: Record<AlertTone, { box: string; iconColor: string; Icon: LucideIcon }> = {
  error: {
    box:
      "border-red-200 bg-red-50 text-red-700 " +
      "dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
    iconColor: "text-red-500 dark:text-red-400",
    Icon: AlertCircle,
  },
  warning: {
    box:
      "border-yellow-200 bg-yellow-50 text-yellow-800 " +
      "dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-200",
    iconColor: "text-yellow-600 dark:text-yellow-400",
    Icon: AlertTriangle,
  },
  // Sky Cyan info tone. Light mode pairs a soft cyan tint with a
  // deeper teal foreground (#0E7490) for readable contrast on
  // off-white. Dark mode lifts the foreground to the brand cyan
  // hex (#16C7F2) so the info accent feels Rivera-branded rather
  // than generic Tailwind blue.
  info: {
    box:
      "border-[rgba(22,199,242,0.30)] bg-[rgba(22,199,242,0.10)] text-[#0E7490] " +
      "dark:border-[rgba(22,199,242,0.40)] dark:bg-[rgba(22,199,242,0.12)] dark:text-rivera-cyan",
    iconColor: "text-rivera-cyan dark:text-rivera-cyan",
    Icon: Info,
  },
  // Electric Lime success tone. Light mode keeps the foreground in
  // the brand navy (#061B33) so the lime tint reads as accent
  // rather than text. Dark mode flips to the brand lime hex on a
  // softer navy-tinted background so the validation accent pops
  // against deep navy panels.
  success: {
    box:
      "border-[rgba(183,242,10,0.50)] bg-[rgba(183,242,10,0.18)] text-rivera-navy " +
      "dark:border-[rgba(183,242,10,0.55)] dark:bg-[rgba(183,242,10,0.14)] dark:text-rivera-lime",
    iconColor: "text-rivera-navy dark:text-rivera-lime",
    Icon: CheckCircle2,
  },
};

interface InlineAlertProps {
  tone: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Right-aligned slot for compact actions (retry, dismiss, etc.). */
  action?: ReactNode;
  className?: string;
}

export function InlineAlert({ tone, title, children, action, className }: InlineAlertProps) {
  const { box, iconColor, Icon } = STYLES[tone];
  return (
    <div
      className={cn(
        "rounded-lg border px-3.5 py-2.5 text-xs flex items-start gap-2.5 shadow-sm",
        box,
        className,
      )}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon className={cn("h-4 w-4 shrink-0 mt-0.5", iconColor)} />
      <div className="flex-1 min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        {children != null && <div className={title ? "mt-0.5" : ""}>{children}</div>}
      </div>
      {action && <div className="shrink-0 ml-2.5">{action}</div>}
    </div>
  );
}
