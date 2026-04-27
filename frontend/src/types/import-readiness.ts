/**
 * Frontend mirror of the backend Import Template readiness preview
 * contract (``backend/app/schemas/import_readiness.py``).
 *
 * The wizard's local heuristic helpers
 * (``evaluateGlobalSource`` / ``computeReadiness`` /
 * ``computeValueSourcePicture`` in ``ColumnInspector.tsx``) compute
 * readiness CLIENT-SIDE today. Phase 1D introduces this contract as
 * the canonical alternative — when the backend's
 * ``POST /invoice-templates/readiness-preview`` responds, the wizard
 * RENDERS the backend verdict instead of its local estimate. The
 * local helpers stay as a fallback for loading / error / offline.
 *
 * Forward-compat strategy:
 *   * Status / category / expectation are typed as string unions but
 *     widen to plain ``string`` for backwards compatibility — if the
 *     backend adds a new literal in a later phase, the wizard
 *     gracefully renders the unknown string instead of crashing.
 *   * Optional fields stay optional; the wizard tolerates missing
 *     fields (``detail``, ``recommendation``, ``fix_step``, etc.).
 *   * Item arrays are typed as ``readonly`` so consumers don't
 *     mutate the response in place.
 */

// ---------------------------------------------------------------------------
// Enums (kept widened for forward compatibility)
// ---------------------------------------------------------------------------

/** Per-item / per-column / per-template status. */
export type ReadinessStatus =
  | "ready"
  | "warning"
  | "blocked"
  // Forward-compat: gracefully accept future literals.
  | (string & {});

/** Coarse forecast of what Dry Run will say for the column. */
export type ResolverExpectation =
  | "should_resolve"
  | "may_be_missing"
  | "will_be_missing"
  | (string & {});

/** Grouping the wizard renders under collapsible sections. */
export type ReadinessCategory =
  | "structure"
  | "value_source"
  | "rule_runtime"
  | "advanced"
  | "validation"
  | (string & {});

/** Provenance tag — always ``backend_readiness`` from this endpoint. */
export type ReadinessSource = "backend_readiness" | (string & {});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/**
 * Request payload for the readiness preview endpoint.
 *
 * Re-uses the existing ``InvoiceTemplateColumn`` and
 * ``InvoiceTemplateRule`` shapes so the wizard can post its current
 * local state directly without any payload transformation.
 *
 * The ``options`` bag is forward-compatible (currently ignored
 * server-side) — Phase 2+ may add scenario inputs here.
 */
export interface ImportTemplateReadinessPreviewRequest {
  template_id?: string | null;
  template_name?: string | null;
  /** Current local columns (unsaved edits OK). */
  columns: unknown[];
  /** Current local rules (unsaved edits OK). */
  rules: unknown[];
  options?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Response items
// ---------------------------------------------------------------------------

/** Per-column value-source verdict — feeds the Resolver Expectation Card. */
export interface ValueSourceVerdictOut {
  /** The column ``source_type`` literal (or unknown future value). */
  kind: string;
  status: ReadinessStatus;
  label: string;
  detail?: string | null;
  /**
   * True iff the resolver needs an extracted fact / catalog hint at
   * runtime to actually produce a value.
   */
  conditional?: boolean;
}

/**
 * One row in a readiness checklist.
 *
 * Fields beyond the base wizard ReadinessItem add API plumbing
 * (column_id / rule_id / cell_key / path / source) so a flat list
 * can carry items from different scopes without losing the link to
 * the offending element.
 */
export interface ReadinessItemOut {
  category: ReadinessCategory;
  status: ReadinessStatus;
  /**
   * Stable issue code. Aligned with backend resolver/validator
   * codes when applicable; readiness-only codes start with
   * ``READINESS_*``.
   */
  code?: string | null;
  message: string;
  detail?: string | null;
  recommendation?: string | null;
  /**
   * Wizard step indicator (1–5 or ``"advanced"``) the operator
   * should jump to in order to fix the item.
   */
  fix_step?: number | string | null;
  column_id?: string | null;
  rule_id?: string | null;
  /**
   * Column id of the cell inside ``rule_id`` the item refers to —
   * rule cells are keyed by column id on the wire.
   */
  cell_key?: string | null;
  /** Optional dotted JSON path into the template body. */
  path?: string | null;
  /** Always ``"backend_readiness"`` from this endpoint. */
  source?: ReadinessSource;
}

/** Per-column readiness picture. */
export interface ColumnReadinessOut {
  column_id: string;
  column_name: string;
  required: boolean;
  data_type?: string | null;
  source_type?: string | null;
  status: ReadinessStatus;
  expectation: ResolverExpectation;
  expectation_label: string;
  expectation_detail: string;
  value_source: ValueSourceVerdictOut;
  items: ReadinessItemOut[];
}

/** Template-level rollup counts. */
export interface ReadinessSummary {
  column_count: number;
  ready_columns: number;
  warning_columns: number;
  blocked_columns: number;
  error_count: number;
  warning_count: number;
  info_count: number;
}

/** Top-level response body. */
export interface ImportTemplateReadinessPreviewResponse {
  template_id?: string | null;
  template_name?: string | null;
  status: ReadinessStatus;
  summary: ReadinessSummary;
  columns: ColumnReadinessOut[];
  /**
   * Template-level (non-column-scoped) items. Currently empty per
   * Phase 1C — column-shape issues are caught by the existing
   * validator. Reserved for future template-level diagnostics.
   */
  issues: ReadinessItemOut[];
}
