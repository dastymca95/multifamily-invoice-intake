"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getApiErrorMessage, importConfigsApi } from "@/lib/api";
import type {
  ImportConfigCreate,
  ImportConfigDetail,
  ImportConfigSummary,
  ImportConfigUpdate,
} from "@/types/import-config";

/**
 * Workspace state for the Import Builder.
 *
 * Models a "list rail + detail pane" pattern:
 *
 *   * `items`           — the saved-config rail. Lightweight summaries.
 *   * `selectedDetail`  — the currently-open config + its preview. Null
 *                         when nothing is selected (empty state) or
 *                         when the selection is mid-load.
 *   * `selectedId`      — id of the selection. Tracked separately from
 *                         `selectedDetail` so we can show the "loading
 *                         …" state on the right pane without losing
 *                         which row is highlighted in the rail.
 *
 * Why one hook (not separate `useImportConfigList` + `useImportConfig`):
 * the workspace's job is to keep the rail and the detail pane in sync
 * (e.g. a save needs to update both), and a shared state owner makes
 * that one-place rather than a parent threading callbacks both ways.
 */
export interface UseImportConfigsResult {
  items: ImportConfigSummary[];
  loadingList: boolean;
  listError: string | null;

  selectedId: string | null;
  selectedDetail: ImportConfigDetail | null;
  loadingDetail: boolean;
  detailError: string | null;

  /** True while a create / update / delete is in flight. */
  saving: boolean;
  /** Error from the most recent mutation (cleared on the next attempt). */
  mutationError: string | null;

  refreshList: () => Promise<void>;
  select: (id: string | null) => void;
  create: (body: ImportConfigCreate) => Promise<ImportConfigDetail | null>;
  update: (
    id: string,
    body: ImportConfigUpdate,
  ) => Promise<ImportConfigDetail | null>;
  remove: (id: string) => Promise<boolean>;
}

export function useImportConfigs(): UseImportConfigsResult {
  const [items, setItems] = useState<ImportConfigSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] =
    useState<ImportConfigDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Guard against late responses overwriting a more-recent selection.
  // Each detail fetch is tagged with the id we asked for; if the
  // selection has moved on by the time the response lands, drop it.
  const detailRequestRef = useRef<string | null>(null);

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const resp = await importConfigsApi.list();
      setItems(resp.items);
    } catch (err) {
      setListError(getApiErrorMessage(err, "Couldn't load saved configs."));
      setItems([]);
    } finally {
      setLoadingList(false);
    }
  }, []);

  // Initial list fetch.
  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Auto-select the first config once the list lands — gets the user
  // straight into the workspace without an extra click. No-op if the
  // list is empty (the page renders an explicit empty state then).
  useEffect(() => {
    if (selectedId == null && items.length > 0) {
      setSelectedId(items[0].id);
    }
  }, [items, selectedId]);

  // Whenever `selectedId` changes, fetch the detail (config + preview).
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
    importConfigsApi
      .get(selectedId)
      .then((resp) => {
        if (detailRequestRef.current !== selectedId) return;
        setSelectedDetail(resp);
      })
      .catch((err) => {
        if (detailRequestRef.current !== selectedId) return;
        setDetailError(getApiErrorMessage(err, "Couldn't load config."));
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
  // Each mutation handler does the round-trip, then folds the
  // freshly-returned detail into both the rail (summary) and the
  // detail pane so the UI reflects the new state without a second
  // GET. On failure we set `mutationError` and leave the prior state
  // intact.

  const _summaryFromDetail = (detail: ImportConfigDetail): ImportConfigSummary => ({
    id: detail.config.id,
    name: detail.config.name,
    description: detail.config.description,
    row_limit: detail.config.row_limit,
    override_count: Object.keys(detail.config.column_role_overrides ?? {}).length,
    created_at: detail.config.created_at,
    updated_at: detail.config.updated_at,
  });

  const create = useCallback(
    async (body: ImportConfigCreate): Promise<ImportConfigDetail | null> => {
      setSaving(true);
      setMutationError(null);
      try {
        const detail = await importConfigsApi.create(body);
        const summary = _summaryFromDetail(detail);
        // New rows go to the top — matches the backend's
        // `list_recent` ordering by updated_at desc.
        setItems((curr) => [summary, ...curr.filter((i) => i.id !== summary.id)]);
        setSelectedId(detail.config.id);
        setSelectedDetail(detail);
        return detail;
      } catch (err) {
        setMutationError(getApiErrorMessage(err, "Couldn't create config."));
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
      body: ImportConfigUpdate,
    ): Promise<ImportConfigDetail | null> => {
      setSaving(true);
      setMutationError(null);
      try {
        const detail = await importConfigsApi.update(id, body);
        const summary = _summaryFromDetail(detail);
        setItems((curr) => {
          // Move-to-top semantics: the most-recently-edited config
          // sits at the top of the rail, mirroring the backend's
          // `updated_at desc` ordering.
          const without = curr.filter((i) => i.id !== id);
          return [summary, ...without];
        });
        if (selectedId === id) {
          setSelectedDetail(detail);
        }
        return detail;
      } catch (err) {
        setMutationError(getApiErrorMessage(err, "Couldn't save changes."));
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
        await importConfigsApi.remove(id);
        setItems((curr) => curr.filter((i) => i.id !== id));
        if (selectedId === id) {
          // Clear selection — the auto-select effect will pick the
          // new first item if any remain.
          setSelectedId(null);
          setSelectedDetail(null);
        }
        return true;
      } catch (err) {
        setMutationError(getApiErrorMessage(err, "Couldn't delete config."));
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
