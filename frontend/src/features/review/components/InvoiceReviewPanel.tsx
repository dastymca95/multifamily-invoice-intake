"use client";

import { Button } from "@/components/ui/Button";
import { Badge, statusBadgeColor } from "@/components/ui/Badge";
import { reviewApi } from "@/lib/api/review";
import { confidenceColor, formatCurrency, formatDate } from "@/lib/utils";
import type { Invoice } from "@/types/invoice";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FieldEditor } from "./FieldEditor";
import { LineItemTable } from "./LineItemTable";

interface InvoiceReviewPanelProps {
  invoiceId: string;
}

export function InvoiceReviewPanel({ invoiceId }: InvoiceReviewPanelProps) {
  const router = useRouter();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<"approve" | "reject" | null>(null);

  useEffect(() => {
    reviewApi.getInvoice(invoiceId).then(setInvoice).finally(() => setLoading(false));
  }, [invoiceId]);

  const handleApprove = async () => {
    setActionLoading("approve");
    try {
      await reviewApi.approve(invoiceId);
      router.push("/review");
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async () => {
    setActionLoading("reject");
    try {
      await reviewApi.reject(invoiceId);
      router.push("/review");
    } finally {
      setActionLoading(null);
    }
  };

  const updateField = (field: keyof Invoice) => (value: unknown) => {
    setInvoice((prev) => prev ? { ...prev, [field]: value } : prev);
  };

  if (loading) return <div className="p-6 text-sm text-gray-400">Loading invoice…</div>;
  if (!invoice) return <div className="p-6 text-sm text-red-500">Invoice not found.</div>;

  return (
    <div className="flex h-full">
      {/* Header fields panel */}
      <div className="w-80 shrink-0 border-r bg-white p-5 overflow-y-auto space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Header Fields</span>
          {invoice.extraction_confidence != null && (
            <span className={`text-xs font-medium ${confidenceColor(invoice.extraction_confidence)}`}>
              {Math.round(invoice.extraction_confidence * 100)}% confidence
            </span>
          )}
        </div>

        <FieldEditor
          invoiceId={invoiceId}
          fieldName="vendor_name"
          label="Vendor Name"
          currentValue={invoice.vendor_name}
          onSaved={updateField("vendor_name")}
        />
        <FieldEditor
          invoiceId={invoiceId}
          fieldName="invoice_number"
          label="Invoice Number"
          currentValue={invoice.invoice_number}
          onSaved={updateField("invoice_number")}
        />
        <FieldEditor
          invoiceId={invoiceId}
          fieldName="invoice_date"
          label="Invoice Date"
          currentValue={invoice.invoice_date}
          onSaved={updateField("invoice_date")}
        />
        <FieldEditor
          invoiceId={invoiceId}
          fieldName="due_date"
          label="Due Date"
          currentValue={invoice.due_date}
          onSaved={updateField("due_date")}
        />
        <FieldEditor
          invoiceId={invoiceId}
          fieldName="property_name"
          label="Property Name"
          currentValue={invoice.property_name}
          onSaved={updateField("property_name")}
        />
        <FieldEditor
          invoiceId={invoiceId}
          fieldName="property_code"
          label="Property Code"
          currentValue={invoice.property_code}
          onSaved={updateField("property_code")}
        />
        <FieldEditor
          invoiceId={invoiceId}
          fieldName="account_number"
          label="Account Number"
          currentValue={invoice.account_number}
          onSaved={updateField("account_number")}
        />
        <FieldEditor
          invoiceId={invoiceId}
          fieldName="total_amount"
          label="Total Amount"
          currentValue={invoice.total_amount}
          onSaved={updateField("total_amount")}
        />

        <div className="pt-2 space-y-2">
          <Button className="w-full" onClick={handleApprove} loading={actionLoading === "approve"}>
            Approve Invoice
          </Button>
          <Button
            variant="danger"
            className="w-full"
            onClick={handleReject}
            loading={actionLoading === "reject"}
          >
            Reject
          </Button>
        </div>
      </div>

      {/* Line items */}
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="mb-4 flex items-center gap-4">
          <div>
            <p className="text-lg font-semibold text-gray-900">{invoice.vendor_name}</p>
            <p className="text-sm text-gray-500">
              Invoice {invoice.invoice_number} · {formatDate(invoice.invoice_date)}
            </p>
          </div>
          <div className="ml-auto text-right">
            <p className="text-xl font-bold text-gray-900">
              {formatCurrency(invoice.total_amount, invoice.currency)}
            </p>
            <Badge color={statusBadgeColor(invoice.invoice_type)}>{invoice.invoice_type}</Badge>
          </div>
        </div>

        <div className="bg-white rounded-xl border p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Line Items</h3>
          <LineItemTable lines={invoice.lines} currency={invoice.currency} />
        </div>
      </div>
    </div>
  );
}
