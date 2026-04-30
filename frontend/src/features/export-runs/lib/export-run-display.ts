/**
 * Phase 5C — Export Runs audit-list display helpers.
 *
 * Pure helpers shared by the audit list page + detail panel:
 *   * Operator-friendly status labels (mirror the panel's
 *     ``_DRAFT_STATUS_LABEL``).
 *   * Cyan/blue tone tokens for status badges — never green for
 *     ``draft_clear`` (mirrors the boundary + draft body
 *     conventions: green would imply "ready to export").
 *   * Closed Literal sets for the audit-list filters.
 *   * Defensive date / hard-pin extraction so a malformed
 *     ``draft_snapshot`` blob can't break the panel.
 *
 * Pure / synchronous — no React, no fetch, no DOM.
 */

import type {
  BackendExportRunDraftResult,
  BackendExportRunDraftReason,
} from "@/types/export-run-draft";
import type {
  PersistedExportRunApprovalStatus,
  PersistedExportRunRead,
  PersistedExportRunStatus,
} from "@/types/export-run-persistence";

// ---------------------------------------------------------------------------
// Status labels + tones
// ---------------------------------------------------------------------------

/**
 * Operator-friendly status labels. Mirrors the panel's
 * ``_DRAFT_STATUS_LABEL`` so the audit list reads the same as the
 * Operational Preview surface that produced the records.
 *
 * Forward-compat: any unknown status value renders verbatim via
 * ``getExportRunStatusLabel`` so a future backend literal lands
 * gracefully without a frontend release.
 */
export const EXPORT_RUN_STATUS_LABEL: Record<string, string> = {
  draft_clear: "Draft clear",
  needs_review: "Needs review",
  blocked: "Blocked",
  draft: "Draft",
  // Forward-compat — Phase 5A maps the Phase 4F ``not_available``
  // value to ``"blocked"`` on persisted rows, but a pre-Phase 5A
  // client occasionally seeing the older literal should still
  // render cleanly.
  not_available: "Not available",
};

/**
 * Operator-facing status label.
 *
 * Phase 5D — when the value is unknown (forward-compat literal, or
 * a malformed row), label as ``"Unknown (<raw>)"`` so the operator
 * can never misread an unfamiliar string as a known verdict. Empty
 * / null values fall back to ``"Unknown"`` with no parens.
 */
export function getExportRunStatusLabel(
  status: string | null | undefined,
): string {
  if (typeof status !== "string" || status.trim().length === 0) {
    return "Unknown";
  }
  if (EXPORT_RUN_STATUS_LABEL[status]) {
    return EXPORT_RUN_STATUS_LABEL[status]!;
  }
  return `Unknown (${status})`;
}

/**
 * Visual tone tokens for the status badge.
 *
 *   * ``draft_clear`` → cyan/blue (NEVER green — green would imply
 *     "ready to export").
 *   * ``needs_review`` → amber.
 *   * ``blocked`` → rose.
 *   * ``draft`` → neutral gray.
 *   * unknown → neutral gray.
 */
export interface ExportRunStatusTone {
  /** Tailwind class string for the badge border. */
  border: string;
  /** Tailwind class string for the badge background. */
  bg: string;
  /** Tailwind class string for the badge text. */
  text: string;
  /** Short single-word tone keyword for callers that prefer to
   *  branch on a Literal instead of class strings. */
  tone: "cyan" | "amber" | "rose" | "neutral";
}

const _STATUS_TONE_BY_VALUE: Record<string, ExportRunStatusTone> = {
  draft_clear: {
    border: "border-cyan-200 dark:border-cyan-900",
    bg: "bg-cyan-50 dark:bg-cyan-950/40",
    text: "text-cyan-800 dark:text-cyan-200",
    tone: "cyan",
  },
  needs_review: {
    border: "border-yellow-200 dark:border-yellow-900",
    bg: "bg-yellow-50 dark:bg-yellow-950/30",
    text: "text-yellow-800 dark:text-yellow-200",
    tone: "amber",
  },
  blocked: {
    border: "border-rose-200 dark:border-rose-900",
    bg: "bg-rose-50 dark:bg-rose-950/30",
    text: "text-rose-800 dark:text-rose-200",
    tone: "rose",
  },
  draft: {
    border: "border-gray-200 dark:border-line",
    bg: "bg-gray-50 dark:bg-surface-muted/60",
    text: "text-gray-700 dark:text-ink-muted",
    tone: "neutral",
  },
  not_available: {
    border: "border-gray-200 dark:border-line",
    bg: "bg-gray-50 dark:bg-surface-muted/60",
    text: "text-gray-700 dark:text-ink-muted",
    tone: "neutral",
  },
};

const _NEUTRAL_TONE: ExportRunStatusTone = {
  border: "border-gray-200 dark:border-line",
  bg: "bg-gray-50 dark:bg-surface-muted/60",
  text: "text-gray-700 dark:text-ink-muted",
  tone: "neutral",
};

/**
 * Visual tone for the status badge.
 *
 * Phase 5D — null / undefined / unknown values fall back to the
 * neutral gray tone. NEVER returns the cyan/blue tone for an
 * unknown status — the operator must not infer "ready" from an
 * unfamiliar literal.
 */
export function getExportRunStatusTone(
  status: string | null | undefined,
): ExportRunStatusTone {
  if (typeof status !== "string" || status.trim().length === 0) {
    return _NEUTRAL_TONE;
  }
  return _STATUS_TONE_BY_VALUE[status] ?? _NEUTRAL_TONE;
}

// ---------------------------------------------------------------------------
// Filter vocabularies (closed sets — match the Phase 5A backend)
// ---------------------------------------------------------------------------

export const EXPORT_RUN_STATUS_FILTER_OPTIONS: ReadonlyArray<{
  value: PersistedExportRunStatus | "all";
  label: string;
}> = [
  { value: "all", label: "All statuses" },
  { value: "draft_clear", label: "Draft clear" },
  { value: "needs_review", label: "Needs review" },
  { value: "blocked", label: "Blocked" },
];

export const EXPORT_RUN_TARGET_SYSTEM_LABEL: Record<string, string> = {
  custom_csv: "Custom CSV",
  resman: "ResMan",
  yardi: "Yardi",
  appfolio: "AppFolio",
};

export function getTargetSystemLabel(
  value: string | null | undefined,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "—";
  }
  return EXPORT_RUN_TARGET_SYSTEM_LABEL[value] ?? value;
}

export const EXPORT_RUN_TARGET_SYSTEM_FILTER_OPTIONS: ReadonlyArray<{
  value: string | "all";
  label: string;
}> = [
  { value: "all", label: "All target systems" },
  { value: "custom_csv", label: "Custom CSV" },
  { value: "resman", label: "ResMan" },
  { value: "yardi", label: "Yardi" },
  { value: "appfolio", label: "AppFolio" },
];

// ---------------------------------------------------------------------------
// Hard-pin extraction (defensive)
// ---------------------------------------------------------------------------

/**
 * Extract the Phase 4F hard-pinned literals from a persisted
 * ``draft_snapshot`` value. The backend re-validates the snapshot
 * on write through Pydantic ``Literal[…]``, so on a healthy row
 * every flag is present and the right value. This helper is
 * defensive: a malformed snapshot returns ``null`` for any missing
 * flag so the panel renders "Not provided" instead of inferring
 * "ready" from absence.
 *
 * The return type uses ``boolean | null`` (not the Literal types)
 * so the panel can reason about a missing value separately from a
 * present-but-wrong value.
 */
export interface ExportRunDraftHardPins {
  draft_only: boolean | null;
  finalized: boolean | null;
  file_generated: boolean | null;
  download_available: boolean | null;
  production_export_ready: boolean | null;
}

export function extractDraftHardPins(
  snapshot: BackendExportRunDraftResult | Record<string, unknown> | null | undefined,
): ExportRunDraftHardPins {
  const out: ExportRunDraftHardPins = {
    draft_only: null,
    finalized: null,
    file_generated: null,
    download_available: null,
    production_export_ready: null,
  };
  if (!snapshot || typeof snapshot !== "object") return out;
  const blob = snapshot as Record<string, unknown>;
  for (const key of Object.keys(out) as (keyof ExportRunDraftHardPins)[]) {
    const v = blob[key];
    if (typeof v === "boolean") {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Extract operator-facing fields from the snapshot for the
 * detail panel:
 *
 *   * ``operator_title`` / ``operator_message`` — surfaced in the
 *     "Operator-facing verdict" block.
 *   * ``reasons`` — capped + rendered as a bullet list with
 *     friendly labels.
 *   * ``next_steps`` — capped + rendered as an ordered list.
 *   * ``disclaimers`` — surfaced as italic small print.
 *
 * Returns sane defaults when the snapshot is missing fields so
 * the panel never crashes on a partial blob.
 */
export interface ExportRunDraftSnapshotFields {
  operator_title: string;
  operator_message: string;
  developer_message: string;
  reasons: string[];
  next_steps: string[];
  disclaimers: string[];
}

export function extractDraftSnapshotFields(
  snapshot: BackendExportRunDraftResult | Record<string, unknown> | null | undefined,
): ExportRunDraftSnapshotFields {
  const blob =
    snapshot && typeof snapshot === "object"
      ? (snapshot as Record<string, unknown>)
      : {};
  const stringOr = (value: unknown, fallback: string): string =>
    typeof value === "string" ? value : fallback;
  const arrayOfStrings = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === "string");
  };
  return {
    operator_title: stringOr(blob.operator_title, ""),
    operator_message: stringOr(blob.operator_message, ""),
    developer_message: stringOr(blob.developer_message, ""),
    reasons: arrayOfStrings(blob.reasons),
    next_steps: arrayOfStrings(blob.next_steps),
    disclaimers: arrayOfStrings(blob.disclaimers),
  };
}

// ---------------------------------------------------------------------------
// Friendly reason labels (mirror the panel's _DRAFT_REASON_LABEL)
// ---------------------------------------------------------------------------

const _REASON_LABEL: Record<string, string> = {
  diagnostic_only_pipeline: "Diagnostic-only pipeline",
  no_export_engine: "No export engine",
  no_file_generation: "No export file generation",
  no_export_run_persistence: "No export run persistence",
  no_final_approval: "No final approval workflow",
  no_export_audit_trail: "No export run / audit trail",
  no_external_posting: "No external posting (ResMan / Yardi / AppFolio)",
  readiness_boundary_not_clear: "Readiness boundary not clear",
  profile_not_persisted: "Selected profile is not persisted",
  profile_validation_blocked: "Profile validation blocked",
  profile_validation_needs_review: "Profile validation needs review",
  no_rows_to_export: "No rows to export",
  row_issues_present: "Row issues present",
};

/**
 * Phase 5D — humanise a snake_case identifier into a display
 * string. Handles ``null`` / ``undefined`` / non-string input
 * gracefully and never crashes on weird unicode / casing.
 *
 *   "no_export_engine" -> "No export engine"
 *   "FOO_BAR"          -> "Foo bar"
 *   ""                 -> ""
 *   null               -> ""
 *
 * Pure / synchronous.
 */
export function humanizeSnakeCase(
  value: string | null | undefined,
): string {
  if (typeof value !== "string" || value.length === 0) return "";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const lowered = trimmed.toLowerCase().replace(/_+/g, " ");
  return lowered.charAt(0).toUpperCase() + lowered.slice(1);
}

/**
 * Operator-facing reason label. Phase 5D — when the reason isn't
 * in the known map, fall back to a humanised snake_case form so
 * the panel never dumps raw codes as the only label. The raw
 * code is still shown in a monospace tag inside the detail
 * panel for technical traceability.
 */
export function getReasonLabel(
  reason: BackendExportRunDraftReason | string | null | undefined,
): string {
  if (typeof reason !== "string" || reason.length === 0) {
    return "Unknown reason";
  }
  return _REASON_LABEL[reason] ?? humanizeSnakeCase(reason) ?? reason;
}

/**
 * Phase 5D — operator-facing phase label. Unknown phases render
 * verbatim so a future ``approved`` / ``finalized`` literal lands
 * cleanly without a frontend release. NEVER labels an unknown
 * phase as "Finalized" — the panel only renders what the
 * backend persists.
 */
export function getPhaseLabel(
  phase: string | null | undefined,
): string {
  if (typeof phase !== "string" || phase.trim().length === 0) {
    return "Unknown";
  }
  if (phase === "draft") return "Draft";
  return humanizeSnakeCase(phase);
}

/**
 * Phase 5D — operator-facing source label. Same forward-compat
 * behaviour as ``getPhaseLabel``.
 */
export function getSourceLabel(
  source: string | null | undefined,
): string {
  if (typeof source !== "string" || source.trim().length === 0) {
    return "Unknown";
  }
  if (source === "operational_preview") return "Operational Preview";
  if (source === "api") return "API";
  if (source === "manual") return "Manual";
  return humanizeSnakeCase(source);
}

// ---------------------------------------------------------------------------
// Date formatting (defensive)
// ---------------------------------------------------------------------------

/**
 * Localised display of an ISO timestamp.
 *
 * Phase 5D — distinguishes:
 *
 *   * ``null`` / ``undefined`` / empty string -> "Not provided"
 *   * a non-empty but unparseable string      -> "Invalid date"
 *   * a parseable ISO                          -> ``toLocaleString``
 *
 * The two distinct fallbacks help an operator tell "the backend
 * didn't capture this column" from "the column was captured but is
 * malformed" without forcing them to inspect the raw row. The
 * caller can override either fallback when a different convention
 * is needed (e.g. the table cell uses an em-dash in some columns).
 */
export function formatExportRunTimestamp(
  iso: string | null | undefined,
  options?: {
    /** Fallback when ``iso`` is null / undefined / empty. */
    missingLabel?: string;
    /** Fallback when ``iso`` is non-empty but unparseable. */
    invalidLabel?: string;
  },
): string {
  const missingLabel = options?.missingLabel ?? "Not provided";
  const invalidLabel = options?.invalidLabel ?? "Invalid date";
  if (typeof iso !== "string" || iso.trim().length === 0) {
    return missingLabel;
  }
  try {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return invalidLabel;
    return parsed.toLocaleString();
  } catch {
    return invalidLabel;
  }
}

// ---------------------------------------------------------------------------
// Profile label helper
// ---------------------------------------------------------------------------

/**
 * Compose a single-line "name (vN)" label from the persisted row's
 * profile snapshot. Returns "—" when no profile name was captured.
 */
export function formatProfileLabel(
  record: PersistedExportRunRead | null,
): string {
  if (!record) return "—";
  const name = record.export_profile_name;
  if (!name) return "—";
  if (record.export_profile_version != null) {
    return `${name} (v${record.export_profile_version})`;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Phase 5D — Safe technical-snapshot rendering
// ---------------------------------------------------------------------------

/**
 * Soft cap on the rendered JSON string length. Snapshots over
 * this size are truncated and the truncation note is appended so
 * a malicious / runaway payload can't blow up the modal.
 */
export const SNAPSHOT_RENDER_MAX_CHARS = 20_000;

/** Result discriminator for ``safeStringifySnapshot``. */
export type SafeSnapshotRender =
  | {
      kind: "missing";
      text: string;
    }
  | {
      kind: "ok";
      text: string;
      truncated: false;
    }
  | {
      kind: "truncated";
      text: string;
      truncated: true;
      originalLength: number;
    }
  | {
      kind: "error";
      text: string;
      error: string;
    };

/**
 * Phase 5D — Pretty-print a JSONB-shaped value for the
 * "Technical snapshot" `<details>` panel safely.
 *
 *   * ``null`` / ``undefined`` / non-object input -> ``kind: "missing"``
 *     with the supplied empty-state text.
 *   * Successful stringify within ``SNAPSHOT_RENDER_MAX_CHARS`` ->
 *     ``kind: "ok"``.
 *   * Successful stringify that exceeds the cap -> ``kind: "truncated"``
 *     with the truncation note appended.
 *   * ``JSON.stringify`` throws (circular ref, BigInt, etc.) ->
 *     ``kind: "error"`` with a single-line operator message.
 *
 * NEVER throws. NEVER returns ``"undefined"`` literal text. The
 * panel renders ``text`` verbatim inside a `<pre>` block — no
 * dangerouslySetInnerHTML, no link parsing, no JSON-value action
 * synthesis.
 */
export function safeStringifySnapshot(
  payload: unknown,
  options?: {
    /** Override the empty-state copy. Defaults to "No snapshot
     *  available." */
    emptyLabel?: string;
    /** Override the size cap. Defaults to ``SNAPSHOT_RENDER_MAX_CHARS``. */
    maxChars?: number;
  },
): SafeSnapshotRender {
  const emptyLabel =
    options?.emptyLabel ?? "No snapshot available.";
  const maxChars = options?.maxChars ?? SNAPSHOT_RENDER_MAX_CHARS;
  if (
    payload === null ||
    payload === undefined ||
    typeof payload !== "object"
  ) {
    return { kind: "missing", text: emptyLabel };
  }
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2);
  } catch (err) {
    return {
      kind: "error",
      text: "Could not render snapshot safely.",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (typeof text !== "string") {
    // ``JSON.stringify`` returns ``undefined`` for some inputs
    // (e.g. a function) — defensively guard so the panel never
    // shows the literal string "undefined".
    return { kind: "missing", text: emptyLabel };
  }
  if (text.length > maxChars) {
    return {
      kind: "truncated",
      text:
        text.slice(0, maxChars) +
        "\n…truncated for display (snapshot exceeds " +
        `${maxChars.toLocaleString()} characters).`,
      truncated: true,
      originalLength: text.length,
    };
  }
  return { kind: "ok", text, truncated: false };
}

// ---------------------------------------------------------------------------
// Phase 5D — Notes value normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a notes textarea value for comparison + persistence.
 *
 *   * Trims surrounding whitespace.
 *   * Treats whitespace-only / empty input as ``null`` so the
 *     wire field is honest about "no notes".
 *   * Returns the trimmed string otherwise.
 *
 * Used by the detail panel to:
 *
 *   * Detect whether the operator's edit is structurally
 *     different from the persisted notes (so the Save button can
 *     stay disabled when nothing changed).
 *   * Compute the value to send on PATCH so a user pasting "   "
 *     doesn't persist whitespace as the new notes string.
 */
export function normalizeNotes(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Compare two normalised notes values (post-``normalizeNotes``).
 * Pure / synchronous. Returns ``true`` when the two represent
 * the same operator-visible state.
 */
export function notesEqual(
  a: string | null,
  b: string | null,
): boolean {
  if (a === null && b === null) return true;
  return a === b;
}

/**
 * Phase 5D — character cap for the notes textarea. Mirrors the
 * panel's pre-existing ``maxLength={2000}`` so the helper that
 * reasons about "approaching the cap" stays in sync with the
 * UI control.
 */
export const NOTES_MAX_CHARS = 2000;

/**
 * TRUE when the notes draft is within ``warningThreshold`` chars
 * of the cap. Used by the panel to render a small character-count
 * indicator only when it matters.
 */
export function notesNearCap(
  value: string,
  warningThreshold: number = 200,
): boolean {
  if (typeof value !== "string") return false;
  return value.length >= NOTES_MAX_CHARS - warningThreshold;
}

// ---------------------------------------------------------------------------
// Phase 6B — Approval workflow display helpers
// ---------------------------------------------------------------------------

/**
 * Operator-friendly approval status labels. Mirrors the closed
 * ``PersistedExportRunApprovalStatus`` vocabulary from the Phase
 * 6A backend schema. ``approved_for_file_generation`` is rendered
 * verbatim because the backend uses the term — but the panel
 * pairs it with a "No file has been generated yet." disclaimer
 * everywhere it surfaces.
 */
export const EXPORT_RUN_APPROVAL_STATUS_LABEL: Record<string, string> = {
  not_requested: "Not requested",
  pending_review: "Pending review",
  approved_for_file_generation: "Approved for file generation",
  rejected: "Rejected",
};

/**
 * Operator-facing approval label. Phase 5D-style fallback —
 * unknown values render as ``"Unknown (<raw>)"`` so the operator
 * can never misread a future literal as one of the known states.
 * Empty / null fall back to ``"Unknown"``.
 */
export function getApprovalStatusLabel(
  status: PersistedExportRunApprovalStatus | string | null | undefined,
): string {
  if (typeof status !== "string" || status.trim().length === 0) {
    return "Unknown";
  }
  if (EXPORT_RUN_APPROVAL_STATUS_LABEL[status]) {
    return EXPORT_RUN_APPROVAL_STATUS_LABEL[status]!;
  }
  return `Unknown (${status})`;
}

/**
 * Visual tone tokens for the approval-status badge. Reuses the
 * same shape as ``ExportRunStatusTone`` so callers can render
 * either status with the same code path.
 *
 *   * ``not_requested`` → neutral gray (no action taken yet).
 *   * ``pending_review`` → amber (awaiting attention).
 *   * ``approved_for_file_generation`` → cyan/blue (NEVER green —
 *     green would imply "ready to export"; the boundary panel +
 *     Operational Preview surface use the same convention).
 *   * ``rejected`` → rose (action item / blocker).
 *   * unknown / null → neutral gray (forward-compat).
 */
const _APPROVAL_TONE_BY_VALUE: Record<string, ExportRunStatusTone> = {
  not_requested: {
    border: "border-gray-200 dark:border-line",
    bg: "bg-gray-50 dark:bg-surface-muted/60",
    text: "text-gray-700 dark:text-ink-muted",
    tone: "neutral",
  },
  pending_review: {
    border: "border-yellow-200 dark:border-yellow-900",
    bg: "bg-yellow-50 dark:bg-yellow-950/30",
    text: "text-yellow-800 dark:text-yellow-200",
    tone: "amber",
  },
  approved_for_file_generation: {
    border: "border-cyan-200 dark:border-cyan-900",
    bg: "bg-cyan-50 dark:bg-cyan-950/40",
    text: "text-cyan-800 dark:text-cyan-200",
    tone: "cyan",
  },
  rejected: {
    border: "border-rose-200 dark:border-rose-900",
    bg: "bg-rose-50 dark:bg-rose-950/30",
    text: "text-rose-800 dark:text-rose-200",
    tone: "rose",
  },
};

const _APPROVAL_NEUTRAL_TONE: ExportRunStatusTone = {
  border: "border-gray-200 dark:border-line",
  bg: "bg-gray-50 dark:bg-surface-muted/60",
  text: "text-gray-700 dark:text-ink-muted",
  tone: "neutral",
};

export function getApprovalStatusTone(
  status: PersistedExportRunApprovalStatus | string | null | undefined,
): ExportRunStatusTone {
  if (typeof status !== "string" || status.trim().length === 0) {
    return _APPROVAL_NEUTRAL_TONE;
  }
  return _APPROVAL_TONE_BY_VALUE[status] ?? _APPROVAL_NEUTRAL_TONE;
}

/**
 * Operator-friendly description that ALWAYS pairs the approval
 * status with the no-export disclaimer. The detail panel renders
 * the description below the badge so a paste-into-Slack reader
 * can never misread an "Approved for file generation" pill as
 * proof of export.
 *
 * Returns the empty string when the status is null / unknown so
 * the panel can branch on truthiness without rendering an empty
 * paragraph.
 */
export function getApprovalStatusDescription(
  status: PersistedExportRunApprovalStatus | string | null | undefined,
): string {
  if (typeof status !== "string") return "";
  switch (status) {
    case "not_requested":
      return (
        "No reviewer attention has been requested for this audit " +
        "record yet."
      );
    case "pending_review":
      return (
        "A reviewer has been asked to look at this audit record. " +
        "No file has been generated and no export has been finalized."
      );
    case "approved_for_file_generation":
      return (
        "Approved as a workflow gate only. No file has been " +
        "generated yet. No export has been finalized. Production " +
        "export remains unavailable."
      );
    case "rejected":
      return (
        "A reviewer rejected the most recent approval request. " +
        "Address the rejection reason below and request approval " +
        "again."
      );
    default:
      return "";
  }
}

/**
 * Small enum the detail panel uses to gate the workflow controls
 * it renders. Pure projection of the Phase 6A transition rules:
 *
 *   * ``request`` — Request approval button enabled.
 *     ``not_requested`` and ``rejected`` source states.
 *   * ``approve_or_reject`` — Approve + Reject buttons enabled
 *     (Approve additionally gated on ``status === "draft_clear"``).
 *     ``pending_review`` source state.
 *   * ``terminal`` — No transition button. Terminal-for-this-phase
 *     ``approved_for_file_generation`` state.
 *   * ``unknown`` — Forward-compat fallback. No buttons rendered.
 */
export type ExportRunApprovalControlsMode =
  | "request"
  | "approve_or_reject"
  | "terminal"
  | "unknown";

export function getApprovalControlsMode(
  status: PersistedExportRunApprovalStatus | string | null | undefined,
): ExportRunApprovalControlsMode {
  if (status === "not_requested" || status === "rejected") {
    return "request";
  }
  if (status === "pending_review") {
    return "approve_or_reject";
  }
  if (status === "approved_for_file_generation") {
    return "terminal";
  }
  return "unknown";
}

/**
 * Phase 6B — character cap for the rejection reason / approval
 * notes textareas. Mirrors ``NOTES_MAX_CHARS`` (Phase 5D) so the
 * approval inputs cap consistently.
 */
export const APPROVAL_NOTES_MAX_CHARS = NOTES_MAX_CHARS;
export const REJECTION_REASON_MAX_CHARS = NOTES_MAX_CHARS;
