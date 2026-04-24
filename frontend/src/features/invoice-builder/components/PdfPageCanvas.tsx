"use client";

import { Loader2, FileWarning } from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  dataUrlToUint8Array,
  loadPdfjs,
} from "../lib/pdfjs";

/**
 * Render a single PDF page into a `<canvas>` and let the parent
 * container drive its CSS width.
 *
 * Sizing model — intentionally minimal so it composes cleanly with the
 * existing image path in `DocumentViewer`:
 *
 *   * Canvas HTML attributes (`width` / `height`) carry the BITMAP
 *     pixel dimensions, sized at devicePixelRatio for crispness on
 *     hi-DPI displays.
 *   * Canvas CSS: `display: block; width: 100%; height: auto`. The
 *     browser preserves the bitmap aspect ratio so the rendered CSS
 *     height follows naturally from the parent's width.
 *   * Result: the parent container's bounding rect EXACTLY matches the
 *     rendered page rect — same coordinate-system contract as the
 *     image path, so the existing bbox-overlay logic in
 *     `DocumentViewer` works unchanged.
 *
 * Why a dedicated subcomponent rather than inlining PDF.js into
 * `DocumentViewer`:
 *
 *   * Lifecycle isolation. Caller passes `key={file.id}` so a
 *     file switch fully remounts the component, tearing down the
 *     PDF document handle without manual bookkeeping.
 *   * Render-task cancellation. Page flips can happen mid-render; the
 *     in-flight `RenderTask` is cancelled in the page-change effect
 *     cleanup so a stale paint can't land on the new canvas.
 *   * SSR safety. The dynamic `import("pdfjs-dist")` lives behind
 *     `loadPdfjs()` and only runs from `useEffect` — guaranteed
 *     client-side.
 */
interface PdfPageCanvasProps {
  /** Full data URL `data:application/pdf;base64,…` from the source file. */
  dataUrl: string;
  /** 1-based page index. Out-of-range falls back to clamping. */
  page: number;
  /**
   * Notified once the document loads, with the total page count. Lets
   * the parent reconcile its pagination state with the document's
   * actual page count when the persisted `page_count` is stale.
   */
  onPageCountResolved?: (numPages: number) => void;
}

/**
 * Default bitmap pixel width to render at. The CSS layer is
 * width: 100% so this only governs OUTPUT FIDELITY at the
 * largest expected viewport — not the visible size. 1600px is
 * a comfortable trade between crispness on a typical 1080p
 * display and PDF.js render time on big pages.
 */
const TARGET_BITMAP_WIDTH = 1600;

export function PdfPageCanvas({
  dataUrl,
  page,
  onPageCountResolved,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Hold the loaded document on a ref so page-flip effects can re-use
  // it without re-loading the (possibly large) PDF blob.
  const docRef = useRef<{
    pdf: import("pdfjs-dist").PDFDocumentProxy;
    dataUrl: string;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);

  // ------------------------------------------------------------------
  // Document load — reruns whenever the data URL changes (caller-side
  // file switch). Holds the `PDFDocumentProxy` on a ref so subsequent
  // page-flip renders can skip the heavy load step.
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNumPages(0);

    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const data = dataUrlToUint8Array(dataUrl);
        const loadingTask = pdfjs.getDocument({ data });
        const pdf = await loadingTask.promise;
        if (cancelled) {
          // Moved on before load finished — release worker memory.
          void pdf.destroy();
          return;
        }
        if (docRef.current && docRef.current.pdf !== pdf) {
          void docRef.current.pdf.destroy();
        }
        docRef.current = { pdf, dataUrl };
        setNumPages(pdf.numPages);
        onPageCountResolved?.(pdf.numPages);
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "Could not render PDF preview.";
        setError(msg);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // onPageCountResolved intentionally omitted — including it in the
    // dep array would force a full document reload every time the
    // parent's callback identity changed, defeating the cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUrl]);

  // ------------------------------------------------------------------
  // Page render — reruns on `page` change OR when the document load
  // completes (`numPages` flips from 0). The render task is cancelled
  // in cleanup so an in-flight paint can't land on the new canvas
  // after a fast page flip.
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let renderTask: import("pdfjs-dist").RenderTask | null = null;

    (async () => {
      const doc = docRef.current;
      if (!doc) return;
      if (numPages === 0) return;

      const safePage = Math.min(Math.max(1, page), doc.pdf.numPages);
      try {
        const pdfPage = await doc.pdf.getPage(safePage);
        if (cancelled) return;

        // Compute the bitmap-pixel viewport. Aspect ratio is preserved
        // by the canvas's HTML attributes; the CSS layer is 100% wide
        // and `height: auto` so the browser scales correctly to the
        // parent container's width.
        const baseViewport = pdfPage.getViewport({ scale: 1 });
        const dpr =
          typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        // Bitmap target: TARGET_BITMAP_WIDTH × DPR for hi-DPI crispness.
        // The canvas's CSS layer scales DOWN to the parent width, so
        // a larger bitmap costs only render time, not display size.
        const bitmapScale = (TARGET_BITMAP_WIDTH * dpr) / baseViewport.width;
        const bitmapViewport = pdfPage.getViewport({ scale: bitmapScale });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("Canvas 2D context is unavailable.");
        }
        canvas.width = Math.floor(bitmapViewport.width);
        canvas.height = Math.floor(bitmapViewport.height);
        // Clear before re-paint so a stale partial render doesn't
        // bleed through if cancellation lands mid-paint.
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        renderTask = pdfPage.render({
          canvasContext: ctx,
          viewport: bitmapViewport,
        });
        await renderTask.promise;
        if (cancelled) return;
        setLoading(false);
      } catch (err) {
        // PDF.js throws `RenderingCancelledException` when we cancel.
        // Treat that as expected — only surface real failures.
        const name = (err as { name?: string } | null)?.name;
        if (cancelled || name === "RenderingCancelledException") return;
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "Could not render PDF page.";
        setError(msg);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // cancel can throw if the task already settled — ignore.
        }
      }
    };
  }, [page, numPages]);

  // Tear down the held document on full unmount.
  useEffect(() => {
    return () => {
      if (docRef.current) {
        void docRef.current.pdf.destroy();
        docRef.current = null;
      }
    };
  }, []);

  // ------------------------------------------------------------------
  // Render
  //
  // The canvas is ALWAYS in the DOM (not gated behind a loading
  // sentinel) so the render effect can find it via `canvasRef` on the
  // first pass. Loading / error overlays absolutely position over it
  // and clear themselves once a paint lands.
  //
  // Until the first render lands, the canvas has the placeholder
  // default attributes (850×1100 ~ US Letter aspect) so the layout
  // doesn't briefly collapse to 0×0 — important because the parent
  // container's bounding rect is the coordinate-system anchor for
  // the bbox overlay layer in `DocumentViewer`.
  // ------------------------------------------------------------------
  const overlayStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(255,255,255,0.85)",
    pointerEvents: "none",
  };

  return (
    <div className="relative w-full">
      <canvas
        ref={canvasRef}
        // Bitmap defaults — 850×1100 (~US Letter aspect at 100dpi)
        // keeps the layout from collapsing before the first PDF page
        // render lands. The render effect overwrites width/height
        // with the actual viewport bitmap dimensions.
        width={850}
        height={1100}
        className="block w-full h-auto pointer-events-none"
      />
      {error ? (
        <div style={overlayStyle}>
          <div className="text-center px-4">
            <FileWarning className="h-8 w-8 mx-auto text-amber-500 mb-1.5" />
            <p className="text-[12.5px] font-medium text-gray-700">
              Could not render PDF preview.
            </p>
            <p
              className="text-[10.5px] text-gray-500 mt-1 max-w-xs mx-auto"
              title={error}
            >
              {error}
            </p>
          </div>
        </div>
      ) : loading ? (
        <div style={overlayStyle}>
          <p className="text-[12px] text-gray-600 inline-flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading PDF page…
          </p>
        </div>
      ) : null}
    </div>
  );
}
