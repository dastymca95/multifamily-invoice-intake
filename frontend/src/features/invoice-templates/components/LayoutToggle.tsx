"use client";

import { Columns3, Rows3 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Two-mode layout toggle for the Import Builder.
 *
 *   * `horizontal` (default) — the existing spreadsheet-first table:
 *     columns are header cells across the top, rules are body rows
 *     beneath. Best for templates with a small-to-medium column count
 *     where horizontal scanning across all columns is the operator's
 *     primary interaction.
 *
 *   * `vertical` — a TRANSPOSED rule-matrix view: fields stack
 *     vertically as stable rows on the LEFT, and each rule renders as
 *     its own column to the RIGHT. The field list appears ONCE; rules
 *     are the repeated dimension. Best for templates with MANY columns
 *     (the horizontal table forces wide scrolling to compare two
 *     rules; the matrix places rules side-by-side so the eye scans
 *     field-by-field vertically) and for "compare these rules"
 *     workflows where rule-vs-rule contrast is the primary task.
 *
 * The toggle is purely a presentation flip — both modes operate on the
 * same underlying `columns` + `rules` state. Switching back and forth
 * is a no-op for the data; an operator can flip mid-edit without
 * losing in-progress work.
 *
 * The persisted preference is per-user (localStorage), not per-template
 * — the choice is about HOW the operator wants to read/edit, not a
 * property of the template itself.
 */

export type BuilderLayoutMode = "horizontal" | "vertical";

interface LayoutToggleProps {
  mode: BuilderLayoutMode;
  onChange: (next: BuilderLayoutMode) => void;
  className?: string;
}

export function LayoutToggle({ mode, onChange, className }: LayoutToggleProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border border-gray-200 bg-gray-50 p-0.5",
        className,
      )}
      role="group"
      aria-label="Builder layout"
    >
      <SegmentButton
        active={mode === "horizontal"}
        onClick={() => onChange("horizontal")}
        ariaLabel="Horizontal layout (spreadsheet table)"
        title="Horizontal: spreadsheet table — columns across, rules down"
      >
        <Columns3 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Table</span>
      </SegmentButton>
      <SegmentButton
        active={mode === "vertical"}
        onClick={() => onChange("vertical")}
        ariaLabel="Matrix layout (transposed: fields down, rules across)"
        title="Matrix: transposed view — fields stacked left, rules across as columns"
      >
        <Rows3 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Matrix</span>
      </SegmentButton>
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  ariaLabel,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  ariaLabel: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        active
          ? "bg-white text-brand-700 shadow-sm"
          : "text-gray-600 hover:text-gray-800",
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

const LAYOUT_STORAGE_KEY = "import-builder-layout-mode";

/**
 * Read the persisted layout choice. Defaults to "horizontal" when no
 * preference has been saved yet OR when running in an environment
 * without `localStorage` (SSR / very old browsers / private mode in
 * some browsers). The default matches the legacy behaviour so existing
 * users don't see a surprise mode switch on first load post-deploy.
 */
export function readLayoutMode(): BuilderLayoutMode {
  if (typeof window === "undefined") return "horizontal";
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw === "vertical" || raw === "horizontal") return raw;
    return "horizontal";
  } catch {
    // localStorage can throw in private mode or when disabled by
    // policy. Falling back to the default is fine — we'd rather lose
    // the preference than crash.
    return "horizontal";
  }
}

/**
 * Persist the layout choice. Silently no-ops when localStorage isn't
 * available — the in-memory state still updates so the user's session
 * works normally; the preference just doesn't survive a refresh.
 */
export function writeLayoutMode(mode: BuilderLayoutMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, mode);
  } catch {
    /* see readLayoutMode */
  }
}
