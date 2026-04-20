/**
 * Soft, client-side data-quality checks for the in-progress invoice draft on
 * the Review screen.
 *
 * Design notes:
 *   - Advisory only — these never block Save / Approve. The backend remains
 *     the source of truth for any hard contract. Phase 1's review-first
 *     workflow explicitly allows reviewers to approve incomplete invoices,
 *     so the UI must inform without obstructing.
 *   - Codes are stable strings so backend `ValidationWarning` items and
 *     client-computed issues with the same `code` can be deduplicated by
 *     `mergeIssues` (server wins).
 *   - Money checks tolerate 1¢ rounding because line-item amounts are stored
 *     as Postgres NUMERIC and may legitimately differ by sub-cent before
 *     rounding.
 */

import type { CanonicalInvoicePayload, ValidationWarning } from "@/types/document";

export interface ReviewIssue {
  code: string;
  message: string;
  severity: "warning" | "info";
  field?: string;
  /** True if produced by the backend; false if computed client-side. */
  fromBackend?: boolean;
}

const MONEY_TOLERANCE = 0.01;

function toMoney(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function computeReviewIssues(draft: CanonicalInvoicePayload): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  if (!draft.vendor_name?.trim()) {
    issues.push({
      code: "missing_vendor_name",
      field: "vendor_name",
      severity: "warning",
      message: "Vendor name is missing.",
    });
  }

  if (!draft.invoice_number?.trim()) {
    issues.push({
      code: "missing_invoice_number",
      field: "invoice_number",
      severity: "warning",
      message: "Invoice number is missing.",
    });
  }

  if (!draft.invoice_date) {
    issues.push({
      code: "missing_invoice_date",
      field: "invoice_date",
      severity: "warning",
      message: "Invoice date is missing.",
    });
  }

  const total = toMoney(draft.total_amount);
  if (total == null) {
    issues.push({
      code: "missing_total_amount",
      field: "total_amount",
      severity: "warning",
      message: "Total amount is missing.",
    });
  } else if (total === 0) {
    issues.push({
      code: "zero_total_amount",
      field: "total_amount",
      severity: "info",
      message: "Total amount is zero — confirm this is correct.",
    });
  }

  if (draft.line_items.length === 0) {
    issues.push({
      code: "no_line_items",
      severity: "info",
      message: "No line items captured. Add at least one if the invoice itemizes charges.",
    });
  }

  const subtotal = toMoney(draft.subtotal);
  const tax = toMoney(draft.tax_amount);
  if (total != null && subtotal != null) {
    const expected = subtotal + (tax ?? 0);
    if (Math.abs(expected - total) > MONEY_TOLERANCE) {
      issues.push({
        code: "subtotal_tax_mismatch",
        severity: "warning",
        message: `Subtotal + tax (${expected.toFixed(2)}) does not equal total (${total.toFixed(2)}). Off by ${(expected - total).toFixed(2)}.`,
      });
    }
  }

  if (total != null && draft.line_items.length > 0) {
    const sum = lineItemsSum(draft.line_items);
    if (sum != null && Number.isFinite(sum) && Math.abs(sum - total) > MONEY_TOLERANCE) {
      issues.push({
        code: "line_items_total_mismatch",
        severity: "warning",
        message: `Sum of line items (${sum.toFixed(2)}) does not match total (${total.toFixed(2)}). Off by ${(sum - total).toFixed(2)}.`,
      });
    }
  }

  return issues;
}

export function backendWarningToIssue(w: ValidationWarning): ReviewIssue {
  return {
    code: w.code,
    message: w.message,
    severity: w.severity,
    field: w.field ?? undefined,
    fromBackend: true,
  };
}

/**
 * Combine backend warnings (authoritative) with client-side issues
 * (responsive). On a `code` collision the backend version wins, so the
 * reviewer sees the canonical wording.
 */
export function mergeIssues(
  backend: ValidationWarning[],
  client: ReviewIssue[],
): ReviewIssue[] {
  const out: ReviewIssue[] = backend.map(backendWarningToIssue);
  const seen = new Set(out.map((i) => i.code));
  for (const issue of client) {
    if (!seen.has(issue.code)) {
      out.push(issue);
      seen.add(issue.code);
    }
  }
  return out;
}

/**
 * Sum of line-item amounts. Returns:
 *   - null if there are no lines
 *   - NaN if any amount cell isn't a finite number (signals "still being typed")
 *   - the total otherwise
 */
export function lineItemsSum(
  lines: CanonicalInvoicePayload["line_items"],
): number | null {
  if (lines.length === 0) return null;
  let sum = 0;
  for (const l of lines) {
    const n = toMoney(l.amount);
    if (n == null) return Number.NaN;
    sum += n;
  }
  return sum;
}
