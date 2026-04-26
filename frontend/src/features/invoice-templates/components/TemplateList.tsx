"use client";

import {
  FileSpreadsheet,
  Layers,
  Loader2,
  Plus,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { cn, formatDate } from "@/lib/utils";
import type {
  InvoiceTemplateSource,
  InvoiceTemplateSummary,
} from "@/types/invoice-template";

/**
 * Left rail of the Invoice Template Builder workspace.
 *
 * Mirrors `ConfigList`'s rhythm so the two builder pages feel like
 * siblings:
 *   * top "+ New" CTA
 *   * stack of selectable rows with name + small meta line
 *   * empty state with "create your first" affordance
 *
 * Empty-state nuance specific to this page: when the user has no
 * saved templates, the orchestrator renders an editable DRAFT of the
 * canonical default in the center pane. This rail explains that
 * gracefully so the empty-list state doesn't feel like a dead end.
 */
interface TemplateListProps {
  items: InvoiceTemplateSummary[];
  selectedId: string | null;
  /** True when the editor is showing the unsaved canonical-default draft. */
  viewingDraft: boolean;
  /** True iff `defaultTemplate` has loaded (drives the draft entry visibility). */
  hasDraft: boolean;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onSelectDraft: () => void;
  onNew: () => void;
  onRetry: () => void;
}

export function TemplateList({
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
}: TemplateListProps) {
  // Show the "Default template (draft)" entry when the user has no
  // saved templates — gives them something to edit immediately. We
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
            Saved templates
          </h2>
        </div>
        <p className="text-[10.5px] text-gray-500 mt-0.5 dark:text-ink-subtle">
          Each entry is a saved column shape. Open one to edit its
          columns, or create a new template from a starter.
        </p>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="w-full mt-2.5"
          onClick={onNew}
        >
          <Plus className="h-3.5 w-3.5" />
          New template
        </Button>
      </div>

      {/* ---- Body ------------------------------------------------------- */}
      <div className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <div className="p-3">
            <InlineAlert
              tone="error"
              title="Couldn't load templates"
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
            Loading saved templates…
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
              <TemplateRow
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
// Saved-template row
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<InvoiceTemplateSource, string> = {
  default: "From default",
  blank: "From blank",
  from_upload: "From ResMan upload",
  custom: "Custom",
};

function TemplateRow({
  item,
  selected,
  onSelect,
}: {
  item: InvoiceTemplateSummary;
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
            ? // Selected = solid Electric Lime in BOTH themes so the
              // active item reads as a contiguous Rivera accent block.
              // Border matches the bg so the 2px reservation doesn't
              // show as a stripe; idle keeps a transparent left border
              // for the same width to prevent layout shift.
              "border-l-rivera-lime bg-rivera-lime"
            : "border-l-transparent hover:bg-gray-50 dark:hover:bg-surface-muted",
        )}
      >
        <p
          className={cn(
            "text-[12.5px] font-semibold truncate",
            selected
              ? // All text inside the lime row swaps to Deep Navy in
                // both themes — lime is bright enough that navy reads
                // crisply regardless of light/dark mode.
                "text-rivera-navy"
              : "text-gray-800 dark:text-ink",
          )}
          title={item.name}
        >
          {item.name}
        </p>
        {item.description && (
          <p
            className={cn(
              "text-[10.5px] truncate mt-0.5",
              selected
                ? "text-rivera-navy/75"
                : "text-gray-500 dark:text-ink-muted",
            )}
            title={item.description}
          >
            {item.description}
          </p>
        )}
        <p
          className={cn(
            "text-[10px] mt-0.5 inline-flex flex-wrap items-center gap-x-1.5",
            selected
              ? "text-rivera-navy/65"
              : "text-gray-400 dark:text-ink-subtle",
          )}
        >
          <span>
            {item.column_count} column{item.column_count === 1 ? "" : "s"}
          </span>
          {item.rule_count > 0 && (
            <>
              <span
                className={
                  selected
                    ? "text-rivera-navy/40"
                    : "text-gray-300 dark:text-line-strong"
                }
              >
                ·
              </span>
              <span
                className={cn(
                  "font-medium",
                  selected
                    ? "text-rivera-navy"
                    : "text-brand-700 dark:text-brand-50",
                )}
                title="Rule rows defined on this template"
              >
                {item.rule_count} rule{item.rule_count === 1 ? "" : "s"}
              </span>
            </>
          )}
          <span
            className={
              selected
                ? "text-rivera-navy/40"
                : "text-gray-300 dark:text-line-strong"
            }
          >
            ·
          </span>
          <span>{SOURCE_LABEL[item.source]}</span>
          <span
            className={
              selected
                ? "text-rivera-navy/40"
                : "text-gray-300 dark:text-line-strong"
            }
          >
            ·
          </span>
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
            ? // Same solid Electric Lime treatment as the regular
              // CatalogRow above — keeps the selected affordance
              // consistent across the entire saved-templates list.
              "border-l-rivera-lime bg-rivera-lime"
            : "border-l-transparent hover:bg-gray-50 dark:hover:bg-surface-muted",
        )}
      >
        <div className="flex items-center gap-1.5">
          <Sparkles
            className={cn(
              "h-3 w-3 shrink-0",
              selected
                ? "text-rivera-navy"
                : "text-gray-400 dark:text-ink-subtle",
            )}
          />
          <p
            className={cn(
              "text-[12.5px] font-semibold truncate",
              selected
                ? "text-rivera-navy"
                : "text-gray-800 dark:text-ink",
            )}
          >
            Default template
          </p>
          <span
            className={cn(
              "ml-auto text-[9.5px] font-semibold uppercase tracking-wide",
              selected
                ? "text-rivera-navy/75"
                : "text-orange-600 dark:text-orange-400",
            )}
          >
            draft
          </span>
        </div>
        <p
          className={cn(
            "text-[10.5px] truncate mt-0.5",
            selected
              ? "text-rivera-navy/75"
              : "text-gray-500 dark:text-ink-muted",
          )}
        >
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
        <FileSpreadsheet className="h-5 w-5 text-brand-600 dark:text-brand-50" />
      </div>
      <p className="text-sm font-medium text-gray-700 dark:text-ink">
        No saved templates yet
      </p>
      <p className="text-[11px] text-gray-500 mt-1 dark:text-ink-muted">
        Create one to capture the column shape your future invoice
        exports should follow.
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-3"
        onClick={onNew}
      >
        <Plus className="h-3.5 w-3.5" />
        New template
      </Button>
    </div>
  );
}
