"use client";

import { BookOpen, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import type {
  GLCatalogCreate,
  GLCatalogEntry,
} from "@/types/gl-catalog";

import { useGLCatalogs } from "../hooks/useGLCatalogs";
import { GLCatalogEditor } from "./GLCatalogEditor";
import { GLCatalogList } from "./GLCatalogList";
import { NewGLCatalogModal } from "./NewGLCatalogModal";

/**
 * GL Codes builder workspace.
 *
 * Two columns, mirroring the Invoice Template Builder:
 *
 *   ┌──────────────┬─────────────────────────────────────┐
 *   │ GLCatalogList│ GLCatalogEditor                     │
 *   │ (left rail)  │   - toolbar (name, source, save)    │
 *   │              │   - description                     │
 *   │ + New        │   - search + add row                │
 *   │ saved rows…  │   - editable rows (code/desc/cat/   │
 *   │              │      active/notes)                  │
 *   │              │   - delete                          │
 *   └──────────────┴─────────────────────────────────────┘
 *
 * The page owns one piece of state on top of the hooks: `viewingDraft`,
 * which lets the user flip between "the canonical-default starter
 * draft" and a real saved catalog even when the list isn't empty.
 *
 * The "From uploaded chart" start mode in the New Catalog modal calls
 * the GL parse-upload endpoint directly inside the modal — there's no
 * persistent reference-data slot for chart-of-accounts files (by
 * design: GL uploads are one-shot, the file isn't stored). So this
 * page passes nothing upload-related to the modal beyond the standard
 * create/cancel callbacks.
 */
export function GLCodesPage() {
  const {
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
  } = useGLCatalogs();

  const [viewingDraft, setViewingDraft] = useState(false);
  const [showNew, setShowNew] = useState(false);

  // When the list lands empty AND we have a default to show, switch
  // into draft mode automatically. The other branch (list arrives
  // populated) is handled by the hook's auto-select.
  useEffect(() => {
    if (!loadingList && !loadingDefault) {
      if (items.length === 0 && defaultCatalog) {
        setViewingDraft(true);
      }
    }
  }, [loadingList, loadingDefault, items.length, defaultCatalog]);

  const handleSelectSaved = useCallback(
    (id: string) => {
      setViewingDraft(false);
      select(id);
    },
    [select],
  );

  const handleSelectDraft = useCallback(() => {
    setViewingDraft(true);
  }, []);

  const handleCreate = useCallback(
    async (body: GLCatalogCreate) => {
      const detail = await create(body);
      if (detail) {
        setShowNew(false);
        setViewingDraft(false);
      }
    },
    [create],
  );

  const handleSaveDraft = useCallback(
    async (body: {
      name: string;
      description: string | null;
      entries: GLCatalogEntry[];
    }) => {
      const detail = await create({
        name: body.name,
        description: body.description,
        entries: body.entries,
        source: "default",
      });
      if (detail) {
        setViewingDraft(false);
      }
    },
    [create],
  );

  const handleSaveExisting = useCallback(
    async (body: {
      name: string;
      description: string | null;
      entries: GLCatalogEntry[];
    }) => {
      if (!selectedId) return;
      await update(selectedId, body);
    },
    [selectedId, update],
  );

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    const ok = await remove(selectedId);
    if (ok) {
      // If that was the last catalog and we have a default, fall back
      // to the draft view so the workspace doesn't go blank.
      if (defaultCatalog) setViewingDraft(true);
    }
  }, [defaultCatalog, remove, selectedId]);

  return (
    <div className="flex h-full min-h-0">
      {/* ---- Left rail ----------------------------------------------- */}
      <div className="w-[16rem] shrink-0">
        <GLCatalogList
          items={items}
          selectedId={selectedId}
          viewingDraft={viewingDraft}
          hasDraft={defaultCatalog != null}
          loading={loadingList}
          error={listError}
          onSelect={handleSelectSaved}
          onSelectDraft={handleSelectDraft}
          onNew={() => setShowNew(true)}
          onRetry={() => void refreshList()}
        />
      </div>

      {/* ---- Center: editor ------------------------------------------ */}
      <main className="flex-1 min-w-0 flex flex-col bg-gray-50 dark:bg-surface">
        <CenterPane
          viewingDraft={viewingDraft}
          loadingList={loadingList}
          loadingDefault={loadingDefault}
          loadingDetail={loadingDetail}
          detailError={detailError}
          hasItems={items.length > 0}
          hasDraft={defaultCatalog != null}
          selectedId={selectedId}
          selectedDetail={selectedDetail}
          defaultCatalog={defaultCatalog}
          saving={saving}
          mutationError={mutationError}
          onNew={() => setShowNew(true)}
          onSelectDraft={handleSelectDraft}
          onRetryDetail={() => selectedId && select(selectedId)}
          onSaveDraft={handleSaveDraft}
          onSaveExisting={handleSaveExisting}
          onDelete={handleDelete}
        />
      </main>

      <NewGLCatalogModal
        open={showNew}
        saving={saving}
        error={mutationError}
        defaultCatalog={defaultCatalog}
        onClose={() => setShowNew(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Center pane — picks the right view based on workspace state
// ---------------------------------------------------------------------------

interface CenterPaneProps {
  viewingDraft: boolean;
  loadingList: boolean;
  loadingDefault: boolean;
  loadingDetail: boolean;
  detailError: string | null;
  hasItems: boolean;
  hasDraft: boolean;
  selectedId: string | null;
  selectedDetail: ReturnType<typeof useGLCatalogs>["selectedDetail"];
  defaultCatalog: ReturnType<typeof useGLCatalogs>["defaultCatalog"];
  saving: boolean;
  mutationError: string | null;
  onNew: () => void;
  onSelectDraft: () => void;
  onRetryDetail: () => void;
  onSaveDraft: (body: {
    name: string;
    description: string | null;
    entries: GLCatalogEntry[];
  }) => Promise<void>;
  onSaveExisting: (body: {
    name: string;
    description: string | null;
    entries: GLCatalogEntry[];
  }) => Promise<void>;
  onDelete: () => Promise<void>;
}

function CenterPane({
  viewingDraft,
  loadingList,
  loadingDefault,
  loadingDetail,
  detailError,
  hasItems,
  hasDraft,
  selectedId,
  selectedDetail,
  defaultCatalog,
  saving,
  mutationError,
  onNew,
  onSelectDraft,
  onRetryDetail,
  onSaveDraft,
  onSaveExisting,
  onDelete,
}: CenterPaneProps) {
  // Both lookups still in flight → spinner. Avoids a brief "no
  // catalogs" flash on first load.
  if (loadingList && loadingDefault && !hasItems && !hasDraft) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-8">
        <p className="text-xs text-gray-500 dark:text-ink-subtle inline-flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading GL catalogs…
        </p>
      </div>
    );
  }

  // Nothing saved AND default fetch failed → only path forward is "+ New".
  if (!hasItems && !hasDraft && !loadingList && !loadingDefault) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-brand-50 dark:bg-brand-900/40 flex items-center justify-center mb-3">
            <BookOpen className="h-6 w-6 text-brand-600 dark:text-brand-50" />
          </div>
          <h2 className="text-base font-semibold text-gray-800 dark:text-ink">
            Build your first GL catalog
          </h2>
          <p className="text-[12.5px] text-gray-600 dark:text-ink-muted mt-1.5">
            A catalog captures the chart of accounts every future
            invoice line item should validate against. Start blank, or
            upload your existing chart.
          </p>
          <Button
            type="button"
            variant="primary"
            size="md"
            className="mt-4"
            onClick={onNew}
          >
            Create your first catalog
          </Button>
        </div>
      </div>
    );
  }

  // Draft mode — render the canonical default as a draft the user can
  // edit and save.
  if (viewingDraft && defaultCatalog) {
    return (
      <GLCatalogEditor
        catalogKey="draft"
        isDraft
        initial={{
          name: defaultCatalog.name,
          description: defaultCatalog.description,
          entries: defaultCatalog.entries,
          source: "default",
        }}
        saving={saving}
        mutationError={mutationError}
        onSave={onSaveDraft}
      />
    );
  }

  // Real-catalog mode.
  if (selectedId && selectedDetail) {
    return (
      <GLCatalogEditor
        catalogKey={selectedDetail.id}
        isDraft={false}
        initial={{
          name: selectedDetail.name,
          description: selectedDetail.description,
          entries: selectedDetail.entries,
          source: selectedDetail.source,
        }}
        saving={saving}
        mutationError={mutationError}
        onSave={onSaveExisting}
        onDelete={onDelete}
      />
    );
  }

  // Detail in flight or errored.
  return (
    <div className="flex-1 min-h-0 flex flex-col p-4">
      {detailError ? (
        <InlineAlert
          tone="error"
          title="Couldn't load catalog"
          action={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onRetryDetail}
            >
              Retry
            </Button>
          }
        >
          {detailError}
        </InlineAlert>
      ) : loadingDetail ? (
        <div className="space-y-1.5">
          <div className="h-7 bg-gray-100 dark:bg-surface-muted rounded animate-pulse" />
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-6 bg-gray-50 dark:bg-surface-muted/60 rounded animate-pulse"
            />
          ))}
          <p className="text-[11px] text-gray-400 dark:text-ink-subtle inline-flex items-center gap-1.5 pt-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading catalog…
          </p>
        </div>
      ) : (
        // Saved catalogs exist but nothing's selected — nudge.
        <div className="m-auto max-w-sm text-center">
          <div className="mx-auto h-10 w-10 rounded-full bg-gray-100 dark:bg-surface-muted flex items-center justify-center mb-2">
            <BookOpen className="h-5 w-5 text-gray-500 dark:text-ink-subtle" />
          </div>
          <p className="text-sm font-medium text-gray-700 dark:text-ink">
            Pick a catalog
          </p>
          <p className="text-[11.5px] text-gray-500 dark:text-ink-muted mt-1">
            Choose one from the rail to edit it,
            {hasDraft ? (
              <>
                {" or "}
                <button
                  type="button"
                  className="text-brand-700 underline dark:text-brand-50"
                  onClick={onSelectDraft}
                >
                  edit the default draft
                </button>
                .
              </>
            ) : (
              " or create a new one."
            )}
          </p>
        </div>
      )}
    </div>
  );
}
