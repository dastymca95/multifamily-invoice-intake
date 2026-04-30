import type {
  BackendExportProfileValidationRequest,
  BackendExportProfileValidationResult,
} from "@/types/export-profile-validation";
import type {
  PersistedExportProfileContractResponse,
  PersistedExportProfileCreate,
  PersistedExportProfileListResponse,
  PersistedExportProfileRead,
  PersistedExportProfileUpdate,
} from "@/types/export-profile-persistence";

import { apiClient } from "./client";

/**
 * Export Profile API client.
 *
 *   * **Phase 3J — diagnostic validation.**
 *     ``validatePreview`` posts a caller-supplied profile + preview
 *     to ``POST /export-profiles/validate-preview`` and returns the
 *     deterministic ``ExportProfileValidationResult``. Diagnostic
 *     only.
 *
 *   * **Phase 4B — persisted profile catalog (read).**
 *     ``list``, ``get``, and ``getContract`` cover the read side of
 *     the Phase 4A CRUD endpoints. Write endpoints (POST / PATCH /
 *     DELETE) are intentionally NOT exposed in this phase — the
 *     panel only needs to PICK saved profiles, not author them. A
 *     future profile-management surface can extend this client
 *     with the write methods then.
 *
 * The ``signal`` option lets callers abort in-flight requests when
 * inputs change (selected profile flips, panel close, run-clicked-
 * twice race, etc.).
 */

export interface ExportProfilesListParams {
  target_system?: string;
  is_active?: boolean;
  limit?: number;
  offset?: number;
}

export const exportProfilesApi = {
  // ---- Phase 3J — diagnostic validation -----------------------------------
  validatePreview: (
    payload: BackendExportProfileValidationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<BackendExportProfileValidationResult> =>
    apiClient
      .post<BackendExportProfileValidationResult>(
        "/export-profiles/validate-preview",
        payload,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),

  // ---- Phase 4B — persisted profile catalog (read-only) -------------------
  list: (
    params?: ExportProfilesListParams,
    options?: { signal?: AbortSignal },
  ): Promise<PersistedExportProfileListResponse> =>
    apiClient
      .get<PersistedExportProfileListResponse>("/export-profiles", {
        params,
        ...(options?.signal ? { signal: options.signal } : {}),
      })
      .then((r) => r.data),

  get: (
    profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PersistedExportProfileRead> =>
    apiClient
      .get<PersistedExportProfileRead>(
        `/export-profiles/${profileId}`,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),

  /**
   * Fetch the persisted profile projected into the existing
   * Phase 3I ``ExportProfile`` validation contract. Used by the
   * picker on selection so the saved profile contract flows
   * through the existing validation hook + report helpers
   * unchanged.
   */
  getContract: (
    profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PersistedExportProfileContractResponse> =>
    apiClient
      .get<PersistedExportProfileContractResponse>(
        `/export-profiles/${profileId}/contract`,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),

  // ---- Phase 4C — persisted profile catalog (write methods) ----------------
  /**
   * Create a new persisted profile.
   *
   * Phase 4C wraps this for the management page's "Save new
   * profile" action. The backend re-validates ``settings`` /
   * ``columns`` against the Phase 3I contract; malformed payloads
   * surface as 422 with a detail message the form renders inline.
   * No export records, no file generation.
   */
  create: (
    payload: PersistedExportProfileCreate,
    options?: { signal?: AbortSignal },
  ): Promise<PersistedExportProfileRead> =>
    apiClient
      .post<PersistedExportProfileRead>(
        "/export-profiles",
        payload,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),

  /**
   * Partially update a persisted profile.
   *
   * Sending ``settings`` / ``columns`` REPLACES the JSONB value
   * outright AND increments the row's ``version`` on the backend.
   * Pure metadata edits (name, description, notes, is_active,
   * is_default) leave the version unchanged.
   */
  update: (
    profileId: string,
    payload: PersistedExportProfileUpdate,
    options?: { signal?: AbortSignal },
  ): Promise<PersistedExportProfileRead> =>
    apiClient
      .patch<PersistedExportProfileRead>(
        `/export-profiles/${profileId}`,
        payload,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),

  /**
   * Soft-deactivate a persisted profile (``is_active=false`` +
   * cleared ``is_default``). Idempotent on the backend. Phase 4C
   * exposes this as "Deactivate" rather than "Delete" — the
   * row stays in the catalog so a future export run audit can
   * still refer to it. No hard delete is exposed.
   */
  deactivate: (
    profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> =>
    apiClient
      .delete<void>(
        `/export-profiles/${profileId}`,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then(() => undefined),
};
