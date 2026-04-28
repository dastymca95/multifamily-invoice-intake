/**
 * Frontend mirror of the Phase 2B backend Template + Pattern Test
 * Runner contract (``backend/app/schemas/template_pattern_test_runner.py``).
 *
 * The endpoint:
 *
 *   POST /api/v1/invoice-templates/{template_id}
 *        /test-with-pattern/{pattern_id}
 *
 * chains the Phase 2A bridge with the existing dry-run resolver and
 * returns the bridge input, the resolver result, and a coarse
 * summary in one envelope. ``diagnostic_only`` is a hard-True
 * constant — no mutations, no export, no Review Queue.
 *
 * Reuses ``ResolverInput`` / ``ResolverResult`` from
 * ``./import-resolver`` rather than re-declaring those shapes —
 * the test runner is purely a composer over already-typed contracts.
 *
 * Forward compat:
 *   * ``status`` + ``diagnostic_only`` are typed as the obvious
 *     literal types but everything inside ``bridge_input`` /
 *     ``resolver_result`` follows the underlying resolver schema's
 *     own forward-compat strategy (string-widened unions).
 *   * Optional fields stay optional; consumers tolerate missing
 *     metadata.
 */

import type {
  ResolverInput,
  ResolverResult,
  ResolverStatus,
} from "./import-resolver";

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/**
 * Request payload for the test-runner endpoint. Every field is
 * optional — posting ``{}`` is valid and yields a test run that
 * uses only the pattern's structural metadata + the template's
 * saved configuration.
 */
export interface TemplatePatternTestRequest {
  /**
   * Operator-typed canonical-field values. Bridge converts each
   * into an ``ExtractedFact`` with ``source_type="manual"`` and
   * ``confidence=1.0``. Field keys flow through the shared
   * extracted-field registry, so ``amount`` lands as
   * ``normalized_field_key="total_amount"``.
   */
  manual_fact_values?: Record<string, unknown>;
  /**
   * Operator-typed catalog hints, keyed by ``vendor`` / ``property``
   * / ``gl``. Values may be plain strings (treated as
   * ``CatalogHint(text=...)``) or full dicts (``entry_id`` /
   * ``text`` / ``field_values``). The vendor hint OVERRIDES the
   * pattern's own ``vendor_hint``.
   */
  manual_catalog_hints?: Record<string, unknown>;
  /**
   * When True, the bridge surfaces pattern field keys without a
   * manual value as advisory metadata
   * (``document_metadata.unfilled_pattern_fields``). Default false.
   */
  include_empty_fields?: boolean;
  /**
   * Forwarded onto ``ResolverInput.runtime_options``. Reserved for
   * Phase 2+ scenario inputs.
   */
  runtime_options?: Record<string, unknown>;
  /**
   * Caller-supplied document metadata. Bridge-managed and
   * runner-managed keys (``bridge_source``, ``bridge_version``,
   * ``invoice_pattern_*``, ``vendor_hint``, ``source_file_*``,
   * ``known_pattern_fields``, ``unfilled_pattern_fields``,
   * ``test_runner_*``, ``template_*``, ``diagnostic_only``) are
   * OVERRIDDEN by the runner so the caller can never spoof them.
   */
  document_metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/**
 * Coarse aggregate counts mirroring the resolver's own per-row /
 * per-severity counts plus two bridge-side counts (extracted facts
 * + catalog hints actually emitted).
 */
export interface TemplatePatternTestSummary {
  status: ResolverStatus | string;
  rows: number;
  ready: number;
  needs_review: number;
  blocked: number;
  conflict: number;
  errors: number;
  warnings: number;
  info: number;
  extracted_fact_count: number;
  catalog_hint_count: number;
}

/**
 * Top-level response envelope for the test-runner endpoint.
 *
 * ``diagnostic_only`` is wired hard-True at the backend; consumers
 * may still want to verify it at parse time before surfacing
 * "this would actually run" copy in the UI.
 */
export interface TemplatePatternTestResult {
  template_id: string;
  template_name?: string | null;
  pattern_id: string;
  pattern_name?: string | null;
  diagnostic_only: boolean;
  bridge_input: ResolverInput;
  resolver_result: ResolverResult;
  summary: TemplatePatternTestSummary;
}
