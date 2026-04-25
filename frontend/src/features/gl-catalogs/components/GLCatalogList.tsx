"use client";

import {
  BookOpen,
  Layers,
  Loader2,
  Plus,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { cn, formatDate } from "@/lib/utils";
import type {
  GLCatalogSource,
  GLCatalogSummary,
} from "@/types/gl-catalog";

/**
 * Left rail of the GL Codes builder workspace.
 *
 * Mirrors `TemplateList`'s rhythm so the two builder pages feel like
 * siblings:
 *   * top "+ New" CTA
 *   * stack of selectable rows with name + small meta line
 *     (entry_count, source_label, formatted updated_at)
 *   * empty state with "create your first" affordance
 *
 * Empty-state nuance: when the user has no saved catalogs, the
 * orchestrator renders an editable DRAFT of the canonical default in
 * the center pane. This rail surfaces that gracefully so the empty
 * list doesn't feel like a dead end.
 */
interface GLCatalogListProps {
  items: GLCatalogSummary[];
  selectedId: string | null;
  /** True when the editor is showing the unsaved canonical-default draft. */
  viewingDraft: boolean;
  /** True iff `defaultCatalog` has loaded (drives the draft entry visibility). */
  hasDraft: boolean;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onSelectDraft: () => void;
  onNew: () => void;
  onRetry: () => void;
}

export function GLCatalogList({
  items,
  selectedId,
  viewingDraft,
  hasDraft,
  loading,
  error,
  onSelect,
  onSelectDraft,
  onNew,
  onRetry,
}: GLCatalogListProps) {
  // Show the "Default catalog (draft)" entry when the user has no
  // saved catalogs — gives them something to edit immediately. We
  // also show it when they actively switch to the draft via the
  // header so the rail keeps a visible selection cue.
  const showDraftEntry = hasDraft && (items.length === 0 || viewingDraft);

  return (
    <div className="flex flex-col h-full bg-white border-r border-gray-200 dark:bg-surface-subtle dark:border-line">
      {/* ---- Header ----------------------------------------------------- */}
      <div className="px-4 py-3 border-b border-gray-200 dark:border-line">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-brand-700 dark:text-brand-50" />
          <h2 className="text-sm font-semibold text-gray-800 dark:text-ink">
            Saved catalogs
          </h2>
        </div>
        <p className="text-[10.5px] text-gray-500 mt-0.5 dark:text-ink-subtle">
          Each entry is a saved chart of accounts. Open one to edit
          its rows, or create a new catalog from a starter.
        </p>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="w-full mt-2.5"
          onClick={onNew}
        >
          <Plus className="h-3.5 w-3.5" />
          New catalog
        </Button>
      </div>

      {/* ---- Body ------------------------------------------------------- */}
      <div className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <div className="p-3">
            <InlineAlert
              tone="error"
              title="Couldn't load catalogs"
              action={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={onRetry}
                >
                  Retry
                </Button>
              }
            >
              {error}
            </InlineAlert>
          </div>
        ) : loading && items.length === 0 ? (
          <p className="p-4 text-xs text-gray-500 dark:text-ink-subtle inline-flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading saved catalogs…
          </p>
        ) : (
          <ul className="py-1">
            {showDraftEntry && (
              <DraftRow
                selected={viewingDraft}
                onSelect={onSelectDraft}
                soloHint={items.length === 0}
              />
            )}
            {items.map((item) => (
              <CatalogRow
                key={item.id}
                item={item}
                selected={!viewingDraft && item.id === selectedId}
                onSelect={() => onSelect(item.id)}
              />
            ))}
            {items.length === 0 && !showDraftEntry && (
              <EmptyState onNew={onNew} />
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved-catalog row
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<GLCatalogSource, string> = {
  default: "From default",
  blank: "From blank",
  from_upload: "From upload",
  custom: "Custom",
};

function CatalogRow({
  item,
  selected,
  onSelect,
}: {
  item: GLCatalogSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "w-full text-left px-3 py-2 border-l-2 transition-colors",
          selected
            ? "border-l-brand-600 bg-brand-50/60 dark:bg-brand-900/30"
            : "border-l-transparent hover:bg-gray-50 dark:hover:bg-surface-muted",
        )}
      >
        <p
          className={cn(
            "text-[12.5px] font-semibold truncate",
            selected
              ? "text-brand-800 dark:text-brand-50"
              : "text-gray-800 dark:text-ink",
          )}
          title={item.name}
        >
          {item.name}
        </p>
        {item.description && (
          <p
            className="text-[10.5px] text-gray-500 truncate mt-0.5 dark:text-ink-muted"
            title={item.description}
          >
            {item.description}
          </p>
        )}
        <p className="text-[10px] text-gray-400 mt-0.5 inline-flex items-center gap-1.5 dark:text-ink-subtle">
          <span>
            {item.entry_count}{" "}
            {item.entry_count === 1 ? "code" : "codes"}
          </span>
          <span className="text-gray-300 dark:text-line-strong">·</span>
          <span>{SOURCE_LABEL[item.source]}</span>
          <span className="text-gray-300 dark:text-line-strong">·</span>
          <span>{formatDate(item.updated_at)}</span>
        </p>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Draft (canonical default) row
// ---------------------------------------------------------------------------

function DraftRow({
  selected,
  onSelect,
  soloHint,
}: {
  selected: boolean;
  onSelect: () => void;
  soloHint: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "w-full text-left px-3 py-2 border-l-2 transition-colors",
          selected
            ? "border-l-brand-600 bg-brand-50/60 dark:bg-brand-900/30"
            : "border-l-transparent hover:bg-gray-50 dark:hover:bg-surface-muted",
        )}
      >
        <div className="flex items-center gap-1.5">
          <Sparkles
            className={cn(
              "h-3 w-3 shrink-0",
              selected
                ? "text-brand-700 dark:text-brand-50"
                : "text-gray-400 dark:text-ink-subtle",
            )}
          />
          <p
            className={cn(
              "text-[12.5px] font-semibold truncate",
              selected ? "text-brand-800" : "text-gray-800",
            )}
          >
            Default catalog
          </p>
          <span className="ml-auto text-[9.5px] font-semibold uppercase tracking-wide text-orange-600 dark:text-orange-400">
            draft
          </span>
        </div>
        <p className="text-[10.5px] text-gray-500 truncate mt-0.5 dark:text-ink-muted">
          {soloHint
            ? "Edit and save to start your library."
            : "Editable starter — save to add it to your list."}
        </p>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Empty state — only used when there's no draft to show either
// ---------------------------------------------------------------------------

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="mx-auto h-10 w-10 rounded-full bg-brand-50 dark:bg-brand-900/40 flex items-center justify-center mb-2">
        <BookOpen className="h-5 w-5 text-brand-600 dark:text-brand-50" />
      </div>
      <p className="text-sm font-medium text-gray-700 dark:text-ink">
        No saved GL catalogs yet
      </p>
      <p className="text-[11px] text-gray-500 mt-1 dark:text-ink-muted">
        Create one to capture the chart of accounts every future invoice
        line item should validate against.
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-3"
        onClick={onNew}
      >
        <Plus className="h-3.5 w-3.5" />
        New catalog
      </Button>
    </div>
  );
}
