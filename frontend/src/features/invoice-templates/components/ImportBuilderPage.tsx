"use client";

import { FileSpreadsheet, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import {
  getSlotState,
  useReferenceData,
} from "@/features/reference/hooks/useReferenceData";
import type {
  InvoiceTemplateColumn,
  InvoiceTemplateCreate,
  InvoiceTemplateRule,
} from "@/types/invoice-template";

import { useCatalogIndex } from "../hooks/useCatalogIndex";
import { useInvoiceTemplates } from "../hooks/useInvoiceTemplates";
import {
  NewTemplateModal,
  type UploadedTemplateSource,
} from "./NewTemplateModal";
import { TemplateEditor } from "./TemplateEditor";
import { TemplateList } from "./TemplateList";

/**
 * Import Builder workspace.
 *
 * Naming note: this page used to be called "Invoice Template Builder"
 * and lived under `/reference-data/invoice-template`. It's now the
 * top-level Import Builder at `/import-builder` — the place where the
 * final import/output schema is designed: which columns exist, which
 * are required, where each value should come from, and what shape it
 * must take. The underlying entity is still an `InvoiceTemplate` at
 * the storage layer (the table and endpoints keep their stable names),
 * but the product surface evolved.
 *
 * Layout:
 *
 *   ┌──────────────┬───────────────────────────────┬─────────────────┐
 *   │ TemplateList │ TemplateEditor                │ ColumnInspector │
 *   │ (left rail)  │   - header (name + desc)      │ (right rail —   │
 *   │              │   - spreadsheet-first table   │  appears when a │
 *   │ + New        │   - per-column header chips   │  column is      │
 *   │ saved rows…  │   - drag/drop reorder         │  selected)      │
 *   │              │   - save / discard / delete   │   - required    │
 *   │              │                               │   - source kind │
 *   │              │                               │   - source ref  │
 *   │              │                               │   - manual list │
 *   │              │                               │   - validation  │
 *   └──────────────┴───────────────────────────────┴─────────────────┘
 *
 * The page owns one piece of state on top of the hooks: `viewingDraft`,
 * which lets the user flip between "the canonical-default starter
 * draft" and a real saved template even when the list isn't empty.
 * Column selection and the inspector live INSIDE `TemplateEditor`
 * (the editor is the column's owner; lifting selection here would
 * force extra prop-drilling for per-column mutations).
 *
 * The "From uploaded ResMan template" start mode in the New Template
 * modal funnels its file upload through `useReferenceData.upload` so
 * the persistent `import_template` slot also gets refreshed. The modal
 * itself is session-local — it only knows about a file the user
 * uploaded inside that open of the dialog and never reads back the
 * persistent slot — so this page just hands it the upload action and
 * the per-kind UI state (progress / error). The mapping from the
 * returned `ReferenceFile` to the modal's `UploadedTemplateSource`
 * happens here so the modal stays decoupled from reference-data
 * internals.
 */
export function ImportBuilderPage() {
  const {
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
  } = useInvoiceTemplates();

  // The modal owns the "From uploaded ResMan template" flow end-to-end:
  // when the user picks a file inside the modal, we forward it through
  // `useReferenceData.upload`, which both refreshes the persistent
  // import_template slot AND returns the freshly-parsed file. The modal
  // builds its own session-local snapshot from that return value and
  // never reads from the persistent slot — so a file uploaded in a
  // previous session can't silently attach itself to a brand-new
  // template draft. We still surface per-kind upload progress / error
  // so the modal can render the in-flight state with no extra
  // bookkeeping.
  const { slotStates: refSlotStates, upload: uploadReference } =
    useReferenceData();

  // One-shot fetch of all three catalog summary lists. Threaded down to
  // the editor + inspector so catalog-backed source bindings can pick a
  // specific saved catalog (BillsIQ supports multiple per kind, so the
  // source TYPE alone is ambiguous). Hoisted here (not in the inspector)
  // so column-switching doesn't refetch on every mount.
  const catalogIndex = useCatalogIndex();

  const importTemplateUiState = getSlotState(refSlotStates, "import_template");

  const handleUploadTemplate = useCallback(
    async (file: File): Promise<UploadedTemplateSource | null> => {
      const next = await uploadReference("import_template", file);
      if (!next) return null;
      const parsed =
        next.parse_status === "parsed" &&
        next.parsed_columns != null &&
        next.parsed_columns.length > 0;
      return {
        filename: next.original_filename,
        updatedAt: next.updated_at,
        columns: parsed ? next.parsed_columns : null,
        parseError: next.parse_error ?? null,
      };
    },
    [uploadReference],
  );

  const [viewingDraft, setViewingDraft] = useState(false);
  const [showNew, setShowNew] = useState(false);

  // When the list lands empty AND we have a default to show, switch
  // into draft mode automatically. The other branch (list arrives
  // populated) is handled by the hook's auto-select.
  useEffect(() => {
    if (!loadingList && !loadingDefault) {
      if (items.length === 0 && defaultTemplate) {
        setViewingDraft(true);
      }
    }
  }, [loadingList, loadingDefault, items.length, defaultTemplate]);

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
    async (body: InvoiceTemplateCreate) => {
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
      columns: InvoiceTemplateColumn[];
      rules: InvoiceTemplateRule[];
    }) => {
      const detail = await create({
        name: body.name,
        description: body.description,
        columns: body.columns,
        rules: body.rules,
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
      columns: InvoiceTemplateColumn[];
      rules: InvoiceTemplateRule[];
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
      // If that was the last template and we have a default, fall back
      // to the draft view so the workspace doesn't go blank.
      if (defaultTemplate) setViewingDraft(true);
    }
  }, [defaultTemplate, remove, selectedId]);

  return (
    <div className="flex h-full min-h-0">
      {/* ---- Left rail ----------------------------------------------- */}
      <div className="w-[16rem] shrink-0">
        <TemplateList
          items={items}
          selectedId={selectedId}
          viewingDraft={viewingDraft}
          hasDraft={defaultTemplate != null}
          loading={loadingList}
          error={listError}
          onSelect={handleSelectSaved}
          onSelectDraft={handleSelectDraft}
          onNew={() => setShowNew(true)}
          onRetry={() => void refreshList()}
        />
      </div>

      {/* ---- Center: editor ------------------------------------------ */}
      <main className="flex-1 min-w-0 flex flex-col bg-gray-50">
        <CenterPane
          viewingDraft={viewingDraft}
          loadingList={loadingList}
          loadingDefault={loadingDefault}
          loadingDetail={loadingDetail}
          detailError={detailError}
          hasItems={items.length > 0}
          hasDraft={defaultTemplate != null}
          selectedId={selectedId}
          selectedDetail={selectedDetail}
          defaultTemplate={defaultTemplate}
          saving={saving}
          mutationError={mutationError}
          catalogIndex={catalogIndex}
          onNew={() => setShowNew(true)}
          onSelectDraft={handleSelectDraft}
          onRetryDetail={() => selectedId && select(selectedId)}
          onSaveDraft={handleSaveDraft}
          onSaveExisting={handleSaveExisting}
          onDelete={handleDelete}
        />
      </main>

      <NewTemplateModal
        open={showNew}
        saving={saving}
        error={mutationError}
        defaultTemplate={defaultTemplate}
        uploading={importTemplateUiState.uploading}
        uploadProgress={importTemplateUiState.uploadProgress}
        uploadError={importTemplateUiState.error}
        onUploadTemplate={handleUploadTemplate}
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
  selectedDetail: ReturnType<typeof useInvoiceTemplates>["selectedDetail"];
  defaultTemplate: ReturnType<typeof useInvoiceTemplates>["defaultTemplate"];
  saving: boolean;
  mutationError: string | null;
  catalogIndex: ReturnType<typeof useCatalogIndex>;
  onNew: () => void;
  onSelectDraft: () => void;
  onRetryDetail: () => void;
  onSaveDraft: (body: {
    name: string;
    description: string | null;
    columns: InvoiceTemplateColumn[];
    rules: InvoiceTemplateRule[];
  }) => Promise<void>;
  onSaveExisting: (body: {
    name: string;
    description: string | null;
    columns: InvoiceTemplateColumn[];
    rules: InvoiceTemplateRule[];
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
  defaultTemplate,
  saving,
  mutationError,
  catalogIndex,
  onNew,
  onSelectDraft,
  onRetryDetail,
  onSaveDraft,
  onSaveExisting,
  onDelete,
}: CenterPaneProps) {
  // Both lookups still in flight → spinner. Avoids a brief "no
  // templates" flash on first load.
  if (loadingList && loadingDefault && !hasItems && !hasDraft) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-8">
        <p className="text-xs text-gray-500 inline-flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading templates…
        </p>
      </div>
    );
  }

  // Nothing saved AND default fetch failed → only path forward is
  // "+ New". Big empty state.
  if (!hasItems && !hasDraft && !loadingList && !loadingDefault) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-brand-50 flex items-center justify-center mb-3">
            <FileSpreadsheet className="h-6 w-6 text-brand-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-800">
            Design your first import
          </h2>
          <p className="text-[12.5px] text-gray-600 mt-1.5">
            Each saved import captures the column shape, source
            bindings, and validation rules every future invoice export
            should follow. Start from the canonical default or upload a
            ResMan template — then refine each column from the inspector.
          </p>
          <Button
            type="button"
            variant="primary"
            size="md"
            className="mt-4"
            onClick={onNew}
          >
            Create your first import
          </Button>
        </div>
      </div>
    );
  }

  // Draft mode — render the canonical default as a draft the user can
  // edit and save. The default template ships with an empty rules
  // array; the user adds rules as they refine the draft pre-save.
  if (viewingDraft && defaultTemplate) {
    return (
      <TemplateEditor
        templateKey="draft"
        isDraft
        initial={{
          name: defaultTemplate.name,
          description: defaultTemplate.description,
          columns: defaultTemplate.columns,
          rules: defaultTemplate.rules,
          source: "default",
        }}
        saving={saving}
        mutationError={mutationError}
        catalogIndex={catalogIndex}
        onSave={onSaveDraft}
      />
    );
  }

  // Real-template mode.
  if (selectedId && selectedDetail) {
    return (
      <TemplateEditor
        templateKey={selectedDetail.id}
        isDraft={false}
        initial={{
          name: selectedDetail.name,
          description: selectedDetail.description,
          columns: selectedDetail.columns,
          rules: selectedDetail.rules,
          source: selectedDetail.source,
        }}
        saving={saving}
        mutationError={mutationError}
        catalogIndex={catalogIndex}
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
          title="Couldn't load template"
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
            Loading template…
          </p>
        </div>
      ) : (
        // Saved templates exist but nothing's selected — nudge.
        <div className="m-auto max-w-sm text-center">
          <div className="mx-auto h-10 w-10 rounded-full bg-gray-100 flex items-center justify-center mb-2">
            <FileSpreadsheet className="h-5 w-5 text-gray-500" />
          </div>
          <p className="text-sm font-medium text-gray-700">
            Pick a template
          </p>
          <p className="text-[11.5px] text-gray-500 mt-1">
            Choose one from the rail to edit it,
            {hasDraft ? (
              <>
                {" or "}
                <button
                  type="button"
                  className="text-brand-700 underline"
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
