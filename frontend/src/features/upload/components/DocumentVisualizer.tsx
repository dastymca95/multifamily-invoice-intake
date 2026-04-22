"use client";

import { Folder } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Document } from "@/types/document";

import type {
  BatchPhase,
  TrackedFile,
} from "../hooks/useBatchUpload";
import { DocumentNode } from "./DocumentNode";
import { PersistedDocumentNode } from "./PersistedDocumentNode";
import { UploadProgressBar } from "./UploadProgressBar";

interface DocumentVisualizerProps {
  files: TrackedFile[];
  persistedDocuments: Document[];
  loadingPersisted: boolean;
  phase: BatchPhase;
  overallProgress: number;
  batchName: string;
  selectedItemId: string | null;
  onSelect: (id: string | null) => void;
  /**
   * Unified remove — accepts either a `TrackedFile.id` or a `Document.id`.
   * The hook decides whether the row is local-only or has a server-side
   * counterpart that needs DELETE.
   */
  onRemove: (id: string) => void;
}

function _statusCounts(files: TrackedFile[]) {
  const c = {
    total: files.length,
    extracted: 0,
    uploaded: 0,
    duplicate: 0,
    failed: 0,
    inFlight: 0,
    queued: 0,
  };
  for (const f of files) {
    if (f.status === "extracted") c.extracted += 1;
    else if (f.status === "uploaded") c.uploaded += 1;
    else if (f.status === "duplicate") c.duplicate += 1;
    else if (f.status === "failed") c.failed += 1;
    else if (f.status === "uploading") c.inFlight += 1;
    else c.queued += 1;
  }
  return c;
}

export function DocumentVisualizer({
  files,
  persistedDocuments,
  loadingPersisted,
  phase,
  overallProgress,
  batchName,
  selectedItemId,
  onSelect,
  onRemove,
}: DocumentVisualizerProps) {
  const counts = _statusCounts(files);
  const trimmedName = batchName.trim();
  const totalShown = files.length + persistedDocuments.length;

  // Tone for the overall progress bar reflects the worst-case state present
  // in the queued list (persisted docs are by definition "done").
  const overallTone =
    phase === "uploading" || phase === "creating_batch"
      ? "active"
      : counts.failed > 0
        ? "error"
        : counts.duplicate > 0 && counts.extracted + counts.uploaded === 0
          ? "warning"
          : counts.total > 0 && phase === "done"
            ? "success"
            : "idle";

  return (
    <div className="bg-white rounded-xl border flex flex-col h-full min-h-[24rem]">
      {/* ---- Header ----------------------------------------------------- */}
      <div className="px-4 py-3 border-b flex items-start gap-3">
        <div className="h-9 w-9 shrink-0 rounded-md bg-brand-50 flex items-center justify-center">
          <Folder className="h-4 w-4 text-brand-600" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-gray-800 truncate">
            {trimmedName || "Untitled batch"}
          </h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {totalShown === 0
              ? loadingPersisted
                ? "Loading saved documents…"
                : "Documents you add or open will appear here."
              : `${persistedDocuments.length} saved · ${files.length} in this session`}
          </p>
        </div>
        {files.length > 0 && (
          <div className="shrink-0 text-right">
            <p className="text-xs font-semibold text-gray-700">
              {overallProgress}%
            </p>
            <p className="text-[10.5px] text-gray-400">
              {phase === "uploading"
                ? "Uploading…"
                : phase === "creating_batch"
                  ? "Preparing…"
                  : phase === "done"
                    ? "Finished"
                    : "Ready"}
            </p>
          </div>
        )}
      </div>

      {/* ---- Overall progress (only meaningful while there's queued work) */}
      {files.length > 0 && (
        <div className="px-4 pt-3">
          <UploadProgressBar
            value={overallProgress}
            tone={overallTone}
            size="md"
          />
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-gray-500">
            {counts.queued > 0 && <CountChip label="queued" value={counts.queued} dotClass="bg-gray-300" />}
            {counts.inFlight > 0 && <CountChip label="uploading" value={counts.inFlight} dotClass="bg-brand-500" />}
            {counts.uploaded > 0 && <CountChip label="awaiting extraction" value={counts.uploaded} dotClass="bg-blue-400" />}
            {counts.extracted > 0 && <CountChip label="extracted" value={counts.extracted} dotClass="bg-green-500" />}
            {counts.duplicate > 0 && <CountChip label="duplicate" value={counts.duplicate} dotClass="bg-yellow-500" />}
            {counts.failed > 0 && <CountChip label="failed" value={counts.failed} dotClass="bg-red-500" />}
          </div>
        </div>
      )}

      {/* ---- Body: persisted + queued lists ---------------------------- */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {totalShown === 0 ? (
          <EmptyState loading={loadingPersisted} />
        ) : (
          <>
            {persistedDocuments.length > 0 && (
              <ListSection
                label="Saved to batch"
                count={persistedDocuments.length}
              >
                {persistedDocuments.map((d) => (
                  <PersistedDocumentNode
                    key={d.id}
                    document={d}
                    selected={selectedItemId === d.id}
                    onSelect={onSelect}
                    onRemove={phase === "idle" ? onRemove : undefined}
                  />
                ))}
              </ListSection>
            )}

            {files.length > 0 && (
              <ListSection
                label={
                  persistedDocuments.length > 0
                    ? "This session"
                    : undefined
                }
                count={persistedDocuments.length > 0 ? files.length : null}
              >
                {files.map((f) => (
                  <DocumentNode
                    key={f.id}
                    tracked={f}
                    selected={selectedItemId === f.id}
                    onSelect={onSelect}
                    // Allow remove except mid-upload. The hook handles
                    // both queued-only and just-saved cases.
                    onRemove={phase === "idle" ? onRemove : undefined}
                  />
                ))}
              </ListSection>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ListSection({
  label,
  count,
  children,
}: {
  label?: string;
  count?: number | null;
  children: React.ReactNode;
}) {
  return (
    <section>
      {label && (
        <div className="flex items-center justify-between px-1 mb-1.5">
          <h3 className="text-[10.5px] uppercase tracking-wide text-gray-400 font-semibold">
            {label}
          </h3>
          {count != null && (
            <span className="text-[10.5px] text-gray-400">{count}</span>
          )}
        </div>
      )}
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function CountChip({
  label,
  value,
  dotClass,
}: {
  label: string;
  value: number;
  dotClass: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-1.5 w-1.5 rounded-full", dotClass)} />
      <span className="text-gray-600 font-medium">{value}</span>
      <span className="text-gray-400">{label}</span>
    </span>
  );
}

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="h-full min-h-[14rem] flex flex-col items-center justify-center text-center px-6 py-10 border-2 border-dashed border-gray-200 rounded-lg">
      <Folder className="h-8 w-8 text-gray-300 mb-2" />
      <p className="text-sm font-medium text-gray-600">
        {loading ? "Loading saved documents…" : "No documents yet"}
      </p>
      <p className="text-xs text-gray-400 mt-1 max-w-xs">
        {loading
          ? "Pulling the documents already on file for this batch."
          : "Drag files into the upload area on the left, or open an existing batch to load its documents."}
      </p>
    </div>
  );
}
