"use client";

import { batchesApi } from "@/lib/api/batches";
import { useEffect, useState } from "react";
import type { Batch } from "@/types/batch";
import { formatDate } from "@/lib/utils";
import { Badge, statusBadgeColor } from "@/components/ui/Badge";
import Link from "next/link";

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

  useEffect(() => {
    batchesApi.list({ limit: 10 }).then(setBatches).finally(() => setLoading(false));
  }, []);

  const totalDocs = batches.reduce((s, b) => s + b.total_documents, 0);
  const processed = batches.reduce((s, b) => s + b.processed_documents, 0);
  const failed = batches.reduce((s, b) => s + b.failed_documents, 0);

  if (loading) return <div className="text-sm text-gray-400">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Total Documents" value={totalDocs} />
        <StatCard label="Processed" value={processed} />
        <StatCard label="Failed" value={failed} />
      </div>

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
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-5 py-3">
                  <Link href={`/upload?batch=${b.id}`} className="font-medium text-brand-600 hover:underline">
                    {b.name}
                  </Link>
                </td>
                <td className="px-5 py-3 text-gray-600">
                  {b.processed_documents} / {b.total_documents}
                </td>
                <td className="px-5 py-3 text-gray-400">{formatDate(b.created_at)}</td>
              </tr>
            ))}
            {batches.length === 0 && (
              <tr>
                <td colSpan={3} className="px-5 py-6 text-center text-gray-400">
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
