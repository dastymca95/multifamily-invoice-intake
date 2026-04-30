"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { exportRunsApi, getApiErrorMessage } from "@/lib/api";
import type { PersistedExportRunRead } from "@/types/export-run-persistence";

/**
 * Phase 5C — Notes-only PATCH for a persisted draft / audit
 * export run record.
 *
 * Mirrors the Phase 5B ``usePersistExportRunDraft`` design:
 *   * Manual click only — no ``useEffect`` fires the request.
 *   * AbortController + ``aliveRef`` so an unmount mid-save
 *     doesn't trigger a setState after teardown.
 *   * Returns the saved record on success (or throws); the
 *     caller (the detail panel) uses the resolved record to
 *     refresh the visible row in place without a full refetch.
 *
 * Phase 5A's PATCH endpoint accepts ONLY ``notes`` — sending any
 * other field 422s. The hook surface mirrors that constraint:
 * the only argument is the new notes value (or ``null`` to
 * clear).
 */

export interface UseExportRunNotesMutationReturn {
  /** ``true`` while the PATCH is in flight. The detail panel uses
   *  this to disable the Save button so a double-click can't
   *  fire two requests. */
  busy: boolean;
  /** Operator-friendly error message from the most recent failed
   *  PATCH. ``null`` when no error is pending. */
  error: string | null;
  /** ``true`` for a brief moment after a successful PATCH so the
   *  panel can flash a "Notes saved" affordance. The caller is
   *  responsible for calling ``clearStatus`` after the
   *  acknowledgement (or it will simply remain set until the
   *  next save). */
  saved: boolean;
  /** Imperative save. Resolves to the updated record on success;
   *  throws (and stores ``error``) on failure. */
  saveNotes: (
    runId: string,
    notes: string | null,
  ) => Promise<PersistedExportRunRead>;
  /** Clear ``error`` / ``saved``. The panel calls this when the
   *  operator dismisses the saved-state callout or starts editing
   *  notes again. */
  clearStatus: () => void;
}

export function useExportRunNotesMutation(): UseExportRunNotesMutationReturn {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // ---- Race / unmount safety -----------------------------------
  // Manual-click flow doesn't have the kind of race the list /
  // detail hooks do, but we still abort on unmount AND drop late
  // results so a fast unmount mid-PATCH doesn't trigger a setState
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

  const saveNotes = useCallback(
    async (
      runId: string,
      notes: string | null,
    ): Promise<PersistedExportRunRead> => {
      // Cancel any prior in-flight save (defensive — UI disables
      // the Save button while ``busy``, but a previous save aborted
      // by unmount could still be cleaning up).
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const myRequestId = ++requestIdRef.current;

      setBusy(true);
      setError(null);
      setSaved(false);

      try {
        const updated = await exportRunsApi.updateNotes(
          runId,
          { notes: notes ?? null },
          { signal: controller.signal },
        );
        if (
          aliveRef.current &&
          myRequestId === requestIdRef.current
        ) {
          setSaved(true);
          setError(null);
        }
        return updated;
      } catch (err) {
        if (controller.signal.aborted) {
          throw err;
        }
        const msg = getApiErrorMessage(
          err,
          "Could not save audit record notes.",
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
    setError(null);
    setSaved(false);
  }, []);

  return {
    busy,
    error,
    saved,
    saveNotes,
    clearStatus,
  };
}
