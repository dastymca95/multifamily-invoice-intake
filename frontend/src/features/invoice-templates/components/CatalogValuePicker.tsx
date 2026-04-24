"use client";

import {
  AlertTriangle,
  CircleSlash,
  Database,
  ExternalLink,
  Library,
  Loader2,
  Search,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";
import {
  catalogKindLabel,
  type ColumnSourceType,
  type InvoiceTemplateColumn,
  type InvoiceTemplateRuleCell,
  MAX_RULE_CELL_VALUES,
  type RuleCellSelection,
  ruleCellSelections,
} from "@/types/invoice-template";

import {
  type CatalogDetailEntry,
  type CatalogIndex,
  catalogSliceFor,
  fieldValueFor,
} from "../hooks/useCatalogIndex";

/**
 * Catalog-aware searchable picker for one rule cell.
 *
 * Lives in the rule-row table cells (and in the vertical layout's
 * stacked cards) wherever the parent column binds to a master-data
 * catalog (`vendor_field`, `property_field`, `gl_field`). Replaces the
 * generic `MultiTagInput` for those source kinds — operators no longer
 * type free strings hoping they exist; they pick from the bound
 * catalog's actual entries.
 *
 * Why not the inspector's catalog dropdown, just shrunk down: the
 * inspector picks WHICH catalog the column binds against (a one-time,
 * per-column choice). This picker picks WHICH ENTRIES inside that
 * already-bound catalog the rule fires for / restricts to / sets — a
 * per-cell, multi-pick choice.
 *
 * Persistence shape (DUAL writes):
 *
 *   * `cell.values`     — flat string[]; each element is the chosen
 *                         entry's BOUND-FIELD value (whichever field
 *                         `column.source_ref.field` names — vendor_code,
 *                         property_name, gl_code, etc.). The legacy
 *                         resolver path consumes this list directly.
 *   * `cell.selections` — structured RuleCellSelection[]; each carries
 *                         entry_id (resolver's authoritative key),
 *                         field_value (mirror of the corresponding
 *                         `values` entry), and label (display string
 *                         cached at pick time so deleted entries can
 *                         still be diagnosed in the UI).
 *
 * Both arrays are kept in lockstep at write time. Reads prefer
 * `selections` (richer); fall back to `values` if a legacy cell hasn't
 * been touched yet (selections may be empty for cells from older
 * saves).
 *
 * Edge cases handled here (so callers don't have to):
 *
 *   * No catalog bound on the column → show a "bind a catalog first"
 *     placeholder linking to the inspector. The cell can't legitimately
 *     hold catalog ids without a bound catalog.
 *   * Catalog id no longer in the live summary list (deleted catalog) →
 *     show the cached selections greyed with a "(missing) ACME Corp"
 *     suffix so the user can clear them; new selections are blocked
 *     until a valid catalog is re-picked in the inspector.
 *   * Catalog detail in flight → small spinner inside the picker.
 *   * Catalog detail failed → inline error + retry hint.
 *   * Empty catalog (zero entries) → call to action linking to the
 *     `/reference-data/*` builder; new selections blocked.
 *   * Selection's entry_id no longer in the catalog (entry deleted) →
 *     render the chip greyed with a "(missing)" suffix using the cached
 *     `label`, still removable.
 *   * Field not picked on the column → selection still possible (we
 *     fall back to the entry's default fieldValue, usually the name);
 *     a small "field not set" hint nudges the user to finish the
 *     binding.
 */

interface CatalogValuePickerProps {
  column: InvoiceTemplateColumn;
  cell: InvoiceTemplateRuleCell;
  catalogIndex: CatalogIndex;
  onChange: (next: InvoiceTemplateRuleCell) => void;
  /**
   * Read-only render — chips remain visible for inspection but no add
   * / remove is possible. Mirrors the rule-row "active" toggle's
   * behaviour for non-catalog cells.
   */
  disabled?: boolean;
}

export function CatalogValuePicker({
  column,
  cell,
  catalogIndex,
  onChange,
  disabled,
}: CatalogValuePickerProps) {
  const sourceType: ColumnSourceType = column.source_type ?? "empty";
  const labelKind = catalogKindLabel(sourceType);
  const slice = catalogSliceFor(sourceType, catalogIndex);
  const catalogId = column.source_ref?.catalog_id ?? null;
  const catalogLabelCached = column.source_ref?.catalog_label ?? null;
  const boundField = column.source_ref?.field ?? null;

  // ---- Lazy-load detail when a catalog is bound ----------------------
  // Fires on mount AND whenever the bound catalog id changes (e.g.
  // user switched catalogs in the inspector while the cell stayed open).
  // The hook itself dedupes — concurrent ensure calls for the same id
  // share one in-flight fetch.
  const ensureCatalogDetail = catalogIndex.ensureCatalogDetail;
  useEffect(() => {
    if (!catalogId) return;
    void ensureCatalogDetail(sourceType, catalogId);
  }, [catalogId, sourceType, ensureCatalogDetail]);

  // ---- Resolve current state -----------------------------------------

  // Cached selections (always preferred over `values`); fall back to
  // synthesising selections from `values` for legacy cells so the chips
  // render right away even before the user re-edits.
  const selections: RuleCellSelection[] = useMemo(() => {
    const stored = ruleCellSelections(cell);
    if (stored.length > 0) return stored.map((s) => ({ ...s }));
    // Legacy fallback — build synthetic selections from `values`.
    // entry_id is unknown (we never persisted one); we stash a sentinel
    // so the picker can render a "(unbound)" chip instead of silently
    // making it look like a real catalog pick.
    return cell.values.map((v) => ({
      entry_id: "",
      field_value: v,
      label: v,
    }));
  }, [cell]);

  // Live catalog summary lookup (does the bound id resolve?).
  const catalogSummary = catalogId
    ? slice?.items.find((c) => c.id === catalogId) ?? null
    : null;
  const catalogMissing = catalogId !== null && catalogSummary === null && !slice?.loading;

  // Live detail lookup (the actual entries for picking).
  const detail = catalogId
    ? catalogIndex.getCatalogDetail(sourceType, catalogId)
    : null;

  // ---- Branch on the binding state -----------------------------------
  //
  // Order matters: each branch below assumes the previous gates have
  // passed. We render the most "set up further upstream" message first.

  // Source type isn't catalog-backed — caller shouldn't have routed
  // here; render nothing rather than crash.
  if (!labelKind || !slice) return null;

  // No catalog bound on the column at all.
  if (catalogId === null) {
    return (
      <PickerEmptyHint
        tone="info"
        title="Bind a catalog first"
        body={`Open the column inspector to pick which saved ${labelKind.singular} this column should bind against. Then come back to choose entries.`}
      />
    );
  }

  // Bound id no longer matches any catalog in the live list.
  if (catalogMissing) {
    return (
      <div className="space-y-1">
        <PickerEmptyHint
          tone="warning"
          title={`Bound ${labelKind.singular} is missing`}
          body={
            catalogLabelCached
              ? `"${catalogLabelCached}" is no longer available. Re-pick a ${labelKind.singular} in the column inspector to enable selection again.`
              : `The bound ${labelKind.singular} is no longer available. Re-pick one in the column inspector.`
          }
        />
        {/* Render existing selections greyed so the user can audit + clear them. */}
        {selections.length > 0 && (
          <SelectionChipsRow
            selections={selections}
            allDeleted
            disabled={disabled}
            onRemoveAt={(idx) => removeAt(idx, selections, cell, onChange)}
          />
        )}
      </div>
    );
  }

  // Detail still loading first time → small spinner.
  if (!detail || (detail.loading && detail.entries === null)) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-gray-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading {labelKind.singular} entries…
      </div>
    );
  }

  // Detail fetch failed.
  if (detail.error && detail.entries === null) {
    return (
      <PickerEmptyHint
        tone="error"
        title={`Couldn't load ${labelKind.singular}`}
        body={detail.error}
        action={
          <button
            type="button"
            onClick={() => {
              if (catalogId) void ensureCatalogDetail(sourceType, catalogId);
            }}
            className="text-[10.5px] text-red-700 underline underline-offset-2 hover:text-red-800"
          >
            Retry
          </button>
        }
      />
    );
  }

  const entries = detail.entries ?? [];

  // Catalog has zero entries.
  if (entries.length === 0) {
    return (
      <PickerEmptyHint
        tone="warning"
        title={`No entries in ${catalogSummary?.name ?? labelKind.singular}`}
        body={`Add at least one entry to this catalog before you can pick from it here.`}
        action={
          <Link
            href={labelKind.routePath}
            className="inline-flex items-center gap-1 text-[10.5px] text-orange-800 underline underline-offset-2 hover:text-orange-900"
          >
            Open the {labelKind.singular} builder
            <ExternalLink className="h-3 w-3" />
          </Link>
        }
      />
    );
  }

  // ---- Healthy path — render the searchable combobox -----------------

  return (
    <PickerCore
      column={column}
      cell={cell}
      sourceType={sourceType}
      boundField={boundField}
      catalogName={catalogSummary?.name ?? catalogLabelCached ?? "catalog"}
      entries={entries}
      selections={selections}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

// ---------------------------------------------------------------------------
// Picker core — chips + searchable input + dropdown
// ---------------------------------------------------------------------------

interface PickerCoreProps {
  column: InvoiceTemplateColumn;
  /**
   * Threaded through from the picker so write helpers can preserve
   * sibling per-cell facets (extraction binding, role override) when
   * mutating selections. Without this the picker would silently strip
   * `cell.role` on every entry add/remove.
   */
  cell: InvoiceTemplateRuleCell;
  sourceType: ColumnSourceType;
  boundField: string | null;
  catalogName: string;
  entries: CatalogDetailEntry[];
  selections: RuleCellSelection[];
  onChange: (next: InvoiceTemplateRuleCell) => void;
  disabled?: boolean;
}

function PickerCore({
  column,
  cell,
  sourceType,
  boundField,
  catalogName,
  entries,
  selections,
  onChange,
  disabled,
}: PickerCoreProps) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Derived: the set of already-picked entry ids so the dropdown can
  // dim them (and the keyboard "select" can no-op on them).
  const pickedIds = useMemo(() => {
    const s = new Set<string>();
    for (const sel of selections) if (sel.entry_id) s.add(sel.entry_id);
    return s;
  }, [selections]);

  // Filter entries by the lowercased draft against the pre-built
  // haystack. Empty draft shows everything (capped by SUGGESTION_LIMIT
  // so we don't blow up the DOM for a 5000-row vendor list).
  const filtered = useMemo(() => {
    const needle = draft.trim().toLowerCase();
    const all = entries;
    const matched = needle
      ? all.filter((e) => e.searchHaystack.includes(needle))
      : all;
    return matched.slice(0, SUGGESTION_LIMIT);
  }, [draft, entries]);

  // Keep highlight in range when the filter result shrinks.
  useEffect(() => {
    if (highlightIdx >= filtered.length) {
      setHighlightIdx(filtered.length === 0 ? 0 : filtered.length - 1);
    }
  }, [filtered.length, highlightIdx]);

  // Click-outside / Escape closes the dropdown without committing.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Keep the highlighted row scrolled into view as the user arrows
  // down a long list.
  useEffect(() => {
    if (!open) return;
    const ul = listRef.current;
    if (!ul) return;
    const li = ul.children.item(highlightIdx) as HTMLElement | null;
    if (li) li.scrollIntoView({ block: "nearest" });
  }, [highlightIdx, open]);

  const atCap = selections.length >= MAX_RULE_CELL_VALUES;

  const commitEntry = (entry: CatalogDetailEntry) => {
    if (disabled || atCap) return;
    if (pickedIds.has(entry.entryId)) return;
    const fieldValue =
      fieldValueFor(entry.raw, boundField).trim() ||
      // Adapter default: the entry's display "name" — guarantees a
      // non-empty mirror in `cell.values` even when the bound field is
      // unset or the entry's bound-field cell is blank. The runtime
      // resolver matches on entry_id (via selections), so this is a
      // diagnostic display, not a load-bearing key.
      entry.fieldValue;
    const next: RuleCellSelection = {
      entry_id: entry.entryId,
      field_value: fieldValue,
      label: entry.label,
    };
    writeSelections([...selections, next], cell, onChange);
    setDraft("");
    setHighlightIdx(0);
    // Re-focus the input so the operator can keep typing more picks
    // without a click — common for "rule fires for these 5 vendors".
    inputRef.current?.focus();
  };

  const removeAtIdx = (idx: number) => {
    if (disabled) return;
    removeAt(idx, selections, cell, onChange);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlightIdx((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setHighlightIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (open && filtered[highlightIdx]) {
        commitEntry(filtered[highlightIdx]);
      } else if (filtered.length > 0) {
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setDraft("");
      return;
    }
    if (e.key === "Backspace" && draft === "" && selections.length > 0) {
      e.preventDefault();
      removeAtIdx(selections.length - 1);
      return;
    }
    if (e.key === "Tab") {
      // Don't preventDefault — let focus move on. Close the dropdown
      // since the user clearly moved on.
      setOpen(false);
      return;
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <div
        className={cn(
          "flex flex-wrap items-center gap-1 rounded-md border border-gray-300 bg-white px-1.5 py-1",
          "focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500",
          disabled && "cursor-not-allowed bg-gray-50 opacity-70",
        )}
      >
        {selections.map((sel, i) => {
          const live = entries.find((e) => e.entryId === sel.entry_id);
          // Two failure modes for chips:
          //   1. entry_id is empty (legacy cell) → "unbound" tone
          //   2. entry_id present but no live match → "missing"
          const isMissing = sel.entry_id === "" || (sel.entry_id !== "" && !live);
          return (
            <SelectionChip
              key={`${sel.entry_id || "legacy"}-${i}`}
              selection={sel}
              live={live}
              isMissing={isMissing}
              isLegacy={sel.entry_id === ""}
              disabled={disabled}
              onRemove={() => removeAtIdx(i)}
            />
          );
        })}
        <div className="flex-1 min-w-[8rem] inline-flex items-center gap-1">
          <Search className="h-3 w-3 text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(e) => {
              setDraft(e.target.value);
              setOpen(true);
              setHighlightIdx(0);
            }}
            onKeyDown={handleKeyDown}
            disabled={disabled || atCap}
            placeholder={
              selections.length === 0
                ? `Search ${catalogName}…`
                : atCap
                  ? `Cell at cap (${MAX_RULE_CELL_VALUES})`
                  : "Add another…"
            }
            aria-label={`Search ${catalogName} entries for ${column.name}`}
            aria-expanded={open}
            aria-haspopup="listbox"
            className={cn(
              "min-w-[6rem] flex-1 bg-transparent px-1 py-0.5 text-[12.5px] text-gray-800 placeholder:text-gray-400",
              "focus:outline-none disabled:cursor-not-allowed",
            )}
          />
        </div>
      </div>

      {/* Helper line: bound catalog + bound field. Tiny so it doesn't
          steal focus from the chips, but makes the binding context
          legible. Skipped when the column has bound everything cleanly
          and nothing is worth nagging about. */}
      <PickerStatusLine
        catalogName={catalogName}
        boundField={boundField}
        sourceType={sourceType}
      />

      {/* Dropdown */}
      {open && !disabled && (
        <div
          className="absolute left-0 right-0 z-40 mt-1 max-h-72 min-w-[16rem] overflow-auto rounded-md border border-gray-200 bg-white shadow-lg"
          role="listbox"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-[12px] italic text-gray-500 inline-flex items-center gap-1.5">
              <CircleSlash className="h-3 w-3" />
              No matches in {catalogName}
            </div>
          ) : (
            <ul ref={listRef} className="py-1">
              {filtered.map((entry, idx) => {
                const isPicked = pickedIds.has(entry.entryId);
                const isHighlighted = idx === highlightIdx;
                const previewFieldValue = fieldValueFor(entry.raw, boundField);
                return (
                  <li
                    key={entry.entryId}
                    role="option"
                    aria-selected={isHighlighted}
                    aria-disabled={isPicked}
                    onMouseEnter={() => setHighlightIdx(idx)}
                    onMouseDown={(e) => {
                      // mousedown (not click) so the input doesn't blur
                      // → close → swallow the click.
                      e.preventDefault();
                      if (!isPicked) commitEntry(entry);
                    }}
                    className={cn(
                      "px-3 py-1.5 cursor-pointer flex items-start gap-2 border-l-2",
                      isHighlighted && !isPicked
                        ? "bg-brand-50 border-brand-500"
                        : "border-transparent",
                      isPicked && "opacity-50 cursor-not-allowed",
                      !entry.active && "italic",
                    )}
                  >
                    <Library className="h-3 w-3 mt-1 text-gray-300 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        <span
                          className={cn(
                            "text-[12.5px] font-medium truncate",
                            isPicked ? "text-gray-500" : "text-gray-800",
                          )}
                        >
                          {entry.label}
                        </span>
                        {!entry.active && (
                          <span className="text-[9.5px] uppercase tracking-wide text-gray-400 shrink-0">
                            inactive
                          </span>
                        )}
                        {isPicked && (
                          <span className="text-[9.5px] uppercase tracking-wide text-brand-600 shrink-0">
                            picked
                          </span>
                        )}
                      </div>
                      {entry.secondary && (
                        <div className="text-[10.5px] text-gray-500 truncate">
                          {entry.secondary}
                        </div>
                      )}
                      {/* Show the projected field value if it differs
                          from the label — clarifies what'll actually be
                          stored / matched. */}
                      {previewFieldValue && previewFieldValue !== entry.label && (
                        <div className="text-[9.5px] text-gray-400 font-mono mt-0.5 truncate">
                          → {previewFieldValue}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
              {/* Suggestion-cap notice — let the user know there's more
                  hidden behind their query. */}
              {entries.length > SUGGESTION_LIMIT && filtered.length === SUGGESTION_LIMIT && (
                <li className="px-3 py-1.5 text-[10.5px] text-gray-400 italic border-t border-gray-100">
                  Showing first {SUGGESTION_LIMIT}. Type to narrow.
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small helpers + presentational pieces
// ---------------------------------------------------------------------------

const SUGGESTION_LIMIT = 50;

function writeSelections(
  next: RuleCellSelection[],
  cell: InvoiceTemplateRuleCell,
  onChange: (cell: InvoiceTemplateRuleCell) => void,
) {
  // Mirror selections.field_value → values 1:1 so the legacy
  // resolver path keeps working without consulting `selections`.
  //
  // Round-trip every sibling per-cell facet so a catalog-pick edit
  // doesn't silently erase work the operator did elsewhere on the cell:
  //   * `extraction` (legacy single-binding) and `extraction_bindings`
  //     (Phase 2 multi-binding list) — only meaningful on
  //     `invoice_field` cells (catalog branches never author them), but
  //     defending defensively keeps this helper safe to call from any
  //     branch and stops a future accidental cross-source edit from
  //     silently dropping bindings.
  //   * `role` — Phase 2 per-cell role override. Picking another vendor
  //     in a catalog cell mustn't reset a custom IF/LIMIT/FILL the
  //     operator pinned via the role chip.
  onChange({
    values: next.map((s) => s.field_value),
    selections: next,
    extraction: cell.extraction ?? null,
    extraction_bindings: cell.extraction_bindings ?? [],
    role: cell.role ?? null,
  });
}

function removeAt(
  idx: number,
  selections: RuleCellSelection[],
  cell: InvoiceTemplateRuleCell,
  onChange: (cell: InvoiceTemplateRuleCell) => void,
) {
  if (idx < 0 || idx >= selections.length) return;
  const next = selections.slice();
  next.splice(idx, 1);
  writeSelections(next, cell, onChange);
}

function SelectionChip({
  selection,
  live,
  isMissing,
  isLegacy,
  disabled,
  onRemove,
}: {
  selection: RuleCellSelection;
  live: CatalogDetailEntry | undefined;
  isMissing: boolean;
  isLegacy: boolean;
  disabled?: boolean;
  onRemove: () => void;
}) {
  // Display: prefer the live entry's label (catches catalog renames
  // mid-session) and fall back to the cached selection label. Missing
  // entries get an italic + greyed treatment so they're obvious.
  const display = live?.label ?? selection.label ?? selection.field_value;
  const tone = isMissing
    ? "bg-amber-50 text-amber-800 ring-1 ring-amber-200"
    : "bg-brand-50 text-brand-700";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium",
        tone,
        disabled && "opacity-60",
      )}
      title={
        isLegacy
          ? `Legacy free-text value: "${selection.field_value}"`
          : isMissing
            ? `Selected entry no longer exists in the bound catalog: "${selection.label || selection.field_value}"`
            : `${display}${selection.field_value && selection.field_value !== display ? ` (resolves to "${selection.field_value}")` : ""}`
      }
    >
      {isMissing && <AlertTriangle className="h-2.5 w-2.5 shrink-0" />}
      <span className="max-w-[10rem] truncate">
        {isMissing && !isLegacy ? `(missing) ${display}` : display}
      </span>
      {!disabled && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${display}`}
          className={cn(
            "rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-500",
            isMissing
              ? "text-amber-700/70 hover:bg-amber-100 hover:text-amber-800"
              : "text-brand-700/70 hover:bg-brand-100 hover:text-brand-700",
          )}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function SelectionChipsRow({
  selections,
  allDeleted,
  disabled,
  onRemoveAt,
}: {
  selections: RuleCellSelection[];
  allDeleted: boolean;
  disabled?: boolean;
  onRemoveAt: (idx: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {selections.map((sel, i) => (
        <SelectionChip
          key={`${sel.entry_id || "legacy"}-${i}`}
          selection={sel}
          live={undefined}
          isMissing={allDeleted || sel.entry_id === ""}
          isLegacy={sel.entry_id === ""}
          disabled={disabled}
          onRemove={() => onRemoveAt(i)}
        />
      ))}
    </div>
  );
}

function PickerEmptyHint({
  tone,
  title,
  body,
  action,
}: {
  tone: "info" | "warning" | "error";
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  const cls =
    tone === "error"
      ? "border-red-200 bg-red-50/60 text-red-800"
      : tone === "warning"
        ? "border-amber-200 bg-amber-50/60 text-amber-800"
        : "border-gray-200 bg-gray-50/60 text-gray-700";
  const Icon = tone === "error" ? AlertTriangle : Database;
  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-1.5 text-[11px] flex items-start gap-1.5",
        cls,
      )}
    >
      <Icon className="h-3 w-3 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">{title}</p>
        <p className="leading-snug mt-0.5">{body}</p>
        {action && <div className="mt-1">{action}</div>}
      </div>
    </div>
  );
}

function PickerStatusLine({
  catalogName,
  boundField,
  sourceType,
}: {
  catalogName: string;
  boundField: string | null;
  sourceType: ColumnSourceType;
}) {
  const labelKind = catalogKindLabel(sourceType);
  if (!labelKind) return null;
  return (
    <div className="mt-0.5 flex items-center gap-1 text-[9.5px] text-gray-400">
      <Library className="h-2.5 w-2.5" />
      <span className="truncate">
        Pulling from <span className="text-gray-600 font-medium">{catalogName}</span>
        {boundField ? (
          <>
            {" "}· field{" "}
            <span className="text-gray-600 font-mono">{boundField}</span>
          </>
        ) : (
          <span className="text-amber-700">
            {" "}· no field set (using default)
          </span>
        )}
      </span>
    </div>
  );
}
