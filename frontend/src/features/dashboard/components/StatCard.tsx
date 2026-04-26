"use client";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { batchesApi } from "@/lib/api/batches";
import { exportsApi } from "@/lib/api/exports";
import { getApiErrorMessage } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { displayBatchStatus } from "@/lib/status";
import { Badge } from "@/components/ui/Badge";
import type { Batch } from "@/types/batch";
import { ArrowRight, Download, Upload } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-1 dark:bg-surface-subtle dark:border-line">
      <p className="text-sm text-gray-500 dark:text-ink-muted">{label}</p>
      <p className="text-2xl font-bold text-gray-900 dark:text-ink">{value}</p>
      {sub && <p className="text-xs text-gray-400 dark:text-ink-subtle">{sub}</p>}
    </div>
  );
}

export function DashboardStats() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    batchesApi
      .list({ limit: 10 })
      .then((rows) => {
        if (!cancelled) setBatches(rows);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(getApiErrorMessage(err, "Failed to load batches."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const totalDocs = batches.reduce((s, b) => s + b.total_documents, 0);
  const processed = batches.reduce((s, b) => s + b.processed_documents, 0);
  const failed = batches.reduce((s, b) => s + b.failed_documents, 0);

  const handleExport = async (batchId: string) => {
    setExportingId(batchId);
    setExportError(null);
    try {
      const job = await exportsApi.createForBatch(batchId, "csv");
      if (job.status !== "completed") {
        setExportError(
          `Export ${job.status}${job.error_message ? `: ${job.error_message}` : ""}`,
        );
        return;
      }
      // Use the auth-aware download helper. `window.open` on the local
      // backend's relative `/api/v1/exports/{id}/download` path opens a new
      // tab without our `Authorization` header and silently 401s.
      await exportsApi.download(job.id, job.format);
    } catch (e) {
      setExportError(getApiErrorMessage(e, "Export failed. Please try again."));
    } finally {
      setExportingId(null);
    }
  };

  if (loading)
    return (
      <div className="text-sm text-gray-400 dark:text-ink-subtle">
        Loading dashboard…
      </div>
    );

  if (loadError) {
    return (
      <InlineAlert
        tone="error"
        title="Could not load batches."
        action={
          <Button variant="secondary" size="sm" onClick={reload}>
            Try again
          </Button>
        }
      >
        {loadError}
      </InlineAlert>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Total Documents" value={totalDocs} />
        <StatCard label="Processed" value={processed} />
        <StatCard label="Failed" value={failed} />
      </div>

      {exportError && <InlineAlert tone="error">{exportError}</InlineAlert>}

      <div className="bg-white rounded-xl border border-gray-200 dark:bg-surface-subtle dark:border-line">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between dark:border-line">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-ink">
              Recent Batches
            </h2>
            <p className="text-xs text-gray-500 mt-0.5 dark:text-ink-muted">
              Open a batch to review documents or create exports.
            </p>
          </div>
          <Link
            href="/upload"
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 dark:text-brand-50 dark:hover:text-brand-50/80"
          >
            <Upload className="h-3.5 w-3.5" />
            New batch
          </Link>
        </div>
        {batches.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-sm font-medium text-gray-700 dark:text-ink">
              No batches yet
            </p>
            <p className="text-xs text-gray-500 mt-1 dark:text-ink-muted">
              Upload your first batch of invoices to get started.
            </p>
            <Link
              href="/upload"
              className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-50 dark:hover:text-brand-50/80"
            >
              Upload documents <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500 text-xs dark:border-line dark:text-ink-subtle">
                <th className="text-left px-5 py-3 font-medium">Name</th>
                <th className="text-left px-5 py-3 font-medium">Status</th>
                <th className="text-left px-5 py-3 font-medium">Documents</th>
                <th className="text-left px-5 py-3 font-medium">Created</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const status = displayBatchStatus(b);
                return (
                  <tr
                    key={b.id}
                    className="border-b border-gray-100 last:border-0 hover:bg-gray-50 dark:border-line/60 dark:hover:bg-surface-muted"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/batches/${b.id}`}
                        className="font-medium text-brand-600 hover:underline dark:text-brand-50"
                      >
                        {b.name}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <Badge color={status.tone}>{status.label}</Badge>
                    </td>
                    <td className="px-5 py-3 text-gray-600 dark:text-ink-muted">
                      {b.processed_documents} / {b.total_documents}
                    </td>
                    <td className="px-5 py-3 text-gray-400 dark:text-ink-subtle">
                      {formatDate(b.created_at)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={exportingId === b.id}
                        onClick={() => handleExport(b.id)}
                        disabled={
                          b.total_documents === 0 ||
                          (exportingId !== null && exportingId !== b.id)
                        }
                        title={
                          b.total_documents === 0
                            ? "No documents in this batch"
                            : "Generate and download a CSV of all extracted invoices"
                        }
                      >
                        <Download className="h-3.5 w-3.5" />
                        Export CSV
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
