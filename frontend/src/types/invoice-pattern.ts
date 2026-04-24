/**
 * Invoice Builder types — visual extraction patterns.
 *
 * Mirrors `app/schemas/invoice_pattern.py`. The Invoice Builder is a
 * sibling product surface to:
 *
 *   * Reference Data — saved catalogs (Vendors / Properties / GL Codes).
 *   * Import Builder — saved column/rule schemas for the final
 *     import output (`InvoiceTemplate`).
 *
 * Each `InvoicePattern` row describes WHERE on a real bill the
 * canonical extracted invoice fields physically live. Operators
 * upload sample bills, draw boxes on them, and assign each box to
 * one of the canonical fields (e.g. "this rectangle on page 1 is
 * the account_number"). The Import Builder integration: rule cells
 * on `invoice_field` columns can OPTIONALLY reference a saved
 * pattern + a canonical field to narrow extraction context for that
 * row. With no rule cell set, extraction falls back to the broad
 * universe of all saved patterns + OCR + AI inference. Rules
 * NARROW; they don't gate.
 */

// ---------------------------------------------------------------------------
// Bounds — kept in lockstep with `app/schemas/invoice_pattern.py`. Used
// by the editor to enforce client-side caps before a POST is rejected.
// ---------------------------------------------------------------------------

export const MAX_PATTERN_NAME_LENGTH = 255;
export const MAX_PATTERN_DESCRIPTION_LENGTH = 2000;
export const MAX_PATTERN_VENDOR_HINT_LENGTH = 255;
export const MAX_PATTERN_SOURCE_FILES = 10;
export const MAX_PATTERN_FILE_NAME_LENGTH = 255;
export const MAX_PATTERN_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_PATTERN_REGIONS = 200;
export const MAX_PATTERN_REGION_LABEL_LENGTH = 200;
export const MAX_PATTERN_REGION_NOTES_LENGTH = 500;

// Operator-edited field universe — see `InvoicePatternFieldDefinition`.
export const MAX_PATTERN_FIELD_DEFINITIONS = 100;
export const MAX_PATTERN_FIELD_KEY_LENGTH = 64;
export const MAX_PATTERN_FIELD_LABEL_LENGTH = 100;

/** Slug-shape for custom field keys — mirrors backend FIELD_KEY_PATTERN. */
const FIELD_KEY_REGEX = /^[a-z][a-z0-9_]*$/;
/** Hex color shape — `#RRGGBB`. Mirrors backend FIELD_COLOR_PATTERN. */
const FIELD_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;

// ---------------------------------------------------------------------------
// Canonical extracted invoice fields — derived from `Invoice`
// ---------------------------------------------------------------------------
//
// SINGLE SOURCE OF TRUTH lives on the backend (the `InvoiceExtractedField`
// Literal in `app/schemas/invoice_pattern.py`, derived from the `Invoice`
// SQLAlchemy model). The frontend mirrors the union here so the region
// inspector dropdown / picker has a typed choice list without an extra
// round-trip on every keystroke; the canonical-fields API endpoint
// (`GET /invoice-patterns/canonical-fields`) is the runtime authority
// — it returns descriptors with both the key AND the human-friendly
// label, and the editor uses those labels when rendering.
//
// Adding a new canonical field is a backend-driven change: extend the
// `Invoice` model + the `InvoiceExtractedField` Literal first, then
// mirror the addition here.

export type InvoiceExtractedField =
  // Vendor identity
  | "vendor_name"
  | "vendor_address"
  | "vendor_tax_id"
  // Bill-to / property
  | "bill_to_name"
  | "bill_to_address"
  | "property_name"
  | "property_code"
  // Invoice metadata
  | "invoice_number"
  | "invoice_date"
  | "due_date"
  | "service_period_start"
  | "service_period_end"
  | "payment_terms"
  // Amounts
  | "subtotal"
  | "tax_amount"
  | "total_amount"
  | "currency"
  // Classification
  | "invoice_type"
  | "utility_type"
  | "account_number"
  | "meter_number";

export const INVOICE_EXTRACTED_FIELDS: readonly InvoiceExtractedField[] = [
  "vendor_name",
  "vendor_address",
  "vendor_tax_id",
  "bill_to_name",
  "bill_to_address",
  "property_name",
  "property_code",
  "invoice_number",
  "invoice_date",
  "due_date",
  "service_period_start",
  "service_period_end",
  "payment_terms",
  "subtotal",
  "tax_amount",
  "total_amount",
  "currency",
  "invoice_type",
  "utility_type",
  "account_number",
  "meter_number",
] as const;

/**
 * Friendly labels for the canonical fields. The runtime authority is
 * the `/invoice-patterns/canonical-fields` API response (so the
 * backend can update labels without a frontend redeploy); this
 * mirror is used as a synchronous fallback / typing aid when the
 * fetched descriptors haven't landed yet.
 */
export const INVOICE_EXTRACTED_FIELD_LABEL: Record<
  InvoiceExtractedField,
  string
> = {
  vendor_name: "Vendor Name",
  vendor_address: "Vendor Address",
  vendor_tax_id: "Vendor Tax ID",
  bill_to_name: "Bill To Name",
  bill_to_address: "Bill To Address",
  property_name: "Property Name",
  property_code: "Property Code",
  invoice_number: "Invoice Number",
  invoice_date: "Invoice Date",
  due_date: "Due Date",
  service_period_start: "Service Period Start",
  service_period_end: "Service Period End",
  payment_terms: "Payment Terms",
  subtotal: "Subtotal",
  tax_amount: "Tax Amount",
  total_amount: "Total Amount",
  currency: "Currency",
  invoice_type: "Invoice Type",
  utility_type: "Utility Type",
  account_number: "Account Number",
  meter_number: "Meter Number",
};

/**
 * Canonical-field descriptor returned by the API. Frontend uses these
 * directly so the dropdown labels stay backend-authoritative.
 */
export interface InvoiceExtractedFieldDescriptor {
  key: InvoiceExtractedField;
  label: string;
}

export interface InvoiceExtractedFieldsResponse {
  fields: InvoiceExtractedFieldDescriptor[];
}

// ---------------------------------------------------------------------------
// Source files — uploaded training documents
// ---------------------------------------------------------------------------

/**
 * One uploaded training document.
 *
 * `id` is generated client-side (so the editor can reference a freshly
 * uploaded file in newly-drawn regions before the first save round-
 * trip). Stored as a non-empty short string rather than strict UUID.
 *
 * `data_url` carries the file inline as a `data:<mime>;base64,…` URL
 * during the prototype phase. Production will swap for an object-
 * storage key without changing this shape; callers can detect by
 * checking the URL prefix.
 *
 * `page_count` is the document's page total (1 for images). Used to
 * bound region.page so a region can never reference a non-existent
 * page.
 */
export interface InvoicePatternSourceFile {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  page_count: number;
  data_url: string;
  uploaded_at?: string | null;
}

// ---------------------------------------------------------------------------
// Regions — bbox annotations
// ---------------------------------------------------------------------------

/**
 * Normalized bounding box on the page. All coordinates in [0, 1] —
 * (0, 0) = top-left, (1, 1) = bottom-right. The renderer scales these
 * to whatever pixel grid it's drawing the document at, so the same
 * pattern stays correct across DPIs and viewport sizes.
 *
 * `w` and `h` are width / height (NOT x2 / y2). Both are strictly > 0;
 * a malformed drag (drag in the wrong direction) is normalised by the
 * editor before persisting.
 */
export interface InvoiceRegionBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One bbox-on-page annotation pinning an extracted field to a
 * rectangle on a specific page of a specific source file.
 *
 *   * `source_file_id` — references one of the pattern's source_files.
 *                         Application-enforced FK.
 *   * `page`           — 1-based page index, must fit inside the
 *                         referenced file's `page_count`.
 *   * `bbox`           — normalized rectangle (see `InvoiceRegionBBox`).
 *   * `field_key`      — slug-shaped key for the field this region is
 *                         pinned to. May reference a canonical
 *                         `InvoiceExtractedField` OR an operator-coined
 *                         custom field defined on the same row's
 *                         `field_definitions`. The editor reconciles
 *                         unknown keys via `RegionInspector` so a
 *                         deleted custom field doesn't strand its
 *                         regions.
 *   * `label`          — optional human-friendly tag (defaults to the
 *                         field's display name when blank).
 *   * `notes`          — operator scratch space (e.g. "only on bills
 *                         from 2025-Q3 onwards").
 */
export interface InvoicePatternRegion {
  id: string;
  source_file_id: string;
  page: number;
  bbox: InvoiceRegionBBox;
  field_key: string;
  label?: string | null;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Field definitions — operator-edited extraction-field universe
// ---------------------------------------------------------------------------

/**
 * Discriminator for `InvoicePatternFieldDefinition`. `built_in` rows
 * OVERRIDE a system canonical field (color, label, hidden flag);
 * `custom` rows ARE the source of truth for operator-coined fields
 * that don't exist on the canonical `Invoice` model.
 */
export type InvoicePatternFieldType = "built_in" | "custom";

/**
 * One operator-edited entry in the pattern's extraction-field universe.
 *
 * Storage strategy: an empty `field_definitions` list means "all
 * canonical fields visible at default colors, no customs". Built-in
 * overrides only show up here when the operator actually customized
 * them (color change, hidden, label override). This keeps the JSONB
 * payload minimal and lets new canonical fields ship to the frontend
 * without touching every saved pattern row.
 */
export interface InvoicePatternFieldDefinition {
  /** Slug-shaped persistent identifier. NEVER auto-renamed when label changes. */
  key: string;
  /** Display name shown in dropdowns / overlay tags. */
  label: string;
  type: InvoicePatternFieldType;
  /** Hex color `#RRGGBB`, or null to fall back to the deterministic default. */
  color: string | null;
  /**
   * Built-in only. Hides the canonical field from the Draw-as
   * dropdown when the operator doesn't use it for this pattern.
   * Custom fields are deleted (not hidden) to remove them from the
   * dropdown; this stays false for them.
   */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Pattern — top-level row
// ---------------------------------------------------------------------------

export interface InvoicePatternOut {
  id: string;
  name: string;
  description: string | null;
  vendor_hint: string | null;
  source_files: InvoicePatternSourceFile[];
  regions: InvoicePatternRegion[];
  /**
   * Operator-edited extraction-field universe. Optional on the wire
   * for backward-compat with rows persisted before the column existed
   * — the deserializer treats `undefined` and `[]` identically.
   */
  field_definitions?: InvoicePatternFieldDefinition[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoicePatternSummary {
  id: string;
  name: string;
  description: string | null;
  vendor_hint: string | null;
  source_file_count: number;
  region_count: number;
  created_at: string;
  updated_at: string;
}

export interface InvoicePatternList {
  items: InvoicePatternSummary[];
}

/**
 * One field a rule cell can bind to within a specific saved pattern.
 *
 * Returned by `GET /invoice-patterns/{id}/fields` — the lightweight
 * per-pattern field-options endpoint that powers the Import Builder
 * extraction-binding picker. Lifts the operator's `field_definitions`
 * overrides over the canonical built-in universe and surfaces custom
 * fields, all in a single sorted list the picker can render straight
 * into a dropdown.
 *
 * Why not synthesise this on the frontend by combining
 * `getCanonicalFields()` + the full pattern detail: the detail
 * endpoint carries base64 source files. The picker needs N field
 * lookups per rule cell — paying base64 cost N times would balloon
 * the editor's payload. This rollup stays under a kilobyte per
 * pattern.
 */
export interface InvoicePatternFieldOption {
  key: string;
  label: string;
  type: InvoicePatternFieldType;
  /** Hex color override; null when the pattern uses the default. */
  color: string | null;
  /**
   * Built-in only. True when the operator hid this canonical field
   * from the pattern's Draw-as dropdown. The picker EXCLUDES hidden
   * fields from new picks by default but keeps them visible when an
   * existing rule cell is already bound to one (so the operator sees
   * what's there and can clear it). Always false on customs.
   */
  hidden: boolean;
}

export interface InvoicePatternFieldOptionsResponse {
  pattern_id: string;
  items: InvoicePatternFieldOption[];
}

export interface InvoicePatternCreate {
  name: string;
  description?: string | null;
  vendor_hint?: string | null;
  source_files?: InvoicePatternSourceFile[];
  regions?: InvoicePatternRegion[];
  field_definitions?: InvoicePatternFieldDefinition[];
}

export interface InvoicePatternUpdate {
  name?: string;
  description?: string | null;
  vendor_hint?: string | null;
  source_files?: InvoicePatternSourceFile[];
  regions?: InvoicePatternRegion[];
  field_definitions?: InvoicePatternFieldDefinition[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable id factories for client-side ids on freshly-added files /
 * regions. Editor needs ids before the first server round-trip so it
 * can reference newly-drawn regions inside the same edit session.
 */
let _fileSeq = 0;
let _regionSeq = 0;
export function newSourceFileId(): string {
  _fileSeq += 1;
  return `f-${Date.now().toString(36)}-${_fileSeq}`;
}
export function newRegionId(): string {
  _regionSeq += 1;
  return `r-${Date.now().toString(36)}-${_regionSeq}`;
}

/**
 * Read a canonical-field descriptor from a fetched-or-fallback list.
 * Centralises the "use the label the API gave us, fall back to the
 * built-in mirror" logic so call sites (region inspector,
 * extraction picker) stay simple.
 */
export function fieldDescriptor(
  key: InvoiceExtractedField,
  fetched: readonly InvoiceExtractedFieldDescriptor[] | undefined,
): InvoiceExtractedFieldDescriptor {
  const found = fetched?.find((d) => d.key === key);
  if (found) return found;
  return { key, label: INVOICE_EXTRACTED_FIELD_LABEL[key] };
}

/**
 * Convenience: pretty-print a byte count for the upload UI. Used by
 * the new-pattern modal + the source-file list inside the editor.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Read a file as a base64 data URL via FileReader. Wrapped as a
 * Promise so the upload flow can `await` it cleanly. Resolves to the
 * full `data:<mime>;base64,…` string. Rejects on FileReader error.
 *
 * Why inline base64 and not multipart upload: keeps the prototype
 * self-contained — the pattern row carries everything it needs in
 * its JSONB `source_files` payload, no separate object storage. The
 * 10 MB per-file cap (mirrored from `MAX_PATTERN_FILE_SIZE_BYTES`)
 * keeps inline storage from blowing up the row size.
 */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("FileReader returned a non-string result"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Field colors
// ---------------------------------------------------------------------------

/**
 * Operator-pickable palette for field overlay colors. Tailwind-500 hue
 * strength so semi-transparent fills stay readable over white-ish PDF
 * pages and a solid border still pops. Twelve entries — wide enough
 * for visual differentiation across a dense pattern (a real bill might
 * pin 15-20 distinct fields) without overwhelming the picker.
 *
 * Persisted as `#RRGGBB` strings on the wire — shape mirrors the
 * backend's `FIELD_COLOR_PATTERN` so any value the picker emits is a
 * valid backend payload.
 */
export const FIELD_COLOR_PALETTE: readonly string[] = [
  "#f59e0b", // amber
  "#3b82f6", // blue
  "#10b981", // emerald
  "#ef4444", // red
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
  "#6366f1", // indigo
  "#84cc16", // lime
  "#06b6d4", // cyan
  "#a855f7", // purple
] as const;

/**
 * Deterministic default color per canonical field. Picked once and
 * stable so the same canonical field gets the same overlay color
 * across patterns (operator builds visual muscle memory: "amber =
 * vendor name").
 */
export const DEFAULT_BUILTIN_FIELD_COLORS: Record<
  InvoiceExtractedField,
  string
> = {
  vendor_name: "#f59e0b",
  vendor_address: "#fb923c",
  vendor_tax_id: "#facc15",
  bill_to_name: "#3b82f6",
  bill_to_address: "#60a5fa",
  property_name: "#8b5cf6",
  property_code: "#a78bfa",
  invoice_number: "#10b981",
  invoice_date: "#34d399",
  due_date: "#06b6d4",
  service_period_start: "#14b8a6",
  service_period_end: "#0d9488",
  payment_terms: "#84cc16",
  subtotal: "#ec4899",
  tax_amount: "#f43f5e",
  total_amount: "#ef4444",
  currency: "#a855f7",
  invoice_type: "#6366f1",
  utility_type: "#22d3ee",
  account_number: "#f97316",
  meter_number: "#fb7185",
};

/**
 * Resolve an overlay color for any field key — canonical, custom, or
 * orphan-from-deleted-def. Strategy:
 *
 *   * Canonical key + no override → static default for that key.
 *   * Override present (color set) → that hex value.
 *   * Custom key with no color → deterministic pick from the palette
 *     using a small string-hash so the same custom key gets the same
 *     color across reloads.
 *
 * Used by every renderer that draws a field-tinted element so the
 * color always matches across the viewer overlay, region inspector,
 * and Draw-as dropdown.
 */
export function colorForFieldKey(key: string): string {
  // Canonical default branch
  if (key in DEFAULT_BUILTIN_FIELD_COLORS) {
    return DEFAULT_BUILTIN_FIELD_COLORS[key as InvoiceExtractedField];
  }
  // Hash → palette fallback. Small djb2-like loop, no external dep.
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return FIELD_COLOR_PALETTE[Math.abs(h) % FIELD_COLOR_PALETTE.length];
}

// ---------------------------------------------------------------------------
// Field-definition reconciliation
// ---------------------------------------------------------------------------

/**
 * Fully-resolved field shape that the editor renders against. Combines
 * the canonical universe with the pattern's per-row overrides + customs
 * into one flat list with stable `key`s and `color`s. Hidden flag
 * preserved so the dropdown can filter while the inspector still
 * resolves a region whose key matches a hidden field.
 */
export interface ResolvedField {
  key: string;
  label: string;
  type: InvoicePatternFieldType;
  color: string;
  hidden: boolean;
}

/**
 * Build the resolved field list from canonical descriptors + the
 * pattern's `field_definitions`.
 *
 * Order: canonical fields first (in canonical order), then customs in
 * the order they appear in `defs`. Stable order keeps the Draw-as
 * dropdown predictable as the operator adds / edits customs.
 *
 * Built-in semantics:
 *   * If the canonical key has an override in `defs`, the override's
 *     color/label/hidden wins (with empty color falling back to
 *     `DEFAULT_BUILTIN_FIELD_COLORS`).
 *   * No override → use canonical label + default color.
 *
 * Custom semantics:
 *   * `defs` entries with `type: "custom"` are appended.
 *   * `defs` entries with `type: "built_in"` whose key isn't canonical
 *     are SKIPPED (orphan override, e.g. canonical field removed from
 *     the model). Frontend doesn't render them; storage keeps them so
 *     a future re-add of the canonical field re-uses the override.
 */
export function resolveFieldList(
  canonical: readonly InvoiceExtractedFieldDescriptor[],
  defs: readonly InvoicePatternFieldDefinition[] | undefined,
): ResolvedField[] {
  const defsArr = defs ?? [];
  const defByKey = new Map(defsArr.map((d) => [d.key, d]));
  const out: ResolvedField[] = [];

  for (const cf of canonical) {
    const d = defByKey.get(cf.key);
    out.push({
      key: cf.key,
      label: d?.label || cf.label,
      type: "built_in",
      color: d?.color || colorForFieldKey(cf.key),
      hidden: d?.hidden === true,
    });
  }

  // Typed as `Set<string>` so a custom def's `string` key can be
  // membership-tested without a cast (canonical keys are a narrower
  // `InvoiceExtractedField` literal union).
  const canonicalKeys = new Set<string>(canonical.map((c) => c.key));
  for (const d of defsArr) {
    if (canonicalKeys.has(d.key)) continue;
    if (d.type !== "custom") continue;
    out.push({
      key: d.key,
      label: d.label,
      type: "custom",
      color: d.color || colorForFieldKey(d.key),
      hidden: d.hidden === true,
    });
  }

  return out;
}

/** Filter to fields that should appear in the Draw-as dropdown. */
export function visibleFieldList(
  resolved: readonly ResolvedField[],
): ResolvedField[] {
  return resolved.filter((r) => !r.hidden);
}

/**
 * Look up a resolved field by key. Returns null if the key isn't
 * known (e.g. deleted custom field that still has dangling regions).
 * Callers handle the null case by rendering an "Unknown field"
 * fallback + offering reassignment.
 */
export function findResolvedField(
  key: string,
  resolved: readonly ResolvedField[],
): ResolvedField | null {
  return resolved.find((r) => r.key === key) ?? null;
}

/**
 * Slugify an operator-typed label into a backend-valid key.
 *
 *   "Service Address"      → "service_address"
 *   "Meter # / Reading"    → "meter_reading"
 *   "1st Late Fee"         → "f_1st_late_fee"   (key must start with letter)
 *
 * Returns "" when the label is empty after cleaning — caller decides
 * whether to fall back or show a validation error.
 */
export function slugifyFieldLabel(label: string): string {
  const s = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) return "";
  const head = /^[a-z]/.test(s) ? s : `f_${s}`;
  return head.slice(0, MAX_PATTERN_FIELD_KEY_LENGTH);
}

/** True iff the given key matches the slug-shape backend will accept. */
export function isValidFieldKey(key: string): boolean {
  return FIELD_KEY_REGEX.test(key);
}

/** True iff the given color matches `#RRGGBB`. */
export function isValidFieldColor(color: string): boolean {
  return FIELD_COLOR_REGEX.test(color);
}

/**
 * Generate a fresh, unique custom-field key from an operator label.
 * Suffixes `_2`, `_3`, … if the slug already collides with another
 * field key in the same pattern.
 */
export function uniqueCustomFieldKey(
  label: string,
  existingKeys: readonly string[],
): string {
  const base = slugifyFieldLabel(label) || "custom_field";
  if (!existingKeys.includes(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`.slice(0, MAX_PATTERN_FIELD_KEY_LENGTH);
    if (!existingKeys.includes(candidate)) return candidate;
  }
  // Astronomically unlikely; final fallback keeps the function total.
  return `${base}_${Date.now().toString(36)}`.slice(
    0,
    MAX_PATTERN_FIELD_KEY_LENGTH,
  );
}

/**
 * Count regions per field key for the manage-fields modal. Lets the
 * UI block deletion of in-use customs with a clear message.
 */
export function countRegionsByFieldKey(
  regions: readonly InvoicePatternRegion[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of regions) {
    out[r.field_key] = (out[r.field_key] ?? 0) + 1;
  }
  return out;
}
