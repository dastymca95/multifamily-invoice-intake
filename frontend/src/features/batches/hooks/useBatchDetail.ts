"use client";

import { useCallback, useEffect, useState } from "react";

import { batchesApi, documentsApi, getApiErrorMessage } from "@/lib/api";
import type { Batch } from "@/types/batch";
import type { Document, DocumentDetailResponse } from "@/types/document";

/**
 * One row in the Batch Detail document queue: the Document plus a small
 * subset of invoice fields needed for the table preview.
 *
 * `invoice` may be null while it loads, or if the document failed to extract.
 */
export interface DocumentRow {
  document: Document;
  invoice: InvoiceSummary | null;
  invoiceLoading: boolean;
}

export interface InvoiceSummary {
  vendor_name: string | null;
  invoice_number: string | null;
  total_amount: string | null;
  currency: string;
}

interface UseBatchDetailResult {
  batch: Batch | null;
  rows: DocumentRow[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Loads the batch header, its documents, and (in parallel) the invoice
 * summary for each document via /documents/{id}.
 *
 * Why N+1: Phase 1 backend has no list-with-invoice endpoint, and the spec
 * says don't expand backend scope. Per-document fetches are issued in
 * parallel via Promise.all so the wall-clock cost is one round trip on top
 * of the listing call. Acceptable for typical batch sizes (<100 docs).
 */
export function useBatchDetail(batchId: string): UseBatchDetailResult {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [batchData, docs] = await Promise.all([
          batchesApi.get(batchId),
          batchesApi.listDocuments(batchId, { limit: 200 }),
        ]);
        if (cancelled) return;

        setBatch(batchData);
        // Seed rows immediately so the table renders without waiting on
        // per-document fetches; invoice cells show a placeholder.
        setRows(
          docs.map((d) => ({
            document: d,
            invoice: null,
            invoiceLoading: d.extraction_status === "extracted",
          })),
        );

        // Hydrate invoice fields for documents that finished extracting.
        const hydratable = docs.filter((d) => d.extraction_status === "extracted");
        const settled = await Promise.all(
          hydratable.map((d) =>
            documentsApi
              .get(d.id)
              .then((detail) => ({ id: d.id, detail }))
              .catch(() => ({ id: d.id, detail: null as DocumentDetailResponse | null })),
          ),
        );
        if (cancelled) return;

        const byId = new Map(settled.map((s) => [s.id, s.detail]));
        setRows((prev) =>
          prev.map((row) => {
            if (!byId.has(row.document.id)) return row;
            const detail = byId.get(row.document.id) ?? null;
            return {
              document: row.document,
              invoiceLoading: false,
              invoice: detail?.invoice
                ? {
                    vendor_name:
                      (detail.invoice.vendor_name as string | null | undefined) ?? null,
                    invoice_number:
                      (detail.invoice.invoice_number as string | null | undefined) ?? null,
                    total_amount:
                      (detail.invoice.total_amount as string | null | undefined) ?? null,
                    currency:
                      (detail.invoice.currency as string | undefined) ?? "USD",
                  }
                : null,
            };
          }),
        );
      } catch (err) {
        if (!cancelled) setError(getApiErrorMessage(err, "Failed to load batch."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [batchId, reloadKey]);

  return { batch, rows, loading, error, reload };
}
