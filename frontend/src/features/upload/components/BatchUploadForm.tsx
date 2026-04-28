"use client";

import { ArrowRight, ListChecks } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { ResizablePanePair } from "@/components/ui/ResizablePanePair";

import { useBatchUpload } from "../hooks/useBatchUpload";
import { BatchPicker } from "./BatchPicker";
import { DocumentVisualizer } from "./DocumentVisualizer";
import { DropZone } from "./DropZone";
import { PreviewPane, type PreviewSelection } from "./PreviewPane";

/**
 * Upload workspace.
 *
 * Layout:
 *   - Left:           controls aside (fixed width on desktop, scrolls vertically)
 *   - Center + Right: ResizablePanePair (visualizer | drag handle | preview)
 *
 * The outer container fills the available viewport height (`h-full`); each
 * column owns its own vertical overflow. That lets the preview pane render
 * a tall PDF without forcing the page to scroll.
 *
 * The hook owns all upload + selection state — see `useBatchUpload`.
 */
export function BatchUploadForm() {
  const [batchName, setBatchName] = useState("");
  const {
    files,
    persistedDocuments,
    loadingPersisted,
    phase,
    topLevelError,
    batch,
    overallProgress,
    selectedItemId,
    setSelectedItemId,
    pageEdits,
    pendingEditsId,
    togglePageEdit,
    restoreAllPages,
    commitPageEdits,
    addFiles,
    removeDocument,
    clearAll,
    startUpload,
    openBatch,
    continueBatch,
    reset,
  } = useBatchUpload();

  const isIdle = phase === "idle";
  const isCreating = phase === "creating_batch";
  const isUploading = phase === "uploading";
  const isDone = phase === "done";
  const isError = phase === "error";

  const queuedCount = files.filter((f) => f.status === "queued").length;
  const failedCount = files.filter((f) => f.status === "failed").length;
  const duplicateCount = files.filter((f) => f.status === "duplicate").length;
  const newSuccessCount = files.filter(
    (f) => f.status === "extracted" || f.status === "uploaded",
  ).length;

  // ---- Selection → PreviewPane payload ------------------------------------
  const selection: PreviewSelection | null = useMemo(() => {
    if (selectedItemId == null) return null;
    const queued = files.find((f) => f.id === selectedItemId);
    if (queued) return { kind: "queued", tracked: queued };
    const persisted = persistedDocuments.find((d) => d.id === selectedItemId);
    if (persisted) return { kind: "persisted", document: persisted };
    return null;
  }, [selectedItemId, files, persistedDocuments]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void startUpload(batchName);
  };
  const handleStartFresh = () => {
    setBatchName("");
    reset();
  };
  const handleContinue = () => continueBatch();
  const handlePick = (b: Parameters<typeof openBatch>[0]) => {
    setBatchName("");
    void openBatch(b);
  };

  const canSubmit = (() => {
    if (!isIdle) return false;
    if (queuedCount === 0) return false;
    if (batch == null && !batchName.trim()) return false;
    return true;
  })();

  const submitLabel = (() => {
    if (isCreating) return "Creating batch…";
    if (isUploading) return "Uploading…";
    if (queuedCount === 0) return batch ? "Add files to upload" : "Upload";
    const verb = batch ? "Add" : "Upload";
    return `${verb} ${queuedCount} file${queuedCount === 1 ? "" : "s"}`;
  })();

  return (
    <div className="h-full w-full flex flex-col gap-4 lg:flex-row lg:gap-3">
      {/* ============== Left: controls aside ============================== */}
      <aside className="lg:w-72 lg:shrink-0 lg:h-full lg:overflow-y-auto lg:pr-1">
        <form onSubmit={handleSubmit} className="space-y-4">
          <BatchPicker
            current={batch}
            onPick={handlePick}
            onStartNew={handleStartFresh}
            disabled={isCreating || isUploading}
          />

          {batch == null && (
            <div>
              <label
                htmlFor="batch-name"
                className="block text-sm font-medium text-gray-700 dark:text-ink mb-1"
              >
                Batch name
              </label>
              <input
                id="batch-name"
                value={batchName}
                onChange={(e) => setBatchName(e.target.value)}
                placeholder="e.g. May 2026 Utilities — Oakwood Portfolio"
                disabled={!isIdle}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-50 disabled:text-gray-500 dark:border-line dark:bg-surface-subtle dark:text-ink dark:placeholder:text-ink-subtle dark:disabled:bg-surface-muted dark:disabled:text-ink-subtle"
                required={batch == null}
              />
              <p className="text-[11px] text-gray-400 dark:text-ink-subtle mt-1">
                Pick something a reviewer will recognize a week from now —
                month + property usually works well.
              </p>
            </div>
          )}

          {batch != null && (
            <div className="rounded-lg bg-brand-50/50 border border-brand-100 dark:border-brand-900/60 dark:bg-brand-900/20 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-brand-700/70 font-semibold">
                Adding to existing batch
              </p>
              <p className="text-sm text-brand-900 dark:text-brand-50 mt-0.5 truncate">
                {batch.name}
              </p>
              <p className="text-[11px] text-brand-700/70 mt-1">
                New files upload into this batch. Use the picker above to switch
                or start fresh.
              </p>
            </div>
          )}

          <DropZone onFiles={addFiles} disabled={!isIdle} />

          <div className="flex items-center gap-2">
            <Button
              type="submit"
              loading={isCreating || isUploading}
              disabled={!canSubmit}
              className="flex-1"
            >
              {submitLabel}
            </Button>
            {isIdle && files.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
                Clear
              </Button>
            )}
          </div>

          {/* ---- Top-level banners --------------------------------------- */}
          {isError && topLevelError && (
            <InlineAlert
              tone="error"
              title="Couldn't create the batch."
              action={
                <Button type="button" variant="secondary" size="sm" onClick={handleStartFresh}>
                  Reset
                </Button>
              }
            >
              {topLevelError}
            </InlineAlert>
          )}

          {!isError && topLevelError && (
            <InlineAlert tone="error">{topLevelError}</InlineAlert>
          )}

          {isDone && (
            <DoneBanner
              batchId={batch?.id ?? null}
              newSuccess={newSuccessCount}
              duplicates={duplicateCount}
              failed={failedCount}
              onContinue={handleContinue}
              onStartFresh={handleStartFresh}
            />
          )}

          {(isCreating || isUploading) && (
            <InlineAlert tone="info">
              {isCreating
                ? "Creating the batch on the server…"
                : `Uploading file ${
                    files.findIndex((f) => f.status === "uploading") + 1
                  } of ${files.length}…`}
            </InlineAlert>
          )}

          {isIdle && files.length === 0 && persistedDocuments.length === 0 && (
            <p className="text-[11px] text-gray-400 dark:text-ink-subtle">
              Drop one or more PDFs/images on the left, or open an existing
              batch from the picker above. Each file uploads sequentially;
              you&apos;ll see live status in the middle and a preview on the
              right.
            </p>
          )}
        </form>
      </aside>

      {/* ============== Right: resizable visualizer + preview ============= */}
      <ResizablePanePair
        className="flex-1 min-w-0"
        initialRatio={0.42}
        minRatio={0.25}
        maxRatio={0.7}
        storageKey="upload.workspaceSplit"
        left={
          <div className="h-full min-h-0">
            <DocumentVisualizer
              files={files}
              persistedDocuments={persistedDocuments}
              loadingPersisted={loadingPersisted}
              phase={phase}
              overallProgress={overallProgress}
              batchName={batch?.name ?? batchName}
              selectedItemId={selectedItemId}
              onSelect={setSelectedItemId}
              onRemove={(id) => void removeDocument(id)}
            />
          </div>
        }
        right={
          <div className="h-full min-h-0">
            <PreviewPane
              selection={selection}
              onRemove={isIdle ? (id) => void removeDocument(id) : undefined}
              pageEdits={pageEdits}
              pendingEditsId={pendingEditsId}
              onTogglePage={togglePageEdit}
              onRestoreAll={restoreAllPages}
              onCommitPageEdits={commitPageEdits}
            />
          </div>
        }
      />
    </div>
  );
}

function DoneBanner({
  batchId,
  newSuccess,
  duplicates,
  failed,
  onContinue,
  onStartFresh,
}: {
  batchId: string | null;
  newSuccess: number;
  duplicates: number;
  failed: number;
  onContinue: () => void;
  onStartFresh: () => void;
}) {
  const tone = failed > 0 ? "warning" : "success";
  const total = newSuccess + duplicates + failed;

  return (
    <InlineAlert
      tone={tone}
      title={
        failed > 0
          ? `Finished with ${failed} failure${failed === 1 ? "" : "s"}.`
          : `Batch ready: ${total} file${total === 1 ? "" : "s"} processed.`
      }
      action={
        <div className="flex items-center gap-1">
          <Button type="button" variant="secondary" size="sm" onClick={onContinue}>
            Continue
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onStartFresh}>
            New batch
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-1">
        <span>
          {newSuccess > 0 && (
            <>
              {newSuccess} new
              {duplicates > 0 || failed > 0 ? ", " : ""}
            </>
          )}
          {duplicates > 0 && (
            <>
              {duplicates} skipped as duplicate{duplicates === 1 ? "" : "s"}
              {failed > 0 ? ", " : ""}
            </>
          )}
          {failed > 0 && <>{failed} failed</>}.
        </span>
        {batchId && (
          <Link
            href={`/batches/${batchId}`}
            className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium"
          >
            <ListChecks className="h-3.5 w-3.5" />
            Open batch to start review
            <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
    </InlineAlert>
  );
}
