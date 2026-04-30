"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { exportRunsApi, getApiErrorMessage } from "@/lib/api";
import type {
  PersistedExportRunListParams,
  PersistedExportRunStatus,
  PersistedExportRunSummary,
} from "@/types/export-run-persistence";

/**
 * Phase 5C / 5D — Persisted draft / audit export run list hook.
 *
 * Lifecycle (mirrors ``usePersistedExportProfiles``):
 *
 *   1. Fires the FIRST PAGE on mount when ``enabled``.
 *   2. Refetches the FIRST PAGE whenever any filter changes
 *      (status / target system / profile id / etc.) AND when
 *      ``retry()`` bumps the retry token.
 *   3. ``loadMore()`` (Phase 5D) appends the next page to the
 *      existing list without clearing it. The Load More UI is
 *      gated on ``canLoadMore``.
 *   4. Each call gets its own ``AbortController`` + monotonic
 *      request id — slow earlier responses can never overwrite
 *      a fresh later one. First-page calls and load-more calls
 *      use the SAME monotonic id stream so a filter change
 *      mid-load-more cancels the load-more cleanly.
 *   5. On unmount the in-flight request is aborted; ``aliveRef``
 *      blocks any final ``setState``.
 *
 * Phase 5C intentionally does NOT auto-poll. Audit records are
 * historical; operators don't expect them to stream.
 *
 * Phase 5D additions:
 *   * Load More pagination (manual click, no infinite scroll).
 *   * Separate ``loading`` (first-page / refetch) and
 *     ``loadingMore`` (Load More click) flags so the UI can render
 *     two different affordances.
 *   * ``loadMoreError`` is independent of ``error`` — a load-more
 *     failure does NOT clear the existing rows.
 *   * ``canLoadMore`` is true iff the LAST successful page filled
 *     the limit (i.e. there might be more rows on the next page).
 *   * Filter changes reset ``items`` + ``loadMoreError`` +
 *     ``canLoadMore`` to a clean first-page slate.
 */

export interface UseExportRunsArgs {
  enabled?: boolean;
  status?: PersistedExportRunStatus | null;
  targetSystem?: string | null;
  exportProfileId?: string | null;
  documentId?: string | null;
  batchId?: string | null;
  /** Page size. Phase 5D defaults to 50. The Load More UI fires
   *  the next page at ``offset = items.length``. */
  limit?: number;
}

export interface UseExportRunsReturn {
  items: PersistedExportRunSummary[];
  /** First-page / refetch in flight. False during Load More. */
  loading: boolean;
  /** Load More click in flight. False during the first page. */
  loadingMore: boolean;
  /** First-page error. Cleared on the next successful refetch.
   *  When set, ``items`` may still hold the previous successful
   *  page (we don't blow away the list on a refetch failure). */
  error: string | null;
  /** Load More error. Independent of ``error``. The existing
   *  rows stay visible when this fires. */
  loadMoreError: string | null;
  /** Heuristic — true iff the LAST successful page returned
   *  exactly ``limit`` rows AND ``items.length`` is non-zero.
   *  When the next page returns ``< limit`` rows we flip this
   *  back to false and the UI hides the button. */
  canLoadMore: boolean;
  /** Force a first-page refetch. Resets ``items`` + load-more
   *  state. Used by the Refresh button + by the parent page
   *  after a successful notes PATCH. */
  retry: () => void;
  /** Append the next page to ``items``. No-op while a request
   *  is in flight or when ``canLoadMore`` is false. */
  loadMore: () => void;
  /** Replace one row in place after a notes PATCH so the table
   *  reflects the freshly-saved record without a full refetch.
   *  Pure local state mutation — never fires a network call. */
  replaceItem: (next: PersistedExportRunSummary) => void;
}

const DEFAULT_LIMIT = 50;

export function useExportRuns(
  args: UseExportRunsArgs = {},
): UseExportRunsReturn {
  const {
    enabled = true,
    status = null,
    targetSystem = null,
    exportProfileId = null,
    documentId = null,
    batchId = null,
    limit = DEFAULT_LIMIT,
  } = args;

  const [items, setItems] = useState<PersistedExportRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  // ``canLoadMore`` is updated only on a successful response so a
  // stale ``true`` from a filter change can't drive the UI into
  // an inconsistent state.
  const [canLoadMore, setCanLoadMore] = useState(false);

  // ---- Race / unmount safety -----------------------------------
  // Single monotonic id stream covering both first-page and
  // load-more requests so a filter change mid-load-more cancels
  // the late response cleanly.
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  // Snapshot of the items length AT THE TIME the load-more
  // request fired. Used to decide whether the response should
  // append (still the latest call) or be dropped (a filter
  // change wiped the list while we were in flight).
  const loadMoreOffsetRef = useRef<number>(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // ---- First-page load (mount + filter change + retry) ---------
  useEffect(() => {
    if (!enabled) {
      // Disabled — clear any prior outcome so re-enabling starts
      // from a clean slate.
      if (items.length > 0) setItems([]);
      if (error !== null) setError(null);
      if (loadMoreError !== null) setLoadMoreError(null);
      if (loading) setLoading(false);
      if (loadingMore) setLoadingMore(false);
      if (canLoadMore) setCanLoadMore(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const myRequestId = ++requestIdRef.current;

    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    // Filter / retry: reset the list so the UI never shows old
    // rows during the new request's spinner. Operators can spot
    // a filter change AND its loading state instead of seeing
    // stale rows.
    setItems([]);
    setCanLoadMore(false);

    (async () => {
      try {
        const params = _buildListParams({
          status,
          targetSystem,
          exportProfileId,
          documentId,
          batchId,
          limit,
          offset: 0,
        });
        const next = await exportRunsApi.list(params, {
          signal: controller.signal,
        });
        if (!aliveRef.current) return;
        if (myRequestId !== requestIdRef.current) return;
        const nextItems = next.items ?? [];
        setItems(nextItems);
        setCanLoadMore(nextItems.length === limit && limit > 0);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (!aliveRef.current) return;
        if (myRequestId !== requestIdRef.current) return;
        setError(
          getApiErrorMessage(
            err,
            "Could not load draft audit records.",
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
    // ``items`` / ``error`` / ``loading`` are written from inside
    // the effect; dependency-by-stable-primitive everywhere else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    status,
    targetSystem,
    exportProfileId,
    documentId,
    batchId,
    limit,
    retryToken,
  ]);

  const retry = useCallback(() => {
    setRetryToken((t) => t + 1);
  }, []);

  const loadMore = useCallback(() => {
    if (!enabled) return;
    if (loading || loadingMore) return;
    if (!canLoadMore) return;
    // Snapshot the offset BEFORE firing so an out-of-order
    // append can't double-fetch the same page.
    const offsetAtFire = items.length;
    loadMoreOffsetRef.current = offsetAtFire;

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const myRequestId = ++requestIdRef.current;

    setLoadingMore(true);
    setLoadMoreError(null);

    (async () => {
      try {
        const params = _buildListParams({
          status,
          targetSystem,
          exportProfileId,
          documentId,
          batchId,
          limit,
          offset: offsetAtFire,
        });
        const next = await exportRunsApi.list(params, {
          signal: controller.signal,
        });
        if (!aliveRef.current) return;
        if (myRequestId !== requestIdRef.current) return;
        const newItems = next.items ?? [];
        // Only append when the snapshot offset still matches the
        // current items length. Defensive — if a filter change
        // wiped the list mid-flight, we drop the response
        // silently (the request-id check above already covers
        // most of this; this is belt-and-suspenders).
        setItems((prev) => {
          if (prev.length !== offsetAtFire) return prev;
          return [...prev, ...newItems];
        });
        setCanLoadMore(newItems.length === limit && limit > 0);
        setLoadMoreError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (!aliveRef.current) return;
        if (myRequestId !== requestIdRef.current) return;
        setLoadMoreError(
          getApiErrorMessage(
            err,
            "Could not load more draft audit records.",
          ),
        );
        // Do NOT touch ``items`` — the existing rows must stay
        // visible when a load-more fails so the operator can
        // continue reading the table.
      } finally {
        if (aliveRef.current && myRequestId === requestIdRef.current) {
          setLoadingMore(false);
        }
      }
    })();
  }, [
    enabled,
    loading,
    loadingMore,
    canLoadMore,
    items.length,
    status,
    targetSystem,
    exportProfileId,
    documentId,
    batchId,
    limit,
  ]);

  const replaceItem = useCallback(
    (next: PersistedExportRunSummary) => {
      setItems((prev) => {
        const idx = prev.findIndex((row) => row.id === next.id);
        if (idx === -1) return prev;
        const out = prev.slice();
        out[idx] = next;
        return out;
      });
    },
    [],
  );

  return {
    items,
    loading,
    loadingMore,
    error,
    loadMoreError,
    canLoadMore,
    retry,
    loadMore,
    replaceItem,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface _BuildParamsArgs {
  status: PersistedExportRunStatus | null;
  targetSystem: string | null;
  exportProfileId: string | null;
  documentId: string | null;
  batchId: string | null;
  limit: number;
  offset: number;
}

/**
 * Build the Phase 5A list-endpoint params from the hook's
 * filter set. Phase / status filter shadow names mirror the
 * backend exactly. Phase 5C intentionally omits ``phase`` so the
 * FastAPI default (``"draft"``) applies — the audit list never
 * surfaces a non-draft phase today.
 */
function _buildListParams(
  args: _BuildParamsArgs,
): PersistedExportRunListParams {
  const params: PersistedExportRunListParams = {
    limit: args.limit,
    offset: args.offset,
  };
  if (args.status) params.status_ = args.status;
  if (args.targetSystem) params.target_system = args.targetSystem;
  if (args.exportProfileId) params.export_profile_id = args.exportProfileId;
  if (args.documentId) params.document_id = args.documentId;
  if (args.batchId) params.batch_id = args.batchId;
  return params;
}
