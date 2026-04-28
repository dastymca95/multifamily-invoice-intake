/**
 * Phase 3D — Operational diagnostics Markdown report.
 *
 * Pure helper that turns the Phase 3D ``OperationalDiagnosticCard``
 * list (already cooked by ``operational-review-diagnostics.ts``)
 * into a Markdown blob the operator can paste into Slack, email,
 * or a support ticket.
 *
 * Reuses the existing Phase 2H ``copyTextToClipboard`` so the
 * operator gets the same clipboard semantics + error handling
 * across all "copy diagnostic report" surfaces.
 *
 * Diagnostic only — this report says so explicitly. It does NOT
 * stand in for an export; the production export engine is a
 * separate future phase.
 */

import type { OperationalResolutionResult } from "@/types/operational-resolution";

import {
  SEVERITY_LABEL,
  groupOperationalDiagnosticCards,
  summarizeOperationalDiagnosticCards,
  type NormalizedSeverity,
  type OperationalDiagnosticCard,
} from "./operational-review-diagnostics";

// Re-export the existing Phase 2H clipboard helper so the panel
// can import everything report-related from a single module
// without taking a dependency on the Pattern Test reports module
// directly.
export { copyTextToClipboard } from "./pattern-test-reports";

// ---------------------------------------------------------------------------
// Public report builder
// ---------------------------------------------------------------------------

export interface OperationalDiagnosticsReportArgs {
  result: OperationalResolutionResult;
  cards: OperationalDiagnosticCard[];
  /** Optional one-line context label, e.g. "Document: epb-march.pdf"
   *  passed in from the launch surface. */
  contextLabel?: string | null;
  /** Override generation time — useful in tests / deterministic snapshots. */
  generatedAt?: Date;
}

/**
 * Build the Markdown report. Sections:
 *   1. Header (template, pattern, document/batch, generated stamp,
 *      diagnostic-only notice)
 *   2. Operational summary (counts + first recommended action)
 *   3. Grouped diagnostics (blocked → warning → info → ready)
 *   4. Footer reminder that this is not an export
 */
export function buildOperationalDiagnosticsMarkdownReport(
  args: OperationalDiagnosticsReportArgs,
): string {
  const { result, cards } = args;
  const summary = summarizeOperationalDiagnosticCards(cards);
  const groups = groupOperationalDiagnosticCards(cards);
  const ts = (args.generatedAt ?? new Date()).toLocaleString();

  const lines: string[] = [];
  lines.push("# Rivera Operational Preview · Diagnostics Report");
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
    "_Diagnostic preview only. This report is not an export and Rivera did not change any document, batch, template, or reference data._",
  );
  lines.push("");

  // -- Operational summary --
  const ops = result.operational_summary;
  lines.push("## Operational summary");
  lines.push("");
  lines.push(`- Resolver status: \`${ops.status ?? "—"}\``);
  lines.push(
    `- Rows: ${ops.row_count} · Ready: ${ops.ready_rows} · Needs review: ${ops.needs_review_rows} · Blocked: ${ops.blocked_rows} · Conflict: ${ops.conflict_rows}`,
  );
  lines.push(
    `- Errors: ${ops.error_count} · Warnings: ${ops.warning_count} · Info: ${ops.info_count}`,
  );
  lines.push(
    `- Extracted facts on bridge input: ${ops.extracted_fact_count} · Catalog hints: ${ops.catalog_hint_count}`,
  );
  lines.push(
    `- Missing required: ${ops.missing_required_count} · Missing facts: ${ops.missing_fact_count} · Missing catalog hints: ${ops.missing_catalog_hint_count}`,
  );
  lines.push("");

  // -- Diagnostic summary (counts + top fix area + first action) --
  lines.push("## Review diagnostics summary");
  lines.push("");
  lines.push(`- Total diagnostics: ${summary.total}`);
  lines.push(`- Blocked: ${summary.blocked}`);
  lines.push(`- Needs review: ${summary.warning}`);
  lines.push(`- Info: ${summary.info}`);
  lines.push(`- Ready: ${summary.ready}`);
  if (summary.top_fix_area_label) {
    lines.push(`- Top fix area: **${summary.top_fix_area_label}**`);
  }
  if (summary.first_recommended_action) {
    lines.push(
      `- First recommended action: ${summary.first_recommended_action}`,
    );
  }
  lines.push("");

  // -- Grouped diagnostics --
  const orderedGroups: Array<[NormalizedSeverity, OperationalDiagnosticCard[]]> = [
    ["blocked", groups.blocked],
    ["warning", groups.warning],
    ["info", groups.info],
    ["ready", groups.ready],
  ];
  let anyRendered = false;
  for (const [severity, list] of orderedGroups) {
    if (list.length === 0) continue;
    anyRendered = true;
    lines.push(`## ${SEVERITY_LABEL[severity]}`);
    lines.push("");
    for (const card of list) {
      _appendCard(lines, card);
    }
  }
  if (!anyRendered) {
    lines.push("## Diagnostics");
    lines.push("");
    lines.push(
      "_No review diagnostics returned by the resolver. Future export readiness still depends on the final export phase._",
    );
    lines.push("");
  }

  // -- Footer --
  lines.push("---");
  lines.push("");
  lines.push(
    "_This is a diagnostic preview. Rivera did not create Review Queue records, modify documents/batches, or generate export rows._",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _appendCard(
  lines: string[],
  card: OperationalDiagnosticCard,
): void {
  lines.push(`### ${card.title}`);
  lines.push("");
  if (card.column_name || card.column_id) {
    lines.push(`- **Column:** ${card.column_name ?? card.column_id}`);
  }
  lines.push(`- **What happened:** ${card.what_happened}`);
  lines.push(`- **Why it matters:** ${card.why_it_matters}`);
  lines.push(`- **Where to fix:** ${card.where_to_fix}`);
  lines.push(`- **Recommended next step:** ${card.recommended_action}`);
  lines.push(`- **Fix area:** ${card.fix_area_label}`);
  if (card.backend_code) {
    lines.push(`- **Backend code:** \`${card.backend_code}\``);
  }
  // Preserve the backend's raw message + recommendation when they
  // differ from the operator-friendly copy — operators forwarding
  // the report to support need this.
  if (card.raw_message && card.raw_message !== card.what_happened) {
    lines.push(`- **Backend message:** ${card.raw_message}`);
  }
  if (
    card.raw_recommendation &&
    card.raw_recommendation !== card.recommended_action
  ) {
    lines.push(
      `- **Backend recommendation:** ${card.raw_recommendation}`,
    );
  }
  lines.push("");
}

function _safeName(
  name: string | null | undefined,
  fallback: string | null | undefined,
): string {
  if (name && name.trim()) return name.trim();
  if (fallback && fallback.trim()) return fallback.trim();
  return "Untitled";
}
