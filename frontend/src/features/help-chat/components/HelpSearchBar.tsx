"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";

import { FAQ_CARDS } from "../lib/faqs";

/**
 * Help-page search input — preview surface only. No real query
 * indexing yet; what it DOES do today is filter the FAQ cards by
 * substring (title + body) so operators get visible feedback while
 * typing and can find a card by half-remembered keyword. The
 * filtered ids are surfaced to the parent via `onFilteredIdsChange`.
 *
 * Why search at all on a 5-card grid: the FAQ catalog will grow
 * (release notes, integration setup, troubleshooting) and the
 * search affordance is the right hook for that future work. Today
 * it's a useful narrowing tool even on five cards; later it becomes
 * the entry point for full-text help search.
 */
interface HelpSearchBarProps {
  onFilteredIdsChange: (ids: string[] | null) => void;
}

export function HelpSearchBar({ onFilteredIdsChange }: HelpSearchBarProps) {
  const [query, setQuery] = useState("");

  // Filtered id list — null when the query is empty so the parent
  // can render the unfiltered grid instead of "0 results". Push to
  // the parent in an effect (NOT useMemo) since the callback is a
  // side effect, not a memoised value.
  useEffect(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      onFilteredIdsChange(null);
      return;
    }
    const ids = FAQ_CARDS.filter((c) => {
      const haystack = (c.title + " " + c.body.join(" ")).toLowerCase();
      return haystack.includes(trimmed);
    }).map((c) => c.id);
    onFilteredIdsChange(ids);
  }, [query, onFilteredIdsChange]);

  return (
    <div className="relative">
      <Search
        className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none"
        aria-hidden
      />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search help (filters FAQ cards by keyword)"
        aria-label="Search help"
        className="w-full pl-9 pr-3 py-2 rounded-md border border-gray-300 bg-white text-[13px] text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-line dark:bg-surface-subtle dark:text-ink dark:placeholder:text-ink-subtle"
      />
    </div>
  );
}
