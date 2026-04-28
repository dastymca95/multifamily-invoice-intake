/**
 * Phase 2H — Pattern Test QA report export.
 *
 * Pure helper module that turns the Phase 2B test-runner response
 * (single-run) AND the Phase 2E batch state (multi-run) into
 * human-readable Markdown / plain-text reports operators can paste
 * into Slack, email, or a ticket. Also emits a CSV for the
 * multi-scenario matrix so reviewers can drop it into Excel /
 * Google Sheets without re-keying.
 *
 * What this is NOT:
 *
 *   * NOT the production export engine (ResMan / Yardi / AppFolio).
 *   * NOT a Review Queue record creator.
 *   * NOT a backend persistence path.
 *
 * What this IS:
 *
 *   * Diagnostic-only operator artefacts.
 *   * Pure formatters — every function takes already-derived data
 *     (or derives via the Phase 2G diagnostics helper) and returns
 *     a string. No DOM access except in the explicit
 *     ``copyTextToClipboard`` / ``downloadTextFile`` utilities.
 */

import type { TemplatePatternTestResult } from "@/types/template-pattern-test-runner";

import {
  FIX_AREA_LABEL,
  derivePatternTestDiagnostics,
  deriveMultiScenarioDiagnostics,
  type DiagnosticFixArea,
  type MultiScenarioRunInput,
  type PatternTestDiagnostic,
  type PatternTestDiagnosticSummary,
} from "./pattern-test-diagnostics";

// ---------------------------------------------------------------------------
// Public report builders
// ---------------------------------------------------------------------------

export interface SingleReportArgs {
  result: TemplatePatternTestResult;
  templateName?: string | null;
  patternName?: string | null;
  /** Selected scenario name from Phase 2D, when one is selected. */
  scenarioName?: string | null;
  /** Optional override for the timestamp — useful in tests. */
  generatedAt?: Date;
}

export interface MultiReportArgs {
  runs: MultiScenarioRunInput[];
  templateName?: string | null;
  patternName?: string | null;
  generatedAt?: Date;
}

// ---------------------------------------------------------------------------
// Single-run Markdown report
// ---------------------------------------------------------------------------

export function buildSinglePatternTestMarkdownReport(
  args: SingleReportArgs,
): string {
  const result = args.result;
  const summary = derivePatternTestDiagnostics(result);
  const ts = (args.generatedAt ?? new Date()).toLocaleString();

  const lines: string[] = [];
  lines.push("# Rivera Pattern Test QA Report");
  lines.push("");
  lines.push(`**Generated:** ${ts}`);
  lines.push(
    `**Template:** ${_safeName(args.templateName, result.template_id)}`,
  );
  lines.push(
    `**Pattern:** ${_safeName(args.patternName, result.pattern_id)}`,
  );
  if (args.scenarioName) {
    lines.push(`**Scenario:** ${args.scenarioName}`);
  }
  lines.push("");
  lines.push(
    "_Diagnostic only. This report does not export accounting data._",
  );
  lines.push("");

  // -- Summary block --
  const s = result.summary;
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Status:** ${s?.status ?? "—"}`);
  lines.push(`- Rows: ${s?.rows ?? 0}`);
  lines.push(`- Ready: ${s?.ready ?? 0}`);
  lines.push(`- Needs review: ${s?.needs_review ?? 0}`);
  lines.push(`- Blocked: ${s?.blocked ?? 0}`);
  lines.push(`- Conflict: ${s?.conflict ?? 0}`);
  lines.push(`- Errors: ${s?.errors ?? 0}`);
  lines.push(`- Warnings: ${s?.warnings ?? 0}`);
  lines.push(`- Info: ${s?.info ?? 0}`);
  lines.push(`- Extracted facts (bridge input): ${s?.extracted_fact_count ?? 0}`);
  lines.push(`- Catalog hints (bridge input): ${s?.catalog_hint_count ?? 0}`);
  lines.push("");

  // -- Diagnostic Review --
  lines.push("## Diagnostic Review");
  lines.push("");
  lines.push(`**${summary.headline}**`);
  if (summary.detail) {
    lines.push("");
    lines.push(summary.detail);
  }
  lines.push("");
  lines.push(`**Suggested next action:** ${summary.suggestedNextAction}`);
  lines.push("");

  // -- Per-diagnostic items --
  lines.push("## Diagnostics");
  lines.push("");
  if (summary.diagnostics.length === 0) {
    lines.push("_No diagnostics._");
    lines.push("");
  } else {
    for (const d of summary.diagnostics) {
      _appendDiagnostic(lines, d);
    }
  }

  // -- Bridge input snapshot --
  lines.push("## Bridge Input");
  lines.push("");
  const facts = result.bridge_input?.extracted_facts ?? [];
  lines.push(`**Extracted facts** (${facts.length}):`);
  if (facts.length === 0) {
    lines.push("- _None._");
  } else {
    for (const f of facts) {
      const value =
        f.value === null || f.value === undefined ? "—" : _stringify(f.value);
      const norm = f.normalized_field_key
        ? ` → ${f.normalized_field_key}`
        : "";
      const conf =
        typeof f.confidence === "number"
          ? ` · confidence ${(f.confidence * 100).toFixed(0)}%`
          : "";
      lines.push(
        `- \`${f.field_key}\`${norm}: ${value} (source: ${f.source_type ?? "unknown"})${conf}`,
      );
    }
  }
  lines.push("");

  const hints = result.bridge_input?.catalog_hints ?? {};
  const hintEntries = Object.entries(hints);
  lines.push(`**Catalog hints** (${hintEntries.length}):`);
  if (hintEntries.length === 0) {
    lines.push("- _None._");
  } else {
    for (const [kind, hint] of hintEntries) {
      const text = hint.text ?? hint.entry_id ?? "—";
      lines.push(`- ${kind}: ${text}`);
    }
  }
  lines.push("");

  const knownFields = _stringList(
    result.bridge_input?.document_metadata?.known_pattern_fields,
  );
  lines.push(`**Known pattern fields** (${knownFields.length}):`);
  lines.push(
    knownFields.length === 0
      ? "- _None._"
      : `- ${knownFields.join(", ")}`,
  );
  lines.push("");

  const unfilled = _stringList(
    result.bridge_input?.document_metadata?.unfilled_pattern_fields,
  );
  if (unfilled.length > 0) {
    lines.push(`**Unfilled pattern fields** (${unfilled.length}):`);
    lines.push(`- ${unfilled.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Multi-scenario Markdown report
// ---------------------------------------------------------------------------

export function buildMultiScenarioMarkdownReport(
  args: MultiReportArgs,
): string {
  const aggregate = deriveMultiScenarioDiagnostics(args.runs);
  const ts = (args.generatedAt ?? new Date()).toLocaleString();

  const lines: string[] = [];
  lines.push("# Rivera Multi-Scenario QA Report");
  lines.push("");
  lines.push(`**Generated:** ${ts}`);
  lines.push(
    `**Template:** ${_safeName(args.templateName, _firstResultTemplateId(args.runs))}`,
  );
  lines.push(
    `**Pattern:** ${_safeName(args.patternName, _firstResultPatternId(args.runs))}`,
  );
  lines.push(`**Scenarios in batch:** ${args.runs.length}`);
  lines.push("");
  lines.push(
    "_Diagnostic only. This report does not export accounting data._",
  );
  lines.push("");

  // -- Aggregate summary --
  lines.push("## Aggregate Summary");
  lines.push("");
  lines.push(`- Scenarios run: ${aggregate.totalRuns}`);
  lines.push(`- Ready: ${aggregate.ready}`);
  lines.push(`- Needs review: ${aggregate.needsReview}`);
  lines.push(`- Blocked: ${aggregate.blocked}`);
  lines.push(`- Failed: ${aggregate.failed}`);
  lines.push(`- Cancelled: ${aggregate.cancelled}`);
  lines.push("");
  lines.push("**Most common missing facts:**");
  if (aggregate.topMissingFacts.length === 0) {
    lines.push("- _None._");
  } else {
    for (const item of aggregate.topMissingFacts) {
      lines.push(
        `- ${item.value} — ${item.count} scenario${item.count === 1 ? "" : "s"} (${item.scenarios.join(", ")})`,
      );
    }
  }
  lines.push("");
  lines.push("**Most common missing hints:**");
  if (aggregate.topMissingHints.length === 0) {
    lines.push("- _None._");
  } else {
    for (const item of aggregate.topMissingHints) {
      lines.push(
        `- ${item.value} — ${item.count} scenario${item.count === 1 ? "" : "s"} (${item.scenarios.join(", ")})`,
      );
    }
  }
  lines.push("");
  lines.push("**Most common blocked columns:**");
  if (aggregate.topBlockedColumns.length === 0) {
    lines.push("- _None._");
  } else {
    for (const item of aggregate.topBlockedColumns) {
      lines.push(
        `- ${item.value} — ${item.count} scenario${item.count === 1 ? "" : "s"} (${item.scenarios.join(", ")})`,
      );
    }
  }
  lines.push("");
  lines.push(`**Suggested next action:** ${aggregate.suggestedNextAction}`);
  lines.push("");

  // -- Scenario matrix --
  lines.push("## Scenario Matrix");
  lines.push("");
  for (const run of args.runs) {
    const status = _scenarioRowStatus(run);
    const result = run.result;
    const s = result?.summary;
    const summary = result ? derivePatternTestDiagnostics(result) : null;
    const missingFacts = summary?.missingFacts ?? [];
    const missingHints = summary?.missingHints ?? [];
    const blockedColumns = summary?.blockedColumns ?? [];

    lines.push(`### ${run.scenarioName}`);
    lines.push("");
    lines.push(`- Run status: ${status}`);
    lines.push(`- Resolver status: ${s?.status ?? "—"}`);
    if (s) {
      lines.push(`- Rows: ${s.rows} · Ready: ${s.ready} · Needs review: ${s.needs_review} · Blocked: ${s.blocked} · Conflict: ${s.conflict}`);
      lines.push(`- Errors: ${s.errors} · Warnings: ${s.warnings} · Info: ${s.info}`);
    }
    if (missingFacts.length > 0) {
      lines.push(`- Missing facts: ${missingFacts.join(", ")}`);
    } else {
      lines.push("- Missing facts: none");
    }
    if (missingHints.length > 0) {
      lines.push(`- Missing hints: ${missingHints.join(", ")}`);
    } else {
      lines.push("- Missing hints: none");
    }
    if (blockedColumns.length > 0) {
      lines.push(`- Blocked columns: ${blockedColumns.join(", ")}`);
    } else {
      lines.push("- Blocked columns: none");
    }
    if (summary) {
      lines.push(`- Suggested action: ${summary.suggestedNextAction}`);
    } else if (run.error) {
      lines.push(`- Error: ${run.error}`);
    }
    lines.push("");
  }

  // -- Detailed diagnostics per scenario --
  lines.push("## Detailed Diagnostics by Scenario");
  lines.push("");
  for (const run of args.runs) {
    lines.push(`### ${run.scenarioName}`);
    lines.push("");
    if (run.status === "failed") {
      lines.push(`_Failed:_ ${run.error ?? "Pattern test request failed."}`);
      lines.push("");
      continue;
    }
    if (run.status === "cancelled") {
      lines.push("_Cancelled before completion._");
      lines.push("");
      continue;
    }
    if (!run.result) {
      lines.push("_No result available._");
      lines.push("");
      continue;
    }
    const summary = derivePatternTestDiagnostics(run.result);
    lines.push(`**${summary.headline}**`);
    lines.push("");
    lines.push(`Suggested next action: ${summary.suggestedNextAction}`);
    lines.push("");
    if (summary.diagnostics.length === 0) {
      lines.push("_No diagnostics._");
      lines.push("");
      continue;
    }
    // Cap per-scenario diagnostics to keep the report scannable.
    const top = summary.diagnostics.slice(0, 5);
    const overflow = Math.max(0, summary.diagnostics.length - top.length);
    for (const d of top) {
      _appendDiagnostic(lines, d);
    }
    if (overflow > 0) {
      lines.push(`_+ ${overflow} more diagnostic${overflow === 1 ? "" : "s"} not listed — re-run the single-scenario report to capture them all._`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Multi-scenario CSV report
// ---------------------------------------------------------------------------

export function buildMultiScenarioCsvReport(args: MultiReportArgs): string {
  const headers = [
    "Scenario",
    "Run Status",
    "Resolver Status",
    "Rows",
    "Ready",
    "Needs Review",
    "Blocked",
    "Conflict",
    "Errors",
    "Warnings",
    "Missing Facts",
    "Missing Hints",
    "Blocked Columns",
    "Suggested Next Action",
  ];
  const rows: string[][] = [headers];
  for (const run of args.runs) {
    const result = run.result;
    const s = result?.summary;
    const summary = result ? derivePatternTestDiagnostics(result) : null;
    rows.push([
      run.scenarioName,
      _scenarioRowStatus(run),
      s?.status ?? "",
      String(s?.rows ?? ""),
      String(s?.ready ?? ""),
      String(s?.needs_review ?? ""),
      String(s?.blocked ?? ""),
      String(s?.conflict ?? ""),
      String(s?.errors ?? ""),
      String(s?.warnings ?? ""),
      (summary?.missingFacts ?? []).join("; "),
      (summary?.missingHints ?? []).join("; "),
      (summary?.blockedColumns ?? []).join("; "),
      summary?.suggestedNextAction ?? run.error ?? "",
    ]);
  }
  return rows.map((row) => row.map(_csvEscape).join(",")).join("\r\n");
}

// ---------------------------------------------------------------------------
// Clipboard + download utilities
// ---------------------------------------------------------------------------

/**
 * Copy text to the clipboard. Resolves on success, REJECTS on
 * failure so the caller can show a clear error message. Uses the
 * modern Clipboard API; older browsers / non-secure contexts will
 * reject (we do NOT fall back to the legacy ``execCommand`` path —
 * the caller's error handler is the right place to surface that).
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof window === "undefined" || !window.navigator?.clipboard) {
    throw new Error("Clipboard API not available in this browser.");
  }
  await window.navigator.clipboard.writeText(text);
}

/**
 * Trigger a browser download of the given text content.
 *
 * Uses Blob + ``URL.createObjectURL`` + a synthetic ``<a download>``
 * click. Cleans up the object URL after a short delay so memory
 * doesn't leak. Throws on failure so the caller can show an error.
 */
export function downloadTextFile(
  filename: string,
  text: string,
  mimeType = "text/plain;charset=utf-8",
): void {
  if (typeof window === "undefined") {
    throw new Error("Download not available outside the browser.");
  }
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    // Hidden + appended-to-DOM is required for Firefox to honour
    // the click in some browser configurations.
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    // Defer revoke so the browser has time to commit the download.
    // 1000ms is generous; modern browsers settle within a few ms.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Sanitize an arbitrary string into a safe filename slug.
 *
 * Lowercases, replaces whitespace with hyphens, drops anything that
 * isn't ASCII alphanumeric / hyphen / underscore / dot, collapses
 * runs of hyphens, trims leading / trailing hyphens, and caps at
 * ``maxLength`` chars (default 80).
 *
 * Safe to use as the body of a filename — the caller still appends
 * the file extension.
 */
export function sanitizeFilename(
  raw: string | null | undefined,
  fallback = "untitled",
  maxLength = 80,
): string {
  const source = (raw ?? "").trim();
  if (!source) return fallback;
  const slug = source
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!slug) return fallback;
  return slug.slice(0, maxLength);
}

/**
 * Build a friendly filename slug for a report.
 *
 * Format: ``rivera-{kind}-{templateSlug}-{patternSlug}-{stamp}.{ext}``
 * Example: ``rivera-pattern-test-bills-iq-import-epb-utility-bill-20260427t1435.md``
 */
export function buildReportFilename(args: {
  kind: "pattern-test" | "multi-scenario-qa";
  templateName?: string | null;
  patternName?: string | null;
  extension: "md" | "csv" | "txt";
  generatedAt?: Date;
}): string {
  const ts = args.generatedAt ?? new Date();
  const stamp = _filenameStamp(ts);
  const tpl = sanitizeFilename(args.templateName, "template", 40);
  const pat = sanitizeFilename(args.patternName, "pattern", 40);
  return `rivera-${args.kind}-${tpl}-${pat}-${stamp}.${args.extension}`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _appendDiagnostic(
  lines: string[],
  d: PatternTestDiagnostic,
): void {
  const sev = d.severity.toUpperCase();
  const fix = FIX_AREA_LABEL[d.fixArea as DiagnosticFixArea] ?? d.fixArea;
  lines.push(`### [${sev}] ${d.title}`);
  lines.push("");
  lines.push(`- **Message:** ${d.message}`);
  lines.push(`- **Recommendation:** ${d.recommendation}`);
  lines.push(`- **Fix area:** ${fix}`);
  if (d.relatedColumn) {
    lines.push(`- **Column:** ${d.relatedColumn}`);
  }
  if (d.relatedField) {
    lines.push(`- **Field:** ${d.relatedField}`);
  }
  if (d.relatedHint) {
    lines.push(`- **Hint:** ${d.relatedHint}`);
  }
  if (d.issueCodes.length > 0) {
    lines.push(`- **Codes:** ${d.issueCodes.join(", ")}`);
  }
  lines.push("");
}

function _scenarioRowStatus(run: MultiScenarioRunInput): string {
  // Compose the run status (queued/running/success/failed/cancelled)
  // — same vocabulary the matrix renders, so reports stay diff-able
  // against on-screen state.
  return run.status;
}

function _safeName(name: string | null | undefined, idFallback?: string | null): string {
  if (name && name.trim()) return name.trim();
  if (idFallback && idFallback.trim()) return idFallback.trim();
  return "Untitled";
}

function _firstResultTemplateId(runs: MultiScenarioRunInput[]): string | null {
  for (const r of runs) {
    if (r.result?.template_id) return r.result.template_id;
  }
  return null;
}

function _firstResultPatternId(runs: MultiScenarioRunInput[]): string | null {
  for (const r of runs) {
    if (r.result?.pattern_id) return r.result.pattern_id;
  }
  return null;
}

function _stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
}

function _stringify(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * RFC 4180 CSV escaping. Wraps the value in double quotes if it
 * contains a comma, quote, CR, or LF — and doubles any embedded
 * quote so the consumer can parse round-trip.
 */
function _csvEscape(value: string): string {
  const text = value ?? "";
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Compact ISO-ish timestamp safe for filenames:
 * ``2026-04-27T14-35-09``. Avoids ``:`` (illegal on Windows) and
 * the milliseconds suffix (visually noisy in a filename).
 */
function _filenameStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `t${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Re-exports — keep the helper consumable as a single import.
// ---------------------------------------------------------------------------

export type { PatternTestDiagnosticSummary };
