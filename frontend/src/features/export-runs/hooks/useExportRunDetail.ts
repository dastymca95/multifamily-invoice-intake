"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { exportRunsApi, getApiErrorMessage } from "@/lib/api";
import type { PersistedExportRunRead } from "@/types/export-run-persistence";

/**
 * Phase 5C — Persisted draft / audit export run detail hook.
 *
 * Loads ONE record by id when ``id`` is non-null. Same race /
 * unmount safety pattern as ``useExportRuns``:
 *
 *   * AbortController per request, monotonic request id, alive ref.
 *   * ``data`` only updates with the LATEST in-flight response.
 *   * On unmount the in-flight request is aborted.
 *
 * The hook is intentionally read-only — notes updates flow through
 * the separate ``useExportRunNotesMutation`` hook so the read +
 * write paths can be re-used independently (e.g. a future "audit
 * detail viewer" surface that doesn't expose notes editing).
 *
 * ``setData`` is exposed so the notes mutation can refresh the
 * detail panel optimistically after a successful PATCH without
 * waiting for the next refetch.
 */

export interface UseExportRunDetailReturn {
  data: PersistedExportRunRead | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
  /** Optimistic local refresh after a notes PATCH. The list
   *  page's mutation hook calls this with the PATCH response so
   *  the detail panel renders the freshest copy without a
   *  refetch. */
  setData: (next: PersistedExportRunRead) => void;
}

export function useExportRunDetail(
  id: string | null,
): UseExportRunDetailReturn {
  const [data, setData] = useState<PersistedExportRunRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  // ---- Race / unmount safety -----------------------------------
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

  useEffect(() => {
    if (!id) {
      // No id selected — clear any prior outcome so the panel
      // doesn't carry stale data when the list opens a different
      // record.
      if (data !== null) setData(null);
      if (error !== null) setError(null);
      if (loading) setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const myRequestId = ++requestIdRef.current;

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const next = await exportRunsApi.get(id, {
          signal: controller.signal,
        });
        if (!aliveRef.current) return;
        if (myRequestId !== requestIdRef.current) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (!aliveRef.current) return;
        if (myRequestId !== requestIdRef.current) return;
        setError(
          getApiErrorMessage(
            err,
            "Could not load draft audit record.",
          ),
        );
      } finally {
        if (aliveRef.current && myRequestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
    // ``data`` / ``error`` / ``loading`` are written from inside
    // the effect; dependency-by-stable-primitive everywhere else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, retryToken]);

  const retry = useCallback(() => {
    setRetryToken((t) => t + 1);
  }, []);

  const setDataExternal = useCallback(
    (next: PersistedExportRunRead) => {
      setData(next);
      // Clear any prior error when the caller has a fresh copy in
      // hand — the previous error was for the OLD load attempt.
      setError(null);
    },
    [],
  );

  return {
    data,
    loading,
    error,
    retry,
    setData: setDataExternal,
  };
}
