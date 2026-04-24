"use client";

import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

/**
 * Chip-style multi-value text input.
 *
 * Used by the rule-row cell editor for any column whose source is a
 * catalog binding (vendor / property / GL Code) — and as a generic
 * fallback for any future "list of strings" cell. Each value renders
 * as a removable pill ("chip"); the user adds more by typing into a
 * trailing input and pressing Enter, comma, or Tab.
 *
 * Why a multi-tag input rather than a catalog autocomplete dropdown
 * in this phase:
 *
 *   * The catalog resolution UX is unsettled — there can be multiple
 *     GL/property/vendor catalogs in flight, no canonical "active" one
 *     is enforced yet, and the catalog list endpoints return summaries
 *     rather than entries (so a real autocomplete needs heavy async
 *     detail fetches across N catalogs).
 *   * The shape a future autocomplete would emit is identical to what
 *     this input persists: `string[]` of selected entries. No data
 *     migration needed when the autocomplete arrives — it just
 *     replaces this component behind the same `values` prop.
 *
 * The input deliberately accepts any free-text — it is NOT enforcing
 * "this string exists in the catalog". The runtime resolver will
 * fail loud at execution time for invalid references; for now,
 * authoring rules with typed-in vendor codes is exactly what the user
 * wants when the catalog hasn't been seeded yet.
 */

interface MultiTagInputProps {
  /** Current list of values. Empty array if none. */
  values: string[];
  /** Called with the new full list on add or remove. */
  onChange: (next: string[]) => void;
  /**
   * Placeholder shown in the trailing input. Tailored per source kind
   * by the parent (e.g. "Add vendor code" vs. "Add property abbreviation").
   */
  placeholder?: string;
  /**
   * Grey out + disable add/remove. Used for read-only views and for
   * `derived` columns whose cells aren't user-editable.
   */
  disabled?: boolean;
  /**
   * Per-value max length — enforced on add. Defaults to backend's
   * `MAX_RULE_CELL_VALUE_LENGTH` (200). Pass a tighter cap if the
   * caller knows the data shape (e.g. GL codes are ~10 chars).
   */
  maxValueLength?: number;
  /**
   * Per-cell max number of values. Defaults to backend's
   * `MAX_RULE_CELL_VALUES` (100). Add button silently no-ops at the cap;
   * we don't render an error because the cap is well past any realistic
   * hand-authored cell.
   */
  maxValues?: number;
  /**
   * `aria-label` for the input. Defaults to "Add value". Caller passes
   * a more specific label when the surrounding context isn't obvious
   * (e.g. multiple cells stacked vertically).
   */
  inputAriaLabel?: string;
  className?: string;
}

const DEFAULT_MAX_VALUE_LENGTH = 200;
const DEFAULT_MAX_VALUES = 100;

export function MultiTagInput({
  values,
  onChange,
  placeholder,
  disabled,
  maxValueLength = DEFAULT_MAX_VALUE_LENGTH,
  maxValues = DEFAULT_MAX_VALUES,
  inputAriaLabel = "Add value",
  className,
}: MultiTagInputProps) {
  // The trailing input's draft state. We don't push it into `values`
  // until the user commits (Enter / comma / Tab / blur). Keeping it
  // local lets the user freely correct typos without churning props.
  const [draft, setDraft] = useState("");

  const atCap = values.length >= maxValues;

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (trimmed.length > maxValueLength) return;
    if (atCap) return;
    // Skip duplicates silently — the rule-cell semantics are set-like;
    // re-adding "EPB" twice has no resolver effect anyway.
    if (values.includes(trimmed)) {
      setDraft("");
      return;
    }
    onChange([...values, trimmed]);
    setDraft("");
  };

  const remove = (index: number) => {
    const next = values.slice();
    next.splice(index, 1);
    onChange(next);
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === ",") {
      // Enter / comma both commit and prevent the default (form submit
      // for Enter; literal comma in the value for `,`).
      e.preventDefault();
      commit(draft);
      return;
    }
    if (e.key === "Tab" && draft.trim()) {
      // Tab commits without preventing default — focus moves to the
      // next field after the chip is added, which matches the natural
      // "I'm done with this cell" gesture.
      commit(draft);
      return;
    }
    if (e.key === "Backspace" && !draft && values.length > 0) {
      // Empty-input Backspace removes the trailing chip — standard
      // tag-editor convention.
      e.preventDefault();
      remove(values.length - 1);
      return;
    }
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-md border border-gray-300 bg-white px-1.5 py-1",
        "focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500",
        disabled && "cursor-not-allowed bg-gray-50 opacity-70",
        className,
      )}
    >
      {values.map((value, index) => (
        <span
          key={`${value}-${index}`}
          className={cn(
            "inline-flex items-center gap-1 rounded bg-brand-50 px-1.5 py-0.5 text-[12px] font-medium text-brand-700",
            disabled && "bg-gray-100 text-gray-600",
          )}
        >
          <span className="max-w-[180px] truncate" title={value}>
            {value}
          </span>
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(index)}
              aria-label={`Remove ${value}`}
              className="rounded-sm text-brand-700/70 hover:bg-brand-100 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-500"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKey}
        // `onBlur` commits the in-flight draft so users who tab away
        // without pressing Enter still get their value persisted. We
        // don't commit on every keystroke — that would interleave
        // half-typed tokens with finished ones.
        onBlur={() => {
          if (draft.trim()) commit(draft);
        }}
        placeholder={values.length === 0 ? placeholder : ""}
        disabled={disabled || atCap}
        aria-label={inputAriaLabel}
        maxLength={maxValueLength}
        className={cn(
          "min-w-[80px] flex-1 bg-transparent px-1 py-0.5 text-[13px] text-gray-800 placeholder:text-gray-400",
          "focus:outline-none disabled:cursor-not-allowed",
        )}
      />
    </div>
  );
}
