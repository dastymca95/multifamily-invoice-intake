"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getApiErrorMessage, propertyCatalogsApi } from "@/lib/api";
import type {
  PropertyCatalogCreate,
  PropertyCatalogDefault,
  PropertyCatalogOut,
  PropertyCatalogSummary,
  PropertyCatalogUpdate,
} from "@/types/property-catalog";

/**
 * Workspace state for the Properties (property/unit master) builder.
 *
 * Mirrors `useGLCatalogs` and `useInvoiceTemplates` so the three
 * builder pages share the same data lifecycle: list rail + lazy-
 * loaded detail + canonical default fetched once on mount + auto-
 * select on first list-land + move-to-top after mutations.
 *
 * The default lives in this hook (rather than a separate one) for
 * the same reason it does for invoice templates and GL catalogs:
 * the UI needs both "do I have any saved catalogs?" and "what's the
 * default shape?" together to render the empty-state-with-draft case
 * cleanly.
 */
export interface UsePropertyCatalogsResult {
  items: PropertyCatalogSummary[];
  loadingList: boolean;
  listError: string | null;

  /** Canonical built-in catalog, fetched once on mount. */
  defaultCatalog: PropertyCatalogDefault | null;
  loadingDefault: boolean;

  selectedId: string | null;
  selectedDetail: PropertyCatalogOut | null;
  loadingDetail: boolean;
  detailError: string | null;

  /** True while a create / update / delete is in flight. */
  saving: boolean;
  /** Error from the most recent mutation (cleared on the next attempt). */
  mutationError: string | null;

  refreshList: () => Promise<void>;
  select: (id: string | null) => void;
  create: (body: PropertyCatalogCreate) => Promise<PropertyCatalogOut | null>;
  update: (
    id: string,
    body: PropertyCatalogUpdate,
  ) => Promise<PropertyCatalogOut | null>;
  remove: (id: string) => Promise<boolean>;
}

export function usePropertyCatalogs(): UsePropertyCatalogsResult {
  const [items, setItems] = useState<PropertyCatalogSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [defaultCatalog, setDefaultCatalog] =
    useState<PropertyCatalogDefault | null>(null);
  const [loadingDefault, setLoadingDefault] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] =
    useState<PropertyCatalogOut | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Guard against late detail responses overwriting a more-recent
  // selection. Same pattern as `useGLCatalogs` / `useInvoiceTemplates`.
  const detailRequestRef = useRef<string | null>(null);

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const resp = await propertyCatalogsApi.list();
      setItems(resp.items);
    } catch (err) {
      setListError(
        getApiErrorMessage(err, "Couldn't load saved property catalogs."),
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
    propertyCatalogsApi
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
    propertyCatalogsApi
      .get(selectedId)
      .then((resp) => {
        if (detailRequestRef.current !== selectedId) return;
        setSelectedDetail(resp);
      })
      .catch((err) => {
        if (detailRequestRef.current !== selectedId) return;
        setDetailError(
          getApiErrorMessage(err, "Couldn't load property catalog."),
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

  const _summaryFromDetail = (
    detail: PropertyCatalogOut,
  ): PropertyCatalogSummary => ({
    id: detail.id,
    name: detail.name,
    description: detail.description,
    source: detail.source,
    entry_count: detail.entries.length,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
  });

  const create = useCallback(
    async (
      body: PropertyCatalogCreate,
    ): Promise<PropertyCatalogOut | null> => {
      setSaving(true);
      setMutationError(null);
      try {
        const detail = await propertyCatalogsApi.create(body);
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
          getApiErrorMessage(err, "Couldn't create property catalog."),
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
      body: PropertyCatalogUpdate,
    ): Promise<PropertyCatalogOut | null> => {
      setSaving(true);
      setMutationError(null);
      try {
        const detail = await propertyCatalogsApi.update(id, body);
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
        await propertyCatalogsApi.remove(id);
        setItems((curr) => curr.filter((i) => i.id !== id));
        if (selectedId === id) {
          setSelectedId(null);
          setSelectedDetail(null);
        }
        return true;
      } catch (err) {
        setMutationError(
          getApiErrorMessage(err, "Couldn't delete property catalog."),
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
