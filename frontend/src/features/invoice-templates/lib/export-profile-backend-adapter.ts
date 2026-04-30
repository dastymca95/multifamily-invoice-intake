/**
 * Phase 3J — Frontend ↔ backend export profile validation adapter.
 *
 * Bridges the Phase 3F local types and the Phase 3I backend
 * contract:
 *
 *   * ``buildBackendExportProfileValidationRequest`` — projects a
 *     local ``ExportProfile`` + ``OperationalExportPreview`` (+
 *     optional ``OperationalResolutionResult`` for context) into the
 *     backend's request payload. Preserves 0 / false / null and
 *     never elides cells.
 *   * ``backendValidationToLocalShape`` — projects the backend
 *     response back into the local ``ExportProfileValidationResult``
 *     shape so the existing Phase 3F UI + report helpers keep
 *     rendering without rewrites.
 *   * ``BACKEND_VALIDATION_SOURCE_LABEL`` + helpers — operator-facing
 *     copy for the Backend verified / Local estimate banner.
 *
 * Design rules:
 *   * Pure / synchronous — no React, no DOM, no fetch.
 *   * Never mutates the input ``profile`` / ``preview`` / ``result``.
 *   * Diagnostic only — every helper carries the contract forward
 *     ("no export file is generated").
 */

import type { OperationalResolutionResult } from "@/types/operational-resolution";
import type {
  BackendExportPreviewCellPayload,
  BackendExportPreviewColumnPayload,
  BackendExportPreviewPayload,
  BackendExportPreviewRowPayload,
  BackendExportProfileColumnPayload,
  BackendExportProfilePayload,
  BackendExportProfileSettingsPayload,
  BackendExportProfileValidationContext,
  BackendExportProfileValidationIssue,
  BackendExportProfileValidationRequest,
  BackendExportProfileValidationResult,
} from "@/types/export-profile-validation";

import type {
  ExportProfile,
  ExportProfileColumn,
  ExportProfileSettings,
} from "./export-profile-contract";
import type {
  OperationalExportPreview,
  OperationalExportPreviewCell,
  OperationalExportPreviewColumn,
  OperationalExportPreviewRow,
} from "./operational-export-preview";
import type {
  ExportProfileColumnResult,
  ExportProfileIssue,
  ExportProfileIssueSeverity,
  ExportProfileRowResult,
  ExportProfileValidationResult,
  ExportProfileValidationStatus,
  ExportProfileValidationSummary,
} from "./export-profile-validation";

// ---------------------------------------------------------------------------
// Public — request builder
// ---------------------------------------------------------------------------

export interface BuildBackendExportProfileValidationRequestArgs {
  profile: ExportProfile;
  preview: OperationalExportPreview;
  /** When provided, the result's identifiers are projected into the
   *  backend ``context`` block so the response can be paste-shared
   *  with full provenance. */
  result?: OperationalResolutionResult | null;
  /** Optional one-line label from the launch surface; surfaced in
   *  the UI banner + Markdown reports, NOT sent on the wire (the
   *  backend context block carries the structured ids). */
  contextLabel?: string | null;
}

/**
 * Build the backend ``validate-preview`` request payload.
 *
 * Pure — never mutates the inputs. Preserves falsy values verbatim
 * (0 / false / null) so the backend's "0 and false are not missing"
 * rule keeps working through the wire.
 */
export function buildBackendExportProfileValidationRequest(
  args: BuildBackendExportProfileValidationRequestArgs,
): BackendExportProfileValidationRequest {
  const { profile, preview, result } = args;
  return {
    profile: _profilePayload(profile),
    preview: _previewPayload(preview),
    context: result ? _contextFromResult(result) : null,
    diagnostic_only: true,
  };
}

// ---------------------------------------------------------------------------
// Public — response adapter (backend → local UI shape)
// ---------------------------------------------------------------------------

/**
 * Project the backend validation response into the existing local
 * ``ExportProfileValidationResult`` shape so the Phase 3F UI
 * components + Markdown report helpers keep working without
 * rewrites.
 *
 * Backend has a few summary fields the local shape doesn't carry
 * (``total_issues`` / ``column_count`` / ``row_count``); they are
 * dropped here. Local also doesn't model ``context`` — surfaced
 * via the panel banner instead.
 */
export function backendValidationToLocalShape(
  backend: BackendExportProfileValidationResult,
  profile: ExportProfile,
): ExportProfileValidationResult {
  const issues: ExportProfileIssue[] = backend.issues.map(_toLocalIssue);
  const columnResults: ExportProfileColumnResult[] = backend.column_results.map(
    (c) => ({
      profile_column_key: c.profile_column_key,
      profile_column_label: c.profile_column_label,
      matched: c.matched,
      matched_preview_column_key: c.matched_preview_column_key ?? null,
      matched_preview_column_label: c.matched_preview_column_label ?? null,
      required: c.required,
      issue_count: c.issue_count,
      worst_severity: _toLocalSeverity(c.worst_severity),
    }),
  );
  const rowResults: ExportProfileRowResult[] = backend.row_results.map((r) => ({
    row_index: r.row_index,
    issue_count: r.issue_count,
    worst_severity: _toLocalSeverity(r.worst_severity),
  }));

  const summary: ExportProfileValidationSummary = {
    blocked_count: backend.summary.blocked_count,
    warning_count: backend.summary.warning_count,
    info_count: backend.summary.info_count,
    matched_columns: backend.summary.matched_column_count,
    unmapped_columns: backend.summary.unmatched_column_count,
    rows_with_issues: backend.summary.rows_with_issues,
    rows_blocked: backend.summary.blocked_rows,
  };

  return {
    status: _toLocalStatus(backend.status),
    profile_id: backend.profile_id,
    profile_name: backend.profile_name,
    target_system: profile.target_system,
    summary,
    issues,
    column_results: columnResults,
    row_results: rowResults,
  };
}

// ---------------------------------------------------------------------------
// Public — UI source labels
// ---------------------------------------------------------------------------

export type ExportProfileValidationSource =
  | "backend"
  | "local"
  | "loading"
  | "unavailable";

export interface ExportProfileValidationSourceCopy {
  /** One-line headline for the banner. */
  title: string;
  /** Operator-facing detail line. */
  detail: string;
  /** Tone bucket — drives the banner colour in the panel. */
  tone: "success" | "info" | "warning" | "neutral";
}

/**
 * Operator-facing copy for the source banner. Plain phrasing — no
 * "production validated" / "ready to export" language. The detail
 * lines stay consistent with the rest of the panel's
 * "diagnostic only — no export file is generated" tone.
 */
export const BACKEND_VALIDATION_SOURCE_COPY: Record<
  ExportProfileValidationSource,
  ExportProfileValidationSourceCopy
> = {
  backend: {
    title: "Backend verified",
    detail:
      "Rivera backend checked this profile against the preview rows. " +
      "Diagnostic only — no export file was generated.",
    tone: "success",
  },
  loading: {
    title: "Checking backend profile validation…",
    detail: "Showing local estimate while backend verifies.",
    tone: "info",
  },
  local: {
    title: "Local estimate only",
    detail:
      "Backend profile check failed. Showing local estimate. " +
      "This check has not been verified by the backend.",
    tone: "warning",
  },
  unavailable: {
    title: "Local estimate only",
    detail: "This check has not been verified by the backend.",
    tone: "neutral",
  },
};

/**
 * Single-line source marker for Markdown reports. Keeps the report
 * honest about whether the included verdict is backend-verified or
 * the frontend's local estimate.
 */
export function backendValidationSourceMarker(
  source: ExportProfileValidationSource,
): string {
  switch (source) {
    case "backend":
      return "Validation source: Backend verified (Rivera diagnostic endpoint).";
    case "loading":
      return "Validation source: Local estimate (backend verification in flight).";
    case "local":
      return "Validation source: Local estimate (backend check failed).";
    case "unavailable":
      return "Validation source: Local estimate (backend not consulted).";
  }
}

// ---------------------------------------------------------------------------
// Internals — request projection
// ---------------------------------------------------------------------------

function _profilePayload(profile: ExportProfile): BackendExportProfilePayload {
  return {
    id: profile.id,
    name: profile.name,
    target_system: profile.target_system,
    description: profile.description ?? null,
    settings: _settingsPayload(profile.settings),
    columns: profile.columns.map(_columnPayload),
    diagnostic_only: true,
  };
}

function _settingsPayload(
  s: ExportProfileSettings,
): BackendExportProfileSettingsPayload {
  return {
    delimiter: s.delimiter,
    include_header: s.include_header,
    quote_strategy: s.quote_strategy,
    newline: s.newline,
    encoding: s.encoding,
    date_format: s.date_format,
    amount_format: s.amount_format,
    boolean_format: s.boolean_format ?? null,
    empty_value_policy: s.empty_value_policy,
    file_naming_preview: s.file_naming_preview ?? null,
  };
}

function _columnPayload(c: ExportProfileColumn): BackendExportProfileColumnPayload {
  return {
    key: c.key,
    label: c.label,
    output_header: c.output_header,
    order: c.order,
    required: c.required,
    source_column_key: c.source_column_key ?? null,
    source_column_label: c.source_column_label ?? null,
    data_type: c.data_type,
    max_length: c.max_length ?? null,
    allowed_values: c.allowed_values ?? null,
    default_value: c.default_value ?? null,
    // Frontend has a 3-value trim ("none" | "trim" | "trim_collapse");
    // backend models ``trim`` as a boolean. Anything other than "none"
    // means "trim ON". Profile-level trim semantics still drive the
    // future production exporter — this flag is purely informational
    // for the validator today.
    trim: c.trim !== "none",
    match_aliases: c.match_aliases ?? [],
    format: c.format ?? null,
  };
}

function _previewPayload(
  preview: OperationalExportPreview,
): BackendExportPreviewPayload {
  return {
    columns: preview.columns.map(_previewColumnPayload),
    rows: preview.rows.map(_previewRowPayload),
  };
}

function _previewColumnPayload(
  col: OperationalExportPreviewColumn,
): BackendExportPreviewColumnPayload {
  return {
    key: col.key,
    label: col.label,
    // Local preview columns don't carry ``required``; backend
    // tolerates the default. Issue counts let the backend echo the
    // correct ``has_issues`` if it wanted to (it currently doesn't).
    has_issues: col.has_issues,
    issue_count: col.issue_count,
  };
}

function _previewRowPayload(
  row: OperationalExportPreviewRow,
): BackendExportPreviewRowPayload {
  return {
    row_index: row.row_index,
    status: row.status,
    cells: row.cells.map(_previewCellPayload),
    issue_count: row.issue_count,
  };
}

function _previewCellPayload(
  cell: OperationalExportPreviewCell,
): BackendExportPreviewCellPayload {
  return {
    column_key: cell.column_key,
    column_label: cell.column_label,
    // Preserve 0 / false / null verbatim — the backend rule
    // "0 and false are NOT missing" depends on the wire shape
    // carrying them through unchanged.
    value: cell.value,
    display_value: cell.display_value,
    status: cell.status,
    source: cell.source,
    issues: cell.issues,
    issue_count: cell.issue_count,
  };
}

function _contextFromResult(
  result: OperationalResolutionResult,
): BackendExportProfileValidationContext {
  return {
    template_id: result.template_id ?? null,
    template_name: result.template_name ?? null,
    pattern_id: result.pattern_id ?? null,
    pattern_name: result.pattern_name ?? null,
    document_id: result.document_id ?? null,
    batch_id: result.batch_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Internals — response narrowing
// ---------------------------------------------------------------------------

function _toLocalSeverity(value: string): ExportProfileIssueSeverity {
  if (
    value === "blocked" ||
    value === "warning" ||
    value === "info" ||
    value === "clear"
  ) {
    return value;
  }
  // Unknown / forward-compat — degrade to warning (mirrors the
  // backend's own ``normalize_profile_issue_severity`` policy so
  // the panel never sees a literal it can't render).
  return "warning";
}

function _toLocalStatus(value: string): ExportProfileValidationStatus {
  if (
    value === "clear" ||
    value === "needs_review" ||
    value === "blocked" ||
    value === "conflict"
  ) {
    return value;
  }
  // Forward-compat — anything novel maps to ``needs_review`` so the
  // operator sees a non-clear pill rather than a crash.
  return "needs_review";
}

function _toLocalIssue(
  i: BackendExportProfileValidationIssue,
): ExportProfileIssue {
  return {
    severity: _toLocalSeverity(i.severity),
    // Local issue ``code`` is a closed Literal mirror of the backend's
    // codes; cast through ``string`` keeps forward-compat issue codes
    // visible without crashing the UI.
    code: i.code as ExportProfileIssue["code"],
    message: i.message,
    recommendation: i.recommendation,
    row_index: i.row_index ?? null,
    column_key: i.column_key ?? null,
    profile_column_key: i.profile_column_key ?? null,
    source_column_key: i.source_column_key ?? null,
  };
}
