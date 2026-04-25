/**
 * Invoice Builder ↔ Import Builder coverage view.
 *
 * Mirrors `app/schemas/invoice_pattern_coverage.py` byte-for-byte.
 * `GET /invoice-patterns/{id}/import-coverage` returns this shape; it
 * powers the right-rail Coverage panel in the Invoice Builder editor
 * and the region overlay association badges ("Linked", "REQ mapped").
 *
 * One-way reference invariant: the source of truth for which patterns
 * a template references is the `extraction_bindings` array on each
 * Import Builder rule cell. The pattern row itself does NOT track
 * reverse pointers. This module is the read-time projection of those
 * bindings, computed by the backend service and rendered by the
 * frontend without ever writing back. See the Part 8 constraint in the
 * spec — Invoice Builder is read-only with respect to Import Builder
 * mappings.
 *
 * The five-bucket `RequiredColumnStatus` taxonomy mirrors the resolver
 * branch order in `app/services/invoice_pattern_coverage.py:_classify_column`.
 * Adding a new bucket requires a backend Literal update at the same
 * time — this union is a wire shape, not a frontend convention.
 */
// UUIDs travel as plain strings on the wire — matches how every other
// `id: string` field is typed across this folder. Kept here so a future
// branded-UUID rollout has one swap point per module.

/**
 * Resolution status for one required column on an Import Builder
 * template, evaluated against the pattern currently open in the
 * Invoice Builder. Branch order is documented on the backend
 * resolver; the UI uses this together with `extraction_field_key` to
 * tell apart "this column is satisfied BY THIS pattern" from "this
 * column is satisfied via some other path (default / catalog / manual
 * list / broad-universe extraction)".
 *
 *   * `satisfied_by_extraction`   — at least one rule cell extraction
 *     binding under this column references THIS pattern (or — when
 *     `extraction_field_key` is null — the column is `invoice_field`
 *     source_type and falls through to broad-universe extraction).
 *   * `satisfied_by_default`      — column has a `default_value`
 *     (typically `fixed_value` source). Independent of which pattern
 *     is open.
 *   * `satisfied_by_catalog`      — column bound to a Reference Data
 *     catalog (vendor/property/gl_field). Independent of this pattern.
 *   * `satisfied_by_manual_or_rule` — column is `manual_list` with
 *     values, OR has rule cells with action values supplying the
 *     column. Independent of this pattern.
 *   * `missing`                   — column has no resolution path
 *     declared. Reported only for required columns; non-required
 *     columns may legally be unresolved.
 */
export type RequiredColumnStatus =
  | "satisfied_by_extraction"
  | "satisfied_by_default"
  | "satisfied_by_catalog"
  | "satisfied_by_manual_or_rule"
  | "missing";

/**
 * One reverse pointer — a single rule cell on an Import Builder
 * template that references this pattern via an extraction binding.
 *
 * The `template_id` + `rule_id` + `column_id` triple is enough for the
 * Coverage panel to deep-link straight into the Import Builder editor
 * (open template → scroll to rule N → highlight column X).
 *
 * `rule_index` is the 1-based human-friendly position inside the
 * template's rules list at the time of the read — surfaced as
 * "Rule 3" in the panel. Snapshot value: if the operator reorders
 * rules in another tab the index can drift, but the deep-link still
 * works because it goes by id.
 *
 * `column_required` is denormalised so the Coverage panel can stamp a
 * "REQ" chip without re-correlating against the source template.
 */
export interface UsedByImportRuleCell {
  template_id: string;
  template_name: string;
  rule_id: string;
  rule_index: number;
  column_id: string;
  column_name: string;
  column_required: boolean;
}

/**
 * One field on the open pattern that at least one Import Builder rule
 * cell references via an extraction binding.
 *
 * `field_label` is the operator-resolved display name — pattern-level
 * override wins, then canonical label, then the slug. The frontend
 * renders this directly; no need to re-run the field-options resolver
 * from the bare key.
 *
 * `used_by` collects every rule cell pointer for this field across
 * every template in the response — that's the cross-template
 * visibility the Coverage panel exists to show.
 */
export interface UsedFieldCoverage {
  field_key: string;
  field_label: string;
  used_by: UsedByImportRuleCell[];
}

/**
 * One required column on a template, with satisfaction status against
 * the open pattern. Always carries the canonical column metadata
 * (id, name, types) so the Coverage panel can render the row
 * standalone without re-correlating against the source template detail
 * payload.
 *
 * `extraction_field_key` is set ONLY when status is
 * `satisfied_by_extraction` AND the contributing binding points at
 * THIS pattern. Null when the column is `satisfied_by_extraction` via
 * broad-universe fall-through (no rule cell binding to the current
 * pattern), or when satisfied via any other path. The UI uses this to
 * distinguish "this pattern actively contributes" from "this column is
 * fine on its own".
 */
export interface RequiredColumnCoverage {
  column_id: string;
  column_name: string;
  data_type: string;
  source_type: string;
  required: boolean;
  status: RequiredColumnStatus;
  extraction_field_key: string | null;
}

/**
 * Counters for the Coverage panel header / chips. Surface
 * "X of Y fields used" and "M of N required satisfied" without
 * folding the per-template arrays client-side.
 *
 * `total_fields_in_pattern` is the size of the resolved field
 * universe (canonical built-ins after operator hide/override + custom
 * fields). Counted on the backend at request time so the value
 * matches the picker's view.
 */
export interface CoverageStats {
  total_fields_in_pattern: number;
  used_fields_count: number;
  unused_fields_count: number;
  total_required_columns: number;
  satisfied_required_columns: number;
  missing_required_columns: number;
}

/**
 * One template's view of the open pattern's coverage. Returned even
 * when the template doesn't reference the pattern — `used_field_keys`
 * is empty in that case and the picker renders the "no fields used"
 * empty state. This keeps the response shape stable for the
 * "All templates" drop-down: every template appears, the user sees
 * at-a-glance which ones are wired up.
 *
 * `used_field_keys` is the de-duped, first-seen-walk-order set of
 * field_keys this template's rule cells reference on this pattern.
 * `used_fields` is the same set with labels + reverse pointers
 * attached.
 *
 * `required_columns` lists EVERY required column on the template;
 * non-required columns are intentionally omitted because coverage is
 * a "will this column have a value at runtime?" view, which is only
 * meaningful for required columns. `missing_required_columns` is the
 * pre-filtered subset where status === "missing" — saves the panel
 * header from re-filtering client-side.
 */
export interface ImportTemplateCoverageSummary {
  template_id: string;
  template_name: string;
  used_field_keys: string[];
  used_fields: UsedFieldCoverage[];
  required_columns: RequiredColumnCoverage[];
  missing_required_columns: RequiredColumnCoverage[];
  coverage: CoverageStats;
}

/**
 * Top-level response shape for `GET /invoice-patterns/{id}/import-coverage`.
 *
 * `templates` carries one entry per template in the response set:
 * every workspace template when no `?template_id` query param is in
 * play, or just the requested template when filtered. An empty
 * `used_field_keys` is allowed — a template that doesn't touch this
 * pattern still appears (with zero counts) so the picker can render
 * the "All templates" view consistently.
 *
 * `aggregate` rolls up across whatever templates are in the response
 * so the Coverage panel header can show one summary line ("4 of 7
 * templates use this pattern · 12 of 14 required columns satisfied")
 * without folding client-side.
 */
export interface InvoicePatternImportCoverage {
  pattern_id: string;
  pattern_name: string;
  templates: ImportTemplateCoverageSummary[];
  aggregate: CoverageStats;
}
