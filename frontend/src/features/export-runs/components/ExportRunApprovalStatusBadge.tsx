"use client";

import { cn } from "@/lib/utils";

import {
  getApprovalStatusLabel,
  getApprovalStatusTone,
} from "../lib/export-run-display";

/**
 * Phase 6B — Approval-status pill for the audit list table +
 * detail panel.
 *
 * Tone follows the project convention:
 *   * ``not_requested`` → neutral gray.
 *   * ``pending_review`` → amber.
 *   * ``approved_for_file_generation`` → cyan/blue (NEVER green —
 *     green would imply "ready to export"; the boundary panel +
 *     status badge use the same convention).
 *   * ``rejected`` → rose.
 *   * unknown → neutral gray (forward-compat). NEVER renders the
 *     cyan/blue tone for an unknown literal.
 */
export function ExportRunApprovalStatusBadge({
  status,
  className,
}: {
  status: string | null | undefined;
  className?: string;
}) {
  const tone = getApprovalStatusTone(status);
  const label = getApprovalStatusLabel(status);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide",
        tone.border,
        tone.bg,
        tone.text,
        className,
      )}
      title={`Approval: ${label}`}
    >
      {label}
    </span>
  );
}
