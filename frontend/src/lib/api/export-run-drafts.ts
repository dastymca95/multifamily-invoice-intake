import type {
  BackendExportRunDraftRequest,
  BackendExportRunDraftResult,
} from "@/types/export-run-draft";

import { apiClient } from "./client";

/**
 * Phase 4G — Export Run Draft diagnostic API client.
 *
 * Single endpoint that evaluates the canonical Phase 4F draft
 * contract from a small diagnostic-state snapshot. Hard-pinned —
 * the response always carries ``draft_only=true`` /
 * ``finalized=false`` / ``file_generated=false`` /
 * ``download_available=false`` / ``production_export_ready=false``
 * regardless of input. The backend never persists a draft, never
 * creates an export record, never generates a file.
 *
 * Lives in its own client module (vs. tacking onto
 * ``exportProfilesApi``) because the endpoint sits at
 * ``/export-run-drafts/evaluate`` rather than under any other
 * namespace — keeps room for a future export-engine surface
 * without crowding one client.
 *
 * Phase 4G intentionally exposes ONLY ``evaluate``. No
 * ``create`` / ``save`` / ``finalize`` / ``download`` / ``export``
 * / ``post`` — Phase 3O regression forbids those handles on
 * diagnostic surfaces.
 *
 * The ``signal`` option lets callers abort in-flight requests when
 * inputs change (selected profile flips, panel close, run-clicked-
 * twice race, etc.).
 */
export const exportRunDraftsApi = {
  evaluate: (
    payload: BackendExportRunDraftRequest,
    options?: { signal?: AbortSignal },
  ): Promise<BackendExportRunDraftResult> =>
    apiClient
      .post<BackendExportRunDraftResult>(
        "/export-run-drafts/evaluate",
        payload,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),
};
