"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { exportRunDraftsApi, getApiErrorMessage } from "@/lib/api";
import type { OperationalResolutionResult } from "@/types/operational-resolution";
import type { BackendExportRunDraftResult } from "@/types/export-run-draft";

import { buildBackendExportRunDraftRequest } from "../lib/export-run-draft-adapter";
import type { ExportProfile } from "../lib/export-profile-contract";
import type { OperationalExportPreview } from "../lib/operational-export-preview";
import type { ExportProfileValidationResult } from "../lib/export-profile-validation";
import type { ExportProfileValidationSource } from "../lib/export-profile-backend-adapter";
import type { ExportReadinessBoundary } from "../lib/export-readiness-boundary";
import type { ExportProfileSelectionOption } from "../lib/export-profile-selection";

/**
 * Phase 4G — Hook that calls the Phase 4F backend draft endpoint
 * and exposes a small UI-friendly state machine.
 *
 * Lifecycle (matches the existing Phase 3J / 3N hook style):
 *
 *   1. Host passes the panel's current diagnostic state.
 *   2. Hook debounces input changes (default 350 ms) so quick
 *      profile / source flips collapse into a single backend call.
 *   3. Each call gets its own ``AbortController`` + monotonically-
 *      increasing request id — slow earlier responses can never
 *      overwrite a fresh later one.
 *   4. ``data`` only updates with the LATEST in-flight request's
 *      response; stale responses are dropped silently.
 *   5. On unmount the in-flight request is aborted and the alive
 *      ref blocks any final ``setState``.
 *   6. ``retry()`` forces a re-fire even when nothing else changed
 *      — used by the "Could not evaluate export draft" banner.
 *
 * Source semantics (mirrors the source-marker copy):
 *   * "loading"     — request in flight, no prior data yet
 *   * "backend"     — last request succeeded, result available
 *   * "error"       — last request failed; UI shows error + Retry
 *   * "unavailable" — disabled / inputs not ready
 */

export type UseBackendExportRunDraftSource =
  | "backend"
  | "loading"
  | "error"
  | "unavailable";

export interface UseBackendExportRunDraftArgs {
  result: OperationalResolutionResult | null;
  exportPreview: OperationalExportPreview | null;
  selectedExportOption: ExportProfileSelectionOption | null;
  selectedExportProfile: ExportProfile | null;
  activeProfileValidation: ExportProfileValidationResult | null;
  activeReadinessBoundary: ExportReadinessBoundary | null;
  activeValidationSource: ExportProfileValidationSource;
  activeBoundarySource: string;
  parityStatus?: string | null;
  /** When false, the hook stays idle and never fires a request. */
  enabled?: boolean;
  /** Debounce window in ms. Defaults to 350. */
  debounceMs?: number;
}

export interface UseBackendExportRunDraftReturn {
  data: BackendExportRunDraftResult | null;
  loading: boolean;
  error: string | null;
  /** True iff ``data`` is from a successful backend call AND no
   *  stale-error condition exists. */
  verified: boolean;
  source: UseBackendExportRunDraftSource;
  /** Phase 4H — TRUE when the panel is showing PREVIOUS draft
   *  ``data`` while a fresh request is either in flight or just
   *  failed (i.e. the displayed verdict is older than the current
   *  request fingerprint). When ``stale=true`` the UI MUST label
   *  the section so the operator doesn't misread it as current. */
  stale: boolean;
  /** Phase 4H — ISO timestamp of when ``data`` was last loaded.
   *  ``null`` until the first successful response. Cleared when
   *  ``data`` is cleared (e.g. disabled, identity changed). */
  lastUpdatedAt: string | null;
  /** Force a re-fire even when inputs haven't changed. */
  retry: () => void;
}

const DEFAULT_DEBOUNCE_MS = 350;

export function useBackendExportRunDraft(
  args: UseBackendExportRunDraftArgs,
): UseBackendExportRunDraftReturn {
  const {
    result,
    exportPreview,
    selectedExportOption,
    selectedExportProfile,
    activeProfileValidation,
    activeReadinessBoundary,
    activeValidationSource,
    activeBoundarySource,
    parityStatus,
    enabled = true,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = args;

  const [data, setData] = useState<BackendExportRunDraftResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by ``retry()``; folded into the deps of the firing
  // effect so callers can re-run without changing inputs.
  const [retryToken, setRetryToken] = useState(0);

  // Phase 4H — stale-state metadata.
  // ``dataFingerprint`` is the input fingerprint at the moment the
  // current ``data`` was returned. ``requestFingerprint`` is the
  // input fingerprint of the LATEST request. When they differ AND
  // ``data`` is non-null, the panel is showing last-known-good and
  // the UI labels it as such.
  const [dataFingerprint, setDataFingerprint] = useState<string | null>(
    null,
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

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
  // The draft classifier reads status labels + IDs + row counts.
  // Cheap derived keys instead of raw object identity keep the
  // effect from looping when the panel re-renders with structurally-
  // equal-but-newly-allocated objects.
  const resultKey = result
    ? [
        result.template_id ?? "",
        result.pattern_id ?? "",
        result.document_id ?? "",
        result.batch_id ?? "",
      ].join(":")
    : "";
  const previewKey = exportPreview
    ? [
        exportPreview.row_count,
        exportPreview.summary?.column_count ?? 0,
        exportPreview.blocked_row_count ?? 0,
        exportPreview.warning_row_count ?? 0,
        exportPreview.summary?.cells_with_issues ?? 0,
        exportPreview.status,
      ].join(":")
    : "";
  const optionKey = selectedExportOption
    ? `${selectedExportOption.option_id}::${selectedExportOption.source}`
    : "";
  const validationKey = activeProfileValidation
    ? activeProfileValidation.status
    : "";
  const boundaryKey = activeReadinessBoundary
    ? activeReadinessBoundary.diagnostic_status
    : "";

  // Determine readiness — the hook idles unless we have at least
  // a result, a preview, and one of the verdicts the classifier
  // reads from.
  const readyToFire =
    enabled &&
    !!result &&
    !!exportPreview &&
    !!activeProfileValidation &&
    !!activeReadinessBoundary;

  // Phase 4H — stable fingerprint of the LATEST input set. Used
  // both as the dep key for the firing effect AND as the value we
  // stamp on ``dataFingerprint`` after a successful response. When
  // the current fingerprint differs from ``dataFingerprint``, the
  // panel is showing last-known-good and we surface ``stale=true``.
  const currentFingerprint = [
    readyToFire ? "1" : "0",
    resultKey,
    previewKey,
    optionKey,
    validationKey,
    boundaryKey,
    activeValidationSource,
    activeBoundarySource,
    parityStatus ?? "",
  ].join("|");

  // ---- Fire backend call (debounced + aborted on input change) ------------
  useEffect(() => {
    if (!readyToFire || !result) {
      // Disabled / inputs not ready — clear any prior outcome so
      // the panel doesn't show stale data after the operator
      // changes profile to one that breaks the evaluator. Phase 4H
      // also clears the fingerprint + timestamp so the next
      // ``readyToFire`` cycle starts from a clean slate (no
      // accidental stale=true on first fresh result).
      if (data !== null) setData(null);
      if (error !== null) setError(null);
      if (loading) setLoading(false);
      if (dataFingerprint !== null) setDataFingerprint(null);
      if (lastUpdatedAt !== null) setLastUpdatedAt(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const myRequestId = ++requestIdRef.current;
    const myRequestFingerprint = currentFingerprint;

    setLoading(true);
    setError(null);

    const payload = buildBackendExportRunDraftRequest({
      result,
      exportPreview,
      selectedExportOption,
      selectedExportProfile,
      activeProfileValidation,
      activeReadinessBoundary,
      activeValidationSource,
      activeBoundarySource,
      parityStatus,
    });

    const handle = window.setTimeout(async () => {
      try {
        const next = await exportRunDraftsApi.evaluate(payload, {
          signal: controller.signal,
        });
        if (!aliveRef.current) return;
        if (myRequestId !== requestIdRef.current) return;
        setData(next);
        setError(null);
        // Phase 4H — stamp the fingerprint + timestamp so the next
        // render correctly reports stale=false until the next
        // input-change cycle starts.
        setDataFingerprint(myRequestFingerprint);
        setLastUpdatedAt(new Date().toISOString());
      } catch (err) {
        if (controller.signal.aborted) return;
        if (!aliveRef.current) return;
        if (myRequestId !== requestIdRef.current) return;
        setError(
          getApiErrorMessage(err, "Could not evaluate export draft."),
        );
        // Don't wipe ``data`` — the panel can keep showing the
        // last verified verdict while the banner explains the
        // new failure. ``dataFingerprint`` stays at the previous
        // value; the source-bucket math correctly reports
        // ``stale=true`` because the current request fingerprint
        // moved on.
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
    // ``data`` / ``error`` / ``loading`` / ``dataFingerprint`` /
    // ``lastUpdatedAt`` are written from inside the effect;
    // dependency-by-stable-key everywhere else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    readyToFire,
    resultKey,
    previewKey,
    optionKey,
    validationKey,
    boundaryKey,
    activeValidationSource,
    activeBoundarySource,
    parityStatus,
    debounceMs,
    retryToken,
  ]);

  const retry = useCallback(() => {
    setRetryToken((t) => t + 1);
  }, []);

  // ---- Derived source bucket ---------------------------------------------
  // Phase 4H — when ``data`` is present, the loading / error
  // banners take precedence over "backend" so the operator sees
  // that something is happening (or just failed) on the wire even
  // though the visible body is the previous verdict. The body
  // separately gates on ``stale`` to label itself.
  let source: UseBackendExportRunDraftSource;
  if (!readyToFire) {
    source = "unavailable";
  } else if (loading) {
    source = "loading";
  } else if (error) {
    source = "error";
  } else if (data) {
    source = "backend";
  } else {
    source = "unavailable";
  }
  // Phase 4H — stale = "we have data, but its fingerprint isn't
  // the current input fingerprint AND we're either waiting for a
  // fresh response or the last refresh failed".
  const stale =
    data !== null &&
    dataFingerprint !== currentFingerprint &&
    (source === "loading" || source === "error");

  return {
    data,
    loading,
    error,
    verified: source === "backend" && !stale,
    source,
    stale,
    lastUpdatedAt,
    retry,
  };
}
