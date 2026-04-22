/**
 * GL Codes (chart of accounts) — types mirror `app/schemas/gl_catalog.py`.
 *
 * One GLCatalog is a saved, named chart of accounts the user maintains
 * for ResMan invoice processing. Decoupled from `InvoiceTemplate`:
 *
 *   * InvoiceTemplate owns the COLUMN SHAPE of an invoice export.
 *   * GLCatalog owns the ROWS of a chart of accounts (one per GL code)
 *     the user later validates / maps invoice line-items against.
 *
 * Same builder pattern across both: list rail + center editor +
 * creation modal. Same source-of-origin metadata. Same JSONB-backed
 * editable list on the server.
 */

/**
 * Where this catalog was originally seeded. Informational — drives a
 * small "origin" hint in the UI but has no functional effect.
 */
export type GLCatalogSource =
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
 * `code` is free text (`"5100"`, `"6010-01"`, `"1100.10"`) — different
 * orgs use different conventions and we don't want to privilege one.
 *
 * `category` is a free-text group label ("Operating Expense",
 * "Asset", "Income"). Optional.
 *
 * `active` defaults to true; users can flip legacy/closed accounts to
 * inactive without deleting them.
 *
 * `notes` is for internal context — "use only for HOA pass-throughs",
 * etc.
 */
export interface GLCatalogEntry {
  id: string;
  code: string;
  description: string;
  category: string | null;
  active: boolean;
  notes: string | null;
}

export interface GLCatalogOut {
  id: string;
  name: string;
  description: string | null;
  entries: GLCatalogEntry[];
  source: GLCatalogSource;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface GLCatalogSummary {
  id: string;
  name: string;
  description: string | null;
  source: GLCatalogSource;
  entry_count: number;
  created_at: string;
  updated_at: string;
}

export interface GLCatalogList {
  items: GLCatalogSummary[];
}

/**
 * Built-in canonical catalog returned by GET /defaults/canonical. Not
 * persisted — the frontend uses it as an editable starter draft.
 */
export interface GLCatalogDefault {
  name: string;
  description: string | null;
  entries: GLCatalogEntry[];
}

/** POST body — all top-level fields required. */
export interface GLCatalogCreate {
  name: string;
  description?: string | null;
  entries: GLCatalogEntry[];
  source?: GLCatalogSource;
}

/**
 * PATCH body. Every field optional; omitting a field leaves the
 * persisted value unchanged. Sending `entries` REPLACES the array
 * outright — the editor always sends the full new ordered list.
 * Sending `null` for `description` clears it.
 */
export interface GLCatalogUpdate {
  name?: string;
  description?: string | null;
  entries?: GLCatalogEntry[];
}

/**
 * Mapping from BillsIQ's canonical GL fields to source column names
 * in an uploaded chart-of-accounts file.
 *
 * Each value is either:
 *   * the EXACT NAME of a column in `ParsedGLUpload.source_columns`
 *     (matching the string the user picks in the field's dropdown), or
 *   * `null`, meaning "no source column maps to this canonical field".
 *
 * Mid-mapping, leaving a required field as `null` is fine — the
 * mapping step's "Create catalog" button is gated on every required
 * field being mapped before the canonical entries are assembled.
 *
 * Mirrors `app.schemas.gl_catalog.GLUploadMapping`.
 */
export interface GLUploadMapping {
  code: string | null;
  description: string | null;
  category: string | null;
  active: string | null;
  notes: string | null;
}

/**
 * Result of POST /gl-catalogs/parse-upload — a one-shot parse of a
 * csv/xlsx GL chart upload.
 *
 * The parser surfaces RAW source data (header columns + data rows) and
 * a best-effort `suggested_mapping` from the canonical BillsIQ GL
 * fields to source column names. The frontend then runs an explicit
 * column-mapping step where the user confirms or overrides each
 * suggestion before the canonical entries are assembled.
 *
 * The parser deliberately does NOT pre-build entries — BillsIQ's
 * canonical schema is the source of truth and the user must explicitly
 * map source columns to canonical fields. The file itself is NOT
 * stored server-side.
 */
export interface ParsedGLUpload {
  filename: string;
  detected_format: "csv" | "xlsx";
  /** Header cells from the uploaded file, in order. Empty when no
   * recognizable header row was found. */
  source_columns: string[];
  /** Data rows below the header, each padded / truncated to
   * `source_columns.length` so column index N is meaningful for every
   * row. Capped server-side at MAX_ENTRIES. */
  source_rows: string[][];
  /** Best-effort canonical-field → source-column-name guess. Always
   * shown to the user on the mapping step — never silently committed.
   * Sentinel `null` means the parser couldn't match that field. */
  suggested_mapping: GLUploadMapping;
  /** Set when the parser still returned a response but something is
   * worth telling the user about — e.g. no recognizable header could
   * be identified, or rows were truncated to MAX_ENTRIES. */
  parse_warning: string | null;
}

/** Bounds enforced by the backend Pydantic schema. */
export const MIN_ENTRIES = 1;
export const MAX_ENTRIES = 5000;
export const MAX_CODE_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_CATEGORY_LENGTH = 120;
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
// Canonical GL fields — single source of truth for the mapping UI
// ---------------------------------------------------------------------------

/**
 * Keys of the canonical GL schema, in the order the mapping UI lists
 * them. Matches `GLUploadMapping`'s field names.
 */
export type CanonicalGLFieldKey =
  | "code"
  | "description"
  | "category"
  | "active"
  | "notes";

/**
 * Describes one canonical BillsIQ GL field for the mapping step.
 *
 * `required: true` means the mapping step's "Create catalog" button
 * stays disabled until the user picks a source column for this field.
 * Optional fields may be left unmapped; the canonical entry's value
 * for that field becomes the documented default (null for nullable
 * strings, true for `active`).
 */
export interface CanonicalGLField {
  key: CanonicalGLFieldKey;
  label: string;
  required: boolean;
  /** One-sentence hint shown under the dropdown. */
  hint: string;
}

export const CANONICAL_GL_FIELDS: readonly CanonicalGLField[] = [
  {
    key: "code",
    label: "GL Code",
    required: true,
    hint: "The unique account number — e.g. 5100, 6010-01, 1100.10.",
  },
  {
    key: "description",
    label: "Description",
    required: true,
    hint: "Human-readable account name.",
  },
  {
    key: "category",
    label: "Category / Group",
    required: false,
    hint: "Optional grouping like 'Operating Expense', 'Asset', 'Income'.",
  },
  {
    key: "active",
    label: "Active / Inactive",
    required: false,
    hint:
      "Optional status flag. Recognizes yes/no, true/false, 1/0, " +
      "active/inactive. Missing values default to active.",
  },
  {
    key: "notes",
    label: "Notes",
    required: false,
    hint: "Optional internal context.",
  },
];

/** Empty mapping — every canonical field unmapped. */
export function emptyGLUploadMapping(): GLUploadMapping {
  return {
    code: null,
    description: null,
    category: null,
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
// Mapping → canonical entries
// ---------------------------------------------------------------------------

/**
 * Result of applying a `GLUploadMapping` to the parser's source rows.
 *
 * `entries` is what gets sent to POST /gl-catalogs (after a final
 * de-dupe pass — see `dedupeAndCount` below). The counters surface
 * data-quality information the modal renders before the user
 * commits, so misdetections (mapping a "type" column to `code` and
 * getting 200 duplicates) are visible up front.
 */
export interface MappedSourceRows {
  entries: GLCatalogEntry[];
  blankRequiredCount: number;
  duplicateCodeCount: number;
}

/**
 * Apply a confirmed mapping to the parser's source rows, producing
 * canonical `GLCatalogEntry`s.
 *
 * Behaviour:
 *   * Rows whose mapped `code` is blank are dropped and counted as
 *     `blankRequiredCount` (`code` is required by the canonical
 *     schema; a row without it can't become a valid entry).
 *   * Rows whose mapped `description` is blank fall back to the code
 *     so the entry is at least constructible — the user can fix it in
 *     the editor after import.
 *   * Codes are de-duplicated case-insensitively; first occurrence
 *     wins and subsequent duplicates are counted as
 *     `duplicateCodeCount`. Matches the backend's uniqueness rule on
 *     `GLCatalogCreate`.
 *   * `active` cells are interpreted via `interpretActive`. When no
 *     source column is mapped, every entry gets `active: true`.
 *   * `category` and `notes` collapse blank → `null` to match the
 *     canonical schema's nullable string convention.
 *
 * `code` and `description` are the only required canonical fields;
 * the function still runs when other mappings are `null` — it just
 * leaves the corresponding canonical field at its default.
 */
export function applyMappingToSourceRows(
  sourceColumns: readonly string[],
  sourceRows: readonly (readonly string[])[],
  mapping: GLUploadMapping,
): MappedSourceRows {
  // Resolve column NAMES → INDICES once. Unknown names (or `null`)
  // map to -1, treated as "no source column for this field".
  const resolveIdx = (col: string | null): number => {
    if (!col) return -1;
    const idx = sourceColumns.indexOf(col);
    return idx >= 0 ? idx : -1;
  };

  const codeIdx = resolveIdx(mapping.code);
  const descIdx = resolveIdx(mapping.description);
  const catIdx = resolveIdx(mapping.category);
  const activeIdx = resolveIdx(mapping.active);
  const notesIdx = resolveIdx(mapping.notes);

  const cellAt = (row: readonly string[], idx: number): string => {
    if (idx < 0 || idx >= row.length) return "";
    return (row[idx] ?? "").trim();
  };

  const seenCodes = new Set<string>();
  const entries: GLCatalogEntry[] = [];
  let blankRequiredCount = 0;
  let duplicateCodeCount = 0;

  for (const row of sourceRows) {
    const code = cellAt(row, codeIdx);
    if (!code) {
      // No code → no canonical entry. Counted so the UI can warn.
      blankRequiredCount += 1;
      continue;
    }

    const codeKey = code.toLowerCase();
    if (seenCodes.has(codeKey)) {
      duplicateCodeCount += 1;
      continue;
    }
    seenCodes.add(codeKey);

    const description = cellAt(row, descIdx) || code;
    const categoryRaw = cellAt(row, catIdx);
    const notesRaw = cellAt(row, notesIdx);
    const activeRaw = activeIdx >= 0 ? cellAt(row, activeIdx) : null;

    entries.push({
      id: newEntryId(),
      code,
      description,
      category: categoryRaw || null,
      active: interpretActive(activeRaw),
      notes: notesRaw || null,
    });
  }

  return { entries, blankRequiredCount, duplicateCodeCount };
}
