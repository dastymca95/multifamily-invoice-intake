/**
 * Phase 4G — Frontend mirror of the Phase 4F backend Export Run
 * Draft contract (``backend/app/schemas/export_run_draft.py``).
 *
 * The endpoint:
 *
 *   POST /api/v1/export-run-drafts/evaluate
 *
 * accepts a small diagnostic-state snapshot and returns a draft
 * verdict that is hard-pinned ``draft_only=true`` /
 * ``finalized=false`` / ``file_generated=false`` /
 * ``download_available=false`` / ``production_export_ready=false``.
 * The Pydantic ``Literal`` types on the backend make those flags
 * impossible to widen — the frontend mirror keeps the same intent
 * at the type layer.
 *
 * Why a dedicated ``Backend*`` namespace:
 *   * Keeps the type sharp on the wire (closed enums for status
 *     and the architectural reasons).
 *   * Forward-compat: status / source / reason codes are widened
 *     to plain ``string`` so a future backend extension renders
 *     gracefully.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type BackendExportRunDraftStatus =
  | "blocked"
  | "needs_review"
  | "draft_clear"
  | "not_available"
  // Forward-compat — gracefully accept future literals.
  | (string & {});

export type BackendExportRunDraftReason =
  | "diagnostic_only_pipeline"
  | "no_export_engine"
  | "no_file_generation"
  | "no_export_run_persistence"
  | "no_final_approval"
  | "no_export_audit_trail"
  | "no_external_posting"
  | "readiness_boundary_not_clear"
  | "profile_not_persisted"
  | "profile_validation_blocked"
  | "profile_validation_needs_review"
  | "no_rows_to_export"
  | "row_issues_present"
  | (string & {});

export type BackendExportRunDraftProfileSource =
  | "saved"
  | "built_in"
  | "inline"
  | "unknown"
  | (string & {});

// ---------------------------------------------------------------------------
// Request envelope
// ---------------------------------------------------------------------------

/**
 * Caller-supplied snapshot of the diagnostic state the draft
 * contract reasons over. Every field is optional so callers can
 * evaluate the draft from partial state.
 *
 * NOTE: the IDs here are purely informational. The backend does
 * NOT load anything from them. They are echoed back inside
 * ``ExportRunDraft.context`` so a paste-into-Slack workflow keeps
 * provenance.
 */
export interface BackendExportRunDraftInput {
  operational_result_id?: string | null;
  template_id?: string | null;
  document_id?: string | null;
  batch_id?: string | null;
  selected_profile_id?: string | null;
  selected_profile_source?: BackendExportRunDraftProfileSource | null;
  profile_validation_status?: string | null;
  readiness_diagnostic_status?: string | null;
  /** Caller's claim about production-export readiness. The backend
   *  IGNORES the value when computing the response; the response
   *  field stays ``Literal[False]``. Captured under ``context`` for
   *  audit visibility. */
  production_export_ready?: boolean;
  export_preview_row_count?: number;
  export_preview_issue_count?: number;
  blocked_row_count?: number;
  warning_row_count?: number;
  context?: Record<string, unknown> | null;
}

export interface BackendExportRunDraftRequest {
  input: BackendExportRunDraftInput;
}

// ---------------------------------------------------------------------------
// Response payload
// ---------------------------------------------------------------------------

export interface BackendExportRunDraftResult {
  /** Hard-pinned ``true`` on the backend — Pydantic ``Literal[True]``
   *  makes this impossible to widen. */
  draft_only: true;
  /** Hard-pinned ``false`` — same reason. */
  finalized: false;
  /** Hard-pinned ``false`` — same reason. */
  file_generated: false;
  /** Hard-pinned ``false`` — same reason. */
  download_available: false;
  /** Hard-pinned ``false`` — same reason. The caller's
   *  ``input.production_export_ready`` claim does NOT flip this. */
  production_export_ready: false;

  status: BackendExportRunDraftStatus;
  reasons: BackendExportRunDraftReason[];

  selected_profile_id?: string | null;
  selected_profile_source?: BackendExportRunDraftProfileSource | null;

  row_count: number;
  blocked_row_count: number;
  warning_row_count: number;

  operator_title: string;
  operator_message: string;
  developer_message: string;
  next_steps: string[];
  disclaimers: string[];

  /** Caller-supplied IDs / labels echoed back so a paste-into-Slack
   *  workflow keeps provenance without re-querying. May include
   *  ``input_production_export_ready_claim`` when the caller sent
   *  ``true`` — the backend captures the discrepancy here. */
  context?: Record<string, unknown> | null;
}
