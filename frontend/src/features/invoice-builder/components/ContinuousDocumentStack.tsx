"use client";

import { Upload } from "lucide-react";
import {
  type CSSProperties,
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
  normalizeExtractedFieldKey,
  regionShape,
  type ResolvedField,
} from "@/types/invoice-pattern";

import {
  ALL_RESIZE_HANDLES,
  clientToNormalizedPoint,
  normalizeBBoxFromCorners,
  type ResizeHandle,
  RESIZE_HANDLE_CURSORS,
  resizeBBoxFromHandle,
  translateBBox,
} from "../lib/geometry";
import {
  DEFAULT_VIEWER_TOOL,
  type ViewerTool,
  viewerToolDescriptor,
} from "../lib/viewer-tools";
import { PdfPageCanvas } from "./PdfPageCanvas";

/**
 * Continuous-vertical view of all visible pages in one source file.
 *
 * Renders the file's non-deleted pages stacked top-to-bottom inside a
 * single scroll container. Each page is its own draw surface (its own
 * normalized [0, 1] coordinate system anchored on its `containerRef`),
 * but the four tools — select / draw_rect / move / resize / pan — all
 * work the same as in single-page `DocumentViewer`. Only the polygon
 * placeholder is suppressed (not useful while skimming).
 *
 * Interaction state (`Interaction`) is owned by THIS component (not per
 * page) so a drag that crosses a page boundary still resolves cleanly
 * — the gesture's anchor page is captured at mousedown and never
 * re-evaluated mid-gesture. Mouse coordinates are translated against
 * the anchor page's bounding rect; the parent commit reads the gesture
 * page from the Interaction record.
 *
 * Pan: drags update the outer scroll container directly (the same
 * container that wraps all the page surfaces), so panning works across
 * the entire stack — not just within one page.
 *
 * Active-page tracking: an IntersectionObserver watches each page's
 * top edge as the operator scrolls; whichever page has the largest
 * intersection becomes the new "active" page (reported via
 * `onPageActivated`). Keeps the toolbar's page indicator + the right-
 * rail inspector consistent without a manual click.
 *
 * Performance: this component renders ALL non-deleted pages at once.
 * The PDF canvas component lazy-loads its own document, but for a
 * 50-page PDF that's still 50 simultaneous render tasks — the upgrade
 * spec caps continuous mode at "≤10 pages OK". Beyond that, we
 * surface a hint to switch to thumbnails / single mode.
 */
interface ContinuousDocumentStackProps {
  file: InvoicePatternSourceFile;
  /**
   * Visible (non-deleted) page numbers. The stack iterates this list
   * directly, so the parent's deleted-page filtering is the only
   * source of truth for which pages render.
   */
  visiblePages: readonly number[];
  regions: InvoicePatternRegion[];
  drawFieldKey: string;
  selectedRegionId: string | null;
  resolvedFields: readonly ResolvedField[];
  /**
   * Field-key set that the active Import Builder template scope binds
   * via at least one rule cell extraction binding. Drives the
   * "Linked"/"REQ" overlay badges. Same prop contract as
   * `DocumentViewer` — see that component's doc for details.
   */
  linkedFieldKeys?: ReadonlySet<string>;
  /** Subset of linked keys also used on at least one required column. */
  requiredFieldKeys?: ReadonlySet<string>;
  tool?: ViewerTool;
  zoom?: number;
  uploading?: boolean;
  onRegionsChange: (next: InvoicePatternRegion[]) => void;
  onSelectRegion: (id: string | null) => void;
  onFilesDropped: (files: File[]) => void;
  /**
   * Called when scroll-driven active-page tracking decides a different
   * page is now in view. Lets the parent keep its `activePage` state in
   * sync so a switch back to single-page mode lands on the page the
   * operator was scrolled to.
   */
  onPageActivated?: (page: number) => void;
}

/** Discriminated interaction state — same model as DocumentViewer. */
type Interaction =
  | { kind: "idle" }
  | {
      kind: "drawing";
      page: number;
      startX: number;
      startY: number;
      currentX: number;
      currentY: number;
    }
  | {
      kind: "moving";
      page: number;
      regionId: string;
      startBBox: InvoiceRegionBBox;
      startNormX: number;
      startNormY: number;
      currentBBox: InvoiceRegionBBox;
    }
  | {
      kind: "resizing";
      page: number;
      regionId: string;
      handle: ResizeHandle;
      startBBox: InvoiceRegionBBox;
      startNormX: number;
      startNormY: number;
      currentBBox: InvoiceRegionBBox;
    }
  | {
      kind: "panning";
      startScrollLeft: number;
      startScrollTop: number;
      startClientX: number;
      startClientY: number;
    };

const IDLE: Interaction = { kind: "idle" };
const UNKNOWN_FIELD_COLOR = "#6b7280";
const UNKNOWN_FIELD_LABEL = "Unknown field";
const BASE_PAGE_WIDTH_PX = 768;
/** Hint threshold — above this we suggest the operator switch modes. */
const PAGES_HINT_THRESHOLD = 10;

export function ContinuousDocumentStack({
  file,
  visiblePages,
  regions,
  drawFieldKey,
  selectedRegionId,
  resolvedFields,
  linkedFieldKeys,
  requiredFieldKeys,
  tool = DEFAULT_VIEWER_TOOL,
  zoom = 1,
  uploading = false,
  onRegionsChange,
  onSelectRegion,
  onFilesDropped,
  onPageActivated,
}: ContinuousDocumentStackProps) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  // Per-page container refs keyed by page number. We use refs (not
  // state) so re-renders mid-drag don't allocate new ref objects and
  // disrupt the gesture.
  const pageRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const [interaction, setInteraction] = useState<Interaction>(IDLE);
  const [dropDepth, setDropDepth] = useState(0);

  const isImage = file.mime_type.startsWith("image/");
  const isPdf = file.mime_type === "application/pdf";
  const isPolygonPlaceholder = tool === "draw_polygon";
  const interactive = !isPolygonPlaceholder;

  // Live override for in-flight move / resize. Same model as
  // DocumentViewer — render the in-progress geometry in place of the
  // persisted version, commit ONCE on mouseup so the undo stack gets
  // a single entry per drag.
  const liveOverride = useMemo(() => {
    if (interaction.kind === "moving" || interaction.kind === "resizing") {
      return {
        id: interaction.regionId,
        bbox: interaction.currentBBox,
      };
    }
    return null;
  }, [interaction]);

  // ------------------------------------------------------------------
  // Mouse handlers — all dispatched per-page so the page rect we
  // normalize against is the page the operator actually touched. The
  // gesture's anchor page is captured at mousedown and never re-
  // evaluated mid-gesture (so a drag that crosses a page boundary
  // still resolves coordinates against the anchor page's rect).
  // ------------------------------------------------------------------

  const onPageMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>, page: number) => {
      if (!interactive) return;
      if (e.button !== 0) return;
      const rect = pageRefs.current.get(page)?.getBoundingClientRect();
      if (!rect) return;

      const target = e.target as HTMLElement;
      if (target.dataset.resizeHandle) return;
      const onRegion = target.dataset.regionInteractive === "true";
      const point = clientToNormalizedPoint(e.clientX, e.clientY, rect);

      // Pan mode short-circuits: scroll the outer container.
      if (tool === "pan") {
        const outer = outerRef.current;
        if (!outer) return;
        e.preventDefault();
        setInteraction({
          kind: "panning",
          startScrollLeft: outer.scrollLeft,
          startScrollTop: outer.scrollTop,
          startClientX: e.clientX,
          startClientY: e.clientY,
        });
        return;
      }

      if (tool === "draw_rect") {
        if (onRegion) return;
        setInteraction({
          kind: "drawing",
          page,
          startX: point.x,
          startY: point.y,
          currentX: point.x,
          currentY: point.y,
        });
        onSelectRegion(null);
        return;
      }

      if (tool === "select") {
        if (!onRegion) {
          onSelectRegion(null);
          return;
        }
        const overlayId = target.dataset.regionId;
        if (overlayId && overlayId === selectedRegionId) {
          const region = regions.find((r) => r.id === overlayId);
          if (!region) return;
          if (regionShape(region) !== "rect") return;
          setInteraction({
            kind: "moving",
            page,
            regionId: region.id,
            startBBox: region.bbox,
            startNormX: point.x,
            startNormY: point.y,
            currentBBox: region.bbox,
          });
        }
        return;
      }
    },
    [interactive, tool, regions, selectedRegionId, onSelectRegion],
  );

  const onResizeHandleMouseDown = useCallback(
    (
      e: ReactMouseEvent<HTMLDivElement>,
      page: number,
      regionId: string,
      handle: ResizeHandle,
    ) => {
      if (!interactive || tool !== "select") return;
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const region = regions.find((r) => r.id === regionId);
      if (!region) return;
      const rect = pageRefs.current.get(page)?.getBoundingClientRect();
      if (!rect) return;
      const point = clientToNormalizedPoint(e.clientX, e.clientY, rect);
      setInteraction({
        kind: "resizing",
        page,
        regionId,
        handle,
        startBBox: region.bbox,
        startNormX: point.x,
        startNormY: point.y,
        currentBBox: region.bbox,
      });
    },
    [interactive, tool, regions],
  );

  // ------------------------------------------------------------------
  // Global mousemove / mouseup — drives the gesture forward + commits
  // it at the end. Same single-commit-per-gesture pattern as
  // DocumentViewer so undo gets one entry per drag.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (interaction.kind === "idle") return;

    const onMove = (e: MouseEvent) => {
      if (interaction.kind === "panning") {
        const outer = outerRef.current;
        if (!outer) return;
        const dx = e.clientX - interaction.startClientX;
        const dy = e.clientY - interaction.startClientY;
        outer.scrollLeft = interaction.startScrollLeft - dx;
        outer.scrollTop = interaction.startScrollTop - dy;
        return;
      }

      const rect = pageRefs.current
        .get(interaction.page)
        ?.getBoundingClientRect();
      if (!rect) return;
      const point = clientToNormalizedPoint(e.clientX, e.clientY, rect);

      if (interaction.kind === "drawing") {
        setInteraction({
          ...interaction,
          currentX: point.x,
          currentY: point.y,
        });
        return;
      }
      if (interaction.kind === "moving") {
        const dx = point.x - interaction.startNormX;
        const dy = point.y - interaction.startNormY;
        const next = translateBBox(interaction.startBBox, dx, dy);
        setInteraction({ ...interaction, currentBBox: next });
        return;
      }
      if (interaction.kind === "resizing") {
        const dx = point.x - interaction.startNormX;
        const dy = point.y - interaction.startNormY;
        const next = resizeBBoxFromHandle(
          interaction.startBBox,
          interaction.handle,
          dx,
          dy,
        );
        setInteraction({ ...interaction, currentBBox: next });
        return;
      }
    };

    const onUp = () => {
      if (interaction.kind === "drawing") {
        const bbox = normalizeBBoxFromCorners(
          { x: interaction.startX, y: interaction.startY },
          { x: interaction.currentX, y: interaction.currentY },
        );
        if (bbox.w >= 0.005 && bbox.h >= 0.005) {
          const region: InvoicePatternRegion = {
            id: newRegionId(),
            source_file_id: file.id,
            page: interaction.page,
            bbox,
            field_key: drawFieldKey,
            label: null,
            notes: null,
            shape: "rect",
            points: null,
          };
          onRegionsChange([...regions, region]);
          onSelectRegion(region.id);
        }
      } else if (interaction.kind === "moving") {
        const next = regions.map((r) =>
          r.id === interaction.regionId
            ? { ...r, bbox: interaction.currentBBox }
            : r,
        );
        const same =
          interaction.currentBBox.x === interaction.startBBox.x &&
          interaction.currentBBox.y === interaction.startBBox.y;
        if (!same) onRegionsChange(next);
      } else if (interaction.kind === "resizing") {
        const next = regions.map((r) =>
          r.id === interaction.regionId
            ? { ...r, bbox: interaction.currentBBox }
            : r,
        );
        const same =
          interaction.currentBBox.x === interaction.startBBox.x &&
          interaction.currentBBox.y === interaction.startBBox.y &&
          interaction.currentBBox.w === interaction.startBBox.w &&
          interaction.currentBBox.h === interaction.startBBox.h;
        if (!same) onRegionsChange(next);
      }
      setInteraction(IDLE);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [
    interaction,
    file.id,
    drawFieldKey,
    regions,
    onRegionsChange,
    onSelectRegion,
  ]);

  // Escape cancels the in-flight gesture.
  useEffect(() => {
    if (interaction.kind === "idle") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInteraction(IDLE);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [interaction]);

  // ------------------------------------------------------------------
  // Active-page tracking via IntersectionObserver. The page with the
  // largest intersection ratio becomes the new active page so the
  // toolbar's page indicator + the inspector stay in sync as the
  // operator scrolls.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!onPageActivated) return;
    const root = outerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the entry with the largest intersection ratio. Break ties
        // by smaller page number so a steady-scroll operator gets a
        // monotonic page indicator.
        let best: IntersectionObserverEntry | null = null;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          if (!best || e.intersectionRatio > best.intersectionRatio) {
            best = e;
          }
        }
        if (!best) return;
        const pageStr = (best.target as HTMLElement).dataset.page;
        if (!pageStr) return;
        const page = parseInt(pageStr, 10);
        if (!Number.isFinite(page)) return;
        onPageActivated(page);
      },
      {
        root,
        // Threshold list lets us pick "most visible" not just "any
        // visible" — 0.5 ensures we update once a page is at least
        // halfway in view.
        threshold: [0.25, 0.5, 0.75],
      },
    );
    // forEach (not for-of) for compat with the project's downlevel
    // tsconfig target — Map iterators require ES2015+ to iterate
    // directly via for-of without the downlevelIteration flag.
    pageRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
    // visiblePages drives observer scope; re-bind on change so a page
    // appearing / disappearing (delete) gets observed / unobserved.
  }, [visiblePages, onPageActivated]);

  // ------------------------------------------------------------------
  // Drag-and-drop file handlers (parent-side ingest).
  // ------------------------------------------------------------------

  const onDragEnterOuter = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
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

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const dropping = dropDepth > 0;
  const surfaceWidthPx = Math.max(50, BASE_PAGE_WIDTH_PX * zoom);
  const surfaceCursor = !interactive
    ? "not-allowed"
    : interaction.kind === "panning"
      ? "grabbing"
      : interaction.kind === "moving"
        ? "grabbing"
        : tool === "pan"
          ? "grab"
          : tool === "draw_rect"
            ? "crosshair"
            : "default";
  const toolDescriptor = viewerToolDescriptor(tool);
  const overPagesHint = visiblePages.length > PAGES_HINT_THRESHOLD;

  return (
    <div
      ref={outerRef}
      className="relative flex-1 min-h-0 overflow-auto bg-gray-200 p-4"
      onDragEnter={onDragEnterOuter}
      onDragOver={onDragOverOuter}
      onDragLeave={onDragLeaveOuter}
      onDrop={onDropOuter}
    >
      {overPagesHint && (
        <div className="mx-auto max-w-3xl mb-3 bg-amber-50 border border-amber-200 text-amber-800 text-[11.5px] px-3 py-2 rounded">
          Continuous mode is rendering all {visiblePages.length} visible
          pages at once. For large files, the thumbnails or single-page
          views are smoother.
        </div>
      )}

      <div className="space-y-4">
        {visiblePages.map((page) => {
          const visibleRegions = regions.filter(
            (r) => r.source_file_id === file.id && r.page === page,
          );
          return (
            <div
              key={`${file.id}:${page}`}
              data-page={page}
              ref={(el) => {
                if (el) pageRefs.current.set(page, el);
                else pageRefs.current.delete(page);
              }}
              className={cn(
                "relative mx-auto bg-white shadow-md select-none",
              )}
              style={{
                width: `${surfaceWidthPx}px`,
                maxWidth: "100%",
                cursor: surfaceCursor,
              }}
              onMouseDown={(e) => onPageMouseDown(e, page)}
            >
              {/* Page number badge — small label so the operator can
                  still tell which page they're on without the
                  paginator. */}
              <div className="absolute -top-[1.05rem] left-0 text-[10px] font-semibold uppercase text-gray-500 tracking-wide">
                Page {page}
              </div>

              {/* Page background */}
              {isImage && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={file.data_url}
                  alt={file.file_name}
                  className="block w-full h-auto pointer-events-none"
                  draggable={false}
                />
              )}
              {isPdf && (
                <PdfPageCanvas
                  key={`${file.id}:${page}`}
                  dataUrl={file.data_url}
                  page={page}
                />
              )}

              {/* Region overlays */}
              {visibleRegions.map((r) => {
                const resolved = findResolvedField(
                  r.field_key,
                  resolvedFields,
                );
                const color = resolved?.color ?? UNKNOWN_FIELD_COLOR;
                const label = r.label?.trim()
                  ? r.label
                  : (resolved?.label ?? UNKNOWN_FIELD_LABEL);
                const isSelected = selectedRegionId === r.id;
                const isUnknown = resolved == null;
                const fillAlpha = isSelected ? 0.22 : 0.14;
                const bboxToRender =
                  liveOverride && liveOverride.id === r.id
                    ? liveOverride.bbox
                    : r.bbox;
                const overlayCursor =
                  tool === "select" && isSelected ? "move" : "pointer";
                // Coverage badges — same contract as DocumentViewer.
                const normalizedFieldKey =
                  normalizeExtractedFieldKey(r.field_key) ?? r.field_key;
                const isLinked =
                  linkedFieldKeys?.has(r.field_key) ||
                  linkedFieldKeys?.has(normalizedFieldKey) ||
                  false;
                const isRequired =
                  requiredFieldKeys?.has(r.field_key) ||
                  requiredFieldKeys?.has(normalizedFieldKey) ||
                  false;
                return (
                  <button
                    key={r.id}
                    type="button"
                    data-region-interactive="true"
                    data-region-id={r.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectRegion(r.id);
                    }}
                    className={cn(
                      "absolute group text-left transition-shadow",
                      isSelected ? "shadow-md z-10" : "z-0",
                    )}
                    style={{
                      left: `${bboxToRender.x * 100}%`,
                      top: `${bboxToRender.y * 100}%`,
                      width: `${bboxToRender.w * 100}%`,
                      height: `${bboxToRender.h * 100}%`,
                      border: `${isSelected ? 3 : 2}px ${
                        isUnknown ? "dashed" : "solid"
                      } ${color}`,
                      backgroundColor: withAlpha(color, fillAlpha),
                      cursor: overlayCursor,
                    }}
                    title={
                      isUnknown
                        ? `${UNKNOWN_FIELD_LABEL} (${r.field_key})`
                        : label
                    }
                  >
                    <span
                      className={cn(
                        "absolute -top-[1.1rem] left-[-2px]",
                        "inline-flex items-stretch pointer-events-none",
                      )}
                    >
                      <span
                        className={cn(
                          "px-1 py-[1px] text-[9.5px] font-bold uppercase tracking-wide",
                          "rounded-tl text-white",
                          !(isRequired || isLinked) && "rounded-tr",
                        )}
                        style={{ backgroundColor: color }}
                      >
                        {label}
                      </span>
                      {(isRequired || isLinked) && (
                        <span
                          className={cn(
                            "px-1 py-[1px] text-[8.5px] font-bold uppercase tracking-wide",
                            "rounded-tr text-white",
                            isRequired ? "bg-amber-500" : "bg-emerald-600",
                          )}
                          title={
                            isRequired
                              ? "Bound to a required column on the selected template scope"
                              : "Bound to a column on the selected template scope"
                          }
                        >
                          {isRequired ? "REQ" : "Linked"}
                        </span>
                      )}
                    </span>
                    {isSelected &&
                      tool === "select" &&
                      regionShape(r) === "rect" &&
                      ALL_RESIZE_HANDLES.map((h) => (
                        <ContinuousResizeHandle
                          key={h}
                          handle={h}
                          onMouseDown={(e) =>
                            onResizeHandleMouseDown(e, page, r.id, h)
                          }
                        />
                      ))}
                  </button>
                );
              })}

              {/* In-flight draw preview — only on the page where the
                  draw started. */}
              {interaction.kind === "drawing" &&
                interaction.page === page && (
                  <div
                    className="absolute pointer-events-none border-2 border-brand-600 bg-brand-500/20"
                    style={drawingPreviewStyle(interaction)}
                  />
                )}
            </div>
          );
        })}
      </div>

      {/* Polygon-mode placeholder — same banner as DocumentViewer so
          the operator gets a consistent affordance across modes. */}
      {isPolygonPlaceholder && (
        <div
          className="absolute top-3 left-1/2 -translate-x-1/2 z-30 bg-white/95 backdrop-blur-sm border border-amber-300 px-3 py-1.5 rounded-md shadow text-[11.5px] text-amber-800 pointer-events-none"
          aria-live="polite"
        >
          {toolDescriptor.label} — coming soon. Switch tools to keep editing.
        </div>
      )}

      {/* File-drop overlay — same UX as DocumentViewer. */}
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
// Helpers — duplicated from DocumentViewer rather than exported. The
// two viewers' surface logic is structurally similar but differs enough
// (single page vs. stack, single rect vs. per-page rects) that sharing
// a render helper would force generic plumbing for marginal savings.
// ---------------------------------------------------------------------------

function ContinuousResizeHandle({
  handle,
  onMouseDown,
}: {
  handle: ResizeHandle;
  onMouseDown: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const positionStyle: CSSProperties = {
    position: "absolute",
    width: 9,
    height: 9,
    transform: "translate(-50%, -50%)",
    cursor: RESIZE_HANDLE_CURSORS[handle],
  };
  if (handle === "n" || handle === "nw" || handle === "ne") {
    positionStyle.top = 0;
  } else if (handle === "s" || handle === "sw" || handle === "se") {
    positionStyle.top = "100%";
  } else {
    positionStyle.top = "50%";
  }
  if (handle === "w" || handle === "nw" || handle === "sw") {
    positionStyle.left = 0;
  } else if (handle === "e" || handle === "ne" || handle === "se") {
    positionStyle.left = "100%";
  } else {
    positionStyle.left = "50%";
  }
  return (
    <div
      data-resize-handle={handle}
      role="presentation"
      style={positionStyle}
      className="bg-white border border-brand-600 rounded-[2px] shadow-sm"
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function drawingPreviewStyle(
  interaction: Extract<Interaction, { kind: "drawing" }>,
): CSSProperties {
  const bbox = normalizeBBoxFromCorners(
    { x: interaction.startX, y: interaction.startY },
    { x: interaction.currentX, y: interaction.currentY },
  );
  return {
    left: `${bbox.x * 100}%`,
    top: `${bbox.y * 100}%`,
    width: `${bbox.w * 100}%`,
    height: `${bbox.h * 100}%`,
  };
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (let i = 0; i < dt.types.length; i++) {
    if (dt.types[i] === "Files") return true;
  }
  return false;
}
