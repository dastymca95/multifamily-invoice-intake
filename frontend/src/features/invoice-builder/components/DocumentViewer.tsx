"use client";

import { FileText, MousePointerSquareDashed, Upload } from "lucide-react";
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";
import {
  findResolvedField,
  type InvoicePatternRegion,
  type InvoicePatternSourceFile,
  type InvoiceRegionBBox,
  newRegionId,
  type ResolvedField,
} from "@/types/invoice-pattern";

import { PdfPageCanvas } from "./PdfPageCanvas";

/**
 * Visual document viewer + region annotator.
 *
 * Image documents (PNG / JPG / etc.) render directly via `<img>`;
 * PDF documents render via PDF.js into a `<canvas>` (one page at a
 * time, lazy-loaded client-side — see `PdfPageCanvas`). In BOTH cases
 * the underlying media element uses `display: block; width: 100%;
 * height: auto` so the container's bounding rect EXACTLY matches the
 * rendered page rect — that's the coordinate-system anchor for the
 * bbox overlay layer.
 *
 * The operator drags to draw a new bbox; existing regions for the
 * active page render as overlay rectangles tinted to the field's
 * resolved color (canonical default → per-pattern override → hash-
 * fallback for customs without a color set). The viewer also doubles
 * as a drop target for additional source files; files dropped onto
 * the gray surface are forwarded to `onFilesDropped` (the parent
 * funnels them through `ingestFile`).
 *
 * State ownership: the viewer is a pure controlled component. It
 * draws what's in `regions` and emits `onRegionsChange` with the new
 * full list (replace-not-merge) on every edit. The editor owns the
 * canonical state.
 *
 * Coordinate system: bbox coordinates are normalized to [0, 1] of the
 * page's display rect. Mouse coordinates are translated using the
 * container's bounding rect, so the same region renders correctly
 * across viewport widths AND across image/PDF viewer kinds — both
 * paths preserve the container ↔ rendered-page rect equivalence.
 */
interface DocumentViewerProps {
  file: InvoicePatternSourceFile | null;
  page: number;
  regions: InvoicePatternRegion[];
  /** Field key (canonical or custom) that newly-drawn regions land on. */
  drawFieldKey: string;
  selectedRegionId: string | null;
  /**
   * FULL resolved field list (canonical + per-pattern overrides +
   * customs). Used to color region overlays + render their label
   * tags. Includes hidden fields so a region pinned to a hidden
   * built-in still shows its real label rather than "Unknown".
   */
  resolvedFields: readonly ResolvedField[];
  /** True while the parent is awaiting `ingestFile` for dropped files. */
  uploading?: boolean;
  disabled?: boolean;
  onRegionsChange: (next: InvoicePatternRegion[]) => void;
  onSelectRegion: (id: string | null) => void;
  /**
   * Files dropped onto the viewer surface. Parent validates +
   * ingests; viewer is purely a drop target. Receives the full
   * `File[]` so the parent can split good vs. bad in one place.
   */
  onFilesDropped: (files: File[]) => void;
}

interface DragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

/** Neutral fallback for a region whose field_key isn't in resolvedFields. */
const UNKNOWN_FIELD_COLOR = "#6b7280"; // gray-500
const UNKNOWN_FIELD_LABEL = "Unknown field";

export function DocumentViewer({
  file,
  page,
  regions,
  drawFieldKey,
  selectedRegionId,
  resolvedFields,
  uploading = false,
  disabled,
  onRegionsChange,
  onSelectRegion,
  onFilesDropped,
}: DocumentViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Counter rather than boolean so nested elements firing dragenter/
  // dragleave don't flicker the overlay. Increment on enter, decrement
  // on leave, show overlay when > 0.
  const [dropDepth, setDropDepth] = useState(0);

  // Filter to regions on the active page of the active file. The
  // pattern row may carry regions across multiple pages / files;
  // the viewer only renders the active slice.
  const visibleRegions = useMemo(
    () =>
      file
        ? regions.filter(
            (r) => r.source_file_id === file.id && r.page === page,
          )
        : [],
    [file, page, regions],
  );

  const isImage = file != null && file.mime_type.startsWith("image/");
  const isPdf = file != null && file.mime_type === "application/pdf";

  // ---- Mouse handlers (region drawing) -------------------------------

  const startDraw = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (disabled || !file) return;
      // Only left mouse, and only when the click landed on the page
      // surface itself (not on an existing region overlay).
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.dataset.regionInteractive === "true") return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;
      // Clamp so a click slightly outside the bounds (rare on the
      // edge) still produces a valid in-range start.
      const cx = Math.max(0, Math.min(1, nx));
      const cy = Math.max(0, Math.min(1, ny));
      setDrag({ startX: cx, startY: cy, currentX: cx, currentY: cy });
      // Clear selection on a fresh draw — selecting an existing
      // region is its own click handler on the overlay.
      onSelectRegion(null);
    },
    [disabled, file, onSelectRegion],
  );

  const moveDraw = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    setDrag((prev) => {
      if (!prev) return prev;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return prev;
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;
      return {
        ...prev,
        currentX: Math.max(0, Math.min(1, nx)),
        currentY: Math.max(0, Math.min(1, ny)),
      };
    });
  }, []);

  const endDraw = useCallback(() => {
    if (!drag || !file) {
      setDrag(null);
      return;
    }
    const bbox = normalizeBBox(
      drag.startX,
      drag.startY,
      drag.currentX,
      drag.currentY,
    );
    setDrag(null);
    // Reject vanishingly small drags — those are usually accidental
    // single clicks rather than intentional region drawings.
    if (bbox.w < 0.005 || bbox.h < 0.005) return;
    const region: InvoicePatternRegion = {
      id: newRegionId(),
      source_file_id: file.id,
      page,
      bbox,
      field_key: drawFieldKey,
      label: null,
      notes: null,
    };
    onRegionsChange([...regions, region]);
    onSelectRegion(region.id);
  }, [
    drag,
    file,
    page,
    drawFieldKey,
    regions,
    onRegionsChange,
    onSelectRegion,
  ]);

  // Cancel an in-flight drag if the mouse leaves the surface — keeps
  // a stale draft from sticking around when the user drags outside.
  const cancelDraw = useCallback(() => setDrag(null), []);

  // Global escape cancels the current drag.
  useEffect(() => {
    if (!drag) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrag(null);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [drag]);

  // ---- Drag-and-drop file handlers ----------------------------------
  //
  // Counter-based depth tracking means the overlay stays up across
  // dragenter/leave on nested children (image, region overlays).
  // `dragover` MUST preventDefault to make the drop event fire.

  const onDragEnterOuter = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      // Only count drags carrying files, not internal text/region
      // drags (region overlays don't currently emit drag events but
      // future region-resize handles might).
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDropDepth((d) => d + 1);
    },
    [],
  );

  const onDragOverOuter = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      // `copy` cursor signals "release to add a copy", which matches
      // the inline-data-URL upload model.
      e.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const onDragLeaveOuter = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (!hasFiles(e.dataTransfer)) return;
      setDropDepth((d) => Math.max(0, d - 1));
    },
    [],
  );

  const onDropOuter = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDropDepth(0);
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      onFilesDropped(files);
    },
    [onFilesDropped],
  );

  // ---- Render --------------------------------------------------------

  const dropping = dropDepth > 0;

  return (
    <div
      className="relative flex-1 min-h-0 overflow-auto bg-gray-200 p-4"
      onDragEnter={onDragEnterOuter}
      onDragOver={onDragOverOuter}
      onDragLeave={onDragLeaveOuter}
      onDrop={onDropOuter}
    >
      {!file ? (
        // Empty state — no file selected. Still a valid drop target
        // so the operator can drop a file directly into an empty
        // pattern.
        <div className="h-full min-h-[16rem] flex items-center justify-center text-gray-500">
          <div className="text-center max-w-sm">
            <MousePointerSquareDashed className="h-8 w-8 mx-auto text-gray-400 mb-2" />
            <p className="text-[12.5px] font-medium text-gray-700">
              Select a training document
            </p>
            <p className="text-[11px] text-gray-500 mt-1">
              Pick a file from the list above, drop one here, or
              upload a new one to start drawing regions.
            </p>
          </div>
        </div>
      ) : (
        <div
          ref={containerRef}
          // The page surface. For both images and PDFs, the natural
          // rendered height of the page element drives container
          // height (image's intrinsic aspect for `<img>`, PDF page's
          // viewport aspect for the canvas). Only the unknown-type
          // fallback forces a US Letter-ish aspect — otherwise the
          // container would collapse to 0 height with no overlay
          // surface.
          className={cn(
            "relative mx-auto bg-white shadow-md select-none",
            isImage || isPdf
              ? "max-w-3xl"
              : "max-w-3xl aspect-[8.5/11]",
            disabled ? "cursor-not-allowed" : "cursor-crosshair",
          )}
          onMouseDown={startDraw}
          onMouseMove={moveDraw}
          onMouseUp={endDraw}
          onMouseLeave={cancelDraw}
        >
          {/* ---- Page background -------------------------------------- */}
          {isImage && (
            // Inline image render. The img element takes full container
            // width; height grows naturally from the file's aspect.
            // Browser renders the data URL directly — no fetch needed.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={file.data_url}
              alt={file.file_name}
              className="block w-full h-auto pointer-events-none"
              draggable={false}
            />
          )}
          {isPdf && (
            // Real PDF render via PDF.js → canvas. Keyed by file.id +
            // page so a file/page switch fully remounts the canvas
            // component, which tears down the held PDFDocumentProxy
            // without manual bookkeeping. The canvas itself uses
            // `pointer-events: none` so mouse events fall through to
            // the container's draw handlers — same interaction model
            // as the image path.
            <PdfPageCanvas
              key={`${file.id}:${page}`}
              dataUrl={file.data_url}
              page={page}
            />
          )}
          {!isImage && !isPdf && <UnknownPlaceholder file={file} />}

          {/* ---- Existing region overlays ---------------------------- */}
          {visibleRegions.map((r) => {
            const resolved = findResolvedField(r.field_key, resolvedFields);
            const color = resolved?.color ?? UNKNOWN_FIELD_COLOR;
            const label = r.label?.trim()
              ? r.label
              : (resolved?.label ?? UNKNOWN_FIELD_LABEL);
            const isSelected = selectedRegionId === r.id;
            const isUnknown = resolved == null;
            const fillAlpha = isSelected ? 0.22 : 0.14;
            return (
              <button
                key={r.id}
                type="button"
                data-region-interactive="true"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectRegion(r.id);
                }}
                className={cn(
                  "absolute group cursor-pointer text-left",
                  "transition-shadow",
                  isSelected ? "shadow-md z-10" : "z-0",
                )}
                style={{
                  left: `${r.bbox.x * 100}%`,
                  top: `${r.bbox.y * 100}%`,
                  width: `${r.bbox.w * 100}%`,
                  height: `${r.bbox.h * 100}%`,
                  // Inline so dynamic palette colors don't need
                  // Tailwind safelisting. Selected = thicker border;
                  // unknown = dashed so the operator's eye picks it
                  // out as something that needs reassigning.
                  border: `${isSelected ? 3 : 2}px ${
                    isUnknown ? "dashed" : "solid"
                  } ${color}`,
                  backgroundColor: withAlpha(color, fillAlpha),
                }}
                title={isUnknown ? `${UNKNOWN_FIELD_LABEL} (${r.field_key})` : label}
              >
                <span
                  className={cn(
                    "absolute -top-[1.1rem] left-[-2px]",
                    "px-1 py-[1px] text-[9.5px] font-bold uppercase tracking-wide",
                    "rounded-t text-white",
                  )}
                  style={{ backgroundColor: color }}
                >
                  {label}
                </span>
              </button>
            );
          })}

          {/* ---- In-flight drag preview ------------------------------- */}
          {drag && (
            <div
              className="absolute pointer-events-none border-2 border-brand-600 bg-brand-500/20"
              style={previewStyle(drag)}
            />
          )}
        </div>
      )}

      {/* ---- Drop overlay (covers the entire scrollable area) ----- */}
      {dropping && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-brand-500/15 border-2 border-dashed border-brand-500 m-2 rounded-lg pointer-events-none"
          aria-hidden
        >
          <div className="bg-white/95 px-4 py-3 rounded-lg shadow text-center">
            <Upload className="h-6 w-6 mx-auto text-brand-600" />
            <p className="text-[13px] font-semibold text-gray-800 mt-1">
              {uploading ? "Reading file…" : "Drop to add training files"}
            </p>
            <p className="text-[11px] text-gray-500 mt-0.5">
              PDFs and images, up to 10 MB each.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unknown-type placeholder
// ---------------------------------------------------------------------------

function UnknownPlaceholder({ file }: { file: InvoicePatternSourceFile }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-50 text-center px-6">
      <FileText className="h-10 w-10 text-gray-300 mb-2" />
      <p className="text-[13px] font-medium text-gray-700">
        Unsupported preview
      </p>
      <p className="text-[11px] text-gray-500 mt-1 max-w-sm">
        {file.file_name} ({file.mime_type || "unknown type"}) — drawing
        is still available, but no preview is shown.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Normalize a drag (which may go in any direction) to a positive-w/h bbox. */
function normalizeBBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): InvoiceRegionBBox {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  return {
    x: clamp01(x),
    y: clamp01(y),
    w: Math.min(w, 1 - clamp01(x)),
    h: Math.min(h, 1 - clamp01(y)),
  };
}

function previewStyle(drag: DragState): React.CSSProperties {
  const bbox = normalizeBBox(
    drag.startX,
    drag.startY,
    drag.currentX,
    drag.currentY,
  );
  return {
    left: `${bbox.x * 100}%`,
    top: `${bbox.y * 100}%`,
    width: `${bbox.w * 100}%`,
    height: `${bbox.h * 100}%`,
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

/**
 * Convert a `#RRGGBB` hex into an `rgba(r, g, b, alpha)` string for
 * inline `style.backgroundColor` use. Falls back to the input string
 * if it doesn't match the expected shape — the renderer will then
 * carry whatever opacity the source color baked in.
 */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Drag-and-drop helpers
// ---------------------------------------------------------------------------

/**
 * True iff the drag carries one or more files. Filters out drags of
 * text / region overlays so the drop overlay never appears for in-app
 * drags. Different browsers populate `types` differently; "Files" is
 * the canonical entry but Safari has historically also used "Files"
 * — both branches handled below.
 */
function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  // `types` is a DOMStringList in some browsers and a string[] in
  // others — both indexable and have `length`, so the loop works.
  for (let i = 0; i < dt.types.length; i++) {
    if (dt.types[i] === "Files") return true;
  }
  return false;
}
