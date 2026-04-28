/**
 * Phase 3D — Operational Review Diagnostics utility.
 *
 * Pure helper module that translates the Phase 3A backend
 * ``OperationalReviewDiagnostic[]`` into operator-friendly UI
 * cards: title + plain-English explanation + why-it-matters +
 * where-to-fix + recommended next action + severity + fix area.
 *
 * Why this lives in a separate module:
 *
 *   * Keeps the panel's render logic thin — the JSX just consumes
 *     pre-cooked card objects.
 *   * Lets the same cards drive the Markdown report (Phase 3D
 *     report helper) and any future Review Queue persistence
 *     without re-mapping codes.
 *   * Stays backend-truth-honest — every card preserves the raw
 *     backend code, message, and recommendation. The frontend
 *     copy is operator-friendly LAYERED ON TOP, never replacing
 *     the source of truth.
 *
 * What this module is NOT:
 *
 *   * NOT a resolver re-implementation.
 *   * NOT a status overrider — the backend's severity wins.
 *   * NOT a Review Queue persistence layer.
 */

import type {
  OperationalReviewDiagnostic,
  OperationalReviewFixArea,
  OperationalReviewSeverity,
} from "@/types/operational-resolution";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One UI-ready diagnostic card. Field naming uses operator-facing
 * vocabulary ("what_happened", "where_to_fix", "recommended_action")
 * rather than developer-flavoured terms.
 */
export interface OperationalDiagnosticCard {
  /** Stable id for React key — derived from code + column + index. */
  id: string;
  severity: NormalizedSeverity;
  /** Operator-facing headline. */
  title: string;
  /** Plain-English explanation of what the resolver reported. */
  what_happened: string;
  /** Why the operator should care. */
  why_it_matters: string;
  /** Where to look to fix it. */
  where_to_fix: string;
  /** Specific actionable next step. */
  recommended_action: string;
  /** Normalized fix area, used for grouping + chip color. */
  fix_area: NormalizedFixArea;
  /** Display label for the fix area chip (operator-facing). */
  fix_area_label: string;
  column_id?: string | null;
  column_name?: string | null;
  /** Original backend code — kept visible for support / debugging. */
  backend_code: string | null;
  /** Original backend message (preserved verbatim). */
  raw_message: string;
  /** Original backend recommendation (when present). */
  raw_recommendation: string | null;
  /** Provenance — always "resolver" today; reserved for future
   *  bridge / scenario-shaped diagnostics. */
  source: "resolver";
}

/** Coarse counts for the Operational Review Summary card. */
export interface OperationalDiagnosticSummary {
  total: number;
  blocked: number;
  warning: number;
  info: number;
  ready: number;
  /** The fix area carrying the most cards (excluding ``unknown``
   *  unless it's the only one). ``null`` when nothing actionable. */
  top_fix_area: NormalizedFixArea | null;
  top_fix_area_label: string | null;
  /** First recommended action across all cards (blocked first,
   *  warning next, etc.). ``null`` when no cards. */
  first_recommended_action: string | null;
}

/** Cards grouped under their normalized severity bucket. */
export interface OperationalDiagnosticGroups {
  blocked: OperationalDiagnosticCard[];
  warning: OperationalDiagnosticCard[];
  info: OperationalDiagnosticCard[];
  ready: OperationalDiagnosticCard[];
}

// ---------------------------------------------------------------------------
// Normalized enums
// ---------------------------------------------------------------------------
//
// The backend's types are widened with ``(string & {})`` for
// forward-compat. Inside the panel we narrow to the four buckets
// the UI actually renders + the six fix-area buckets the chips
// distinguish. Unknown future literals fall back to safe defaults
// rather than crashing the panel.

export type NormalizedSeverity = "blocked" | "warning" | "info" | "ready";

export type NormalizedFixArea =
  | "extracted_fact"
  | "catalog_hint"
  | "import_template"
  | "invoice_pattern"
  | "reference_data"
  | "runtime_context"
  | "unknown";

// ---------------------------------------------------------------------------
// Public labels — kept here so the panel + reports + future Review
// Queue surfaces all read the same vocabulary.
// ---------------------------------------------------------------------------

export const FIX_AREA_LABEL: Record<NormalizedFixArea, string> = {
  extracted_fact: "Missing invoice facts",
  catalog_hint: "Catalog / reference data",
  import_template: "Import Template setup",
  invoice_pattern: "Invoice Pattern setup",
  reference_data: "Reference Data",
  runtime_context: "Runtime / context issue",
  unknown: "Needs review",
};

export const SEVERITY_LABEL: Record<NormalizedSeverity, string> = {
  blocked: "Blocked — must fix before export",
  warning: "Needs review",
  info: "Informational",
  ready: "Ready / no action needed",
};

// ---------------------------------------------------------------------------
// Code → operator-friendly template
// ---------------------------------------------------------------------------
//
// Every known backend code from Phase 3A maps to a curated card.
// Unknown codes fall through to ``_UNKNOWN_TEMPLATE`` so the panel
// renders SOMETHING for every diagnostic — never silently drops.

interface DiagnosticTemplate {
  title: string;
  what_happened: string;
  why_it_matters: string;
  where_to_fix: string;
  recommended_action: string;
  /** Default fix area when the backend doesn't supply one (rare). */
  default_fix_area: NormalizedFixArea;
  default_severity: NormalizedSeverity;
}

const CODE_TEMPLATES: Record<string, DiagnosticTemplate> = {
  REQUIRED_RUNTIME_VALUE_MISSING: {
    title: "Required value is missing",
    what_happened:
      "The resolver could not produce a required value for this column.",
    why_it_matters:
      "Export rows need this value before the invoice can move forward.",
    where_to_fix:
      "Check the invoice facts, catalog hints, or Import Template rule for this column.",
    recommended_action:
      "Add the missing value manually or update the template rule so Rivera knows where the value should come from.",
    default_fix_area: "import_template",
    default_severity: "blocked",
  },
  INVOICE_FIELD_FACT_NOT_FOUND: {
    title: "Invoice fact was not provided",
    what_happened:
      "The template expects a field from the invoice, but that fact was not available in this preview.",
    why_it_matters:
      "Rivera cannot fill the mapped column without that invoice fact.",
    where_to_fix:
      "Add the fact manually in Operational Preview or update the Invoice Pattern later when extraction is available.",
    recommended_action:
      "Enter the missing invoice fact and run the preview again.",
    default_fix_area: "extracted_fact",
    default_severity: "warning",
  },
  CATALOG_HINT_MISSING: {
    title: "Catalog hint is missing",
    what_happened:
      "The resolver needed a vendor, property, GL, or similar catalog hint but none was provided.",
    why_it_matters:
      "Rivera may not be able to match the invoice to the correct reference data.",
    where_to_fix:
      "Add a catalog hint in the preview or improve the document/pattern context.",
    recommended_action:
      "Enter the missing vendor / property / GL hint and run the preview again.",
    default_fix_area: "catalog_hint",
    default_severity: "warning",
  },
  CATALOG_NOT_CONFIGURED: {
    title: "Reference catalog is not configured",
    what_happened:
      "The template references a catalog that is not available or not configured.",
    why_it_matters:
      "Rivera cannot match values against missing reference data.",
    where_to_fix: "Check Reference Data setup.",
    recommended_action:
      "Configure or import the required catalog, then run the preview again.",
    default_fix_area: "import_template",
    default_severity: "blocked",
  },
  CATALOG_ENTRY_NOT_FOUND: {
    title: "Reference match was not found",
    what_happened:
      "Rivera looked for a matching catalog entry but could not find one.",
    why_it_matters:
      "The invoice may be linked to the wrong or missing vendor / property / GL.",
    where_to_fix: "Check Reference Data or adjust the catalog hint.",
    recommended_action:
      "Add the missing reference entry or correct the hint, then run the preview again.",
    default_fix_area: "reference_data",
    default_severity: "warning",
  },
  CATALOG_NOT_FOUND: {
    title: "Reference catalog was not found",
    what_happened: "The resolver could not find the expected catalog.",
    why_it_matters:
      "Catalog-based columns cannot resolve without the correct reference dataset.",
    where_to_fix:
      "Check Reference Data and template catalog configuration.",
    recommended_action:
      "Connect the template to the correct catalog or import the missing reference data.",
    default_fix_area: "reference_data",
    default_severity: "blocked",
  },
  NO_RULES_MATCHED: {
    title: "No rule matched this invoice",
    what_happened:
      "The resolver evaluated the rules but none matched the current invoice/context.",
    why_it_matters:
      "Rivera does not know which value strategy to apply.",
    where_to_fix: "Check the Import Template rule conditions.",
    recommended_action:
      "Add or adjust a rule for this vendor / property / invoice scenario.",
    default_fix_area: "import_template",
    default_severity: "warning",
  },
  CONDITION_NO_ACTUAL_VALUE: {
    title: "Rule condition could not be evaluated",
    what_happened:
      "A rule condition expected a value, but the preview did not provide it.",
    why_it_matters:
      "Rivera cannot determine whether the rule should apply.",
    where_to_fix:
      "Check the rule condition and the preview facts/hints.",
    recommended_action:
      "Provide the missing value or adjust the rule condition.",
    default_fix_area: "extracted_fact",
    default_severity: "warning",
  },
};

const _UNKNOWN_TEMPLATE: DiagnosticTemplate = {
  title: "Review needed",
  what_happened: "(see backend message below)",
  why_it_matters:
    "This issue may prevent Rivera from resolving the invoice correctly.",
  where_to_fix:
    "Review the template, invoice facts, and reference data.",
  recommended_action:
    "Review the diagnostic details and run the preview again after making corrections.",
  default_fix_area: "unknown",
  default_severity: "warning",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a list of backend ``OperationalReviewDiagnostic``s into
 * UI-ready cards. Sorted blocked → warning → info → ready, then
 * by fix-area sort rank, then by title for stability.
 */
export function buildOperationalDiagnosticCards(
  diagnostics: OperationalReviewDiagnostic[] | null | undefined,
): OperationalDiagnosticCard[] {
  if (!diagnostics || diagnostics.length === 0) return [];
  const cards: OperationalDiagnosticCard[] = [];
  diagnostics.forEach((d, idx) => {
    const code = (d.code ?? "").trim() || null;
    const template =
      (code && CODE_TEMPLATES[code]) || _UNKNOWN_TEMPLATE;
    const severity = _normalizeSeverity(
      d.severity ?? template.default_severity,
    );
    const fixArea = _normalizeFixArea(d.fix_area, template.default_fix_area);

    // Backend message is the source of truth — when the template's
    // ``what_happened`` is the unknown placeholder, surface the
    // backend message verbatim. For known codes, prepend the
    // operator-friendly explanation BUT also keep the backend
    // message available as ``raw_message`` so the chip + report
    // still show it.
    const what_happened =
      template === _UNKNOWN_TEMPLATE
        ? d.message || template.what_happened
        : template.what_happened;

    // Recommendation: backend wins when it's specific. Falls back
    // to the operator-friendly default when the backend left it
    // blank or short.
    const recommended_action =
      d.recommendation && d.recommendation.trim().length > 0
        ? d.recommendation.trim()
        : template.recommended_action;

    cards.push({
      id: `op-diag-${code ?? "uncoded"}-${d.column_id ?? ""}-${idx}`,
      severity,
      title: template.title,
      what_happened,
      why_it_matters: template.why_it_matters,
      where_to_fix: template.where_to_fix,
      recommended_action,
      fix_area: fixArea,
      fix_area_label: FIX_AREA_LABEL[fixArea],
      column_id: d.column_id ?? null,
      column_name: d.column_name ?? null,
      backend_code: code,
      raw_message: d.message,
      raw_recommendation: d.recommendation ?? null,
      source: "resolver",
    });
  });

  cards.sort((a, b) => {
    const sevDiff =
      getOperationalSeverityRank(a.severity) -
      getOperationalSeverityRank(b.severity);
    if (sevDiff !== 0) return sevDiff;
    const fixDiff =
      getFixAreaSortRank(a.fix_area) - getFixAreaSortRank(b.fix_area);
    if (fixDiff !== 0) return fixDiff;
    return a.title.localeCompare(b.title);
  });
  return cards;
}

/**
 * Roll the cards up into a coarse summary the panel shows above
 * the grouped sections. ``top_fix_area`` excludes ``unknown``
 * unless ``unknown`` is the only category present.
 */
export function summarizeOperationalDiagnosticCards(
  cards: OperationalDiagnosticCard[],
): OperationalDiagnosticSummary {
  let blocked = 0;
  let warning = 0;
  let info = 0;
  let ready = 0;
  const fixAreaCounts: Record<NormalizedFixArea, number> = {
    extracted_fact: 0,
    catalog_hint: 0,
    import_template: 0,
    invoice_pattern: 0,
    reference_data: 0,
    runtime_context: 0,
    unknown: 0,
  };
  for (const card of cards) {
    if (card.severity === "blocked") blocked += 1;
    else if (card.severity === "warning") warning += 1;
    else if (card.severity === "info") info += 1;
    else if (card.severity === "ready") ready += 1;
    fixAreaCounts[card.fix_area] += 1;
  }
  // Pick the dominant fix area (excluding ``unknown`` unless it's the
  // only one with anything).
  const ranked = (Object.entries(fixAreaCounts) as Array<
    [NormalizedFixArea, number]
  >)
    .filter(([area, count]) => count > 0 && area !== "unknown")
    .sort((a, b) => b[1] - a[1]);
  let top_fix_area: NormalizedFixArea | null = ranked[0]?.[0] ?? null;
  if (!top_fix_area && fixAreaCounts.unknown > 0) {
    top_fix_area = "unknown";
  }
  // First recommended action (sorted cards put blocked first).
  const first_recommended_action =
    cards.length > 0 ? cards[0].recommended_action : null;
  return {
    total: cards.length,
    blocked,
    warning,
    info,
    ready,
    top_fix_area,
    top_fix_area_label: top_fix_area ? FIX_AREA_LABEL[top_fix_area] : null,
    first_recommended_action,
  };
}

/** Bucket the cards by severity for the panel's grouped sections. */
export function groupOperationalDiagnosticCards(
  cards: OperationalDiagnosticCard[],
): OperationalDiagnosticGroups {
  const groups: OperationalDiagnosticGroups = {
    blocked: [],
    warning: [],
    info: [],
    ready: [],
  };
  for (const card of cards) {
    groups[card.severity].push(card);
  }
  return groups;
}

/** Lower rank = higher priority = appears first in lists. */
export function getOperationalSeverityRank(
  severity: NormalizedSeverity,
): number {
  switch (severity) {
    case "blocked":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
    case "ready":
      return 3;
  }
}

/** Operator-friendly label for the fix area chip. */
export function getFixAreaLabel(area: NormalizedFixArea): string {
  return FIX_AREA_LABEL[area];
}

/** Sort rank within the same severity bucket. Lower = first. */
export function getFixAreaSortRank(area: NormalizedFixArea): number {
  switch (area) {
    case "extracted_fact":
      return 0;
    case "catalog_hint":
      return 1;
    case "reference_data":
      return 2;
    case "import_template":
      return 3;
    case "invoice_pattern":
      return 4;
    case "runtime_context":
      return 5;
    case "unknown":
      return 6;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _normalizeSeverity(
  raw: OperationalReviewSeverity | string | null | undefined,
): NormalizedSeverity {
  // Explicit cast — the backend type is widened with ``(string & {})``
  // for forward-compat, which prevents TS from narrowing through a
  // literal === check. The runtime check is still tight.
  if (raw === "blocked" || raw === "warning" || raw === "info" || raw === "ready") {
    return raw as NormalizedSeverity;
  }
  return "warning";
}

function _normalizeFixArea(
  raw: OperationalReviewFixArea | string | null | undefined,
  fallback: NormalizedFixArea,
): NormalizedFixArea {
  if (
    raw === "extracted_fact" ||
    raw === "catalog_hint" ||
    raw === "import_template" ||
    raw === "invoice_pattern" ||
    raw === "reference_data" ||
    raw === "runtime_context" ||
    raw === "unknown"
  ) {
    return raw as NormalizedFixArea;
  }
  return fallback;
}
