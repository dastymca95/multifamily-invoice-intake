/**
 * Lightweight document metadata probe used by the Upload visualizer.
 *
 * Honesty contract:
 *   - For PDFs we attempt a real page count via `pdf-lib` (dynamic import
 *     so the parser only loads on the Upload page). If parsing fails —
 *     encrypted PDF, malformed bytes, etc. — we return `null` page count
 *     and surface that as "—" in the UI rather than guessing.
 *   - For images we return 1 page; this is correct, not estimated.
 *   - For everything else (`unknown`) we return `null`.
 *
 * We deliberately do NOT try to render thumbnails or extract text here —
 * the page-count read is the only thing we promise.
 */

export type DocSource = "pdf" | "image" | "unknown";

export interface DocMeta {
  /** Real page count when known. `null` means we couldn't determine it. */
  pageCount: number | null;
  /** Where the count came from, for honest UI labels. */
  source: DocSource;
  /** Human-readable kind label ("PDF", "PNG", "Image", "File"). */
  kindLabel: string;
}

const PDF_MIME = new Set(["application/pdf", "application/x-pdf"]);
const IMAGE_PREFIX = "image/";

function _kindLabel(file: File): string {
  if (PDF_MIME.has(file.type)) return "PDF";
  if (file.type.startsWith(IMAGE_PREFIX)) {
    const sub = file.type.slice(IMAGE_PREFIX.length).toUpperCase();
    return sub || "Image";
  }
  // Fall back to the extension if MIME is empty/odd.
  const ext = file.name.includes(".")
    ? file.name.slice(file.name.lastIndexOf(".") + 1).toUpperCase()
    : "";
  return ext || "File";
}

async function _probePdfPageCount(file: File): Promise<number | null> {
  try {
    const bytes = await file.arrayBuffer();
    // Dynamic import so pdf-lib (~hundreds of KB) only ships when the
    // Upload page is actually visited.
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const count = pdf.getPageCount();
    return Number.isFinite(count) && count > 0 ? count : null;
  } catch {
    // Encrypted, malformed, or unsupported PDF variant — be honest.
    return null;
  }
}

export async function getDocumentMeta(file: File): Promise<DocMeta> {
  const kindLabel = _kindLabel(file);

  if (PDF_MIME.has(file.type)) {
    const pageCount = await _probePdfPageCount(file);
    return { pageCount, source: "pdf", kindLabel };
  }

  if (file.type.startsWith(IMAGE_PREFIX)) {
    return { pageCount: 1, source: "image", kindLabel };
  }

  return { pageCount: null, source: "unknown", kindLabel };
}
