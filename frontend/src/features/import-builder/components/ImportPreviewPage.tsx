"use client";

import { LayoutGrid, Loader2, RefreshCw, Table2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import type { ImportConfigCreate, ImportConfigUpdate } from "@/types/import-config";

import { useImportConfigs } from "../hooks/useImportConfigs";
import { ConfigDetailsPanel } from "./ConfigDetailsPanel";
import { ConfigList } from "./ConfigList";
import { NewConfigModal } from "./NewConfigModal";
import { PreviewSpreadsheet } from "./PreviewSpreadsheet";

/**
 * Import Preview workspace (relocated from `/import-builder`).
 *
 * Naming + relocation note: this used to live at `/import-builder` and
 * be called "Import Builder," but the product surface called the
 * "Import Builder" is now the evolved schema-design experience under
 * `/import-builder` (formerly Invoice Template Builder). This page
 * still renders config-driven spreadsheet previews of how invoices
 * would map into ResMan-shape rows — that's a *preview* concern, not
 * a *contract design* concern, so the new home is `/import-preview`.
 *
 * Three columns, top-down:
 *
 *   ┌──────────────┬─────────────────────────────────┬──────────────┐
 *   │ ConfigList   │ Center: spreadsheet preview     │ Details pane │
 *   │ (left rail)  │   - header (config name + meta) │ (right rail) │
 *   │              │   - PreviewSpreadsheet table    │              │
 *   │ + New        │                                 │ name + desc  │
 *   │ saved rows…  │                                 │ + row limit  │
 *   │              │                                 │ + pinned     │
 *   │              │                                 │   roles      │
 *   │              │                                 │ + contribs   │
 *   │              │                                 │ + notes      │
 *   │              │                                 │ Save / Del   │
 *   └──────────────┴─────────────────────────────────┴──────────────┘
 *
 * The center is the only column that always renders the same skeleton
 * (header + body), so the page doesn't reflow when the rail or the
 * detail pane change. Empty / loading / error states are swapped into
 * the body slot.
 */
export function ImportPreviewPage() {
  const {
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
  } = useImportConfigs();

  const [showNew, setShowNew] = useState(false);

  const handleCreate = async (body: ImportConfigCreate) => {
    const detail = await create(body);
    if (detail) setShowNew(false);
  };

  const handleSave = async (body: ImportConfigUpdate) => {
    if (!selectedId) return;
    await update(selectedId, body);
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    await remove(selectedId);
  };

  return (
    <div className="flex h-full min-h-0">
      {/* ---- Left rail ----------------------------------------------- */}
      <div className="w-[16rem] shrink-0">
        <ConfigList
          items={items}
          selectedId={selectedId}
          loading={loadingList}
          error={listError}
          onSelect={select}
          onNew={() => setShowNew(true)}
          onRetry={() => void refreshList()}
        />
      </div>

      {/* ---- Center: preview ----------------------------------------- */}
      <main className="flex-1 min-w-0 flex flex-col bg-gray-50">
        <CenterPane
          loading={loadingDetail}
          error={detailError}
          hasItems={items.length > 0}
          selectedDetail={selectedDetail}
          onNew={() => setShowNew(true)}
          onRetry={() => selectedId && select(selectedId)}
        />
      </main>

      {/* ---- Right rail (only when a config is open) ----------------- */}
      {selectedDetail && (
        <ConfigDetailsPanel
          detail={selectedDetail}
          saving={saving}
          mutationError={mutationError}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      )}

      <NewConfigModal
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
// Center pane — header + spreadsheet body, with empty / loading / error swaps
// ---------------------------------------------------------------------------

function CenterPane({
  loading,
  error,
  hasItems,
  selectedDetail,
  onNew,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  hasItems: boolean;
  selectedDetail: ReturnType<typeof useImportConfigs>["selectedDetail"];
  onNew: () => void;
  onRetry: () => void;
}) {
  // No configs at all → workspace-wide empty state.
  if (!hasItems && !selectedDetail && !loading && !error) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-brand-50 flex items-center justify-center mb-3">
            <LayoutGrid className="h-6 w-6 text-brand-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-800">
            Preview a ResMan import
          </h2>
          <p className="text-[12.5px] text-gray-600 mt-1.5">
            Save a configuration to capture how columns from your uploaded
            template should map to roles. Each saved config renders a live
            spreadsheet preview against your current uploads and approved
            invoices. The output schema itself is now designed in the
            top-level Import Builder.
          </p>
          <Button
            type="button"
            variant="primary"
            size="md"
            className="mt-4"
            onClick={onNew}
          >
            Create your first configuration
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Header strip */}
      <div className="border-b bg-white px-4 py-3 flex items-start gap-3 shrink-0">
        <div className="h-9 w-9 shrink-0 rounded-md bg-brand-50 flex items-center justify-center">
          <Table2 className="h-4 w-4 text-brand-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-sm font-semibold text-gray-800 truncate">
              {selectedDetail?.config.name ?? "Import preview"}
            </h1>
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-700 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              Preview
            </span>
            {selectedDetail && (
              <span className="text-[10.5px] text-gray-400">
                {selectedDetail.preview.rows.length} row
                {selectedDetail.preview.rows.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <p className="text-[11.5px] text-gray-500 mt-0.5 line-clamp-2">
            {selectedDetail?.config.description ||
              "Spreadsheet-shaped preview of the future ResMan-ready file. Columns come from your uploaded template; cells are populated from approved invoices and matched against your reference reports."}
          </p>
          {selectedDetail?.preview.template_filename && (
            <p className="text-[10.5px] text-gray-400 mt-0.5">
              Template:{" "}
              <span className="font-mono text-gray-600">
                {selectedDetail.preview.template_filename}
              </span>
            </p>
          )}
        </div>
        {selectedDetail && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRetry}
            title="Re-render preview"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {error ? (
          <InlineAlert
            tone="error"
            title="Couldn't load configuration"
            action={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onRetry}
              >
                Retry
              </Button>
            }
          >
            {error}
          </InlineAlert>
        ) : loading && !selectedDetail ? (
          <div className="space-y-1.5">
            <div className="h-7 bg-gray-100 rounded animate-pulse" />
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-6 bg-gray-50 rounded animate-pulse" />
            ))}
            <p className="text-[11px] text-gray-400 inline-flex items-center gap-1.5 pt-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Rendering preview…
            </p>
          </div>
        ) : selectedDetail ? (
          <PreviewSpreadsheet
            data={selectedDetail.preview}
            maxHeight="calc(100vh - 16rem)"
          />
        ) : null}
      </div>
    </div>
  );
}
