"use client";

import { LayoutGrid, Loader2, Plus, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { cn, formatDate } from "@/lib/utils";
import type { ImportConfigSummary } from "@/types/import-config";

/**
 * Left rail of the Import Builder workspace.
 *
 * Mirrors the upload page's batch-rail visual rhythm:
 *   * top "+ New" CTA
 *   * a stack of selectable rows showing name + small meta line
 *   * empty state when nothing's saved yet
 *
 * Selection is a controlled prop — the workspace owns the
 * `selectedId` so the right pane always reflects the rail's choice.
 */
interface ConfigListProps {
  items: ImportConfigSummary[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRetry: () => void;
}

export function ConfigList({
  items,
  selectedId,
  loading,
  error,
  onSelect,
  onNew,
  onRetry,
}: ConfigListProps) {
  return (
    <div className="flex flex-col h-full bg-white border-r border-gray-200">
      {/* ---- Header ----------------------------------------------------- */}
      <div className="px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-4 w-4 text-brand-700" />
          <h2 className="text-sm font-semibold text-gray-800">
            Saved configurations
          </h2>
        </div>
        <p className="text-[10.5px] text-gray-500 mt-0.5">
          Each entry is a saved import design. Open one to render its
          spreadsheet, or create a new one to start from defaults.
        </p>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="w-full mt-2.5"
          onClick={onNew}
        >
          <Plus className="h-3.5 w-3.5" />
          New configuration
        </Button>
      </div>

      {/* ---- Body ------------------------------------------------------- */}
      <div className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <div className="p-3">
            <InlineAlert
              tone="error"
              title="Couldn't load configs"
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
            Loading saved configs…
          </p>
        ) : items.length === 0 ? (
          <EmptyState onNew={onNew} />
        ) : (
          <ul className="py-1">
            {items.map((item) => (
              <ConfigListRow
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

function ConfigListRow({
  item,
  selected,
  onSelect,
}: {
  item: ImportConfigSummary;
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
        {item.description && (
          <p
            className="text-[10.5px] text-gray-500 truncate mt-0.5"
            title={item.description}
          >
            {item.description}
          </p>
        )}
        <p className="text-[10px] text-gray-400 mt-0.5 inline-flex items-center gap-1.5">
          {item.override_count > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-brand-700">
              <Sparkles className="h-2.5 w-2.5" />
              {item.override_count} pin
              {item.override_count === 1 ? "" : "s"}
            </span>
          ) : (
            <span>No overrides</span>
          )}
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
        <LayoutGrid className="h-5 w-5 text-brand-600" />
      </div>
      <p className="text-sm font-medium text-gray-700">
        No saved configurations yet
      </p>
      <p className="text-[11px] text-gray-500 mt-1">
        Create one to start designing the shape of your future ResMan import.
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-3"
        onClick={onNew}
      >
        <Plus className="h-3.5 w-3.5" />
        New configuration
      </Button>
    </div>
  );
}
