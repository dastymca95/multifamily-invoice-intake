"use client";

import { Button } from "@/components/ui/Button";
import { Badge, statusBadgeColor } from "@/components/ui/Badge";
import { exportsApi } from "@/lib/api/exports";
import { formatDate } from "@/lib/utils";
import type { ExportFormat } from "@/types/api";
import type { ExportJob } from "@/types/invoice";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";

export function ExportForm() {
  const [format, setFormat] = useState<ExportFormat>("xlsx");
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loadingUrl, setLoadingUrl] = useState<string | null>(null);

  useEffect(() => {
    exportsApi.list().then(setJobs);
  }, []);

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const job = await exportsApi.create({ format });
      setJobs((prev) => [job, ...prev]);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownload = async (jobId: string) => {
    setLoadingUrl(jobId);
    try {
      const { url } = await exportsApi.getDownloadUrl(jobId);
      window.open(url, "_blank");
    } finally {
      setLoadingUrl(null);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleExport} className="bg-white rounded-xl border p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-700">New Export</h2>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Format</label>
          <div className="flex gap-3">
            {(["csv", "xlsx", "json"] as ExportFormat[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFormat(f)}
                className={`px-4 py-2 rounded-md border text-sm font-medium transition-colors ${
                  format === f
                    ? "border-brand-500 bg-brand-50 text-brand-700"
                    : "border-gray-200 text-gray-600 hover:border-gray-300"
                }`}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <Button type="submit" loading={submitting}>
          Generate Export
        </Button>
      </form>

      <div className="bg-white rounded-xl border">
        <div className="px-5 py-4 border-b">
          <h2 className="text-sm font-semibold text-gray-700">Export History</h2>
        </div>
        <div className="divide-y">
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
                  onClick={() => handleDownload(job.id)}
                  disabled={loadingUrl === job.id}
                  className="text-brand-600 hover:text-brand-700"
                >
                  <Download className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {jobs.length === 0 && (
            <p className="px-5 py-6 text-sm text-gray-400 text-center">No exports yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
