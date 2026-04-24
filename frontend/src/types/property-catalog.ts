/**
 * Properties (property/unit master) — types mirror
 * `app/schemas/property_catalog.py`.
 *
 * One PropertyCatalog is a saved, named property master table the user
 * maintains. Decoupled from `InvoiceTemplate` and `GLCatalog`:
 *
 *   * InvoiceTemplate owns the COLUMN SHAPE of an invoice export.
 *   * GLCatalog owns the ROWS of a chart of accounts.
 *   * PropertyCatalog owns the ROWS of a property/unit master table
 *     that powers later property validation, abbreviation lookup,
 *     address lookup, and unit lookup.
 *
 * Same builder pattern across all three: list rail + center editor +
 * creation modal. Same source-of-origin metadata. Same JSONB-backed
 * editable list on the server.
 *
 * The Properties module is the first one to support **multi-file**
 * uploads. The backend exposes a single-file `parse-upload`; the
 * frontend orchestrates multi-file by calling that endpoint per file
 * and merging the per-file mapped rows into one canonical table via
 * `mergePropertyFiles` below. Practical example: file A is a Yardi
 * "Property List" with property-level columns (name, address, city,
 * state, zip); file B is an "Unit Roster" with unit-level columns
 * (property code, unit number, unit type). Both contribute to the
 * final per-unit canonical table.
 */

/**
 * Where this catalog was originally seeded. Informational — drives a
 * small "origin" hint in the UI but has no functional effect.
 */
export type PropertyCatalogSource =
  | "default"
  | "blank"
  | "from_upload"
  | "custom";

/**
 * One entry inside a catalog's `entries` array.
 *
 * `id` is a stable client-side string key (not a numeric index) so
 * reordering / mid-edit React reconciliation stays correct. Generated
 * client-side when adding a row; the backend only enforces uniqueness
 * within the catalog.
 *
 * Only `property_name` and `property_code` are required — they form
 * the row identity that downstream validation joins against. Every
 * other field is optional (nullable string or bool).
 *
 * `unit_number` empty means "property-level row" (a building summary
 * entry). The same `property_code` can repeat across many `unit_number`
 * values — uniqueness within the catalog is on the **pair**.
 *
 * `active` defaults to true so freshly added entries are "live"; users
 * can mark legacy / decommissioned units inactive without deleting
 * them.
 */
export interface PropertyCatalogEntry {
  id: string;
  property_name: string;
  property_code: string;
  property_abbreviation: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  unit_number: string | null;
  unit_type: string | null;
  building: string | null;
  active: boolean;
  notes: string | null;
}

export interface PropertyCatalogOut {
  id: string;
  name: string;
  description: string | null;
  entries: PropertyCatalogEntry[];
  source: PropertyCatalogSource;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PropertyCatalogSummary {
  id: string;
  name: string;
  description: string | null;
  source: PropertyCatalogSource;
  entry_count: number;
  created_at: string;
  updated_at: string;
}

export interface PropertyCatalogList {
  items: PropertyCatalogSummary[];
}

/**
 * Built-in canonical catalog returned by GET /defaults/canonical. Not
 * persisted — the frontend uses it as an editable starter draft.
 */
export interface PropertyCatalogDefault {
  name: string;
  description: string | null;
  entries: PropertyCatalogEntry[];
}

/** POST body — all top-level fields required. */
export interface PropertyCatalogCreate {
  name: string;
  description?: string | null;
  entries: PropertyCatalogEntry[];
  source?: PropertyCatalogSource;
}

/**
 * PATCH body. Every field optional; omitting a field leaves the
 * persisted value unchanged. Sending `entries` REPLACES the array
 * outright — the editor always sends the full new ordered list.
 * Sending `null` for `description` clears it.
 */
export interface PropertyCatalogUpdate {
  name?: string;
  description?: string | null;
  entries?: PropertyCatalogEntry[];
}

/**
 * Mapping from BillsIQ's canonical property fields to source column
 * names in an uploaded file.
 *
 * Each value is either:
 *   * the EXACT NAME of a column in `ParsedPropertyUpload.source_columns`
 *     (matching the string the user picks in the field's dropdown), or
 *   * `null`, meaning "no source column maps to this canonical field".
 *
 * Mid-mapping, leaving a required field as `null` is fine — the
 * mapping step's "Continue" button is gated on every required field
 * being mapped before the canonical entries are assembled.
 *
 * Mirrors `app.schemas.property_catalog.PropertyUploadMapping`.
 */
export interface PropertyUploadMapping {
  property_name: string | null;
  property_code: string | null;
  property_abbreviation: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  unit_number: string | null;
  unit_type: string | null;
  building: string | null;
  active: string | null;
  notes: string | null;
}

/**
 * Result of POST /property-catalogs/parse-upload — a one-shot parse
 * of ONE csv/xlsx property upload.
 *
 * The parser surfaces RAW source data (header columns + data rows) and
 * a best-effort `suggested_mapping` from the canonical BillsIQ
 * property fields to source column names. The frontend then runs an
 * explicit column-mapping step where the user confirms or overrides
 * each suggestion before the canonical entries are assembled.
 *
 * Multi-file uploads are orchestrated client-side: call this endpoint
 * once per file, accumulate `ParsedPropertyUpload`s, present a per-
 * file mapping UI, then merge confirmed mappings via
 * `mergePropertyFiles`.
 */
export interface ParsedPropertyUpload {
  filename: string;
  detected_format: "csv" | "xlsx";
  /** Header cells from the uploaded file, in order. Empty when no
   * recognizable header row was found. */
  source_columns: string[];
  /** Data rows below the header, each padded / truncated to
   * `source_columns.length`. Capped server-side at MAX_ENTRIES. */
  source_rows: string[][];
  /** Best-effort canonical-field → source-column-name guess. Always
   * shown to the user on the mapping step — never silently committed.
   * Sentinel `null` means the parser couldn't match that field. */
  suggested_mapping: PropertyUploadMapping;
  /** Set when the parser still returned a response but something is
   * worth telling the user about — e.g. no recognizable header, or
   * rows were truncated to MAX_ENTRIES. */
  parse_warning: string | null;
}

/** Bounds enforced by the backend Pydantic schema. */
export const MIN_ENTRIES = 1;
export const MAX_ENTRIES = 20000;
export const MAX_NAME_LENGTH = 255;
export const MAX_CODE_LENGTH = 64;
export const MAX_ABBR_LENGTH = 32;
export const MAX_ADDRESS_LENGTH = 255;
export const MAX_CITY_LENGTH = 120;
export const MAX_STATE_LENGTH = 64;
export const MAX_ZIP_LENGTH = 20;
export const MAX_UNIT_NUMBER_LENGTH = 64;
export const MAX_UNIT_TYPE_LENGTH = 64;
export const MAX_BUILDING_LENGTH = 64;
export const MAX_NOTES_LENGTH = 1000;

/**
 * Generate a stable client-side id for a freshly-added entry. Uses
 * `crypto.randomUUID` where available, falls back to a Math.random
 * hex so the entry-id contract holds in environments without a crypto
 * API. The backend validates uniqueness within the catalog, not the
 * format — `e-0` style ids from a fresh draft are accepted.
 */
export function newEntryId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `e-${Math.random().toString(16).slice(2, 10)}-${Date.now().toString(
    16,
  )}`;
}

// ---------------------------------------------------------------------------
// Canonical property fields — single source of truth for the mapping UI
// ---------------------------------------------------------------------------

/**
 * Keys of the canonical property schema, in the order the mapping UI
 * lists them. Matches `PropertyUploadMapping`'s field names.
 *
 * Order is "identity first (property), then geographic, then unit-
 * level, then meta" — same way the user reads the editor table.
 */
export type CanonicalPropertyFieldKey =
  | "property_code"
  | "property_name"
  | "property_abbreviation"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "unit_number"
  | "unit_type"
  | "building"
  | "active"
  | "notes";

/**
 * Describes one canonical BillsIQ property field for the mapping step.
 *
 * `required: true` means the mapping step's "Continue" button stays
 * disabled until the user picks a source column for this field.
 * Optional fields may be left unmapped; the canonical entry's value
 * for that field becomes the documented default (null for nullable
 * strings, true for `active`).
 *
 * Note: across multiple uploaded files, only ONE file needs to map a
 * given canonical field for the merge to fill it. So if file A has
 * "Address" but file B doesn't, file B's mapping for `address` can
 * stay unmapped and the merge will still produce filled-in addresses
 * for matching property rows. Required fields (property_code,
 * property_name) must be mappable per-file or the file is unusable.
 */
export interface CanonicalPropertyField {
  key: CanonicalPropertyFieldKey;
  label: string;
  required: boolean;
  /** True when this field is property-level (vs unit-level). Used by
   * the merge to broadcast property-level fields from donor rows down
   * onto unit-level rows of the same property. */
  propertyLevel: boolean;
  /** One-sentence hint shown under the dropdown. */
  hint: string;
}

export const CANONICAL_PROPERTY_FIELDS: readonly CanonicalPropertyField[] = [
  {
    key: "property_code",
    label: "Property Code",
    required: true,
    propertyLevel: true,
    hint: "The unique property identifier — e.g. VST, OAK-001, MF1234.",
  },
  {
    key: "property_name",
    label: "Property Name",
    required: true,
    propertyLevel: true,
    hint: "Human-readable property name — e.g. Vista Apartments.",
  },
  {
    key: "property_abbreviation",
    label: "Abbreviation",
    required: false,
    propertyLevel: true,
    hint: "Optional short tag used by exports.",
  },
  {
    key: "address",
    label: "Street Address",
    required: false,
    propertyLevel: true,
    hint: "Street address — e.g. 100 Sunset Drive.",
  },
  {
    key: "city",
    label: "City",
    required: false,
    propertyLevel: true,
    hint: "City name.",
  },
  {
    key: "state",
    label: "State / Region",
    required: false,
    propertyLevel: true,
    hint: "State or province — free text (TX, CA, Ontario).",
  },
  {
    key: "zip",
    label: "ZIP / Postal Code",
    required: false,
    propertyLevel: true,
    hint: "ZIP or postal code — free text.",
  },
  {
    key: "unit_number",
    label: "Unit Number",
    required: false,
    propertyLevel: false,
    hint:
      "Optional. Empty rows are treated as property-level summary " +
      "entries; populated rows are unit-level.",
  },
  {
    key: "unit_type",
    label: "Unit Type",
    required: false,
    propertyLevel: false,
    hint: "Floorplan or type — e.g. 1BR, 2BR, Townhouse.",
  },
  {
    key: "building",
    label: "Building / Phase",
    required: false,
    propertyLevel: false,
    hint: "Building name, number, or phase.",
  },
  {
    key: "active",
    label: "Active / Inactive",
    required: false,
    propertyLevel: false,
    hint:
      "Optional status flag. Recognizes yes/no, true/false, 1/0, " +
      "active/inactive, occupied/vacant. Missing values default to active.",
  },
  {
    key: "notes",
    label: "Notes",
    required: false,
    propertyLevel: false,
    hint: "Optional internal context.",
  },
];

/** Required canonical field keys (derived from CANONICAL_PROPERTY_FIELDS). */
export const REQUIRED_PROPERTY_FIELD_KEYS: readonly CanonicalPropertyFieldKey[] =
  CANONICAL_PROPERTY_FIELDS.filter((f) => f.required).map((f) => f.key);

/** Property-level canonical field keys — used by the merge broadcast. */
export const PROPERTY_LEVEL_FIELD_KEYS: readonly CanonicalPropertyFieldKey[] =
  CANONICAL_PROPERTY_FIELDS.filter((f) => f.propertyLevel).map((f) => f.key);

/** Empty mapping — every canonical field unmapped. */
export function emptyPropertyUploadMapping(): PropertyUploadMapping {
  return {
    property_name: null,
    property_code: null,
    property_abbreviation: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    unit_number: null,
    unit_type: null,
    building: null,
    active: null,
    notes: null,
  };
}

// ---------------------------------------------------------------------------
// Active-cell interpretation
// ---------------------------------------------------------------------------

const ACTIVE_TRUE_TOKENS = new Set([
  "yes",
  "y",
  "true",
  "t",
  "1",
  "active",
  "enabled",
  "open",
  "occupied",
  "live",
]);

const ACTIVE_FALSE_TOKENS = new Set([
  "no",
  "n",
  "false",
  "f",
  "0",
  "inactive",
  "disabled",
  "closed",
  "archived",
  "deleted",
  "vacant",
  "down",
]);

/**
 * Map a string from the optional `active` source column to a bool.
 *
 * Defaults to `true` when the cell is empty or unrecognized — a
 * missing status almost always means "active" in the source systems
 * we've seen, and the user can flip individual rows in the editor
 * after import.
 *
 * Lives here (rather than in the backend parser) because the column
 * the user maps to `active` isn't known until the mapping step
 * confirms it — the same source value ("Open") might be a status in
 * one upload and a category in another.
 */
export function interpretActive(raw: string | null | undefined): boolean {
  if (!raw) return true;
  const norm = raw.trim().toLowerCase();
  if (!norm) return true;
  if (ACTIVE_FALSE_TOKENS.has(norm)) return false;
  if (ACTIVE_TRUE_TOKENS.has(norm)) return true;
  return true;
}

// ---------------------------------------------------------------------------
// Mapping → canonical entries (single file)
// ---------------------------------------------------------------------------

/**
 * Result of applying a `PropertyUploadMapping` to one file's source rows.
 *
 * Unlike GL Codes, this function does NOT dedupe or merge — that's the
 * job of `mergePropertyFiles`. Each source row becomes one canonical
 * entry (modulo blank-identity rows being dropped). The merge step
 * then:
 *   * collapses (property, unit) duplicates across files,
 *   * broadcasts property-level fields from donor rows onto unit
 *     rows of the same property,
 *   * drops absorbed donors.
 */
export interface MappedPropertyRows {
  entries: PropertyCatalogEntry[];
  /** Source rows dropped because both `property_code` AND
   * `property_name` were blank (no row identity at all). */
  blankIdentityCount: number;
  /** Source rows dropped because the resolved `property_code` or
   * `property_name` was a bare summary token ("Total", "Grand Total",
   * "Subtotal", …) AND the OTHER identity field was blank or also a
   * summary token. Defense in depth on top of the backend's universal
   * `_is_summary_row` filter — catches footer rows that slipped past
   * the parser (e.g. a paste-in CSV with funky cell values, or a
   * future format whose footer pattern the backend doesn't recognize).
   * Without this, such rows surface as a ghost `Total / Total` entry
   * after the merge step's PASS-3 code↔name mirror. */
  summaryRowsSkipped: number;
}

/**
 * Bare summary tokens that downstream code refuses to accept as a
 * legitimate property identity value. Anchored — only EXACT matches
 * (case + whitespace insensitive) qualify. A real property name like
 * "Total Wine Plaza" is NOT in this set, so it stays a valid identity.
 *
 * Mirrors the backend `_SUMMARY_PREFIXES` list in
 * `app/domain/property_upload_parse.py`. Keep these in sync — when one
 * side learns a new footer label, teach the other.
 */
const _SUMMARY_TOKENS: ReadonlySet<string> = new Set([
  "total",
  "totals",
  "subtotal",
  "sub total",
  "sub-total",
  "property total",
  "property totals",
  "property subtotal",
  "grand total",
  "grand totals",
  "report total",
  "report totals",
  "summary",
  "page total",
]);

function _isSummaryToken(value: string | null | undefined): boolean {
  const norm = (value || "").trim().toLowerCase();
  if (!norm) return false;
  return _SUMMARY_TOKENS.has(norm);
}

/**
 * Apply a confirmed mapping to ONE file's source rows, producing
 * canonical `PropertyCatalogEntry`s.
 *
 * Behaviour:
 *   * Rows where both `property_code` AND `property_name` are blank
 *     are dropped and counted as `blankIdentityCount`. Without either,
 *     the row has no identity and can't be merged.
 *   * Rows where the resolved code or name is a bare summary token
 *     ("Total", "Grand Total", …) AND the other identity field is
 *     blank-or-also-a-token are dropped and counted as
 *     `summaryRowsSkipped`. Defense in depth on top of the backend's
 *     `_is_summary_row` filter — catches the ghost `Total / Total`
 *     row at the materialization layer regardless of whether the file
 *     went through the grouped or flat parser path. A row with a real
 *     code (e.g. "VST") and a quirky name like "Total" is KEPT
 *     untouched — the heuristic only fires when one side is a token
 *     and the other has no real identity to anchor on.
 *   * Rows are NOT post-processed to mirror code↔name. Leaving the
 *     unmapped one blank lets the merge step fill it from a donor row
 *     of the same property — otherwise a placeholder "VST"-as-name
 *     value would block the donor broadcast from supplying the real
 *     "Vista Apartments". The merge does a final mirror pass at the
 *     end for any rows that no donor reached, so single-file uploads
 *     still satisfy the Pydantic required-field invariant.
 *   * `active` cells are interpreted via `interpretActive`. When no
 *     source column is mapped, every entry gets `active: true`.
 *   * Optional string fields collapse blank → `null` to match the
 *     canonical schema's nullable string convention.
 *
 * The returned IDs are fresh client-side IDs — they're throwaway
 * because the merge step regenerates IDs after deduplication.
 */
export function applyMappingToSourceRows(
  sourceColumns: readonly string[],
  sourceRows: readonly (readonly string[])[],
  mapping: PropertyUploadMapping,
): MappedPropertyRows {
  // Resolve column NAMES → INDICES once. Unknown names (or `null`)
  // map to -1, treated as "no source column for this field".
  const resolveIdx = (col: string | null): number => {
    if (!col) return -1;
    const idx = sourceColumns.indexOf(col);
    return idx >= 0 ? idx : -1;
  };

  const idx = {
    property_name: resolveIdx(mapping.property_name),
    property_code: resolveIdx(mapping.property_code),
    property_abbreviation: resolveIdx(mapping.property_abbreviation),
    address: resolveIdx(mapping.address),
    city: resolveIdx(mapping.city),
    state: resolveIdx(mapping.state),
    zip: resolveIdx(mapping.zip),
    unit_number: resolveIdx(mapping.unit_number),
    unit_type: resolveIdx(mapping.unit_type),
    building: resolveIdx(mapping.building),
    active: resolveIdx(mapping.active),
    notes: resolveIdx(mapping.notes),
  };

  const cellAt = (row: readonly string[], i: number): string => {
    if (i < 0 || i >= row.length) return "";
    return (row[i] ?? "").trim();
  };

  const entries: PropertyCatalogEntry[] = [];
  let blankIdentityCount = 0;
  let summaryRowsSkipped = 0;

  for (const row of sourceRows) {
    const code = cellAt(row, idx.property_code);
    const name = cellAt(row, idx.property_name);
    if (!code && !name) {
      blankIdentityCount += 1;
      continue;
    }

    // Defense-in-depth: reject footer/summary rows that survived the
    // backend filter. We only fire when one identity slot is a known
    // summary token AND the other slot has no real value to anchor
    // on. That keeps the heuristic from clobbering a legitimate row
    // with quirky data (e.g. property_code="VST" + property_name="Total")
    // while still catching the ghost-row pattern (one side blank or
    // both sides token).
    const codeIsToken = _isSummaryToken(code);
    const nameIsToken = _isSummaryToken(name);
    if (
      (codeIsToken && (!name || nameIsToken)) ||
      (nameIsToken && (!code || codeIsToken))
    ) {
      summaryRowsSkipped += 1;
      continue;
    }

    const activeRaw = idx.active >= 0 ? cellAt(row, idx.active) : null;

    entries.push({
      id: newEntryId(),
      property_name: name,
      property_code: code,
      property_abbreviation: cellAt(row, idx.property_abbreviation) || null,
      address: cellAt(row, idx.address) || null,
      city: cellAt(row, idx.city) || null,
      state: cellAt(row, idx.state) || null,
      zip: cellAt(row, idx.zip) || null,
      unit_number: cellAt(row, idx.unit_number) || null,
      unit_type: cellAt(row, idx.unit_type) || null,
      building: cellAt(row, idx.building) || null,
      active: interpretActive(activeRaw),
      notes: cellAt(row, idx.notes) || null,
    });
  }

  return { entries, blankIdentityCount, summaryRowsSkipped };
}

// ---------------------------------------------------------------------------
// Multi-file merge
// ---------------------------------------------------------------------------

/**
 * Per-file input to `mergePropertyFiles`. We only need the mapped
 * entries plus the file's display name (for the rejection summary).
 */
export interface PropertyFileContribution {
  filename: string;
  entries: PropertyCatalogEntry[];
}

/**
 * Stats surfaced by the merge — rendered as a one-line summary above
 * the preview table so the user can sanity-check what happened.
 */
export interface PropertyMergeStats {
  /** Total rows the merge consumed across all files. */
  totalSourceRows: number;
  /** Final row count in the canonical table after dedup + broadcast. */
  finalRowCount: number;
  /** Number of (property, unit) groups that collapsed two or more
   * source rows into one (cross-file de-dupe). */
  duplicatePairsMerged: number;
  /** Number of property-level "donor" rows that were absorbed into
   * unit-level rows of the same property. */
  donorsAbsorbed: number;
  /** Number of unit-level rows that picked up at least one property-
   * level field from a donor. */
  unitsEnrichedFromDonor: number;
  /** Number of source rows whose grouping key got rewritten via the
   * cross-file identity registry. Indicates how many name-only rows
   * in one file were matched to code+name rows in another file (or
   * vice versa) so they ended up in the same property bucket
   * instead of two parallel buckets that don't merge. */
  crossFileIdentitiesResolved: number;
}

export interface MergedPropertyResult {
  entries: PropertyCatalogEntry[];
  stats: PropertyMergeStats;
}

/**
 * Lowercase + trim a candidate identity value so cross-file matching
 * is whitespace / case insensitive. Returns "" for null / blank.
 */
function _normIdentity(v: string | null | undefined): string {
  return (v || "").trim().toLowerCase();
}

function _unitKey(entry: PropertyCatalogEntry): string {
  return _normIdentity(entry.unit_number);
}

function _isBlank(v: string | null | undefined): boolean {
  return v === null || v === undefined || v === "";
}

/**
 * Cross-file identity registry built from rows that carry BOTH
 * `property_code` AND `property_name`. Used by the merge to pick a
 * single canonical bucket for rows that only have one of the two.
 *
 * Two lookups are tracked side by side:
 *   * `codeForName` — name (lowercased) → canonical code (lowercased)
 *   * `nameForCode` — code (lowercased) → canonical name (lowercased)
 *
 * Conservative on purpose:
 *   * No fuzzy matching (no Levenshtein, no token overlap, no AI). A
 *     row with name "Vista Apts" does NOT match a registered "Vista
 *     Apartments" — there's no way to tell from one row whether the
 *     two strings refer to the same property.
 *   * Only registers code↔name pairs that appear EXPLICITLY together
 *     in the same row. A file that has separate property-level rows
 *     ("VST", "") and unit-level rows ("", "Vista Apartments") would
 *     not contribute to the registry — neither row pins the pairing.
 *   * First-row-wins on ties (later rows with conflicting pairings
 *     are ignored). This matches the rest of the merge's
 *     first-non-null-wins semantics. Conflicts are rare in practice
 *     because the user typically uploads one "primary" file with
 *     authoritative identities.
 *
 * Outputs `lowercased` keys + values so the bucket key the merge
 * derives matches the registry's canonical form regardless of the
 * raw casing in any contributing file.
 */
interface IdentityRegistry {
  codeForName: Map<string, string>;
  nameForCode: Map<string, string>;
}

function _buildIdentityRegistry(
  rows: readonly PropertyCatalogEntry[],
): IdentityRegistry {
  const codeForName = new Map<string, string>();
  const nameForCode = new Map<string, string>();
  for (const row of rows) {
    const code = _normIdentity(row.property_code);
    const name = _normIdentity(row.property_name);
    if (!code || !name) continue;
    if (!codeForName.has(name)) codeForName.set(name, code);
    if (!nameForCode.has(code)) nameForCode.set(code, name);
  }
  return { codeForName, nameForCode };
}

/**
 * Resolve a row to a canonical property bucket key.
 *
 * Algorithm (in order):
 *   1. If the row has BOTH code and name, the bucket key is `code` —
 *      the durable identifier. (Equivalent to "trust the code over
 *      the name when both are present.")
 *   2. If the row has only `code`, the bucket key is `code`.
 *   3. If the row has only `name`, look the name up in the registry:
 *      a. Hit → bucket key is the registered code (so this row joins
 *         the same bucket as the code-bearing rows).
 *      b. Miss → bucket key is `name` (best we can do — the row
 *         stays in a name-only bucket).
 *   4. No identity at all → return "" (caller should skip).
 *
 * Returns the resolved key plus a bool flagging whether the registry
 * actually rewrote the key (used for the
 * `crossFileIdentitiesResolved` stat).
 */
function _resolvePropertyKey(
  entry: PropertyCatalogEntry,
  registry: IdentityRegistry,
): { key: string; rewroteFromRegistry: boolean } {
  const code = _normIdentity(entry.property_code);
  const name = _normIdentity(entry.property_name);
  if (code) return { key: code, rewroteFromRegistry: false };
  if (name) {
    const registered = registry.codeForName.get(name);
    if (registered) {
      return { key: registered, rewroteFromRegistry: true };
    }
    return { key: name, rewroteFromRegistry: false };
  }
  return { key: "", rewroteFromRegistry: false };
}

/**
 * Merge a sequence of mapped per-file row sets into ONE canonical
 * property table.
 *
 * Multi-pass algorithm:
 *
 *   PASS 0 — Build the cross-file identity registry.
 *     Walk every row and record code↔name pairings from rows that
 *     carry BOTH fields. The registry lets a name-only row from one
 *     file (e.g. a flattened ResMan All Units file with banner names
 *     but no codes) bucket with the code-bearing rows from another
 *     file (e.g. a Property List with both code AND name). Without
 *     this, two files describing the same property via different
 *     identity columns would land in two separate buckets and never
 *     merge. See `_buildIdentityRegistry` for the conservative rules.
 *
 *   PASS 1 — Group + collapse duplicates.
 *     Bucket every row by `(propertyKey, unitKey)` where propertyKey
 *     is resolved via the registry (`_resolvePropertyKey`). Within a
 *     bucket (multiple files contributing rows for the same property
 *     + unit), merge fields with first-non-null-wins semantics. File
 *     order is the order the user uploaded the files in, which means
 *     the first file's value wins ties — rationale: most users
 *     upload their "primary" file first.
 *
 *   PASS 2 — Broadcast property-level donors onto unit rows.
 *     A "donor" is a property-level row (unitKey === "") for a
 *     property that ALSO has unit-level rows. The donor's property-
 *     level fields fill in any blanks on the unit rows. Then the
 *     donor itself is dropped — it's been absorbed.
 *     Property-level rows for properties WITHOUT any unit rows are
 *     kept as standalone property entries (the user might add units
 *     later in the editor).
 *
 *   PASS 3 — Final code↔name mirror for any rows the donor broadcast
 *     didn't reach. Guarantees the Pydantic invariant that both
 *     `property_code` and `property_name` are non-blank on every
 *     entry.
 *
 * The output is suitable for direct use as a `PropertyCatalogCreate.entries`
 * payload — the merge guarantees both required fields are non-blank
 * as long as at least one contributing row had at least one of them.
 */
export function mergePropertyFiles(
  contributions: readonly PropertyFileContribution[],
): MergedPropertyResult {
  const allRows: PropertyCatalogEntry[] = [];
  for (const c of contributions) {
    for (const e of c.entries) allRows.push(e);
  }

  if (allRows.length === 0) {
    return {
      entries: [],
      stats: {
        totalSourceRows: 0,
        finalRowCount: 0,
        duplicatePairsMerged: 0,
        donorsAbsorbed: 0,
        unitsEnrichedFromDonor: 0,
        crossFileIdentitiesResolved: 0,
      },
    };
  }

  // ---- PASS 0: build the cross-file identity registry ---------------
  const registry = _buildIdentityRegistry(allRows);

  // ---- PASS 1: bucket by (propertyKey, unitKey) and merge fields ----
  type Bucket = {
    propertyKey: string;
    unitKey: string;
    rows: PropertyCatalogEntry[];
  };
  const buckets = new Map<string, Bucket>();
  const bucketOrder: string[] = [];
  let crossFileIdentitiesResolved = 0;

  for (const row of allRows) {
    const { key: propertyKey, rewroteFromRegistry } = _resolvePropertyKey(
      row,
      registry,
    );
    if (!propertyKey) continue; // safety — applyMapping should have filtered
    if (rewroteFromRegistry) crossFileIdentitiesResolved += 1;
    const unitKey = _unitKey(row);
    const groupKey = `${propertyKey}::${unitKey}`;
    let bucket = buckets.get(groupKey);
    if (!bucket) {
      bucket = { propertyKey, unitKey, rows: [] };
      buckets.set(groupKey, bucket);
      bucketOrder.push(groupKey);
    }
    bucket.rows.push(row);
  }

  /**
   * First-non-null-wins merge across rows in a bucket. The first row
   * is the seed; subsequent rows fill in only blank fields. `active`
   * is OR-ed (any active wins) — matches the intuition that a unit
   * marked active in one file should be considered active overall.
   */
  const mergeBucket = (rows: PropertyCatalogEntry[]): PropertyCatalogEntry => {
    const out: PropertyCatalogEntry = {
      id: newEntryId(),
      property_name: rows[0].property_name,
      property_code: rows[0].property_code,
      property_abbreviation: rows[0].property_abbreviation,
      address: rows[0].address,
      city: rows[0].city,
      state: rows[0].state,
      zip: rows[0].zip,
      unit_number: rows[0].unit_number,
      unit_type: rows[0].unit_type,
      building: rows[0].building,
      active: rows[0].active,
      notes: rows[0].notes,
    };
    for (let i = 1; i < rows.length; i += 1) {
      const r = rows[i];
      if (_isBlank(out.property_name)) out.property_name = r.property_name;
      if (_isBlank(out.property_code)) out.property_code = r.property_code;
      if (_isBlank(out.property_abbreviation))
        out.property_abbreviation = r.property_abbreviation;
      if (_isBlank(out.address)) out.address = r.address;
      if (_isBlank(out.city)) out.city = r.city;
      if (_isBlank(out.state)) out.state = r.state;
      if (_isBlank(out.zip)) out.zip = r.zip;
      if (_isBlank(out.unit_number)) out.unit_number = r.unit_number;
      if (_isBlank(out.unit_type)) out.unit_type = r.unit_type;
      if (_isBlank(out.building)) out.building = r.building;
      // active OR — any active wins
      out.active = out.active || r.active;
      if (_isBlank(out.notes)) out.notes = r.notes;
    }
    return out;
  };

  const merged = new Map<string, PropertyCatalogEntry>();
  let duplicatePairsMerged = 0;
  for (const groupKey of bucketOrder) {
    const bucket = buckets.get(groupKey)!;
    if (bucket.rows.length > 1) duplicatePairsMerged += 1;
    merged.set(groupKey, mergeBucket(bucket.rows));
  }

  // ---- PASS 2: broadcast donors onto unit rows of the same property ----
  // Index donors (property-level rows: unitKey === "") by propertyKey.
  // First-seen donor wins (matches first-non-null semantics).
  const donorByProperty = new Map<string, PropertyCatalogEntry>();
  const propertiesWithUnits = new Set<string>();
  for (const groupKey of bucketOrder) {
    const bucket = buckets.get(groupKey)!;
    if (bucket.unitKey === "") {
      if (!donorByProperty.has(bucket.propertyKey)) {
        donorByProperty.set(bucket.propertyKey, merged.get(groupKey)!);
      }
    } else {
      propertiesWithUnits.add(bucket.propertyKey);
    }
  }

  let unitsEnrichedFromDonor = 0;
  for (const groupKey of bucketOrder) {
    const bucket = buckets.get(groupKey)!;
    if (bucket.unitKey === "") continue; // not a unit row
    const donor = donorByProperty.get(bucket.propertyKey);
    if (!donor) continue;
    const entry = merged.get(groupKey)!;
    let didEnrich = false;
    for (const key of PROPERTY_LEVEL_FIELD_KEYS) {
      const cur = entry[key] as string | null;
      const fromDonor = donor[key] as string | null;
      if (_isBlank(cur) && !_isBlank(fromDonor)) {
        // Type-safe narrow assignment — these keys are all string|null.
        (entry as unknown as Record<string, string | null>)[key] = fromDonor;
        didEnrich = true;
      }
    }
    if (didEnrich) unitsEnrichedFromDonor += 1;
  }

  // Drop donor rows whose property has unit rows — they've been absorbed.
  // Donors for properties without any units are kept as standalone rows.
  let donorsAbsorbed = 0;
  const finalEntries: PropertyCatalogEntry[] = [];
  for (const groupKey of bucketOrder) {
    const bucket = buckets.get(groupKey)!;
    if (bucket.unitKey === "" && propertiesWithUnits.has(bucket.propertyKey)) {
      donorsAbsorbed += 1;
      continue;
    }
    finalEntries.push(merged.get(groupKey)!);
  }

  // ---- PASS 3: final code↔name mirror for any rows the donor broadcast
  // didn't reach.
  //
  // A unit-only file (mapped property_code but not property_name) leaves
  // its rows with a non-blank code and a blank name. The donor broadcast
  // fills `property_name` from a same-property donor when one exists; if
  // there's no donor (e.g. truly single-file upload that only mapped
  // code), we fall back to mirroring code → name so the Pydantic schema
  // invariant ("both code and name are non-blank") still holds. The
  // user can fix it in the editor — but the catalog is at least
  // saveable. Same logic in reverse for name-only files.
  for (const entry of finalEntries) {
    if (_isBlank(entry.property_code) && !_isBlank(entry.property_name)) {
      entry.property_code = entry.property_name;
    } else if (_isBlank(entry.property_name) && !_isBlank(entry.property_code)) {
      entry.property_name = entry.property_code;
    }
  }

  return {
    entries: finalEntries,
    stats: {
      totalSourceRows: allRows.length,
      finalRowCount: finalEntries.length,
      duplicatePairsMerged,
      donorsAbsorbed,
      unitsEnrichedFromDonor,
      crossFileIdentitiesResolved,
    },
  };
}

// ---------------------------------------------------------------------------
// Required-field validation for a finished entries list
// ---------------------------------------------------------------------------

/**
 * Check whether a finished entries list satisfies the canonical schema's
 * required-field rules. Returned by the merge preview step so the
 * "Save catalog" button can be gated.
 */
export interface EntriesValidationResult {
  ok: boolean;
  /** Number of entries missing `property_code` or `property_name`. */
  missingRequired: number;
  /** Number of (property_code, unit_number) duplicate pairs. */
  duplicatePairs: number;
}

export function validatePropertyEntries(
  entries: readonly PropertyCatalogEntry[],
): EntriesValidationResult {
  let missingRequired = 0;
  const seenPairs = new Set<string>();
  let duplicatePairs = 0;
  for (const e of entries) {
    if (_isBlank(e.property_code) || _isBlank(e.property_name)) {
      missingRequired += 1;
    }
    const code = (e.property_code || "").trim().toLowerCase();
    const unit = (e.unit_number || "").trim().toLowerCase();
    const key = `${code}::${unit}`;
    if (seenPairs.has(key)) {
      duplicatePairs += 1;
    } else {
      seenPairs.add(key);
    }
  }
  return {
    ok: missingRequired === 0 && duplicatePairs === 0 && entries.length > 0,
    missingRequired,
    duplicatePairs,
  };
}
