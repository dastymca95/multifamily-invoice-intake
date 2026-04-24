"use client";

import { FileSearch, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import type { InvoicePatternCreate } from "@/types/invoice-pattern";

import { useInvoicePatterns } from "../hooks/useInvoicePatterns";
import { NewPatternModal } from "./NewPatternModal";
import { PatternEditor } from "./PatternEditor";
import { PatternList } from "./PatternList";

/**
 * Invoice Builder workspace.
 *
 * Sibling product surface to Reference Data and Import Builder. Each
 * row in the left rail is a saved `InvoicePattern` — uploaded training
 * bills with bbox-on-page region annotations pinning canonical
 * extracted invoice fields to specific rectangles. The page wires the
 * `useInvoicePatterns` hook to three child components:
 *
 *   ┌──────────────┬───────────────────────────────┬─────────────────┐
 *   │ PatternList  │ PatternEditor                 │ RegionInspector │
 *   │ (left rail)  │   - header (name / hint /     │ (right rail —   │
 *   │              │     description)              │  embedded in    │
 *   │ + New        │   - file thumbnails + paging  │  PatternEditor) │
 *   │ saved rows…  │   - DocumentViewer canvas     │                 │
 *   │              │   - draw-target field picker  │                 │
 *   │              │   - save / delete             │                 │
 *   └──────────────┴───────────────────────────────┴─────────────────┘
 *
 * Difference from `ImportBuilderPage`: Invoice Builder has NO canonical
 * default pattern. A pattern's content is the operator's drawn regions
 * on the operator's uploaded bills — there's nothing to seed. So the
 * workspace skips the `viewingDraft` branch entirely and the empty
 * state goes straight to the "+ New pattern" affordance.
 *
 * The PatternEditor is keyed by `selectedDetail.id` so switching
 * patterns fully remounts the editor — that's the simplest way to keep
 * its in-flight form state, region selection, and active-file/page
 * indices from leaking across patterns.
 */
export function InvoiceBuilderPage() {
  const {
    items,
    loadingList,
    listError,
    canonicalFields,
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
  } = useInvoicePatterns();

  const [showNew, setShowNew] = useState(false);

  const handleCreate = useCallback(
    async (body: InvoicePatternCreate) => {
      const detail = await create(body);
      if (detail) setShowNew(false);
    },
    [create],
  );

  const handleSave = useCallback(
    async (
      id: string,
      body: Parameters<typeof update>[1],
    ): Promise<void> => {
      await update(id, body);
    },
    [update],
  );

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    await remove(selectedId);
  }, [remove, selectedId]);

  return (
    <div className="flex h-full min-h-0">
      {/* ---- Left rail ----------------------------------------------- */}
      <div className="w-[16rem] shrink-0">
        <PatternList
          items={items}
          selectedId={selectedId}
          loading={loadingList}
          error={listError}
          onSelect={select}
          onNew={() => setShowNew(true)}
          onRetry={() => void refreshList()}
        />
      </div>

      {/* ---- Center + right: editor (when a pattern is open) -------- */}
      <main className="flex-1 min-w-0 flex flex-col bg-gray-50">
        <CenterPane
          loadingList={loadingList}
          loadingDetail={loadingDetail}
          detailError={detailError}
          hasItems={items.length > 0}
          selectedId={selectedId}
          selectedDetail={selectedDetail}
          saving={saving}
          mutationError={mutationError}
          canonicalFields={canonicalFields}
          onNew={() => setShowNew(true)}
          onRetryDetail={() => selectedId && select(selectedId)}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      </main>

      <NewPatternModal
        open={showNew}
        saving={saving}
        error={mutationError}
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
  loadingList: boolean;
  loadingDetail: boolean;
  detailError: string | null;
  hasItems: boolean;
  selectedId: string | null;
  selectedDetail: ReturnType<typeof useInvoicePatterns>["selectedDetail"];
  saving: boolean;
  mutationError: string | null;
  canonicalFields: ReturnType<
    typeof useInvoicePatterns
  >["canonicalFields"];
  onNew: () => void;
  onRetryDetail: () => void;
  onSave: (
    id: string,
    body: Parameters<
      ReturnType<typeof useInvoicePatterns>["update"]
    >[1],
  ) => Promise<void>;
  onDelete: () => Promise<void>;
}

function CenterPane({
  loadingList,
  loadingDetail,
  detailError,
  hasItems,
  selectedId,
  selectedDetail,
  saving,
  mutationError,
  canonicalFields,
  onNew,
  onRetryDetail,
  onSave,
  onDelete,
}: CenterPaneProps) {
  // First load — no list yet, no selection. Skeleton-style spinner so
  // the pane doesn't briefly render the empty state and snap back.
  if (loadingList && !hasItems) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-8">
        <p className="text-xs text-gray-500 inline-flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading patterns…
        </p>
      </div>
    );
  }

  // List landed empty — onboarding. Big "+ New pattern" CTA.
  if (!hasItems && !loadingList) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-brand-50 flex items-center justify-center mb-3">
            <FileSearch className="h-6 w-6 text-brand-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-800">
            Teach the extractor where invoice fields live
          </h2>
          <p className="text-[12.5px] text-gray-600 mt-1.5">
            Each saved pattern captures one vendor's bill layout —
            upload a sample bill, draw a box around each canonical
            field, and save. Import Builder rule cells can then
            optionally narrow extraction to a specific pattern. With no
            rule cell set, extraction falls back to the broad universe
            of all saved patterns plus OCR + AI inference.
          </p>
          <Button
            type="button"
            variant="primary"
            size="md"
            className="mt-4"
            onClick={onNew}
          >
            Create your first pattern
          </Button>
        </div>
      </div>
    );
  }

  // Real-pattern mode — detail loaded. Editor takes over the whole
  // center+right area. Keyed by id so selection-change fully remounts.
  if (selectedId && selectedDetail) {
    return (
      <PatternEditor
        patternKey={selectedDetail.id}
        key={selectedDetail.id}
        initial={selectedDetail}
        saving={saving}
        mutationError={mutationError}
        canonicalFields={canonicalFields}
        onSave={onSave}
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
          title="Couldn't load pattern"
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
          <div className="h-7 bg-gray-100 rounded animate-pulse" />
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-6 bg-gray-50 rounded animate-pulse" />
          ))}
          <p className="text-[11px] text-gray-400 inline-flex items-center gap-1.5 pt-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading pattern…
          </p>
        </div>
      ) : (
        // Saved patterns exist but nothing's selected — nudge the
        // operator. (The hook auto-selects the first row on first
        // land, so this branch only shows up after an explicit
        // deselect or a delete that emptied the rail.)
        <div className="m-auto max-w-sm text-center">
          <div className="mx-auto h-10 w-10 rounded-full bg-gray-100 flex items-center justify-center mb-2">
            <FileSearch className="h-5 w-5 text-gray-500" />
          </div>
          <p className="text-sm font-medium text-gray-700">
            Pick a pattern
          </p>
          <p className="text-[11.5px] text-gray-500 mt-1">
            Choose one from the rail to edit it, or create a new one.
          </p>
        </div>
      )}
    </div>
  );
}
