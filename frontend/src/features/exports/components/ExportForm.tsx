"use client";

import { Badge, statusBadgeColor } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { exportsApi } from "@/lib/api/exports";
import { getApiErrorMessage } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import type { ExportJob } from "@/types/invoice";
import { Download } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export function ExportForm() {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    exportsApi
      .list()
      .then((rows) => {
        if (!cancelled) setJobs(rows);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(getApiErrorMessage(err, "Failed to load export history."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const handleDownload = async (job: ExportJob) => {
    setLoadingId(job.id);
    setDownloadError(null);
    try {
      // Auth-aware download helper — handles both S3 presigned URLs and
      // the local backend's JWT-protected relative path.
      await exportsApi.download(job.id, job.format);
    } catch (err) {
      setDownloadError(getApiErrorMessage(err, "Failed to download export."));
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <InlineAlert tone="info" title="Exports are generated per batch.">
        Open a batch from the dashboard and use the <strong>Export Batch</strong>{" "}
        panel at the bottom of the batch detail page to choose a format (CSV,
        Excel, or JSON) and create an export. This page lists every export you
        have created.
      </InlineAlert>

      {downloadError && <InlineAlert tone="error">{downloadError}</InlineAlert>}

      <div className="bg-white rounded-xl border">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-700">Export History</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              All exports you have created, newest first.
            </p>
          </div>
          {!loading && !loadError && (
            <span className="text-xs text-gray-400">
              {jobs.length} export{jobs.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="divide-y">
          {loading && (
            <p className="px-5 py-6 text-sm text-gray-400 text-center">
              Loading export history…
            </p>
          )}
          {!loading && loadError && (
            <div className="px-5 py-4">
              <InlineAlert
                tone="error"
                action={
                  <Button variant="secondary" size="sm" onClick={reload}>
                    Try again
                  </Button>
                }
              >
                {loadError}
              </InlineAlert>
            </div>
          )}
          {!loading && !loadError && jobs.length === 0 && (
            <p className="px-5 py-10 text-sm text-gray-500 text-center">
              No exports yet. Create one from a batch&apos;s detail page.
            </p>
          )}
          {!loading &&
            !loadError &&
            jobs.map((job) => (
              <div key={job.id} className="flex items-center gap-4 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">
                    {job.format.toUpperCase()}
                  </p>
                  <p className="text-xs text-gray-400">{formatDate(job.created_at)}</p>
                </div>
                {job.row_count != null && (
                  <span className="text-xs text-gray-500">
                    {job.row_count} row{job.row_count === 1 ? "" : "s"}
                  </span>
                )}
                <Badge color={statusBadgeColor(job.status)}>{job.status}</Badge>
                {job.status === "completed" && (
                  <button
                    type="button"
                    onClick={() => handleDownload(job)}
                    disabled={loadingId === job.id}
                    className="text-brand-600 hover:text-brand-700 disabled:opacity-50"
                    aria-label={`Download ${job.format.toUpperCase()} export`}
                    title="Download"
                  >
                    <Download className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
