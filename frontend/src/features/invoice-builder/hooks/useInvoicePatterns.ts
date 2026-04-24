"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getApiErrorMessage, invoicePatternsApi } from "@/lib/api";
import type {
  InvoiceExtractedFieldDescriptor,
  InvoicePatternCreate,
  InvoicePatternFieldOption,
  InvoicePatternOut,
  InvoicePatternSummary,
  InvoicePatternUpdate,
} from "@/types/invoice-pattern";

/**
 * Workspace state for the Invoice Builder.
 *
 * Same "list rail + detail pane" rhythm as `useInvoiceTemplates` and
 * `useImportConfigs`:
 *
 *   * `items`           — saved patterns rail (lightweight summaries).
 *   * `selectedDetail`  — full row for the open pattern, including
 *                         source files (with inline data URLs) and
 *                         regions.
 *   * `selectedId`      — id of the selection, tracked separately so
 *                         the rail's highlight stays in place while
 *                         the detail is mid-load.
 *   * `canonicalFields` — descriptors for the canonical extracted-
 *                         field universe (key + human label). Fetched
 *                         once on mount; the editor binds region
 *                         pickers to this list so labels stay
 *                         backend-authoritative.
 *
 * Why canonical fields live in this hook (not their own): they're
 * needed alongside every pattern detail render (the region inspector
 * needs the label list) AND the "what's a fresh pattern's available
 * field set?" question is answered identically in every part of the
 * workspace. Fetching them here once avoids a parallel cache layer.
 */
export interface UseInvoicePatternsResult {
  items: InvoicePatternSummary[];
  loadingList: boolean;
  listError: string | null;

  /** Canonical extracted-field descriptors, fetched once on mount. */
  canonicalFields: InvoiceExtractedFieldDescriptor[];
  loadingCanonicalFields: boolean;

  selectedId: string | null;
  selectedDetail: InvoicePatternOut | null;
  loadingDetail: boolean;
  detailError: string | null;

  /** True while a create / update / delete is in flight. */
  saving: boolean;
  /** Error from the most recent mutation (cleared on the next attempt). */
  mutationError: string | null;

  refreshList: () => Promise<void>;
  select: (id: string | null) => void;
  create: (
    body: InvoicePatternCreate,
  ) => Promise<InvoicePatternOut | null>;
  update: (
    id: string,
    body: InvoicePatternUpdate,
  ) => Promise<InvoicePatternOut | null>;
  remove: (id: string) => Promise<boolean>;
}

export function useInvoicePatterns(): UseInvoicePatternsResult {
  const [items, setItems] = useState<InvoicePatternSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [canonicalFields, setCanonicalFields] = useState<
    InvoiceExtractedFieldDescriptor[]
  >([]);
  const [loadingCanonicalFields, setLoadingCanonicalFields] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] =
    useState<InvoicePatternOut | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Guard against late detail responses overwriting a more-recent
  // selection. Same pattern as `useInvoiceTemplates`.
  const detailRequestRef = useRef<string | null>(null);

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const resp = await invoicePatternsApi.list();
      setItems(resp.items);
    } catch (err) {
      setListError(
        getApiErrorMessage(err, "Couldn't load saved patterns."),
      );
      setItems([]);
    } finally {
      setLoadingList(false);
    }
  }, []);

  // Initial list fetch.
  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // One-shot canonical-fields fetch. Failure here is soft — the editor
  // falls back to the built-in `INVOICE_EXTRACTED_FIELD_LABEL` mirror
  // so picker labels still render even if the API is unreachable.
  useEffect(() => {
    let cancelled = false;
    setLoadingCanonicalFields(true);
    invoicePatternsApi
      .getCanonicalFields()
      .then((resp) => {
        if (!cancelled) setCanonicalFields(resp.fields);
      })
      .catch(() => {
        if (!cancelled) setCanonicalFields([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCanonicalFields(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-select the first saved pattern on first list-land. Avoids an
  // extra click for returning users.
  useEffect(() => {
    if (selectedId == null && items.length > 0) {
      setSelectedId(items[0].id);
    }
  }, [items, selectedId]);

  // Whenever selection changes, fetch the full detail.
  useEffect(() => {
    if (selectedId == null) {
      setSelectedDetail(null);
      setDetailError(null);
      setLoadingDetail(false);
      detailRequestRef.current = null;
      return;
    }
    detailRequestRef.current = selectedId;
    setLoadingDetail(true);
    setDetailError(null);
    invoicePatternsApi
      .get(selectedId)
      .then((resp) => {
        if (detailRequestRef.current !== selectedId) return;
        setSelectedDetail(resp);
      })
      .catch((err) => {
        if (detailRequestRef.current !== selectedId) return;
        setDetailError(getApiErrorMessage(err, "Couldn't load pattern."));
        setSelectedDetail(null);
      })
      .finally(() => {
        if (detailRequestRef.current !== selectedId) return;
        setLoadingDetail(false);
      });
  }, [selectedId]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

  // ---- Mutations -------------------------------------------------------

  const _summaryFromDetail = (
    detail: InvoicePatternOut,
  ): InvoicePatternSummary => ({
    id: detail.id,
    name: detail.name,
    description: detail.description,
    vendor_hint: detail.vendor_hint,
    source_file_count: detail.source_files.length,
    region_count: detail.regions.length,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
  });

  const create = useCallback(
    async (
      body: InvoicePatternCreate,
    ): Promise<InvoicePatternOut | null> => {
      setSaving(true);
      setMutationError(null);
      try {
        const detail = await invoicePatternsApi.create(body);
        const summary = _summaryFromDetail(detail);
        setItems((curr) => [
          summary,
          ...curr.filter((i) => i.id !== summary.id),
        ]);
        setSelectedId(detail.id);
        setSelectedDetail(detail);
        return detail;
      } catch (err) {
        setMutationError(
          getApiErrorMessage(err, "Couldn't create pattern."),
        );
        return null;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const update = useCallback(
    async (
      id: string,
      body: InvoicePatternUpdate,
    ): Promise<InvoicePatternOut | null> => {
      setSaving(true);
      setMutationError(null);
      try {
        const detail = await invoicePatternsApi.update(id, body);
        const summary = _summaryFromDetail(detail);
        setItems((curr) => {
          const without = curr.filter((i) => i.id !== id);
          return [summary, ...without];
        });
        if (selectedId === id) {
          setSelectedDetail(detail);
        }
        return detail;
      } catch (err) {
        setMutationError(
          getApiErrorMessage(err, "Couldn't save changes."),
        );
        return null;
      } finally {
        setSaving(false);
      }
    },
    [selectedId],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      setSaving(true);
      setMutationError(null);
      try {
        await invoicePatternsApi.remove(id);
        setItems((curr) => curr.filter((i) => i.id !== id));
        if (selectedId === id) {
          setSelectedId(null);
          setSelectedDetail(null);
        }
        return true;
      } catch (err) {
        setMutationError(
          getApiErrorMessage(err, "Couldn't delete pattern."),
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [selectedId],
  );

  return {
    items,
    loadingList,
    listError,
    canonicalFields,
    loadingCanonicalFields,
    selectedId,
    selectedDetail,
    loadingDetail,
    detailError,
    saving,
    mutationError,
    refreshList,
    select,
    create,
    update,
    remove,
  };
}

/**
 * Lighter-weight hook for surfaces that only need the list of saved
 * pattern summaries (e.g. the Import Builder rule editor's
 * extraction picker). Doesn't touch detail / mutation state — keeps
 * the picker render path cheap.
 */
export interface UseInvoicePatternSummariesResult {
  items: InvoicePatternSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useInvoicePatternSummaries(): UseInvoicePatternSummariesResult {
  const [items, setItems] = useState<InvoicePatternSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await invoicePatternsApi.list();
      setItems(resp.items);
    } catch (err) {
      setError(getApiErrorMessage(err, "Couldn't load saved patterns."));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { items, loading, error, refresh };
}

/**
 * Per-pattern field-option index for the Import Builder extraction
 * picker. Multiple rule cells can fan out to multiple patterns; a
 * single rule cell can carry multiple bindings; both can fan out to
 * the SAME pattern. Naively each binding row would refetch the same
 * pattern's fields — this hook dedupes via an internal cache keyed by
 * `pattern_id` so the editor pays at most one HTTP round-trip per
 * pattern, regardless of how many bindings reference it.
 *
 * Cache contract:
 *   * `ensure(id)`     — kick a fetch (or no-op if already cached /
 *                        in-flight). Awaitable.
 *   * `get(id)`        — synchronous read. Returns one of:
 *                          - `{ status: "loading" }` — fetch is in
 *                                                       flight
 *                          - `{ status: "ready", items }` — resolved
 *                          - `{ status: "error", error }` — failed
 *                          - `null` — never fetched
 *   * `invalidate(id)` — drop the cached entry so the next `ensure`
 *                        refetches. Used after a pattern edit lands.
 *
 * The hook DOES NOT auto-fetch any id on mount — the consumer is
 * expected to call `ensure` for every bound pattern_id it cares about
 * (typically inside an effect that watches the binding list).
 *
 * Why a custom hook with a Map state instead of pulling react-query:
 * the rest of the codebase uses plain useState/useEffect for similar
 * lazy-cache flows (see `useCatalogIndex`); keeping the same shape
 * keeps the editor's mental model uniform.
 */
export type PatternFieldsCacheEntry =
  | { status: "loading" }
  | { status: "ready"; items: InvoicePatternFieldOption[] }
  | { status: "error"; error: string };

export interface UseInvoicePatternFieldOptionsCacheResult {
  get: (patternId: string) => PatternFieldsCacheEntry | null;
  ensure: (patternId: string) => Promise<void>;
  invalidate: (patternId: string) => void;
}

export function useInvoicePatternFieldOptionsCache(): UseInvoicePatternFieldOptionsCacheResult {
  const [cache, setCache] = useState<Record<string, PatternFieldsCacheEntry>>(
    {},
  );
  // Mirror the cache in a ref so `ensure` can read the freshest state
  // without needing to re-create itself when the cache changes — a
  // closure over `cache` would dedupe stale.
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  // Track in-flight promises by id so concurrent `ensure` calls share
  // a single fetch. The cache state alone can't dedupe — by the time
  // React commits the "loading" entry, a second caller may have
  // already started its own request.
  const inflightRef = useRef<Map<string, Promise<void>>>(new Map());

  const ensure = useCallback(async (patternId: string) => {
    if (!patternId) return;
    const existing = cacheRef.current[patternId];
    if (existing?.status === "ready" || existing?.status === "loading") return;
    const inflight = inflightRef.current.get(patternId);
    if (inflight) return inflight;
    setCache((prev) => ({ ...prev, [patternId]: { status: "loading" } }));
    const promise = (async () => {
      try {
        const resp = await invoicePatternsApi.getFields(patternId);
        setCache((prev) => ({
          ...prev,
          [patternId]: { status: "ready", items: resp.items },
        }));
      } catch (err) {
        setCache((prev) => ({
          ...prev,
          [patternId]: {
            status: "error",
            error: getApiErrorMessage(
              err,
              "Couldn't load this pattern's fields.",
            ),
          },
        }));
      } finally {
        inflightRef.current.delete(patternId);
      }
    })();
    inflightRef.current.set(patternId, promise);
    return promise;
  }, []);

  const get = useCallback(
    (patternId: string): PatternFieldsCacheEntry | null => {
      if (!patternId) return null;
      return cache[patternId] ?? null;
    },
    [cache],
  );

  const invalidate = useCallback((patternId: string) => {
    setCache((prev) => {
      if (!(patternId in prev)) return prev;
      const next = { ...prev };
      delete next[patternId];
      return next;
    });
  }, []);

  return { get, ensure, invalidate };
}
