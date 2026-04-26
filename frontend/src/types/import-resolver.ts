/**
 * Frontend mirror of the backend Import Builder dry-run resolver
 * contract (`backend/app/schemas/import_resolver.py`).
 *
 * The dry-run endpoint is a DIAGNOSTIC surface: it never mutates a
 * template, never exports, never touches Review Queue, and never
 * invokes OCR / AI. It returns a `ResolverResult` describing how a
 * given input would resolve against the saved template — used by the
 * Resolver Preview panel inside Import Builder so an operator can
 * audit row/cell behaviour and inspect provenance.
 *
 * Keep types tolerant of harmless backend additions:
 *   * Use `string` (or `string & {}` widened unions) where the
 *     backend may grow new enum values over time.
 *   * Mark fields the backend treats as optional with `?` so
 *     stripped-down test responses don't crash the panel.
 *   * `value` / `normalized_value` carry user-defined cell content
 *     and stay `unknown` so the panel never silently coerces them.
 */

// ---------------------------------------------------------------------------
// Enums (backend Literals)
// ---------------------------------------------------------------------------

/** Source the resolver attributes an extracted fact to. */
export type ExtractedFactSourceType =
  | "invoice_pattern"
  | "ocr"
  | "heuristic"
  | "ai"
  | "manual"
  | "unknown";

/** Severity ladder for `ResolverIssue`. */
export type ResolverSeverity = "error" | "warning" | "info";

/**
 * Where in the resolver lifecycle the issue originated. The backend
 * may extend this set; the panel falls back to "unscoped" for unknown
 * values so old frontends keep rendering.
 */
export type ResolverIssueScope = "readiness" | "runtime" | "row" | "cell";

/** Top-level + per-row status verdict. */
export type ResolverStatus =
  | "ready"
  | "needs_review"
  | "blocked"
  | "conflict";

/** Per-cell verdict — finer-grained than the row status. */
export type ResolvedCellStatus =
  | "resolved"
  | "missing"
  | "conflict"
  | "fallback"
  | "manual_review"
  | "ignored";

/** Where a resolved cell's value originated. */
export type ResolvedCellSourceType =
  | "fixed_value"
  | "catalog"
  | "invoice_pattern"
  | "ocr"
  | "heuristic"
  | "ai"
  | "manual"
  | "global_default"
  | "rule_fill"
  | "derived"
  | "none";

// ---------------------------------------------------------------------------
// Request payload
// ---------------------------------------------------------------------------

/** One candidate value produced by extraction or later fallbacks. */
export interface ExtractedFact {
  field_key: string;
  normalized_field_key?: string | null;
  value?: unknown;
  text_value?: string | null;
  /** 0..1 confidence; nullable when source isn't a probabilistic model. */
  confidence?: number | null;
  source_type?: ExtractedFactSourceType;
  pattern_id?: string | null;
  pattern_label?: string | null;
  region_id?: string | null;
  /** 1-indexed source page when known. */
  page?: number | null;
  provenance_label?: string | null;
}

/** A candidate Invoice Builder pattern match for the current document. */
export interface PatternMatch {
  pattern_id: string;
  pattern_label?: string | null;
  confidence?: number | null;
  matched?: boolean;
  reason?: string | null;
}

/** Deterministic hint for resolving one catalog-backed baseline field. */
export interface CatalogHint {
  entry_id?: string | null;
  text?: string | null;
  field_values?: Record<string, unknown>;
}

/**
 * Request payload for the dry-run endpoint. ALL fields are optional;
 * an empty `{}` is a perfectly valid request and the backend will
 * just resolve the template against zero facts/hints.
 */
export interface ResolverInput {
  template_id?: string | null;
  document_id?: string | null;
  batch_id?: string | null;
  extracted_facts?: ExtractedFact[];
  pattern_matches?: PatternMatch[];
  catalog_hints?: Record<string, CatalogHint>;
  catalog_context?: Record<string, unknown> | null;
  document_metadata?: Record<string, unknown>;
  runtime_options?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Response — issues + provenance
// ---------------------------------------------------------------------------

/** One runtime / dry-run diagnostic. */
export interface ResolverIssue {
  severity: ResolverSeverity;
  code: string;
  message: string;
  scope?: ResolverIssueScope | null;
  recommendation?: string | null;
  column_id?: string | null;
  column_label?: string | null;
  rule_id?: string | null;
  rule_label?: string | null;
  field_key?: string | null;
  pattern_id?: string | null;
  /** Dotted JSON path used by the validator/resolver to locate the
   *  offending element inside the template document. */
  path?: string | null;
}

/** How a resolved output cell was produced. */
export interface CellProvenance {
  rule_id?: string | null;
  rule_label?: string | null;
  column_id: string;
  column_label: string;
  pattern_id?: string | null;
  field_key?: string | null;
  normalized_field_key?: string | null;
  catalog_id?: string | null;
  entry_id?: string | null;
  source_label?: string | null;
  source_detail?: string | null;
  source_type?: string | null;
}

/** One IF/condition cell evaluation for a dry-run row. */
export interface RuleConditionEvaluation {
  column_id: string;
  column_label: string;
  rule_id: string;
  role: string;
  expected_values?: unknown[];
  actual_values?: unknown[];
  matched: boolean;
  match_reason?: string | null;
  source_type?: string | null;
  issue_codes?: string[];
}

/** One LIMIT/restriction cell evaluation for a matched dry-run rule. */
export interface RuleRestrictionEvaluation {
  column_id: string;
  column_label?: string | null;
  rule_id: string;
  role: string;
  expected_values?: unknown[];
  actual_values?: unknown[];
  passed: boolean;
  restricted_out?: boolean;
  match_reason?: string | null;
  source_type?: string | null;
  issue_codes?: string[];
}

/** Applicability diagnostics for one rule against one dry-run row. */
export interface MatchedRuleResult {
  rule_id: string;
  rule_label?: string | null;
  matched: boolean;
  skipped?: boolean;
  skip_reason?: string | null;
  condition_count?: number;
  conditions_passed?: number;
  conditions_failed?: number;
  restriction_count?: number;
  restrictions_passed?: number;
  restrictions_failed?: number;
  restricted_out?: boolean;
  eligible_for_actions?: boolean;
  actions_applied?: number;
  actions_ignored?: number;
  issues?: ResolverIssue[];
  matched_conditions?: RuleConditionEvaluation[];
  restrictions?: RuleRestrictionEvaluation[];
  action_issues?: ResolverIssue[];
}

// ---------------------------------------------------------------------------
// Response — rows + cells
// ---------------------------------------------------------------------------

/** One output cell in a dry-run row. */
export interface ResolvedImportCell {
  column_id: string;
  column_label: string;
  /** Raw resolved value. May be string / number / boolean / null. */
  value?: unknown;
  /** Backend-normalized form (e.g. trimmed string, parsed number). */
  normalized_value?: unknown;
  /** Display-ready string (date formatted, currency rounded, etc.). */
  formatted_value?: string | null;
  status: ResolvedCellStatus;
  source_type: ResolvedCellSourceType;
  confidence?: number | null;
  provenance?: CellProvenance | null;
  warnings?: string[];
  issue_codes?: string[];
}

/** One placeholder import row returned by the dry-run skeleton. */
export interface ResolvedImportRow {
  row_index: number;
  status: ResolverStatus;
  cells?: ResolvedImportCell[];
  issues?: ResolverIssue[];
  matched_rules?: MatchedRuleResult[];
  confidence?: number | null;
}

// ---------------------------------------------------------------------------
// Response — summary + top-level result
// ---------------------------------------------------------------------------

/** Aggregate counts for the resolver result. */
export interface ResolverSummary {
  row_count?: number;
  ready_rows?: number;
  needs_review_rows?: number;
  blocked_rows?: number;
  conflict_rows?: number;
  error_count?: number;
  warning_count?: number;
  info_count?: number;
}

/** Top-level dry-run response. */
export interface ResolverResult {
  template_id: string;
  template_name?: string | null;
  status: ResolverStatus;
  rows?: ResolvedImportRow[];
  issues?: ResolverIssue[];
  summary?: ResolverSummary;
}
