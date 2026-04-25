/**
 * Geometry helpers for the Invoice Builder visual editor.
 *
 * Single home for the math used by:
 *
 *   * `DocumentViewer` — drawing new regions, hit-testing existing
 *     ones, computing in-flight preview rects.
 *   * Region move (drag inside a selected region) — translates the
 *     bbox by mouse delta with edge-clamping.
 *   * Region resize (drag a corner / side handle) — re-shapes the bbox
 *     against an opposing anchor, keeps `w`/`h` strictly > 0, and
 *     clamps the result to stay inside the [0, 1] page rectangle.
 *
 * Pulling these out of `DocumentViewer` keeps the math reviewable +
 * testable in one file instead of being repeated inline at each call
 * site (move, resize, draw all share the same transforms). Centralising
 * also means a future bug fix in clamp / corner normalisation
 * propagates without hunting through component code.
 *
 * Coordinate convention — all coordinates are normalised to the
 * `[0, 1]` page rect: (0, 0) = top-left, (1, 1) = bottom-right. The
 * renderer scales these to whatever pixel grid the page is currently
 * at, so geometry stays correct across DPIs, viewport widths, AND
 * future zoom levels (a 2× zoom doesn't change the normalised value of
 * a rectangle on the page — only its rendered pixel size).
 */

import type {
  InvoicePatternRegion,
  InvoiceRegionBBox,
  InvoiceRegionPoint,
} from "@/types/invoice-pattern";

// ---------------------------------------------------------------------------
// Scalar / point clamping
// ---------------------------------------------------------------------------

/** Clamp a scalar to the page's normalised range. */
export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Clamp both axes of a point to `[0, 1]`. */
export function clampPointTo01(p: InvoiceRegionPoint): InvoiceRegionPoint {
  return { x: clamp01(p.x), y: clamp01(p.y) };
}

/**
 * Clamp a bbox so it stays entirely inside the `[0, 1]` page rect with
 * `w`, `h` strictly positive.
 *
 * Strategy:
 *   1. Clamp x, y to `[0, 1)` so the top-left corner is on-page.
 *   2. Cap w, h at the remaining horizontal / vertical headroom so the
 *      bottom-right corner doesn't escape.
 *   3. Floor w, h at `MIN_BBOX_DIMENSION` so a fully-collapsed box
 *      doesn't sneak through (the schema validator on the backend
 *      requires `w > 0` and `h > 0`; we use a slightly larger floor so
 *      the editor remains pixel-clickable).
 */
export const MIN_BBOX_DIMENSION = 0.005; // half a percent of page side

export function clampBBoxTo01(bbox: InvoiceRegionBBox): InvoiceRegionBBox {
  const x = Math.max(0, Math.min(1 - MIN_BBOX_DIMENSION, bbox.x));
  const y = Math.max(0, Math.min(1 - MIN_BBOX_DIMENSION, bbox.y));
  const maxW = 1 - x;
  const maxH = 1 - y;
  const w = Math.max(MIN_BBOX_DIMENSION, Math.min(maxW, bbox.w));
  const h = Math.max(MIN_BBOX_DIMENSION, Math.min(maxH, bbox.h));
  return { x, y, w, h };
}

// ---------------------------------------------------------------------------
// Coordinate conversion
// ---------------------------------------------------------------------------

/**
 * Convert a `clientX` / `clientY` mouse pair into a normalised point
 * relative to the supplied container rect (typically
 * `containerRef.current.getBoundingClientRect()`).
 *
 * Why a separate helper instead of inlining the formula at each site:
 *   * Move + resize handlers also need this (not just draw start/end),
 *     and the inline version was easy to drift on (e.g. forgetting
 *     the clamp on edge cases where the mouse leaves the container).
 *   * Future zoom support reads from the SAME rect — the `getBounding…`
 *     value already accounts for any CSS transform, so the normalised
 *     value remains correct without per-call adjustment.
 *
 * Always clamps to `[0, 1]` so a tiny overshoot (mouse drifts a pixel
 * past the edge mid-drag) doesn't corrupt downstream geometry.
 */
export function clientToNormalizedPoint(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): InvoiceRegionPoint {
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0 };
  }
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  return clampPointTo01({ x, y });
}

// ---------------------------------------------------------------------------
// Bbox construction / mutation
// ---------------------------------------------------------------------------

/**
 * Make a positive-w/h bbox from any two diagonal corner points
 * (regardless of drag direction) and clamp the result to the page.
 *
 * Replaces the inline `normalizeBBox` previously living in
 * `DocumentViewer`; same behaviour, plus the unified clamping pass at
 * the end so a slightly-out-of-bounds drag end never escapes the page.
 */
export function normalizeBBoxFromCorners(
  p1: InvoiceRegionPoint,
  p2: InvoiceRegionPoint,
): InvoiceRegionBBox {
  const x = Math.min(p1.x, p2.x);
  const y = Math.min(p1.y, p2.y);
  const w = Math.abs(p2.x - p1.x);
  const h = Math.abs(p2.y - p1.y);
  return clampBBoxTo01({ x, y, w, h });
}

/**
 * Translate a bbox by `(dx, dy)` (in normalised units) and clamp the
 * RESULT so the bbox stays fully on-page.
 *
 * Important: this clamps the TRANSLATION, not just the origin. A naive
 * `x + dx` followed by clampBBoxTo01 would shrink the box if it tried
 * to drift past the right / bottom edge; instead we clamp dx/dy first
 * so the box's width and height stay constant during a move (matches
 * Figma / Photoshop / every other editor's drag-move behaviour).
 */
export function translateBBox(
  bbox: InvoiceRegionBBox,
  dx: number,
  dy: number,
): InvoiceRegionBBox {
  const minDx = -bbox.x;
  const maxDx = 1 - bbox.x - bbox.w;
  const minDy = -bbox.y;
  const maxDy = 1 - bbox.y - bbox.h;
  const cappedDx = Math.max(minDx, Math.min(maxDx, dx));
  const cappedDy = Math.max(minDy, Math.min(maxDy, dy));
  return {
    x: bbox.x + cappedDx,
    y: bbox.y + cappedDy,
    w: bbox.w,
    h: bbox.h,
  };
}

// ---------------------------------------------------------------------------
// Resize handles
// ---------------------------------------------------------------------------

/**
 * The eight resize affordances surfaced on a selected region: four
 * corners + four side midpoints. The string itself names the EDGE(S)
 * being grabbed (e.g. `"nw"` = north-west corner, `"e"` = east side
 * midpoint). Cursor mapping + anchor-point lookup both key off this.
 */
export type ResizeHandle =
  | "n"
  | "s"
  | "e"
  | "w"
  | "nw"
  | "ne"
  | "sw"
  | "se";

export const ALL_RESIZE_HANDLES: readonly ResizeHandle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
] as const;

/**
 * CSS cursor for each handle. Combines the `_-resize` / `n-resize` /
 * etc. set so the cursor reads as the operator's intuition expects
 * (north-south arrow on a side handle, diagonal on a corner).
 */
export const RESIZE_HANDLE_CURSORS: Record<ResizeHandle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
};

/**
 * Apply a resize-by-mouse-delta to a bbox. The OPPOSING corner /
 * midpoint stays fixed; the dragged edge moves with the mouse.
 *
 * Implementation is symmetric per axis. For each handle:
 *   * `n` / `s` move only the y-edge (top or bottom); `x` and `w`
 *     unchanged.
 *   * `e` / `w` move only the x-edge.
 *   * `nw` / `ne` / `sw` / `se` move BOTH edges they touch.
 *
 * After mutating both axes the result goes through `clampBBoxTo01` so
 * a delta that would drag the box past a page edge gets clipped, AND a
 * delta that would crush the box's `w` or `h` below `MIN_BBOX_DIMENSION`
 * gets floored. Both behaviours match standard editor UX (the corner
 * stops at the edge / pinches to a min size rather than disappearing).
 */
export function resizeBBoxFromHandle(
  bbox: InvoiceRegionBBox,
  handle: ResizeHandle,
  dx: number,
  dy: number,
): InvoiceRegionBBox {
  let x = bbox.x;
  let y = bbox.y;
  let w = bbox.w;
  let h = bbox.h;

  // Horizontal axis
  if (handle === "w" || handle === "nw" || handle === "sw") {
    // Left edge moves; right edge fixed.
    x = bbox.x + dx;
    w = bbox.w - dx;
  } else if (handle === "e" || handle === "ne" || handle === "se") {
    // Right edge moves; left edge fixed.
    w = bbox.w + dx;
  }

  // Vertical axis
  if (handle === "n" || handle === "nw" || handle === "ne") {
    // Top edge moves; bottom edge fixed.
    y = bbox.y + dy;
    h = bbox.h - dy;
  } else if (handle === "s" || handle === "sw" || handle === "se") {
    // Bottom edge moves; top edge fixed.
    h = bbox.h + dy;
  }

  // If the operator drags PAST the opposing edge (negative width/
  // height), the bbox would invert. Rather than swap the anchor mid-
  // drag (which surprises users), we floor at MIN_BBOX_DIMENSION via
  // the clamp pass. clampBBoxTo01 also handles page-edge clipping.
  return clampBBoxTo01({ x, y, w, h });
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/** True iff the point lies inside (or on the edge of) the bbox. */
export function pointInBBox(
  p: InvoiceRegionPoint,
  bbox: InvoiceRegionBBox,
): boolean {
  return (
    p.x >= bbox.x &&
    p.x <= bbox.x + bbox.w &&
    p.y >= bbox.y &&
    p.y <= bbox.y + bbox.h
  );
}

/**
 * Filter `regions` to those that live on `(fileId, page)`. Used by the
 * viewer to derive the visible-on-this-page slice for both rendering
 * and hit testing.
 */
export function regionsOnPage(
  regions: readonly InvoicePatternRegion[],
  fileId: string,
  page: number,
): InvoicePatternRegion[] {
  return regions.filter(
    (r) => r.source_file_id === fileId && r.page === page,
  );
}
