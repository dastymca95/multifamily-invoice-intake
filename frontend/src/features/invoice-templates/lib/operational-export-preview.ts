/**
 * Phase 3E — Operational Export-style Rows Preview utility.
 *
 * Pure helper that turns a Phase 3A ``OperationalResolutionResult``
 * (specifically its ``resolver_result.rows`` + ``cells``) into a
 * UI-friendly preview of what the future export rows would look
 * like.
 *
 * Diagnostic-only — this module:
 *   * NEVER calls the backend.
 *   * NEVER mutates the result.
 *   * NEVER claims production readiness.
 *   * NEVER generates a CSV / XLSX file.
 *   * NEVER claims a row is "export ready" — the backend resolver
 *     status is the source of truth, and even ``"ready"`` only
 *     means "the resolver did not block this row in this preview".
 *
 * The export-style table this drives is intended as an operator-
 * facing rehearsal: same row shape the production export engine
 * will eventually produce, but with diagnostic chips, missing-value
 * markers, and zero side effects.
 */

import type {
  ResolvedImportCell,
  ResolvedImportRow,
  ResolverStatus,
} from "@/types/import-resolver";
import type { OperationalResolutionResult } from "@/types/operational-resolution";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Coarse status for each preview cell. Distinct from the backend's
 * ``ResolvedCellStatus`` because the UI only needs to render four
 * tones (clear / warning / blocked / missing) consistently.
 */
export type ExportPreviewCellStatus =
  | "clear"
  | "warning"
  | "blocked"
  | "missing"
  | "conflict"
  | "ignored";

/** Coarse status for each preview row. Mirrors ``ResolverStatus``
 *  with operator-facing phrasing reserved for the UI layer. */
export type ExportPreviewRowStatus =
  | "clear"
  | "needs_review"
  | "blocked"
  | "conflict";

export interface OperationalExportPreviewIssueRef {
  /** A short label from cell warnings or issue codes — preserved
   *  verbatim for support / debugging. */
  text: string;
  /** Where this label came from on the cell — keeps duplicates
   *  identifiable when warnings + issue_codes overlap. */
  source: "warning" | "code";
}

export interface OperationalExportPreviewCell {
  column_key: string;
  column_label: string;
  /** Raw resolver value (may be string / number / boolean / null /
   *  unknown). UI uses ``display_value`` for rendering. */
  value: unknown;
  /** Display-ready string. ``null`` when the resolver couldn't
   *  produce a value AND the cell is missing/blocked. */
  display_value: string | null;
  /** Coarse cell status — drives the chip + tone in the UI. */
  status: ExportPreviewCellStatus;
  /** Backend ``ResolvedCellSourceType`` echoed for the operator
   *  Source chip. ``"none"`` when the cell didn't resolve. */
  source: string;
  /** Cell-level issue references (warnings + codes). */
  issues: OperationalExportPreviewIssueRef[];
  issue_count: number;
  /** Convenience flags for table-cell tinting + filters. */
  blocked: boolean;
  warning: boolean;
  missing: boolean;
  conflict: boolean;
}

export interface OperationalExportPreviewRow {
  row_index: number;
  status: ExportPreviewRowStatus;
  cells: OperationalExportPreviewCell[];
  issue_count: number;
  blocked: boolean;
  warning: boolean;
}

export interface OperationalExportPreviewColumn {
  /** Stable identifier — uses ``column_id`` from the resolver. */
  key: string;
  label: string;
  /** Echoed from cell.column_id (we don't have source-of-truth
   *  template here, so this is the best-effort "original" id). */
  original_column_id: string;
  /** Whether at least one cell in this column carries an issue. */
  has_issues: boolean;
  issue_count: number;
}

export interface OperationalExportPreviewIssue {
  /** Issue text (warning string OR code). */
  text: string;
  /** Row + column where the issue surfaced. */
  row_index: number;
  column_key: string;
  column_label: string;
  /** Severity bucket — drives the issue list grouping in the UI. */
  severity: "warning" | "blocked";
  source: "warning" | "code";
}

export interface OperationalExportPreviewSummary {
  row_count: number;
  ready_row_count: number;
  warning_row_count: number;
  blocked_row_count: number;
  conflict_row_count: number;
  /** Cells with issue_count > 0. */
  cells_with_issues: number;
  /** Number of columns surfaced in the preview. */
  column_count: number;
  /** Worst severity across rows — drives the section banner tone. */
  worst_status: ExportPreviewRowStatus | null;
}

/**
 * Top-level preview shape consumed by the panel.
 *
 * ``can_preview_export`` says "is there something visible to
 * render?" — true whenever we have at least one row with at least
 * one cell. ``can_future_export_hint`` is a SOFT signal that no
 * blocked / conflict cells were detected in this preview;
 * deliberately NOT named ``export_ready`` per spec — the backend
 * is the only thing that can ever say "ready to export", and
 * Phase 3E doesn't promise that.
 */
export interface OperationalExportPreview {
  status: ResolverStatus | string;
  row_count: number;
  ready_row_count: number;
  blocked_row_count: number;
  warning_row_count: number;
  conflict_row_count: number;
  columns: OperationalExportPreviewColumn[];
  rows: OperationalExportPreviewRow[];
  issues: OperationalExportPreviewIssue[];
  summary: OperationalExportPreviewSummary;
  can_preview_export: boolean;
  can_future_export_hint: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the export-style preview from a Phase 3A operational
 * result. Pure + deterministic.
 *
 * Column order:
 *   First-occurrence order across rows. ``rows[0]`` contributes
 *   its cells in cell-array order; subsequent rows append any
 *   columns not yet seen. Stable + matches what the operator
 *   sees in the backend resolver result section above.
 */
export function buildOperationalExportPreview(
  result: OperationalResolutionResult,
): OperationalExportPreview {
  const rawRows: ResolvedImportRow[] = result.resolver_result?.rows ?? [];

  // -- Discover columns in first-occurrence order ------------------
  const columnOrder: string[] = [];
  const columnLabels = new Map<string, string>();
  for (const row of rawRows) {
    for (const cell of row.cells ?? []) {
      const key = cell.column_id;
      if (!key) continue;
      if (!columnLabels.has(key)) {
        columnOrder.push(key);
        columnLabels.set(key, cell.column_label || key);
      }
    }
  }

  // -- Per-column issue rollup (filled while walking rows below) --
  const columnIssueCount = new Map<string, number>();

  // -- Build preview rows -----------------------------------------
  const rows: OperationalExportPreviewRow[] = [];
  const allIssues: OperationalExportPreviewIssue[] = [];

  for (const row of rawRows) {
    // Index existing cells by column_id so missing cells can be
    // synthesised below without losing the cell that DID exist.
    const cellByCol = new Map<string, ResolvedImportCell>();
    for (const cell of row.cells ?? []) {
      if (cell.column_id) cellByCol.set(cell.column_id, cell);
    }

    const previewCells: OperationalExportPreviewCell[] = [];
    let rowIssueCount = 0;
    let rowHasBlocked = false;
    let rowHasWarning = false;

    for (const columnKey of columnOrder) {
      const sourceCell = cellByCol.get(columnKey);
      const previewCell = sourceCell
        ? _buildPreviewCellFromResolved(sourceCell)
        : _buildSyntheticMissingCell(columnKey, columnLabels.get(columnKey) ?? columnKey);

      previewCells.push(previewCell);
      rowIssueCount += previewCell.issue_count;
      if (previewCell.blocked || previewCell.conflict) rowHasBlocked = true;
      else if (previewCell.warning) rowHasWarning = true;

      if (previewCell.issue_count > 0) {
        columnIssueCount.set(
          columnKey,
          (columnIssueCount.get(columnKey) ?? 0) + previewCell.issue_count,
        );
        for (const issue of previewCell.issues) {
          allIssues.push({
            text: issue.text,
            row_index: row.row_index,
            column_key: columnKey,
            column_label: previewCell.column_label,
            severity: previewCell.blocked || previewCell.conflict ? "blocked" : "warning",
            source: issue.source,
          });
        }
      }
    }

    // Row status: backend wins; fall back to derived from cells.
    const rowStatus = _normalizeRowStatus(
      row.status,
      rowHasBlocked,
      rowHasWarning,
    );

    rows.push({
      row_index: row.row_index,
      status: rowStatus,
      cells: previewCells,
      issue_count: rowIssueCount,
      blocked: rowStatus === "blocked" || rowStatus === "conflict",
      warning: rowStatus === "needs_review",
    });
  }

  // -- Build columns with rolled-up issue counts -------------------
  const columns: OperationalExportPreviewColumn[] = columnOrder.map((key) => ({
    key,
    label: columnLabels.get(key) ?? key,
    original_column_id: key,
    has_issues: (columnIssueCount.get(key) ?? 0) > 0,
    issue_count: columnIssueCount.get(key) ?? 0,
  }));

  // -- Roll up summary --------------------------------------------
  let ready = 0;
  let needsReview = 0;
  let blocked = 0;
  let conflict = 0;
  let cellsWithIssues = 0;
  for (const row of rows) {
    if (row.status === "clear") ready += 1;
    else if (row.status === "needs_review") needsReview += 1;
    else if (row.status === "blocked") blocked += 1;
    else if (row.status === "conflict") conflict += 1;
    for (const cell of row.cells) {
      if (cell.issue_count > 0) cellsWithIssues += 1;
    }
  }

  // Worst status — blocked > conflict > needs_review > clear.
  // Drives the section banner tone in the UI.
  const worstStatus: ExportPreviewRowStatus | null = (() => {
    if (rows.length === 0) return null;
    if (blocked > 0) return "blocked";
    if (conflict > 0) return "conflict";
    if (needsReview > 0) return "needs_review";
    return "clear";
  })();

  const summary: OperationalExportPreviewSummary = {
    row_count: rows.length,
    ready_row_count: ready,
    warning_row_count: needsReview,
    blocked_row_count: blocked,
    conflict_row_count: conflict,
    cells_with_issues: cellsWithIssues,
    column_count: columns.length,
    worst_status: worstStatus,
  };

  // Soft hint that nothing in the visible preview is blocked /
  // conflicted. Deliberately NOT promising export-readiness.
  const can_future_export_hint =
    rows.length > 0 &&
    blocked === 0 &&
    conflict === 0 &&
    needsReview === 0;

  return {
    status: result.resolver_result?.status ?? result.operational_summary?.status ?? "needs_review",
    row_count: rows.length,
    ready_row_count: ready,
    blocked_row_count: blocked,
    warning_row_count: needsReview,
    conflict_row_count: conflict,
    columns,
    rows,
    issues: allIssues,
    summary,
    can_preview_export: rows.length > 0 && columns.length > 0,
    can_future_export_hint,
  };
}

/**
 * Format a raw resolver value for display. Distinct from the
 * cell's own ``formatted_value`` field — used only when the
 * backend didn't supply one.
 *
 * Returns ``null`` only when the value is genuinely empty
 * (undefined / null / empty-trimmed string). ``0`` and ``false``
 * are NOT empty — they render as "0" / "false".
 */
export function formatExportPreviewValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Coarse cell status — flattens the backend's six-value
 * ``ResolvedCellStatus`` onto the four UI tones the preview chip
 * uses (plus the ``conflict`` / ``ignored`` pass-throughs).
 */
export function normalizeExportCellStatus(
  cell: ResolvedImportCell,
): ExportPreviewCellStatus {
  const raw = cell.status;
  if (raw === "resolved") return "clear";
  if (raw === "fallback") return "warning";
  if (raw === "manual_review") return "warning";
  if (raw === "missing") return "missing";
  if (raw === "conflict") return "conflict";
  if (raw === "ignored") return "ignored";
  return "warning";
}

/**
 * Sort rank for export preview row statuses — blocked first so
 * "show only issues" lists put the most urgent rows on top.
 */
export function getExportPreviewStatusRank(
  status: ExportPreviewRowStatus,
): number {
  switch (status) {
    case "blocked":
      return 0;
    case "conflict":
      return 1;
    case "needs_review":
      return 2;
    case "clear":
      return 3;
  }
}

/**
 * Convenience accessor — same data as ``preview.summary`` but
 * exposed as a function for callers that don't want to hold the
 * full preview object (e.g. log lines, telemetry).
 */
export function summarizeExportPreview(
  preview: OperationalExportPreview,
): OperationalExportPreviewSummary {
  return preview.summary;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _buildPreviewCellFromResolved(
  cell: ResolvedImportCell,
): OperationalExportPreviewCell {
  const status = normalizeExportCellStatus(cell);
  const blocked = false; // resolver cell statuses don't emit "blocked"
  // — row status carries blocked verdicts. Cells stay at the
  // missing / conflict / fallback / etc. level.
  const conflict = status === "conflict";
  const warning = status === "warning";
  const missing = status === "missing";

  // Pick the best displayable value. Backend-formatted_value
  // wins; then normalized_value; then raw value.
  let display_value: string | null = null;
  if (cell.formatted_value != null && cell.formatted_value !== "") {
    display_value = cell.formatted_value;
  } else if (cell.normalized_value !== undefined) {
    display_value = formatExportPreviewValue(cell.normalized_value);
  }
  if (display_value === null) {
    display_value = formatExportPreviewValue(cell.value);
  }

  // Issues — combine backend warnings + issue codes. Both are
  // preserved with provenance so the operator can tell them apart
  // (e.g. "DATA_TYPE_COERCION_FAILED" code vs. "Missing fact"
  // human warning text).
  const issues: OperationalExportPreviewIssueRef[] = [];
  for (const w of cell.warnings ?? []) {
    if (typeof w === "string" && w.trim()) {
      issues.push({ text: w.trim(), source: "warning" });
    }
  }
  for (const c of cell.issue_codes ?? []) {
    if (typeof c === "string" && c.trim()) {
      issues.push({ text: c.trim(), source: "code" });
    }
  }

  return {
    column_key: cell.column_id,
    column_label: cell.column_label || cell.column_id,
    value: cell.value,
    display_value,
    status,
    source: cell.source_type ?? "none",
    issues,
    issue_count: issues.length,
    blocked,
    warning,
    missing,
    conflict,
  };
}

function _buildSyntheticMissingCell(
  columnKey: string,
  columnLabel: string,
): OperationalExportPreviewCell {
  // Synthesized for rows whose resolver omitted this column. Marked
  // missing so the table shows a visible gap and the operator
  // knows the column existed elsewhere but didn't resolve here.
  return {
    column_key: columnKey,
    column_label: columnLabel,
    value: null,
    display_value: null,
    status: "missing",
    source: "none",
    issues: [],
    issue_count: 0,
    blocked: false,
    warning: false,
    missing: true,
    conflict: false,
  };
}

function _normalizeRowStatus(
  raw: ResolverStatus | undefined,
  rowHasBlocked: boolean,
  rowHasWarning: boolean,
): ExportPreviewRowStatus {
  // Backend status wins — narrow onto the four UI buckets.
  if (raw === "blocked") return "blocked";
  if (raw === "conflict") return "conflict";
  if (raw === "needs_review") return "needs_review";
  if (raw === "ready") {
    // Backend says ready, but if any cell screams blocked /
    // conflict, surface that — never silently downgrade severity.
    if (rowHasBlocked) return "blocked";
    if (rowHasWarning) return "needs_review";
    return "clear";
  }
  // Missing / unknown row status — derive from cells.
  if (rowHasBlocked) return "blocked";
  if (rowHasWarning) return "needs_review";
  return "clear";
}
