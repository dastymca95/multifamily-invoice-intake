"use client";

import { FileSearch, Layers, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { cn, formatDate } from "@/lib/utils";
import type { InvoicePatternSummary } from "@/types/invoice-pattern";

/**
 * Left rail of the Invoice Builder workspace.
 *
 * Mirrors `TemplateList` (Import Builder) so the two builder pages
 * feel like siblings:
 *   * top "+ New" CTA
 *   * stack of selectable rows with name + small meta line
 *   * empty state with "create your first" affordance
 *
 * Difference from TemplateList: there is no "default draft" entry —
 * an Invoice Builder pattern is an inherently user-authored thing
 * (its content is the operator's drawn regions on the operator's
 * uploaded bills), so there's no canonical default to pre-populate.
 * Empty list goes straight to the "+ New" affordance.
 */
interface PatternListProps {
  items: InvoicePatternSummary[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRetry: () => void;
}

export function PatternList({
  items,
  selectedId,
  loading,
  error,
  onSelect,
  onNew,
  onRetry,
}: PatternListProps) {
  return (
    <div className="flex flex-col h-full bg-white border-r border-gray-200">
      {/* ---- Header ----------------------------------------------------- */}
      <div className="px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-brand-700" />
          <h2 className="text-sm font-semibold text-gray-800">
            Saved patterns
          </h2>
        </div>
        <p className="text-[10.5px] text-gray-500 mt-0.5">
          Each entry is a saved visual extraction pattern — uploaded
          training bills with regions pinned to canonical invoice
          fields. Open one to edit, or create a new pattern.
        </p>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="w-full mt-2.5"
          onClick={onNew}
        >
          <Plus className="h-3.5 w-3.5" />
          New pattern
        </Button>
      </div>

      {/* ---- Body ------------------------------------------------------- */}
      <div className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <div className="p-3">
            <InlineAlert
              tone="error"
              title="Couldn't load patterns"
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
          <p className="p-4 text-xs text-gray-500 inline-flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading saved patterns…
          </p>
        ) : items.length === 0 ? (
          <EmptyState onNew={onNew} />
        ) : (
          <ul className="py-1">
            {items.map((item) => (
              <PatternRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={() => onSelect(item.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PatternRow({
  item,
  selected,
  onSelect,
}: {
  item: InvoicePatternSummary;
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
            ? "border-l-brand-600 bg-brand-50/60"
            : "border-l-transparent hover:bg-gray-50",
        )}
      >
        <p
          className={cn(
            "text-[12.5px] font-semibold truncate",
            selected ? "text-brand-800" : "text-gray-800",
          )}
          title={item.name}
        >
          {item.name}
        </p>
        {item.vendor_hint && (
          <p
            className="text-[10.5px] text-brand-700/80 truncate mt-0.5"
            title={`Vendor hint: ${item.vendor_hint}`}
          >
            {item.vendor_hint}
          </p>
        )}
        {item.description && (
          <p
            className="text-[10.5px] text-gray-500 truncate mt-0.5"
            title={item.description}
          >
            {item.description}
          </p>
        )}
        <p className="text-[10px] text-gray-400 mt-0.5 inline-flex flex-wrap items-center gap-x-1.5">
          <span>
            {item.source_file_count} file
            {item.source_file_count === 1 ? "" : "s"}
          </span>
          <span className="text-gray-300">·</span>
          <span
            className={cn(
              "font-medium",
              item.region_count > 0 ? "text-brand-700" : "text-gray-400",
            )}
          >
            {item.region_count} region
            {item.region_count === 1 ? "" : "s"}
          </span>
          <span className="text-gray-300">·</span>
          <span>{formatDate(item.updated_at)}</span>
        </p>
      </button>
    </li>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="mx-auto h-10 w-10 rounded-full bg-brand-50 flex items-center justify-center mb-2">
        <FileSearch className="h-5 w-5 text-brand-600" />
      </div>
      <p className="text-sm font-medium text-gray-700">
        No saved patterns yet
      </p>
      <p className="text-[11px] text-gray-500 mt-1">
        Create a pattern to teach the extractor where the canonical
        invoice fields live on a real bill.
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-3"
        onClick={onNew}
      >
        <Plus className="h-3.5 w-3.5" />
        New pattern
      </Button>
    </div>
  );
}
