/**
 * UI-facing status normalizers.
 *
 * Backend sources of truth:
 *   - Document.extraction_status: "pending" | "processing" | "extracted" | "failed"
 *   - Document.review_status:     "pending" | "in_review" | "approved" | "rejected"
 *   - Batch (no `status` column): derived from total/processed/failed counts
 *
 * Everything in this file folds those raw enums into a small set of human
 * labels + tone tokens that map to Badge colors. Centralizing this prevents
 * sprinkling switch statements across the UI.
 */

import type { Batch } from "@/types/batch";
import type { Document } from "@/types/document";

export type Tone = "gray" | "blue" | "green" | "yellow" | "red" | "purple";

export interface DisplayStatus {
  label: string;
  tone: Tone;
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

/**
 * Roll a Batch's counts into a single status the user can scan at a glance.
 *
 * Order matters: a batch with both processed and failed docs is reported as
 * "Partial" — that's the action signal (something needs attention) rather
 * than the success signal.
 */
export function displayBatchStatus(batch: Batch): DisplayStatus {
  const { total_documents: total, processed_documents: done, failed_documents: failed } = batch;

  if (total === 0) return { label: "Empty", tone: "gray" };
  if (failed > 0 && done + failed >= total) return { label: "Partial", tone: "yellow" };
  if (done >= total) return { label: "Complete", tone: "green" };
  if (done > 0) return { label: "In progress", tone: "blue" };
  return { label: "Pending", tone: "gray" };
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * Combined extraction + review status for a single document row.
 *
 * Failures and unsupported routes win — the user needs to see them first.
 * Otherwise we surface the review state, which is what the operator acts on.
 */
export function displayDocumentStatus(doc: Document): DisplayStatus {
  if (doc.route_used === "unsupported") return { label: "Unsupported", tone: "red" };
  if (doc.extraction_status === "failed") return { label: "Extraction failed", tone: "red" };
  if (doc.extraction_status === "pending" || doc.extraction_status === "processing") {
    return { label: "Extracting", tone: "yellow" };
  }
  // Extraction succeeded — fall through to the review state.
  switch (doc.review_status) {
    case "approved":
      return { label: "Approved", tone: "green" };
    case "rejected":
      return { label: "Rejected", tone: "red" };
    case "in_review":
      return { label: "In review", tone: "blue" };
    case "pending":
    default:
      return { label: "Needs review", tone: "yellow" };
  }
}

/** True if a human still has work to do on this document. */
export function documentNeedsReview(doc: Document): boolean {
  if (doc.extraction_status !== "extracted") return false;
  if (doc.route_used === "unsupported") return false;
  return doc.review_status === "pending" || doc.review_status === "in_review";
}

/** True if a reviewer has already made a final decision (approve or reject). */
export function documentIsReviewed(doc: Document): boolean {
  return doc.review_status === "approved" || doc.review_status === "rejected";
}

/** True if the document hit a problem the reviewer needs to triage. */
export function documentHasProblem(doc: Document): boolean {
  return doc.extraction_status === "failed" || doc.route_used === "unsupported";
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const ROUTE_LABELS: Record<Document["route_used"], string> = {
  native_pdf: "Native PDF",
  scanned_or_image: "Scan/Image",
  unsupported: "Unsupported",
};

export function displayRoute(route: Document["route_used"]): string {
  return ROUTE_LABELS[route] ?? route;
}
