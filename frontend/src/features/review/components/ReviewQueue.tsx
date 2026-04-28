"use client";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { reviewApi } from "@/lib/api/review";
import { getApiErrorMessage } from "@/lib/api";
import { confidenceColor, formatCurrency, formatDate } from "@/lib/utils";
import type { Invoice } from "@/types/invoice";
import { ArrowRight, Inbox } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

export function ReviewQueue() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    reviewApi
      .queue(100)
      .then((rows) => {
        if (!cancelled) setInvoices(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(getApiErrorMessage(err, "Failed to load review queue."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (loading) return <div className="text-sm text-gray-400 dark:text-ink-subtle">Loading review queue…</div>;

  if (error) {
    return (
      <InlineAlert
        tone="error"
        title="Could not load the review queue."
        action={
          <Button variant="secondary" size="sm" onClick={reload}>
            Try again
          </Button>
        }
      >
        {error}
      </InlineAlert>
    );
  }

  if (invoices.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 py-16 text-center shadow-sm dark:bg-surface-subtle dark:border-line">
        <Inbox className="h-10 w-10 text-gray-300 dark:text-ink-subtle mx-auto mb-3" />
        <p className="text-base font-medium text-gray-700 dark:text-ink">Nothing waiting for review</p>
        <p className="text-sm text-gray-500 dark:text-ink-muted mt-1">
          Approved or rejected invoices won&apos;t show up here.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Link
            href="/upload"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-brand-600 transition-colors hover:bg-brand-50 hover:text-brand-700 dark:text-brand-50 dark:hover:bg-surface-muted"
          >
            Upload documents <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm dark:bg-surface-subtle dark:border-line">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-line flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-ink">Pending Review</h2>
          <p className="text-xs text-gray-500 dark:text-ink-muted mt-0.5">
            Open an invoice to verify the extracted fields and approve or reject.
          </p>
        </div>
        <span className="text-xs text-gray-400 dark:text-ink-subtle">
          {invoices.length} invoice{invoices.length === 1 ? "" : "s"}
        </span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-line text-gray-500 dark:text-ink-subtle text-xs">
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
            <tr key={inv.id} className="border-b border-gray-100 dark:border-line/60 last:border-0 hover:bg-gray-50 dark:hover:bg-surface-muted">
              <td className="px-5 py-3 font-medium text-gray-900 dark:text-ink">
                {inv.vendor_name || <span className="text-gray-300 dark:text-ink-subtle">—</span>}
              </td>
              <td className="px-5 py-3 text-gray-600 dark:text-ink-muted font-mono text-xs">
                {inv.invoice_number || <span className="text-gray-300 dark:text-ink-subtle">—</span>}
              </td>
              <td className="px-5 py-3 text-gray-600 dark:text-ink-muted">{formatDate(inv.invoice_date)}</td>
              <td className="px-5 py-3 text-gray-500 dark:text-ink-muted">{inv.property_name || "—"}</td>
              <td className="px-5 py-3 text-right font-medium text-gray-900 dark:text-ink">
                {formatCurrency(Number(inv.total_amount ?? 0), inv.currency)}
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
                  href={`/review/${inv.document_id}`}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-brand-600 hover:bg-brand-50 hover:text-brand-700 dark:text-brand-50 dark:hover:bg-surface-muted text-xs font-medium"
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
