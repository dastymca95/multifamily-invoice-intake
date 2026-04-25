"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { FAQ_CARDS, type FaqCard } from "../lib/faqs";

/**
 * Static "what is each workspace?" FAQ grid. Renders the curated
 * `FAQ_CARDS` catalog as clickable cards — each card is itself a
 * deep link into the workspace it describes so the operator can read
 * about it and jump straight there in one motion.
 *
 * Why one card per workspace (and not e.g. cards-per-FAQ-question):
 * the questions cluster by workspace; a card-per-question grid would
 * push the operator into an information-find loop ("which question
 * is most like mine?") instead of "which workspace handles this?".
 * Workspace-keyed cards match the mental model the sidebar already
 * trains.
 */
export function FaqGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {FAQ_CARDS.map((card) => (
        <FaqCardItem key={card.id} card={card} />
      ))}
    </div>
  );
}

function FaqCardItem({ card }: { card: FaqCard }) {
  const Icon = card.icon;
  return (
    <Link
      href={card.workspaceHref}
      className="group rounded-lg border border-gray-200 bg-white p-4 hover:border-brand-400 hover:shadow-sm transition-all dark:border-line dark:bg-surface-subtle dark:hover:border-brand-500"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center h-8 w-8 rounded-md bg-brand-50 text-brand-700 shrink-0 dark:bg-brand-900/40 dark:text-brand-50">
            <Icon className="h-4 w-4" aria-hidden />
          </span>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-ink">
            {card.title}
          </h3>
        </div>
        <ArrowUpRight
          className="h-3.5 w-3.5 text-gray-400 group-hover:text-brand-600 mt-1.5 transition-colors dark:text-ink-subtle"
          aria-hidden
        />
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
      <p className="text-[11.5px] text-brand-700 dark:text-brand-50 font-medium mt-3 group-hover:underline">
        {card.workspaceLabel} →
      </p>
    </Link>
  );
}
