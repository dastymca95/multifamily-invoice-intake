/**
 * Phase 3F — Export Profile validation.
 *
 * Pure helper that checks an Export Profile contract against the
 * Phase 3E ``OperationalExportPreview``. Returns a typed result
 * the panel renders directly.
 *
 * Hard contract:
 *
 *   * Pure + deterministic — no React, no DOM, no API.
 *   * Diagnostic only — never claims production export readiness.
 *   * Never weakens resolver verdicts: a cell the resolver said
 *     was blocked / conflict still surfaces as ``blocked`` here.
 *   * Never mutates ``preview`` or ``profile``.
 *
 * Output severity bands:
 *
 *   blocked       — at least one issue with severity ``blocked``
 *   conflict      — only when every blocker is a conflict
 *   needs_review  — at least one warning, no blockers
 *   clear         — no issues
 */

import type {
  OperationalExportPreview,
  OperationalExportPreviewCell,
  OperationalExportPreviewColumn,
  OperationalExportPreviewRow,
} from "./operational-export-preview";

import {
  findPreviewColumnForProfileColumn,
  type ExportProfile,
  type ExportProfileColumn,
  type ExportProfileColumnDataType,
  type ExportProfileDateFormat,
} from "./export-profile-contract";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ExportProfileIssueSeverity =
  | "blocked"
  | "warning"
  | "info"
  | "clear";

export type ExportProfileIssueCode =
  | "PROFILE_REQUIRED_COLUMN_MISSING"
  | "PROFILE_REQUIRED_VALUE_MISSING"
  | "PROFILE_CELL_BLOCKED"
  | "PROFILE_CELL_CONFLICT"
  | "PROFILE_CELL_NEEDS_REVIEW"
  | "PROFILE_DATE_FORMAT_CHECK_FAILED"
  | "PROFILE_AMOUNT_FORMAT_CHECK_FAILED"
  | "PROFILE_ALLOWED_VALUE_FAILED"
  | "PROFILE_MAX_LENGTH_EXCEEDED"
  | "PROFILE_COLUMN_UNMAPPED"
  | "PROFILE_PREVIEW_HAS_NO_ROWS";

export interface ExportProfileIssue {
  severity: ExportProfileIssueSeverity;
  code: ExportProfileIssueCode;
  message: string;
  recommendation: string;
  /** When set, identifies the offending preview row (1-based as
   *  shown in the UI; we keep ``row_index`` raw + 0-based for
   *  parity with ``OperationalExportPreviewRow.row_index``). */
  row_index?: number | null;
  /** Identifier of the matched preview column, when applicable. */
  column_key?: string | null;
  /** Identifier of the offending profile column, when applicable. */
  profile_column_key?: string | null;
  /** Best-known source preview column key (after alias matching). */
  source_column_key?: string | null;
}

export interface ExportProfileColumnResult {
  profile_column_key: string;
  profile_column_label: string;
  /** Whether the profile column matched a preview column at all. */
  matched: boolean;
  matched_preview_column_key: string | null;
  matched_preview_column_label: string | null;
  required: boolean;
  /** Number of validation issues attributed to THIS profile column. */
  issue_count: number;
  /** Worst severity of issues attributed to THIS profile column. */
  worst_severity: ExportProfileIssueSeverity;
}

export interface ExportProfileRowResult {
  row_index: number;
  /** Validation issues attributed to THIS preview row. */
  issue_count: number;
  worst_severity: ExportProfileIssueSeverity;
}

export type ExportProfileValidationStatus =
  | "clear"
  | "needs_review"
  | "blocked"
  | "conflict";

export interface ExportProfileValidationSummary {
  /** Total counts across all issue lists. */
  blocked_count: number;
  warning_count: number;
  info_count: number;
  /** How many profile columns matched a preview column. */
  matched_columns: number;
  /** Profile columns that did NOT match a preview column. */
  unmapped_columns: number;
  /** How many preview rows had at least one validation issue. */
  rows_with_issues: number;
  /** How many preview rows had at least one BLOCKING issue. */
  rows_blocked: number;
}

export interface ExportProfileValidationResult {
  status: ExportProfileValidationStatus;
  profile_id: string;
  profile_name: string;
  target_system: ExportProfile["target_system"];
  summary: ExportProfileValidationSummary;
  issues: ExportProfileIssue[];
  column_results: ExportProfileColumnResult[];
  row_results: ExportProfileRowResult[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an export-style preview against the supplied profile.
 *
 * Walking strategy:
 *
 *   1. For every profile column, find the matching preview column
 *      (via the contract module's matcher).
 *   2. Required + unmatched → ``PROFILE_REQUIRED_COLUMN_MISSING``
 *      (blocked).
 *   3. Optional + unmatched → ``PROFILE_COLUMN_UNMAPPED`` (info).
 *   4. For matched columns, walk every preview row and validate
 *      the resolved cell:
 *        * blocked / conflict cell → blocked issue
 *        * warning cell → needs_review issue
 *        * required + missing/blank → blocked issue
 *        * data_type=date + value present → best-effort format check
 *        * data_type=amount/decimal/integer + value present → best-effort
 *          numeric check
 *        * allowed_values mismatch → blocked when required, warning otherwise
 *        * max_length exceeded → warning
 *
 * Empty preview → ``PROFILE_PREVIEW_HAS_NO_ROWS`` (blocked).
 */
export function validateExportPreviewAgainstProfile(
  preview: OperationalExportPreview,
  profile: ExportProfile,
): ExportProfileValidationResult {
  const issues: ExportProfileIssue[] = [];
  const columnResults: ExportProfileColumnResult[] = [];
  const rowIssueCounts = new Map<number, { count: number; worst: ExportProfileIssueSeverity }>();
  const columnIssueRollup = new Map<string, { count: number; worst: ExportProfileIssueSeverity }>();

  const trackRow = (rowIndex: number, severity: ExportProfileIssueSeverity) => {
    const cur = rowIssueCounts.get(rowIndex) ?? { count: 0, worst: "clear" };
    cur.count += 1;
    cur.worst = _maxSeverity(cur.worst, severity);
    rowIssueCounts.set(rowIndex, cur);
  };
  const trackColumn = (
    profileColumnKey: string,
    severity: ExportProfileIssueSeverity,
  ) => {
    const cur = columnIssueRollup.get(profileColumnKey) ?? { count: 0, worst: "clear" };
    cur.count += 1;
    cur.worst = _maxSeverity(cur.worst, severity);
    columnIssueRollup.set(profileColumnKey, cur);
  };
  const pushIssue = (issue: ExportProfileIssue) => {
    issues.push(issue);
    if (issue.row_index != null) trackRow(issue.row_index, issue.severity);
    if (issue.profile_column_key) {
      trackColumn(issue.profile_column_key, issue.severity);
    }
  };

  // -- Empty preview short-circuit --------------------------------
  if (preview.rows.length === 0 || preview.columns.length === 0) {
    pushIssue({
      severity: "blocked",
      code: "PROFILE_PREVIEW_HAS_NO_ROWS",
      message: "The preview has no rows to validate.",
      recommendation:
        "Run a preview with enough invoice facts and template rules to produce export-style rows.",
    });
  }

  // -- Per-column walk --------------------------------------------
  for (const profileColumn of profile.columns) {
    const matched = findPreviewColumnForProfileColumn(
      profileColumn,
      preview.columns,
    );
    columnResults.push({
      profile_column_key: profileColumn.key,
      profile_column_label: profileColumn.label,
      matched: matched != null,
      matched_preview_column_key: matched?.key ?? null,
      matched_preview_column_label: matched?.label ?? null,
      required: profileColumn.required,
      // Filled in below from columnIssueRollup.
      issue_count: 0,
      worst_severity: "clear",
    });

    if (!matched) {
      if (profileColumn.required) {
        pushIssue({
          severity: "blocked",
          code: "PROFILE_REQUIRED_COLUMN_MISSING",
          message: `Required column "${profileColumn.label}" is not in the preview.`,
          recommendation:
            "Add the column to the Import Template, or change the export profile to not require it.",
          profile_column_key: profileColumn.key,
        });
      } else {
        pushIssue({
          severity: "info",
          code: "PROFILE_COLUMN_UNMAPPED",
          message: `Optional column "${profileColumn.label}" is not in the preview.`,
          recommendation:
            "Add the column to the Import Template, or accept the gap if your downstream system doesn't need it.",
          profile_column_key: profileColumn.key,
        });
      }
      continue;
    }

    // Walk every preview row's cell for this matched column.
    for (const row of preview.rows) {
      const cell = row.cells.find((c) => c.column_key === matched.key);
      const baseRef = {
        row_index: row.row_index,
        column_key: matched.key,
        profile_column_key: profileColumn.key,
        source_column_key: matched.key,
      } as const;
      _validateCellAgainstProfileColumn({
        row,
        cell,
        profileColumn,
        profileDateFormat: profile.settings.date_format,
        baseRef,
        push: pushIssue,
      });
    }
  }

  // -- Roll up per-column issue counts ----------------------------
  for (const colResult of columnResults) {
    const rollup = columnIssueRollup.get(colResult.profile_column_key);
    if (rollup) {
      colResult.issue_count = rollup.count;
      colResult.worst_severity = rollup.worst;
    }
  }

  // -- Build row results ------------------------------------------
  const rowResults: ExportProfileRowResult[] = preview.rows.map((row) => {
    const r = rowIssueCounts.get(row.row_index);
    return {
      row_index: row.row_index,
      issue_count: r?.count ?? 0,
      worst_severity: r?.worst ?? "clear",
    };
  });

  // -- Summary + status -------------------------------------------
  let blocked_count = 0;
  let warning_count = 0;
  let info_count = 0;
  for (const issue of issues) {
    if (issue.severity === "blocked") blocked_count += 1;
    else if (issue.severity === "warning") warning_count += 1;
    else if (issue.severity === "info") info_count += 1;
  }
  const matched_columns = columnResults.filter((c) => c.matched).length;
  const unmapped_columns = columnResults.length - matched_columns;
  let rows_with_issues = 0;
  let rows_blocked = 0;
  for (const r of rowResults) {
    if (r.issue_count > 0) rows_with_issues += 1;
    if (r.worst_severity === "blocked") rows_blocked += 1;
  }

  // Status — the spec calls for ``conflict`` only when every
  // blocker is a conflict. We don't track conflict separately at
  // the issue level today (cell.conflict is folded into "blocked"
  // via PROFILE_CELL_BLOCKED), so use the preview's conflict count
  // as a tiebreaker.
  let status: ExportProfileValidationStatus;
  if (blocked_count > 0) {
    const allBlockersAreConflicts =
      preview.blocked_row_count === 0 &&
      preview.conflict_row_count > 0 &&
      blocked_count <= preview.conflict_row_count + 0; // simple heuristic
    status = allBlockersAreConflicts ? "conflict" : "blocked";
  } else if (warning_count > 0) {
    status = "needs_review";
  } else {
    status = "clear";
  }

  return {
    status,
    profile_id: profile.id,
    profile_name: profile.name,
    target_system: profile.target_system,
    summary: {
      blocked_count,
      warning_count,
      info_count,
      matched_columns,
      unmapped_columns,
      rows_with_issues,
      rows_blocked,
    },
    issues,
    column_results: columnResults,
    row_results: rowResults,
  };
}

/**
 * Coerce an arbitrary severity string into the four-band UI
 * vocabulary. Used by the panel + report; exported so future
 * surfaces don't re-derive the mapping.
 */
export function normalizeProfileIssueSeverity(
  raw: string | null | undefined,
): ExportProfileIssueSeverity {
  if (raw === "blocked" || raw === "warning" || raw === "info" || raw === "clear") {
    return raw;
  }
  return "warning";
}

/**
 * Convenience helper — exposes the severity sort order without
 * forcing callers to import `_maxSeverity`.
 */
export function getProfileSeverityRank(
  severity: ExportProfileIssueSeverity,
): number {
  switch (severity) {
    case "blocked":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
    case "clear":
      return 3;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface _ValidateCellArgs {
  row: OperationalExportPreviewRow;
  cell: OperationalExportPreviewCell | undefined;
  profileColumn: ExportProfileColumn;
  profileDateFormat: ExportProfileDateFormat;
  baseRef: {
    readonly row_index: number;
    readonly column_key: string;
    readonly profile_column_key: string;
    readonly source_column_key: string;
  };
  push: (issue: ExportProfileIssue) => void;
}

function _validateCellAgainstProfileColumn(args: _ValidateCellArgs): void {
  const { row, cell, profileColumn, profileDateFormat, baseRef, push } = args;

  // No cell at all means the resolver omitted this column for this
  // row. Treat as missing — required → blocked, optional → quiet.
  if (!cell) {
    if (profileColumn.required) {
      push({
        severity: "blocked",
        code: "PROFILE_REQUIRED_VALUE_MISSING",
        message: `Required column "${profileColumn.label}" has no cell on row ${row.row_index + 1}.`,
        recommendation:
          "Provide a default value, fix the rule, or supply the missing extracted fact / catalog hint.",
        ...baseRef,
      });
    }
    return;
  }

  // Resolver-side hard verdicts always surface — never weakened.
  if (cell.blocked) {
    push({
      severity: "blocked",
      code: "PROFILE_CELL_BLOCKED",
      message: `"${profileColumn.label}" is blocked on row ${row.row_index + 1}.`,
      recommendation:
        "Fix the underlying resolver issue (see the Review Diagnostics above).",
      ...baseRef,
    });
    return;
  }
  if (cell.conflict) {
    push({
      severity: "blocked",
      code: "PROFILE_CELL_CONFLICT",
      message: `"${profileColumn.label}" has a conflict on row ${row.row_index + 1}.`,
      recommendation:
        "Resolve the conflicting source values before exporting.",
      ...baseRef,
    });
    return;
  }
  if (cell.warning) {
    push({
      severity: "warning",
      code: "PROFILE_CELL_NEEDS_REVIEW",
      message: `"${profileColumn.label}" needs review on row ${row.row_index + 1}.`,
      recommendation:
        "Confirm the value before exporting — see the Review Diagnostics above.",
      ...baseRef,
    });
    // Don't ``return`` — still run optional format checks below.
  }

  // Required + missing.
  const isMissing = cell.missing || cell.display_value == null;
  if (profileColumn.required && isMissing) {
    push({
      severity: "blocked",
      code: "PROFILE_REQUIRED_VALUE_MISSING",
      message: `Required column "${profileColumn.label}" is missing on row ${row.row_index + 1}.`,
      recommendation:
        "Provide a default value, fix the rule, or supply the missing extracted fact / catalog hint.",
      ...baseRef,
    });
    return;
  }

  // Optional + missing — nothing more to validate.
  if (isMissing) return;

  const valueText = String(cell.display_value);

  // Data-type checks — best-effort, lenient. Failures are warnings
  // when optional and warnings when required (the required gate
  // already forced a blocking missing-value issue above when the
  // value was empty).
  if (profileColumn.data_type === "date") {
    if (!_looksLikeDate(valueText, profileColumn.format ?? profileDateFormat)) {
      push({
        severity: "warning",
        code: "PROFILE_DATE_FORMAT_CHECK_FAILED",
        message: `"${profileColumn.label}" on row ${row.row_index + 1} doesn't look like a date.`,
        recommendation:
          "Confirm the value is a valid date in the profile's date format, or update the column's data type.",
        ...baseRef,
      });
    }
  } else if (
    profileColumn.data_type === "amount" ||
    profileColumn.data_type === "decimal" ||
    profileColumn.data_type === "integer"
  ) {
    if (!_looksLikeNumber(valueText, profileColumn.data_type)) {
      push({
        severity: "warning",
        code: "PROFILE_AMOUNT_FORMAT_CHECK_FAILED",
        message: `"${profileColumn.label}" on row ${row.row_index + 1} doesn't look numeric.`,
        recommendation:
          "Confirm the value is a number, or update the column's data type / format rule.",
        ...baseRef,
      });
    }
  }

  // Allowed values check.
  if (profileColumn.allowed_values && profileColumn.allowed_values.length > 0) {
    const matches = profileColumn.allowed_values.some(
      (allowed) => allowed.toLowerCase() === valueText.toLowerCase(),
    );
    if (!matches) {
      push({
        severity: profileColumn.required ? "blocked" : "warning",
        code: "PROFILE_ALLOWED_VALUE_FAILED",
        message: `"${profileColumn.label}" on row ${row.row_index + 1} is not one of the allowed values.`,
        recommendation: `Use one of: ${profileColumn.allowed_values.join(", ")}.`,
        ...baseRef,
      });
    }
  }

  // Max length check.
  if (
    typeof profileColumn.max_length === "number" &&
    valueText.length > profileColumn.max_length
  ) {
    push({
      severity: "warning",
      code: "PROFILE_MAX_LENGTH_EXCEEDED",
      message: `"${profileColumn.label}" on row ${row.row_index + 1} exceeds the profile's max length (${profileColumn.max_length}).`,
      recommendation:
        "Trim the value, increase the profile's max length, or change the source mapping.",
      ...baseRef,
    });
  }
}

function _looksLikeDate(value: string, format: string): boolean {
  // Best-effort — accept anything ``Date.parse`` can parse OR any
  // common American/ISO digit-grouped format. The date_format hint
  // is informational; we don't strict-parse against it (the
  // backend / production export engine will).
  if (Date.parse(value)) return true;
  // Accept M/D/YYYY, MM/DD/YYYY, YYYY-MM-DD, DD/MM/YYYY, D-M-YYYY etc.
  if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(value.trim())) return true;
  void format; // Reserved for stricter parsing later.
  return false;
}

function _looksLikeNumber(value: string, kind: ExportProfileColumnDataType): boolean {
  // Strip currency / commas / parentheses (negative) before parsing.
  const cleaned = value
    .trim()
    .replace(/^\(/, "-")
    .replace(/\)$/, "")
    .replace(/[$,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return false;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return false;
  if (kind === "integer" && !Number.isInteger(n)) return false;
  return true;
}

function _maxSeverity(
  a: ExportProfileIssueSeverity,
  b: ExportProfileIssueSeverity,
): ExportProfileIssueSeverity {
  return getProfileSeverityRank(a) <= getProfileSeverityRank(b) ? a : b;
}
