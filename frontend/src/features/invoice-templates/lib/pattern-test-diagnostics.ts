/**
 * Phase 2G — Pattern Test Result → Review-style Diagnostics.
 *
 * Pure helper module that translates the Phase 2B test-runner
 * response (raw resolver issues + bridge metadata) into operator-
 * facing diagnostic cards that answer four questions per row:
 *
 *   1. What happened? (title + message)
 *   2. Why does it matter? (severity + count rollups)
 *   3. Where should I fix it? (fix area chip:
 *      Test scenario values / Invoice Pattern setup /
 *      Import Template setup / Reference Data / Runtime input)
 *   4. What action should I take next? (recommendation copy +
 *      suggestedNextAction at the summary level)
 *
 * No backend persistence, no Review Queue records, no API mutations.
 * The output is intentionally serialisable JSON-shaped so a future
 * phase can promote diagnostics into a real Review Queue entity
 * without changing the producer.
 *
 * Defensive against unknown issue shapes — every helper uses
 * ``getter || fallback`` access patterns and unknown codes
 * surface as ``severity="warning"`` + ``fixArea="unknown"`` rather
 * than crashing the panel.
 */

import type {
  ResolvedImportCell,
  ResolvedImportRow,
  ResolverIssue,
  ResolverSeverity,
} from "@/types/import-resolver";
import type { TemplatePatternTestResult } from "@/types/template-pattern-test-runner";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = "ready" | "info" | "warning" | "blocked";

export type DiagnosticFixArea =
  | "scenario_input"
  | "invoice_pattern"
  | "import_template"
  | "reference_data"
  | "runtime_context"
  | "unknown";

export interface PatternTestDiagnostic {
  /** Stable id for React key — derived from code + scope + index. */
  id: string;
  severity: DiagnosticSeverity;
  /** Short, human-readable headline (≤80 chars). */
  title: string;
  /** One-paragraph explanation. */
  message: string;
  /** Operator-actionable next step for THIS specific item. */
  recommendation: string;
  fixArea: DiagnosticFixArea;
  relatedColumn?: string;
  relatedField?: string;
  relatedHint?: string;
  /** Original resolver/bridge codes the diagnostic represents. */
  issueCodes: string[];
  /** Where the diagnostic was synthesised from. */
  source: "resolver" | "bridge" | "scenario" | "summary";
}

export interface PatternTestDiagnosticSummary {
  status: DiagnosticSeverity;
  /** One-line headline answering "is this ready?" */
  headline: string;
  /** Short paragraph below the headline. */
  detail: string;
  diagnostics: PatternTestDiagnostic[];
  counts: {
    ready: number;
    info: number;
    warning: number;
    blocked: number;
  };
  missingFacts: string[];
  missingHints: string[];
  blockedColumns: string[];
  /** Top-level "do this next" copy. */
  suggestedNextAction: string;
  /** Distribution by fix area — drives the multi-scenario aggregate. */
  fixAreaCounts: Record<DiagnosticFixArea, number>;
}

/**
 * Lightweight subset of ``ScenarioRunState`` from
 * ``TemplatePatternTestPanel.tsx``. Re-typed here so the diagnostics
 * helper has no upstream dependency on the panel internals.
 */
export interface MultiScenarioRunInput {
  scenarioId: string;
  scenarioName: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  result?: TemplatePatternTestResult;
  error?: string;
}

export interface CommonItemCount<T> {
  value: T;
  count: number;
  scenarios: string[];
}

export interface MultiScenarioDiagnosticSummary {
  totalRuns: number;
  ready: number;
  needsReview: number;
  blocked: number;
  failed: number;
  cancelled: number;
  topMissingFacts: CommonItemCount<string>[];
  topMissingHints: CommonItemCount<string>[];
  topBlockedColumns: CommonItemCount<string>[];
  fixAreaCounts: Record<DiagnosticFixArea, number>;
  /** Per-scenario diagnostic summary — drives the matrix details. */
  scenariosWithDiagnostics: Array<{
    scenarioId: string;
    scenarioName: string;
    summary: PatternTestDiagnosticSummary;
  }>;
  /** One-line aggregate "do this next" copy. */
  suggestedNextAction: string;
}

// ---------------------------------------------------------------------------
// Public copy / labels
// ---------------------------------------------------------------------------

export const FIX_AREA_LABEL: Record<DiagnosticFixArea, string> = {
  scenario_input: "Test scenario values",
  invoice_pattern: "Invoice Pattern setup",
  import_template: "Import Template setup",
  reference_data: "Reference Data",
  runtime_context: "Runtime input",
  unknown: "Needs review",
};

// ---------------------------------------------------------------------------
// Code → fix area + severity tables
// ---------------------------------------------------------------------------
//
// Default mappings — refined further by ``_refineFixArea`` when the
// resolved cell tells us more (e.g. a REQUIRED_RUNTIME_VALUE_MISSING
// on a catalog column lands on ``reference_data``, not the default
// ``import_template``).

const CODE_FIX_AREA: Record<string, DiagnosticFixArea> = {
  // Invoice fact extraction
  INVOICE_FIELD_FACT_NOT_FOUND: "scenario_input",
  // Required-value missing — refined later via cell.source_type
  REQUIRED_RUNTIME_VALUE_MISSING: "import_template",
  // Catalog hint missing at runtime
  CATALOG_HINT_MISSING: "scenario_input",
  CATALOG_NOT_FOUND: "reference_data",
  CATALOG_ENTRY_NOT_FOUND: "reference_data",
  CATALOG_ENTRY_AMBIGUOUS: "reference_data",
  CATALOG_VALUE_MISSING: "reference_data",
  // Catalog wiring on the template
  CATALOG_NOT_CONFIGURED: "import_template",
  SOURCE_CATALOG_ID_MISSING: "import_template",
  SOURCE_CATALOG_FIELD_MISSING: "import_template",
  CATALOG_MATCHER_NOT_IMPLEMENTED: "import_template",
  // Rules
  NO_RULES_MATCHED: "import_template",
  RULE_FILL_VALUE_MISSING: "import_template",
  CONFLICTING_RULE_ACTION: "import_template",
  RULE_ACTION_IGNORED_BY_GLOBAL_OVERRIDE: "import_template",
  CONDITION_NO_ACTUAL_VALUE: "scenario_input",
  RESTRICTION_NO_ACTUAL_VALUE: "scenario_input",
  CONDITION_NOT_MATCHED: "runtime_context",
  RESTRICTION_NOT_MATCHED: "runtime_context",
  RULE_RESTRICTED_OUT: "runtime_context",
  // Data type / coercion
  DATA_TYPE_COERCION_FAILED: "scenario_input",
  DATA_TYPE_UNKNOWN: "import_template",
  // Source / extraction wiring
  SOURCE_FIELD_KEY_UNKNOWN: "import_template",
  EXTRACTION_BINDING_PARTIAL: "import_template",
  EXTRACTION_BINDING_DUPLICATE: "import_template",
  // Defaults
  FIXED_VALUE_EMPTY: "import_template",
  MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION: "import_template",
  MANUAL_VALUE_REQUIRED: "import_template",
  DROPDOWN_OPTIONS_EMPTY: "import_template",
  // Legacy advisories
  LEGACY_EXTRACTION_DIVERGENCE: "import_template",
  LEGACY_FIELD_ALIAS_NORMALIZED: "import_template",
  // Resolver-side housekeeping
  READINESS_VALIDATION_NOT_RUN: "unknown",
  RESOLVER_INPUT_TEMPLATE_ID_MISMATCH: "unknown",
};

// Per-code severity overrides — only when the resolver's own
// severity isn't a good match. Most codes inherit the issue's
// severity directly via ``_severityFromIssue``.
const CODE_SEVERITY_OVERRIDE: Record<string, DiagnosticSeverity> = {
  LEGACY_EXTRACTION_DIVERGENCE: "info",
  LEGACY_FIELD_ALIAS_NORMALIZED: "info",
  READINESS_VALIDATION_NOT_RUN: "info",
  RESOLVER_INPUT_TEMPLATE_ID_MISMATCH: "warning",
};

// ---------------------------------------------------------------------------
// Title / message / recommendation templates
// ---------------------------------------------------------------------------
//
// Returns one diagnostic shell per code. The runtime fills in
// related column/field/hint via context. Unknown codes flow through
// ``_unknownTemplate`` so the panel still surfaces them.

interface DiagnosticTemplate {
  title: string;
  /** Function so we can inject column/field labels. */
  message: (ctx: TemplateContext) => string;
  recommendation: (ctx: TemplateContext) => string;
}

interface TemplateContext {
  column?: string;
  field?: string;
  hint?: string;
  knownPatternFields: Set<string>;
}

const CODE_TEMPLATES: Record<string, DiagnosticTemplate> = {
  INVOICE_FIELD_FACT_NOT_FOUND: {
    title: "Missing invoice fact",
    message: (c) =>
      `Rivera needs ${labelFor("the field", c.field)} from the invoice to resolve ${labelFor("the column", c.column)}.`,
    recommendation: (c) =>
      c.field && c.knownPatternFields.has(c.field)
        ? "Enter a manual value in this test scenario, or wait for OCR/AI extraction once it's wired."
        : c.field
          ? "Add a region for this field in Invoice Builder, then enter a manual value here for now."
          : "Add a manual value in this test scenario to simulate runtime extraction.",
  },
  REQUIRED_RUNTIME_VALUE_MISSING: {
    title: "Required column couldn't be resolved",
    message: (c) =>
      `${labelFor("A required column", c.column)} is required but Rivera couldn't produce a value.`,
    recommendation: () =>
      "Add a default, provide a test fact / catalog hint, or configure an Action / FILL rule.",
  },
  CATALOG_HINT_MISSING: {
    title: "Missing catalog hint",
    message: (c) =>
      `Rivera needs a catalog hint for ${labelFor("this column", c.column)} to match a saved entry.`,
    recommendation: (c) =>
      c.hint
        ? `Add a ${c.hint} hint to this scenario.`
        : "Add a vendor / property / GL hint to this scenario, or seed it at runtime.",
  },
  CATALOG_NOT_FOUND: {
    title: "Catalog not configured",
    message: (c) =>
      `${labelFor("This column", c.column)} points at a catalog that doesn't exist in Reference Data.`,
    recommendation: () =>
      "Open Reference Data and add the missing catalog, or change the column to point at an existing one.",
  },
  CATALOG_ENTRY_NOT_FOUND: {
    title: "Catalog entry didn't match",
    message: (c) =>
      `No entry in the saved catalog matched the hint for ${labelFor("this column", c.column)}.`,
    recommendation: () =>
      "Either add the entry in Reference Data, or refine the test hint so it matches an existing entry.",
  },
  CATALOG_ENTRY_AMBIGUOUS: {
    title: "Catalog match was ambiguous",
    message: (c) =>
      `More than one catalog entry matched the hint for ${labelFor("this column", c.column)}.`,
    recommendation: () =>
      "Tighten the hint with an entry id or a more specific text, or de-duplicate the catalog entries in Reference Data.",
  },
  CATALOG_VALUE_MISSING: {
    title: "Catalog entry missing field",
    message: (c) =>
      `The matched catalog entry has no value for the field ${labelFor("required by this column", c.column)}.`,
    recommendation: () =>
      "Open Reference Data and fill in the missing field on the matched entry.",
  },
  CATALOG_NOT_CONFIGURED: {
    title: "Catalog not picked",
    message: (c) =>
      `${labelFor("This column", c.column)} is set to a catalog source but no catalog has been chosen.`,
    recommendation: () =>
      "Open the column inspector and select a catalog + an output field in the Default Source step.",
  },
  SOURCE_CATALOG_ID_MISSING: {
    title: "Catalog source not picked",
    message: (c) =>
      `${labelFor("This column", c.column)} needs a catalog id to resolve.`,
    recommendation: () =>
      "Open the column inspector and pick the catalog in the Default Source step.",
  },
  SOURCE_CATALOG_FIELD_MISSING: {
    title: "Catalog output field not picked",
    message: (c) =>
      `${labelFor("This column", c.column)} needs an output field on the catalog.`,
    recommendation: () =>
      "Open the column inspector and pick the output field in the Default Source step.",
  },
  CATALOG_MATCHER_NOT_IMPLEMENTED: {
    title: "Catalog matcher not implemented",
    message: (c) =>
      `Rivera doesn't yet support matching this catalog kind for ${labelFor("the column", c.column)}.`,
    recommendation: () =>
      "Pick a different catalog kind, or wait for the matcher to land in a future phase.",
  },
  NO_RULES_MATCHED: {
    title: "No rules matched",
    message: () =>
      "None of the saved rules matched the test inputs for this row.",
    recommendation: () =>
      "Add or relax a rule's IF/LIMIT cells, or supply test values that match an existing rule.",
  },
  RULE_FILL_VALUE_MISSING: {
    title: "Rule has no fill value",
    message: (c) =>
      `A FILL rule for ${labelFor("this column", c.column)} matched but has no value to write.`,
    recommendation: () =>
      "Open the rule and add a value to its FILL cell, or change the cell role.",
  },
  CONFLICTING_RULE_ACTION: {
    title: "Rules wrote conflicting values",
    message: (c) =>
      `Two or more rules tried to write different values into ${labelFor("this column", c.column)}.`,
    recommendation: () =>
      "Add a LIMIT to one rule so only one applies, or remove the duplicate FILL.",
  },
  RULE_ACTION_IGNORED_BY_GLOBAL_OVERRIDE: {
    title: "Rule ignored by global override",
    message: (c) =>
      `A FILL rule for ${labelFor("this column", c.column)} was overridden by a global default.`,
    recommendation: () =>
      "Disable the global override, or change the rule cell role to Action so it can take precedence.",
  },
  CONDITION_NO_ACTUAL_VALUE: {
    title: "Rule condition has no value to test",
    message: (c) =>
      `A rule's IF condition needed a value for ${labelFor("a column", c.column)} but the test input didn't provide one.`,
    recommendation: () =>
      "Add a value for that field in the scenario, or relax the rule's IF condition.",
  },
  RESTRICTION_NO_ACTUAL_VALUE: {
    title: "Rule restriction has no value to test",
    message: (c) =>
      `A rule's LIMIT couldn't evaluate because the test input had no value for ${labelFor("a column", c.column)}.`,
    recommendation: () =>
      "Add a value for that field in the scenario, or relax the LIMIT.",
  },
  CONDITION_NOT_MATCHED: {
    title: "Rule condition didn't match",
    message: (c) =>
      `A rule's IF condition didn't match the test value for ${labelFor("a column", c.column)}.`,
    recommendation: () =>
      "Check the test value, the IF expected values, or both.",
  },
  RESTRICTION_NOT_MATCHED: {
    title: "Rule restriction blocked the rule",
    message: (c) =>
      `A LIMIT cell blocked a matched rule for ${labelFor("a column", c.column)}.`,
    recommendation: () =>
      "Update the LIMIT or change the test value so the rule is eligible.",
  },
  RULE_RESTRICTED_OUT: {
    title: "Matched rule was restricted out",
    message: () =>
      "A matched rule was eligible but a restriction prevented it from applying.",
    recommendation: () =>
      "Open the rule and relax the LIMIT, or update the test value so the LIMIT passes.",
  },
  DATA_TYPE_COERCION_FAILED: {
    title: "Value didn't fit the column type",
    message: (c) =>
      `The supplied value for ${labelFor("this column", c.column)} couldn't be coerced into the expected type.`,
    recommendation: () =>
      "Adjust the test value or change the column's data type / format.",
  },
  DATA_TYPE_UNKNOWN: {
    title: "Column data type unknown",
    message: (c) =>
      `${labelFor("This column", c.column)} doesn't have a recognised data type.`,
    recommendation: () =>
      "Open the column inspector and pick a data type in the Identity step.",
  },
  SOURCE_FIELD_KEY_UNKNOWN: {
    title: "Unknown source field",
    message: (c) =>
      `${labelFor("This column", c.column)} references a field key the resolver doesn't recognise.`,
    recommendation: () =>
      "Pick a known canonical field in the column's Default Source step.",
  },
  EXTRACTION_BINDING_PARTIAL: {
    title: "Incomplete extraction binding",
    message: (c) =>
      `An extraction binding for ${labelFor("this column", c.column)} is missing required fields.`,
    recommendation: () =>
      "Open the rule cell and complete the extraction binding (pattern + field key).",
  },
  EXTRACTION_BINDING_DUPLICATE: {
    title: "Duplicate extraction bindings",
    message: (c) =>
      `${labelFor("This column", c.column)} has duplicate extraction bindings on a rule cell.`,
    recommendation: () =>
      "Open the rule cell and de-duplicate the extraction bindings.",
  },
  FIXED_VALUE_EMPTY: {
    title: "Fixed value is empty",
    message: (c) =>
      `${labelFor("This column", c.column)} is set to a fixed value but no value was provided.`,
    recommendation: () =>
      "Open the column inspector and enter the fixed value.",
  },
  MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION: {
    title: "Multiple defaults, none chosen",
    message: (c) =>
      `${labelFor("This column", c.column)} has several manual options but no default selected.`,
    recommendation: () =>
      "Open the Default Source step and pick one of the options as the default.",
  },
  MANUAL_VALUE_REQUIRED: {
    title: "Manual value required",
    message: (c) =>
      `${labelFor("This column", c.column)} expects a manual value but none was provided.`,
    recommendation: () =>
      "Add a value at runtime, or set a default in the column inspector.",
  },
  DROPDOWN_OPTIONS_EMPTY: {
    title: "Dropdown has no options",
    message: (c) =>
      `${labelFor("This column", c.column)} renders as a dropdown but has no options to pick from.`,
    recommendation: () =>
      "Open the column inspector's Values step and add at least one option.",
  },
  LEGACY_EXTRACTION_DIVERGENCE: {
    title: "Legacy extraction setup may conflict",
    message: () =>
      "A legacy extraction setting on this template may conflict with canonical bindings.",
    recommendation: () =>
      "Re-save the column inspector to migrate the rule cell — Phase B already strips legacy state on save.",
  },
  LEGACY_FIELD_ALIAS_NORMALIZED: {
    title: "Field alias normalised",
    message: (c) =>
      `A legacy alias was normalised to a canonical key for ${labelFor("this column", c.column)}.`,
    recommendation: () =>
      "No action required — Rivera will keep accepting both forms; the canonical key is preferred.",
  },
  READINESS_VALIDATION_NOT_RUN: {
    title: "Readiness validation skipped",
    message: () =>
      "The resolver couldn't run readiness validation because no DB session was provided.",
    recommendation: () =>
      "No action required from this surface — the API endpoint always provides a session.",
  },
  RESOLVER_INPUT_TEMPLATE_ID_MISMATCH: {
    title: "Resolver input template id mismatch",
    message: () =>
      "The resolver input carried a template_id that doesn't match the path-loaded template.",
    recommendation: () =>
      "No action required — the path-loaded template was used.",
  },
};

const _UNKNOWN_TEMPLATE: DiagnosticTemplate = {
  title: "Other resolver issue",
  message: (c) =>
    `Rivera reported an issue${labelFor("for the column", c.column, " for ")}.`,
  recommendation: () =>
    "Inspect the resolver result + bridge input below for the full code, then open the relevant surface to fix.",
};

// ---------------------------------------------------------------------------
// Public derive functions
// ---------------------------------------------------------------------------

/**
 * Convert one Phase 2B test result into a diagnostic summary the
 * Pattern Test panel can render directly.
 */
export function derivePatternTestDiagnostics(
  result: TemplatePatternTestResult,
): PatternTestDiagnosticSummary {
  const knownPatternFields = new Set(
    extractStringList(
      result.bridge_input?.document_metadata?.known_pattern_fields,
    ),
  );
  const unfilledPatternFields = extractStringList(
    result.bridge_input?.document_metadata?.unfilled_pattern_fields,
  );
  const cellSourceTypes = buildCellSourceTypeMap(result.resolver_result.rows ?? []);

  const issues = collectIssues(result);
  const cellCodes = collectCellIssueCodes(result.resolver_result.rows ?? []);

  const ctx: TemplateContext = {
    knownPatternFields,
  };

  // -- Per-issue diagnostics ----------------------------------------
  const diagnostics: PatternTestDiagnostic[] = [];
  let idCounter = 0;
  const seen = new Set<string>(); // dedupe (code, column, field) triples

  const pushFromIssue = (
    issue: ResolverIssue,
    sourceLabel: PatternTestDiagnostic["source"],
  ) => {
    const code = issue.code ?? "UNKNOWN";
    const column = issue.column_label ?? issue.column_id ?? undefined;
    const field = issue.field_key ?? undefined;
    const key = `${code}::${column ?? ""}::${field ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(
      _buildDiagnostic({
        idCounter: ++idCounter,
        code,
        column,
        field,
        hint: undefined,
        baseSeverity: _severityFromIssue(issue),
        defaultMessage: issue.message,
        defaultRecommendation: issue.recommendation ?? undefined,
        cellSourceTypes,
        knownPatternFields,
        sourceLabel,
      }),
    );
  };

  for (const issue of issues) {
    pushFromIssue(issue, "resolver");
  }

  // Cell-level codes that aren't already represented as top-level
  // resolver issues — surface them too.
  for (const cell of cellCodes) {
    const code = cell.code;
    const column = cell.columnLabel ?? cell.columnId;
    const key = `${code}::${column}::`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(
      _buildDiagnostic({
        idCounter: ++idCounter,
        code,
        column,
        field: undefined,
        hint: undefined,
        baseSeverity: code === "REQUIRED_RUNTIME_VALUE_MISSING" ? "blocked" : "warning",
        defaultMessage: undefined,
        defaultRecommendation: undefined,
        cellSourceTypes,
        knownPatternFields,
        sourceLabel: "resolver",
      }),
    );
  }

  // -- Bridge-side advisory: pattern fields without test values ----
  // Skip ones already represented as missing-fact issues so we don't
  // double up.
  if (unfilledPatternFields.length > 0) {
    const factsAlreadyDiagnosed = new Set(
      diagnostics
        .filter(
          (d) => d.issueCodes.includes("INVOICE_FIELD_FACT_NOT_FOUND"),
        )
        .map((d) => d.relatedField)
        .filter((v): v is string => !!v),
    );
    for (const field of unfilledPatternFields) {
      if (factsAlreadyDiagnosed.has(field)) continue;
      diagnostics.push({
        id: `bridge-unfilled-${++idCounter}`,
        severity: "info",
        title: "Pattern field has no test value",
        message: `Pattern field “${field}” has no value in this scenario yet.`,
        recommendation:
          "Add a manual value for this field, or leave blank to test that the resolver tolerates missing extraction.",
        fixArea: "scenario_input",
        relatedField: field,
        issueCodes: ["READINESS_PATTERN_FIELD_UNFILLED"],
        source: "bridge",
      });
    }
  }

  // -- Sort: blocked → warning → info → ready, then by title ------
  const SORT: Record<DiagnosticSeverity, number> = {
    blocked: 0,
    warning: 1,
    info: 2,
    ready: 3,
  };
  diagnostics.sort((a, b) => {
    if (SORT[a.severity] !== SORT[b.severity]) {
      return SORT[a.severity] - SORT[b.severity];
    }
    return a.title.localeCompare(b.title);
  });

  // -- Counts + missing-* lists ------------------------------------
  const counts = { ready: 0, info: 0, warning: 0, blocked: 0 };
  const fixAreaCounts: Record<DiagnosticFixArea, number> = {
    scenario_input: 0,
    invoice_pattern: 0,
    import_template: 0,
    reference_data: 0,
    runtime_context: 0,
    unknown: 0,
  };
  for (const d of diagnostics) {
    counts[d.severity] += 1;
    fixAreaCounts[d.fixArea] += 1;
  }

  const missingFacts = deriveMissingFacts(result);
  const missingHints = deriveMissingHints(result);
  const blockedColumns = deriveBlockedColumns(result);

  // -- Overall status / headline / detail / next action ------------
  const status = _overallStatus(result, counts);
  const { headline, detail } = _buildHeadline(result, status, counts);
  const suggestedNextAction = _buildSuggestedNextAction({
    status,
    fixAreaCounts,
    missingFacts,
    missingHints,
    blockedColumns,
  });

  // Strip the dummy ctx — the templates already used the per-row
  // context they were built with.
  void ctx;

  return {
    status,
    headline,
    detail,
    diagnostics,
    counts,
    missingFacts,
    missingHints,
    blockedColumns,
    suggestedNextAction,
    fixAreaCounts,
  };
}

/**
 * Aggregate diagnostics across a multi-scenario batch run.
 *
 * Failed/cancelled scenarios are tallied but contribute nothing to
 * the missing-fact / hint / blocked-column rollups (we don't have
 * a result body to walk).
 */
export function deriveMultiScenarioDiagnostics(
  runs: MultiScenarioRunInput[],
): MultiScenarioDiagnosticSummary {
  let ready = 0;
  let needsReview = 0;
  let blocked = 0;
  let failed = 0;
  let cancelled = 0;

  const factsByValue = new Map<string, Set<string>>();
  const hintsByValue = new Map<string, Set<string>>();
  const blockedByValue = new Map<string, Set<string>>();
  const fixAreaCounts: Record<DiagnosticFixArea, number> = {
    scenario_input: 0,
    invoice_pattern: 0,
    import_template: 0,
    reference_data: 0,
    runtime_context: 0,
    unknown: 0,
  };

  const scenariosWithDiagnostics: MultiScenarioDiagnosticSummary["scenariosWithDiagnostics"] =
    [];

  for (const run of runs) {
    if (run.status === "failed") failed += 1;
    else if (run.status === "cancelled") cancelled += 1;
    else if (run.status === "success" && run.result) {
      const summary = derivePatternTestDiagnostics(run.result);
      scenariosWithDiagnostics.push({
        scenarioId: run.scenarioId,
        scenarioName: run.scenarioName,
        summary,
      });
      if (summary.status === "ready") ready += 1;
      else if (summary.status === "warning") needsReview += 1;
      else if (summary.status === "blocked") blocked += 1;
      else if (summary.status === "info") needsReview += 1;
      // Roll up missing-* lists keyed by value, scenarios as set.
      _bumpCounts(summary.missingFacts, run.scenarioName, factsByValue);
      _bumpCounts(summary.missingHints, run.scenarioName, hintsByValue);
      _bumpCounts(
        summary.blockedColumns,
        run.scenarioName,
        blockedByValue,
      );
      for (const area of Object.keys(summary.fixAreaCounts) as DiagnosticFixArea[]) {
        fixAreaCounts[area] += summary.fixAreaCounts[area];
      }
    }
  }

  const topMissingFacts = _topCounts(factsByValue);
  const topMissingHints = _topCounts(hintsByValue);
  const topBlockedColumns = _topCounts(blockedByValue);

  const suggestedNextAction = _buildAggregateNextAction({
    ready,
    needsReview,
    blocked,
    failed,
    topMissingFacts,
    topMissingHints,
    topBlockedColumns,
    fixAreaCounts,
  });

  return {
    totalRuns: runs.length,
    ready,
    needsReview,
    blocked,
    failed,
    cancelled,
    topMissingFacts,
    topMissingHints,
    topBlockedColumns,
    fixAreaCounts,
    scenariosWithDiagnostics,
    suggestedNextAction,
  };
}

// ---------------------------------------------------------------------------
// Issue / cell collectors (defensive)
// ---------------------------------------------------------------------------

export function collectIssues(
  result: TemplatePatternTestResult,
): ResolverIssue[] {
  const out: ResolverIssue[] = [];
  for (const issue of result.resolver_result.issues ?? []) {
    if (issue) out.push(issue);
  }
  for (const row of result.resolver_result.rows ?? []) {
    for (const issue of row.issues ?? []) {
      if (issue) out.push(issue);
    }
    for (const matched of row.matched_rules ?? []) {
      for (const issue of matched.issues ?? []) {
        if (issue) out.push(issue);
      }
      for (const issue of matched.action_issues ?? []) {
        if (issue) out.push(issue);
      }
    }
  }
  return out;
}

export function collectIssueCodes(
  result: TemplatePatternTestResult,
): string[] {
  const codes = new Set<string>();
  for (const issue of collectIssues(result)) {
    if (issue.code) codes.add(issue.code);
  }
  for (const row of result.resolver_result.rows ?? []) {
    for (const cell of row.cells ?? []) {
      for (const code of cell.issue_codes ?? []) codes.add(code);
    }
  }
  return Array.from(codes);
}

interface CellCodeRow {
  columnId: string;
  columnLabel: string;
  code: string;
}

function collectCellIssueCodes(rows: ResolvedImportRow[]): CellCodeRow[] {
  const out: CellCodeRow[] = [];
  for (const row of rows) {
    for (const cell of row.cells ?? []) {
      for (const code of cell.issue_codes ?? []) {
        out.push({
          columnId: cell.column_id,
          columnLabel: cell.column_label || cell.column_id,
          code,
        });
      }
    }
  }
  return out;
}

function buildCellSourceTypeMap(
  rows: ResolvedImportRow[],
): Map<string, string> {
  // column_id → source_type (last cell wins; resolver returns one
  // cell per column per row in the dry-run shape).
  const out = new Map<string, string>();
  for (const row of rows) {
    for (const cell of row.cells ?? []) {
      if (cell.column_id && cell.source_type) {
        out.set(cell.column_id, cell.source_type);
      }
    }
  }
  return out;
}

export function deriveMissingFacts(
  result: TemplatePatternTestResult,
): string[] {
  const out: string[] = [];
  for (const issue of collectIssues(result)) {
    if (issue.code === "INVOICE_FIELD_FACT_NOT_FOUND") {
      const label =
        issue.field_key ??
        issue.column_label ??
        issue.column_id ??
        "(unknown)";
      out.push(label);
    }
  }
  for (const row of result.resolver_result.rows ?? []) {
    for (const cell of row.cells ?? []) {
      const codes = cell.issue_codes ?? [];
      if (codes.includes("INVOICE_FIELD_FACT_NOT_FOUND")) {
        out.push(cell.column_label ?? cell.column_id);
      }
    }
  }
  for (const f of extractStringList(
    result.bridge_input?.document_metadata?.unfilled_pattern_fields,
  )) {
    out.push(f);
  }
  return Array.from(new Set(out));
}

export function deriveMissingHints(
  result: TemplatePatternTestResult,
): string[] {
  const out: string[] = [];
  const HINT_CODES = new Set([
    "CATALOG_HINT_MISSING",
    "CATALOG_NOT_CONFIGURED",
    "CATALOG_ENTRY_NOT_FOUND",
    "CATALOG_NOT_FOUND",
  ]);
  for (const issue of collectIssues(result)) {
    if (issue.code && HINT_CODES.has(issue.code)) {
      out.push(issue.column_label ?? issue.column_id ?? "(unknown)");
    }
  }
  return Array.from(new Set(out));
}

export function deriveBlockedColumns(
  result: TemplatePatternTestResult,
): string[] {
  const out: string[] = [];
  for (const issue of collectIssues(result)) {
    if (issue.code === "REQUIRED_RUNTIME_VALUE_MISSING") {
      out.push(issue.column_label ?? issue.column_id ?? "(unknown)");
    }
  }
  for (const row of result.resolver_result.rows ?? []) {
    for (const cell of row.cells ?? []) {
      const codes = cell.issue_codes ?? [];
      if (codes.includes("REQUIRED_RUNTIME_VALUE_MISSING")) {
        out.push(cell.column_label ?? cell.column_id);
      }
    }
  }
  return Array.from(new Set(out));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _buildDiagnostic(args: {
  idCounter: number;
  code: string;
  column?: string;
  field?: string;
  hint?: string;
  baseSeverity: DiagnosticSeverity;
  defaultMessage?: string;
  defaultRecommendation?: string;
  cellSourceTypes: Map<string, string>;
  knownPatternFields: Set<string>;
  sourceLabel: PatternTestDiagnostic["source"];
}): PatternTestDiagnostic {
  const template = CODE_TEMPLATES[args.code] ?? _UNKNOWN_TEMPLATE;
  const ctx: TemplateContext = {
    column: args.column,
    field: args.field,
    hint: args.hint,
    knownPatternFields: args.knownPatternFields,
  };
  const severityOverride = CODE_SEVERITY_OVERRIDE[args.code];
  const severity = severityOverride ?? args.baseSeverity;
  const baseFixArea = CODE_FIX_AREA[args.code] ?? "unknown";
  const fixArea = _refineFixArea({
    code: args.code,
    defaultArea: baseFixArea,
    column: args.column,
    field: args.field,
    cellSourceTypes: args.cellSourceTypes,
    knownPatternFields: args.knownPatternFields,
  });
  const message =
    args.defaultMessage && template === _UNKNOWN_TEMPLATE
      ? args.defaultMessage
      : template.message(ctx);
  const recommendation =
    template === _UNKNOWN_TEMPLATE
      ? args.defaultRecommendation ?? template.recommendation(ctx)
      : template.recommendation(ctx);
  return {
    id: `diag-${args.code}-${args.idCounter}`,
    severity,
    title: template.title,
    message,
    recommendation,
    fixArea,
    relatedColumn: args.column,
    relatedField: args.field,
    relatedHint: args.hint,
    issueCodes: [args.code],
    source: args.sourceLabel,
  };
}

function _refineFixArea(args: {
  code: string;
  defaultArea: DiagnosticFixArea;
  column?: string;
  field?: string;
  cellSourceTypes: Map<string, string>;
  knownPatternFields: Set<string>;
}): DiagnosticFixArea {
  // INVOICE_FIELD_FACT_NOT_FOUND — refine by whether the pattern
  // KNOWS the field. If the pattern declares it (via a region) →
  // scenario_input (operator just needs to enter a value or wait
  // for OCR). If not → invoice_pattern (the pattern is missing the
  // region for this field).
  if (args.code === "INVOICE_FIELD_FACT_NOT_FOUND" && args.field) {
    return args.knownPatternFields.has(args.field)
      ? "scenario_input"
      : "invoice_pattern";
  }
  // REQUIRED_RUNTIME_VALUE_MISSING — refine by cell.source_type:
  //   * invoice_pattern / ocr / heuristic → scenario_input
  //   * catalog / manual → import_template fallback
  //   * fixed_value (somehow empty) → import_template
  if (args.code === "REQUIRED_RUNTIME_VALUE_MISSING") {
    const sourceType = args.column ? args.cellSourceTypes.get(args.column) : undefined;
    if (
      sourceType === "invoice_pattern" ||
      sourceType === "ocr" ||
      sourceType === "heuristic" ||
      sourceType === "ai"
    ) {
      return "scenario_input";
    }
    if (sourceType === "catalog") {
      return "reference_data";
    }
    return args.defaultArea;
  }
  return args.defaultArea;
}

function _severityFromIssue(issue: ResolverIssue): DiagnosticSeverity {
  const sev: ResolverSeverity | undefined = issue.severity;
  if (sev === "error") return "blocked";
  if (sev === "warning") return "warning";
  if (sev === "info") return "info";
  return "warning";
}

function _overallStatus(
  result: TemplatePatternTestResult,
  counts: { ready: number; info: number; warning: number; blocked: number },
): DiagnosticSeverity {
  if (counts.blocked > 0) return "blocked";
  // Use resolver's own status as a strong signal — it factors in
  // row-level conflict / needs_review states too.
  const resolverStatus = result.resolver_result.status;
  if (resolverStatus === "blocked" || resolverStatus === "conflict") {
    return "blocked";
  }
  if (resolverStatus === "needs_review" || counts.warning > 0) {
    return "warning";
  }
  return "ready";
}

function _buildHeadline(
  result: TemplatePatternTestResult,
  status: DiagnosticSeverity,
  counts: { ready: number; info: number; warning: number; blocked: number },
): { headline: string; detail: string } {
  const rows = result.summary?.rows ?? 0;
  const ready = result.summary?.ready ?? 0;
  if (status === "ready") {
    return {
      headline: "Ready — Rivera produced resolved output rows.",
      detail:
        rows > 0
          ? `${ready} of ${rows} row${rows === 1 ? "" : "s"} resolved cleanly with no blocking issues.`
          : "No blocking issues detected.",
    };
  }
  if (status === "warning") {
    const advisory = counts.warning + counts.info;
    return {
      headline:
        "Needs review — Rivera produced rows but advisory items need attention.",
      detail: `${advisory} advisory item${advisory === 1 ? "" : "s"} below.`,
    };
  }
  return {
    headline: "Blocked — at least one required value couldn't be resolved.",
    detail: `${counts.blocked} blocking item${counts.blocked === 1 ? "" : "s"} below.`,
  };
}

function _buildSuggestedNextAction(args: {
  status: DiagnosticSeverity;
  fixAreaCounts: Record<DiagnosticFixArea, number>;
  missingFacts: string[];
  missingHints: string[];
  blockedColumns: string[];
}): string {
  if (args.status === "ready") {
    return "Looks good — you can re-run with different scenarios or move on to Dry Run + Save.";
  }
  // Pick the dominant fix area (excluding ``unknown`` unless it's the only one).
  const ranked = (Object.entries(args.fixAreaCounts) as Array<
    [DiagnosticFixArea, number]
  >)
    .filter(([area, count]) => count > 0 && area !== "unknown")
    .sort((a, b) => b[1] - a[1]);
  const dominant: DiagnosticFixArea | undefined = ranked[0]?.[0];
  switch (dominant) {
    case "scenario_input":
      return args.missingFacts.length > 0
        ? `Add ${args.missingFacts.length} missing test value${args.missingFacts.length === 1 ? "" : "s"} above, then re-run.`
        : "Add or correct test scenario values above, then re-run.";
    case "import_template":
      return "Open Validate or Health Map to fix the template configuration.";
    case "reference_data":
      return "Open Reference Data to add or correct the matched catalog entry.";
    case "invoice_pattern":
      return "Open Invoice Builder to extend this pattern with the missing field region.";
    case "runtime_context":
      return "Add a runtime hint or extracted fact in the test inputs above, or wait for OCR/AI to provide it.";
    default:
      return "Review the items below for next steps.";
  }
}

function _buildAggregateNextAction(args: {
  ready: number;
  needsReview: number;
  blocked: number;
  failed: number;
  topMissingFacts: CommonItemCount<string>[];
  topMissingHints: CommonItemCount<string>[];
  topBlockedColumns: CommonItemCount<string>[];
  fixAreaCounts: Record<DiagnosticFixArea, number>;
}): string {
  const blocked = args.blocked + args.failed;
  if (blocked === 0 && args.needsReview === 0) {
    return "All scenarios ready — the template + pattern combination looks good across the board.";
  }
  // Pick the most common single missing item across the batch.
  const topFact = args.topMissingFacts[0];
  if (topFact && topFact.count >= 1) {
    return `Add ${topFact.value} to ${topFact.count} scenario${topFact.count === 1 ? "" : "s"}, or extract it via Invoice Builder.`;
  }
  const topHint = args.topMissingHints[0];
  if (topHint && topHint.count >= 1) {
    return `Add ${topHint.value} hint to ${topHint.count} scenario${topHint.count === 1 ? "" : "s"}.`;
  }
  const topBlocked = args.topBlockedColumns[0];
  if (topBlocked && topBlocked.count >= 1) {
    return `Review required column “${topBlocked.value}” — it blocked ${topBlocked.count} scenario${topBlocked.count === 1 ? "" : "s"}.`;
  }
  // Fall back to fix-area dominant.
  const ranked = (Object.entries(args.fixAreaCounts) as Array<
    [DiagnosticFixArea, number]
  >)
    .filter(([area, count]) => count > 0 && area !== "unknown")
    .sort((a, b) => b[1] - a[1]);
  const dominant = ranked[0]?.[0];
  if (dominant === "import_template") {
    return "Open Validate or Health Map — most blockers point at template configuration.";
  }
  if (dominant === "reference_data") {
    return "Open Reference Data — most blockers point at catalog entries.";
  }
  if (dominant === "invoice_pattern") {
    return "Open Invoice Builder — most blockers point at pattern setup.";
  }
  return "Review per-scenario diagnostics in the matrix below for next steps.";
}

function _topCounts(
  byValue: Map<string, Set<string>>,
  limit = 3,
): CommonItemCount<string>[] {
  return Array.from(byValue.entries())
    .map(([value, scenarios]) => ({
      value,
      count: scenarios.size,
      scenarios: Array.from(scenarios),
    }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

function _bumpCounts(
  values: string[],
  scenarioName: string,
  byValue: Map<string, Set<string>>,
) {
  for (const v of values) {
    if (!v) continue;
    let set = byValue.get(v);
    if (!set) {
      set = new Set();
      byValue.set(v, set);
    }
    set.add(scenarioName);
  }
}

function extractStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) out.push(item);
  }
  return out;
}

function labelFor(
  defaultLabel: string,
  named: string | undefined,
  prefix = " “",
  suffix = "”",
): string {
  if (!named) return defaultLabel;
  return `${defaultLabel}${prefix}${named}${suffix}`;
}

// Defensive accessor wrappers — exported for parity tests / future
// helpers, but unused inside the module today.
export function getIssueColumn(issue: ResolverIssue): string | undefined {
  return issue.column_label ?? issue.column_id ?? undefined;
}

export function getIssueMessage(issue: ResolverIssue): string {
  return issue.message ?? "(no message)";
}

export function getIssueRecommendation(
  issue: ResolverIssue,
): string | undefined {
  return issue.recommendation ?? undefined;
}

export function getCellIssues(
  result: TemplatePatternTestResult,
): Array<{ cell: ResolvedImportCell; codes: string[] }> {
  const out: Array<{ cell: ResolvedImportCell; codes: string[] }> = [];
  for (const row of result.resolver_result.rows ?? []) {
    for (const cell of row.cells ?? []) {
      out.push({ cell, codes: cell.issue_codes ?? [] });
    }
  }
  return out;
}
