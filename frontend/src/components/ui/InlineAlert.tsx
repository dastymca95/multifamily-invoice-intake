/**
 * Single source of truth for the "rounded box with a colored background and
 * an icon" pattern that Dashboard, Batch Detail, Review, and Exports were
 * each rolling by hand. Keeping all four tones (error/warning/info/success)
 * in one place means a tone tweak (color, padding, icon) propagates without
 * a sweep.
 *
 * Use the `action` slot for retry buttons or compact CTAs that should sit on
 * the right edge of the alert.
 */

import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type AlertTone = "error" | "warning" | "info" | "success";

const STYLES: Record<AlertTone, { box: string; iconColor: string; Icon: LucideIcon }> = {
  error: {
    box: "border-red-200 bg-red-50 text-red-700",
    iconColor: "text-red-500",
    Icon: AlertCircle,
  },
  warning: {
    box: "border-yellow-200 bg-yellow-50 text-yellow-800",
    iconColor: "text-yellow-600",
    Icon: AlertTriangle,
  },
  info: {
    box: "border-blue-200 bg-blue-50 text-blue-800",
    iconColor: "text-blue-500",
    Icon: Info,
  },
  success: {
    box: "border-green-200 bg-green-50 text-green-700",
    iconColor: "text-green-500",
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
        "rounded-md border px-3 py-2 text-xs flex items-start gap-2",
        box,
        className,
      )}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0 mt-0.5", iconColor)} />
      <div className="flex-1 min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        {children != null && <div className={title ? "mt-0.5" : ""}>{children}</div>}
      </div>
      {action && <div className="shrink-0 ml-2">{action}</div>}
    </div>
  );
}
