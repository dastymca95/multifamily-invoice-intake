/**
 * Viewer tool modes for the Invoice Builder.
 *
 * The document viewer's mouse handlers behave differently depending on
 * which tool is active in the toolbar. Splitting the modes into their
 * own file keeps the type definition and the cursor / hint metadata
 * adjacent — both the toolbar (rendering the buttons) and the viewer
 * (interpreting clicks) read from the same constants.
 *
 * Modes:
 *
 *   * `"select"`       — Default. Click an existing region to select
 *                        it; drag inside a selected region to move it;
 *                        drag a corner / side handle to resize.
 *                        Clicking empty space clears the selection.
 *
 *   * `"draw_rect"`    — Drag on empty space to draw a new rectangle
 *                        region. Replaces the implicit "default = draw
 *                        always" behaviour the viewer had before tool
 *                        modes existed.
 *
 *   * `"pan"`          — Drag anywhere to scroll the viewport
 *                        (mirrors the hand tool in PDF readers /
 *                        image viewers). Spacebar from any mode
 *                        temporarily activates pan while held — see
 *                        `useViewerKeyboardShortcuts`.
 *
 *   * `"draw_polygon"` — Placeholder for the polygon-region affordance.
 *                        The data model already accepts polygon
 *                        regions (see `RegionShape` in
 *                        `types/invoice-pattern.ts`), but the editor
 *                        UI for drawing them is intentionally
 *                        deferred — the toolbar surfaces the button
 *                        as "coming soon" so the operator knows the
 *                        capability is in flight.
 */

import {
  Hand,
  Lasso,
  MousePointer2,
  Square,
  type LucideIcon,
} from "lucide-react";

export type ViewerTool = "select" | "draw_rect" | "pan" | "draw_polygon";

/** Metadata for rendering the toolbar buttons. */
export interface ViewerToolDescriptor {
  id: ViewerTool;
  label: string;
  /**
   * Single-character shortcut shown in the tooltip. The actual handler
   * lives in `useViewerKeyboardShortcuts` — declaring it here keeps
   * the visible shortcut and the active binding from drifting.
   */
  shortcut: string;
  icon: LucideIcon;
  /** CSS cursor while this tool is active over the page surface. */
  cursor: string;
  /** True when the underlying capability isn't wired up yet. */
  comingSoon?: boolean;
  /** Tooltip text. */
  hint: string;
}

export const VIEWER_TOOLS: readonly ViewerToolDescriptor[] = [
  {
    id: "select",
    label: "Select",
    shortcut: "V",
    icon: MousePointer2,
    cursor: "default",
    hint: "Select & edit regions (V)",
  },
  {
    id: "draw_rect",
    label: "Rectangle",
    shortcut: "R",
    icon: Square,
    cursor: "crosshair",
    hint: "Draw a rectangular region (R)",
  },
  {
    id: "pan",
    label: "Pan",
    shortcut: "H",
    icon: Hand,
    // `grab` flips to `grabbing` mid-drag via the viewer's data-drag
    // attribute (see DocumentViewer). Hold Space from any mode to
    // temporarily activate pan without switching tools.
    cursor: "grab",
    hint: "Pan the viewport (H, or hold Space)",
  },
  {
    id: "draw_polygon",
    label: "Polygon",
    shortcut: "P",
    icon: Lasso,
    cursor: "crosshair",
    comingSoon: true,
    hint: "Draw a polygon region — coming soon",
  },
];

/** Default tool — operator opens the editor in select mode. */
export const DEFAULT_VIEWER_TOOL: ViewerTool = "select";

/** Lookup for the descriptor by tool id. Useful in mode-conditional UI. */
export function viewerToolDescriptor(tool: ViewerTool): ViewerToolDescriptor {
  // Non-null assertion is safe: `tool` is a typed Literal whose every
  // value appears in VIEWER_TOOLS.
  return VIEWER_TOOLS.find((t) => t.id === tool)!;
}
