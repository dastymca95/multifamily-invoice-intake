"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { exportReadinessBoundaryApi, getApiErrorMessage } from "@/lib/api";
import type { OperationalResolutionResult } from "@/types/operational-resolution";
import type { BackendExportReadinessBoundaryResult } from "@/types/export-readiness-boundary";

import { buildBackendExportReadinessBoundaryRequest } from "../lib/export-readiness-boundary-backend-adapter";
import type { ExportProfile } from "../lib/export-profile-contract";
import type { OperationalExportPreview } from "../lib/operational-export-preview";
import type { ExportProfileValidationResult } from "../lib/export-profile-validation";
import type { ExportProfileValidationSource } from "../lib/export-profile-backend-adapter";
import type { ExportValidationParityResult } from "../lib/export-validation-parity";

/**
 * Phase 3N — Hook that calls the Phase 3M backend boundary endpoint
 * and exposes a small UI-friendly state machine.
 *
 * Lifecycle (matches ``useBackendExportProfileValidation``):
 *
 *   1. The host passes the panel's current diagnostic state.
 *   2. The hook debounces input changes (default 350 ms) so quick
 *      profile / source flips collapse into a single backend call.
 *   3. Each call gets its own ``AbortController`` + monotonically-
 *      increasing request id — slow earlier responses can never
 *      overwrite a fresh later one.
 *   4. ``data`` only updates with the LATEST in-flight request's
 *      response; stale responses are dropped silently.
 *   5. On unmount the in-flight request is aborted and the alive
 *      ref blocks any final ``setState``.
 *   6. ``retry()`` forces a re-fire even when nothing else changed
 *      — used by the "Backend boundary check failed" banner.
 *
 * Source semantics:
 *   * "loading"     — request in flight, no prior data yet
 *   * "backend"     — last request succeeded, result available
 *   * "local"       — last request failed; UI shows local fallback
 *   * "unavailable" — disabled / inputs not ready
 */

export type UseBackendExportReadinessBoundarySource =
  | "backend"
  | "local"
  | "loading"
  | "unavailable";

export interface UseBackendExportReadinessBoundaryArgs {
  result: OperationalResolutionResult | null;
  exportPreview: OperationalExportPreview | null;
  activeProfileValidation: ExportProfileValidationResult | null;
  parityResult: ExportValidationParityResult | null;
  validationSource: ExportProfileValidationSource;
  selectedProfile: ExportProfile | null;
  /** Phase 4B — true when the operator's selected profile came
   *  from the Phase 4A backend catalog. Forwarded to the request
   *  builder so the boundary endpoint can drop
   *  ``no_export_profile_persistence`` for saved selections. */
  hasPersistedProfile?: boolean;
  /** When false, the hook stays idle and never fires a request. */
  enabled?: boolean;
  /** Debounce window in ms. Defaults to 350. */
  debounceMs?: number;
}

export interface UseBackendExportReadinessBoundaryReturn {
  data: BackendExportReadinessBoundaryResult | null;
  loading: boolean;
  error: string | null;
  /** True iff ``data`` is from a successful backend call AND no
   *  stale-error condition exists. */
  verified: boolean;
  source: UseBackendExportReadinessBoundarySource;
  /** Force a re-fire even when inputs haven't changed. */
  retry: () => void;
}

const DEFAULT_DEBOUNCE_MS = 350;

export function useBackendExportReadinessBoundary(
  args: UseBackendExportReadinessBoundaryArgs,
): UseBackendExportReadinessBoundaryReturn {
  const {
    result,
    exportPreview,
    activeProfileValidation,
    parityResult,
    validationSource,
    selectedProfile,
    hasPersistedProfile = false,
    enabled = true,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = args;

  const [data, setData] =
    useState<BackendExportReadinessBoundaryResult | null>(null);
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

  // ---- Stable input keys for the dep array --------------------------------
  // The boundary classifier is driven by status labels, not raw
  // result objects. Cheap derived keys instead of raw object identity
  // keep the effect from looping when the panel re-renders with
  // structurally-equal-but-newly-allocated objects.
  const resultKey = result
    ? [
        result.template_id ?? "",
        result.pattern_id ?? "",
        result.document_id ?? "",
        result.batch_id ?? "",
        typeof result.operational_summary?.status === "string"
          ? result.operational_summary.status
          : "",
      ].join(":")
    : "";
  const previewKey = exportPreview
    ? [
        exportPreview.row_count,
        exportPreview.summary.column_count,
        exportPreview.blocked_row_count,
        exportPreview.warning_row_count,
        exportPreview.conflict_row_count,
      ].join(":")
    : "";
  const validationKey = activeProfileValidation
    ? [
        activeProfileValidation.profile_id,
        activeProfileValidation.status,
        activeProfileValidation.summary.blocked_count,
        activeProfileValidation.summary.warning_count,
        activeProfileValidation.summary.info_count,
      ].join(":")
    : "";
  const parityKey = parityResult
    ? [parityResult.status, parityResult.checked ? "y" : "n"].join(":")
    : "";
  const profileKey = selectedProfile
    ? `${selectedProfile.id}::${selectedProfile.columns.length}`
    : "";

  // ---- Fire backend call (debounced + aborted on input change) ------------
  useEffect(() => {
    // The endpoint accepts an empty input and returns ``not_available``,
    // but firing it with no result wastes a round-trip and would
    // mask the panel's "no preview yet" idle state. Keep idle until
    // we actually have something to ask about.
    if (!enabled || !result) {
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

    const payload = buildBackendExportReadinessBoundaryRequest({
      result,
      exportPreview,
      activeProfileValidation,
      parityResult,
      validationSource,
      selectedProfile,
      hasPersistedProfile,
    });

    const handle = window.setTimeout(async () => {
      try {
        const next = await exportReadinessBoundaryApi.evaluate(payload, {
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
          getApiErrorMessage(err, "Could not run backend boundary check."),
        );
        // Don't wipe ``data`` — the panel can keep showing the
        // last verified verdict while the banner explains the
        // new failure.
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
    // ``data`` / ``error`` / ``loading`` are written from inside the
    // effect; dependency-by-stable-key everywhere else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    resultKey,
    previewKey,
    validationKey,
    parityKey,
    profileKey,
    validationSource,
    hasPersistedProfile,
    debounceMs,
    retryToken,
  ]);

  const retry = useCallback(() => {
    setRetryToken((t) => t + 1);
  }, []);

  // ---- Derived source bucket ---------------------------------------------
  let source: UseBackendExportReadinessBoundarySource;
  if (!enabled || !result) {
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
