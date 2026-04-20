"use client";

import { Button } from "@/components/ui/Button";
import { batchesApi } from "@/lib/api/batches";
import { exportsApi } from "@/lib/api/exports";
import { formatDate } from "@/lib/utils";
import type { Batch } from "@/types/batch";
import { Download } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border p-5 space-y-1">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400">{sub}</p>}
    </div>
  );
}

export function DashboardStats() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    batchesApi.list({ limit: 10 }).then(setBatches).finally(() => setLoading(false));
  }, []);

  const totalDocs = batches.reduce((s, b) => s + b.total_documents, 0);
  const processed = batches.reduce((s, b) => s + b.processed_documents, 0);
  const failed = batches.reduce((s, b) => s + b.failed_documents, 0);

  const handleExport = async (batchId: string) => {
    setExportingId(batchId);
    setError(null);
    try {
      const job = await exportsApi.createForBatch(batchId, "csv");
      if (job.status !== "completed") {
        setError(`Export ${job.status}${job.error_message ? `: ${job.error_message}` : ""}`);
        return;
      }
      const { url } = await exportsApi.getDownloadUrl(job.id);
      window.open(url, "_blank");
    } catch (e) {
      setError("Export failed. Please try again.");
    } finally {
      setExportingId(null);
    }
  };

  if (loading) return <div className="text-sm text-gray-400">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Total Documents" value={totalDocs} />
        <StatCard label="Processed" value={processed} />
        <StatCard label="Failed" value={failed} />
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border">
        <div className="px-5 py-4 border-b">
          <h2 className="text-sm font-semibold text-gray-700">Recent Batches</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-gray-500 text-xs">
              <th className="text-left px-5 py-3 font-medium">Name</th>
              <th className="text-left px-5 py-3 font-medium">Documents</th>
              <th className="text-left px-5 py-3 font-medium">Created</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-5 py-3">
                  <Link href={`/batches/${b.id}`} className="font-medium text-brand-600 hover:underline">
                    {b.name}
                  </Link>
                </td>
                <td className="px-5 py-3 text-gray-600">
                  {b.processed_documents} / {b.total_documents}
                </td>
                <td className="px-5 py-3 text-gray-400">{formatDate(b.created_at)}</td>
                <td className="px-5 py-3 text-right">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={exportingId === b.id}
                    onClick={() => handleExport(b.id)}
                    disabled={b.total_documents === 0}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export CSV
                  </Button>
                </td>
              </tr>
            ))}
            {batches.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-6 text-center text-gray-400">
                  No batches yet. Start by uploading documents.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
