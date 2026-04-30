import type {
  PersistedExportRunApproveForFileGenerationPayload,
  PersistedExportRunCreate,
  PersistedExportRunListParams,
  PersistedExportRunListResponse,
  PersistedExportRunRead,
  PersistedExportRunRejectApprovalPayload,
  PersistedExportRunRequestApprovalPayload,
  PersistedExportRunUpdate,
} from "@/types/export-run-persistence";

import { apiClient } from "./client";

/**
 * Phase 5B / 6B — Export Run Draft / audit persistence API client.
 *
 * Sibling to ``exportRunDraftsApi`` (the Phase 4F stateless
 * evaluator). Phase 4I + 4G hard-pin the evaluator endpoint
 * against returning any ``id`` / ``export_run_id`` flavour;
 * persistence happens ONLY through the explicit endpoint family
 * surfaced here, and ONLY when the operator clicks "Save draft
 * audit record" in the panel.
 *
 * The persisted ``id`` is a draft / audit record id — NOT a
 * finalized export id, NOT a file id, NOT proof of export, and
 * does NOT imply document / batch / template / external-system
 * mutation. See ``docs/export-run-draft-contract.md`` §11 +
 * ``docs/export-run-persistence-contract.md`` §6.1 for the
 * canonical persistence + approval contract.
 *
 * Phase 5B + 6B exposes ONLY the seven endpoints the Phase 5A +
 * 6A backend defines:
 *
 *   * ``createDraft``                  — POST  /export-runs/drafts
 *   * ``list``                         — GET   /export-runs
 *   * ``get``                          — GET   /export-runs/{id}
 *   * ``updateNotes``                  — PATCH /export-runs/{id}
 *   * ``requestApproval``              — POST  /export-runs/{id}/request-approval
 *   * ``approveForFileGeneration``     — POST  /export-runs/{id}/approve-for-file-generation
 *   * ``rejectApproval``               — POST  /export-runs/{id}/reject-approval
 *
 * No ``finalize`` / ``generateFile`` / ``download`` / ``post`` /
 * ``markExported`` / ``delete`` — those handles do not exist on
 * the diagnostic surface and never will. Even when an approval
 * transition flips ``approval_status`` to
 * ``"approved_for_file_generation"``, the embedded
 * ``draft_snapshot`` hard pins (``finalized=false`` /
 * ``file_generated=false`` / ``download_available=false`` /
 * ``production_export_ready=false``) hold and ``phase`` stays
 * ``"draft"``.
 *
 * The ``signal`` option lets callers abort in-flight requests on
 * unmount / panel close. Every transition is manual-click only
 * (no useEffect auto-fire), but the AbortController plumbing is
 * still wired so an unmount mid-call doesn't trigger a setState
 * after teardown.
 */
export const exportRunsApi = {
  createDraft: (
    payload: PersistedExportRunCreate,
    options?: { signal?: AbortSignal },
  ): Promise<PersistedExportRunRead> =>
    apiClient
      .post<PersistedExportRunRead>(
        "/export-runs/drafts",
        payload,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),

  list: (
    params?: PersistedExportRunListParams,
    options?: { signal?: AbortSignal },
  ): Promise<PersistedExportRunListResponse> =>
    apiClient
      .get<PersistedExportRunListResponse>("/export-runs", {
        params: params ?? undefined,
        ...(options?.signal ? { signal: options.signal } : {}),
      })
      .then((r) => r.data),

  get: (
    runId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PersistedExportRunRead> =>
    apiClient
      .get<PersistedExportRunRead>(
        `/export-runs/${encodeURIComponent(runId)}`,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),

  updateNotes: (
    runId: string,
    payload: PersistedExportRunUpdate,
    options?: { signal?: AbortSignal },
  ): Promise<PersistedExportRunRead> =>
    apiClient
      .patch<PersistedExportRunRead>(
        `/export-runs/${encodeURIComponent(runId)}`,
        payload,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),

  // ---- Phase 6B — Approval workflow transitions ----------------
  // Each call mutates ONLY the approval columns server-side; the
  // embedded snapshot's hard pins, the row's ``phase``, ``status``,
  // counts, and FKs are unchanged. The backend rejects forged
  // bodies (``extra="forbid"``) and rejects invalid transitions
  // with HTTP 409 (e.g. approve from ``not_requested``, approve a
  // ``blocked`` / ``needs_review`` row). Reject without a
  // non-empty ``rejection_reason`` is HTTP 422 (Pydantic).

  requestApproval: (
    runId: string,
    payload: PersistedExportRunRequestApprovalPayload,
    options?: { signal?: AbortSignal },
  ): Promise<PersistedExportRunRead> =>
    apiClient
      .post<PersistedExportRunRead>(
        `/export-runs/${encodeURIComponent(runId)}/request-approval`,
        payload,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),

  approveForFileGeneration: (
    runId: string,
    payload: PersistedExportRunApproveForFileGenerationPayload,
    options?: { signal?: AbortSignal },
  ): Promise<PersistedExportRunRead> =>
    apiClient
      .post<PersistedExportRunRead>(
        `/export-runs/${encodeURIComponent(runId)}/approve-for-file-generation`,
        payload,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),

  rejectApproval: (
    runId: string,
    payload: PersistedExportRunRejectApprovalPayload,
    options?: { signal?: AbortSignal },
  ): Promise<PersistedExportRunRead> =>
    apiClient
      .post<PersistedExportRunRead>(
        `/export-runs/${encodeURIComponent(runId)}/reject-approval`,
        payload,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),
};
