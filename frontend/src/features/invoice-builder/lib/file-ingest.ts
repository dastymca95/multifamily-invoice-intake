/**
 * Centralized file ingestion for the Invoice Builder.
 *
 * Both the "+ New pattern" modal and the in-editor "Add file" / drag-
 * and-drop paths feed through here. Centralizing prevents drift between
 * the modal's read-and-validate pipeline and the editor's — they MUST
 * produce identical `InvoicePatternSourceFile` records (same page-count
 * probe, same size cap, same data-URL shape) or saved regions can
 * silently misalign across upload paths.
 *
 * What this does, in order:
 *   1. Type / extension validation. Operators upload PDF and image
 *      formats; anything else is rejected with a specific error so the
 *      drop overlay can surface it.
 *   2. Size cap (10 MB) — hard-stop before reading. A 50 MB scanned
 *      PDF would otherwise blow up the JSONB row.
 *   3. Read as base64 data URL.
 *   4. PDF page-count probe via `pdfjs.probePdfPageCount`. The probe
 *      result lights up the multi-page navigator in the editor; if it
 *      throws (corrupt PDF), the caller still gets a usable record
 *      with `page_count = 1` and the operator sees the failure in the
 *      viewer (where a render error reads more naturally than at
 *      upload).
 *
 * Returns a plain `InvoicePatternSourceFile` ready to push into the
 * pattern's `source_files` array. No state, no side effects beyond
 * the PDF.js worker spin-up that `loadPdfjs()` caches.
 */

import {
  formatFileSize,
  type InvoicePatternSourceFile,
  MAX_PATTERN_FILE_SIZE_BYTES,
  newSourceFileId,
  readFileAsDataUrl,
} from "@/types/invoice-pattern";

import { probePdfPageCount } from "./pdfjs";

/** Mime-type predicate for the accepted upload set. */
export function isAcceptedFileType(file: File): boolean {
  const mt = file.type.toLowerCase();
  if (mt === "application/pdf") return true;
  if (mt.startsWith("image/")) return true;
  // Some browsers / file systems leave `file.type` blank; fall back to
  // extension sniffing so a *.pdf or *.png drag still ingests cleanly.
  const lower = file.name.toLowerCase();
  return (
    lower.endsWith(".pdf") ||
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".bmp")
  );
}

/** Effective mime type used when persisting — falls back from extension. */
function resolveMimeType(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "application/octet-stream";
}

/**
 * Custom error subclass so callers can branch on validation failures
 * (e.g. show a drop-overlay error toast for `IngestError`, but a
 * generic "Couldn't read file" for unknown failures).
 */
export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

/**
 * Validate + read + (PDF-only) probe a single file. Resolves to a
 * fully-populated `InvoicePatternSourceFile`.
 *
 * Errors:
 *   * `IngestError("Unsupported file type …")`    — wrong mime / ext.
 *   * `IngestError("Too large (max …) …")`         — over the 10 MB cap.
 *   * Any error from `readFileAsDataUrl` re-thrown verbatim.
 */
export async function ingestFile(
  file: File,
): Promise<InvoicePatternSourceFile> {
  if (!isAcceptedFileType(file)) {
    throw new IngestError(
      `Unsupported file type — ${file.name} (${file.type || "unknown type"}). ` +
        `Drop a PDF or image file.`,
    );
  }
  if (file.size > MAX_PATTERN_FILE_SIZE_BYTES) {
    throw new IngestError(
      `${file.name}: too large (max ${formatFileSize(MAX_PATTERN_FILE_SIZE_BYTES)})`,
    );
  }

  const dataUrl = await readFileAsDataUrl(file);
  const mimeType = resolveMimeType(file);

  let pageCount = 1;
  if (mimeType === "application/pdf") {
    try {
      pageCount = await probePdfPageCount(file);
    } catch {
      // Corrupt or unreadable PDF — keep ingest alive; the editor
      // will surface the render failure in the viewer.
      pageCount = 1;
    }
  }

  return {
    id: newSourceFileId(),
    file_name: file.name,
    mime_type: mimeType,
    size_bytes: file.size,
    page_count: pageCount,
    data_url: dataUrl,
  };
}
