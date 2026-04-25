"use client";

import { Plus, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/Button";

/**
 * Centered empty-state shown inside a catalog editor's grid when the
 * catalog has no rows. Same shape across catalogs (icon-in-circle +
 * title + body + add button); per-catalog copy and icon are passed in.
 *
 * Lives next to the grid (not inside it) so callers can swap it for a
 * "no results" message when a search filter empties the visible list.
 */
export interface EmptyTablePromptProps {
  icon: LucideIcon;
  title: string;
  body: string;
  /** Label for the call-to-action button. Default: "Add the first row". */
  addLabel?: string;
  onAdd: () => void;
}

export function EmptyTablePrompt({
  icon: Icon,
  title,
  body,
  addLabel = "Add the first row",
  onAdd,
}: EmptyTablePromptProps) {
  return (
    <div className="py-2">
      <div className="mx-auto h-10 w-10 rounded-full bg-brand-50 dark:bg-brand-900/40 flex items-center justify-center mb-2">
        <Icon className="h-5 w-5 text-brand-600 dark:text-brand-50" />
      </div>
      <p className="text-sm font-medium text-gray-700 dark:text-ink">{title}</p>
      <p className="text-[11px] text-gray-500 dark:text-ink-subtle mt-1 max-w-md mx-auto">
        {body}
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-3"
        onClick={onAdd}
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}
