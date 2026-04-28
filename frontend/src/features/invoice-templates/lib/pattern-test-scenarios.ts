/**
 * Phase 2D — Pattern Test Scenario presets.
 *
 * Local-only persistence helper for the Template + Pattern Test
 * Runner panel. Scenarios are saved per (template_id, pattern_id)
 * pair in localStorage so the operator never has to re-type a long
 * payload to reproduce the same diagnostic test.
 *
 * Why localStorage and not the backend:
 *
 *   * The test runner is a diagnostic surface. Storing scenarios in
 *     the database would require an entire CRUD round (model +
 *     migration + endpoints + tests) for what is essentially a
 *     per-operator workflow shortcut. localStorage gets the same
 *     UX with zero backend churn.
 *   * Scenarios are scoped to a workstation by design — a tester
 *     iterating on a template doesn't want their throwaway "EPB
 *     normal bill" payloads polluting another operator's view.
 *   * Phase 3+ can promote the saved-scenario shape to a real
 *     backend model later if/when team sharing is needed; the
 *     storage shape is intentionally JSON-stable so a backfill is
 *     a one-shot import.
 *
 * Storage key convention:
 *
 *   ``rivera.patternTestScenarios.v1.{templateId}.{patternId}``
 *
 * The ``v1`` prefix is reserved for a future shape migration —
 * unknown versioned payloads are ignored on read so a Phase 3+
 * upgrade can swap the parser without crashing existing
 * workstations.
 */

import type { TemplatePatternTestRequest } from "@/types/template-pattern-test-runner";

// ---------------------------------------------------------------------------
// Quick-fact keys — shared with the panel
// ---------------------------------------------------------------------------
//
// The panel's QUICK_FACT_FIELDS table renders inputs for these
// canonical keys. The helper uses the same set to decide what gets
// hoisted out of a stored ``manual_fact_values`` object back into
// the quick-fields form on Load (vs. what stays in the advanced
// JSON editor). Keep the two in sync — the panel imports this
// constant.

export const QUICK_FACT_KEYS: readonly string[] = [
  "invoice_number",
  "account_number",
  "invoice_date",
  "due_date",
  "total_amount",
  "subtotal",
  "tax_amount",
  "service_period_start",
  "service_period_end",
  "vendor_name",
  "property_name",
  "service_address",
] as const;

const QUICK_FACT_KEY_SET = new Set(QUICK_FACT_KEYS);

// Catalog hint kinds the panel renders quick-field inputs for.
// Other kinds (or structured dict values for these kinds) flow into
// the advanced JSON editor on load.
const QUICK_HINT_KINDS = new Set(["vendor", "property", "gl"]);

// Reasonable upper bounds — keep storage payloads well under the
// 5–10 MB localStorage cap and keep the scenario list scannable.
export const MAX_SCENARIO_NAME_LENGTH = 80;
export const MAX_SCENARIOS_PER_PAIR = 50;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Stored scenario shape. Mirrors the request body the panel posts
 * to the Phase 2B endpoint, plus identity + audit fields.
 *
 * ``include_empty_fields`` lives on the scenario (not the request
 * bag) because it's a panel-level toggle the operator usually wants
 * persisted alongside the rest.
 */
export interface PatternTestScenario {
  id: string;
  name: string;
  description?: string | null;
  template_id: string;
  pattern_id: string;
  manual_fact_values: Record<string, unknown>;
  manual_catalog_hints: Record<string, unknown>;
  include_empty_fields: boolean;
  runtime_options?: Record<string, unknown> | null;
  document_metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  /** Most recent successful run timestamp (ISO). */
  last_run_at?: string | null;
  /** Most recent ``summary.status`` from the Phase 2B response. */
  last_result_status?: string | null;
  tags?: string[];
}

/**
 * UI form state derived from a scenario. The panel hydrates each
 * input from this shape on Load.
 */
export interface ScenarioFormState {
  quickFacts: Record<string, string>;
  vendorHint: string;
  propertyHint: string;
  glHint: string;
  factsJson: string;
  hintsJson: string;
  runtimeOptionsJson: string;
  docMetadataJson: string;
  includeEmptyFields: boolean;
}

/** Result of a localStorage write. ``ok=false`` carries a human message. */
export interface StorageWriteResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Storage key + low-level read/write
// ---------------------------------------------------------------------------

const STORAGE_KEY_PREFIX = "rivera.patternTestScenarios.v1";

export function getScenarioStorageKey(
  templateId: string,
  patternId: string,
): string {
  return `${STORAGE_KEY_PREFIX}.${templateId}.${patternId}`;
}

/**
 * Load scenarios for a template + pattern pair.
 *
 * Defensive: any parse failure (corrupted entry, unknown shape,
 * etc.) returns ``[]`` so the panel renders the "no scenarios yet"
 * empty state instead of crashing. The caller's optional
 * ``onError`` callback receives a human-readable message so the
 * panel can surface a one-time warning toast.
 */
export function loadScenarios(
  templateId: string,
  patternId: string,
  onError?: (message: string) => void,
): PatternTestScenario[] {
  if (!templateId || !patternId) return [];
  if (typeof window === "undefined") return [];
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(
      getScenarioStorageKey(templateId, patternId),
    );
  } catch (err) {
    onError?.(
      `Could not read saved scenarios from this browser: ${(err as Error).message}`,
    );
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Ignore entries that don't look like scenario rows (loose
    // shape check — we only need the identity fields to be present
    // for the panel to render them sanely).
    return parsed.filter(_isScenarioLike) as PatternTestScenario[];
  } catch (err) {
    onError?.(
      `Saved scenarios for this template + pattern were corrupt and ignored: ${(err as Error).message}`,
    );
    return [];
  }
}

export function saveScenarios(
  templateId: string,
  patternId: string,
  scenarios: PatternTestScenario[],
): StorageWriteResult {
  if (!templateId || !patternId) {
    return { ok: false, error: "Missing template or pattern id." };
  }
  if (typeof window === "undefined") {
    return { ok: false, error: "Browser storage is not available." };
  }
  try {
    const key = getScenarioStorageKey(templateId, patternId);
    window.localStorage.setItem(key, JSON.stringify(scenarios));
    return { ok: true };
  } catch (err) {
    // Most likely cause: QuotaExceededError when the page hits the
    // 5–10 MB localStorage cap. Surface a clear message; the panel
    // shows a non-blocking warning.
    return {
      ok: false,
      error: `Scenarios could not be saved in this browser: ${(err as Error).message}`,
    };
  }
}

function _isScenarioLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.name === "string" &&
    typeof obj.template_id === "string" &&
    typeof obj.pattern_id === "string"
  );
}

// ---------------------------------------------------------------------------
// Scenario CRUD (pure — caller persists via saveScenarios)
// ---------------------------------------------------------------------------

/** Insert or replace by id. Returns a new array. */
export function upsertScenario(
  scenarios: PatternTestScenario[],
  scenario: PatternTestScenario,
): PatternTestScenario[] {
  const idx = scenarios.findIndex((s) => s.id === scenario.id);
  if (idx === -1) return [...scenarios, scenario];
  const next = scenarios.slice();
  next[idx] = scenario;
  return next;
}

/** Remove by id. Returns a new array. */
export function deleteScenarioById(
  scenarios: PatternTestScenario[],
  id: string,
): PatternTestScenario[] {
  return scenarios.filter((s) => s.id !== id);
}

/**
 * Build a duplicate of an existing scenario with a new id +
 * timestamps + " copy" suffix on the name.
 *
 * The duplicate inherits ``last_run_at`` / ``last_result_status`` =
 * null — the operator hasn't run the copy yet. created_at / updated_at
 * reset to "now" so the duplicate sorts to the top of any future
 * recently-edited UI.
 */
export function duplicateScenario(
  scenario: PatternTestScenario,
): PatternTestScenario {
  return {
    ...scenario,
    id: _newId(),
    name: `${scenario.name} copy`.slice(0, MAX_SCENARIO_NAME_LENGTH),
    created_at: _nowIso(),
    updated_at: _nowIso(),
    last_run_at: null,
    last_result_status: null,
  };
}

/**
 * Build a fresh scenario from current panel form state.
 *
 * The caller provides the EFFECTIVE payload (the same one the panel
 * would post to the test-runner endpoint) so the storage round-
 * trips deterministically — quick fields and advanced JSON have
 * already been merged at this point.
 */
export function createScenarioFromPayload({
  templateId,
  patternId,
  name,
  payload,
  description,
}: {
  templateId: string;
  patternId: string;
  name: string;
  payload: TemplatePatternTestRequest;
  description?: string | null;
}): PatternTestScenario {
  const now = _nowIso();
  return {
    id: _newId(),
    name: _normalizeName(name),
    description: description ?? null,
    template_id: templateId,
    pattern_id: patternId,
    manual_fact_values: _normalizeRecord(payload.manual_fact_values),
    manual_catalog_hints: _normalizeRecord(payload.manual_catalog_hints),
    include_empty_fields: !!payload.include_empty_fields,
    runtime_options: payload.runtime_options
      ? _normalizeRecord(payload.runtime_options)
      : null,
    document_metadata: payload.document_metadata
      ? _normalizeRecord(payload.document_metadata)
      : null,
    created_at: now,
    updated_at: now,
    last_run_at: null,
    last_result_status: null,
  };
}

/**
 * Update an existing scenario in place from the current panel
 * payload. ``updated_at`` refreshes; ``id`` / ``created_at`` /
 * ``last_*`` are preserved.
 */
export function updateScenarioFromPayload(
  base: PatternTestScenario,
  payload: TemplatePatternTestRequest,
): PatternTestScenario {
  return {
    ...base,
    manual_fact_values: _normalizeRecord(payload.manual_fact_values),
    manual_catalog_hints: _normalizeRecord(payload.manual_catalog_hints),
    include_empty_fields: !!payload.include_empty_fields,
    runtime_options: payload.runtime_options
      ? _normalizeRecord(payload.runtime_options)
      : null,
    document_metadata: payload.document_metadata
      ? _normalizeRecord(payload.document_metadata)
      : null,
    updated_at: _nowIso(),
  };
}

/**
 * Stamp the most recent run metadata on a scenario.
 *
 * Called from the panel after a successful Run completes when a
 * scenario is selected. ``last_result_status`` mirrors
 * ``summary.status`` from the Phase 2B response.
 */
export function stampLastRun(
  base: PatternTestScenario,
  status: string,
): PatternTestScenario {
  return {
    ...base,
    last_run_at: _nowIso(),
    last_result_status: status,
    updated_at: _nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Form-state hydration / dirty detection
// ---------------------------------------------------------------------------

/**
 * Split a scenario back into form state for the panel.
 *
 * Quick-fact keys (``QUICK_FACT_KEYS``) hoist into ``quickFacts``
 * with stringified values; everything else lands in ``factsJson``
 * as a JSON object. Same logic for catalog hints —
 * ``vendor`` / ``property`` / ``gl`` with plain string values
 * hoist into the quick fields, structured dicts (or other kinds)
 * fall through to ``hintsJson``.
 *
 * Result is fully deterministic: round-tripping (panel → save →
 * load → panel) produces identical UI state.
 */
export function scenarioFormState(
  scenario: PatternTestScenario,
): ScenarioFormState {
  // Hoist quick facts; dump the rest into facts JSON.
  const quickFacts: Record<string, string> = {};
  const factsOverflow: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    scenario.manual_fact_values ?? {},
  )) {
    if (QUICK_FACT_KEY_SET.has(key)) {
      quickFacts[key] = _toInputString(value);
    } else {
      factsOverflow[key] = value;
    }
  }

  // Hoist quick hints with plain string values; structured/unknown
  // hints fall through to hints JSON.
  let vendorHint = "";
  let propertyHint = "";
  let glHint = "";
  const hintsOverflow: Record<string, unknown> = {};
  for (const [kind, value] of Object.entries(
    scenario.manual_catalog_hints ?? {},
  )) {
    if (QUICK_HINT_KINDS.has(kind) && typeof value === "string") {
      if (kind === "vendor") vendorHint = value;
      else if (kind === "property") propertyHint = value;
      else if (kind === "gl") glHint = value;
    } else {
      hintsOverflow[kind] = value;
    }
  }

  return {
    quickFacts,
    vendorHint,
    propertyHint,
    glHint,
    factsJson: _toJsonField(factsOverflow),
    hintsJson: _toJsonField(hintsOverflow),
    runtimeOptionsJson: _toJsonField(scenario.runtime_options),
    docMetadataJson: _toJsonField(scenario.document_metadata),
    includeEmptyFields: !!scenario.include_empty_fields,
  };
}

/**
 * Deep-equal two payloads after canonicalising key order. Used by
 * the panel to detect "scenario unsaved changes" — the operator
 * has typed something that differs from the saved scenario.
 *
 * Compares the normalized maps (same nullish handling as storage),
 * which means an empty ``manual_fact_values`` object equals a
 * missing one. Avoids spurious dirty signals when the panel toggles
 * between "no facts entered" and a freshly cleared form.
 */
export function payloadEqualsScenario(
  scenario: PatternTestScenario,
  payload: TemplatePatternTestRequest,
): boolean {
  const a = {
    facts: _normalizeRecord(scenario.manual_fact_values),
    hints: _normalizeRecord(scenario.manual_catalog_hints),
    include_empty_fields: !!scenario.include_empty_fields,
    runtime: _normalizeRecord(scenario.runtime_options ?? undefined),
    metadata: _normalizeRecord(scenario.document_metadata ?? undefined),
  };
  const b = {
    facts: _normalizeRecord(payload.manual_fact_values),
    hints: _normalizeRecord(payload.manual_catalog_hints),
    include_empty_fields: !!payload.include_empty_fields,
    runtime: _normalizeRecord(payload.runtime_options),
    metadata: _normalizeRecord(payload.document_metadata),
  };
  return _canonicalJson(a) === _canonicalJson(b);
}

// ---------------------------------------------------------------------------
// Starter scenarios
// ---------------------------------------------------------------------------

/**
 * Build the three sample scenarios called out by the spec —
 * "Normal utility bill", "Missing invoice number", "Credit memo".
 *
 * The values are deliberately placeholder ("Sample Vendor" /
 * "Sample Property") so the operator immediately sees they need to
 * customise. The panel only ADDS starters whose names don't
 * collide with existing scenarios so re-clicking "Add starter
 * scenarios" never overwrites the operator's work.
 */
export function buildStarterScenarios(
  templateId: string,
  patternId: string,
): PatternTestScenario[] {
  const now = _nowIso();
  const make = (
    name: string,
    facts: Record<string, unknown>,
    hints: Record<string, unknown>,
  ): PatternTestScenario => ({
    id: _newId(),
    name,
    description: "Sample scenario — adjust values to match your bill.",
    template_id: templateId,
    pattern_id: patternId,
    manual_fact_values: facts,
    manual_catalog_hints: hints,
    include_empty_fields: false,
    runtime_options: null,
    document_metadata: null,
    created_at: now,
    updated_at: now,
    last_run_at: null,
    last_result_status: null,
  });
  return [
    make(
      "Normal utility bill",
      {
        invoice_number: "INV-1001",
        account_number: "000-000-001",
        invoice_date: "2026-04-10",
        total_amount: "125.50",
      },
      {
        vendor: "Sample Vendor",
        property: "Sample Property",
        gl: "6915",
      },
    ),
    make(
      "Missing invoice number",
      {
        invoice_date: "2026-04-10",
        total_amount: "125.50",
      },
      { vendor: "Sample Vendor" },
    ),
    make(
      "Credit memo",
      {
        invoice_number: "CM-1001",
        invoice_date: "2026-04-10",
        total_amount: "-45.00",
      },
      { vendor: "Sample Vendor" },
    ),
  ];
}

/**
 * Add the buildStarterScenarios output to ``existing``, skipping
 * any starter whose name already exists (case-insensitive). Returns
 * the merged array AND the count actually added so the caller can
 * report "added 3 / skipped 0" feedback.
 */
export function mergeStarterScenarios(
  existing: PatternTestScenario[],
  templateId: string,
  patternId: string,
): { merged: PatternTestScenario[]; added: number } {
  const lower = new Set(existing.map((s) => s.name.toLowerCase()));
  const starters = buildStarterScenarios(templateId, patternId);
  const toAdd = starters.filter((s) => !lower.has(s.name.toLowerCase()));
  return { merged: [...existing, ...toAdd], added: toAdd.length };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _newId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function _nowIso(): string {
  return new Date().toISOString();
}

/** Trim + cap. Empty input falls back to "Untitled scenario". */
export function _normalizeName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "Untitled scenario";
  return trimmed.slice(0, MAX_SCENARIO_NAME_LENGTH);
}

/**
 * Defensive normalisation — strip undefined values from a record
 * so JSON.stringify is deterministic. Returns ``{}`` for null /
 * undefined inputs.
 */
function _normalizeRecord(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    out[key] = v;
  }
  return out;
}

/** Coerce a stored value to a string for an HTML input. */
function _toInputString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * JSON-stringify a record for the advanced JSON textareas. Empty
 * records collapse to ``""`` so the panel doesn't flash an
 * extraneous ``{}`` on every Load.
 */
function _toJsonField(
  value: Record<string, unknown> | null | undefined,
): string {
  if (!value || Object.keys(value).length === 0) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

/**
 * Stable JSON serialisation for deep-equal comparisons. Sorts
 * keys recursively so ``{a, b}`` and ``{b, a}`` compare equal.
 *
 * Defensive against cycles / unserialisable values (returns a
 * sentinel string instead of throwing — comparison may produce a
 * false negative but never crashes the panel).
 */
function _canonicalJson(value: unknown): string {
  try {
    return JSON.stringify(_sortKeys(value));
  } catch {
    return `__non_canonical__:${Math.random()}`;
  }
}

function _sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(_sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = _sortKeys(obj[key]);
    return out;
  }
  return value;
}
