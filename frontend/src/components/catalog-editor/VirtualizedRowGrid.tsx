"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useRef,
} from "react";

/**
 * Generic virtualized grid for catalog editors.
 *
 * Mounts only the rows currently in the viewport (plus an overscan
 * buffer) regardless of catalog size — even at 50k rows, ~30 row
 * components live in the DOM at once. This is what keeps typing in a
 * cell responsive on large catalogs: a keystroke triggers React to
 * reconcile only the visible rows, not the entire 12 × 50k grid.
 *
 * Why a `<div>`-based grid instead of `<table>` / `<tbody>` / `<tr>`:
 * `react-virtual` positions each row absolutely inside a tall scroll
 * container. `<tr>` elements can't be reliably absolutely-positioned
 * across browsers — the table layout algorithm overrides position
 * rules. We use `display: grid` rows with a shared
 * `gridTemplateColumns` so the columns line up between header and
 * body without needing `<colgroup>`.
 *
 * Add-row UX: when the parent appends a new row off-screen, it sets
 * `pendingFocusId` to the new row's id. The grid scrolls the row into
 * view via the virtualizer, then polls (capped) for the focusable
 * element returned by `resolveFocusTarget` and focuses it. The parent
 * is notified via `onPendingFocusHandled` once handled (success or
 * timeout) so it can clear its own state.
 */

export interface VirtualizedRowGridHandle {
  /** Imperative scroll — useful for "jump to row N". */
  scrollToIndex: (index: number, opts?: { align?: "start" | "center" | "end" | "auto" }) => void;
}

export interface VirtualizedRowGridProps<TEntry> {
  entries: ReadonlyArray<TEntry>;
  /** Stable per-row identity (used by the virtualizer for keying). */
  getKey: (entry: TEntry) => string;
  /** Render a single row's content. Wrap in `React.memo` for best
   * results — the grid passes stable callbacks. */
  renderRow: (entry: TEntry, index: number) => ReactNode;
  /** Header rendered once at the top of the scroll container, sticky. */
  header: ReactNode;
  /** Shown when `entries.length === 0`. Inside the same scroll container. */
  emptyState: ReactNode;
  /** Min width of the inner container (so columns don't squeeze on
   * narrow viewports). E.g. `"78rem"`. */
  minWidth?: string;
  /** Estimated row height in px. The virtualizer self-corrects on
   * actual measurement, so a small over/under is fine. Default: 40. */
  rowHeightEstimate?: number;
  /** Off-screen rows to keep mounted for smoother scrolling. Default: 8. */
  overscan?: number;

  // ---- Add-row focus handoff ------------------------------------------------
  /** Id of a row to scroll into view + focus once mounted. Pass `null`
   * when nothing is pending. */
  pendingFocusId?: string | null;
  /** Resolves the focusable element for a given row id. Called multiple
   * times until it returns a non-null element or the retry budget runs
   * out. Typically reads from a refs Map populated by `renderRow`. */
  resolveFocusTarget?: (id: string) => HTMLElement | null;
  /** Notified after the grid has scrolled + focused (or given up). The
   * parent should reset its `pendingFocusId` state. */
  onPendingFocusHandled?: () => void;
}

const DEFAULT_ROW_HEIGHT = 40;
const DEFAULT_OVERSCAN = 8;
const FOCUS_RETRY_BUDGET = 8;

function VirtualizedRowGridInner<TEntry>(
  {
    entries,
    getKey,
    renderRow,
    header,
    emptyState,
    minWidth = "78rem",
    rowHeightEstimate = DEFAULT_ROW_HEIGHT,
    overscan = DEFAULT_OVERSCAN,
    pendingFocusId,
    resolveFocusTarget,
    onPendingFocusHandled,
  }: VirtualizedRowGridProps<TEntry>,
  ref: React.Ref<VirtualizedRowGridHandle>,
) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeightEstimate,
    overscan,
    getItemKey: useCallback(
      (index: number) => getKey(entries[index]),
      [entries, getKey],
    ),
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index, opts) =>
        virtualizer.scrollToIndex(index, { align: opts?.align ?? "auto" }),
    }),
    [virtualizer],
  );

  // Add-row scroll-and-focus. The row may be off-screen, so we ask the
  // virtualizer to scroll to it, then poll for its focusable element on
  // animation frames. Capped so a missing target doesn't spin forever.
  useEffect(() => {
    if (!pendingFocusId) return;
    const idx = entries.findIndex((e) => getKey(e) === pendingFocusId);
    if (idx < 0) {
      onPendingFocusHandled?.();
      return;
    }
    virtualizer.scrollToIndex(idx, { align: "end" });
    if (!resolveFocusTarget) {
      onPendingFocusHandled?.();
      return;
    }
    let attempts = 0;
    let cancelled = false;
    const tryFocus = () => {
      if (cancelled) return;
      const el = resolveFocusTarget(pendingFocusId);
      if (el) {
        el.focus();
        if (el instanceof HTMLInputElement) el.select();
        onPendingFocusHandled?.();
        return;
      }
      attempts += 1;
      if (attempts < FOCUS_RETRY_BUDGET) {
        requestAnimationFrame(tryFocus);
      } else {
        onPendingFocusHandled?.();
      }
    };
    requestAnimationFrame(tryFocus);
    return () => {
      cancelled = true;
    };
    // We intentionally only re-run on pendingFocusId / entries.length;
    // re-running on virtualizer/getKey churn would cause a cascade.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocusId, entries.length]);

  const totalSize = virtualizer.getTotalSize();
  const virtualRows = virtualizer.getVirtualItems();
  const showEmpty = entries.length === 0;

  return (
    <div
      ref={scrollRef}
      className="flex-1 min-h-0 overflow-auto"
      // The whole grid (header + virtualized body) lives inside this
      // single scroll container. react-virtual measures its vertical
      // scroll; horizontal scroll happens naturally because of the
      // inner min-width.
    >
      <div style={{ minWidth }}>
        {header}
        {showEmpty ? (
          <div className="px-4 py-10 text-center">{emptyState}</div>
        ) : (
          <div
            style={{
              height: `${totalSize}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualRows.map((virtualRow) => {
              const entry = entries[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {renderRow(entry, virtualRow.index)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// `forwardRef` doesn't preserve generics out of the box; this cast
// gives the public API back its `<TEntry>` parameter.
export const VirtualizedRowGrid = forwardRef(VirtualizedRowGridInner) as <
  TEntry,
>(
  props: VirtualizedRowGridProps<TEntry> & {
    ref?: React.Ref<VirtualizedRowGridHandle>;
  },
) => ReturnType<typeof VirtualizedRowGridInner>;
