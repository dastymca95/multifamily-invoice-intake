/**
 * Phase 3J — Frontend mirror of the Phase 3I backend export profile
 * validation contract (``backend/app/schemas/export_profile.py``).
 *
 * The endpoint:
 *
 *   POST /api/v1/export-profiles/validate-preview
 *
 * accepts the operator-selected profile + a normalised export-style
 * preview payload + optional context, and returns a deterministic
 * validation result with status / summary / issues / row + column
 * results. Diagnostic only — the response always carries
 * ``diagnostic_only=true``.
 *
 * Why a dedicated ``Backend*`` namespace instead of reusing the
 * Phase 3F local types (``ExportProfileValidationResult``):
 *
 *   * The two contracts are CLOSE but not identical. The backend
 *     adds ``total_issues`` / ``column_count`` / ``row_count`` /
 *     ``matched_column_count`` / ``unmatched_column_count`` to the
 *     summary; the local validator never carried those.
 *   * Keeping them distinct prevents accidental wiring where a
 *     backend-only field is consumed without a fallback for the
 *     local result.
 *   * A small adapter (`backendValidationToLocalShape`) bridges
 *     the two so the existing UI components stay untouched.
 *
 * Forward-compat: status / severity / target_system / issue codes
 * are the obvious literal sets but widened to plain ``string`` so a
 * future backend extension renders gracefully without crashing.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type BackendExportProfileValidationStatus =
  | "clear"
  | "needs_review"
  | "blocked"
  | "conflict"
  // Forward-compat: gracefully accept future literals.
  | (string & {});

export type BackendExportProfileIssueSeverity =
  | "blocked"
  | "warning"
  | "info"
  | "clear"
  | (string & {});

export type BackendExportProfileIssueCode =
  | "PROFILE_REQUIRED_COLUMN_MISSING"
  | "PROFILE_REQUIRED_VALUE_MISSING"
  | "PROFILE_CELL_BLOCKED"
  | "PROFILE_CELL_CONFLICT"
  | "PROFILE_CELL_NEEDS_REVIEW"
  | "PROFILE_DATE_FORMAT_CHECK_FAILED"
  | "PROFILE_AMOUNT_FORMAT_CHECK_FAILED"
  | "PROFILE_ALLOWED_VALUE_FAILED"
  | "PROFILE_MAX_LENGTH_EXCEEDED"
  | "PROFILE_COLUMN_UNMAPPED"
  | "PROFILE_PREVIEW_HAS_NO_ROWS"
  | (string & {});

export type BackendExportTargetSystem =
  | "resman"
  | "yardi"
  | "appfolio"
  | "custom_csv"
  | (string & {});

// ---------------------------------------------------------------------------
// Request payload (backend-shaped; built by the adapter)
// ---------------------------------------------------------------------------

/**
 * Profile shape sent on the wire — keep loose so we don't have to
 * keep this in lock-step with the local Phase 3F ``ExportProfile``
 * if that adds optional fields. The adapter narrows correctness; the
 * backend re-validates with Pydantic anyway.
 */
export interface BackendExportProfileColumnPayload {
  key: string;
  label: string;
  output_header: string;
  order: number;
  required: boolean;
  source_column_key?: string | null;
  source_column_label?: string | null;
  data_type: string;
  max_length?: number | null;
  allowed_values?: string[] | null;
  default_value?: string | number | boolean | null;
  trim?: boolean;
  match_aliases?: string[];
  format?: string | null;
}

export interface BackendExportProfileSettingsPayload {
  delimiter?: string;
  include_header?: boolean;
  quote_strategy?: string;
  newline?: string;
  encoding?: string;
  date_format?: string;
  amount_format?: string;
  boolean_format?: string | null;
  empty_value_policy?: string;
  file_naming_preview?: string | null;
}

export interface BackendExportProfilePayload {
  id: string;
  name: string;
  target_system: BackendExportTargetSystem;
  description?: string | null;
  settings: BackendExportProfileSettingsPayload;
  columns: BackendExportProfileColumnPayload[];
  diagnostic_only?: boolean;
}

export interface BackendExportPreviewColumnPayload {
  key: string;
  label: string;
  required?: boolean;
  has_issues?: boolean;
  issue_count?: number;
}

export interface BackendExportPreviewCellPayload {
  column_key: string;
  column_label?: string | null;
  /** Preserves 0 / false / null. Adapter never elides falsy values. */
  value?: unknown;
  display_value?: string | null;
  status: string;
  source?: string | null;
  issues?: unknown[];
  issue_count?: number;
}

export interface BackendExportPreviewRowPayload {
  row_index: number;
  status: string;
  cells: BackendExportPreviewCellPayload[];
  issue_count?: number;
}

export interface BackendExportPreviewPayload {
  columns: BackendExportPreviewColumnPayload[];
  rows: BackendExportPreviewRowPayload[];
}

export interface BackendExportProfileValidationContext {
  template_id?: string | null;
  template_name?: string | null;
  pattern_id?: string | null;
  pattern_name?: string | null;
  document_id?: string | null;
  batch_id?: string | null;
}

export interface BackendExportProfileValidationRequest {
  profile: BackendExportProfilePayload;
  preview: BackendExportPreviewPayload;
  context?: BackendExportProfileValidationContext | null;
  /** Hard-True client-side; backend is hard-True regardless. */
  diagnostic_only?: boolean;
}

// ---------------------------------------------------------------------------
// Response payload
// ---------------------------------------------------------------------------

export interface BackendExportProfileValidationIssue {
  severity: BackendExportProfileIssueSeverity;
  code: BackendExportProfileIssueCode;
  message: string;
  recommendation: string;
  row_index?: number | null;
  column_key?: string | null;
  profile_column_key?: string | null;
  source_column_key?: string | null;
}

export interface BackendExportProfileValidationColumnResult {
  profile_column_key: string;
  profile_column_label: string;
  matched: boolean;
  matched_preview_column_key?: string | null;
  matched_preview_column_label?: string | null;
  required: boolean;
  issue_count: number;
  worst_severity: BackendExportProfileIssueSeverity;
}

export interface BackendExportProfileValidationRowResult {
  row_index: number;
  issue_count: number;
  worst_severity: BackendExportProfileIssueSeverity;
}

export interface BackendExportProfileValidationSummary {
  total_issues: number;
  blocked_count: number;
  warning_count: number;
  info_count: number;
  row_count: number;
  column_count: number;
  matched_column_count: number;
  unmatched_column_count: number;
  rows_with_issues: number;
  blocked_rows: number;
}

export interface BackendExportProfileValidationResult {
  diagnostic_only: boolean;
  profile_id: string;
  profile_name: string;
  target_system: BackendExportTargetSystem;
  status: BackendExportProfileValidationStatus;
  summary: BackendExportProfileValidationSummary;
  issues: BackendExportProfileValidationIssue[];
  column_results: BackendExportProfileValidationColumnResult[];
  row_results: BackendExportProfileValidationRowResult[];
  context?: BackendExportProfileValidationContext | null;
}
