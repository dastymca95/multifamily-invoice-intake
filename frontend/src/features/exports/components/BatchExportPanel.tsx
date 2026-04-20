"use client";

import { useState } from "react";
import { Download, RotateCw } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
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

const FORMATS: Array<{ key: ExportFormat; label: string; hint: string }> = [
  { key: "csv", label: "CSV", hint: "Comma-separated, opens in any spreadsheet app." },
  { key: "xlsx", label: "Excel", hint: "Native Excel workbook with one sheet per section." },
  { key: "json", label: "JSON", hint: "Raw structured data for downstream systems." },
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
  const activeFormatHint = FORMATS.find((f) => f.key === format)?.hint;

  return (
    <div className="bg-white rounded-xl border">
      <div className="px-5 py-4 border-b flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-700">Export Batch</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Generate a downloadable file containing every extracted invoice in
            this batch.
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
              <InlineAlert tone="warning">
                No extracted invoices in this batch yet. Upload and process
                documents before exporting.
              </InlineAlert>
            ) : pendingReviewCount > 0 ? (
              <InlineAlert tone="info">
                {pendingReviewCount} document{pendingReviewCount === 1 ? "" : "s"}{" "}
                still need review. Export will include all extracted invoices
                regardless — review can continue afterward.
              </InlineAlert>
            ) : null}

            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex gap-1.5" role="radiogroup" aria-label="Export format">
                {FORMATS.map((f) => {
                  const active = format === f.key;
                  return (
                    <button
                      key={f.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setFormat(f.key)}
                      disabled={creating}
                      title={f.hint}
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
              {!creating && exportableCount > 0 && (
                <span className="text-xs text-gray-400">
                  {exportableCount} invoice{exportableCount === 1 ? "" : "s"} will be included
                </span>
              )}
            </div>
            {activeFormatHint && (
              <p className="text-[11px] text-gray-400">{activeFormatHint}</p>
            )}
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

            {job.status === "completed" && (
              <p className="text-[11px] text-gray-400">
                Click <strong>Download</strong> to save the file. Use{" "}
                <strong>New export</strong> above to start over with a different format.
              </p>
            )}

            {job.status === "failed" && job.error_message && (
              <InlineAlert tone="error">{job.error_message}</InlineAlert>
            )}
          </div>
        )}

        {error && <InlineAlert tone="error">{error}</InlineAlert>}
      </div>
    </div>
  );
}
