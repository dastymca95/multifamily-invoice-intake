"use client";

import { Button } from "@/components/ui/Button";
import { vendorPatternsApi } from "@/lib/api/vendor-patterns";
import { formatDate } from "@/lib/utils";
import type { VendorPattern } from "@/types/invoice";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

export function PatternList() {
  const [patterns, setPatterns] = useState<VendorPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = (q?: string) => {
    vendorPatternsApi.list(q, 50).then(setPatterns).finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    load(search || undefined);
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      await vendorPatternsApi.delete(id);
      setPatterns((prev) => prev.filter((p) => p.id !== id));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search vendors…"
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <Button type="submit" variant="secondary">Search</Button>
      </form>

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="bg-white rounded-xl border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-gray-500 text-xs">
                <th className="text-left px-5 py-3 font-medium">Vendor</th>
                <th className="text-left px-5 py-3 font-medium">Confidence</th>
                <th className="text-right px-5 py-3 font-medium">Samples</th>
                <th className="text-left px-5 py-3 font-medium">Hints</th>
                <th className="text-left px-5 py-3 font-medium">Updated</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {patterns.map((p) => (
                <tr key={p.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-5 py-3">
                    <p className="font-medium text-gray-900">{p.vendor_name_display}</p>
                    <p className="text-xs text-gray-400">{p.vendor_name_normalized}</p>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-20 h-1.5 rounded-full bg-gray-200">
                        <div
                          className="h-full rounded-full bg-brand-500"
                          style={{ width: `${p.confidence_score * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-500">
                        {Math.round(p.confidence_score * 100)}%
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-right text-gray-600">{p.sample_count}</td>
                  <td className="px-5 py-3 text-xs text-gray-500">
                    {Object.keys(p.field_hints).join(", ") || "—"}
                  </td>
                  <td className="px-5 py-3 text-gray-400">{formatDate(p.updated_at)}</td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => handleDelete(p.id)}
                      disabled={deleting === p.id}
                      className="text-gray-300 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {patterns.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-gray-400">
                    No vendor patterns yet. Approve invoices to start learning.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
