"use client";

import { useState } from "react";
import { Download, RotateCw } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import type { ExportFormat } from "@/types/api";

import { useBatchExport } from "../hooks/useBatchExport";

interface BatchExportPanelProps {
  batchId: string;
  /** Documents whose extraction completed — those the backend will include. */
  exportableCount: number;
  /** Documents still awaiting reviewer action — informational only. */
  pendingReviewCount: number;
}

const FORMATS: Array<{ key: ExportFormat; label: string }> = [
  { key: "csv", label: "CSV" },
  { key: "xlsx", label: "Excel" },
  { key: "json", label: "JSON" },
];

export function BatchExportPanel({
  batchId,
  exportableCount,
  pendingReviewCount,
}: BatchExportPanelProps) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const { job, phase, error, create, download, reset } = useBatchExport();

  const noneToExport = exportableCount === 0;
  const creating = phase === "creating";
  const downloading = phase === "downloading";

  return (
    <div className="bg-white rounded-xl border">
      <div className="px-5 py-4 border-b flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-700">Export Batch</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Generate a downloadable file containing all extracted invoices in this batch.
          </p>
        </div>
        {job && (
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCw className="h-3.5 w-3.5" />
            New export
          </Button>
        )}
      </div>

      <div className="px-5 py-4 space-y-3">
        {/* ---- Pre-create ---------------------------------------------- */}
        {!job && (
          <>
            {noneToExport ? (
              <div className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                No extracted invoices in this batch yet. Upload and extract documents first.
              </div>
            ) : pendingReviewCount > 0 ? (
              <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                {pendingReviewCount} document{pendingReviewCount === 1 ? "" : "s"} still need review.
                Export will include all extracted invoices regardless — review can continue afterward.
              </div>
            ) : null}

            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex gap-1.5">
                {FORMATS.map((f) => {
                  const active = format === f.key;
                  return (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => setFormat(f.key)}
                      disabled={creating}
                      className={cn(
                        "rounded-md px-3 py-1.5 text-xs font-medium border transition-colors",
                        active
                          ? "bg-brand-600 text-white border-brand-600"
                          : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50",
                        creating && "opacity-50 cursor-not-allowed",
                      )}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
              <Button
                size="sm"
                onClick={() => create(batchId, format)}
                loading={creating}
                disabled={noneToExport}
              >
                Create export
              </Button>
            </div>
          </>
        )}

        {/* ---- Post-create --------------------------------------------- */}
        {job && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge color="gray">{job.format.toUpperCase()}</Badge>
              <Badge
                color={
                  job.status === "completed"
                    ? "green"
                    : job.status === "failed"
                    ? "red"
                    : "yellow"
                }
              >
                {job.status}
              </Badge>
              {job.row_count != null && (
                <span className="text-xs text-gray-500">
                  {job.row_count} row{job.row_count === 1 ? "" : "s"}
                </span>
              )}
              <div className="ml-auto">
                {job.status === "completed" && (
                  <Button size="sm" onClick={download} loading={downloading}>
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </Button>
                )}
              </div>
            </div>

            {job.status === "failed" && job.error_message && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {job.error_message}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
