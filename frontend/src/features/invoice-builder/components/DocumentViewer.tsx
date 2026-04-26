"use client";

import { FileText, MousePointerSquareDashed, Upload } from "lucide-react";
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
 * Tool modes (see `viewer-tools.ts`):
 *
 *   * `"select"`     — Click a region to select it; drag inside a
 *                      selected region to move it; drag a corner /
 *                      side handle to resize. Clicking empty space
 *                      clears the selection.
 *   * `"draw_rect"`  — Drag empty space to draw a new rectangle.
 *   * `"pan"`        — Drag anywhere to scroll the outer viewport
 *                      (mouse wheel still works; this is for trackpads
 *                      and operators that prefer a hand-drag pan).
 *   * `"draw_polygon"` — Currently a placeholder (the data model
 *                      accepts polygons but the editor surface is
 *                      deferred). When this mode is active the
 *                      surface refuses interactions.
 *
 * Zoom: the parent passes a `zoom` factor (1.0 = 100%). The page
 * surface's CSS width is scaled accordingly; because the overlay
 * layer uses CSS percentage positioning relative to that surface,
 * region rectangles scale "for free" without per-overlay math.
 *
 * State ownership: the viewer is a controlled component for the
 * region list — it emits `onRegionsChange` with the new full array
 * (replace-not-merge) ONCE per gesture (single click, complete drag).
 * Calling once per gesture (rather than once per `mousemove`) keeps
 * the parent's undo stack tidy: one drag = one history entry.
 *
 * During an in-flight move / resize the viewer renders the in-progress
 * region from a LOCAL override so the visual feedback is immediate.
 * The override is dropped on `mouseup` after `onRegionsChange` lands.
 *
 * Coordinate system: bbox coordinates are normalized to [0, 1] of the
 * page's display rect. Mouse coordinates are translated using the
 * container's bounding rect — the same coordinate system survives
 * zoom, viewport-width changes, and image vs. PDF media kinds.
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
  /**
   * Field-key set referenced by at least one rule cell extraction
   * binding under the current Import Builder template scope (or every
   * template when scope is "All"). Drives the "Linked" badge on each
   * region's overlay tag — operator sees at a glance which regions
   * are actually wired up. Empty set ⇒ no badges.
   */
  linkedFieldKeys?: ReadonlySet<string>;
  /**
   * Subset of `linkedFieldKeys` that ALSO appears under at least one
   * REQUIRED column in the current scope. Drives the amber "REQ"
   * variant of the badge. Always a subset of `linkedFieldKeys`.
   */
  requiredFieldKeys?: ReadonlySet<string>;
  /** Active tool — drives mouse handler interpretation + cursor. */
  tool?: ViewerTool;
  /** Zoom factor relative to base width. 1.0 = 100%. */
  zoom?: number;
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

/**
 * In-progress mouse interaction. Discriminated so the move handler
 * can dispatch on `kind` without branching on multiple booleans.
 */
type Interaction =
  | { kind: "idle" }
  | {
      kind: "drawing";
      startX: number;
      startY: number;
      currentX: number;
      currentY: number;
    }
  | {
      kind: "moving";
      regionId: string;
      startBBox: InvoiceRegionBBox;
      startNormX: number;
      startNormY: number;
      currentBBox: InvoiceRegionBBox;
    }
  | {
      kind: "resizing";
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

/** Neutral fallback for a region whose field_key isn't in resolvedFields. */
const UNKNOWN_FIELD_COLOR = "#6b7280"; // gray-500
const UNKNOWN_FIELD_LABEL = "Unknown field";

/**
 * Base CSS width for the page surface at zoom = 1.0. Matches the
 * legacy `max-w-3xl` (48rem = 768px). Zoom multiplies this; the
 * outer container (`overflow-auto`) handles scrolling when the
 * scaled surface exceeds the viewport.
 */
const BASE_PAGE_WIDTH_PX = 768;

export function DocumentViewer({
  file,
  page,
  regions,
  drawFieldKey,
  selectedRegionId,
  resolvedFields,
  linkedFieldKeys,
  requiredFieldKeys,
  tool = DEFAULT_VIEWER_TOOL,
  zoom = 1,
  uploading = false,
  disabled,
  onRegionsChange,
  onSelectRegion,
  onFilesDropped,
}: DocumentViewerProps) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [interaction, setInteraction] = useState<Interaction>(IDLE);
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

  // Live override for the region currently being moved / resized.
  // We render the override in place of the persisted version so the
  // visual feedback is immediate, but only commit ONCE per gesture
  // (on mouseup) to keep the undo stack tidy.
  const liveOverride = useMemo(() => {
    if (interaction.kind === "moving" || interaction.kind === "resizing") {
      return {
        id: interaction.regionId,
        bbox: interaction.currentBBox,
      };
    }
    return null;
  }, [interaction]);

  const isImage = file != null && file.mime_type.startsWith("image/");
  const isPdf = file != null && file.mime_type === "application/pdf";

  const isPolygonPlaceholder = tool === "draw_polygon";
  const interactive = !disabled && file != null && !isPolygonPlaceholder;

  // ---- Mouse handlers (dispatch on tool mode) ------------------------

  const onSurfaceMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!interactive) return;
      if (e.button !== 0) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const target = e.target as HTMLElement;
      // Resize-handle clicks dispatch their own onMouseDown handler
      // (see ResizeHandleSquare). They stopPropagation so this branch
      // never fires for them, but defensively bail just in case.
      if (target.dataset.resizeHandle) return;

      const onRegion = target.dataset.regionInteractive === "true";
      const point = clientToNormalizedPoint(e.clientX, e.clientY, rect);

      // Pan mode short-circuits everything — drag scrolls the outer
      // viewport regardless of what we're hovering.
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
        // Don't draw on top of an existing region overlay — let the
        // overlay's own click handler take selection instead.
        if (onRegion) return;
        setInteraction({
          kind: "drawing",
          startX: point.x,
          startY: point.y,
          currentX: point.x,
          currentY: point.y,
        });
        // Clear selection on a fresh draw.
        onSelectRegion(null);
        return;
      }

      // Select mode (default): clicking empty space clears selection;
      // clicking a region is handled by the region's own click handler
      // (selection is set there); dragging on the SELECTED region
      // initiates a move (handled below by checking the region under
      // the click).
      if (tool === "select") {
        if (!onRegion) {
          onSelectRegion(null);
          return;
        }
        // Check if we clicked on the currently-selected region — if
        // so, prep a move. Otherwise let the click handler on the
        // overlay handle selection.
        const overlayId = target.dataset.regionId;
        if (
          overlayId &&
          overlayId === selectedRegionId &&
          file != null
        ) {
          const region = regions.find((r) => r.id === overlayId);
          if (!region) return;
          // Only rect regions are draggable today (polygon UI deferred).
          if (regionShape(region) !== "rect") return;
          setInteraction({
            kind: "moving",
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
    [
      interactive,
      tool,
      file,
      regions,
      selectedRegionId,
      onSelectRegion,
    ],
  );

  const onResizeHandleMouseDown = useCallback(
    (
      e: ReactMouseEvent<HTMLDivElement>,
      regionId: string,
      handle: ResizeHandle,
    ) => {
      if (!interactive || tool !== "select") return;
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const region = regions.find((r) => r.id === regionId);
      if (!region) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const point = clientToNormalizedPoint(e.clientX, e.clientY, rect);
      setInteraction({
        kind: "resizing",
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

  // Global mousemove/mouseup. Listening on the document keeps the
  // gesture alive even if the cursor leaves the page surface mid-drag
  // (which `containerRef.onMouseLeave` would otherwise cancel).
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

      const rect = containerRef.current?.getBoundingClientRect();
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
      // Commit the gesture's effect to the parent's region list ONCE
      // here so the undo stack gets a single entry per drag.
      if (interaction.kind === "drawing" && file != null) {
        const bbox = normalizeBBoxFromCorners(
          { x: interaction.startX, y: interaction.startY },
          { x: interaction.currentX, y: interaction.currentY },
        );
        // Reject vanishingly small drags — accidental single clicks.
        if (bbox.w >= 0.005 && bbox.h >= 0.005) {
          const region: InvoicePatternRegion = {
            id: newRegionId(),
            source_file_id: file.id,
            page,
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
        // No-op when the move resolved to zero delta (operator clicked
        // and released without dragging — common when re-selecting).
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
    file,
    page,
    drawFieldKey,
    regions,
    onRegionsChange,
    onSelectRegion,
  ]);

  // Global escape cancels the current drag.
  useEffect(() => {
    if (interaction.kind === "idle") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInteraction(IDLE);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [interaction]);

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
  const toolDescriptor = viewerToolDescriptor(tool);

  // Cursor for the page surface depends on the active tool + drag state.
  // During a pan-drag the cursor switches from `grab` to `grabbing` so
  // the operator gets the same affordance feedback as PDF readers.
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

  // Page-surface width — multiplied by zoom so the overlay layer (which
  // uses CSS percentages) scales for free. Floors at the base width's
  // 50% lower bound so a degenerate zoom can never collapse the surface.
  const surfaceWidthPx = Math.max(50, BASE_PAGE_WIDTH_PX * zoom);

  return (
    <div
      ref={outerRef}
      // Workspace surrounding the page. Light: subtle gray to make the
      // white page pop. Dark: deep slate so the page reads as the
      // bright "real document" inside a dim workspace. CRITICAL: the
      // PDF page surface itself stays bg-white in both themes — see
      // the inner `containerRef` div below — because it represents the
      // actual document, not chrome.
      className="relative flex-1 min-h-0 overflow-auto bg-gray-200 p-4 dark:bg-surface"
      onDragEnter={onDragEnterOuter}
      onDragOver={onDragOverOuter}
      onDragLeave={onDragLeaveOuter}
      onDrop={onDropOuter}
    >
      {!file ? (
        // Empty state — no file selected. Still a valid drop target
        // so the operator can drop a file directly into an empty
        // pattern.
        <div className="h-full min-h-[16rem] flex items-center justify-center text-gray-500 dark:text-ink-subtle">
          <div className="text-center max-w-sm">
            <MousePointerSquareDashed className="h-8 w-8 mx-auto text-gray-400 dark:text-ink-subtle mb-2" />
            <p className="text-[12.5px] font-medium text-gray-700 dark:text-ink">
              Select a training document
            </p>
            <p className="text-[11px] text-gray-500 dark:text-ink-muted mt-1">
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
          //
          // bg-white stays in BOTH themes here on purpose — this is the
          // real document, not app chrome, and inverting it would make
          // PDF text unreadable.
          className={cn(
            "relative mx-auto bg-white shadow-md select-none",
            !isImage && !isPdf && "aspect-[8.5/11]",
          )}
          style={{
            width: `${surfaceWidthPx}px`,
            maxWidth: "100%",
            cursor: surfaceCursor,
          }}
          onMouseDown={onSurfaceMouseDown}
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
            // Association badges — mirror the Import Builder coverage
            // for this pattern under the active template scope. Linked
            // = some rule cell binds this field; REQ = at least one of
            // those bindings sits on a required column. The two badges
            // are mutually-inclusive (REQ implies Linked) so we render
            // REQ instead of Linked when both apply — keeps the
            // overlay tight.
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
            // Prefer the live override geometry when the operator is
            // mid-drag on this region — keeps the visual feedback in
            // sync with the cursor before commit.
            const bboxToRender =
              liveOverride && liveOverride.id === r.id
                ? liveOverride.bbox
                : r.bbox;
            // Cursor: in select mode, hovering an unselected region
            // hints "click to select" (default); the SELECTED region
            // hints "drag to move".
            const overlayCursor =
              tool === "select" && isSelected ? "move" : "pointer";
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
                  "absolute group text-left",
                  "transition-shadow",
                  isSelected ? "shadow-md z-10" : "z-0",
                )}
                style={{
                  left: `${bboxToRender.x * 100}%`,
                  top: `${bboxToRender.y * 100}%`,
                  width: `${bboxToRender.w * 100}%`,
                  height: `${bboxToRender.h * 100}%`,
                  // Inline so dynamic palette colors don't need
                  // Tailwind safelisting. Selected = thicker border;
                  // unknown = dashed so the operator's eye picks it
                  // out as something that needs reassigning.
                  border: `${isSelected ? 3 : 2}px ${
                    isUnknown ? "dashed" : "solid"
                  } ${color}`,
                  backgroundColor: withAlpha(color, fillAlpha),
                  cursor: overlayCursor,
                }}
                title={
                  isUnknown ? `${UNKNOWN_FIELD_LABEL} (${r.field_key})` : label
                }
              >
                {/* Overlay tag row — field label plus optional
                    association badge. Wrapped in a flex container so
                    the REQ/Linked chip flows next to the label
                    without pixel-offset hackery. The whole strip is
                    pointer-events:none — the parent button handles
                    region selection. */}
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
                        "rounded-tr",
                        // REQ stays amber on white (required attention
                        // signal). Plain "Linked" uses Electric Lime
                        // on the brand navy — surfaces the Rivera
                        // validation accent on every region wired to
                        // a template. Text color is set per-branch so
                        // each pairing maintains contrast.
                        isRequired
                          ? "bg-amber-500 text-white"
                          : "bg-rivera-lime text-rivera-navy",
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
                {/* Resize handles — only on the selected rect region
                    while the select tool is active. Each handle stops
                    propagation so its mousedown initiates a resize
                    instead of a region click. */}
                {isSelected &&
                  tool === "select" &&
                  regionShape(r) === "rect" &&
                  ALL_RESIZE_HANDLES.map((h) => (
                    <ResizeHandleSquare
                      key={h}
                      handle={h}
                      onMouseDown={(e) =>
                        onResizeHandleMouseDown(e, r.id, h)
                      }
                    />
                  ))}
              </button>
            );
          })}

          {/* ---- In-flight draw preview ------------------------------- */}
          {interaction.kind === "drawing" && (
            <div
              className="absolute pointer-events-none border-2 border-brand-600 bg-brand-500/20"
              style={drawingPreviewStyle(interaction)}
            />
          )}
        </div>
      )}

      {/* ---- Polygon-mode placeholder --------------------------- */}
      {file && isPolygonPlaceholder && (
        <div
          className="absolute top-3 left-1/2 -translate-x-1/2 z-30 bg-white/95 backdrop-blur-sm border border-amber-300 px-3 py-1.5 rounded-md shadow text-[11.5px] text-amber-800 pointer-events-none dark:bg-surface-subtle/95 dark:border-yellow-900 dark:text-yellow-200"
          aria-live="polite"
        >
          {toolDescriptor.label} — coming soon. Switch tools to keep editing.
        </div>
      )}

      {/* ---- Drop overlay (covers the entire scrollable area) ----- */}
      {dropping && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-brand-500/15 border-2 border-dashed border-brand-500 m-2 rounded-lg pointer-events-none"
          aria-hidden
        >
          <div className="bg-white/95 px-4 py-3 rounded-lg shadow text-center dark:bg-surface-subtle/95 dark:border dark:border-line">
            <Upload className="h-6 w-6 mx-auto text-brand-600 dark:text-brand-50" />
            <p className="text-[13px] font-semibold text-gray-800 mt-1 dark:text-ink">
              {uploading ? "Reading file…" : "Drop to add training files"}
            </p>
            <p className="text-[11px] text-gray-500 mt-0.5 dark:text-ink-muted">
              PDFs and images, up to 10 MB each.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resize-handle square
// ---------------------------------------------------------------------------

/**
 * One of the eight resize handles surfaced on a selected region. The
 * handle catches its own `mousedown` (stopping propagation so the
 * region's click handler doesn't also fire) and tells the parent
 * which handle the operator grabbed.
 *
 * Visual: 8px square positioned at the matching corner / midpoint of
 * the parent overlay. Tailwind `bg-white` + brand-500 border keeps
 * the handle visible against arbitrary region tint colors. Hit area
 * is intentionally a hair larger than the visual via `padding`-style
 * margins (`-2` offsets) so the handle is easier to grab.
 */
function ResizeHandleSquare({
  handle,
  onMouseDown,
}: {
  handle: ResizeHandle;
  onMouseDown: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  // Positioning: each handle sits at the corresponding edge midpoint
  // or corner of the parent overlay. Translation centers the handle
  // ON the edge rather than INSIDE / OUTSIDE.
  const positionStyle: CSSProperties = {
    position: "absolute",
    width: 9,
    height: 9,
    transform: "translate(-50%, -50%)",
    cursor: RESIZE_HANDLE_CURSORS[handle],
  };
  // Position keyed off the handle's compass direction.
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
      onClick={(e) => {
        // Stop the click from bubbling to the region overlay's onClick
        // (which would re-select / clear).
        e.stopPropagation();
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Unknown-type placeholder
// ---------------------------------------------------------------------------

function UnknownPlaceholder({ file }: { file: InvoicePatternSourceFile }) {
  return (
    // bg-gray-50 stays in dark mode here too — this stands in for a
    // missing PDF page surface, so it follows the same "stay light to
    // represent the document" rule.
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
// Inline render helpers
// ---------------------------------------------------------------------------

/** CSS positioning for the in-flight rectangle being drawn. */
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
