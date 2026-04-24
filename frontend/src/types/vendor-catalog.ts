/**
 * Vendors (vendor master data) — types mirror `app/schemas/vendor_catalog.py`.
 *
 * One VendorCatalog is a saved, named vendor master list the user
 * maintains for ResMan invoice processing. Sibling of `GLCatalog` and
 * `PropertyCatalog` — same builder pattern across all three:
 *
 *   * InvoiceTemplate  — column shape of an invoice export.
 *   * GLCatalog        — chart-of-accounts rows.
 *   * PropertyCatalog  — property/unit master rows.
 *   * VendorCatalog    — vendor master rows (this module).
 *
 * Same JSONB-backed editable list on the server, same source-of-origin
 * metadata, same list-rail + center-editor + creation-modal UI.
 *
 * Distinct from `vendor-patterns` (extraction-confidence learning):
 *   * Vendor patterns describe what the extraction pipeline has SEEN.
 *   * Vendor catalogs describe what the user KNOWS — the canonical
 *     vendor list, with names, aliases, addresses, and contact info.
 *
 * Future invoice-payee matching will resolve extracted payees against
 * vendor catalog rows (using `vendor_name` + `aliases` as the match
 * surface). That logic isn't in this phase — the catalog being the
 * canonical source the user actively edits is the prerequisite.
 */

/**
 * Where this catalog was originally seeded. Informational — drives a
 * small "origin" hint in the UI but has no functional effect.
 */
export type VendorCatalogSource =
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
 * `vendor_name` is the SOLE hard-required canonical field — a row
 * without a name isn't a vendor.
 *
 * `vendor_code` is optional but strongly suggested. When present it's
 * the secondary match key for invoice resolution and must be unique
 * within the catalog (case-insensitive).
 *
 * `aliases` is the alternate-name surface — DBA names, abbreviations,
 * historical names, common misspellings. Stored as a structured list
 * so future matching can iterate per-alias in O(1). The editor renders
 * it as a comma-joined text input (low friction); the canonical
 * persisted shape stays structured.
 *
 * `state` is free text — international users have regions / provinces;
 * we don't validate against a US state list.
 *
 * `active` defaults to true; users can flip legacy/closed vendors to
 * inactive without deleting them.
 */
export interface VendorCatalogEntry {
  id: string;
  vendor_name: string;
  vendor_code: string | null;
  aliases: string[];
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
  notes: string | null;
}

export interface VendorCatalogOut {
  id: string;
  name: string;
  description: string | null;
  entries: VendorCatalogEntry[];
  source: VendorCatalogSource;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface VendorCatalogSummary {
  id: string;
  name: string;
  description: string | null;
  source: VendorCatalogSource;
  entry_count: number;
  created_at: string;
  updated_at: string;
}

export interface VendorCatalogList {
  items: VendorCatalogSummary[];
}

/**
 * Built-in canonical catalog returned by GET /defaults/canonical. Not
 * persisted — the frontend uses it as an editable starter draft.
 */
export interface VendorCatalogDefault {
  name: string;
  description: string | null;
  entries: VendorCatalogEntry[];
}

/** POST body — all top-level fields required. */
export interface VendorCatalogCreate {
  name: string;
  description?: string | null;
  entries: VendorCatalogEntry[];
  source?: VendorCatalogSource;
}

/**
 * PATCH body. Every field optional; omitting a field leaves the
 * persisted value unchanged. Sending `entries` REPLACES the array
 * outright — the editor always sends the full new ordered list.
 * Sending `null` for `description` clears it.
 */
export interface VendorCatalogUpdate {
  name?: string;
  description?: string | null;
  entries?: VendorCatalogEntry[];
}

/**
 * Mapping from BillsIQ's canonical vendor fields to source column names
 * in an uploaded vendor master file.
 *
 * Each value is either:
 *   * the EXACT NAME of a column in `ParsedVendorUpload.source_columns`
 *     (matching the string the user picks in the field's dropdown), or
 *   * `null`, meaning "no source column maps to this canonical field".
 *
 * Mid-mapping, leaving a required field as `null` is fine — the
 * mapping step's "Create catalog" button is gated on every required
 * field being mapped before the canonical entries are assembled.
 *
 * Note: `aliases` accepts a single source column whose value is split
 * client-side on common separators (comma / semicolon / pipe / slash).
 * Multi-column alias mapping isn't supported in this phase — most
 * exports keep aliases in a single delimited column.
 *
 * Mirrors `app.schemas.vendor_catalog.VendorUploadMapping`.
 */
export interface VendorUploadMapping {
  vendor_name: string | null;
  vendor_code: string | null;
  aliases: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  active: string | null;
  notes: string | null;
}

/**
 * Result of POST /vendor-catalogs/parse-upload — a one-shot parse of a
 * csv/xlsx vendor master upload.
 *
 * The parser surfaces RAW source data (header columns + data rows) and
 * a best-effort `suggested_mapping` from the canonical BillsIQ vendor
 * fields to source column names. The frontend then runs an explicit
 * column-mapping step where the user confirms or overrides each
 * suggestion before the canonical entries are assembled.
 *
 * The parser deliberately does NOT pre-build entries — BillsIQ's
 * canonical schema is the source of truth and the user must explicitly
 * map source columns to canonical fields. The file itself is NOT
 * stored server-side.
 */
export interface ParsedVendorUpload {
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
  suggested_mapping: VendorUploadMapping;
  /** Set when the parser still returned a response but something is
   * worth telling the user about — e.g. no recognizable header could
   * be identified, or rows were truncated to MAX_ENTRIES. */
  parse_warning: string | null;
}

/** Bounds enforced by the backend Pydantic schema. */
export const MIN_ENTRIES = 1;
export const MAX_ENTRIES = 5000;
export const MAX_NAME_LENGTH = 255;
export const MAX_CODE_LENGTH = 64;
export const MAX_ALIAS_LENGTH = 255;
export const MAX_ALIASES_PER_ENTRY = 16;
export const MAX_ADDRESS_LENGTH = 500;
export const MAX_CITY_LENGTH = 120;
export const MAX_STATE_LENGTH = 64;
export const MAX_ZIP_LENGTH = 32;
export const MAX_CONTACT_NAME_LENGTH = 255;
export const MAX_EMAIL_LENGTH = 320;
export const MAX_PHONE_LENGTH = 64;
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
// Canonical vendor fields — single source of truth for the mapping UI
// ---------------------------------------------------------------------------

/**
 * Keys of the canonical vendor schema, in the order the mapping UI
 * lists them. Matches `VendorUploadMapping`'s field names.
 */
export type CanonicalVendorFieldKey =
  | "vendor_name"
  | "vendor_code"
  | "aliases"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "contact_name"
  | "email"
  | "phone"
  | "active"
  | "notes";

/**
 * Describes one canonical BillsIQ vendor field for the mapping step.
 *
 * `required: true` means the mapping step's "Create catalog" button
 * stays disabled until the user picks a source column for this field.
 * Optional fields may be left unmapped; the canonical entry's value
 * for that field becomes the documented default (null for nullable
 * strings, true for `active`, [] for aliases).
 */
export interface CanonicalVendorField {
  key: CanonicalVendorFieldKey;
  label: string;
  required: boolean;
  /** One-sentence hint shown under the dropdown. */
  hint: string;
}

export const CANONICAL_VENDOR_FIELDS: readonly CanonicalVendorField[] = [
  {
    key: "vendor_name",
    label: "Vendor Name",
    required: true,
    hint: "The vendor's primary display name — payee on the invoice.",
  },
  {
    key: "vendor_code",
    label: "Vendor Code / External ID",
    required: false,
    hint:
      "Optional but recommended — the ResMan / Yardi vendor ID, tax ID, " +
      "or short stable key. Used as the secondary match key for invoices.",
  },
  {
    key: "aliases",
    label: "Aliases / Alternate Names",
    required: false,
    hint:
      "Optional — a single column with alternate names separated by " +
      "commas, semicolons, slashes, or pipes. Used for future invoice-" +
      "payee matching.",
  },
  {
    key: "address",
    label: "Address",
    required: false,
    hint: "Street address line.",
  },
  {
    key: "city",
    label: "City",
    required: false,
    hint: "City / town / municipality.",
  },
  {
    key: "state",
    label: "State / Region",
    required: false,
    hint: "Free text — US state, Canadian province, country region.",
  },
  {
    key: "zip",
    label: "ZIP / Postal Code",
    required: false,
    hint: "ZIP, postal, or postcode.",
  },
  {
    key: "contact_name",
    label: "Contact Name",
    required: false,
    hint: "Primary contact person at the vendor.",
  },
  {
    key: "email",
    label: "Email",
    required: false,
    hint: "Contact email address.",
  },
  {
    key: "phone",
    label: "Phone",
    required: false,
    hint: "Primary contact phone number.",
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
export function emptyVendorUploadMapping(): VendorUploadMapping {
  return {
    vendor_name: null,
    vendor_code: null,
    aliases: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    contact_name: null,
    email: null,
    phone: null,
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
 * one upload and a "open invoices" count in another.
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
// Alias splitting
// ---------------------------------------------------------------------------

// Comma, semicolon, pipe, slash, and newline. The split is generous —
// nothing forces vendors into one canonical separator across exports,
// and an over-eager split is easier to fix in the editor (drop a row)
// than a missed alias (manually re-add).
const ALIAS_SPLIT_RE = /[,;|\/\n]/;

/**
 * Split a delimited alias cell into a clean alias list.
 *
 * Behaviour:
 *   * Splits on `,` `;` `|` `/` and newlines.
 *   * Trims each token; drops blank tokens.
 *   * De-dupes case-insensitively (first occurrence wins).
 *   * Truncates to `MAX_ALIASES_PER_ENTRY` to match the backend cap;
 *     overflow is silently dropped — the editor can render a "more"
 *     count if we ever want to surface it.
 *   * Returns `[]` when the input is empty / null. Per-vendor: an
 *     empty alias list means "no alternate names known".
 */
export function splitAliasCell(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const tokens = raw
    .split(ALIAS_SPLIT_RE)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_ALIASES_PER_ENTRY) break;
  }
  return out;
}

/**
 * Inverse of `splitAliasCell` — render an alias list as the editor's
 * text-input string. Comma+space is used as the canonical join (most
 * readable, round-trips cleanly through `splitAliasCell`).
 */
export function joinAliases(aliases: readonly string[]): string {
  return aliases.join(", ");
}

// ---------------------------------------------------------------------------
// Mapping → canonical entries
// ---------------------------------------------------------------------------

/**
 * Result of applying a `VendorUploadMapping` to the parser's source
 * rows.
 *
 * `entries` is what gets sent to POST /vendor-catalogs (after a final
 * de-dupe pass). The counters surface data-quality information the
 * modal renders before the user commits, so misdetections (mapping a
 * "type" column to `vendor_code` and getting 200 duplicates) are
 * visible up front.
 */
export interface MappedSourceRows {
  entries: VendorCatalogEntry[];
  /** Rows skipped because their mapped vendor_name was blank. */
  blankRequiredCount: number;
  /** Rows skipped because their vendor_code collided with an earlier row. */
  duplicateCodeCount: number;
}

/**
 * Apply a confirmed mapping to the parser's source rows, producing
 * canonical `VendorCatalogEntry`s.
 *
 * Behaviour:
 *   * Rows whose mapped `vendor_name` is blank are dropped and counted
 *     as `blankRequiredCount` (`vendor_name` is required by the
 *     canonical schema; a row without it can't become a valid entry).
 *   * Rows whose mapped `vendor_code` is non-blank AND collides with
 *     an earlier row's code (case-insensitive) are dropped and counted
 *     as `duplicateCodeCount`. Matches the backend's uniqueness rule
 *     on `VendorCatalogCreate`.
 *   * Rows whose mapped `vendor_code` is BLANK are kept — vendor codes
 *     are optional in the canonical schema, and a duplicate "no code"
 *     across rows isn't a collision (the codes are absent, not equal).
 *   * `aliases` cells are split via `splitAliasCell` (comma / semicolon
 *     / pipe / slash / newline). When no alias column is mapped, every
 *     entry gets `aliases: []`.
 *   * `active` cells are interpreted via `interpretActive`. When no
 *     source column is mapped, every entry gets `active: true`.
 *   * All optional string fields collapse blank → `null` to match the
 *     canonical schema's nullable-string convention.
 *
 * `vendor_name` is the only required canonical field; the function
 * still runs when other mappings are `null` — it just leaves the
 * corresponding canonical field at its default.
 */
export function applyMappingToSourceRows(
  sourceColumns: readonly string[],
  sourceRows: readonly (readonly string[])[],
  mapping: VendorUploadMapping,
): MappedSourceRows {
  // Resolve column NAMES → INDICES once. Unknown names (or `null`)
  // map to -1, treated as "no source column for this field".
  const resolveIdx = (col: string | null): number => {
    if (!col) return -1;
    const idx = sourceColumns.indexOf(col);
    return idx >= 0 ? idx : -1;
  };

  const idx = {
    vendor_name: resolveIdx(mapping.vendor_name),
    vendor_code: resolveIdx(mapping.vendor_code),
    aliases: resolveIdx(mapping.aliases),
    address: resolveIdx(mapping.address),
    city: resolveIdx(mapping.city),
    state: resolveIdx(mapping.state),
    zip: resolveIdx(mapping.zip),
    contact_name: resolveIdx(mapping.contact_name),
    email: resolveIdx(mapping.email),
    phone: resolveIdx(mapping.phone),
    active: resolveIdx(mapping.active),
    notes: resolveIdx(mapping.notes),
  };

  const cellAt = (row: readonly string[], i: number): string => {
    if (i < 0 || i >= row.length) return "";
    return (row[i] ?? "").trim();
  };

  const seenCodes = new Set<string>();
  const entries: VendorCatalogEntry[] = [];
  let blankRequiredCount = 0;
  let duplicateCodeCount = 0;

  for (const row of sourceRows) {
    const vendorName = cellAt(row, idx.vendor_name);
    if (!vendorName) {
      blankRequiredCount += 1;
      continue;
    }

    const vendorCode = cellAt(row, idx.vendor_code);
    if (vendorCode) {
      const codeKey = vendorCode.toLowerCase();
      if (seenCodes.has(codeKey)) {
        duplicateCodeCount += 1;
        continue;
      }
      seenCodes.add(codeKey);
    }

    const aliasesRaw = idx.aliases >= 0 ? cellAt(row, idx.aliases) : "";
    const activeRaw = idx.active >= 0 ? cellAt(row, idx.active) : null;

    const address = cellAt(row, idx.address);
    const city = cellAt(row, idx.city);
    const state = cellAt(row, idx.state);
    const zip = cellAt(row, idx.zip);
    const contactName = cellAt(row, idx.contact_name);
    const email = cellAt(row, idx.email);
    const phone = cellAt(row, idx.phone);
    const notes = cellAt(row, idx.notes);

    entries.push({
      id: newEntryId(),
      vendor_name: vendorName,
      vendor_code: vendorCode || null,
      aliases: splitAliasCell(aliasesRaw),
      address: address || null,
      city: city || null,
      state: state || null,
      zip: zip || null,
      contact_name: contactName || null,
      email: email || null,
      phone: phone || null,
      active: interpretActive(activeRaw),
      notes: notes || null,
    });
  }

  return { entries, blankRequiredCount, duplicateCodeCount };
}
