"use client";

import { cn } from "@/lib/utils";

interface UploadProgressBarProps {
  /** 0..100. Values outside the range are clamped. */
  value: number;
  /**
   * Visual tone:
   *   - active   = brand color (currently uploading)
   *   - success  = green (finished cleanly)
   *   - warning  = amber (finished but with non-fatal notes — e.g. dupes)
   *   - error    = red (something failed)
   *   - idle     = gray (nothing happening yet)
   */
  tone?: "active" | "success" | "warning" | "error" | "idle";
  /** Slight visual difference between batch-overall vs. per-file rows. */
  size?: "sm" | "md";
  /** Animate the moving stripe while uploading. */
  indeterminate?: boolean;
  className?: string;
}

const TONE_CLASSES: Record<NonNullable<UploadProgressBarProps["tone"]>, string> = {
  active: "bg-brand-600",
  success: "bg-green-500",
  warning: "bg-yellow-500",
  error: "bg-red-500",
  idle: "bg-gray-300",
};

export function UploadProgressBar({
  value,
  tone = "active",
  size = "md",
  indeterminate = false,
  className,
}: UploadProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const trackHeight = size === "sm" ? "h-1" : "h-1.5";

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-full bg-gray-100",
        trackHeight,
        className,
      )}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300 ease-out",
          TONE_CLASSES[tone],
          indeterminate && "animate-pulse",
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
