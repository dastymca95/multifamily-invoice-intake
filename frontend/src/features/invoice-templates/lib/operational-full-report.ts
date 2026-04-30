/**
 * Phase 3G — Consolidated Operational Preview Markdown report.
 *
 * Single Markdown blob the operator can copy from the Operational
 * Resolution Preview panel, combining the four diagnostic surfaces
 * already covered by per-section copy actions:
 *
 *   1. Operational Summary (always present)
 *   2. Review Diagnostics (Phase 3D)
 *   3. Export-style Rows Preview (Phase 3E)
 *   4. Export Profile Check (Phase 3F)
 *   5. Concise Technical Trace References
 *
 * Hard contract:
 *
 *   * Pure + deterministic — no React, no DOM, no clipboard
 *     access, no API calls.
 *   * Diagnostic only — every surfaced section explicitly says so.
 *   * Never weakens resolver verdicts: blocked stays blocked,
 *     conflict stays conflict, missing stays missing.
 *   * Never claims production / export readiness.
 *   * Never generates a file — the caller is responsible for
 *     piping the returned string into the existing
 *     ``copyTextToClipboard`` helper.
 *
 * Why this lives in its own module instead of stitching the
 * three existing per-section reports together:
 *
 *   * Avoids duplicate H1 headers + footers that would otherwise
 *     leak in from the per-section reports.
 *   * Lets the consolidated report tune row caps + skip the
 *     long-form per-cell issues block in favour of a concise
 *     summary suited to a single artefact.
 *   * Keeps Phase 3D / 3E / 3F helpers untouched — Phase 3G is
 *     additive only.
 */

import type { OperationalResolutionResult } from "@/types/operational-resolution";
import type { BackendExportRunDraftResult } from "@/types/export-run-draft";
import type { PersistedExportRunRead } from "@/types/export-run-persistence";

import type { OperationalDiagnosticCard } from "./operational-review-diagnostics";
import {
  SEVERITY_LABEL,
  groupOperationalDiagnosticCards,
  summarizeOperationalDiagnosticCards,
  type NormalizedSeverity,
} from "./operational-review-diagnostics";
import type {
  ExportPreviewRowStatus,
  OperationalExportPreview,
  OperationalExportPreviewCell,
} from "./operational-export-preview";
import type { ExportProfile } from "./export-profile-contract";
import type {
  ExportProfileIssue,
  ExportProfileIssueSeverity,
  ExportProfileValidationResult,
} from "./export-profile-validation";
import type { ExportValidationParityResult } from "./export-validation-parity";
import type { ExportReadinessBoundary } from "./export-readiness-boundary";
import {
  EXPORT_DIAGNOSTIC_STATUS_LABEL,
  EXPORT_READINESS_BOUNDARY_REASON_LABEL,
  PRODUCTION_EXPORT_STATUS_LABEL,
} from "./export-readiness-boundary";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OperationalFullReportOptions {
  /** Cap on rows rendered inside the export-preview table. Defaults
   *  to 100 — keeps the report scannable even on large operational
   *  runs. */
  exportRowCap?: number;
  /** Cap on profile issues rendered. Defaults to 200; older
   *  truncated entries surface a "+N more" line. */
  profileIssueCap?: number;
  /** When true, includes compact JSON snippets for
   *  ``resolver_input.document_metadata`` and
   *  ``resolver_input.runtime_options`` in the Technical Trace
   *  section. Default false (keeps the report quiet). */
  includeTechnicalTrace?: boolean;
}

export interface OperationalFullReportArgs {
  result: OperationalResolutionResult;
  reviewCards: OperationalDiagnosticCard[];
  exportPreview: OperationalExportPreview;
  /** Selected profile from the panel; ``null`` when no profile
   *  selection is meaningful (e.g. zero-row preview). */
  selectedProfile: ExportProfile | null;
  /** Validation result for ``selectedProfile``; ``null`` when no
   *  profile is selected. */
  profileValidation: ExportProfileValidationResult | null;
  contextLabel?: string | null;
  /** Override generation time — useful in tests / deterministic
   *  snapshots. */
  generatedAt?: Date;
  options?: OperationalFullReportOptions;
  /** Phase 3J — single-line marker describing the validation
   *  source (Backend verified / Local estimate / etc.). When
   *  provided, surfaced in the Context section so the consolidated
   *  report makes the verdict's provenance visible. */
  validationSourceMarker?: string | null;
  /** Phase 3K — parity diagnostic comparing local vs backend.
   *  Surfaced as a compact source-audit block under the Export
   *  Profile Check section. When ``aligned``, only one summary
   *  line is emitted; drift cases include the difference list. */
  parityResult?: ExportValidationParityResult | null;
  /** Phase 3L — explicit boundary contract describing the gap to
   *  a future production export. Surfaced as an "Export Readiness
   *  Boundary" section so the consolidated report ALWAYS carries
   *  the contract regardless of diagnostic state. */
  readinessBoundary?: ExportReadinessBoundary | null;
  /** Phase 3N — single-line marker describing the boundary source
   *  (Backend boundary verified / Local estimate / etc.). Surfaced
   *  inside the boundary section so the consolidated report
   *  announces whether the verdict is backend-verified or a local
   *  fallback. Only emitted when ``readinessBoundary`` is also
   *  provided. */
  boundarySourceMarker?: string | null;
  /** Phase 4B — single-line marker describing the profile source
   *  (Saved profile / Built-in starter). Surfaced in the Context
   *  section so the consolidated report announces whether the
   *  profile is a backend catalog row or a built-in starter. */
  profileSourceMarker?: string | null;
  /** Phase 4G — backend-evaluated Export Run Draft result. When
   *  present, surfaced as a "Export Run Draft" section in the
   *  consolidated report. ALWAYS carries hard-pinned literals
   *  (``draft_only=true`` / ``finalized=false`` /
   *  ``file_generated=false`` / ``download_available=false`` /
   *  ``production_export_ready=false``) — the section never
   *  claims production readiness regardless of status. */
  exportRunDraft?: BackendExportRunDraftResult | null;
  /** Phase 4G — single-line marker describing the draft source
   *  (Backend evaluated / Evaluation failed / Unavailable). Used
   *  to title the section honestly. */
  exportRunDraftSourceMarker?: string | null;
  /** Phase 4H — when ``true``, the draft section renders a stale
   *  banner so the operator knows the verdict is last-known-good
   *  while a fresh request is in flight or just failed. The
   *  ``exportRunDraftSourceMarker`` ALREADY carries the wording —
   *  this flag only drives the additional stale-callout line. */
  exportRunDraftStale?: boolean;
  /** Phase 4H — ISO timestamp of when ``exportRunDraft`` was last
   *  loaded. When provided, surfaced as a "Last evaluated" line so
   *  paste-into-Slack recipients can see exactly when the verdict
   *  was computed. */
  exportRunDraftLastUpdatedAt?: string | null;
  /** Phase 5B — persisted draft / audit record (when the operator
   *  clicked "Save draft audit record" in the panel). Always
   *  surfaced as a "Persisted Draft Audit Record" section ABOVE
   *  the Validation Source Audit so a paste-into-Slack reader sees
   *  the audit row id alongside the verdict that produced it.
   *  When ``null`` the section is omitted entirely. */
  persistedExportRun?: PersistedExportRunRead | null;
  /** Phase 5B — single-line operator-facing marker describing the
   *  persisted record (id, phase, status, "no file generated"
   *  reaffirmation). When provided, surfaced as the section's
   *  italic marker line. */
  persistedExportRunSourceMarker?: string | null;
  /** Phase 5B — when ``true``, the persisted record was saved
   *  against an OLDER diagnostic fingerprint than the current
   *  preview state. The section emits a "Current preview changed
   *  after save" callout so a paste-into-Slack reader doesn't
   *  misread the saved row as proof of the current verdict. */
  persistedExportRunStaleAfterSave?: boolean;
}

// ---------------------------------------------------------------------------
// Local labels (mirror per-section reports for consistency)
// ---------------------------------------------------------------------------

const ROW_STATUS_LABEL: Record<ExportPreviewRowStatus, string> = {
  clear: "Clear",
  needs_review: "Needs review",
  blocked: "Blocked",
  conflict: "Conflict",
};

const PROFILE_STATUS_LABEL: Record<
  ExportProfileValidationResult["status"],
  string
> = {
  clear: "No blocking issues in this diagnostic profile check",
  needs_review: "Needs review",
  blocked: "Blocked",
  conflict: "Conflict",
};

const PROFILE_SEVERITY_LABEL: Record<ExportProfileIssueSeverity, string> = {
  blocked: "Blocked",
  warning: "Needs review",
  info: "Info",
  clear: "Clear",
};

const DEFAULT_EXPORT_ROW_CAP = 100;
const DEFAULT_PROFILE_ISSUE_CAP = 200;

// ---------------------------------------------------------------------------
// Public report builder
// ---------------------------------------------------------------------------

/**
 * Build the consolidated Markdown report. Returns a single string —
 * the caller is responsible for clipboard / display.
 */
export function buildOperationalFullMarkdownReport(
  args: OperationalFullReportArgs,
): string {
  const { result, reviewCards, exportPreview, selectedProfile, profileValidation } = args;
  const ts = (args.generatedAt ?? new Date()).toLocaleString();
  const rowCap = args.options?.exportRowCap ?? DEFAULT_EXPORT_ROW_CAP;
  const profileIssueCap =
    args.options?.profileIssueCap ?? DEFAULT_PROFILE_ISSUE_CAP;
  const includeTrace = args.options?.includeTechnicalTrace ?? false;

  const lines: string[] = [];

  // -- Header --------------------------------------------------------
  lines.push("# Rivera Operational Preview Report");
  lines.push("");
  lines.push("## Diagnostic-only notice");
  lines.push("");
  lines.push(
    "_This report is a diagnostic preview. It does not create Review Queue records, export files, export batches, or external postings._",
  );
  lines.push("");

  // -- Context -------------------------------------------------------
  lines.push("## Context");
  lines.push("");
  lines.push(`- Generated at: ${ts}`);
  lines.push(
    `- Template: ${_safeName(result.template_name, result.template_id)}`,
  );
  if (result.pattern_id || result.pattern_name) {
    lines.push(
      `- Invoice Pattern: ${_safeName(result.pattern_name, result.pattern_id)}`,
    );
  } else {
    lines.push("- Invoice Pattern: _none (direct facts)_");
  }
  if (result.document_id) lines.push(`- Document ID: ${result.document_id}`);
  if (result.batch_id) lines.push(`- Batch ID: ${result.batch_id}`);
  if (args.contextLabel) lines.push(`- Launch context: ${args.contextLabel}`);
  if (args.validationSourceMarker) {
    lines.push(`- ${args.validationSourceMarker}`);
  }
  if (args.profileSourceMarker) {
    lines.push(`- ${args.profileSourceMarker}`);
  }
  lines.push(
    `- diagnostic_only: \`${String(result.diagnostic_only ?? true)}\``,
  );
  // Pattern selection mode lives on the request side, not the
  // response; surface it from the metadata when the bridge wrote
  // it (Phase 3A puts it into operational metadata only when
  // explicit).
  const md = result.resolver_input?.document_metadata ?? {};
  const psm = (md as Record<string, unknown>).pattern_selection_mode;
  if (typeof psm === "string" && psm.trim()) {
    lines.push(`- pattern_selection_mode: \`${psm}\``);
  }
  lines.push("");

  // -- Operational Summary ------------------------------------------
  const ops = result.operational_summary;
  lines.push("## Operational Summary");
  lines.push("");
  lines.push(`- Overall status: \`${ops?.status ?? "—"}\``);
  if (ops) {
    lines.push(`- Rows: ${ops.row_count}`);
    lines.push(`- Ready rows: ${ops.ready_rows}`);
    lines.push(`- Needs-review rows: ${ops.needs_review_rows}`);
    lines.push(`- Blocked rows: ${ops.blocked_rows}`);
    lines.push(`- Conflict rows: ${ops.conflict_rows}`);
    lines.push(
      `- Errors: ${ops.error_count} · Warnings: ${ops.warning_count} · Info: ${ops.info_count}`,
    );
    lines.push(
      `- Extracted facts on bridge input: ${ops.extracted_fact_count} · Catalog hints: ${ops.catalog_hint_count}`,
    );
    lines.push(
      `- Missing required: ${ops.missing_required_count} · Missing facts: ${ops.missing_fact_count} · Missing catalog hints: ${ops.missing_catalog_hint_count}`,
    );
    lines.push(`- diagnostic_only: \`${String(ops.diagnostic_only)}\``);
  }
  lines.push("");

  // -- Review Diagnostics --------------------------------------------
  lines.push("## Review Diagnostics");
  lines.push("");
  if (reviewCards.length === 0) {
    lines.push("_No review diagnostics returned by the resolver._");
    lines.push("");
  } else {
    const summary = summarizeOperationalDiagnosticCards(reviewCards);
    lines.push(`- Total: ${summary.total}`);
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
    const groups = groupOperationalDiagnosticCards(reviewCards);
    const orderedGroups: Array<[NormalizedSeverity, OperationalDiagnosticCard[]]> = [
      ["blocked", groups.blocked],
      ["warning", groups.warning],
      ["info", groups.info],
      ["ready", groups.ready],
    ];
    for (const [severity, list] of orderedGroups) {
      if (list.length === 0) continue;
      lines.push(`### ${SEVERITY_LABEL[severity]}`);
      lines.push("");
      for (const card of list) {
        _appendReviewCard(lines, card);
      }
    }
  }

  // -- Export-style Rows Preview ------------------------------------
  lines.push("## Export-style Rows Preview");
  lines.push("");
  lines.push(
    "_Diagnostic preview only — no export file is generated._",
  );
  lines.push("");
  if (
    !exportPreview.can_preview_export ||
    exportPreview.rows.length === 0 ||
    exportPreview.columns.length === 0
  ) {
    lines.push("_No resolved rows to preview yet._");
    lines.push("");
  } else {
    const ps = exportPreview.summary;
    lines.push(`- Resolver status: \`${exportPreview.status}\``);
    lines.push(`- Rows: ${ps.row_count}`);
    lines.push(`- Clear: ${ps.ready_row_count}`);
    lines.push(`- Needs review: ${ps.warning_row_count}`);
    lines.push(`- Blocked: ${ps.blocked_row_count}`);
    lines.push(`- Conflict: ${ps.conflict_row_count}`);
    lines.push(`- Cells with issues: ${ps.cells_with_issues}`);
    lines.push(`- Columns: ${ps.column_count}`);
    if (ps.worst_status) {
      lines.push(`- Worst row status: **${ROW_STATUS_LABEL[ps.worst_status]}**`);
    }
    lines.push("");
    // Column list -------------------------------------------------
    lines.push("### Columns");
    lines.push("");
    for (const col of exportPreview.columns) {
      const issuePart = col.has_issues
        ? ` — ${col.issue_count} issue${col.issue_count === 1 ? "" : "s"}`
        : "";
      lines.push(`- **${col.label}** (\`${col.key}\`)${issuePart}`);
    }
    lines.push("");

    // Rows table (capped) ----------------------------------------
    const visibleRows = exportPreview.rows.slice(0, rowCap);
    const hidden = exportPreview.rows.length - visibleRows.length;
    lines.push("### Rows");
    lines.push("");
    const headerCells: string[] = ["Row", "Status"];
    for (const col of exportPreview.columns) headerCells.push(col.label);
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
      for (const col of exportPreview.columns) {
        const cell = row.cells.find((c) => c.column_key === col.key);
        rowCells.push(_renderCellMd(cell));
      }
      lines.push(`| ${rowCells.map(_escapeMd).join(" | ")} |`);
    }
    if (hidden > 0) {
      lines.push("");
      lines.push(
        `_${hidden} additional row${hidden === 1 ? "" : "s"} not listed in this report (cap: ${rowCap})._`,
      );
    }
    lines.push("");

    // Cell-level issues grouped by severity ----------------------
    if (exportPreview.issues.length > 0) {
      lines.push("### Cell-level issues");
      lines.push("");
      const blocked = exportPreview.issues.filter(
        (i) => i.severity === "blocked",
      );
      const warning = exportPreview.issues.filter(
        (i) => i.severity === "warning",
      );
      if (blocked.length > 0) {
        lines.push("#### Blocked / Conflict cells");
        lines.push("");
        for (const issue of blocked) {
          lines.push(
            `- Row ${issue.row_index + 1} · **${issue.column_label}** — ${issue.text} _(${issue.source})_`,
          );
        }
        lines.push("");
      }
      if (warning.length > 0) {
        lines.push("#### Cells needing review");
        lines.push("");
        for (const issue of warning) {
          lines.push(
            `- Row ${issue.row_index + 1} · **${issue.column_label}** — ${issue.text} _(${issue.source})_`,
          );
        }
        lines.push("");
      }
    }
  }

  // -- Export Profile Check ------------------------------------------
  lines.push("## Export Profile Check");
  lines.push("");
  lines.push(
    "_Diagnostic profile check only — no export file is generated._",
  );
  lines.push("");
  if (!selectedProfile || !profileValidation) {
    lines.push("_No profile selected for this report._");
    lines.push("");
  } else {
    lines.push(`- Selected profile: **${selectedProfile.name}**`);
    lines.push(`- Target system: \`${selectedProfile.target_system}\``);
    lines.push(`- Description: ${selectedProfile.description}`);
    const s = selectedProfile.settings;
    lines.push(
      `- Settings: delimiter \`${s.delimiter}\` · header ${s.include_header ? "yes" : "no"} · date \`${s.date_format}\` · amount \`${s.amount_format}\` · encoding \`${s.encoding}\``,
    );
    lines.push("");
    lines.push(
      `- Validation status: **${PROFILE_STATUS_LABEL[profileValidation.status]}**`,
    );
    const sm = profileValidation.summary;
    lines.push(
      `- Counts: blocked ${sm.blocked_count} · needs-review ${sm.warning_count} · info ${sm.info_count}`,
    );
    lines.push(
      `- Columns matched: ${sm.matched_columns} / ${selectedProfile.columns.length} · unmapped ${sm.unmapped_columns}`,
    );
    lines.push(
      `- Rows blocked: ${sm.rows_blocked} · rows with issues: ${sm.rows_with_issues}`,
    );
    lines.push("");
    // Column mapping -----------------------------------------------
    if (profileValidation.column_results.length > 0) {
      lines.push("### Column mapping");
      lines.push("");
      lines.push(
        "| Profile column | Required | Matched preview column | Issues | Worst severity |",
      );
      lines.push("| --- | --- | --- | --- | --- |");
      for (const col of profileValidation.column_results) {
        lines.push(
          `| ${_escapeMd(col.profile_column_label)} (\`${col.profile_column_key}\`) | ` +
            (col.required ? "Yes" : "No") +
            " | " +
            (col.matched
              ? _escapeMd(
                  col.matched_preview_column_label ??
                    col.matched_preview_column_key ??
                    "—",
                )
              : "_unmapped_") +
            ` | ${col.issue_count} | ${PROFILE_SEVERITY_LABEL[col.worst_severity]} |`,
        );
      }
      lines.push("");
    }
    // Profile issues ----------------------------------------------
    if (profileValidation.issues.length > 0) {
      const visibleIssues = profileValidation.issues.slice(0, profileIssueCap);
      const hiddenIssues = profileValidation.issues.length - visibleIssues.length;
      lines.push("### Profile issues");
      lines.push("");
      const grouped: Array<[ExportProfileIssueSeverity, ExportProfileIssue[]]> = [
        ["blocked", visibleIssues.filter((i) => i.severity === "blocked")],
        ["warning", visibleIssues.filter((i) => i.severity === "warning")],
        ["info", visibleIssues.filter((i) => i.severity === "info")],
      ];
      for (const [sev, items] of grouped) {
        if (items.length === 0) continue;
        lines.push(`#### ${PROFILE_SEVERITY_LABEL[sev]}`);
        lines.push("");
        for (const issue of items) {
          const rowText =
            issue.row_index != null ? ` · row ${issue.row_index + 1}` : "";
          const colText = issue.profile_column_key
            ? ` · column \`${issue.profile_column_key}\``
            : "";
          lines.push(`- **${issue.message}**${rowText}${colText}`);
          lines.push(`  - Recommendation: ${issue.recommendation}`);
          lines.push(`  - Code: \`${issue.code}\``);
        }
        lines.push("");
      }
      if (hiddenIssues > 0) {
        lines.push(
          `_${hiddenIssues} additional issue${hiddenIssues === 1 ? "" : "s"} not listed in this report (cap: ${profileIssueCap})._`,
        );
        lines.push("");
      }
    }
  }

  // -- Export Readiness Boundary (Phase 3L + 3N) --------------------
  // ALWAYS emitted when supplied — the boundary contract is the
  // explicit gap from "diagnostic clear" to "production export
  // ready". Phase 3N — also receives the optional source marker so
  // the boundary section announces whether the verdict is backend-
  // verified or a local fallback.
  if (args.readinessBoundary) {
    _appendBoundarySection(
      lines,
      args.readinessBoundary,
      args.boundarySourceMarker ?? null,
    );
  }

  // -- Export Run Draft (Phase 4G) ----------------------------------
  // Backend-evaluated draft verdict — sits AFTER the readiness
  // boundary section so the operator reads the boundary contract
  // first. ALWAYS emitted when ``exportRunDraft`` is supplied;
  // hard-pinned literals make the section honest about
  // ``draft_only`` / ``finalized`` / ``file_generated`` /
  // ``download_available`` / ``production_export_ready``
  // regardless of the draft status.
  if (args.exportRunDraft) {
    _appendExportRunDraftSection(
      lines,
      args.exportRunDraft,
      args.exportRunDraftSourceMarker ?? null,
      args.exportRunDraftStale ?? false,
      args.exportRunDraftLastUpdatedAt ?? null,
    );
  }

  // -- Persisted Draft Audit Record (Phase 5B) ----------------------
  // Sits AFTER the Export Run Draft section so the operator reads
  // the verdict first, then the audit record id that captured it.
  // ALWAYS honest: ``id`` is an audit record id, NOT a finalised
  // export id; no ``download_url`` / ``file_id`` / ``export_id`` /
  // ``export_run_id`` ever appears in this section.
  if (args.persistedExportRun) {
    _appendPersistedExportRunSection(
      lines,
      args.persistedExportRun,
      args.persistedExportRunSourceMarker ?? null,
      args.persistedExportRunStaleAfterSave ?? false,
    );
  }

  // -- Validation Source Audit (Phase 3K) ---------------------------
  // Compact block under the Export Profile Check section. When the
  // parity is ``aligned`` we emit a single line; drift cases get
  // the full difference list (capped). When parity wasn't checked
  // (no backend / different profile / etc.) we suppress entirely
  // to keep the report quiet.
  if (args.parityResult && args.parityResult.checked) {
    _appendParityAuditBlock(lines, args.parityResult);
  }

  // -- Technical Trace References ------------------------------------
  lines.push("## Technical Trace References");
  lines.push("");
  const ri = result.resolver_input ?? null;
  const rr = result.resolver_result ?? null;
  const factKeys = (ri?.extracted_facts ?? [])
    .map((f) => f.field_key)
    .filter((k): k is string => typeof k === "string");
  const hintKeys = Object.keys(ri?.catalog_hints ?? {});
  const metadataKeys = Object.keys(ri?.document_metadata ?? {});
  const runtimeKeys = Object.keys(ri?.runtime_options ?? {});
  const diagnosticCodes = Array.from(
    new Set(
      (result.review_diagnostics ?? [])
        .map((d) => d.code ?? null)
        .filter((c): c is string => typeof c === "string" && c.trim().length > 0),
    ),
  );
  lines.push(`- resolver_result.rows: ${rr?.rows?.length ?? 0}`);
  lines.push(
    `- resolver_input.extracted_facts (${factKeys.length}): ${
      factKeys.length === 0 ? "_none_" : factKeys.map((k) => `\`${k}\``).join(", ")
    }`,
  );
  lines.push(
    `- resolver_input.catalog_hints (${hintKeys.length}): ${
      hintKeys.length === 0 ? "_none_" : hintKeys.map((k) => `\`${k}\``).join(", ")
    }`,
  );
  lines.push(
    `- resolver_input.document_metadata keys (${metadataKeys.length}): ${
      metadataKeys.length === 0
        ? "_none_"
        : metadataKeys.map((k) => `\`${k}\``).join(", ")
    }`,
  );
  lines.push(
    `- resolver_input.runtime_options keys (${runtimeKeys.length}): ${
      runtimeKeys.length === 0
        ? "_none_"
        : runtimeKeys.map((k) => `\`${k}\``).join(", ")
    }`,
  );
  lines.push(
    `- Backend diagnostic codes present (${diagnosticCodes.length}): ${
      diagnosticCodes.length === 0
        ? "_none_"
        : diagnosticCodes.map((c) => `\`${c}\``).join(", ")
    }`,
  );
  if (selectedProfile) {
    lines.push(
      `- Selected profile: \`${selectedProfile.id}\` · target \`${selectedProfile.target_system}\``,
    );
  } else {
    lines.push("- Selected profile: _none_");
  }
  lines.push(
    `- Caps used: exportRowCap=${rowCap} · profileIssueCap=${profileIssueCap}`,
  );

  if (includeTrace) {
    lines.push("");
    lines.push("### Compact technical trace");
    lines.push("");
    lines.push("```json");
    try {
      lines.push(
        JSON.stringify(
          {
            document_metadata: ri?.document_metadata ?? {},
            runtime_options: ri?.runtime_options ?? {},
          },
          null,
          2,
        ),
      );
    } catch {
      lines.push('"// non-serialisable metadata snapshot"');
    }
    lines.push("```");
  }
  lines.push("");

  // -- Footer --------------------------------------------------------
  lines.push("---");
  lines.push("");
  lines.push(
    "_No export file was generated. Future production export depends on export profiles, final validation, and the export engine._",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _appendReviewCard(
  lines: string[],
  card: OperationalDiagnosticCard,
): void {
  lines.push(`- **${card.title}**`);
  if (card.column_name || card.column_id) {
    lines.push(`  - Column: ${card.column_name ?? card.column_id}`);
  }
  lines.push(`  - What happened: ${card.what_happened}`);
  lines.push(`  - Why it matters: ${card.why_it_matters}`);
  lines.push(`  - Where to fix: ${card.where_to_fix}`);
  lines.push(`  - Recommended next step: ${card.recommended_action}`);
  lines.push(`  - Fix area: ${card.fix_area_label}`);
  if (card.backend_code) {
    lines.push(`  - Backend code: \`${card.backend_code}\``);
  }
  if (card.raw_message && card.raw_message !== card.what_happened) {
    lines.push(`  - Backend message: ${card.raw_message}`);
  }
}

function _renderCellMd(
  cell: OperationalExportPreviewCell | undefined,
): string {
  if (!cell) return "—";
  if (cell.status === "missing") {
    return cell.display_value ?? "Missing";
  }
  if (
    cell.status === "blocked" ||
    cell.status === "conflict" ||
    cell.status === "warning"
  ) {
    const value = cell.display_value ?? "—";
    return `${value} ⚠`;
  }
  return cell.display_value ?? "—";
}

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

// ---------------------------------------------------------------------------
// Phase 3K — Parity audit block (compact, gated on ``aligned``)
// ---------------------------------------------------------------------------

const _PARITY_STATUS_LABEL: Record<
  ExportValidationParityResult["status"],
  string
> = {
  aligned: "Aligned",
  minor_drift: "Minor drift",
  major_drift: "Major drift",
  not_checked: "Not checked",
};

const _PARITY_DIFF_CAP_FULL_REPORT = 15;

function _appendParityAuditBlock(
  lines: string[],
  parity: ExportValidationParityResult,
): void {
  lines.push("## Validation Source Audit");
  lines.push("");
  if (parity.status === "aligned") {
    // Single-line aligned case — keep the full report quiet.
    lines.push(
      `_Backend and local estimate are aligned (local=${parity.local_status ?? "—"}, backend=${parity.backend_status ?? "—"}, ${parity.local_issue_count} local / ${parity.backend_issue_count} backend issues). Diagnostic only._`,
    );
    lines.push("");
    return;
  }
  // Drift case — surface the headline + a capped detail list.
  lines.push(`- Status: **${_PARITY_STATUS_LABEL[parity.status]}**`);
  lines.push(`- Local status: \`${parity.local_status ?? "—"}\``);
  lines.push(`- Backend status: \`${parity.backend_status ?? "—"}\``);
  lines.push(`- Local issue count: ${parity.local_issue_count}`);
  lines.push(`- Backend issue count: ${parity.backend_issue_count}`);
  lines.push(`- Compared at: ${parity.compared_at}`);
  lines.push("");
  if (parity.differences.length === 0) {
    lines.push(
      "_No drift differences. Backend remains the source of truth._",
    );
  } else {
    const visible = parity.differences.slice(0, _PARITY_DIFF_CAP_FULL_REPORT);
    const hidden = parity.differences.length - visible.length;
    lines.push(`Top differences (${visible.length} of ${parity.differences.length}):`);
    lines.push("");
    for (const d of visible) {
      lines.push(`- **${d.severity.toUpperCase()}** · _${d.area}_ · ${d.message}`);
      lines.push(`  - Local: \`${d.local_value}\``);
      lines.push(`  - Backend: \`${d.backend_value}\``);
    }
    if (hidden > 0) {
      lines.push("");
      lines.push(
        `_…and ${hidden} more drift detail${hidden === 1 ? "" : "s"} omitted._`,
      );
    }
  }
  lines.push("");
  lines.push(
    "_Diagnostic only. Backend remains the active validation source._",
  );
  lines.push("");
}

// ---------------------------------------------------------------------------
// Phase 3L — Export Readiness Boundary block
// ---------------------------------------------------------------------------

function _appendBoundarySection(
  lines: string[],
  boundary: ExportReadinessBoundary,
  boundarySourceMarker: string | null,
): void {
  lines.push("## Export Readiness Boundary");
  lines.push("");
  if (boundarySourceMarker) {
    lines.push(`_${boundarySourceMarker}_`);
    lines.push("");
  }
  lines.push(
    `- Diagnostic status: **${EXPORT_DIAGNOSTIC_STATUS_LABEL[boundary.diagnostic_status]}**`,
  );
  lines.push(
    `- Production export: \`${PRODUCTION_EXPORT_STATUS_LABEL[boundary.production_export_status]}\``,
  );
  lines.push(`- production_export_ready: **No**`);
  lines.push(`- diagnostic_only: \`true\``);
  lines.push("");
  lines.push(`**${boundary.operator_title}**`);
  lines.push("");
  lines.push(boundary.operator_message);
  lines.push("");
  lines.push("Reasons production export is unavailable:");
  for (const reason of boundary.reasons) {
    lines.push(
      `- ${EXPORT_READINESS_BOUNDARY_REASON_LABEL[reason]} (\`${reason}\`)`,
    );
  }
  lines.push("");
  lines.push("Next steps:");
  for (const step of boundary.next_steps) {
    lines.push(`- ${step}`);
  }
  lines.push("");
  lines.push(`_${boundary.developer_message}_`);
  lines.push("");
  lines.push("_Diagnostic clear does not mean production export ready._");
  lines.push("");
}

// ---------------------------------------------------------------------------
// Phase 4G — Export Run Draft block
// ---------------------------------------------------------------------------

const _DRAFT_STATUS_LABEL: Record<string, string> = {
  draft_clear: "Draft clear",
  needs_review: "Needs review",
  blocked: "Blocked",
  not_available: "Not available",
};

/**
 * Phase 4H — operator-friendly reason labels mirrored from
 * ``OperationalResolutionPreviewPanel._DRAFT_REASON_LABEL`` so the
 * report renders e.g. "No export engine (`no_export_engine`)"
 * instead of dumping raw codes that read as developer log entries
 * to operators. The raw code is preserved in backticks so technical
 * trace recipients can still grep the report.
 */
const _DRAFT_REASON_LABEL: Record<string, string> = {
  diagnostic_only_pipeline: "Diagnostic-only pipeline",
  no_export_engine: "No export engine",
  no_file_generation: "No export file generation",
  no_export_run_persistence: "No export run persistence",
  no_final_approval: "No final approval workflow",
  no_export_audit_trail: "No export run / audit trail",
  no_external_posting: "No external posting (ResMan / Yardi / AppFolio)",
  readiness_boundary_not_clear: "Readiness boundary not clear",
  profile_not_persisted: "Selected profile is not persisted",
  profile_validation_blocked: "Profile validation blocked",
  profile_validation_needs_review: "Profile validation needs review",
  no_rows_to_export: "No rows to export",
  row_issues_present: "Row issues present",
};

/** Cap on rendered next-step / reason items so paste-into-Slack
 *  doesn't blow past sensible message lengths. The backend never
 *  ships unbounded lists today, but defending the wire is cheap. */
const _DRAFT_LIST_CAP = 20;

function _appendExportRunDraftSection(
  lines: string[],
  draft: BackendExportRunDraftResult,
  draftSourceMarker: string | null,
  // Phase 4H — when ``true``, prepend a "Showing last evaluated
  // draft…" callout so paste-into-Slack recipients can see the
  // body verdict is older than the current backend state.
  stale: boolean,
  // Phase 4H — ISO timestamp of when ``draft`` was last loaded.
  // Surfaced as a "Last evaluated" line.
  lastUpdatedAt: string | null,
): void {
  lines.push("## Export Run Draft");
  lines.push("");
  if (draftSourceMarker) {
    lines.push(`_${draftSourceMarker}_`);
    lines.push("");
  }
  if (stale) {
    lines.push(
      "_Showing last evaluated draft. Production export remains unavailable._",
    );
    lines.push("");
  }
  if (lastUpdatedAt) {
    let label: string | null = null;
    try {
      const parsed = new Date(lastUpdatedAt);
      if (!Number.isNaN(parsed.getTime())) {
        label = parsed.toLocaleString();
      }
    } catch {
      label = null;
    }
    if (label) {
      lines.push(`- Last evaluated: ${label}`);
    }
  }
  // Hard-pinned literals — surface verbatim so the report is
  // honest about the draft contract regardless of status.
  const statusLabel = _DRAFT_STATUS_LABEL[draft.status] ?? draft.status;
  lines.push(`- Status: **${statusLabel}**`);
  lines.push("- draft_only: **Yes**");
  lines.push("- finalized: **No**");
  lines.push("- file_generated: **No**");
  lines.push("- download_available: **No**");
  lines.push("- production_export_ready: **No**");
  if (draft.selected_profile_id) {
    lines.push(`- Selected profile id: \`${draft.selected_profile_id}\``);
  }
  if (draft.selected_profile_source) {
    lines.push(
      `- Selected profile source: \`${draft.selected_profile_source}\``,
    );
  }
  lines.push(`- Rows: ${draft.row_count}`);
  lines.push(`- Blocked rows: ${draft.blocked_row_count}`);
  lines.push(`- Warning rows: ${draft.warning_row_count}`);
  lines.push("");
  lines.push(`**${draft.operator_title}**`);
  lines.push("");
  lines.push(draft.operator_message);
  lines.push("");

  if (draft.reasons.length > 0) {
    const visible = draft.reasons.slice(0, _DRAFT_LIST_CAP);
    const hidden = draft.reasons.length - visible.length;
    lines.push("Reasons:");
    for (const reason of visible) {
      // Phase 4H — operator-friendly label first, raw code in
      // backticks second. Falls back to the raw code when no
      // mapping exists so future backend reason codes still surface
      // honestly without a frontend release.
      const friendly = _DRAFT_REASON_LABEL[reason];
      if (friendly) {
        lines.push(`- ${friendly} (\`${reason}\`)`);
      } else {
        lines.push(`- \`${reason}\``);
      }
    }
    if (hidden > 0) {
      lines.push(
        `_…and ${hidden} more reason${hidden === 1 ? "" : "s"} omitted._`,
      );
    }
    lines.push("");
  }

  if (draft.next_steps.length > 0) {
    const visible = draft.next_steps.slice(0, _DRAFT_LIST_CAP);
    const hidden = draft.next_steps.length - visible.length;
    lines.push("Next steps:");
    for (const step of visible) {
      lines.push(`- ${step}`);
    }
    if (hidden > 0) {
      lines.push(
        `_…and ${hidden} more next step${hidden === 1 ? "" : "s"} omitted._`,
      );
    }
    lines.push("");
  }

  lines.push(`_${draft.developer_message}_`);
  lines.push("");
  // Disclaimers are always present on the backend; emit them
  // verbatim so the report's small print matches the panel.
  if (draft.disclaimers.length > 0) {
    for (const line of draft.disclaimers) {
      lines.push(`_${line}_`);
    }
    lines.push("");
  }
  lines.push("_Export draft clear does not mean production export ready._");
  lines.push("");
}

// ---------------------------------------------------------------------------
// Phase 5B — Persisted Draft Audit Record block
// ---------------------------------------------------------------------------

/**
 * Render the persisted draft / audit record section.
 *
 * Hard contract:
 *   * Always calls the id "audit record id" — never "export run id".
 *   * Always reaffirms "no export file generated" so a paste-into-
 *     Slack reader can't misread the section as proof of export.
 *   * NEVER emits any forbidden export / file / posting handle key
 *     names (``download_url`` / ``file_url`` / ``file_id`` /
 *     ``export_id`` / ``export_run_id`` / ``export_batch_id`` /
 *     ``posted_at`` / ``external_posting_id`` / ``finalized_at`` /
 *     ``exported_at``). The persisted record's
 *     ``draft_snapshot`` is hard-pinned by Pydantic so the
 *     ``finalized: **No**`` / ``file_generated: **No**`` /
 *     ``download_available: **No**`` /
 *     ``production_export_ready: **No**`` lines are always honest.
 *   * When ``staleAfterSave`` is true, prepends a clear notice that
 *     the diagnostic preview has changed since the audit record
 *     was saved. The existing record is NOT updated automatically;
 *     the operator must save again.
 */
function _appendPersistedExportRunSection(
  lines: string[],
  record: PersistedExportRunRead,
  sourceMarker: string | null,
  staleAfterSave: boolean,
): void {
  lines.push("## Persisted Draft Audit Record");
  lines.push("");
  if (sourceMarker) {
    lines.push(`_${sourceMarker}_`);
    lines.push("");
  }
  if (staleAfterSave) {
    lines.push(
      "_Current preview changed after save. Save again to create a " +
        "new audit record; the existing record was not modified._",
    );
    lines.push("");
  }
  // Localised created-at timestamp. Defensive try/catch around
  // Date.parse so a malformed ISO string never breaks the report.
  let createdAtLabel: string | null = null;
  try {
    const parsed = new Date(record.created_at);
    if (!Number.isNaN(parsed.getTime())) {
      createdAtLabel = parsed.toLocaleString();
    }
  } catch {
    createdAtLabel = null;
  }
  // ---- Identity + lifecycle ------------------------------------
  lines.push(`- Audit record id: \`${record.id}\``);
  lines.push(`- Phase: \`${record.phase}\``);
  const statusLabel =
    _DRAFT_STATUS_LABEL[record.status] ?? record.status;
  lines.push(`- Status: **${statusLabel}**`);
  lines.push(`- Source: \`${record.source}\``);
  if (createdAtLabel) {
    lines.push(`- Created at: ${createdAtLabel}`);
  }

  // ---- Profile snapshot ----------------------------------------
  if (record.export_profile_name) {
    const versionTag =
      record.export_profile_version != null
        ? ` (v${record.export_profile_version})`
        : "";
    lines.push(
      `- Export profile: ${record.export_profile_name}${versionTag}`,
    );
  }
  if (record.target_system) {
    lines.push(`- Target system: \`${record.target_system}\``);
  }

  // ---- Row counts ----------------------------------------------
  lines.push(
    `- Rows: ${record.row_count} · blocked: ${record.blocked_row_count} · ` +
      `warning: ${record.warning_row_count} · issues: ${record.issue_count}`,
  );

  // ---- Hard-pinned literals from the embedded snapshot ---------
  // The persisted snapshot is the canonical Phase 4F verdict; the
  // backend re-validates the literals on write so the panel can
  // surface them verbatim without a defensive re-check.
  lines.push("- draft_only: **Yes**");
  lines.push("- finalized: **No**");
  lines.push("- file_generated: **No**");
  lines.push("- download_available: **No**");
  lines.push("- production_export_ready: **No**");

  // ---- Notes ---------------------------------------------------
  if (record.notes && record.notes.trim().length > 0) {
    lines.push("");
    lines.push("Notes:");
    lines.push("");
    lines.push(`> ${record.notes.trim()}`);
  }

  // ---- Disclaimers ---------------------------------------------
  lines.push("");
  lines.push(
    "_This id is an audit record id, not a finalized export id._",
  );
  lines.push("_No export file was generated._");
  lines.push("_No finalized export run was created._");
  lines.push(
    "_No document, batch, or template was marked exported._",
  );
  lines.push("");
}
