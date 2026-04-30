/**
 * Phase 3F — Export Profile validation Markdown report.
 *
 * Pure helper that emits a Markdown blob describing a profile
 * check (selected profile + settings + validation result + column
 * mapping + issues). Operators paste it into Slack / email / a
 * support ticket.
 *
 * Diagnostic only — header, body, and footer all say so. NO
 * export file is generated; this is a clipboard artefact, not an
 * export artefact.
 *
 * Re-exports the existing Phase 2H ``copyTextToClipboard`` so the
 * panel imports both report + clipboard from one module without
 * taking a direct dependency on the Pattern Test reports module.
 */

import type { OperationalResolutionResult } from "@/types/operational-resolution";

import type { OperationalExportPreview } from "./operational-export-preview";
import type {
  ExportProfile,
  ExportProfileColumn,
  ExportProfileSettings,
  ExportTargetSystem,
} from "./export-profile-contract";
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

// Re-export the existing Phase 2H clipboard helper so the panel
// can import everything report-related from a single module.
export { copyTextToClipboard } from "./pattern-test-reports";

// ---------------------------------------------------------------------------
// Public report builder
// ---------------------------------------------------------------------------

export interface ExportProfileValidationReportArgs {
  result: OperationalResolutionResult;
  preview: OperationalExportPreview;
  profile: ExportProfile;
  validation: ExportProfileValidationResult;
  /** Optional one-line context label, e.g. "Document: epb-march.pdf"
   *  passed in from the launch surface. */
  contextLabel?: string | null;
  /** Override generation time — useful in tests / deterministic snapshots. */
  generatedAt?: Date;
  /** Phase 3J — single-line marker describing the validation
   *  source (Backend verified / Local estimate / etc.). When
   *  provided, surfaced in the header so a paste-into-Slack
   *  workflow makes the verdict's provenance visible. */
  validationSourceMarker?: string | null;
  /** Phase 3K — parity diagnostic comparing local vs backend.
   *  Surfaced as a "Validation Source Audit" section. Diagnostic
   *  only — never overrides the displayed verdict. */
  parityResult?: ExportValidationParityResult | null;
  /** Phase 3L — explicit boundary contract describing the gap to
   *  a future production export. Surfaced as an "Export Readiness
   *  Boundary" section. ALWAYS carries
   *  ``production_export_ready: false`` — the section never claims
   *  production readiness regardless of diagnostic status. */
   readinessBoundary?: ExportReadinessBoundary | null;
  /** Phase 3N — single-line marker describing the boundary source
   *  (Backend boundary verified / Local estimate / etc.). Surfaced
   *  inside the boundary section so a paste-into-Slack reader
   *  knows whether the boundary verdict is backend-verified or a
   *  local fallback. Only emitted when ``readinessBoundary`` is
   *  also provided. */
  boundarySourceMarker?: string | null;
  /** Phase 4B — single-line marker describing the profile source
   *  (Saved profile / Built-in starter). Surfaced in the header
   *  so a paste-into-Slack reader knows whether the verdict is
   *  reading a backend catalog row or a built-in starter, plus
   *  whether the saved-profile contract is mid-load. */
  profileSourceMarker?: string | null;
}

const SEVERITY_LABEL: Record<ExportProfileIssueSeverity, string> = {
  blocked: "Blocked",
  warning: "Needs review",
  info: "Info",
  clear: "Clear",
};

const STATUS_LABEL: Record<
  ExportProfileValidationResult["status"],
  string
> = {
  clear: "No blocking issues in this diagnostic profile check",
  needs_review: "Needs review",
  blocked: "Blocked",
  conflict: "Conflict",
};

/**
 * Build the Markdown report. Sections:
 *
 *   1. Header (template, pattern, document/batch, generated stamp,
 *      diagnostic-only notice)
 *   2. Profile metadata (name, target system, description, settings)
 *   3. Validation summary (status + counts)
 *   4. Column mapping table
 *   5. Issues list grouped by severity
 *   6. Footer reminder that no export file was generated
 */
export function buildExportProfileValidationMarkdownReport(
  args: ExportProfileValidationReportArgs,
): string {
  const { result, preview, profile, validation } = args;
  const ts = (args.generatedAt ?? new Date()).toLocaleString();
  const lines: string[] = [];

  lines.push("# Rivera Operational Preview · Export Profile Check");
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
  if (args.validationSourceMarker) {
    lines.push(`**${args.validationSourceMarker}**`);
  }
  if (args.profileSourceMarker) {
    lines.push(`**${args.profileSourceMarker}**`);
  }
  lines.push("");
  lines.push(
    "_Diagnostic profile check only. No export file was generated, no Review Queue records were created, and no document, batch, template, or reference data was modified._",
  );
  lines.push("");

  // -- Profile metadata ------------------------------------------
  lines.push("## Profile");
  lines.push("");
  lines.push(`- Name: **${profile.name}**`);
  lines.push(`- Target system: \`${profile.target_system}\``);
  lines.push(`- Description: ${profile.description}`);
  lines.push("");
  _appendSettings(lines, profile.settings);
  lines.push("");

  // -- Validation summary ----------------------------------------
  const summary = validation.summary;
  lines.push("## Validation summary");
  lines.push("");
  lines.push(`- Status: **${STATUS_LABEL[validation.status]}**`);
  lines.push(`- Blocked issues: ${summary.blocked_count}`);
  lines.push(`- Needs-review issues: ${summary.warning_count}`);
  lines.push(`- Info issues: ${summary.info_count}`);
  lines.push(
    `- Profile columns matched: ${summary.matched_columns} / ${profile.columns.length}`,
  );
  lines.push(`- Profile columns unmapped: ${summary.unmapped_columns}`);
  lines.push(`- Preview rows with issues: ${summary.rows_with_issues}`);
  lines.push(`- Preview rows blocked: ${summary.rows_blocked}`);
  lines.push("");

  // -- Column mapping --------------------------------------------
  lines.push("## Column mapping");
  lines.push("");
  if (validation.column_results.length === 0) {
    lines.push("_No profile columns to validate._");
    lines.push("");
  } else {
    lines.push("| Profile column | Required | Matched preview column | Issues | Worst severity |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const col of validation.column_results) {
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
          ` | ${col.issue_count} | ${SEVERITY_LABEL[col.worst_severity]} |`,
      );
    }
    lines.push("");
  }

  // -- Issues -----------------------------------------------------
  if (validation.issues.length === 0) {
    lines.push("## Issues");
    lines.push("");
    lines.push("_No issues raised by the profile check._");
    lines.push("");
  } else {
    lines.push("## Issues");
    lines.push("");
    const grouped: Array<[ExportProfileIssueSeverity, ExportProfileIssue[]]> = [
      ["blocked", validation.issues.filter((i) => i.severity === "blocked")],
      ["warning", validation.issues.filter((i) => i.severity === "warning")],
      ["info", validation.issues.filter((i) => i.severity === "info")],
    ];
    for (const [sev, items] of grouped) {
      if (items.length === 0) continue;
      lines.push(`### ${SEVERITY_LABEL[sev]}`);
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
  }

  // -- Export Readiness Boundary (Phase 3L + 3N) ------------------
  // Surfaced before the parity audit so a paste-into-Slack reader
  // sees the boundary contract before the technical drift block.
  // Phase 3N — also receives the optional source marker so the
  // boundary section announces whether the verdict is backend-
  // verified or a local fallback.
  if (args.readinessBoundary) {
    _appendBoundarySection(
      lines,
      args.readinessBoundary,
      args.boundarySourceMarker ?? null,
    );
  }

  // -- Validation Source Audit (Phase 3K) -------------------------
  if (args.parityResult) {
    _appendParitySection(lines, args.parityResult);
  }

  // -- Footer reminder --------------------------------------------
  lines.push("---");
  lines.push("");
  lines.push("_This is a diagnostic profile check. No export file was generated._");
  lines.push("_Future production export depends on final export profiles and validation._");

  // Reserved for future use — silences "preview unused" lint while
  // keeping the arg in the public contract.
  void preview;
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 3K — Validation Source Audit Markdown block
// ---------------------------------------------------------------------------

const PARITY_STATUS_LABEL: Record<
  ExportValidationParityResult["status"],
  string
> = {
  aligned: "Aligned",
  minor_drift: "Minor drift",
  major_drift: "Major drift",
  not_checked: "Not checked",
};

/** Cap on rendered drift details so paste-into-Slack doesn't
 *  blow past sensible message lengths. */
const PARITY_DIFFERENCE_CAP = 20;

function _appendParitySection(
  lines: string[],
  parity: ExportValidationParityResult,
): void {
  lines.push("## Validation Source Audit");
  lines.push("");
  lines.push(`- Status: **${PARITY_STATUS_LABEL[parity.status]}**`);
  lines.push(`- Checked: ${parity.checked ? "yes" : "no"}`);
  lines.push(`- Local status: \`${parity.local_status ?? "—"}\``);
  lines.push(`- Backend status: \`${parity.backend_status ?? "—"}\``);
  lines.push(`- Local issue count: ${parity.local_issue_count}`);
  lines.push(`- Backend issue count: ${parity.backend_issue_count}`);
  lines.push(`- Compared at: ${parity.compared_at}`);
  // Summary booleans — give support a quick glance at which axis drifted.
  lines.push("");
  lines.push("Summary breakdown:");
  lines.push(`- Status matches: ${_yn(parity.summary.status_matches)}`);
  lines.push(`- Blocked count matches: ${_yn(parity.summary.blocked_count_matches)}`);
  lines.push(`- Warning count matches: ${_yn(parity.summary.warning_count_matches)}`);
  lines.push(`- Info count matches: ${_yn(parity.summary.info_count_matches)}`);
  lines.push(`- Issue code set matches: ${_yn(parity.summary.issue_code_set_matches)}`);
  lines.push(`- Column mapping matches: ${_yn(parity.summary.column_mapping_matches)}`);
  lines.push(`- Row results match: ${_yn(parity.summary.row_status_matches)}`);
  lines.push("");
  if (parity.differences.length === 0) {
    lines.push(
      "_No drift differences. Backend remains the source of truth._",
    );
  } else {
    const visible = parity.differences.slice(0, PARITY_DIFFERENCE_CAP);
    const hidden = parity.differences.length - visible.length;
    lines.push(`Top differences (${visible.length} of ${parity.differences.length}):`);
    lines.push("");
    for (const d of visible) {
      lines.push(`- **${d.severity.toUpperCase()}** · _${d.area}_ · ${d.message}`);
      lines.push(`  - Local: \`${d.local_value}\``);
      lines.push(`  - Backend: \`${d.backend_value}\``);
      lines.push(`  - Recommendation: ${d.recommendation}`);
    }
    if (hidden > 0) {
      lines.push("");
      lines.push(`_…and ${hidden} more drift detail${hidden === 1 ? "" : "s"} omitted._`);
    }
  }
  lines.push("");
  lines.push(
    "_Validation Source Audit is diagnostic only. Backend remains the active validation source when present._",
  );
  lines.push("");
}

function _yn(v: boolean): string {
  return v ? "yes" : "no";
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _appendSettings(lines: string[], settings: ExportProfileSettings): void {
  lines.push(`- Delimiter: \`${settings.delimiter}\``);
  lines.push(`- Include header: ${settings.include_header ? "yes" : "no"}`);
  lines.push(`- Quote strategy: \`${settings.quote_strategy}\``);
  lines.push(`- Newline: \`${settings.newline}\``);
  lines.push(`- Encoding: \`${settings.encoding}\``);
  lines.push(`- Date format: \`${settings.date_format}\``);
  lines.push(`- Amount format: \`${settings.amount_format}\``);
  if (settings.boolean_format) {
    lines.push(`- Boolean format: \`${settings.boolean_format}\``);
  }
  lines.push(`- Empty value policy: \`${settings.empty_value_policy}\``);
  lines.push(`- File naming preview: \`${settings.file_naming_preview}\``);
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

// Keep the column type re-exported for caller convenience — some
// future surfaces may want to render profile columns + report
// rendering side-by-side.
export type { ExportProfileColumn };

// Internal re-export so the contract's literal type stays accessible
// from a single import in the panel.
export type { ExportTargetSystem };

// ---------------------------------------------------------------------------
// Phase 3L — Export Readiness Boundary Markdown block
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
  lines.push("Reasons:");
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
  lines.push(`_${boundary.disclaimers.join(" "  )}_`);
  lines.push("");
}
