"use client";

import { cn } from "@/lib/utils";

export type QueueFilter = "all" | "needs_review" | "reviewed" | "problem";

interface DocumentQueueFiltersProps {
  value: QueueFilter;
  counts: Record<QueueFilter, number>;
  onChange: (filter: QueueFilter) => void;
}

const FILTERS: Array<{ key: QueueFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "needs_review", label: "Needs review" },
  { key: "reviewed", label: "Reviewed" },
  { key: "problem", label: "Failed / problem" },
];

export function DocumentQueueFilters({ value, counts, onChange }: DocumentQueueFiltersProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {FILTERS.map((f) => {
        const active = value === f.key;
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onChange(f.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-brand-600 text-white"
                : "bg-white border border-gray-300 text-gray-700 hover:bg-gray-50",
            )}
          >
            {f.label}
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                active ? "bg-white/20 text-white" : "bg-gray-100 text-gray-600",
              )}
            >
              {counts[f.key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
