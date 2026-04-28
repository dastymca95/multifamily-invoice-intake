/**
 * Frontend mirror of the Phase 3A backend operational-resolution
 * contract (``backend/app/schemas/operational_resolution.py``).
 *
 * The endpoint:
 *
 *   POST /api/v1/operational-resolution/run
 *
 * runs the same dry-run resolver Phase 2B uses, but in a
 * "production-shaped" envelope that carries the operational ids
 * (document_id / batch_id) Phase 3C+ will fill in for real
 * uploaded documents. Phase 3B uses it from the diagnostic
 * Operational Preview panel so operators can rehearse the
 * production flow with operator-supplied facts before OCR/AI
 * lands.
 *
 * Reuses ``ResolverInput`` / ``ResolverResult`` from
 * ``./import-resolver`` rather than re-declaring those shapes —
 * the operational pipeline is purely a composer over already-typed
 * contracts.
 *
 * Forward-compat:
 *   * ``status`` / ``severity`` / ``fix_area`` / ``pattern_selection_mode``
 *     are typed as the obvious literal sets but widened to plain
 *     ``string`` for forward compat — a future backend literal
 *     renders gracefully without crashing the panel.
 *   * Optional fields stay optional throughout.
 */

import type {
  ExtractedFact,
  ResolverInput,
  ResolverResult,
  ResolverStatus,
} from "./import-resolver";

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/**
 * Pattern selection strategy. Today only ``"manual"`` (operator
 * picks an id) and ``"none"`` (no pattern, raw context only) are
 * honoured — string-widened for future modes (``"auto"`` /
 * ``"hint_match"`` / etc.).
 */
export type PatternSelectionMode =
  | "manual"
  | "none"
  // Forward-compat: gracefully accept future literals.
  | (string & {});

/**
 * Request payload for ``POST /operational-resolution/run``.
 *
 * Every field except ``template_id`` is optional. Posting only the
 * template id yields a baseline run that uses zero runtime context
 * (useful for "is this template ready to receive operational input"
 * checks).
 */
export interface OperationalResolutionRequest {
  template_id: string;
  pattern_id?: string | null;
  document_id?: string | null;
  batch_id?: string | null;
  /**
   * Mapping shape (``{key: value}``) OR list shape
   * (``ExtractedFact[]``). Both flow through the resolver's
   * own validators on the backend side.
   */
  extracted_facts?: Record<string, unknown> | ExtractedFact[];
  /**
   * Catalog hints keyed by kind: ``vendor`` / ``property`` / ``gl``.
   * Values may be strings (treated as ``CatalogHint(text=...)``)
   * or full dicts (``entry_id`` / ``text`` / ``field_values``).
   */
  catalog_hints?: Record<string, unknown>;
  /**
   * Caller free-form metadata. Bridge / runner / operational
   * protected keys are filtered server-side before merge so a
   * caller can never spoof provenance.
   */
  document_metadata?: Record<string, unknown>;
  /**
   * Forwarded onto ``ResolverInput.runtime_options``. Reserved for
   * Phase 2+ scenario inputs.
   */
  runtime_options?: Record<string, unknown>;
  pattern_selection_mode?: PatternSelectionMode;
  /** Hard-True on the backend; provided here for future flexibility. */
  diagnostic_only?: boolean;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** Coarse aggregate counts mirroring the resolver's own summary. */
export interface OperationalResolutionSummary {
  status: ResolverStatus | string;
  row_count: number;
  ready_rows: number;
  needs_review_rows: number;
  blocked_rows: number;
  conflict_rows: number;
  error_count: number;
  warning_count: number;
  info_count: number;
  extracted_fact_count: number;
  catalog_hint_count: number;
  missing_required_count: number;
  missing_fact_count: number;
  missing_catalog_hint_count: number;
  diagnostic_only: boolean;
}

/** Per-item review surface — backend mirror of the Phase 2G frontend
 *  diagnostics, narrowed to the codes the operational pipeline
 *  classifies. */
export type OperationalReviewSeverity =
  | "ready"
  | "info"
  | "warning"
  | "blocked"
  | (string & {});

export type OperationalReviewFixArea =
  | "extracted_fact"
  | "catalog_hint"
  | "import_template"
  | "invoice_pattern"
  | "reference_data"
  | "unknown"
  | (string & {});

export interface OperationalReviewDiagnostic {
  severity: OperationalReviewSeverity;
  code?: string | null;
  message: string;
  recommendation?: string | null;
  column_id?: string | null;
  column_name?: string | null;
  fix_area?: OperationalReviewFixArea;
}

/**
 * Top-level response envelope for the operational resolution
 * endpoint. ``diagnostic_only`` is hard-True at the backend;
 * surface that in any "is this safe to run for real?" UI gate.
 */
export interface OperationalResolutionResult {
  diagnostic_only: boolean;
  template_id: string;
  template_name?: string | null;
  pattern_id?: string | null;
  pattern_name?: string | null;
  document_id?: string | null;
  batch_id?: string | null;
  resolver_input: ResolverInput;
  resolver_result: ResolverResult;
  operational_summary: OperationalResolutionSummary;
  review_diagnostics: OperationalReviewDiagnostic[];
}
