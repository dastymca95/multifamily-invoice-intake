/**
 * Phase 3E — Operational Export-style Rows Preview Markdown report.
 *
 * Pure helper that turns the Phase 3E ``OperationalExportPreview``
 * (already cooked by ``operational-export-preview.ts``) into a
 * Markdown blob the operator can paste into Slack / email / a
 * support ticket to share what the export-style preview looked
 * like.
 *
 * Reuses the existing Phase 2H ``copyTextToClipboard`` so all
 * operator-facing copy actions share the same clipboard semantics
 * + error handling.
 *
 * Diagnostic only — the report header, body, and footer all say so
 * explicitly. NO export file is generated; this is a clipboard
 * artefact, not an export artefact.
 */

import type { OperationalResolutionResult } from "@/types/operational-resolution";

import type {
  ExportPreviewRowStatus,
  OperationalExportPreview,
  OperationalExportPreviewCell,
  OperationalExportPreviewRow,
} from "./operational-export-preview";

// Re-export the existing Phase 2H clipboard helper so the panel
// can import everything report-related from a single module
// without taking a direct dependency on the Pattern Test reports
// module.
export { copyTextToClipboard } from "./pattern-test-reports";

// ---------------------------------------------------------------------------
// Public report builder
// ---------------------------------------------------------------------------

export interface OperationalExportPreviewReportArgs {
  result: OperationalResolutionResult;
  preview: OperationalExportPreview;
  /** Optional one-line context label, e.g. "Document: epb-march.pdf"
   *  passed in from the launch surface. */
  contextLabel?: string | null;
  /** Override generation time — useful in tests / deterministic snapshots. */
  generatedAt?: Date;
  /**
   * Cap how many rows render in the Markdown table. Defaults to
   * 100 — keeps the report scannable even when a future operational
   * run produces many rows. Caller can override in extreme cases.
   */
  rowCap?: number;
}

const DEFAULT_ROW_CAP = 100;

const ROW_STATUS_LABEL: Record<ExportPreviewRowStatus, string> = {
  clear: "Clear",
  needs_review: "Needs review",
  blocked: "Blocked",
  conflict: "Conflict",
};

/**
 * Build the Markdown report. Sections:
 *
 *   1. Header (template, pattern, document/batch, generated stamp,
 *      diagnostic-only notice)
 *   2. Summary block (row counts + worst status + columns count)
 *   3. Column list
 *   4. Rows table (capped via ``rowCap``)
 *   5. Issues block (cell-level warnings + codes)
 *   6. Footer reminder that this is not an export file
 */
export function buildOperationalExportPreviewMarkdownReport(
  args: OperationalExportPreviewReportArgs,
): string {
  const { result, preview } = args;
  const ts = (args.generatedAt ?? new Date()).toLocaleString();
  const rowCap = args.rowCap ?? DEFAULT_ROW_CAP;

  const lines: string[] = [];
  lines.push("# Rivera Operational Preview · Export-style Rows Preview");
  lines.push("");
  lines.push(`**Generated:** ${ts}`);
  lines.push(
    `**Template:** ${_safeName(result.template_name, result.template_id)}`,
  );
  if (result.pattern_id || result.pattern_name) {
    lines.push(
      `**Invoice Pattern:** ${_safeName(result.pattern_name, result.pattern_id)}`,
    );
  } else {
    lines.push("**Invoice Pattern:** _none (direct facts)_");
  }
  if (result.document_id) {
    lines.push(`**Document ID:** ${result.document_id}`);
  }
  if (result.batch_id) {
    lines.push(`**Batch ID:** ${result.batch_id}`);
  }
  if (args.contextLabel) {
    lines.push(`**Launch context:** ${args.contextLabel}`);
  }
  lines.push("");
  lines.push(
    "_Diagnostic export-style preview only. No export file was generated, no Review Queue records were created, and no document, batch, template, or reference data was modified._",
  );
  lines.push("");

  // -- Summary block --
  const summary = preview.summary;
  lines.push("## Preview summary");
  lines.push("");
  lines.push(`- Resolver status: \`${preview.status}\``);
  lines.push(`- Rows: ${summary.row_count}`);
  lines.push(`- Clear: ${summary.ready_row_count}`);
  lines.push(`- Needs review: ${summary.warning_row_count}`);
  lines.push(`- Blocked: ${summary.blocked_row_count}`);
  lines.push(`- Conflict: ${summary.conflict_row_count}`);
  lines.push(`- Cells with issues: ${summary.cells_with_issues}`);
  lines.push(`- Columns: ${summary.column_count}`);
  if (summary.worst_status) {
    lines.push(
      `- Worst row status: **${ROW_STATUS_LABEL[summary.worst_status]}**`,
    );
  }
  lines.push("");

  // -- Empty preview --
  if (preview.rows.length === 0 || preview.columns.length === 0) {
    lines.push("## Rows");
    lines.push("");
    lines.push(
      "_No resolved rows to preview. Run a preview with enough invoice facts and template rules to see export-style rows._",
    );
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(_footer());
    return lines.join("\n");
  }

  // -- Column list --
  lines.push("## Columns");
  lines.push("");
  for (const col of preview.columns) {
    const issueLine = col.has_issues
      ? ` — ${col.issue_count} issue${col.issue_count === 1 ? "" : "s"}`
      : "";
    lines.push(`- **${col.label}** (\`${col.key}\`)${issueLine}`);
  }
  lines.push("");

  // -- Rows table (capped) --
  const visibleRows = preview.rows.slice(0, rowCap);
  const hiddenRowCount = preview.rows.length - visibleRows.length;

  lines.push("## Rows");
  lines.push("");
  // Markdown table header — include a leading "Row" + "Status"
  // column so reviewers can scan severity without reading values.
  const headerCells: string[] = ["Row", "Status"];
  for (const col of preview.columns) headerCells.push(col.label);
  lines.push(`| ${headerCells.map(_escapeMd).join(" | ")} |`);
  lines.push(`| ${headerCells.map(() => "---").join(" | ")} |`);
  for (const row of visibleRows) {
    const rowCells: string[] = [
      String(row.row_index + 1),
      ROW_STATUS_LABEL[row.status] +
        (row.issue_count > 0
          ? ` (${row.issue_count} issue${row.issue_count === 1 ? "" : "s"})`
          : ""),
    ];
    for (const col of preview.columns) {
      const cell = row.cells.find((c) => c.column_key === col.key);
      rowCells.push(_renderCellMd(cell));
    }
    lines.push(`| ${rowCells.map(_escapeMd).join(" | ")} |`);
  }
  if (hiddenRowCount > 0) {
    lines.push("");
    lines.push(
      `_${hiddenRowCount} additional row${hiddenRowCount === 1 ? "" : "s"} not listed in this report (cap: ${rowCap})._`,
    );
  }
  lines.push("");

  // -- Issues block --
  if (preview.issues.length > 0) {
    lines.push("## Cell-level issues");
    lines.push("");
    // Group blocked first, then warning, mirroring the panel's
    // sort order. Within each group, preserve the row/column
    // discovery order from the preview.
    const blocked = preview.issues.filter((i) => i.severity === "blocked");
    const warning = preview.issues.filter((i) => i.severity === "warning");
    if (blocked.length > 0) {
      lines.push("### Blocked / Conflict cells");
      lines.push("");
      for (const issue of blocked) {
        lines.push(
          `- Row ${issue.row_index + 1} · **${issue.column_label}** — ${issue.text} _(${issue.source})_`,
        );
      }
      lines.push("");
    }
    if (warning.length > 0) {
      lines.push("### Cells needing review");
      lines.push("");
      for (const issue of warning) {
        lines.push(
          `- Row ${issue.row_index + 1} · **${issue.column_label}** — ${issue.text} _(${issue.source})_`,
        );
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(_footer());
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _renderCellMd(
  cell: OperationalExportPreviewCell | undefined,
): string {
  if (!cell) return "—";
  if (cell.status === "missing") {
    return cell.display_value ?? "Missing";
  }
  if (cell.status === "blocked" || cell.status === "conflict") {
    const value = cell.display_value ?? "—";
    return `${value} ⚠`;
  }
  if (cell.status === "warning") {
    const value = cell.display_value ?? "—";
    return `${value} ⚠`;
  }
  return cell.display_value ?? "—";
}

/** Markdown table cells must escape pipes + collapse newlines. */
function _escapeMd(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function _safeName(
  name: string | null | undefined,
  fallback: string | null | undefined,
): string {
  if (name && name.trim()) return name.trim();
  if (fallback && fallback.trim()) return fallback.trim();
  return "Untitled";
}

function _footer(): string {
  // Phase 3L — boundary contract reaffirmed inline. The panel
  // attaches a full boundary block to the consolidated full-report
  // and the per-section profile-check report; the export-preview
  // report keeps the boundary as a footer line so the per-section
  // call site doesn't need to thread the boundary through.
  return [
    "_This is a diagnostic export-style preview. No export file was generated._",
    "_Production export is unavailable: no export engine, no persisted profiles, no export run records, no file generation, no external posting._",
    "_Future export depends on export profiles and final validation._",
    "_Diagnostic clear does not mean production export ready._",
  ].join("\n");
}

// Re-export row + cell types for caller convenience.
export type { OperationalExportPreviewRow, OperationalExportPreviewCell };
