"use client";

import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { documentsApi } from "@/lib/api/documents";
import { reviewApi } from "@/lib/api/review";
import { getApiErrorMessage } from "@/lib/api";
import { displayDocumentStatus } from "@/lib/status";
import { confidenceColor, formatCurrency, formatDate } from "@/lib/utils";
import {
  computeReviewIssues,
  lineItemsSum,
  mergeIssues,
  type ReviewIssue,
} from "@/lib/validation";
import type {
  CanonicalInvoicePayload,
  DocumentDetailResponse,
  ValidationWarning,
} from "@/types/document";
import { CheckCircle2, FileText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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

const MONEY_TOLERANCE = 0.01;

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
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
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
  }, [documentId, reloadKey]);

  const setHeader = <K extends keyof CanonicalInvoicePayload>(
    key: K,
    value: CanonicalInvoicePayload[K],
  ) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    // Any edit invalidates the "Saved at" indicator — keep the UI honest.
    if (savedAt) setSavedAt(null);
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

  // Issues = backend warnings (authoritative) ∪ client soft checks (responsive).
  // Recomputed from the live draft so reviewers see the impact of edits
  // without a round-trip.
  const issues: ReviewIssue[] = useMemo(
    () => mergeIssues(warnings, computeReviewIssues(draft)),
    [warnings, draft],
  );
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  const infoCount = issues.filter((i) => i.severity === "info").length;

  // ---- Top-level states --------------------------------------------------
  if (loading) return <div className="p-6 text-sm text-gray-400">Loading invoice…</div>;
  if (!detail) {
    return (
      <div className="p-6 max-w-md">
        <InlineAlert
          tone="error"
          title="Could not load this invoice."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              Retry
            </Button>
          }
        >
          {loadError ?? "Document not found."}
        </InlineAlert>
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

        {issues.length > 0 && (
          <IssueList
            issues={issues}
            warningCount={warningCount}
            infoCount={infoCount}
          />
        )}

        {error && <InlineAlert tone="error">{error}</InlineAlert>}

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
          <p className="text-[11px] text-gray-400 pt-1 text-center leading-snug">
            Warnings are advisory. You can approve or reject regardless.
          </p>
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

        <div className="bg-white rounded-xl border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">Line Items</h3>
            <span className="text-xs text-gray-400">
              {draft.line_items.length} line
              {draft.line_items.length === 1 ? "" : "s"}
            </span>
          </div>
          <LineItemTable
            lines={draft.line_items}
            currency={draft.currency}
            onChange={(lines) => setHeader("line_items", lines)}
          />
          <ReconciliationSummary draft={draft} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline subcomponents
// ---------------------------------------------------------------------------

function IssueList({
  issues,
  warningCount,
  infoCount,
}: {
  issues: ReviewIssue[];
  warningCount: number;
  infoCount: number;
}) {
  // Pick the box tone from the highest severity present so the panel reads at
  // a glance: yellow if anything is a warning, blue if only informational.
  const tone = warningCount > 0 ? "warning" : "info";
  const summary =
    warningCount > 0 && infoCount > 0
      ? `${warningCount} warning${warningCount === 1 ? "" : "s"} · ${infoCount} note${infoCount === 1 ? "" : "s"}`
      : warningCount > 0
        ? `${warningCount} warning${warningCount === 1 ? "" : "s"}`
        : `${infoCount} note${infoCount === 1 ? "" : "s"}`;

  return (
    <InlineAlert tone={tone} title={summary}>
      <ul className="ml-4 mt-1 list-disc space-y-0.5">
        {issues.map((issue) => (
          <li key={issue.code}>{issue.message}</li>
        ))}
      </ul>
    </InlineAlert>
  );
}

/**
 * Compact reconciliation summary so the reviewer doesn't have to mentally
 * tally line items vs the invoice total. Greys out rows that aren't
 * applicable (e.g. no subtotal entered) so it never feels noisy.
 */
function ReconciliationSummary({ draft }: { draft: CanonicalInvoicePayload }) {
  const total = toNum(draft.total_amount);
  const subtotal = toNum(draft.subtotal);
  const tax = toNum(draft.tax_amount);
  const subPlusTax = subtotal != null ? subtotal + (tax ?? 0) : null;
  const liSum = lineItemsSum(draft.line_items);
  const currency = draft.currency || "USD";

  const subOk =
    total != null && subPlusTax != null && Math.abs(subPlusTax - total) <= MONEY_TOLERANCE;
  const liOk =
    total != null &&
    liSum != null &&
    Number.isFinite(liSum) &&
    Math.abs(liSum - total) <= MONEY_TOLERANCE;

  return (
    <div className="border-t pt-3 grid grid-cols-3 gap-3 text-xs">
      <ReconCell
        label="Subtotal + tax"
        value={subPlusTax != null ? formatCurrency(subPlusTax, currency) : "—"}
        ok={subPlusTax == null || total == null ? null : subOk}
      />
      <ReconCell
        label="Line items sum"
        value={
          liSum == null
            ? "—"
            : Number.isFinite(liSum)
              ? formatCurrency(liSum, currency)
              : "…"
        }
        ok={liSum == null || total == null || !Number.isFinite(liSum) ? null : liOk}
      />
      <ReconCell
        label="Invoice total"
        value={total != null ? formatCurrency(total, currency) : "—"}
        emphasize
      />
    </div>
  );
}

function ReconCell({
  label,
  value,
  ok,
  emphasize,
}: {
  label: string;
  value: string;
  ok?: boolean | null;
  emphasize?: boolean;
}) {
  const valueClass = emphasize
    ? "text-gray-900 font-semibold"
    : ok === true
      ? "text-green-700 font-medium"
      : ok === false
        ? "text-yellow-700 font-medium"
        : "text-gray-700";
  return (
    <div>
      <p className="text-gray-500">{label}</p>
      <p className={valueClass}>{value}</p>
    </div>
  );
}

function toNum(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
