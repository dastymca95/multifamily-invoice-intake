"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getApiErrorMessage, invoiceTemplatesApi } from "@/lib/api";
import type {
  InvoiceTemplateCreate,
  InvoiceTemplateDefault,
  InvoiceTemplateOut,
  InvoiceTemplateSummary,
  InvoiceTemplateUpdate,
} from "@/types/invoice-template";

/**
 * Workspace state for the Invoice Template Builder.
 *
 * Models a "list rail + detail pane" pattern, mirroring `useImportConfigs`:
 *
 *   * `items`           — saved templates rail. Lightweight summaries.
 *   * `selectedDetail`  — the currently-open template's full row.
 *   * `selectedId`      — id of the selection, tracked separately so
 *                         the rail's highlight stays in place while
 *                         the detail is mid-load.
 *   * `defaultTemplate` — the canonical built-in template (fetched
 *                         once on mount). Used as a starter draft when
 *                         the user has no saved templates yet.
 *
 * Why the default lives in this hook (not a separate one): the UI
 * needs both "do I have any saved templates?" and "what's the default
 * shape?" together to render the empty-state-with-draft case cleanly.
 * Couples the two fetches but they're both small reads.
 */
export interface UseInvoiceTemplatesResult {
  items: InvoiceTemplateSummary[];
  loadingList: boolean;
  listError: string | null;

  /** Canonical built-in template, fetched once on mount. */
  defaultTemplate: InvoiceTemplateDefault | null;
  loadingDefault: boolean;

  selectedId: string | null;
  selectedDetail: InvoiceTemplateOut | null;
  loadingDetail: boolean;
  detailError: string | null;

  /** True while a create / update / delete is in flight. */
  saving: boolean;
  /** Error from the most recent mutation (cleared on the next attempt). */
  mutationError: string | null;

  refreshList: () => Promise<void>;
  select: (id: string | null) => void;
  create: (
    body: InvoiceTemplateCreate,
  ) => Promise<InvoiceTemplateOut | null>;
  update: (
    id: string,
    body: InvoiceTemplateUpdate,
  ) => Promise<InvoiceTemplateOut | null>;
  remove: (id: string) => Promise<boolean>;
}

export function useInvoiceTemplates(): UseInvoiceTemplatesResult {
  const [items, setItems] = useState<InvoiceTemplateSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [defaultTemplate, setDefaultTemplate] =
    useState<InvoiceTemplateDefault | null>(null);
  const [loadingDefault, setLoadingDefault] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] =
    useState<InvoiceTemplateOut | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Guard against late detail responses overwriting a more-recent
  // selection. Same pattern as `useImportConfigs`.
  const detailRequestRef = useRef<string | null>(null);

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const resp = await invoiceTemplatesApi.list();
      setItems(resp.items);
    } catch (err) {
      setListError(
        getApiErrorMessage(err, "Couldn't load saved templates."),
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

  // One-shot fetch of the canonical default template. Failures here are
  // soft — the user can still create new templates from scratch via
  // the modal even if this never lands.
  useEffect(() => {
    let cancelled = false;
    setLoadingDefault(true);
    invoiceTemplatesApi
      .getDefault()
      .then((d) => {
        if (!cancelled) setDefaultTemplate(d);
      })
      .catch(() => {
        if (!cancelled) setDefaultTemplate(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDefault(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-select the first saved template on first list-land. Avoids an
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
    invoiceTemplatesApi
      .get(selectedId)
      .then((resp) => {
        if (detailRequestRef.current !== selectedId) return;
        setSelectedDetail(resp);
      })
      .catch((err) => {
        if (detailRequestRef.current !== selectedId) return;
        setDetailError(getApiErrorMessage(err, "Couldn't load template."));
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
    detail: InvoiceTemplateOut,
  ): InvoiceTemplateSummary => ({
    id: detail.id,
    name: detail.name,
    description: detail.description,
    source: detail.source,
    column_count: detail.columns.length,
    // Mirror what the backend `_to_summary` does — count from the
    // detail so the rail badge reflects the just-saved truth without
    // a re-fetch.
    rule_count: detail.rules.length,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
  });

  const create = useCallback(
    async (
      body: InvoiceTemplateCreate,
    ): Promise<InvoiceTemplateOut | null> => {
      setSaving(true);
      setMutationError(null);
      try {
        const detail = await invoiceTemplatesApi.create(body);
        const summary = _summaryFromDetail(detail);
        // New rows go to the top — matches the backend's
        // `list_recent` ordering by updated_at desc.
        setItems((curr) => [
          summary,
          ...curr.filter((i) => i.id !== summary.id),
        ]);
        setSelectedId(detail.id);
        setSelectedDetail(detail);
        return detail;
      } catch (err) {
        setMutationError(
          getApiErrorMessage(err, "Couldn't create template."),
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
      body: InvoiceTemplateUpdate,
    ): Promise<InvoiceTemplateOut | null> => {
      setSaving(true);
      setMutationError(null);
      try {
        const detail = await invoiceTemplatesApi.update(id, body);
        const summary = _summaryFromDetail(detail);
        setItems((curr) => {
          // Move-to-top: most-recently-edited template sits up top.
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
        await invoiceTemplatesApi.remove(id);
        setItems((curr) => curr.filter((i) => i.id !== id));
        if (selectedId === id) {
          setSelectedId(null);
          setSelectedDetail(null);
        }
        return true;
      } catch (err) {
        setMutationError(
          getApiErrorMessage(err, "Couldn't delete template."),
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
    defaultTemplate,
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
