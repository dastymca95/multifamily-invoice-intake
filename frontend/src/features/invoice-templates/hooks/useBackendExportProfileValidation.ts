"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { exportProfilesApi, getApiErrorMessage } from "@/lib/api";
import type { OperationalResolutionResult } from "@/types/operational-resolution";
import type { BackendExportProfileValidationResult } from "@/types/export-profile-validation";

import { buildBackendExportProfileValidationRequest } from "../lib/export-profile-backend-adapter";
import type { ExportProfile } from "../lib/export-profile-contract";
import type { OperationalExportPreview } from "../lib/operational-export-preview";

/**
 * Phase 3J — Hook that calls the Phase 3I backend validator and
 * exposes a small UI-friendly state machine.
 *
 * Lifecycle:
 *
 *   1. The host passes ``{profile, preview, result, enabled}``.
 *   2. The hook debounces input changes (default 350 ms) so quick
 *      switches between profiles or rapid re-runs collapse into a
 *      single backend call.
 *   3. Each call gets its own ``AbortController`` + monotonically-
 *      increasing request id so a slow earlier response can never
 *      overwrite a fresh later one.
 *   4. ``data`` only updates with the LATEST in-flight request's
 *      result; stale responses are dropped silently.
 *   5. On unmount the in-flight request is aborted and the alive
 *      ref blocks any final ``setState``.
 *   6. ``retry()`` forces a re-fire even when nothing else changed
 *      — used by the "Backend profile check failed" banner.
 *
 * Source semantics:
 *   * "loading"     — request in flight, no prior data yet
 *   * "backend"     — last request succeeded, result available
 *   * "local"       — last request failed; UI should show local fallback
 *   * "unavailable" — disabled / inputs not ready
 */

export type UseBackendExportProfileValidationSource =
  | "backend"
  | "local"
  | "loading"
  | "unavailable";

export interface UseBackendExportProfileValidationArgs {
  profile: ExportProfile | null;
  preview: OperationalExportPreview | null;
  result: OperationalResolutionResult | null;
  /** When false, the hook stays idle and never fires a request. */
  enabled?: boolean;
  /** Debounce window in ms. Defaults to 350. */
  debounceMs?: number;
  /** Optional one-line label echoed into the request context block. */
  contextLabel?: string | null;
}

export interface UseBackendExportProfileValidationReturn {
  data: BackendExportProfileValidationResult | null;
  loading: boolean;
  error: string | null;
  /** Convenience flag — true iff ``data`` is from a successful
   *  backend call AND no stale-error condition exists. */
  verified: boolean;
  /** Coarse source bucket suitable for the panel banner. */
  source: UseBackendExportProfileValidationSource;
  /** Force a re-fire even when inputs haven't changed. */
  retry: () => void;
}

const DEFAULT_DEBOUNCE_MS = 350;

export function useBackendExportProfileValidation(
  args: UseBackendExportProfileValidationArgs,
): UseBackendExportProfileValidationReturn {
  const {
    profile,
    preview,
    result,
    enabled = true,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    contextLabel,
  } = args;

  const [data, setData] =
    useState<BackendExportProfileValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by ``retry()``; folded into the deps of the firing
  // effect so callers can re-run without changing inputs.
  const [retryToken, setRetryToken] = useState(0);

  // ---- Race / unmount safety -----------------------------------------------
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

  // ---- Stable inputs for the dep array ------------------------------------
  // The hook fires whenever the things that affect the validator's
  // verdict change. Cheap derived keys instead of raw object identity
  // keep the effect from looping when the panel re-renders with
  // structurally-equal-but-newly-allocated objects (e.g. a
  // ``useMemo`` recomputing on an unrelated re-render).
  const profileKey = profile
    ? `${profile.id}::${profile.columns.length}`
    : null;
  const previewKey = preview
    ? [
        preview.row_count,
        preview.summary.column_count,
        preview.summary.cells_with_issues,
        preview.blocked_row_count,
        preview.warning_row_count,
        preview.conflict_row_count,
      ].join(":")
    : null;
  const resultKey = result
    ? [
        result.template_id ?? "",
        result.pattern_id ?? "",
        result.document_id ?? "",
        result.batch_id ?? "",
      ].join(":")
    : "";

  // ---- Fire backend call (debounced + aborted on input change) ------------
  useEffect(() => {
    if (!enabled || !profile || !preview || !result) {
      // Disabled / inputs not ready — clear any prior outcome so
      // the panel doesn't show stale data after the operator
      // changes profile to one without a preview etc.
      if (data !== null) setData(null);
      if (error !== null) setError(null);
      if (loading) setLoading(false);
      return;
    }
    // Empty preview short-circuit — there's nothing meaningful for
    // the backend to do that the local validator hasn't already
    // surfaced. Callers should still render the local PROFILE_PREVIEW_HAS_NO_ROWS
    // verdict — this branch keeps us from spamming the API.
    if (preview.row_count === 0 || preview.columns.length === 0) {
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

    const payload = buildBackendExportProfileValidationRequest({
      profile,
      preview,
      result,
      contextLabel: contextLabel ?? null,
    });

    const handle = window.setTimeout(async () => {
      try {
        const next = await exportProfilesApi.validatePreview(payload, {
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
          getApiErrorMessage(err, "Could not run backend profile check."),
        );
        // Don't wipe ``data`` — the panel can keep showing the last
        // verified verdict while the banner explains the new failure.
      } finally {
        if (aliveRef.current && myRequestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    }, debounceMs);

    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
    // We DO want this to fire on input changes; ``data`` / ``error``
    // / ``loading`` are written from inside the effect so omitting
    // them is intentional. The two non-state deps (profile / preview
    // / result references) are gated through their stable keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    profileKey,
    previewKey,
    resultKey,
    debounceMs,
    contextLabel,
    retryToken,
  ]);

  const retry = useCallback(() => {
    setRetryToken((t) => t + 1);
  }, []);

  // ---- Derived source bucket ---------------------------------------------
  let source: UseBackendExportProfileValidationSource;
  if (!enabled || !profile || !preview || !result) {
    source = "unavailable";
  } else if (loading && data === null) {
    source = "loading";
  } else if (error && data === null) {
    source = "local";
  } else if (data) {
    source = "backend";
  } else {
    source = "unavailable";
  }

  return {
    data,
    loading,
    error,
    verified: source === "backend",
    source,
    retry,
  };
}
