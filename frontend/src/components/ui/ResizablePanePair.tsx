"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

interface ResizablePanePairProps {
  left: React.ReactNode;
  right: React.ReactNode;
  /** Initial fraction (0..1) of the pair's width assigned to the left pane. */
  initialRatio?: number;
  /** Min/max fraction for the left pane. Right pane gets `1 - left`. */
  minRatio?: number;
  maxRatio?: number;
  /** localStorage key — when set, the chosen ratio survives reloads. */
  storageKey?: string;
  className?: string;
  /**
   * Below this Tailwind breakpoint the divider is hidden and the panes
   * stack vertically. Defaults to "lg" (1024px). The component matches
   * `(min-width: <breakpoint>px)` to decide.
   */
  desktopBreakpointPx?: number;
}

/**
 * Two horizontally adjacent panes separated by a draggable divider.
 *
 * Why this exists in /components/ui rather than the upload feature:
 *   the resize gesture is generic and self-contained (mousedown on the
 *   handle, mousemove on document, persist to localStorage on mouseup).
 *   Other workspaces (Review, Batch detail) are likely candidates for
 *   the same pattern later.
 *
 * Behavior notes:
 *   - We track a *ratio* (fraction of total width), not pixels, so the
 *     split scales when the user resizes their window.
 *   - The container has `flex` and the divider is a fixed-width handle;
 *     the left pane uses `flex-basis` and the right pane uses `flex: 1`.
 *     That gives the right pane the residual width without us having to
 *     do the arithmetic for both sides.
 *   - During an active drag we (a) disable text selection on `body`,
 *     (b) force `cursor: col-resize` globally, and (c) listen for
 *     `pointermove`/`pointerup` rather than `mousemove`/`mouseup` so it
 *     also works on touchpads with pen / touch input.
 *   - On screens narrower than `desktopBreakpointPx` the divider is
 *     hidden and the panes stack — the resize gesture only makes sense
 *     when there's room for two columns side by side.
 */
export function ResizablePanePair({
  left,
  right,
  initialRatio = 0.42,
  minRatio = 0.25,
  maxRatio = 0.75,
  storageKey,
  className,
  desktopBreakpointPx = 1024,
}: ResizablePanePairProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState<number>(() => {
    if (typeof window === "undefined" || !storageKey) return initialRatio;
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return initialRatio;
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return initialRatio;
    return Math.min(maxRatio, Math.max(minRatio, parsed));
  });
  const [dragging, setDragging] = useState(false);
  const [isDesktop, setIsDesktop] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia(`(min-width: ${desktopBreakpointPx}px)`).matches;
  });

  // Track viewport width so the divider hides on narrow screens.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(min-width: ${desktopBreakpointPx}px)`);
    const handler = (e: MediaQueryListEvent | MediaQueryList) =>
      setIsDesktop("matches" in e ? e.matches : mq.matches);
    handler(mq);
    // Older Safari uses addListener; modern browsers use addEventListener.
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler as (e: MediaQueryListEvent) => void);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler as (e: MediaQueryListEvent) => void);
    };
  }, [desktopBreakpointPx]);

  // Persist the ratio whenever it changes (debouncing isn't worth it —
  // localStorage writes here are fast and the user does this rarely).
  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, ratio.toFixed(4));
  }, [ratio, storageKey]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!containerRef.current) return;
      // Capture the pointer so we keep getting move events even when the
      // cursor leaves the handle.
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDragging(true);
    },
    [],
  );

  // While dragging, listen for pointermove on document so we get events
  // outside the handle too.
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Account for divider width by clamping inside the container.
      const x = e.clientX - rect.left;
      const next = Math.min(maxRatio, Math.max(minRatio, x / rect.width));
      setRatio(next);
    };
    const onUp = () => setDragging(false);

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);

    // Disable text selection + force the resize cursor while dragging.
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging, minRatio, maxRatio]);

  // Double-click resets to the initial ratio — a quick "back to default"
  // affordance that's standard in IDEs.
  const onDoubleClick = useCallback(
    () => setRatio(Math.min(maxRatio, Math.max(minRatio, initialRatio))),
    [initialRatio, minRatio, maxRatio],
  );

  // ---- Mobile (stacked) layout --------------------------------------------
  if (!isDesktop) {
    return (
      <div className={cn("flex flex-col gap-4", className)}>
        <div className="min-h-[24rem]">{left}</div>
        <div className="min-h-[24rem]">{right}</div>
      </div>
    );
  }

  // ---- Desktop (resizable) layout -----------------------------------------
  return (
    <div
      ref={containerRef}
      className={cn("flex h-full w-full min-w-0 min-h-0", className)}
    >
      <div
        className="h-full min-w-0 min-h-0"
        style={{ flexBasis: `${ratio * 100}%` }}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={Math.round(minRatio * 100)}
        aria-valuemax={Math.round(maxRatio * 100)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        onKeyDown={(e) => {
          // Keyboard nudging — useful for accessibility and for users who
          // want exact widths.
          const step = e.shiftKey ? 0.05 : 0.01;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            setRatio((r) => Math.max(minRatio, r - step));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            setRatio((r) => Math.min(maxRatio, r + step));
          }
        }}
        title="Drag to resize · double-click to reset"
        className={cn(
          "shrink-0 mx-1.5 my-1 w-1.5 rounded-full cursor-col-resize",
          // Light: subtle gray pill that brightens to brand on hover.
          // Dark: lifted slate pill against the slate-900 page so the
          // divider stays visible without screaming.
          "bg-gray-200 hover:bg-brand-300 transition-colors",
          "dark:bg-line dark:hover:bg-brand-500",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300",
          dragging && "bg-brand-400 dark:bg-brand-500",
        )}
      />
      <div className="h-full flex-1 min-w-0 min-h-0">{right}</div>
    </div>
  );
}
