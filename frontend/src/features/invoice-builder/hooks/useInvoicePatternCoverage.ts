"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getApiErrorMessage, invoicePatternsApi } from "@/lib/api";
import type { InvoicePatternImportCoverage } from "@/types/invoice-pattern-coverage";

/**
 * Coverage view for the open Invoice Builder pattern.
 *
 * Powers the right-rail Coverage panel (which Import Builder templates
 * + columns reference this pattern's fields) plus the region overlay
 * association badges ("Linked", "REQ mapped"). One round-trip per
 * pattern open / template-filter change; backend service derives the
 * full reverse view from `extraction_bindings` on every rule cell, so
 * there's no client-side cache to keep coherent — refetching is cheap
 * and always-correct.
 *
 * Args:
 *   * `patternId`  — null disables the hook entirely (useful while no
 *                    pattern is selected; returns `data: null`,
 *                    `loading: false`).
 *   * `templateId` — null = "All templates" (one entry per workspace
 *                    template, including templates that don't reference
 *                    this pattern). A specific id = single-template
 *                    view, cheaper round-trip when the operator has
 *                    drilled into one template.
 *
 * Late-response guard: each request stamps a monotonically increasing
 * sequence number into a ref; only the response whose seq matches the
 * latest write commits to state. Same shape as the detail-fetch guard
 * in `useInvoicePatterns` — drops stale responses when the operator
 * flips templates rapidly.
 *
 * `refresh()` re-runs the same query — used after a save in the Import
 * Builder editor or a manual refresh from the Coverage panel header.
 */
export interface UseInvoicePatternCoverageResult {
  data: InvoicePatternImportCoverage | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useInvoicePatternCoverage(
  patternId: string | null,
  templateId: string | null,
): UseInvoicePatternCoverageResult {
  const [data, setData] = useState<InvoicePatternImportCoverage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Monotonic request id. Each fetch increments it; only the matching
  // response is allowed to commit. Lets `refresh()` and prop-driven
  // refetches race safely.
  const reqSeqRef = useRef(0);

  const fetchOnce = useCallback(
    async (pid: string, tid: string | null) => {
      const seq = reqSeqRef.current + 1;
      reqSeqRef.current = seq;
      setLoading(true);
      setError(null);
      try {
        const resp = await invoicePatternsApi.getImportCoverage(
          pid,
          tid ?? undefined,
        );
        if (reqSeqRef.current !== seq) return;
        setData(resp);
      } catch (err) {
        if (reqSeqRef.current !== seq) return;
        setError(
          getApiErrorMessage(err, "Couldn't load coverage for this pattern."),
        );
        setData(null);
      } finally {
        if (reqSeqRef.current === seq) setLoading(false);
      }
    },
    [],
  );

  // Auto-fetch on (patternId, templateId) change. Null pattern clears
  // state without making a request — the Coverage panel renders an
  // empty-pattern hint rather than a loading spinner in that case.
  useEffect(() => {
    if (!patternId) {
      // Bump seq so any in-flight request from a prior pattern can't
      // race-write into the cleared state.
      reqSeqRef.current += 1;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    void fetchOnce(patternId, templateId);
  }, [patternId, templateId, fetchOnce]);

  const refresh = useCallback(async () => {
    if (!patternId) return;
    await fetchOnce(patternId, templateId);
  }, [patternId, templateId, fetchOnce]);

  return { data, loading, error, refresh };
}
