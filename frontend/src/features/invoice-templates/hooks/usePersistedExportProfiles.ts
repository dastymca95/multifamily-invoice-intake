"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { exportProfilesApi, getApiErrorMessage } from "@/lib/api";
import type { PersistedExportProfileSummary } from "@/types/export-profile-persistence";

/**
 * Phase 4B — load the persisted export profile catalog (list-only).
 *
 * Lifecycle:
 *
 *   1. Fires on mount (when ``enabled``) and refetches whenever
 *      ``enabled`` flips back to ``true`` (e.g. panel re-opened).
 *   2. Each call gets its own ``AbortController`` + monotonically-
 *      increasing request id — slow earlier responses can never
 *      overwrite a fresh later one.
 *   3. ``data`` only updates with the LATEST in-flight request's
 *      response; stale responses are dropped silently.
 *   4. On unmount the in-flight request is aborted and the alive
 *      ref blocks any final ``setState``.
 *   5. ``retry()`` forces a re-fire — used by the "Could not load
 *      saved profiles" warning banner.
 *
 * Phase 4B intentionally does NOT auto-poll. Saved profiles are
 * catalog metadata — operators don't expect them to stream.
 *
 * Returned ``profiles`` is ALWAYS an array (never null) so the
 * picker can compose it with built-ins without nullguard
 * gymnastics. Errors live on ``error`` separately.
 */

export interface UsePersistedExportProfilesArgs {
  enabled?: boolean;
  /** Mirrors the backend's default. ``true`` = active rows only. */
  isActive?: boolean | null;
  /** Soft cap — Phase 4B defaults to 200 which is plenty for an
   *  operator-curated catalog. Bumps gracefully if a future tenant
   *  has more. */
  limit?: number;
}

export interface UsePersistedExportProfilesReturn {
  profiles: PersistedExportProfileSummary[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

const DEFAULT_LIMIT = 200;

export function usePersistedExportProfiles(
  args: UsePersistedExportProfilesArgs = {},
): UsePersistedExportProfilesReturn {
  const {
    enabled = true,
    isActive = true,
    limit = DEFAULT_LIMIT,
  } = args;

  const [profiles, setProfiles] = useState<
    PersistedExportProfileSummary[]
  >([]);
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
    if (!enabled) {
      // Disabled — clear any prior outcome so re-enabling starts
      // from a clean slate.
      if (profiles.length > 0) setProfiles([]);
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
        const params: Record<string, unknown> = { limit };
        if (isActive !== null) params.is_active = isActive;
        const next = await exportProfilesApi.list(
          params,
          { signal: controller.signal },
        );
        if (!aliveRef.current) return;
        if (myRequestId !== requestIdRef.current) return;
        setProfiles(next.items ?? []);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (!aliveRef.current) return;
        if (myRequestId !== requestIdRef.current) return;
        setError(
          getApiErrorMessage(err, "Could not load saved export profiles."),
        );
        // Don't wipe ``profiles`` — a previously-loaded list stays
        // visible while a refetch is failing.
      } finally {
        if (aliveRef.current && myRequestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
    // ``profiles`` / ``error`` / ``loading`` are written from inside
    // the effect; dependency-by-stable-primitive everywhere else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, isActive, limit, retryToken]);

  const retry = useCallback(() => {
    setRetryToken((t) => t + 1);
  }, []);

  return { profiles, loading, error, retry };
}
