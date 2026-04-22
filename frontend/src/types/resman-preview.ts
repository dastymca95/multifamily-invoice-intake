/**
 * ResMan import preview — types mirror `app/schemas/resman_preview.py`.
 *
 * Shape:
 *   ResmanPreviewResponse
 *     ├ columns:       PreviewColumn[]    (template column + detected role)
 *     ├ rows:          PreviewRow[]       (each row's cells, in column order)
 *     ├ contributions: PreviewContribution[] ("what each report adds")
 *     └ notes:         string[]           (human-readable status / caveats)
 *
 * Cell statuses:
 *   "ok"          — value resolved (from invoice or reference report)
 *   "unresolved"  — column has a known role but no value can be filled yet
 *   "unmapped"    — column doesn't match any known role (rendered with a
 *                   subtle slash pattern so it's visually distinct from
 *                   "unresolved" — that's a missing value, this is a
 *                   missing rule)
 */

export type CellStatus = "ok" | "unresolved" | "unmapped";

export type CellSource =
  | "vendor_report"
  | "property_report"
  | "unit_report"
  | "invoice"
  | "synthetic";

export type ReferenceSource =
  | "vendor_report"
  | "property_report"
  | "unit_report"
  | "import_template";

export type ColumnRole =
  | "vendor_name"
  | "vendor_id"
  | "property_name"
  | "property_code"
  | "unit"
  | "location"
  | "invoice_number"
  | "invoice_date"
  | "due_date"
  | "amount_total"
  | "amount_subtotal"
  | "amount_tax"
  | "currency"
  | "description"
  | "account_number"
  | "gl_code"
  | "unmapped";

export type RowOrigin = "invoice" | "synthetic";

export interface PreviewCell {
  value: string | null;
  status: CellStatus;
  source: CellSource | null;
  note: string | null;
}

export interface PreviewRow {
  /** Row label shown in the leftmost (frozen) column. */
  label: string;
  origin: RowOrigin;
  /** One cell per column, in template column order. */
  cells: PreviewCell[];
}

export interface PreviewColumn {
  name: string;
  role: ColumnRole;
  /** Which uploaded report (if any) backs this column. */
  populated_from: ReferenceSource | null;
  /**
   * True when this column's role was set by a user-saved Import Builder
   * override (rather than the auto-classifier). The Import Builder
   * decorates the column header so the user can see which roles they've
   * manually pinned.
   */
  role_overridden: boolean;
}

export interface PreviewContribution {
  source: ReferenceSource;
  label: string;
  /** True when this source's file has been uploaded. */
  available: boolean;
  /** Total parsed rows in the source (NOT the sample size). */
  row_count: number | null;
  /** Template column names this source helps fill. */
  columns_powered: string[];
  note: string | null;
}

export interface ResmanPreviewResponse {
  has_template: boolean;
  template_filename: string | null;
  columns: PreviewColumn[];
  rows: PreviewRow[];
  contributions: PreviewContribution[];
  notes: string[];
}
