"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { InvoicePatternRegion } from "@/types/invoice-pattern";

/**
 * Local-only history stack for region edits.
 *
 * Why scoped to regions, not the whole pattern form: regions are the
 * only structurally-rich state where an undo affordance pays off. The
 * other form fields (name, vendor_hint, description) are short text
 * inputs; the browser already has Cmd+Z inside them. Source-file
 * uploads are not undoable in any meaningful sense — re-add the file
 * if it was removed by mistake.
 *
 * Implementation note: history is a triple `{ past, present, future }`
 * of region arrays. Each `setRegions` push replaces `present` and
 * clears `future` (standard editor undo semantics — a fresh edit
 * forks a new branch). `undo` and `redo` shuttle entries across the
 * three lists. The stack caps at `MAX_HISTORY` snapshots to prevent
 * memory creep on long editing sessions; the oldest snapshot is
 * dropped from `past` when the cap is hit.
 *
 * Coalescing: not implemented. Region drawing is naturally coarse
 * (one drag → one region added), and operators don't typically
 * scrub a slider in a way that would need debounced grouping. If
 * region resize lands later, this hook would benefit from a
 * "coalesce edits within Nms" pass.
 */
export interface UseRegionHistoryResult {
  regions: InvoicePatternRegion[];
  setRegions: (next: InvoicePatternRegion[]) => void;
  /** Replace the baseline (e.g. on save) without losing history. */
  reset: (next: InvoicePatternRegion[]) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

interface History {
  past: InvoicePatternRegion[][];
  present: InvoicePatternRegion[];
  future: InvoicePatternRegion[][];
}

const MAX_HISTORY = 50;

export function useRegionHistory(
  initial: InvoicePatternRegion[],
): UseRegionHistoryResult {
  const [history, setHistory] = useState<History>(() => ({
    past: [],
    present: initial,
    future: [],
  }));

  // Track the latest "initial" via ref so the reset path doesn't have
  // to be dep on a value the consumer may not memoise.
  const initialRef = useRef(initial);
  initialRef.current = initial;

  const setRegions = useCallback((next: InvoicePatternRegion[]) => {
    setHistory((curr) => {
      // No-op when unchanged (reference equality is enough — the
      // editor produces a fresh array on every edit).
      if (next === curr.present) return curr;
      const past = [...curr.past, curr.present];
      // Drop the oldest snapshot if we hit the cap.
      while (past.length > MAX_HISTORY) past.shift();
      return { past, present: next, future: [] };
    });
  }, []);

  const reset = useCallback((next: InvoicePatternRegion[]) => {
    // Wholesale reset clears history. Used on pattern switch (the
    // editor key-remounts, but defensive) and on a successful save
    // so the saved state becomes the new baseline.
    setHistory({ past: [], present: next, future: [] });
  }, []);

  const undo = useCallback(() => {
    setHistory((curr) => {
      if (curr.past.length === 0) return curr;
      const previous = curr.past[curr.past.length - 1];
      const past = curr.past.slice(0, -1);
      return {
        past,
        present: previous,
        future: [curr.present, ...curr.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((curr) => {
      if (curr.future.length === 0) return curr;
      const [next, ...rest] = curr.future;
      return {
        past: [...curr.past, curr.present],
        present: next,
        future: rest,
      };
    });
  }, []);

  return {
    regions: history.present,
    setRegions,
    reset,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}

/**
 * Wire keyboard shortcuts (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y) to
 * the supplied undo/redo callbacks.
 *
 * Skipping rules — the listener does NOT fire when the focus is in
 * an input, textarea, select, or contenteditable element. Operators
 * editing the region label or pattern name expect the browser's
 * native text-undo to work there; intercepting it would clobber a
 * single-character correction with a region-level undo.
 */
export function useRegionHistoryShortcuts(
  undo: () => void,
  redo: () => void,
  enabled: boolean = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      // Bail when the user is typing into a form control. `closest`
      // also covers contenteditable surfaces (e.g. rich text in
      // future region notes).
      const target = e.target;
      if (target instanceof HTMLElement) {
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }

      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;

      const key = e.key.toLowerCase();
      // Cmd/Ctrl + Shift + Z → redo
      if (key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }
      // Cmd/Ctrl + Z → undo
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      // Ctrl + Y → redo (Windows convention; ignored on Mac where
      // Cmd+Y is "history" in some apps and we already have Shift+Z).
      if (key === "y" && !e.metaKey) {
        e.preventDefault();
        redo();
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [undo, redo, enabled]);
}
