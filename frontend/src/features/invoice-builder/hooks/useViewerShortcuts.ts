"use client";

import { useEffect } from "react";

import type { ViewerTool } from "../lib/viewer-tools";

/**
 * Keyboard shortcuts for the Invoice Builder visual editor.
 *
 * Bindings:
 *
 *   * `V`              → Select tool
 *   * `R`              → Draw rectangle tool
 *   * `H`              → Pan tool
 *   * `Space` (held)   → Temporarily activate pan; release returns to
 *                        the previous tool. Mirrors PDF readers /
 *                        Photoshop behaviour.
 *   * `Delete`/`Bksp`  → Delete the currently-selected region.
 *   * `Ctrl/Cmd +`     → Zoom in.
 *   * `Ctrl/Cmd -`     → Zoom out.
 *   * `Ctrl/Cmd 0`     → Reset zoom to 100%.
 *
 * Skipping rules — none of the shortcuts fire when focus is in an
 * `<input>` / `<textarea>` / `<select>` / contenteditable element.
 * That keeps the operator's text-edit experience native (a `V`
 * keystroke inside the pattern-name field stays a literal "v",
 * Backspace works to delete characters, etc.). The history hook
 * (`useRegionHistoryShortcuts`) uses the same skip rules — staying
 * consistent across both means there's no surprising mix of
 * "intercepted here, native there" depending on which element holds
 * focus.
 */
export interface UseViewerShortcutsOptions {
  /** Active tool — read so the spacebar handler can restore it. */
  tool: ViewerTool;
  setTool: (tool: ViewerTool) => void;
  onDeleteSelected?: () => void;
  /** True iff a region is currently selected — gates the Delete handler. */
  hasSelection: boolean;
  /** True when zoom is below the viewer's max (for `+`). Optional. */
  canZoomIn?: boolean;
  /** True when zoom is above the viewer's min (for `-`). Optional. */
  canZoomOut?: boolean;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onResetZoom?: () => void;
  /** Soft kill-switch — pauses the listener while a modal owns focus. */
  enabled?: boolean;
}

export function useViewerKeyboardShortcuts({
  tool,
  setTool,
  onDeleteSelected,
  hasSelection,
  canZoomIn = true,
  canZoomOut = true,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  enabled = true,
}: UseViewerShortcutsOptions): void {
  useEffect(() => {
    if (!enabled) return;

    // Track the prior tool when Space initiates a temporary pan, so
    // we can restore it on release. Refs (not state) keep the listener
    // from re-binding mid-drag, which would lose the prior tool value.
    let priorTool: ViewerTool | null = null;
    let spaceHeld = false;

    const isInTextField = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      );
    };

    const handler = (e: KeyboardEvent) => {
      if (isInTextField(e.target)) return;

      const key = e.key;
      const meta = e.ctrlKey || e.metaKey;

      // Ctrl/Cmd + zoom shortcuts. Note the `+` key on US layouts
      // arrives as `=` (with shift); we handle both. The `0` reset
      // matches every browser's "reset zoom" muscle memory.
      if (meta && (key === "+" || key === "=")) {
        if (onZoomIn && canZoomIn) {
          e.preventDefault();
          onZoomIn();
        }
        return;
      }
      if (meta && key === "-") {
        if (onZoomOut && canZoomOut) {
          e.preventDefault();
          onZoomOut();
        }
        return;
      }
      if (meta && key === "0") {
        if (onResetZoom) {
          e.preventDefault();
          onResetZoom();
        }
        return;
      }
      // Bare modifiers (Ctrl/Cmd) + something else: bail so we don't
      // intercept browser shortcuts like Cmd+S / Cmd+R / Cmd+Z.
      if (meta) return;

      // Space → temporary pan. Tracks the prior tool so release
      // restores it. Holding Space while another key fires has no
      // special handling — the temporary-pan only kicks in for the
      // first Space keydown.
      if (key === " " || key === "Spacebar") {
        if (!spaceHeld) {
          spaceHeld = true;
          if (tool !== "pan") {
            priorTool = tool;
            setTool("pan");
          }
        }
        e.preventDefault();
        return;
      }

      // Delete / Backspace → delete the selected region.
      if ((key === "Delete" || key === "Backspace") && hasSelection) {
        e.preventDefault();
        onDeleteSelected?.();
        return;
      }

      // Single-letter tool shortcuts. `e.key` is always the printed
      // character so we lower-case before comparing to be friendly to
      // caps-lock.
      const lower = key.toLowerCase();
      if (lower === "v") {
        e.preventDefault();
        setTool("select");
        return;
      }
      if (lower === "r") {
        e.preventDefault();
        setTool("draw_rect");
        return;
      }
      if (lower === "h") {
        e.preventDefault();
        setTool("pan");
        return;
      }
      // `P` is reserved for the polygon tool — surfaced in the toolbar
      // but the underlying capability is deferred. Pressing it switches
      // to the placeholder mode so the operator sees the "coming soon"
      // banner.
      if (lower === "p") {
        e.preventDefault();
        setTool("draw_polygon");
        return;
      }
    };

    const upHandler = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Spacebar") {
        spaceHeld = false;
        if (priorTool != null) {
          setTool(priorTool);
          priorTool = null;
        }
      }
    };

    document.addEventListener("keydown", handler);
    document.addEventListener("keyup", upHandler);
    return () => {
      document.removeEventListener("keydown", handler);
      document.removeEventListener("keyup", upHandler);
    };
  }, [
    enabled,
    tool,
    setTool,
    hasSelection,
    onDeleteSelected,
    canZoomIn,
    canZoomOut,
    onZoomIn,
    onZoomOut,
    onResetZoom,
  ]);
}
