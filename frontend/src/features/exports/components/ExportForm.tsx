"use client";

import { Badge, statusBadgeColor } from "@/components/ui/Badge";
import { exportsApi } from "@/lib/api/exports";
import { formatDate } from "@/lib/utils";
import type { ExportJob } from "@/types/invoice";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";

export function ExportForm() {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loadingUrl, setLoadingUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    exportsApi.list().then(setJobs).finally(() => setLoading(false));
  }, []);

  const handleDownload = async (job: ExportJob) => {
    setLoadingUrl(job.id);
    try {
      // Auth-aware download helper — handles both S3 presigned URLs and
      // the local backend's JWT-protected relative path.
      await exportsApi.download(job.id, job.format);
    } finally {
      setLoadingUrl(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-blue-50 border-blue-200 p-4 text-sm text-blue-800">
        Exports are generated per batch. Open a batch from the dashboard and
        use the <strong>Export Batch</strong> panel at the bottom of the batch
        detail page to choose a format and create an export.
      </div>

      <div className="bg-white rounded-xl border">
        <div className="px-5 py-4 border-b">
          <h2 className="text-sm font-semibold text-gray-700">Export History</h2>
        </div>
        <div className="divide-y">
          {loading && (
            <p className="px-5 py-6 text-sm text-gray-400 text-center">Loading…</p>
          )}
          {!loading && jobs.length === 0 && (
            <p className="px-5 py-6 text-sm text-gray-400 text-center">No exports yet.</p>
          )}
          {jobs.map((job) => (
            <div key={job.id} className="flex items-center gap-4 px-5 py-3">
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">{job.format.toUpperCase()}</p>
                <p className="text-xs text-gray-400">{formatDate(job.created_at)}</p>
              </div>
              {job.row_count != null && (
                <span className="text-xs text-gray-500">{job.row_count} rows</span>
              )}
              <Badge color={statusBadgeColor(job.status)}>{job.status}</Badge>
              {job.status === "completed" && (
                <button
                  onClick={() => handleDownload(job)}
                  disabled={loadingUrl === job.id}
                  className="text-brand-600 hover:text-brand-700"
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
