/**
 * Phase 3N — Frontend mirror of the Phase 3M backend export
 * readiness boundary contract
 * (``backend/app/schemas/export_readiness_boundary.py``).
 *
 * The endpoint:
 *
 *   POST /api/v1/export-readiness-boundary/evaluate
 *
 * accepts a small diagnostic-state snapshot and returns a boundary
 * verdict that is hard-pinned ``production_export_ready=false`` and
 * ``diagnostic_only=true``. The Pydantic ``Literal`` types on the
 * backend make those flags impossible to widen — the frontend
 * mirror keeps the same intent at the type level.
 *
 * Why a dedicated ``Backend*`` namespace instead of reusing the
 * Phase 3L local helper types (``ExportReadinessBoundary``):
 *
 *   * Two contracts are CLOSE but not identical. Backend reasons
 *     are forward-compat strings; the local helper closes the
 *     literal set today.
 *   * Keeping them distinct prevents accidental wiring where a
 *     backend-only field flows in without a fallback for the
 *     local result.
 *   * A small adapter (``backendBoundaryToLocalShape``) bridges
 *     the two so the existing UI components + Markdown report
 *     helpers stay untouched.
 *
 * Forward-compat: status / target system / reason codes are the
 * obvious literal sets but widened to plain ``string`` so a
 * future backend extension renders gracefully without crashing
 * the panel.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type BackendExportDiagnosticStatus =
  | "blocked"
  | "needs_review"
  | "clear"
  | "not_available"
  // Forward-compat — gracefully accept a future literal.
  | (string & {});

export type BackendProductionExportStatus =
  | "unavailable"
  | "not_configured"
  | "not_authorized"
  // Backend Literal does NOT include "ready" today, but we keep
  // the type widened for forward-compat. The adapter MUST refuse
  // to surface "ready" through the local-shape conversion in this
  // phase regardless.
  | (string & {});

export type BackendExportReadinessBoundaryReason =
  | "diagnostic_only_pipeline"
  | "no_export_engine"
  | "no_export_profile_persistence"
  | "no_export_batch_model"
  | "no_file_generation"
  | "no_final_approval_workflow"
  | "no_export_audit_trail"
  | "no_external_posting"
  | (string & {});

// ---------------------------------------------------------------------------
// Request envelope
// ---------------------------------------------------------------------------

/**
 * Caller-supplied snapshot of the current diagnostic state. Every
 * field is optional so the endpoint can return ``not_available``
 * without any persisted records being involved.
 */
export interface BackendExportReadinessBoundaryInput {
  operational_status?: string | null;
  profile_validation_status?: string | null;
  parity_status?: string | null;
  validation_source?: string | null;
  has_result?: boolean;
  has_preview_rows?: boolean;
  has_persisted_profile?: boolean;
}

export interface BackendExportReadinessBoundaryRequest {
  input: BackendExportReadinessBoundaryInput;
}

// ---------------------------------------------------------------------------
// Response payload
// ---------------------------------------------------------------------------

export interface BackendExportReadinessBoundaryResult {
  diagnostic_status: BackendExportDiagnosticStatus;
  production_export_status: BackendProductionExportStatus;
  /** Hard-pinned ``false`` on the backend — the Pydantic
   *  ``Literal[False]`` makes this impossible to widen. We mirror
   *  the same literal here so a downstream consumer can't reassign
   *  it to ``true`` either. */
  production_export_ready: false;
  /** Hard-pinned ``true`` on the backend — same reason. */
  diagnostic_only: true;
  reasons: BackendExportReadinessBoundaryReason[];
  operator_title: string;
  operator_message: string;
  developer_message: string;
  next_steps: string[];
  disclaimers: string[];
}
