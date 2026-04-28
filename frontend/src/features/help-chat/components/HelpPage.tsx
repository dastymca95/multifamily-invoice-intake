"use client";

import { useCallback, useState } from "react";

import { FAQ_CARDS } from "../lib/faqs";
import { FaqGrid } from "./FaqGrid";
import { HelpChatPanel } from "./HelpChatPanel";
import { HelpHeader } from "./HelpHeader";
import { HelpSearchBar } from "./HelpSearchBar";

/**
 * Composition root for the Help Center surface. Stitches together:
 *
 *   1. Header — title + email-support fallback
 *   2. Search — filters the FAQ grid by keyword
 *   3. FAQ grid — one card per workspace (deep-linked)
 *   4. Help chat panel — local-only mock assistant
 *
 * The page intentionally renders the FAQ grid AND the chat panel on
 * the same surface (rather than separate routes) because the two are
 * complementary: the FAQ is where most operator questions get
 * answered fastest, and the chat is the escape hatch for "my question
 * isn't on a card". Putting them side-by-side reinforces "try the
 * cards first" without hiding the chat.
 *
 * State here is minimal: only the FAQ filter from the search bar.
 * Chat owns its own transcript inside `HelpChatPanel`.
 */
export function HelpPage() {
  // null = show all cards (no filter active); array = render this id
  // subset (possibly empty for "no matches" state).
  const [filteredIds, setFilteredIds] = useState<string[] | null>(null);

  // Stable callback so the search bar's effect doesn't refire on
  // every parent render.
  const handleFilteredIdsChange = useCallback((ids: string[] | null) => {
    setFilteredIds(ids);
  }, []);

  const visibleCardCount =
    filteredIds == null ? FAQ_CARDS.length : filteredIds.length;

  return (
    <div className="px-6 py-6 max-w-6xl mx-auto space-y-6">
      <HelpHeader />

      <HelpSearchBar onFilteredIdsChange={handleFilteredIdsChange} />

      <section aria-label="Frequently asked questions">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-ink">
            FAQs by workspace
          </h2>
          {filteredIds != null && (
            <p className="text-[11.5px] text-gray-500 dark:text-ink-muted">
              {visibleCardCount} of {FAQ_CARDS.length} card
              {FAQ_CARDS.length === 1 ? "" : "s"} match
            </p>
          )}
        </div>
        {visibleCardCount === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 dark:border-line dark:bg-surface-muted px-4 py-6 text-center">
            <p className="text-[12.5px] text-gray-600 dark:text-ink-muted">
              No FAQ cards match that search. Try a different keyword,
              or ask the help assistant below.
            </p>
          </div>
        ) : (
          <FilteredFaqGrid filteredIds={filteredIds} />
        )}
      </section>

      <section aria-label="Help assistant">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-ink mb-2">
          Ask the assistant
        </h2>
        <HelpChatPanel />
      </section>
    </div>
  );
}

/**
 * Tiny wrapper around `FaqGrid` that respects the search filter. The
 * grid component itself stays filter-agnostic so it can be reused
 * (e.g. as a dashboard widget) without dragging the search wiring
 * along; this wrapper does the conditional rendering.
 *
 * When `filteredIds` is null the grid renders the full catalog
 * unchanged. Otherwise we render a manual list of cards filtered to
 * the matching ids.
 */
function FilteredFaqGrid({ filteredIds }: { filteredIds: string[] | null }) {
  if (filteredIds == null) return <FaqGrid />;

  // Manually re-render the matching subset rather than passing a
  // filter prop into FaqGrid — keeps that component a "given a list,
  // render it" primitive.
  const idSet = new Set(filteredIds);
  const subset = FAQ_CARDS.filter((c) => idSet.has(c.id));
  return <FilteredCardList cards={subset} />;
}

/**
 * Internal: same visual rhythm as FaqGrid but operates on a passed-in
 * subset. Lives next to its single caller; promote out of this file
 * if a second consumer ever needs it.
 */
function FilteredCardList({
  cards,
}: {
  cards: ReadonlyArray<(typeof FAQ_CARDS)[number]>;
}) {
  // Defer to the same FaqGrid markup by re-rendering inline. We can't
  // call FaqGrid directly because it iterates the full FAQ_CARDS
  // module-level constant; mirror its container classes here.
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <a
            key={card.id}
            href={card.workspaceHref}
            className="group rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-md dark:border-line dark:bg-surface-subtle dark:hover:border-brand-500/60"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center h-8 w-8 rounded-md bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-50 shrink-0">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-ink">
                  {card.title}
                </h3>
              </div>
            </div>
            <div className="mt-2 space-y-1.5">
              {card.body.map((p, i) => (
                <p
                  key={i}
                  className="text-[12px] text-gray-600 dark:text-ink-muted leading-relaxed"
                >
                  {p}
                </p>
              ))}
            </div>
            <p className="text-[11.5px] text-brand-700 font-medium mt-3 group-hover:underline">
              {card.workspaceLabel} →
            </p>
          </a>
        );
      })}
    </div>
  );
}
