import type {
  BackendExportReadinessBoundaryRequest,
  BackendExportReadinessBoundaryResult,
} from "@/types/export-readiness-boundary";

import { apiClient } from "./client";

/**
 * Phase 3N — Export Readiness Boundary diagnostic API client.
 *
 * Single endpoint that evaluates the canonical Phase 3M boundary
 * contract from a small diagnostic-state snapshot. Hard-pinned —
 * the response always carries ``diagnostic_only=true`` and
 * ``production_export_ready=false`` regardless of input. The
 * backend never persists a boundary, never creates an export
 * record, never generates a file.
 *
 * Lives in its own client module (vs. tacking onto
 * ``exportProfilesApi``) because the endpoint sits at
 * ``/export-readiness-boundary/evaluate`` rather than under the
 * profiles namespace — keeps room for future additions like
 * boundary streaming or per-profile evaluation without crowding
 * one client.
 *
 * The ``signal`` option lets callers abort in-flight requests when
 * inputs change (selected profile flips, panel close, run-clicked-
 * twice race, etc.).
 */
export const exportReadinessBoundaryApi = {
  evaluate: (
    payload: BackendExportReadinessBoundaryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<BackendExportReadinessBoundaryResult> =>
    apiClient
      .post<BackendExportReadinessBoundaryResult>(
        "/export-readiness-boundary/evaluate",
        payload,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),
};
