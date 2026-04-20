"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
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

  // ---- Top-level states ---------------------------------------------------
  if (loading && !batch) {
    return (
      <div className="p-6 text-sm text-gray-400">Loading batch…</div>
    );
  }

  if (error && !batch) {
    return (
      <div className="p-6 space-y-3">
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
        <Button variant="secondary" size="sm" onClick={reload}>
          Try again
        </Button>
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
            {filteredRows.length} of {rows.length} documents
          </span>
        </div>

        {error && (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-2 text-sm text-yellow-800">
            {error}
          </div>
        )}

        {rows.length === 0 ? (
          <EmptyBatchState />
        ) : (
          <DocumentQueueTable rows={filteredRows} />
        )}
      </div>
    </div>
  );
}

function EmptyBatchState() {
  return (
    <div className="bg-white rounded-xl border py-16 text-center text-gray-400">
      <p className="text-sm font-medium text-gray-600">No documents in this batch yet.</p>
      <p className="text-xs mt-1">Upload documents from the Upload page to see them here.</p>
    </div>
  );
}
