"use client";

import { Badge, statusBadgeColor } from "@/components/ui/Badge";
import { reviewApi } from "@/lib/api/review";
import { confidenceColor, formatCurrency, formatDate } from "@/lib/utils";
import type { Invoice } from "@/types/invoice";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

export function ReviewQueue() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    reviewApi.queue(100).then(setInvoices).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-sm text-gray-400">Loading review queue…</div>;

  if (invoices.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <p className="text-lg font-medium">No invoices awaiting review</p>
        <p className="text-sm mt-1">Upload documents to get started.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border">
      <div className="px-5 py-4 border-b flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Pending Review</h2>
        <span className="text-xs text-gray-400">{invoices.length} invoices</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-gray-500 text-xs">
            <th className="text-left px-5 py-3 font-medium">Vendor</th>
            <th className="text-left px-5 py-3 font-medium">Invoice #</th>
            <th className="text-left px-5 py-3 font-medium">Date</th>
            <th className="text-left px-5 py-3 font-medium">Property</th>
            <th className="text-right px-5 py-3 font-medium">Total</th>
            <th className="text-left px-5 py-3 font-medium">Confidence</th>
            <th className="px-5 py-3" />
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id} className="border-b last:border-0 hover:bg-gray-50">
              <td className="px-5 py-3 font-medium text-gray-900">{inv.vendor_name}</td>
              <td className="px-5 py-3 text-gray-600 font-mono text-xs">{inv.invoice_number}</td>
              <td className="px-5 py-3 text-gray-600">{formatDate(inv.invoice_date)}</td>
              <td className="px-5 py-3 text-gray-500">{inv.property_name || "—"}</td>
              <td className="px-5 py-3 text-right font-medium">
                {formatCurrency(inv.total_amount, inv.currency)}
              </td>
              <td className="px-5 py-3">
                <span className={confidenceColor(inv.extraction_confidence)}>
                  {inv.extraction_confidence != null
                    ? `${Math.round(inv.extraction_confidence * 100)}%`
                    : "—"}
                </span>
              </td>
              <td className="px-5 py-3 text-right">
                <Link
                  href={`/review/${inv.id}`}
                  className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 text-xs font-medium"
                >
                  Review <ArrowRight className="h-3 w-3" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
