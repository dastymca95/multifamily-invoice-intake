/**
 * Phase 4B — Frontend mirror of the Phase 4A persisted Export
 * Profile contract
 * (``backend/app/schemas/export_profile_persistence.py``).
 *
 * The CRUD endpoints:
 *
 *   GET    /api/v1/export-profiles
 *   GET    /api/v1/export-profiles/{profile_id}
 *   GET    /api/v1/export-profiles/{profile_id}/contract
 *
 * return persisted profile rows + a converter into the existing
 * Phase 3I ``ExportProfile`` validation contract. Diagnostic only —
 * no export records, no file generation, no posting.
 *
 * Why a dedicated ``Persisted*`` namespace instead of reusing the
 * Phase 3F local types (``ExportProfile``):
 *
 *   * The persisted row carries catalog metadata (``id``, ``version``,
 *     ``is_active``, ``is_default``, ``created_at``/``updated_at``,
 *     ``source``, ``notes``) that the local validation contract
 *     doesn't model.
 *   * The list endpoint returns a SUMMARY shape without the JSONB
 *     ``settings`` / ``columns`` payloads. Selecting a saved
 *     profile triggers a follow-up GET on the contract endpoint;
 *     the type system makes that two-step explicit.
 *   * Forward-compat: ``target_system`` / ``source`` are widened
 *     to plain strings so a future backend literal renders
 *     gracefully without crashing.
 */

import type { ExportProfile } from "@/features/invoice-templates/lib/export-profile-contract";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type PersistedExportProfileTargetSystem =
  | "custom_csv"
  | "resman"
  | "yardi"
  | "appfolio"
  // Forward-compat — gracefully accept future literals.
  | (string & {});

export type PersistedExportProfileSourceTag =
  | "manual"
  | "built_in_seed"
  | "imported"
  | (string & {});

// ---------------------------------------------------------------------------
// Summary (list response)
// ---------------------------------------------------------------------------

/**
 * Lightweight item returned by the list endpoint. The JSONB
 * ``settings`` / ``columns`` payloads are NOT included — the picker
 * loads them on selection via ``getContract``.
 */
export interface PersistedExportProfileSummary {
  id: string;
  name: string;
  target_system: PersistedExportProfileTargetSystem;
  description: string | null;
  is_active: boolean;
  is_default: boolean;
  version: number;
  source: PersistedExportProfileSourceTag;
  created_at: string;
  updated_at: string;
}

export interface PersistedExportProfileListResponse {
  items: PersistedExportProfileSummary[];
}

// ---------------------------------------------------------------------------
// Full read (single-profile GET)
// ---------------------------------------------------------------------------

/**
 * Full read shape returned by ``GET /export-profiles/{id}`` — the
 * ``ExportProfileSummary`` fields PLUS the JSONB ``settings`` /
 * ``columns`` payloads + the soft-FK audit cols.
 *
 * The JSONB blobs are typed loosely as ``Record<string, unknown>`` /
 * ``Record<string, unknown>[]`` so a backend tightening to the
 * canonical ``ExportProfileSettings`` / ``ExportProfileColumn``
 * shapes doesn't force a frontend type churn — the
 * ``getContract`` endpoint is the canonical re-validation path
 * when we need a guaranteed-shape ``ExportProfile``.
 */
export interface PersistedExportProfileRead {
  id: string;
  name: string;
  target_system: PersistedExportProfileTargetSystem;
  description: string | null;
  settings: Record<string, unknown>;
  columns: Record<string, unknown>[];
  is_active: boolean;
  is_default: boolean;
  version: number;
  source: PersistedExportProfileSourceTag;
  notes: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Contract (Phase 3I shape)
// ---------------------------------------------------------------------------

/**
 * Backend's ``GET /export-profiles/{id}/contract`` returns the
 * persisted row projected into the existing Phase 3I
 * ``ExportProfile`` validation contract — same shape the Phase 3F
 * built-in factories produce. The frontend ``ExportProfile`` type
 * is the canonical mirror, so we re-export it here as the
 * contract response type.
 */
export type PersistedExportProfileContractResponse = ExportProfile;

// ---------------------------------------------------------------------------
// Phase 4C — CRUD write payloads
// ---------------------------------------------------------------------------

/**
 * Body for ``POST /api/v1/export-profiles``. Mirrors the backend
 * ``ExportProfileCreate`` Pydantic shape. ``settings`` and
 * ``columns`` use the loose JSON shape the backend's JSONB columns
 * accept (per Phase 4A); the management service re-validates them
 * against ``ExportProfileSettings`` / ``ExportProfileColumn``
 * before persisting.
 */
export interface PersistedExportProfileCreate {
  name: string;
  target_system: PersistedExportProfileTargetSystem;
  description?: string | null;
  settings: Record<string, unknown>;
  columns: Record<string, unknown>[];
  is_active?: boolean;
  is_default?: boolean;
  source?: PersistedExportProfileSourceTag;
  notes?: string | null;
}

/**
 * Body for ``PATCH /api/v1/export-profiles/{id}``. Every field is
 * optional. Sending ``description: null`` (or ``notes: null``)
 * explicitly clears the value. Sending ``settings`` / ``columns``
 * REPLACES the JSONB value outright AND increments the row's
 * version on the backend.
 */
export interface PersistedExportProfileUpdate {
  name?: string;
  description?: string | null;
  settings?: Record<string, unknown>;
  columns?: Record<string, unknown>[];
  is_active?: boolean;
  is_default?: boolean;
  notes?: string | null;
}
