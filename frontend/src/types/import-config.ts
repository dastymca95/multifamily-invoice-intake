/**
 * Import Builder — types mirror `app/schemas/import_config.py`.
 *
 * Three response shapes:
 *   * ImportConfigSummary — list-row payload (no overrides dict).
 *   * ImportConfigOut     — full record. Used as a building block.
 *   * ImportConfigDetail  — `config + preview` bundle. Returned by GET
 *                           detail / POST / PATCH so the workspace can
 *                           update both atomically from a single
 *                           round-trip.
 *
 * The role-override values are constrained to `ColumnRole` so a typo
 * at edit time gets rejected by the backend with a 422.
 */

import type {
  ColumnRole,
  ResmanPreviewResponse,
} from "@/types/resman-preview";

/** Bounds for the `row_limit` knob — must match the backend Pydantic schema. */
export const ROW_LIMIT_MIN = 1;
export const ROW_LIMIT_MAX = 50;
export const DEFAULT_ROW_LIMIT = 8;

export interface ImportConfigOut {
  id: string;
  name: string;
  description: string | null;
  /** Map of `template column name → pinned role`. Overrides the auto-classifier. */
  column_role_overrides: Record<string, ColumnRole>;
  row_limit: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportConfigSummary {
  id: string;
  name: string;
  description: string | null;
  row_limit: number;
  /** Number of pinned roles in this config (size of column_role_overrides). */
  override_count: number;
  created_at: string;
  updated_at: string;
}

export interface ImportConfigDetail {
  config: ImportConfigOut;
  /**
   * Preview rendered against the CURRENT reference uploads + approved
   * invoices, with this config's overrides applied. Always reflects
   * live state — never a stale snapshot.
   */
  preview: ResmanPreviewResponse;
}

export interface ImportConfigList {
  items: ImportConfigSummary[];
}

export interface ImportConfigCreate {
  name: string;
  description?: string | null;
  column_role_overrides?: Record<string, ColumnRole>;
  row_limit?: number;
}

/**
 * PATCH body. Every field is optional; omitting a field leaves the
 * persisted value unchanged. Sending `column_role_overrides: {}`
 * REPLACES the dict (use to clear all overrides). Sending `null` for
 * `description` clears it.
 */
export interface ImportConfigUpdate {
  name?: string;
  description?: string | null;
  column_role_overrides?: Record<string, ColumnRole>;
  row_limit?: number;
}
