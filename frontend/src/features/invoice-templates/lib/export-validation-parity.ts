/**
 * Phase 3K — Export Validation Parity diagnostics.
 *
 * Pure deterministic comparison between:
 *
 *   * the Phase 3F local ``ExportProfileValidationResult``
 *   * the Phase 3J backend-adapted ``ExportProfileValidationResult``
 *     (already in local shape via ``backendValidationToLocalShape``)
 *
 * Backend remains the active validation source — this module ONLY
 * surfaces drift so developers / support can spot when the local
 * fallback is materially diverging from backend truth. It does NOT:
 *
 *   * Decide export readiness.
 *   * Override either result.
 *   * Block the operator.
 *   * Generate files / records / mutations of any kind.
 *
 * Design rules:
 *   * Pure / synchronous — no React, no DOM, no fetch.
 *   * Never mutates either input.
 *   * Tolerant of unknown/forward-compat values — never throws.
 *   * Order-insensitive: issue ordering, row ordering, column
 *     ordering are all collapsed before comparison.
 *   * Conservative: when in doubt, classify as ``minor_drift`` rather
 *     than over-claim alignment.
 */

import type { OperationalExportPreview } from "./operational-export-preview";
import type { ExportProfile } from "./export-profile-contract";
import type {
  ExportProfileColumnResult,
  ExportProfileIssue,
  ExportProfileIssueCode,
  ExportProfileIssueSeverity,
  ExportProfileRowResult,
  ExportProfileValidationResult,
  ExportProfileValidationStatus,
} from "./export-profile-validation";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ExportValidationParityStatus =
  | "aligned"
  | "minor_drift"
  | "major_drift"
  | "not_checked";

export type ExportValidationParityArea =
  | "status"
  | "summary"
  | "issue_codes"
  | "column_mapping"
  | "row_results"
  | "unknown";

export interface ExportValidationParityDifference {
  severity: "info" | "warning" | "blocked";
  area: ExportValidationParityArea;
  message: string;
  /** Stringified value from the local validator (for paste-into-Slack). */
  local_value: string;
  /** Stringified value from the backend validator. */
  backend_value: string;
  recommendation: string;
}

export interface ExportValidationParitySummary {
  status_matches: boolean;
  blocked_count_matches: boolean;
  warning_count_matches: boolean;
  info_count_matches: boolean;
  issue_code_set_matches: boolean;
  column_mapping_matches: boolean;
  row_status_matches: boolean;
}

export interface ExportValidationParityResult {
  status: ExportValidationParityStatus;
  /** True when the comparison actually ran (vs. ``not_checked``). */
  checked: boolean;
  summary: ExportValidationParitySummary;
  differences: ExportValidationParityDifference[];
  /** ISO-ish stamp — uses ``new Date().toISOString()`` so reports
   *  paste cleanly. */
  compared_at: string;
  /** Status snapshots so the audit line / Markdown report can read
   *  them without re-walking the inputs. */
  local_status: ExportProfileValidationStatus | null;
  backend_status: ExportProfileValidationStatus | null;
  local_issue_count: number;
  backend_issue_count: number;
}

export interface CompareExportValidationResultsArgs {
  localValidation: ExportProfileValidationResult | null;
  backendValidation: ExportProfileValidationResult | null;
  /** Carried so a future enhancement can scope drift severity by
   *  profile (e.g. tighter rules for ResMan generic). Unused today. */
  profile?: ExportProfile | null;
  /** Carried for the same future-tightening reason. Unused today. */
  preview?: OperationalExportPreview | null;
  /** Optional override for tests / deterministic snapshots. */
  comparedAt?: Date;
}

// ---------------------------------------------------------------------------
// Public — main comparator
// ---------------------------------------------------------------------------

/**
 * Compare local vs backend validation results and emit a parity
 * verdict. Always returns a result — never throws.
 */
export function compareExportValidationResults(
  args: CompareExportValidationResultsArgs,
): ExportValidationParityResult {
  const { localValidation, backendValidation } = args;
  const compared_at = (args.comparedAt ?? new Date()).toISOString();

  // -- Not-checked short-circuits ----------------------------------------
  if (!localValidation || !backendValidation) {
    return {
      status: "not_checked",
      checked: false,
      summary: _emptyParitySummary(),
      differences: [],
      compared_at,
      local_status: localValidation?.status ?? null,
      backend_status: backendValidation?.status ?? null,
      local_issue_count: localValidation?.issues.length ?? 0,
      backend_issue_count: backendValidation?.issues.length ?? 0,
    };
  }
  // Profile id mismatch — these cannot be meaningfully compared.
  if (localValidation.profile_id !== backendValidation.profile_id) {
    return {
      status: "not_checked",
      checked: false,
      summary: _emptyParitySummary(),
      differences: [],
      compared_at,
      local_status: localValidation.status,
      backend_status: backendValidation.status,
      local_issue_count: localValidation.issues.length,
      backend_issue_count: backendValidation.issues.length,
    };
  }

  const differences: ExportValidationParityDifference[] = [];

  // -- A. Overall status ------------------------------------------------
  const statusMatches = localValidation.status === backendValidation.status;
  if (!statusMatches) {
    const downgrade = _isStatusDowngrade(
      localValidation.status,
      backendValidation.status,
    );
    differences.push({
      severity: downgrade ? "blocked" : "warning",
      area: "status",
      message: `Overall status differs (local=${localValidation.status}, backend=${backendValidation.status}).`,
      local_value: localValidation.status,
      backend_value: backendValidation.status,
      recommendation: downgrade
        ? "Backend reports a worse verdict than the local estimate. Investigate which validation rule is missing locally."
        : "Local and backend disagree on the overall verdict. Backend is the source of truth.",
    });
  }

  // -- B. Summary counts ------------------------------------------------
  const blockedMatches =
    localValidation.summary.blocked_count ===
    backendValidation.summary.blocked_count;
  const warningMatches =
    localValidation.summary.warning_count ===
    backendValidation.summary.warning_count;
  const infoMatches =
    localValidation.summary.info_count ===
    backendValidation.summary.info_count;

  if (!blockedMatches) {
    differences.push({
      severity: "warning",
      area: "summary",
      message: "Blocked-issue count differs.",
      local_value: String(localValidation.summary.blocked_count),
      backend_value: String(backendValidation.summary.blocked_count),
      recommendation:
        "Inspect the issue lists below; the local validator may be missing a blocking rule the backend enforces (or vice versa).",
    });
  }
  if (!warningMatches) {
    differences.push({
      severity: "info",
      area: "summary",
      message: "Needs-review issue count differs.",
      local_value: String(localValidation.summary.warning_count),
      backend_value: String(backendValidation.summary.warning_count),
      recommendation:
        "Likely a best-effort format check (date / amount / max-length) drifting between validators.",
    });
  }
  if (!infoMatches) {
    differences.push({
      severity: "info",
      area: "summary",
      message: "Info-issue count differs.",
      local_value: String(localValidation.summary.info_count),
      backend_value: String(backendValidation.summary.info_count),
      recommendation:
        "Optional unmapped column accounting differs between validators.",
    });
  }

  // -- C. Issue code sets -----------------------------------------------
  const localCodes = _collectIssueCodes(localValidation.issues);
  const backendCodes = _collectIssueCodes(backendValidation.issues);
  const issueCodeSetMatches = _setsEqual(localCodes, backendCodes);
  if (!issueCodeSetMatches) {
    const onlyLocal = _difference(localCodes, backendCodes);
    const onlyBackend = _difference(backendCodes, localCodes);
    if (onlyBackend.length > 0) {
      const blockingMissing = onlyBackend.filter(_isBlockingCode);
      differences.push({
        severity: blockingMissing.length > 0 ? "blocked" : "info",
        area: "issue_codes",
        message:
          blockingMissing.length > 0
            ? `Backend raised blocking issue codes the local estimate did not: ${blockingMissing.join(", ")}.`
            : `Backend raised additional issue codes the local estimate did not: ${onlyBackend.join(", ")}.`,
        local_value: "—",
        backend_value: onlyBackend.join(", "),
        recommendation:
          blockingMissing.length > 0
            ? "Local fallback under-reports blocking issues — backend remains source of truth. Track which rule needs porting locally."
            : "Local fallback under-reports informational signals. Backend remains source of truth.",
      });
    }
    if (onlyLocal.length > 0) {
      differences.push({
        severity: "info",
        area: "issue_codes",
        message: `Local estimate raised issue codes the backend did not: ${onlyLocal.join(", ")}.`,
        local_value: onlyLocal.join(", "),
        backend_value: "—",
        recommendation:
          "Local fallback may be over-reporting. Backend remains source of truth.",
      });
    }
  }

  // -- D. Column mapping ------------------------------------------------
  const columnMatches = _compareColumnMapping(
    localValidation.column_results,
    backendValidation.column_results,
    differences,
  );

  // -- E. Row results ---------------------------------------------------
  const rowMatches = _compareRowResults(
    localValidation.row_results,
    backendValidation.row_results,
    differences,
  );

  const summary: ExportValidationParitySummary = {
    status_matches: statusMatches,
    blocked_count_matches: blockedMatches,
    warning_count_matches: warningMatches,
    info_count_matches: infoMatches,
    issue_code_set_matches: issueCodeSetMatches,
    column_mapping_matches: columnMatches,
    row_status_matches: rowMatches,
  };

  // -- Roll up overall parity status ------------------------------------
  let status: ExportValidationParityStatus;
  const hasBlocked = differences.some((d) => d.severity === "blocked");
  const hasWarning = differences.some((d) => d.severity === "warning");
  if (hasBlocked) status = "major_drift";
  else if (hasWarning || !issueCodeSetMatches) status = "minor_drift";
  else if (
    !statusMatches ||
    !blockedMatches ||
    !warningMatches ||
    !infoMatches ||
    !columnMatches ||
    !rowMatches
  ) {
    status = "minor_drift";
  } else {
    status = "aligned";
  }

  return {
    status,
    checked: true,
    summary,
    differences,
    compared_at,
    local_status: localValidation.status,
    backend_status: backendValidation.status,
    local_issue_count: localValidation.issues.length,
    backend_issue_count: backendValidation.issues.length,
  };
}

/**
 * One-line operator-friendly summary suitable for the small audit
 * note in the panel + the report header.
 */
export function summarizeExportValidationParity(
  parity: ExportValidationParityResult | null,
): string {
  if (!parity || parity.status === "not_checked") {
    return "Source audit not checked.";
  }
  switch (parity.status) {
    case "aligned":
      return "Source audit: backend and local estimate are aligned.";
    case "minor_drift":
      return "Source audit: backend and local estimate differ slightly. Backend result is shown.";
    case "major_drift":
      return "Source audit: backend and local estimate disagree. Backend result is shown.";
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _emptyParitySummary(): ExportValidationParitySummary {
  return {
    status_matches: false,
    blocked_count_matches: false,
    warning_count_matches: false,
    info_count_matches: false,
    issue_code_set_matches: false,
    column_mapping_matches: false,
    row_status_matches: false,
  };
}

function _collectIssueCodes(
  issues: ExportProfileIssue[],
): Set<ExportProfileIssueCode> {
  const out = new Set<ExportProfileIssueCode>();
  for (const i of issues) out.add(i.code);
  return out;
}

function _setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  // Array.from to avoid Set iteration target-compat issues.
  const list = Array.from(a);
  for (const v of list) {
    if (!b.has(v)) return false;
  }
  return true;
}

function _difference<T>(a: Set<T>, b: Set<T>): T[] {
  const out: T[] = [];
  const list = Array.from(a);
  for (const v of list) {
    if (!b.has(v)) out.push(v);
  }
  // Stable sort — output order is operator-facing.
  return out.slice().sort();
}

function _isBlockingCode(code: ExportProfileIssueCode): boolean {
  return (
    code === "PROFILE_REQUIRED_COLUMN_MISSING" ||
    code === "PROFILE_REQUIRED_VALUE_MISSING" ||
    code === "PROFILE_CELL_BLOCKED" ||
    code === "PROFILE_CELL_CONFLICT" ||
    code === "PROFILE_PREVIEW_HAS_NO_ROWS" ||
    // Allowed-value failures are blocking when on a required column.
    // We don't have ``required`` here without re-walking, so treat
    // the code itself as potentially blocking. Conservative.
    code === "PROFILE_ALLOWED_VALUE_FAILED"
  );
}

const _STATUS_RANK: Record<ExportProfileValidationStatus, number> = {
  // Higher = worse.
  clear: 0,
  needs_review: 1,
  blocked: 2,
  conflict: 3,
};

function _isStatusDowngrade(
  localStatus: ExportProfileValidationStatus,
  backendStatus: ExportProfileValidationStatus,
): boolean {
  // True when local says "everything's fine" (or milder) but backend
  // says it's worse. That's the dangerous direction — operators
  // would think they're clear but the backend disagrees.
  return _STATUS_RANK[backendStatus] > _STATUS_RANK[localStatus];
}

const _SEVERITY_RANK: Record<ExportProfileIssueSeverity, number> = {
  // Higher = worse.
  clear: 0,
  info: 1,
  warning: 2,
  blocked: 3,
};

function _compareColumnMapping(
  localCols: ExportProfileColumnResult[],
  backendCols: ExportProfileColumnResult[],
  differences: ExportValidationParityDifference[],
): boolean {
  const localByKey = new Map<string, ExportProfileColumnResult>();
  for (const c of localCols) localByKey.set(c.profile_column_key, c);
  const backendByKey = new Map<string, ExportProfileColumnResult>();
  for (const c of backendCols) backendByKey.set(c.profile_column_key, c);

  let allMatch = true;

  // Walk profile column keys union-style so neither side hides a
  // column the other has.
  const allKeys = new Set<string>();
  Array.from(localByKey.keys()).forEach((k) => allKeys.add(k));
  Array.from(backendByKey.keys()).forEach((k) => allKeys.add(k));

  const sortedKeys = Array.from(allKeys).sort();
  for (const key of sortedKeys) {
    const l = localByKey.get(key);
    const b = backendByKey.get(key);
    if (!l || !b) {
      allMatch = false;
      differences.push({
        severity: "warning",
        area: "column_mapping",
        message: `Profile column "${key}" appears in only one validator's column results.`,
        local_value: l ? "present" : "—",
        backend_value: b ? "present" : "—",
        recommendation:
          "Confirm both validators are walking the same profile column set.",
      });
      continue;
    }
    if (l.matched !== b.matched) {
      allMatch = false;
      differences.push({
        severity: "warning",
        area: "column_mapping",
        message: `Profile column "${l.profile_column_label}" matched differs.`,
        local_value: String(l.matched),
        backend_value: String(b.matched),
        recommendation:
          "One validator found a preview column the other did not. Check label normalisation / alias coverage.",
      });
    }
    if (
      l.matched_preview_column_key &&
      b.matched_preview_column_key &&
      l.matched_preview_column_key !== b.matched_preview_column_key
    ) {
      allMatch = false;
      differences.push({
        severity: "info",
        area: "column_mapping",
        message: `Profile column "${l.profile_column_label}" matched a different preview column.`,
        local_value: l.matched_preview_column_key,
        backend_value: b.matched_preview_column_key,
        recommendation:
          "Two preview columns matched the same profile column on different validators — alias coverage may differ.",
      });
    }
    if (l.worst_severity !== b.worst_severity) {
      allMatch = false;
      const isBlockingDelta =
        _SEVERITY_RANK[b.worst_severity] >= _SEVERITY_RANK.blocked &&
        _SEVERITY_RANK[l.worst_severity] < _SEVERITY_RANK.blocked;
      differences.push({
        severity: isBlockingDelta ? "blocked" : "warning",
        area: "column_mapping",
        message: `Worst severity for "${l.profile_column_label}" differs.`,
        local_value: l.worst_severity,
        backend_value: b.worst_severity,
        recommendation: isBlockingDelta
          ? "Backend marks this column as blocked while local does not — local fallback is under-reporting."
          : "Worst severities differ — check the per-column issue lists.",
      });
    }
  }

  return allMatch;
}

function _compareRowResults(
  localRows: ExportProfileRowResult[],
  backendRows: ExportProfileRowResult[],
  differences: ExportValidationParityDifference[],
): boolean {
  const localByIdx = new Map<number, ExportProfileRowResult>();
  for (const r of localRows) localByIdx.set(r.row_index, r);
  const backendByIdx = new Map<number, ExportProfileRowResult>();
  for (const r of backendRows) backendByIdx.set(r.row_index, r);

  let allMatch = true;

  if (localRows.length !== backendRows.length) {
    allMatch = false;
    differences.push({
      severity: "warning",
      area: "row_results",
      message: "Row result count differs.",
      local_value: String(localRows.length),
      backend_value: String(backendRows.length),
      recommendation:
        "Confirm both validators are walking the same preview row set.",
    });
  }

  const allIdx = new Set<number>();
  Array.from(localByIdx.keys()).forEach((k) => allIdx.add(k));
  Array.from(backendByIdx.keys()).forEach((k) => allIdx.add(k));

  const sorted = Array.from(allIdx).sort((a, b) => a - b);
  for (const idx of sorted) {
    const l = localByIdx.get(idx);
    const b = backendByIdx.get(idx);
    if (!l || !b) {
      allMatch = false;
      differences.push({
        severity: "warning",
        area: "row_results",
        message: `Preview row ${idx + 1} appears in only one validator's row results.`,
        local_value: l ? "present" : "—",
        backend_value: b ? "present" : "—",
        recommendation:
          "Confirm both validators are walking the same preview row set.",
      });
      continue;
    }
    if (l.worst_severity !== b.worst_severity) {
      allMatch = false;
      const flippedToBlocked =
        _SEVERITY_RANK[b.worst_severity] >= _SEVERITY_RANK.blocked &&
        _SEVERITY_RANK[l.worst_severity] < _SEVERITY_RANK.blocked;
      const flippedToClear =
        _SEVERITY_RANK[l.worst_severity] >= _SEVERITY_RANK.warning &&
        _SEVERITY_RANK[b.worst_severity] === _SEVERITY_RANK.clear;
      const blocking = flippedToBlocked || flippedToClear;
      differences.push({
        severity: blocking ? "blocked" : "warning",
        area: "row_results",
        message: `Worst severity for row ${idx + 1} differs.`,
        local_value: l.worst_severity,
        backend_value: b.worst_severity,
        recommendation: blocking
          ? "Row outcome flips between blocked and clear across validators — material drift."
          : "Worst row severities differ — backend remains source of truth.",
      });
    } else if (l.issue_count !== b.issue_count) {
      // Same severity but different count — minor drift only.
      allMatch = false;
      differences.push({
        severity: "info",
        area: "row_results",
        message: `Issue count for row ${idx + 1} differs (same worst severity).`,
        local_value: String(l.issue_count),
        backend_value: String(b.issue_count),
        recommendation:
          "Same overall row verdict, but issue counts differ. Check best-effort format checks.",
      });
    }
  }

  return allMatch;
}
