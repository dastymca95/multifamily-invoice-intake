"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getApiErrorMessage, glCatalogsApi } from "@/lib/api";
import type {
  GLCatalogCreate,
  GLCatalogDefault,
  GLCatalogOut,
  GLCatalogSummary,
  GLCatalogUpdate,
} from "@/types/gl-catalog";

/**
 * Workspace state for the GL Codes (chart of accounts) builder.
 *
 * Mirrors `useInvoiceTemplates` so the two builder pages share the
 * same data lifecycle: list rail + lazy-loaded detail + canonical
 * default fetched once on mount + auto-select on first list-land +
 * move-to-top after mutations.
 *
 * The default lives in this hook (rather than a separate one) for
 * the same reason it does for invoice templates: the UI needs both
 * "do I have any saved catalogs?" and "what's the default shape?"
 * together to render the empty-state-with-draft case cleanly.
 */
export interface UseGLCatalogsResult {
  items: GLCatalogSummary[];
  loadingList: boolean;
  listError: string | null;

  /** Canonical built-in catalog, fetched once on mount. */
  defaultCatalog: GLCatalogDefault | null;
  loadingDefault: boolean;

  selectedId: string | null;
  selectedDetail: GLCatalogOut | null;
  loadingDetail: boolean;
  detailError: string | null;

  /** True while a create / update / delete is in flight. */
  saving: boolean;
  /** Error from the most recent mutation (cleared on the next attempt). */
  mutationError: string | null;

  refreshList: () => Promise<void>;
  select: (id: string | null) => void;
  create: (body: GLCatalogCreate) => Promise<GLCatalogOut | null>;
  update: (
    id: string,
    body: GLCatalogUpdate,
  ) => Promise<GLCatalogOut | null>;
  remove: (id: string) => Promise<boolean>;
}

export function useGLCatalogs(): UseGLCatalogsResult {
  const [items, setItems] = useState<GLCatalogSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [defaultCatalog, setDefaultCatalog] =
    useState<GLCatalogDefault | null>(null);
  const [loadingDefault, setLoadingDefault] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] =
    useState<GLCatalogOut | null>(null);
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
      const resp = await glCatalogsApi.list();
      setItems(resp.items);
    } catch (err) {
      setListError(
        getApiErrorMessage(err, "Couldn't load saved GL catalogs."),
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

  // One-shot fetch of the canonical default catalog. Failures here are
  // soft — the user can still create new catalogs from scratch via the
  // modal even if this never lands.
  useEffect(() => {
    let cancelled = false;
    setLoadingDefault(true);
    glCatalogsApi
      .getDefault()
      .then((d) => {
        if (!cancelled) setDefaultCatalog(d);
      })
      .catch(() => {
        if (!cancelled) setDefaultCatalog(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDefault(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-select the first saved catalog on first list-land. Avoids an
  // extra click for returning users. No-op when the list is empty (the
  // page renders the default-draft state then).
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
    glCatalogsApi
      .get(selectedId)
      .then((resp) => {
        if (detailRequestRef.current !== selectedId) return;
        setSelectedDetail(resp);
      })
      .catch((err) => {
        if (detailRequestRef.current !== selectedId) return;
        setDetailError(
          getApiErrorMessage(err, "Couldn't load GL catalog."),
        );
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

  const _summaryFromDetail = (detail: GLCatalogOut): GLCatalogSummary => ({
    id: detail.id,
    name: detail.name,
    description: detail.description,
    source: detail.source,
    entry_count: detail.entries.length,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
  });

  const create = useCallback(
    async (body: GLCatalogCreate): Promise<GLCatalogOut | null> => {
      setSaving(true);
      setMutationError(null);
      try {
        const detail = await glCatalogsApi.create(body);
        const summary = _summaryFromDetail(detail);
        // New rows go to the top — matches the backend's `list_recent`
        // ordering by updated_at desc.
        setItems((curr) => [
          summary,
          ...curr.filter((i) => i.id !== summary.id),
        ]);
        setSelectedId(detail.id);
        setSelectedDetail(detail);
        return detail;
      } catch (err) {
        setMutationError(
          getApiErrorMessage(err, "Couldn't create GL catalog."),
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
      body: GLCatalogUpdate,
    ): Promise<GLCatalogOut | null> => {
      setSaving(true);
      setMutationError(null);
      try {
        const detail = await glCatalogsApi.update(id, body);
        const summary = _summaryFromDetail(detail);
        setItems((curr) => {
          // Move-to-top: most-recently-edited catalog sits up top.
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
        await glCatalogsApi.remove(id);
        setItems((curr) => curr.filter((i) => i.id !== id));
        if (selectedId === id) {
          setSelectedId(null);
          setSelectedDetail(null);
        }
        return true;
      } catch (err) {
        setMutationError(
          getApiErrorMessage(err, "Couldn't delete GL catalog."),
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
    defaultCatalog,
    loadingDefault,
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
