"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getApiErrorMessage, vendorCatalogsApi } from "@/lib/api";
import type {
  VendorCatalogCreate,
  VendorCatalogDefault,
  VendorCatalogOut,
  VendorCatalogSummary,
  VendorCatalogUpdate,
} from "@/types/vendor-catalog";

/**
 * Workspace state for the Vendors (vendor master data) builder.
 *
 * Sibling of `useGLCatalogs` and `usePropertyCatalogs` — same
 * data lifecycle (list rail + lazy detail + canonical default + auto-
 * select on first land + move-to-top after mutations) so the three
 * builder pages feel like one product.
 *
 * The default lives in this hook (rather than a separate one) for
 * the same reason it does for GL catalogs: the UI needs both
 * "do I have any saved catalogs?" and "what's the default shape?"
 * together to render the empty-state-with-draft case cleanly.
 */
export interface UseVendorCatalogsResult {
  items: VendorCatalogSummary[];
  loadingList: boolean;
  listError: string | null;

  /** Canonical built-in catalog, fetched once on mount. */
  defaultCatalog: VendorCatalogDefault | null;
  loadingDefault: boolean;

  selectedId: string | null;
  selectedDetail: VendorCatalogOut | null;
  loadingDetail: boolean;
  detailError: string | null;

  /** True while a create / update / delete is in flight. */
  saving: boolean;
  /** Error from the most recent mutation (cleared on the next attempt). */
  mutationError: string | null;

  refreshList: () => Promise<void>;
  select: (id: string | null) => void;
  create: (body: VendorCatalogCreate) => Promise<VendorCatalogOut | null>;
  update: (
    id: string,
    body: VendorCatalogUpdate,
  ) => Promise<VendorCatalogOut | null>;
  remove: (id: string) => Promise<boolean>;
}

export function useVendorCatalogs(): UseVendorCatalogsResult {
  const [items, setItems] = useState<VendorCatalogSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [defaultCatalog, setDefaultCatalog] =
    useState<VendorCatalogDefault | null>(null);
  const [loadingDefault, setLoadingDefault] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] =
    useState<VendorCatalogOut | null>(null);
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
      const resp = await vendorCatalogsApi.list();
      setItems(resp.items);
    } catch (err) {
      setListError(
        getApiErrorMessage(err, "Couldn't load saved vendor catalogs."),
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
    vendorCatalogsApi
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
    vendorCatalogsApi
      .get(selectedId)
      .then((resp) => {
        if (detailRequestRef.current !== selectedId) return;
        setSelectedDetail(resp);
      })
      .catch((err) => {
        if (detailRequestRef.current !== selectedId) return;
        setDetailError(
          getApiErrorMessage(err, "Couldn't load vendor catalog."),
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
    detail: VendorCatalogOut,
  ): VendorCatalogSummary => ({
    id: detail.id,
    name: detail.name,
    description: detail.description,
    source: detail.source,
    entry_count: detail.entries.length,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
  });

  const create = useCallback(
    async (body: VendorCatalogCreate): Promise<VendorCatalogOut | null> => {
      setSaving(true);
      setMutationError(null);
      try {
        const detail = await vendorCatalogsApi.create(body);
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
          getApiErrorMessage(err, "Couldn't create vendor catalog."),
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
      body: VendorCatalogUpdate,
    ): Promise<VendorCatalogOut | null> => {
      setSaving(true);
      setMutationError(null);
      try {
        const detail = await vendorCatalogsApi.update(id, body);
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
        await vendorCatalogsApi.remove(id);
        setItems((curr) => curr.filter((i) => i.id !== id));
        if (selectedId === id) {
          setSelectedId(null);
          setSelectedDetail(null);
        }
        return true;
      } catch (err) {
        setMutationError(
          getApiErrorMessage(err, "Couldn't delete vendor catalog."),
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
