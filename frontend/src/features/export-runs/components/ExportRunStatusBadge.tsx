"use client";

import { cn } from "@/lib/utils";

import {
  getExportRunStatusLabel,
  getExportRunStatusTone,
} from "../lib/export-run-display";

/**
 * Phase 5C — Status pill for the audit-list table + detail panel.
 *
 * Tone follows the project convention:
 *   * ``draft_clear`` → cyan/blue (NEVER green — green would imply
 *     "ready to export"; the boundary panel + Operational Preview
 *     surface use the same convention).
 *   * ``needs_review`` → amber.
 *   * ``blocked`` → rose.
 *   * ``draft`` / unknown → neutral gray.
 *
 * Forward-compat: an unknown status renders verbatim (raw value)
 * with the neutral tone so a future backend literal lands cleanly
 * without a frontend release.
 */
export function ExportRunStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const tone = getExportRunStatusTone(status);
  const label = getExportRunStatusLabel(status);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide",
        tone.border,
        tone.bg,
        tone.text,
        className,
      )}
      title={`Status: ${label}`}
    >
      {label}
    </span>
  );
}
