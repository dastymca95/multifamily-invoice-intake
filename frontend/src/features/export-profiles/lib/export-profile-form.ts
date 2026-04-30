/**
 * Phase 4C — Export profile editor form helpers.
 *
 * Pure helpers for the management page's create / edit form:
 *
 *   * ``ExportProfileFormState`` / ``ExportProfileFormColumn`` —
 *     the editable shape (strings everywhere so inputs map cleanly).
 *   * ``buildEmptyForm`` / ``buildFormFromRecord`` — seed an empty
 *     editor for the given target system, or load an existing
 *     persisted record for editing.
 *   * ``validateForm`` — name / target / column / settings checks.
 *     Mirrors the backend Phase 4A management service rules so
 *     422s are rare in practice.
 *   * ``buildCreatePayload`` / ``buildUpdatePayload`` — convert
 *     the form state into the API client payloads.
 *
 * All pure / synchronous. No React, no fetch, no DOM. The
 * management page owns the React state; this module owns the
 * conversion + validation rules.
 */

import type {
  PersistedExportProfileCreate,
  PersistedExportProfileRead,
  PersistedExportProfileSourceTag,
  PersistedExportProfileTargetSystem,
  PersistedExportProfileUpdate,
} from "@/types/export-profile-persistence";

// ---------------------------------------------------------------------------
// Public — vocabulary
// ---------------------------------------------------------------------------

export const EXPORT_PROFILE_TARGET_SYSTEMS: PersistedExportProfileTargetSystem[] = [
  "custom_csv",
  "resman",
  "yardi",
  "appfolio",
];

export const EXPORT_PROFILE_TARGET_SYSTEM_LABEL: Record<
  string,
  string
> = {
  custom_csv: "Custom CSV",
  resman: "ResMan",
  yardi: "Yardi",
  appfolio: "AppFolio",
};

export const EXPORT_PROFILE_DATA_TYPES = [
  "text",
  "date",
  "amount",
  "integer",
  "decimal",
  "boolean",
] as const;
export type ExportProfileFormDataType =
  (typeof EXPORT_PROFILE_DATA_TYPES)[number];

export const EXPORT_PROFILE_TRIM_OPTIONS = [
  "none",
  "trim",
  "trim_collapse",
] as const;
export type ExportProfileFormTrim = (typeof EXPORT_PROFILE_TRIM_OPTIONS)[number];

export const EXPORT_PROFILE_DELIMITERS = [
  "comma",
  "tab",
  "semicolon",
  "pipe",
] as const;

export const EXPORT_PROFILE_QUOTE_STRATEGIES = [
  "minimal",
  "all",
  "non_numeric",
  "none",
] as const;

export const EXPORT_PROFILE_NEWLINES = ["lf", "crlf"] as const;

export const EXPORT_PROFILE_ENCODINGS = [
  "utf-8",
  "utf-8-bom",
  "windows-1252",
] as const;

export const EXPORT_PROFILE_DATE_FORMATS = [
  "MM/DD/YYYY",
  "M/D/YYYY",
  "YYYY-MM-DD",
  "DD/MM/YYYY",
] as const;

export const EXPORT_PROFILE_AMOUNT_FORMATS = [
  "decimal_2",
  "decimal_4",
  "integer",
  "decimal_2_neg_paren",
] as const;

export const EXPORT_PROFILE_EMPTY_VALUE_POLICIES = [
  "blank",
  "literal_null",
  "dash",
] as const;

// ---------------------------------------------------------------------------
// Public — form shape
// ---------------------------------------------------------------------------

export interface ExportProfileFormSettings {
  delimiter: string;
  include_header: boolean;
  quote_strategy: string;
  newline: string;
  encoding: string;
  date_format: string;
  amount_format: string;
  empty_value_policy: string;
}

/**
 * UI-friendly column shape — strings everywhere so HTML inputs
 * round-trip cleanly. ``allowed_values`` and ``match_aliases`` are
 * comma- / newline-separated text in the UI; the form helpers
 * parse them into arrays before building the payload.
 */
export interface ExportProfileFormColumn {
  key: string;
  label: string;
  output_header: string;
  required: boolean;
  source_column_key: string;
  source_column_label: string;
  data_type: ExportProfileFormDataType;
  /** Stringified positive integer or empty. */
  max_length: string;
  /** Comma- or newline-separated. */
  allowed_values: string;
  /** Stringified value (text / "true" / "false" / numeric text). */
  default_value: string;
  trim: ExportProfileFormTrim;
  /** Comma- or newline-separated. */
  match_aliases: string;
  /**
   * Phase 4D — Original raw column object as it came from the
   * backend, captured so unknown / forward-compat keys (e.g.
   * ``format``, ``custom_format``, ``export_transform``,
   * vendor-specific fields the editor doesn't surface) survive
   * a round-trip through the form. ``undefined`` for new columns
   * the operator added through the editor; we intentionally don't
   * synthesize one for them.
   */
  _raw_original?: Record<string, unknown>;
}

export interface ExportProfileFormState {
  /** Present only when editing — null on create. */
  id: string | null;
  name: string;
  target_system: PersistedExportProfileTargetSystem;
  description: string;
  notes: string;
  is_active: boolean;
  is_default: boolean;
  /** Read-only on edit, but kept on the form so display + payload
   *  stay consistent. Always ``"manual"`` on create. */
  source: PersistedExportProfileSourceTag;
  /** Backend version — read-only display while editing, ``1`` on
   *  create. The backend bumps it on shape changes; the form just
   *  carries the value through for UI labels. */
  version: number;
  settings: ExportProfileFormSettings;
  columns: ExportProfileFormColumn[];
  /**
   * Phase 4D — Original raw settings object as it came from the
   * backend, captured so unknown / forward-compat keys (e.g.
   * ``custom_delimiter_note``, ``target_specific_options``)
   * survive a round-trip through the form. ``undefined`` for new
   * profiles the operator created from a starter — those have no
   * unknown keys yet.
   */
  _raw_settings?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public — defaults
// ---------------------------------------------------------------------------

export function defaultExportProfileSettings(): ExportProfileFormSettings {
  return {
    delimiter: "comma",
    include_header: true,
    quote_strategy: "minimal",
    newline: "lf",
    encoding: "utf-8",
    date_format: "MM/DD/YYYY",
    amount_format: "decimal_2",
    empty_value_policy: "blank",
  };
}

export function blankFormColumn(
  partial?: Partial<ExportProfileFormColumn>,
): ExportProfileFormColumn {
  return {
    key: "",
    label: "",
    output_header: "",
    required: false,
    source_column_key: "",
    source_column_label: "",
    data_type: "text",
    max_length: "",
    allowed_values: "",
    default_value: "",
    trim: "trim",
    match_aliases: "",
    ...partial,
  };
}

export function buildEmptyForm(args?: {
  targetSystem?: PersistedExportProfileTargetSystem;
}): ExportProfileFormState {
  return {
    id: null,
    name: "",
    target_system: args?.targetSystem ?? "custom_csv",
    description: "",
    notes: "",
    is_active: true,
    is_default: false,
    source: "manual",
    version: 1,
    settings: defaultExportProfileSettings(),
    columns: [],
  };
}

// ---------------------------------------------------------------------------
// Public — load existing record into editable form
// ---------------------------------------------------------------------------

export function buildFormFromRecord(
  record: PersistedExportProfileRead,
): ExportProfileFormState {
  return {
    id: record.id,
    name: record.name,
    target_system:
      record.target_system as PersistedExportProfileTargetSystem,
    description: record.description ?? "",
    notes: record.notes ?? "",
    is_active: record.is_active,
    is_default: record.is_default,
    source: record.source,
    version: record.version,
    settings: _settingsFromRecord(record.settings),
    columns: (record.columns ?? []).map(_columnFromRecord),
    // Phase 4D — capture the raw settings dict so unknown keys
    // survive a round-trip. Defensive copy; never mutate the
    // backend response object.
    _raw_settings: { ...(record.settings ?? {}) },
  };
}

function _settingsFromRecord(
  raw: Record<string, unknown>,
): ExportProfileFormSettings {
  const base = defaultExportProfileSettings();
  return {
    delimiter:
      typeof raw.delimiter === "string" ? raw.delimiter : base.delimiter,
    include_header:
      typeof raw.include_header === "boolean"
        ? raw.include_header
        : base.include_header,
    quote_strategy:
      typeof raw.quote_strategy === "string"
        ? raw.quote_strategy
        : base.quote_strategy,
    newline: typeof raw.newline === "string" ? raw.newline : base.newline,
    encoding: typeof raw.encoding === "string" ? raw.encoding : base.encoding,
    date_format:
      typeof raw.date_format === "string" ? raw.date_format : base.date_format,
    amount_format:
      typeof raw.amount_format === "string"
        ? raw.amount_format
        : base.amount_format,
    empty_value_policy:
      typeof raw.empty_value_policy === "string"
        ? raw.empty_value_policy
        : base.empty_value_policy,
  };
}

function _columnFromRecord(
  raw: Record<string, unknown>,
): ExportProfileFormColumn {
  const dataType = String(raw.data_type ?? "text");
  const trim = String(raw.trim ?? "trim");
  return {
    key: String(raw.key ?? ""),
    label: String(raw.label ?? ""),
    output_header: String(raw.output_header ?? raw.label ?? ""),
    required: !!raw.required,
    source_column_key: _stringOrEmpty(raw.source_column_key),
    source_column_label: _stringOrEmpty(raw.source_column_label),
    data_type: (EXPORT_PROFILE_DATA_TYPES as readonly string[]).includes(
      dataType,
    )
      ? (dataType as ExportProfileFormDataType)
      : "text",
    max_length:
      typeof raw.max_length === "number" && raw.max_length > 0
        ? String(raw.max_length)
        : "",
    allowed_values: Array.isArray(raw.allowed_values)
      ? (raw.allowed_values as unknown[]).map(String).join(", ")
      : "",
    default_value:
      raw.default_value === undefined || raw.default_value === null
        ? ""
        : String(raw.default_value),
    trim: (EXPORT_PROFILE_TRIM_OPTIONS as readonly string[]).includes(trim)
      ? (trim as ExportProfileFormTrim)
      : "trim",
    match_aliases: Array.isArray(raw.match_aliases)
      ? (raw.match_aliases as unknown[]).map(String).join(", ")
      : "",
    // Phase 4D — capture the column's raw object verbatim so
    // unknown / forward-compat keys survive a round-trip through
    // the editor. Defensive copy.
    _raw_original: { ...raw },
  };
}

function _stringOrEmpty(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

// ---------------------------------------------------------------------------
// Public — payload builders
// ---------------------------------------------------------------------------

/**
 * The set of column keys the form OWNS. Any key on the raw column
 * object that is NOT in this set is treated as an unknown /
 * forward-compat field and preserved through the round-trip
 * (Phase 4D). Keep this list in sync with ``_columnFromRecord`` +
 * the form column type.
 */
const _FORM_OWNED_COLUMN_KEYS: ReadonlySet<string> = new Set([
  "key",
  "label",
  "output_header",
  "order",
  "required",
  "source_column_key",
  "source_column_label",
  "data_type",
  "max_length",
  "allowed_values",
  "default_value",
  "trim",
  "match_aliases",
]);

/**
 * The set of settings keys the form OWNS. Same preservation rule
 * as columns — anything else on the raw settings dict survives.
 */
const _FORM_OWNED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "delimiter",
  "include_header",
  "quote_strategy",
  "newline",
  "encoding",
  "date_format",
  "amount_format",
  "empty_value_policy",
]);

/**
 * Build the ``settings`` JSONB payload from form state.
 *
 * Phase 4D — when ``rawOriginal`` is present (edit mode), unknown
 * keys (e.g. vendor-specific extensions, future backend fields)
 * are preserved on top of the form's edited known keys. New
 * profiles created from a starter pass ``undefined`` here and
 * land at the regular known-keys-only payload.
 *
 * Pure — never mutates the inputs.
 */
function _settingsToPayload(
  settings: ExportProfileFormSettings,
  rawOriginal: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const known: Record<string, unknown> = {
    delimiter: settings.delimiter,
    include_header: settings.include_header,
    quote_strategy: settings.quote_strategy,
    newline: settings.newline,
    encoding: settings.encoding,
    date_format: settings.date_format,
    amount_format: settings.amount_format,
    empty_value_policy: settings.empty_value_policy,
  };
  if (!rawOriginal) return known;
  // Preserve unknown keys from the raw original; the editor's
  // known fields override them.
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rawOriginal)) {
    if (!_FORM_OWNED_SETTINGS_KEYS.has(k)) {
      out[k] = rawOriginal[k];
    }
  }
  return { ...out, ...known };
}

/**
 * Build a column JSONB payload from form state.
 *
 * Phase 4D — ``column._raw_original`` (when present) captures the
 * row's incoming backend object so unknown keys (e.g. ``format``,
 * ``custom_format``, ``export_transform``, vendor-specific rules)
 * survive a round-trip. Editor-owned fields override; unknown
 * fields are preserved verbatim. The ``order`` field is ALWAYS
 * derived from the row's current position in the form, never
 * from the raw original — re-ordering must take effect.
 *
 * New columns added through the editor have no ``_raw_original``
 * and produce a known-keys-only payload.
 *
 * Strings are trimmed; comma/newline lists are split + de-duped;
 * numeric text is coerced; empty optional fields are omitted so
 * the backend re-validation round-trips cleanly.
 */
function _columnToPayload(
  column: ExportProfileFormColumn,
  index: number,
): Record<string, unknown> {
  const known: Record<string, unknown> = {
    key: column.key.trim(),
    label: column.label.trim(),
    output_header: column.output_header.trim() || column.label.trim(),
    order: index,
    required: column.required,
    data_type: column.data_type,
    trim: column.trim,
  };
  if (column.source_column_key.trim()) {
    known.source_column_key = column.source_column_key.trim();
  }
  if (column.source_column_label.trim()) {
    known.source_column_label = column.source_column_label.trim();
  }
  // ``max_length`` — empty string drops the key; non-numeric or
  // non-positive integer is enforced by ``validateForm`` BEFORE
  // payload build, so we only have to handle the happy path here.
  const maxLengthRaw = column.max_length.trim();
  if (maxLengthRaw) {
    const maxLengthNum = parseInt(maxLengthRaw, 10);
    if (Number.isFinite(maxLengthNum) && maxLengthNum > 0) {
      known.max_length = maxLengthNum;
    }
  }
  const allowedList = _parseAllowedValues(column.allowed_values);
  if (allowedList.length > 0) {
    known.allowed_values = allowedList;
  }
  const aliasesList = _parseMatchAliases(column.match_aliases);
  if (aliasesList.length > 0) {
    known.match_aliases = aliasesList;
  }
  if (column.default_value.trim()) {
    known.default_value = column.default_value.trim();
  }

  if (!column._raw_original) return known;
  // Preserve unknown keys from the raw original; the editor's
  // known fields override them. ``order`` is the canonical exception
  // — re-ordering on the form must beat the raw value.
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(column._raw_original)) {
    if (!_FORM_OWNED_COLUMN_KEYS.has(k)) {
      out[k] = column._raw_original[k];
    }
  }
  return { ...out, ...known };
}

/**
 * Phase 4D — Parse a comma- / newline-separated input list into a
 * clean array. Trims tokens, drops empties, de-duplicates
 * case-insensitively while PRESERVING the original order (first
 * occurrence wins).
 */
function _parseAllowedValues(text: string): string[] {
  return _parseDedupedTokenList(text);
}

/**
 * Same parsing semantics as ``_parseAllowedValues``. Kept as a
 * separate function so a future divergence (e.g. allowed_values
 * preserving case, match_aliases lower-casing) lands cleanly.
 */
function _parseMatchAliases(text: string): string[] {
  return _parseDedupedTokenList(text);
}

function _parseDedupedTokenList(text: string): string[] {
  if (!text || !text.trim()) return [];
  const tokens = text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Phase 4C compat — kept exported for any caller that still uses
 * the raw split. Defers to the deduped parser so the de-dup +
 * trim semantics stay consistent.
 *
 * @deprecated prefer ``_parseAllowedValues`` /
 *   ``_parseMatchAliases`` so the call site reads which list
 *   semantics it wants.
 */
function _splitList(text: string): string[] {
  return _parseDedupedTokenList(text);
}
// Mark as referenced so a stale import doesn't fail the build.
void _splitList;

/**
 * Build the ``POST /api/v1/export-profiles`` payload from form state.
 * Caller is responsible for running ``validateForm`` first; this
 * builder doesn't re-validate (a 422 from the backend is the safety
 * net for any rule the form's validator missed).
 *
 * Phase 4D — create payloads NEVER carry ``_raw_settings`` /
 * ``_raw_original`` because new profiles have no unknown
 * forward-compat keys to preserve. Starter profiles built via
 * ``buildStarterForm`` produce raw-less form state by design.
 */
export function buildCreatePayload(
  state: ExportProfileFormState,
): PersistedExportProfileCreate {
  return {
    name: state.name.trim(),
    target_system: state.target_system,
    description: state.description.trim() || null,
    settings: _settingsToPayload(state.settings, state._raw_settings),
    columns: state.columns.map(_columnToPayload),
    is_active: state.is_active,
    is_default: state.is_default,
    source: state.source,
    notes: state.notes.trim() || null,
  };
}

/**
 * Build the ``PATCH /api/v1/export-profiles/{id}`` payload.
 *
 * Phase 4C sends the full editable surface on every PATCH — the
 * backend treats ``settings`` / ``columns`` as REPLACE-on-write
 * and bumps ``version`` only when those JSONB blobs change. Since
 * the form's settings + columns always carry the latest editable
 * snapshot, we send them every time and let the backend decide
 * whether the version actually moves.
 *
 * Phase 4D — Unknown / forward-compat keys captured from the
 * incoming record (``state._raw_settings`` for the settings dict,
 * ``column._raw_original`` per column row) are merged BEHIND the
 * editor's known fields so a PATCH never silently drops a
 * vendor-specific extension or a backend field the editor doesn't
 * surface yet. Removed columns lose their unknown fields by
 * design — the row is gone, so its raw object is gone too.
 */
export function buildUpdatePayload(
  state: ExportProfileFormState,
): PersistedExportProfileUpdate {
  return {
    name: state.name.trim(),
    description: state.description.trim() || null,
    settings: _settingsToPayload(state.settings, state._raw_settings),
    columns: state.columns.map(_columnToPayload),
    is_active: state.is_active,
    is_default: state.is_default,
    notes: state.notes.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Public — validation
// ---------------------------------------------------------------------------

export interface ExportProfileFormErrors {
  /** Top-level errors not tied to a single column row. */
  form: string[];
  /** Per-column-index → list of human-readable errors. */
  columns: Map<number, string[]>;
}

export function emptyFormErrors(): ExportProfileFormErrors {
  return { form: [], columns: new Map() };
}

export function hasFormErrors(errors: ExportProfileFormErrors): boolean {
  if (errors.form.length > 0) return true;
  const lists = Array.from(errors.columns.values());
  for (const list of lists) {
    if (list.length > 0) return true;
  }
  return false;
}

/**
 * Validate the form state against the same business rules the
 * backend enforces (target system enum, non-empty name, column
 * key uniqueness, output_header non-empty, data_type closed set,
 * positive integer max_length).
 *
 * Phase 4D hardening — duplicate keys are compared
 * case-insensitively (matching the Phase 4A management service's
 * column-key uniqueness rule), BOTH the original and the
 * duplicate row are flagged, and decimal / negative / non-numeric
 * ``max_length`` inputs each produce a targeted message.
 *
 * Returns BOTH the errors AND a sanitised form state with whitespace
 * trimmed so the caller can feed the sanitised state straight into
 * the payload builder. Pure — never mutates the input.
 */
export function validateForm(
  state: ExportProfileFormState,
): { errors: ExportProfileFormErrors; sanitized: ExportProfileFormState } {
  const errors = emptyFormErrors();
  const sanitized: ExportProfileFormState = {
    ...state,
    name: state.name.trim(),
    description: state.description.trim(),
    notes: state.notes.trim(),
    columns: state.columns.map((c) => ({ ...c })),
  };

  if (!sanitized.name) {
    errors.form.push("Name is required.");
  }
  if (
    !(EXPORT_PROFILE_TARGET_SYSTEMS as readonly string[]).includes(
      sanitized.target_system,
    )
  ) {
    errors.form.push(
      `Target system must be one of: ${EXPORT_PROFILE_TARGET_SYSTEMS.join(", ")}.`,
    );
  }
  if (sanitized.columns.length === 0) {
    errors.form.push("At least one column is required.");
  }

  // ---- First pass — surface per-row issues + collect a
  // case-insensitive key map so the second pass can mark BOTH
  // sides of a duplicate.
  const colErrorsByIndex = new Map<number, string[]>();
  const keyOccurrences = new Map<string, number[]>();
  sanitized.columns.forEach((col, idx) => {
    const colErrors: string[] = [];
    const trimmedKey = col.key.trim();
    const label = col.label.trim();
    const outputHeader = col.output_header.trim() || label;

    if (!trimmedKey) colErrors.push("Column key is required.");
    if (!label) colErrors.push("Column label is required.");
    if (!outputHeader) {
      colErrors.push("Output header is required.");
    }
    if (
      !(EXPORT_PROFILE_DATA_TYPES as readonly string[]).includes(col.data_type)
    ) {
      colErrors.push(
        `Data type must be one of: ${EXPORT_PROFILE_DATA_TYPES.join(", ")}.`,
      );
    }
    // ``max_length`` — empty is allowed (omitted from payload).
    // Reject non-numeric, non-positive, and decimal inputs with
    // targeted messages so the operator can tell which axis to
    // fix.
    const maxLengthRaw = col.max_length.trim();
    if (maxLengthRaw) {
      // Reject obvious non-numerics first (e.g. "n/a", "abc")
      // before the parseInt — parseInt would silently coerce
      // ``"12abc"`` to 12 otherwise.
      if (!/^-?\d+(\.\d+)?$/.test(maxLengthRaw)) {
        colErrors.push("Max length must be a positive integer.");
      } else if (maxLengthRaw.includes(".")) {
        colErrors.push("Max length must be a whole number (no decimals).");
      } else {
        const n = parseInt(maxLengthRaw, 10);
        if (!Number.isFinite(n) || n <= 0) {
          colErrors.push("Max length must be a positive integer.");
        }
      }
    }

    if (trimmedKey) {
      const normalised = trimmedKey.toLowerCase();
      const list = keyOccurrences.get(normalised);
      if (list) {
        list.push(idx);
      } else {
        keyOccurrences.set(normalised, [idx]);
      }
    }

    if (colErrors.length > 0) {
      colErrorsByIndex.set(idx, colErrors);
    }
  });

  // ---- Second pass — mark BOTH sides of every duplicate key.
  // Phase 4D — case-insensitive comparison matches the backend
  // management service's uniqueness rule.
  const dupKeys = Array.from(keyOccurrences.entries()).filter(
    ([, indexes]) => indexes.length > 1,
  );
  for (const [normalisedKey, indexes] of dupKeys) {
    for (const idx of indexes) {
      const peerRows = indexes
        .filter((other) => other !== idx)
        .map((i) => i + 1)
        .join(", ");
      const list = colErrorsByIndex.get(idx) ?? [];
      list.push(
        `Column key "${normalisedKey}" duplicates row ${peerRows}; keys must be unique (case-insensitive).`,
      );
      colErrorsByIndex.set(idx, list);
    }
  }

  // Array.from to avoid TS2802 Map-iteration target-compat issues.
  const entries = Array.from(colErrorsByIndex.entries());
  for (const [idx, list] of entries) {
    if (list.length > 0) errors.columns.set(idx, list);
  }
  return { errors, sanitized };
}

// ---------------------------------------------------------------------------
// Public — column-list operations (used by the UI)
// ---------------------------------------------------------------------------

export function moveColumn(
  columns: ExportProfileFormColumn[],
  index: number,
  direction: "up" | "down",
): ExportProfileFormColumn[] {
  const next = [...columns];
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= next.length) return next;
  const tmp = next[index]!;
  next[index] = next[target]!;
  next[target] = tmp;
  return next;
}

export function removeColumn(
  columns: ExportProfileFormColumn[],
  index: number,
): ExportProfileFormColumn[] {
  return columns.filter((_, i) => i !== index);
}

export function appendColumn(
  columns: ExportProfileFormColumn[],
  partial?: Partial<ExportProfileFormColumn>,
): ExportProfileFormColumn[] {
  return [...columns, blankFormColumn(partial)];
}
