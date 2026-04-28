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
