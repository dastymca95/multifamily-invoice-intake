"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { exportRunsApi, getApiErrorMessage } from "@/lib/api";
import type {
  PersistedExportRunApproveForFileGenerationPayload,
  PersistedExportRunRead,
  PersistedExportRunRejectApprovalPayload,
  PersistedExportRunRequestApprovalPayload,
} from "@/types/export-run-persistence";

/**
 * Phase 6B — Manual-click mutation hook for the three Phase 6A
 * approval workflow endpoints:
 *
 *   * ``requestApproval`` — POST /export-runs/{id}/request-approval
 *   * ``approveForFileGeneration`` — POST /export-runs/{id}/approve-for-file-generation
 *   * ``rejectApproval`` — POST /export-runs/{id}/reject-approval
 *
 * Mirrors the design of the Phase 5B / 5C mutation hooks:
 *   * Manual click only — no ``useEffect`` fires the request.
 *   * AbortController + ``aliveRef`` so an unmount mid-call
 *     doesn't trigger a setState after teardown.
 *   * Returns the saved record on success (or throws); the
 *     caller (the detail panel) uses the resolved record to
 *     refresh the visible row in place without a full refetch.
 *
 * Hard contract — even when an approval transition succeeds:
 *
 *   * ``phase`` remains ``"draft"``.
 *   * ``status`` is unchanged.
 *   * The embedded ``draft_snapshot`` hard pins
 *     (``draft_only`` / ``finalized`` / ``file_generated`` /
 *     ``download_available`` / ``production_export_ready``) are
 *     unchanged.
 *   * No file is generated, no download URL issued, no document /
 *     batch / template mutated, no external system contacted, no
 *     export batch created.
 *
 * The hook surfaces ``actionInFlight`` so the detail panel can
 * disable the right button (Request / Approve / Reject) instead
 * of a single global busy spinner.
 */

export type ExportRunApprovalAction = "request" | "approve" | "reject";

export interface UseExportRunApprovalMutationReturn {
  /** ``true`` while any of the three transitions is in flight. */
  busy: boolean;
  /** Which transition is currently in flight, if any. The detail
   *  panel uses this to disable the matching button (and dim the
   *  others) so the operator can't double-fire mid-call. */
  actionInFlight: ExportRunApprovalAction | null;
  /** Operator-friendly error message from the most recent failed
   *  transition. ``null`` when no error is pending. */
  error: string | null;
  /** Set to the action name on the most recent successful
   *  transition; cleared by ``clearStatus`` or by the next
   *  attempt. The panel renders a brief "Approval status updated."
   *  affordance whenever this is set. */
  lastSuccessAction: ExportRunApprovalAction | null;
  /** Imperative request-approval. Resolves to the updated record;
   *  throws (and stores ``error``) on failure. */
  requestApproval: (
    runId: string,
    payload: PersistedExportRunRequestApprovalPayload,
  ) => Promise<PersistedExportRunRead>;
  /** Imperative approve. */
  approveForFileGeneration: (
    runId: string,
    payload: PersistedExportRunApproveForFileGenerationPayload,
  ) => Promise<PersistedExportRunRead>;
  /** Imperative reject. */
  rejectApproval: (
    runId: string,
    payload: PersistedExportRunRejectApprovalPayload,
  ) => Promise<PersistedExportRunRead>;
  /** Clear ``error`` / ``lastSuccessAction``. The panel calls
   *  this when the operator dismisses an error / success
   *  affordance. */
  clearStatus: () => void;
}

export function useExportRunApprovalMutation(): UseExportRunApprovalMutationReturn {
  const [actionInFlight, setActionInFlight] =
    useState<ExportRunApprovalAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSuccessAction, setLastSuccessAction] =
    useState<ExportRunApprovalAction | null>(null);

  // ---- Race / unmount safety -----------------------------------
  // Manual-click flow doesn't have the kind of race the list /
  // detail hooks do, but we still abort on unmount AND drop late
  // results so a fast unmount mid-call doesn't trigger a setState
  // after teardown.
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  /**
   * Shared transition runner — accepts the action name + a
   * callback that performs the actual API call (signal-aware).
   * Centralises the busy / abort / alive-ref / error / success
   * bookkeeping so the three exposed methods stay tiny.
   */
  const runTransition = useCallback(
    async (
      action: ExportRunApprovalAction,
      apiCall: (
        signal: AbortSignal,
      ) => Promise<PersistedExportRunRead>,
    ): Promise<PersistedExportRunRead> => {
      // Cancel any prior in-flight transition (defensive — UI
      // disables buttons while ``busy``, but a previous call
      // aborted by unmount could still be cleaning up).
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const myRequestId = ++requestIdRef.current;

      setActionInFlight(action);
      setError(null);
      // Clear stale success state so a new attempt doesn't show
      // "approval status updated" from a previous successful call.
      setLastSuccessAction(null);

      try {
        const record = await apiCall(controller.signal);
        if (
          aliveRef.current &&
          myRequestId === requestIdRef.current
        ) {
          setLastSuccessAction(action);
          setError(null);
        }
        return record;
      } catch (err) {
        if (controller.signal.aborted) {
          throw err;
        }
        const msg = getApiErrorMessage(
          err,
          _defaultErrorMessageFor(action),
        );
        if (
          aliveRef.current &&
          myRequestId === requestIdRef.current
        ) {
          setError(msg);
        }
        throw err;
      } finally {
        if (
          aliveRef.current &&
          myRequestId === requestIdRef.current
        ) {
          setActionInFlight(null);
        }
      }
    },
    [],
  );

  const requestApproval = useCallback(
    async (
      runId: string,
      payload: PersistedExportRunRequestApprovalPayload,
    ): Promise<PersistedExportRunRead> => {
      return runTransition("request", (signal) =>
        exportRunsApi.requestApproval(runId, payload, { signal }),
      );
    },
    [runTransition],
  );

  const approveForFileGeneration = useCallback(
    async (
      runId: string,
      payload: PersistedExportRunApproveForFileGenerationPayload,
    ): Promise<PersistedExportRunRead> => {
      return runTransition("approve", (signal) =>
        exportRunsApi.approveForFileGeneration(runId, payload, {
          signal,
        }),
      );
    },
    [runTransition],
  );

  const rejectApproval = useCallback(
    async (
      runId: string,
      payload: PersistedExportRunRejectApprovalPayload,
    ): Promise<PersistedExportRunRead> => {
      return runTransition("reject", (signal) =>
        exportRunsApi.rejectApproval(runId, payload, { signal }),
      );
    },
    [runTransition],
  );

  const clearStatus = useCallback(() => {
    setError(null);
    setLastSuccessAction(null);
  }, []);

  return {
    busy: actionInFlight !== null,
    actionInFlight,
    error,
    lastSuccessAction,
    requestApproval,
    approveForFileGeneration,
    rejectApproval,
    clearStatus,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _defaultErrorMessageFor(action: ExportRunApprovalAction): string {
  switch (action) {
    case "request":
      return "Could not request approval.";
    case "approve":
      return "Could not approve audit record for file generation.";
    case "reject":
      return "Could not reject approval.";
  }
}
