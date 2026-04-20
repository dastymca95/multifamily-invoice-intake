"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { BatchExportPanel } from "@/features/exports/components/BatchExportPanel";
import {
  documentHasProblem,
  documentIsReviewed,
  documentNeedsReview,
} from "@/lib/status";

import { useBatchDetail } from "../hooks/useBatchDetail";
import { BatchDetailHeader } from "./BatchDetailHeader";
import { DocumentQueueFilters, type QueueFilter } from "./DocumentQueueFilters";
import { DocumentQueueTable } from "./DocumentQueueTable";

interface BatchDetailProps {
  batchId: string;
}

export function BatchDetail({ batchId }: BatchDetailProps) {
  const { batch, rows, loading, error, reload } = useBatchDetail(batchId);
  const [filter, setFilter] = useState<QueueFilter>("all");

  const counts = useMemo(() => {
    const c: Record<QueueFilter, number> = {
      all: rows.length,
      needs_review: 0,
      reviewed: 0,
      problem: 0,
    };
    for (const r of rows) {
      if (documentNeedsReview(r.document)) c.needs_review += 1;
      if (documentIsReviewed(r.document)) c.reviewed += 1;
      if (documentHasProblem(r.document)) c.problem += 1;
    }
    return c;
  }, [rows]);

  const filteredRows = useMemo(() => {
    switch (filter) {
      case "needs_review":
        return rows.filter((r) => documentNeedsReview(r.document));
      case "reviewed":
        return rows.filter((r) => documentIsReviewed(r.document));
      case "problem":
        return rows.filter((r) => documentHasProblem(r.document));
      case "all":
      default:
        return rows;
    }
  }, [rows, filter]);

  // Backend's batch-export workflow includes any document whose extraction
  // finished (status === "extracted"); reviewer approval is not required.
  // Mirroring that filter here keeps the panel's "nothing to export" warning
  // and Create-button enablement honest.
  const exportableCount = useMemo(
    () => rows.filter((r) => r.document.extraction_status === "extracted").length,
    [rows],
  );

  // ---- Top-level states ---------------------------------------------------
  if (loading && !batch) {
    return (
      <div className="p-6 text-sm text-gray-400">Loading batch…</div>
    );
  }

  if (error && !batch) {
    return (
      <div className="p-6 max-w-md">
        <InlineAlert
          tone="error"
          title="Could not load this batch."
          action={
            <Button variant="secondary" size="sm" onClick={reload}>
              Try again
            </Button>
          }
        >
          {error}
        </InlineAlert>
      </div>
    );
  }

  if (!batch) {
    return <div className="p-6 text-sm text-gray-400">Batch not found.</div>;
  }

  // ---- Loaded -------------------------------------------------------------
  return (
    <div className="flex flex-col h-full">
      <BatchDetailHeader batch={batch} onReload={reload} />

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <DocumentQueueFilters value={filter} counts={counts} onChange={setFilter} />
          <span className="text-xs text-gray-400">
            Showing {filteredRows.length} of {rows.length} document
            {rows.length === 1 ? "" : "s"}
          </span>
        </div>

        {error && (
          <InlineAlert
            tone="warning"
            action={
              <Button variant="secondary" size="sm" onClick={reload}>
                Retry
              </Button>
            }
          >
            {error}
          </InlineAlert>
        )}

        {rows.length === 0 ? <EmptyBatchState /> : <DocumentQueueTable rows={filteredRows} />}

        <BatchExportPanel
          batchId={batchId}
          exportableCount={exportableCount}
          pendingReviewCount={counts.needs_review}
        />
      </div>
    </div>
  );
}

function EmptyBatchState() {
  return (
    <div className="bg-white rounded-xl border py-16 text-center">
      <p className="text-sm font-medium text-gray-700">
        No documents in this batch yet.
      </p>
      <p className="text-xs text-gray-500 mt-1">
        Upload documents from the Upload page and they&apos;ll appear here as they
        finish processing.
      </p>
    </div>
  );
}
