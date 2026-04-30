"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { exportRunsApi, getApiErrorMessage } from "@/lib/api";
import type {
  PersistedExportRunCreate,
  PersistedExportRunRead,
} from "@/types/export-run-persistence";

/**
 * Phase 5B — Hook that persists an Export Run Draft / audit
 * record on explicit user click. NEVER fires on its own.
 *
 * Lifecycle:
 *
 *   1. The panel renders the "Save draft audit record" button.
 *   2. The operator clicks. The button handler builds the
 *      payload (via ``buildPersistedExportRunDraftCreatePayload``)
 *      and calls ``createDraftRecord(payload)``.
 *   3. The hook POSTs to ``/api/v1/export-runs/drafts``.
 *   4. On success: stores the returned ``PersistedExportRunRead``
 *      + the wall-clock timestamp; the panel renders the success
 *      card.
 *   5. On failure: stores the error message; the panel renders
 *      the inline error. No retry happens automatically.
 *
 * Phase 5B regression compatibility:
 *   * NO ``useEffect`` that fires the request. The save is a
 *     manual click only.
 *   * NO retry-on-mount.
 *   * NO debounce — the operator's intent is explicit.
 *   * AbortController + alive-ref still wired so an unmount
 *     mid-save doesn't trigger a setState after teardown.
 *   * ``createDraftRecord`` returns the saved record on success
 *     (or throws) so the caller can react synchronously to the
 *     outcome (e.g. resetting the notes textarea).
 */

export interface UsePersistExportRunDraftReturn {
  /** Saved on the most recent successful POST. ``null`` until the
   *  first successful save. Cleared by ``clearStatus``. */
  lastSavedRecord: PersistedExportRunRead | null;
  /** ISO timestamp of when ``lastSavedRecord`` was returned by the
   *  backend. Cleared with the record. */
  lastSavedAt: string | null;
  /** ``true`` while a POST is in flight. The panel uses this to
   *  disable the Save button so a double-click can't create two
   *  records. */
  busy: boolean;
  /** Operator-friendly error message from the most recent failed
   *  save. ``null`` when no error is pending. */
  error: string | null;
  /** Imperative create. Resolves to the saved record on success;
   *  throws (and stores ``error``) on failure. */
  createDraftRecord: (
    payload: PersistedExportRunCreate,
  ) => Promise<PersistedExportRunRead>;
  /** Clear ``lastSavedRecord`` / ``lastSavedAt`` / ``error``. The
   *  panel calls this after the operator dismisses the success
   *  card or starts a new save. */
  clearStatus: () => void;
}

export function usePersistExportRunDraft(): UsePersistExportRunDraftReturn {
  const [lastSavedRecord, setLastSavedRecord] =
    useState<PersistedExportRunRead | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Race / unmount safety -----------------------------------
  // Manual-click flow doesn't have the kind of race the evaluator
  // hook does (one user click = one fire), but we still abort
  // on unmount AND drop late results so a fast unmount mid-save
  // doesn't trigger a setState after teardown.
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

  const createDraftRecord = useCallback(
    async (
      payload: PersistedExportRunCreate,
    ): Promise<PersistedExportRunRead> => {
      // Cancel any prior in-flight save (defensive — UI disables
      // the button while busy, but a previous save aborted by
      // unmount could still be cleaning up).
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const myRequestId = ++requestIdRef.current;

      setBusy(true);
      setError(null);

      try {
        const record = await exportRunsApi.createDraft(payload, {
          signal: controller.signal,
        });
        if (
          aliveRef.current &&
          myRequestId === requestIdRef.current
        ) {
          setLastSavedRecord(record);
          setLastSavedAt(new Date().toISOString());
          setError(null);
        }
        return record;
      } catch (err) {
        if (controller.signal.aborted) {
          // Aborted by unmount or a fresh save — caller shouldn't
          // see this as a user-visible error.
          throw err;
        }
        const msg = getApiErrorMessage(
          err,
          "Could not save draft audit record.",
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
          setBusy(false);
        }
      }
    },
    [],
  );

  const clearStatus = useCallback(() => {
    setLastSavedRecord(null);
    setLastSavedAt(null);
    setError(null);
  }, []);

  return {
    lastSavedRecord,
    lastSavedAt,
    busy,
    error,
    createDraftRecord,
    clearStatus,
  };
}
