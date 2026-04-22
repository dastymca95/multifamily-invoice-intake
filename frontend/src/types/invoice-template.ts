/**
 * Invoice Template Builder — types mirror `app/schemas/invoice_template.py`.
 *
 * One InvoiceTemplate is a saved, named definition of the column shape
 * for a future ResMan invoice import. The user authors this directly
 * in the builder (rename / add / remove / reorder columns).
 *
 * Related but distinct from `ImportConfig`: that model owns ROLE
 * OVERRIDES on top of an inferred column structure (today derived from
 * the uploaded ResMan template). InvoiceTemplate owns the COLUMN
 * STRUCTURE itself.
 */

/**
 * Where this template was originally seeded from. Informational —
 * drives a small "origin" hint in the UI but has no functional effect.
 */
export type InvoiceTemplateSource =
  | "default"
  | "blank"
  | "from_upload"
  | "custom";

/**
 * One column inside a template's `columns` array.
 *
 * `id` is a stable string key (not a numeric index) so reordering
 * preserves React-list identity. Generated client-side when adding a
 * row; the backend doesn't care about the value beyond uniqueness.
 *
 * `source_column` carries the original ResMan template column name when
 * this column was seeded from an upload. Null otherwise. A future
 * export step can use it to recover "this user-named column maps to
 * that template column" without re-running classification.
 */
export interface InvoiceTemplateColumn {
  id: string;
  name: string;
  source_column: string | null;
}

export interface InvoiceTemplateOut {
  id: string;
  name: string;
  description: string | null;
  columns: InvoiceTemplateColumn[];
  source: InvoiceTemplateSource;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceTemplateSummary {
  id: string;
  name: string;
  description: string | null;
  source: InvoiceTemplateSource;
  column_count: number;
  created_at: string;
  updated_at: string;
}

export interface InvoiceTemplateList {
  items: InvoiceTemplateSummary[];
}

/**
 * Built-in canonical template returned by GET /defaults/canonical.
 * Not persisted — the frontend uses it as an editable starter draft.
 */
export interface InvoiceTemplateDefault {
  name: string;
  description: string | null;
  columns: InvoiceTemplateColumn[];
}

/** POST body — all top-level fields required. */
export interface InvoiceTemplateCreate {
  name: string;
  description?: string | null;
  columns: InvoiceTemplateColumn[];
  source?: InvoiceTemplateSource;
}

/**
 * PATCH body. Every field optional; omitting a field leaves the
 * persisted value unchanged. Sending `columns` REPLACES the array
 * outright — the editor always sends the full new ordered list.
 * Sending `null` for `description` clears it.
 */
export interface InvoiceTemplateUpdate {
  name?: string;
  description?: string | null;
  columns?: InvoiceTemplateColumn[];
}

/** Bounds enforced by the backend Pydantic schema. */
export const MIN_COLUMNS = 1;
export const MAX_COLUMNS = 200;
export const MAX_COLUMN_NAME_LENGTH = 200;

/**
 * Generate a stable client-side id for a freshly-added column. Uses
 * `crypto.randomUUID` where available, falls back to a Math.random
 * hex so the column-id contract still holds in environments without
 * a crypto API (very old browsers, SSR test runners). The backend
 * validates uniqueness within the template, not the format.
 */
export function newColumnId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Math.random().toString(16).slice(2, 10)}-${Date.now().toString(
    16,
  )}`;
}
