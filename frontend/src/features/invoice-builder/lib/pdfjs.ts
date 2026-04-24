/**
 * Client-only PDF.js loader.
 *
 * `pdfjs-dist` is heavy (~1.3 MB minified worker) and reaches into
 * browser-only globals (Worker, fetch, atob) at import time, so we
 * never want it to land in the SSR bundle. Two safeguards:
 *
 *   1. The actual ESM import runs INSIDE `loadPdfjs()` via dynamic
 *      `import("pdfjs-dist")`. Code that calls this function is
 *      itself a client-only React component (`"use client"`), and the
 *      dynamic import keeps the module out of any server-rendered
 *      bundle path.
 *
 *   2. The worker URL is configured exactly once on first load,
 *      pinned to the EXACT installed `pdfjs-dist` version via
 *      `pdfjsLib.version`. Loading a worker whose version differs
 *      from the host module is a known PDF.js failure mode ("Cannot
 *      load script") so version interpolation is non-negotiable.
 *
 * Worker hosting strategy: unpkg CDN, pinned by version. Trade-offs:
 *
 *   * Pro: zero build-config changes — Next.js doesn't have a built-in
 *     story for shipping a `.mjs` worker as a static asset without
 *     either copying the 1.3 MB binary into `public/` (committed
 *     blob, version-skew risk on `pdfjs-dist` upgrades that don't
 *     update the copy) or wrangling the webpack config.
 *   * Con: runtime network dependency on `unpkg.com`. Acceptable for
 *     the prototype phase; production swap is a one-line change.
 *
 * Module-level promise cache means the dynamic import + worker
 * configuration happen ONCE per session, not once per `<PdfPageCanvas>`
 * mount. Subsequent callers await the resolved cached promise.
 */

type PdfjsModule = typeof import("pdfjs-dist");

let pdfjsModulePromise: Promise<PdfjsModule> | null = null;

export function loadPdfjs(): Promise<PdfjsModule> {
  if (pdfjsModulePromise) return pdfjsModulePromise;
  pdfjsModulePromise = import("pdfjs-dist").then((mod) => {
    // Configure the worker exactly once. `mod.version` matches the
    // installed `pdfjs-dist` package.json version, so the unpkg URL
    // can never drift from the host module.
    if (typeof window !== "undefined" && !mod.GlobalWorkerOptions.workerSrc) {
      mod.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${mod.version}/build/pdf.worker.min.mjs`;
    }
    return mod;
  });
  return pdfjsModulePromise;
}

/**
 * Decode a `data:<mime>;base64,<payload>` URL into a `Uint8Array`
 * that PDF.js's `getDocument({ data })` accepts. Throws a descriptive
 * error if the input doesn't look like a base64 data URL — surfaces
 * cleanly into the viewer's error state.
 *
 * Why we don't just hand the data URL to PDF.js directly: `getDocument`
 * supports `{ url }` for fetchable URLs but data URLs of any meaningful
 * size are slow / brittle there because the worker re-fetches the URL
 * (parsing megabytes of base64 every time). Decoding once on the main
 * thread and handing the worker a `Uint8Array` is both faster and
 * works around the data-URL fetch quirks.
 */
export function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const commaIdx = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || commaIdx < 0) {
    throw new Error("Source file is not a base64 data URL.");
  }
  const meta = dataUrl.slice(0, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  if (!meta.includes(";base64")) {
    // Non-base64 data URLs are rare for PDFs but possible — decode the
    // URL-encoded payload via decodeURIComponent → TextEncoder.
    const decoded = decodeURIComponent(payload);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  }
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Probe a PDF file (or already-decoded bytes) for its `numPages`
 * metadata, then immediately destroy the document to free the worker.
 *
 * This is a separate, lightweight call from the full `<PdfPageCanvas>`
 * render path because the upload pipeline needs the page count BEFORE
 * the editor renders any page — to populate `source_file.page_count`
 * so multi-page nav lights up right after drop, and so saved regions
 * can never reference an out-of-range page.
 *
 * Throws on a malformed PDF; the caller (file ingest) catches and
 * falls back to `page_count = 1` so a corrupt file still uploads
 * (the operator sees the render error in the viewer, not at ingest).
 */
export async function probePdfPageCount(
  source: File | Uint8Array,
): Promise<number> {
  const pdfjs = await loadPdfjs();
  const data =
    source instanceof Uint8Array
      ? source
      : new Uint8Array(await source.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;
  try {
    return pdf.numPages;
  } finally {
    // Free worker memory immediately — we don't keep the doc handle
    // around after the probe; the editor's full render path opens its
    // own (cached on `<PdfPageCanvas>`).
    void pdf.destroy();
  }
}
