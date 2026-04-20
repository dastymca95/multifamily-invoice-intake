"use client";

import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { documentsApi } from "@/lib/api/documents";
import { reviewApi } from "@/lib/api/review";
import { getApiErrorMessage } from "@/lib/api";
import { displayDocumentStatus } from "@/lib/status";
import { confidenceColor, formatCurrency, formatDate } from "@/lib/utils";
import type {
  CanonicalInvoicePayload,
  DocumentDetailResponse,
  ValidationWarning,
} from "@/types/document";
import { AlertTriangle, CheckCircle2, FileText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LineItemTable } from "./LineItemTable";

interface InvoiceReviewPanelProps {
  documentId: string;
}

/**
 * Header field metadata. `nullable: false` marks fields whose backend type is
 * a required `str` rather than `str | None` — for those we coerce empty input
 * back to a default rather than sending `null`.
 */
const HEADER_FIELDS: Array<{
  key: keyof CanonicalInvoicePayload;
  label: string;
  type?: string;
  nullable?: false;
}> = [
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
  { key: "currency", label: "Currency", nullable: false },
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
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    documentsApi
      .get(documentId)
      .then((d) => {
        setDetail(d);
        setWarnings(d.warnings);
        if (d.invoice) {
          setDraft({
            ...EMPTY_PAYLOAD,
            ...d.invoice,
            line_items: d.invoice.line_items ?? [],
          });
        }
      })
      .catch((err) => setLoadError(getApiErrorMessage(err, "Failed to load document.")))
      .finally(() => setLoading(false));
  }, [documentId]);

  const setHeader = <K extends keyof CanonicalInvoicePayload>(
    key: K,
    value: CanonicalInvoicePayload[K],
  ) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  // Refresh the document so the post-save badge / warnings / timestamps
  // reflect the backend's new state. Soft-fails: we don't want a
  // refresh hiccup to overwrite a successful save indicator.
  async function refreshDetail() {
    try {
      const fresh = await documentsApi.get(documentId);
      setDetail(fresh);
      setWarnings(fresh.warnings);
    } catch {
      /* non-fatal */
    }
  }

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await reviewApi.save(documentId, draft);
      setSavedAt(new Date());
      await refreshDetail();
    } catch (err) {
      setError(getApiErrorMessage(err, "Failed to save changes."));
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async () => {
    setDecision("approve");
    setError(null);
    try {
      // Save current draft first so reviewer corrections aren't lost on approve.
      await reviewApi.save(documentId, draft);
      await reviewApi.approve(documentId);
      router.push("/review");
    } catch (err) {
      setError(getApiErrorMessage(err, "Failed to approve invoice."));
      // Backend may have partially advanced (saved but not approved); refresh
      // so the on-screen status badge matches reality.
      await refreshDetail();
    } finally {
      setDecision(null);
    }
  };

  const handleReject = async () => {
    // Optional rejection note; backend's RejectRequest.note is `str | None`.
    const note =
      typeof window !== "undefined"
        ? window.prompt("Reason for rejection (optional):")
        : null;
    setDecision("reject");
    setError(null);
    try {
      await reviewApi.reject(documentId, note ? note : undefined);
      router.push("/review");
    } catch (err) {
      setError(getApiErrorMessage(err, "Failed to reject invoice."));
      await refreshDetail();
    } finally {
      setDecision(null);
    }
  };

  // ---- Top-level states --------------------------------------------------
  if (loading) return <div className="p-6 text-sm text-gray-400">Loading invoice…</div>;
  if (!detail) {
    return (
      <div className="p-6">
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError ?? "Document not found."}
        </div>
      </div>
    );
  }

  const totalNumeric = Number(draft.total_amount ?? 0);
  const confidence = detail.extraction_run?.confidence_score;
  const status = displayDocumentStatus(detail.document);
  const busy = saving || decision !== null;

  return (
    <div className="flex h-full">
      {/* ---- Left panel: header field editor --------------------------- */}
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

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {HEADER_FIELDS.map(({ key, label, type, nullable }) => (
          <div key={key}>
            <label className="block text-xs text-gray-500 mb-1">{label}</label>
            <input
              type={type ?? "text"}
              value={(draft[key] as string | number | null) ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (nullable === false) {
                  // Required string field (e.g. currency) — fall back to a
                  // sensible default rather than sending null.
                  setHeader(
                    key,
                    (v || (key === "currency" ? "USD" : "")) as CanonicalInvoicePayload[typeof key],
                  );
                } else {
                  setHeader(key, (v === "" ? null : v) as CanonicalInvoicePayload[typeof key]);
                }
              }}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        ))}

        <div className="pt-2 space-y-2">
          <Button
            className="w-full"
            onClick={handleSave}
            loading={saving}
            disabled={decision !== null}
          >
            Save Changes
          </Button>
          {savedAt && !error && !saving && (
            <p className="text-xs text-green-600 inline-flex items-center justify-center gap-1 w-full">
              <CheckCircle2 className="h-3 w-3" />
              Saved at {savedAt.toLocaleTimeString()}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button
              variant="secondary"
              onClick={handleApprove}
              loading={decision === "approve"}
              disabled={busy && decision !== "approve"}
            >
              Save &amp; Approve
            </Button>
            <Button
              variant="danger"
              onClick={handleReject}
              loading={decision === "reject"}
              disabled={busy && decision !== "reject"}
            >
              Reject
            </Button>
          </div>
        </div>
      </div>

      {/* ---- Right panel: invoice summary + line items ----------------- */}
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="mb-4 flex items-center gap-4">
          <div className="min-w-0">
            <p className="text-lg font-semibold text-gray-900 truncate">
              {draft.vendor_name || <span className="text-gray-300">Unknown vendor</span>}
            </p>
            <p className="text-sm text-gray-500">
              Invoice {draft.invoice_number || "—"} · {formatDate(draft.invoice_date)}
            </p>
            <p className="text-xs text-gray-400 inline-flex items-center gap-1 mt-1">
              <FileText className="h-3 w-3" />
              <span className="truncate">{detail.document.original_filename}</span>
            </p>
          </div>
          <div className="ml-auto text-right shrink-0">
            <p className="text-xl font-bold text-gray-900">
              {formatCurrency(totalNumeric, draft.currency)}
            </p>
            <Badge color={status.tone}>{status.label}</Badge>
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
