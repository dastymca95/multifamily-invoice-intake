"use client";

import { Button } from "@/components/ui/Button";
import { Badge, statusBadgeColor } from "@/components/ui/Badge";
import { documentsApi } from "@/lib/api/documents";
import { reviewApi } from "@/lib/api/review";
import { confidenceColor, formatCurrency, formatDate } from "@/lib/utils";
import type {
  CanonicalInvoicePayload,
  DocumentDetailResponse,
  ValidationWarning,
} from "@/types/document";
import { AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LineItemTable } from "./LineItemTable";

interface InvoiceReviewPanelProps {
  documentId: string;
}

const HEADER_FIELDS: Array<{ key: keyof CanonicalInvoicePayload; label: string; type?: string }> = [
  { key: "vendor_name", label: "Vendor Name" },
  { key: "invoice_number", label: "Invoice Number" },
  { key: "invoice_date", label: "Invoice Date", type: "date" },
  { key: "due_date", label: "Due Date", type: "date" },
  { key: "service_period_start", label: "Service Period Start", type: "date" },
  { key: "service_period_end", label: "Service Period End", type: "date" },
  { key: "property_name", label: "Property Name" },
  { key: "property_code", label: "Property Code" },
  { key: "account_number", label: "Account Number" },
  { key: "subtotal", label: "Subtotal", type: "number" },
  { key: "tax_amount", label: "Tax", type: "number" },
  { key: "total_amount", label: "Total Amount", type: "number" },
];

const EMPTY_PAYLOAD: CanonicalInvoicePayload = {
  vendor_name: "",
  vendor_address: null,
  property_name: null,
  property_code: null,
  invoice_number: "",
  invoice_date: null,
  due_date: null,
  service_period_start: null,
  service_period_end: null,
  payment_terms: null,
  subtotal: null,
  tax_amount: null,
  total_amount: "0",
  currency: "USD",
  invoice_type: "unknown",
  utility_type: null,
  account_number: null,
  meter_number: null,
  line_items: [],
};

export function InvoiceReviewPanel({ documentId }: InvoiceReviewPanelProps) {
  const router = useRouter();
  const [detail, setDetail] = useState<DocumentDetailResponse | null>(null);
  const [draft, setDraft] = useState<CanonicalInvoicePayload>(EMPTY_PAYLOAD);
  const [warnings, setWarnings] = useState<ValidationWarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => {
    documentsApi.get(documentId).then((d) => {
      setDetail(d);
      setWarnings(d.warnings);
      if (d.invoice) {
        setDraft({
          ...EMPTY_PAYLOAD,
          ...d.invoice,
          line_items: d.invoice.line_items ?? [],
        });
      }
    }).finally(() => setLoading(false));
  }, [documentId]);

  const setHeader = <K extends keyof CanonicalInvoicePayload>(key: K, value: CanonicalInvoicePayload[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await reviewApi.save(documentId, draft);
      setSavedAt(new Date());
      // Re-fetch to get refreshed warnings after save
      const fresh = await documentsApi.get(documentId);
      setDetail(fresh);
      setWarnings(fresh.warnings);
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async () => {
    setDecision("approve");
    try {
      await reviewApi.save(documentId, draft);
      await reviewApi.approve(documentId);
      router.push("/review");
    } finally {
      setDecision(null);
    }
  };

  const handleReject = async () => {
    setDecision("reject");
    try {
      await reviewApi.reject(documentId);
      router.push("/review");
    } finally {
      setDecision(null);
    }
  };

  if (loading) return <div className="p-6 text-sm text-gray-400">Loading invoice…</div>;
  if (!detail) return <div className="p-6 text-sm text-red-500">Document not found.</div>;

  const totalNumeric = Number(draft.total_amount ?? 0);
  const confidence = detail.extraction_run?.confidence_score;

  return (
    <div className="flex h-full">
      <div className="w-96 shrink-0 border-r bg-white p-5 overflow-y-auto space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Header Fields
          </span>
          {confidence != null && (
            <span className={`text-xs font-medium ${confidenceColor(confidence)}`}>
              {Math.round(confidence * 100)}% confidence
            </span>
          )}
        </div>

        {warnings.length > 0 && (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 space-y-1">
            <div className="flex items-center gap-2 text-yellow-800 text-xs font-semibold">
              <AlertTriangle className="h-3.5 w-3.5" />
              {warnings.length} warning{warnings.length !== 1 ? "s" : ""}
            </div>
            <ul className="text-xs text-yellow-700 space-y-0.5 ml-5 list-disc">
              {warnings.map((w) => (
                <li key={w.code}>{w.message}</li>
              ))}
            </ul>
          </div>
        )}

        {HEADER_FIELDS.map(({ key, label, type }) => (
          <div key={key}>
            <label className="block text-xs text-gray-500 mb-1">{label}</label>
            <input
              type={type ?? "text"}
              value={(draft[key] as string | number | null) ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setHeader(key, (v === "" ? null : v) as CanonicalInvoicePayload[typeof key]);
              }}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        ))}

        <div className="pt-2 space-y-2">
          <Button className="w-full" onClick={handleSave} loading={saving}>
            Save Changes
          </Button>
          {savedAt && (
            <p className="text-xs text-gray-400 text-center">
              Saved {savedAt.toLocaleTimeString()}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button variant="secondary" onClick={handleApprove} loading={decision === "approve"}>
              Save &amp; Approve
            </Button>
            <Button variant="danger" onClick={handleReject} loading={decision === "reject"}>
              Reject
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 p-6 overflow-y-auto">
        <div className="mb-4 flex items-center gap-4">
          <div>
            <p className="text-lg font-semibold text-gray-900">
              {draft.vendor_name || <span className="text-gray-300">Unknown vendor</span>}
            </p>
            <p className="text-sm text-gray-500">
              Invoice {draft.invoice_number || "—"} · {formatDate(draft.invoice_date)}
            </p>
          </div>
          <div className="ml-auto text-right">
            <p className="text-xl font-bold text-gray-900">
              {formatCurrency(totalNumeric, draft.currency)}
            </p>
            <Badge color={statusBadgeColor(detail.document.review_status)}>
              {detail.document.review_status}
            </Badge>
          </div>
        </div>

        <div className="bg-white rounded-xl border p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Line Items</h3>
          <LineItemTable
            lines={draft.line_items}
            currency={draft.currency}
            onChange={(lines) => setHeader("line_items", lines)}
          />
        </div>
      </div>
    </div>
  );
}
