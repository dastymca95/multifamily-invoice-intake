"use client";

import { useMemo, useState } from "react";

/**
 * Generic case-insensitive substring filter over an entry list.
 *
 * Both the GL and Property catalog editors filter rows the same way:
 * concatenate every searchable field on a row into a haystack, lowercase
 * the search query, and `includes` it. Extracting it here keeps that
 * one-liner consistent and means callers only have to describe HOW to
 * build the haystack for their schema.
 *
 * Hot-path notes:
 *   - The filter recomputes only when `entries` or `search` change. As
 *     long as `toHaystack` is stable, the memo holds across unrelated
 *     re-renders (e.g. typing in the title bar of an isolated
 *     `IsolatedTitleBar` doesn't invalidate this).
 *   - Empty / whitespace search returns the original `entries` reference
 *     (not a copy), so downstream reference-equality checks see no
 *     change when the user clears the search.
 */
export function useGridSearch<TEntry>(
  entries: readonly TEntry[],
  toHaystack: (e: TEntry) => string,
): {
  search: string;
  setSearch: (s: string) => void;
  filtered: TEntry[];
} {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries as TEntry[];
    return (entries as TEntry[]).filter((e) =>
      toHaystack(e).toLowerCase().includes(q),
    );
    // toHaystack is intentionally NOT in deps — callers pass an inline
    // arrow per render and we'd recompute every render. The contract is
    // "the function is pure on its argument", which makes recomputing
    // when entries/search change sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, search]);

  return { search, setSearch, filtered };
}
