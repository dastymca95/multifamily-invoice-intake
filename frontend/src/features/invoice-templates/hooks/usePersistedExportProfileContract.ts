"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { exportProfilesApi, getApiErrorMessage } from "@/lib/api";
import type { PersistedExportProfileContractResponse } from "@/types/export-profile-persistence";

/**
 * Phase 4B — load the Phase 3I-shaped contract for a SELECTED
 * persisted profile.
 *
 * The Phase 4A list endpoint returns summaries (no JSONB
 * ``settings`` / ``columns``) so the picker fires this hook on
 * selection to fetch the full contract. The fetched contract feeds
 * the existing Phase 3J validation hook + report helpers without
 * any further conversion.
 *
 * Lifecycle:
 *
 *   1. Fires whenever ``profileId`` changes (and is non-null) AND
 *      ``enabled`` is true.
 *   2. Per-id ``AbortController`` + monotonically-increasing
 *      request id — selecting profile A → B → A within ms collapses
 *      cleanly.
 *   3. ``data`` only updates with the LATEST in-flight request's
 *      response.
 *   4. On unmount the in-flight request is aborted and the alive
 *      ref blocks any final ``setState``.
 *   5. ``retry()`` forces a re-fire — used by the "Could not load
 *      saved profile contract" warning.
 *
 * Contract failure does NOT crash the panel — the host falls back
 * to the previously-selected built-in (Custom CSV mirror) and
 * surfaces the error inline.
 */

export interface UsePersistedExportProfileContractArgs {
  profileId: string | null;
  enabled?: boolean;
}

export interface UsePersistedExportProfileContractReturn {
  data: PersistedExportProfileContractResponse | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

export function usePersistedExportProfileContract(
  args: UsePersistedExportProfileContractArgs,
): UsePersistedExportProfileContractReturn {
  const { profileId, enabled = true } = args;

  const [data, setData] =
    useState<PersistedExportProfileContractResponse | null>(null);
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
    if (!enabled || !profileId) {
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
        const next = await exportProfilesApi.getContract(profileId, {
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
            "Could not load saved export profile contract.",
          ),
        );
        // Drop ``data`` so the host falls back to the built-in
        // contract — a stale contract from the previous saved
        // profile would mis-validate the current selection.
        setData(null);
      } finally {
        if (aliveRef.current && myRequestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, profileId, retryToken]);

  const retry = useCallback(() => {
    setRetryToken((t) => t + 1);
  }, []);

  return { data, loading, error, retry };
}
