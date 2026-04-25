"use client";

import { memo, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Sticky-top, CSS-grid-based header row for `<VirtualizedRowGrid>`.
 *
 * Headers and rows share the same `gridTemplateColumns` string so that
 * column alignment Just Works without needing a `<colgroup>` (which we
 * can't use here because the rows are absolutely-positioned `<div>`s
 * placed by `@tanstack/react-virtual`, not table rows).
 *
 * Memoized so it doesn't re-render when entries change. The columns
 * shape rarely changes within a session.
 */
export interface GridHeaderRowProps {
  gridTemplateColumns: string;
  children: ReactNode;
  className?: string;
}

export const GridHeaderRow = memo(function GridHeaderRow({
  gridTemplateColumns,
  children,
  className,
}: GridHeaderRowProps) {
  return (
    <div
      className={cn(
        // Light: subtle gray header on white grid bg.
        // Dark: lifted slate panel against the slate-900 grid bg, with
        // ink-subtle text so the all-caps reads quietly without competing
        // with row content.
        "bg-gray-50 text-[10.5px] uppercase tracking-wide text-gray-500",
        "dark:bg-surface-muted dark:text-ink-subtle",
        "sticky top-0 z-10 border-b border-gray-200 dark:border-line",
        className,
      )}
      style={{ display: "grid", gridTemplateColumns }}
    >
      {children}
    </div>
  );
});

/** Single header cell. Pads + left-aligns text. */
export function HeaderCell({
  children,
  ...rest
}: { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="px-2 py-2 text-left" {...rest}>
      {children}
    </div>
  );
}
