"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle, FileText } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import {
  displayDocumentStatus,
  displayRoute,
  documentIsReviewed,
  documentNeedsReview,
} from "@/lib/status";
import { formatCurrency } from "@/lib/utils";
import type { DocumentRow } from "../hooks/useBatchDetail";

interface DocumentQueueTableProps {
  rows: DocumentRow[];
}

export function DocumentQueueTable({ rows }: DocumentQueueTableProps) {
  if (rows.length === 0) {
    return (
      <div className="bg-white rounded-xl border py-12 text-center text-gray-400">
        <FileText className="h-8 w-8 mx-auto mb-2 text-gray-300" />
        <p className="text-sm">No documents match this filter.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr className="border-b text-gray-500 text-xs">
            <Th>File</Th>
            <Th>Route</Th>
            <Th>Status</Th>
            <Th>Vendor</Th>
            <Th>Invoice #</Th>
            <Th align="right">Total</Th>
            <Th align="center">Review&nbsp;Req.</Th>
            <Th align="center">Reviewed</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.document.id} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ row }: { row: DocumentRow }) {
  const { document: doc, invoice, invoiceLoading } = row;
  const status = displayDocumentStatus(doc);
  const needsReview = documentNeedsReview(doc);
  const reviewed = documentIsReviewed(doc);

  const totalDisplay =
    invoice?.total_amount != null
      ? formatCurrency(Number(invoice.total_amount), invoice.currency || "USD")
      : invoiceLoading
      ? "…"
      : "—";

  return (
    <tr className="border-b last:border-0 hover:bg-gray-50">
      <Td>
        <span className="font-medium text-gray-900 truncate block max-w-[260px]" title={doc.original_filename}>
          {doc.original_filename}
        </span>
      </Td>
      <Td>
        <Badge color="gray">{displayRoute(doc.route_used)}</Badge>
      </Td>
      <Td>
        <Badge color={status.tone}>{status.label}</Badge>
      </Td>
      <Td>
        {invoiceLoading ? (
          <span className="text-gray-300">…</span>
        ) : (
          <span className="text-gray-700 truncate block max-w-[180px]">
            {invoice?.vendor_name || <span className="text-gray-300">—</span>}
          </span>
        )}
      </Td>
      <Td>
        {invoiceLoading ? (
          <span className="text-gray-300">…</span>
        ) : (
          <span className="font-mono text-xs text-gray-600">
            {invoice?.invoice_number || <span className="text-gray-300">—</span>}
          </span>
        )}
      </Td>
      <Td align="right">
        <span className="font-medium text-gray-900">{totalDisplay}</span>
      </Td>
      <Td align="center">
        <BoolDot value={needsReview} title={needsReview ? "Needs review" : "Not required"} />
      </Td>
      <Td align="center">
        <BoolDot value={reviewed} title={reviewed ? "Reviewed" : "Not reviewed"} positiveOnly />
      </Td>
      <Td align="right">
        {doc.extraction_status === "extracted" && doc.route_used !== "unsupported" ? (
          <Link
            href={`/review/${doc.id}`}
            className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 text-xs font-medium"
          >
            Open <ArrowRight className="h-3 w-3" />
          </Link>
        ) : (
          <span className="text-xs text-gray-300">—</span>
        )}
      </Td>
    </tr>
  );
}

function BoolDot({
  value,
  title,
  positiveOnly,
}: {
  value: boolean;
  title: string;
  positiveOnly?: boolean;
}) {
  if (value) {
    return <CheckCircle2 className="h-4 w-4 text-green-500 inline-block" aria-label={title} />;
  }
  // For "Reviewed" we show nothing when false; for "Review required" we show
  // an empty circle to make the state explicit.
  return positiveOnly ? (
    <span className="text-gray-300" aria-label={title}>
      —
    </span>
  ) : (
    <Circle className="h-4 w-4 text-gray-300 inline-block" aria-label={title} />
  );
}

function Th({
  children,
  align = "left",
}: {
  children?: React.ReactNode;
  align?: "left" | "right" | "center";
}) {
  const cls =
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return <th className={`${cls} px-4 py-2.5 font-medium`}>{children}</th>;
}

function Td({
  children,
  align = "left",
}: {
  children?: React.ReactNode;
  align?: "left" | "right" | "center";
}) {
  const cls =
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return <td className={`${cls} px-4 py-2.5 align-middle`}>{children}</td>;
}
