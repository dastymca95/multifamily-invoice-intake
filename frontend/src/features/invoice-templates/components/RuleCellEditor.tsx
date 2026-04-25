"use client";

import { cn } from "@/lib/utils";
import { ChevronDown, Lock } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type ColumnSourceType,
  type InvoiceTemplateColumn,
  type InvoiceTemplateRuleCell,
  type RuleCellExtractionBinding,
  type RuleRole,
  MAX_RULE_CELL_VALUE_LENGTH,
  RULE_ROLE_LABEL,
  RULE_ROLE_OPERATOR_LABEL,
  RULE_ROLE_TONE,
  columnAllowsRuleOverride,
  effectiveCellRole,
  effectiveColumnDefaultRole,
  readRuleCellExtractionBindings,
} from "@/types/invoice-template";

import type { CatalogIndex } from "../hooks/useCatalogIndex";

import { CatalogValuePicker } from "./CatalogValuePicker";
import { InvoiceExtractionPicker } from "./InvoiceExtractionPicker";

/**
 * One rule cell's editor — discriminated dispatch on the column's
 * `source_type` so the user gets the right input shape per column:
 *
 *   * `vendor_field` / `property_field` / `gl_field` — searchable
 *     CATALOG PICKER. The picker reads the column's bound catalog
 *     (id from `source_ref.catalog_id`) and lets the operator pick
 *     real entries from it. Selections persist in `cell.selections`
 *     (structured: entry_id + field_value + label) AND mirror into
 *     `cell.values` for the legacy resolver path. No more arbitrary
 *     free text in catalog cells.
 *   * `manual_list` — multi-select against the column's
 *     `manual_values` enum. Renders as toggle pills (selected /
 *     unselected) so the bounded option set is visible at a glance.
 *   * `invoice_field` — multi-tag chip input (free text). Each chip is
 *     a literal value the rule's condition matches against (e.g. "USD",
 *     "EUR" for a Currency column). Stays free text because invoice
 *     fields aren't catalog-backed; the literal IS what the resolver
 *     compares.
 *   * `fixed_value` — single-line text input. Rule cell here ACTS AS
 *     a per-row override of the column's `default_value`. Stored as
 *     a one-element list (or empty for "use the column default").
 *   * `empty` — single-line text input. Stored as a one-element list.
 *     The user is suggesting / setting an output value for a column
 *     that has no source binding.
 *   * `derived` — disabled placeholder. The derived-rule editor lives
 *     in a follow-up phase; the cell can't be hand-authored.
 *
 * The editor never mutates `cell` directly — it calls `onChange` with
 * the new full cell (replace-not-merge). Cells with empty `values`
 * are inert at runtime, so deletion is just clearing all values.
 *
 * Catalog index is REQUIRED for catalog source kinds — the picker
 * needs the bound catalog's entry list. The editor takes the index
 * uniformly so callers don't need to branch on source kind.
 */

interface RuleCellEditorProps {
  column: InvoiceTemplateColumn;
  cell: InvoiceTemplateRuleCell;
  onChange: (next: InvoiceTemplateRuleCell) => void;
  /**
   * Saved-catalog summaries + lazy detail cache. Required even when
   * the column's source kind isn't catalog-backed (the editor doesn't
   * branch the prop interface on source kind to keep call sites
   * uniform). Non-catalog branches simply ignore it.
   */
  catalogIndex: CatalogIndex;
  /**
   * Read-only render. Used when the parent rule's `is_active` is
   * false — the cell still shows its values so the operator can see
   * the saved state, but it can't be edited until the rule is
   * re-activated. Keeps the "inactive but recoverable" workflow
   * obvious.
   */
  disabled?: boolean;
}

export function RuleCellEditor({
  column,
  cell,
  onChange,
  catalogIndex,
  disabled,
}: RuleCellEditorProps) {
  const sourceType: ColumnSourceType = column.source_type ?? "empty";
  // When the column's `allow_rule_override` is OFF, the global behavior
  // wins at resolve time — rule cells are still recorded (so the user
  // can flip the switch back without re-authoring) but inert. We wrap
  // the editor in a small banner so the operator sees a coherent story
  // with the lock chip on the column header / field label: edit if you
  // want, but know that the runtime resolver isn't going to use it.
  const ruleOverrideLocked = !columnAllowsRuleOverride(column);

  // Bookkeeping helpers shared across branches.
  //
  // Each helper round-trips the OTHER persisted facets of the cell so a
  // value-only edit doesn't silently erase a previously-set extraction
  // narrowing (Invoice Builder ↔ Import Builder bridge) or role
  // override (Phase 2 — per-cell rule role can differ from the
  // column's `default_rule_role`). Catalog cells never carry extraction
  // bindings and the catalog branch routes through `CatalogValuePicker`
  // (which does its own preservation, see below), so the no-op pass-
  // through here is safe in every branch.
  //
  // Two extraction shapes co-exist on the wire (Phase 2 multi-binding
  // refactor):
  //   * `extraction_bindings` — the new list-shaped narrowing. Editors
  //                             write THIS exclusively going forward.
  //   * `extraction`          — legacy single-binding. We pass it
  //                             through unmodified so a future cleanup
  //                             pass can drop the field without re-
  //                             rewriting saved cells; readers should
  //                             prefer `readRuleCellExtractionBindings`.
  const preservedBindings = cell.extraction_bindings ?? [];
  const setValues = (next: string[]) =>
    // For non-catalog cells we leave selections empty — the
    // discriminated dispatch only writes selections through the catalog
    // picker. Round-trips on legacy cells stay clean.
    onChange({
      values: next,
      selections: [],
      extraction: cell.extraction ?? null,
      extraction_bindings: preservedBindings,
      role: cell.role ?? null,
    });
  const setSingle = (raw: string) => {
    const trimmed = raw.trim();
    onChange({
      values: trimmed ? [trimmed] : [],
      selections: [],
      extraction: cell.extraction ?? null,
      extraction_bindings: preservedBindings,
      role: cell.role ?? null,
    });
  };
  const setExtractionBindings = (next: RuleCellExtractionBinding[]) =>
    onChange({
      values: cell.values,
      selections: cell.selections ?? [],
      // Leave the legacy `extraction` field untouched — readers always
      // prefer `extraction_bindings` (see `readRuleCellExtractionBindings`)
      // and a future cleanup pass can drop the legacy field without
      // re-rewriting saved cells.
      extraction: cell.extraction ?? null,
      extraction_bindings: next,
      role: cell.role ?? null,
    });
  // Per-cell role override. `next === null` means "inherit from column"
  // — we strip the persisted role so legacy + new readers both fall
  // through to `column.default_rule_role` via `effectiveCellRole`.
  const setRole = (next: RuleRole | null) =>
    onChange({
      values: cell.values,
      selections: cell.selections ?? [],
      extraction: cell.extraction ?? null,
      extraction_bindings: preservedBindings,
      role: next,
    });
  const single = cell.values[0] ?? "";

  // Derived cells skip the role chip — the rule expression decides
  // their behavior, no hand-edited role applies. Disabled (inactive
  // rule) cells STILL show the chip so the operator can see the
  // current role at a glance without re-activating; the chip's button
  // honours `disabled` and won't open the popover.
  const showRoleChip = sourceType !== "derived";
  const cellRole = effectiveCellRole(cell, column);
  const columnDefaultRole = effectiveColumnDefaultRole(column);
  const hasExplicitRole = cell.role !== undefined && cell.role !== null;

  const inner = renderInner();

  // No chrome needed when the cell is derived (own affordance), or when
  // there's nothing to surface (no role chip + no override-locked
  // banner). Keeps simple cells visually unchanged from Phase 1.
  if (!showRoleChip && !ruleOverrideLocked) return inner;

  return (
    <div className="space-y-1">
      {/* Header bar — in-flow so cells across a row align consistently
          (vs. the Phase 1 absolute-positioned overlay which only existed
          in locked columns and broke the row's vertical baseline).
          Carries the per-cell role chip and (when `allow_rule_override`
          is OFF on the column) the "Global wins" amber badge. */}
      <div className="flex items-center gap-1">
        {showRoleChip && (
          <RuleCellRoleChip
            cellRole={cellRole}
            columnDefaultRole={columnDefaultRole}
            hasExplicitRole={hasExplicitRole}
            onPick={setRole}
            disabled={disabled}
          />
        )}
        <div className="flex-1" />
        {ruleOverrideLocked && (
          <span
            aria-label="Global behavior wins — rule cell is recorded but inert at resolve time"
            title="Allow rule override is OFF on this column. Cell values are saved, but the column's global behavior wins at resolve time."
            className={cn(
              "inline-flex items-center gap-0.5 rounded",
              "bg-amber-100 ring-1 ring-amber-300 px-1 py-px",
              "dark:bg-yellow-950/40 dark:ring-yellow-900",
              "text-[8.5px] font-bold uppercase tracking-wide text-amber-800",
              "dark:text-yellow-200",
            )}
          >
            <Lock className="h-2 w-2" />
            Global wins
          </span>
        )}
      </div>
      {inner}
    </div>
  );

  function renderInner() {
    switch (sourceType) {
    // -----------------------------------------------------------------
    // Manual list — toggle pills against the column's enumerated values
    // -----------------------------------------------------------------
    case "manual_list": {
      const options = column.manual_values ?? [];
      if (options.length === 0) {
        // Column hasn't defined its enum yet — show a contextual hint
        // rather than a useless empty cell.
        return (
          <div className="text-[12px] italic text-gray-400 dark:text-ink-subtle">
            No list values defined on column
          </div>
        );
      }
      const selected = new Set(cell.values);
      const toggle = (option: string) => {
        if (disabled) return;
        const next = new Set(selected);
        if (next.has(option)) next.delete(option);
        else next.add(option);
        setValues(Array.from(next));
      };
      return (
        <div className="flex flex-wrap gap-1">
          {options.map((option) => {
            const isOn = selected.has(option);
            return (
              <button
                key={option}
                type="button"
                onClick={() => toggle(option)}
                disabled={disabled}
                aria-pressed={isOn}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[12px] transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
                  isOn
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-line dark:bg-surface-subtle dark:text-ink-muted dark:hover:bg-surface-muted",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                {option}
              </button>
            );
          })}
        </div>
      );
    }

    // -----------------------------------------------------------------
    // Catalog bindings — searchable picker against the bound catalog
    // -----------------------------------------------------------------
    case "vendor_field":
    case "property_field":
    case "gl_field":
      return (
        <CatalogValuePicker
          column={column}
          cell={cell}
          catalogIndex={catalogIndex}
          onChange={onChange}
          disabled={disabled}
        />
      );

    // -----------------------------------------------------------------
    // Invoice fields — pattern→field extraction-context narrowing,
    // with NO literal-text chip input.
    //
    // The Phase 2 design (multi-binding refactor) deliberately drops
    // the free-text chip input on invoice_field cells: literal values
    // were never the right authoring affordance for "where does this
    // value come from in the bill?". Each cell carries one or more
    // (pattern, field) bindings instead — see
    // `RuleCellExtractionBinding`. Empty bindings = broad-universe
    // fallback (the column's global extraction behavior wins, fanning
    // across all saved patterns + OCR + AI inference). Rules NARROW;
    // they don't gate.
    //
    // The picker handles the legacy single-binding `extraction` shape
    // transparently via `readRuleCellExtractionBindings` — old saves
    // light up as a one-item bindings list automatically.
    // -----------------------------------------------------------------
    case "invoice_field":
      return (
        <InvoiceExtractionPicker
          bindings={readRuleCellExtractionBindings(cell)}
          onChange={setExtractionBindings}
          defaultFieldKey={column.source_ref?.field ?? null}
          disabled={disabled}
        />
      );

    // -----------------------------------------------------------------
    // Free text — single literal value (fixed_value override or empty
    // column suggestion). One-element list under the hood.
    // -----------------------------------------------------------------
    case "fixed_value":
    case "empty":
      return (
        <input
          type="text"
          value={single}
          onChange={(e) => setSingle(e.target.value)}
          disabled={disabled}
          placeholder={
            sourceType === "fixed_value"
              ? column.default_value
                ? `Override (default: ${column.default_value})`
                : "Override default value…"
              : "Suggest a value…"
          }
          maxLength={MAX_RULE_CELL_VALUE_LENGTH}
          aria-label={`Value for ${column.name}`}
          className={cn(
            "w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-[13px] text-gray-800 placeholder:text-gray-400",
            "dark:border-line dark:bg-surface dark:text-ink dark:placeholder:text-ink-subtle",
            "focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500",
            disabled &&
              "cursor-not-allowed bg-gray-50 opacity-70 dark:bg-surface-muted",
          )}
        />
      );

    // -----------------------------------------------------------------
    // Derived columns — editor deferred. Show a locked affordance so
    // the operator knows the cell intentionally isn't hand-editable.
    // -----------------------------------------------------------------
    case "derived":
      return (
        <div
          className="flex items-center gap-1.5 rounded-md border border-dashed border-gray-300 bg-gray-50 px-2 py-1 text-[12px] italic text-gray-500 dark:border-line dark:bg-surface-muted dark:text-ink-subtle"
          title="Derived columns are computed by a rule expression — direct cell editing is not supported in this phase."
        >
          <Lock className="h-3 w-3 shrink-0" />
          Derived (rule editor coming soon)
        </div>
      );

    default: {
      // TypeScript exhaustiveness check — if a new source type is added
      // to the union, this assignment forces a compile error so we
      // remember to wire it up here.
      const _exhaustive: never = sourceType;
      void _exhaustive;
      return null;
    }
    }
  }
}

/**
 * Compact IF/LIMIT/FILL chip with a 4-option popover (Inherit + the
 * three roles). Sits in the cell's header bar — identical layout in
 * every editor so the eye can scan a column of cells and spot where
 * the role differs from the column's default.
 *
 * Visual encoding:
 *   * Background tone tracks the EFFECTIVE role (so an inherited cell
 *     paints the same color as its column default — the column is the
 *     source of the visual signal in that case).
 *   * A small dashed bottom border is added when the role is INHERITED
 *     (i.e. `cell.role` is null) — distinguishes "this cell is
 *     painted because the column says so" from "this cell pinned its
 *     own role". Solid when the operator picked a role explicitly.
 *
 * The popover lists all three roles + an "Inherit" reset option that
 * writes `null` back through `setRole`. Closes on outside click /
 * Escape (modeled on the catalog picker's dropdown).
 */
function RuleCellRoleChip({
  cellRole,
  columnDefaultRole,
  hasExplicitRole,
  onPick,
  disabled,
}: {
  cellRole: RuleRole | null;
  columnDefaultRole: RuleRole | null;
  hasExplicitRole: boolean;
  onPick: (next: RuleRole | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Tone reflects the EFFECTIVE role (so inherited cells visually echo
  // the column's color). When the column itself has no default and the
  // cell hasn't pinned one, fall back to a neutral grey so the chip
  // doesn't pretend a role exists.
  const tone = cellRole ? RULE_ROLE_TONE[cellRole] : null;
  const operatorLabel = cellRole
    ? RULE_ROLE_OPERATOR_LABEL[cellRole]
    : "ROLE";
  const titleText = cellRole
    ? hasExplicitRole
      ? `Per-cell role: ${RULE_ROLE_LABEL[cellRole]} (${operatorLabel}). Click to change.`
      : `Inheriting "${RULE_ROLE_LABEL[cellRole]}" from the column default. Click to override.`
    : "No role set on the column or this cell. Click to pin one.";

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={titleText}
        aria-label={titleText}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-0.5 rounded border px-1 py-px",
          "text-[9px] font-bold uppercase tracking-wide leading-none",
          "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
          tone
            ? tone.chip
            : "bg-gray-100 text-gray-500 border-gray-200 dark:bg-surface-muted dark:text-ink-muted dark:border-line",
          // Dashed bottom edge marks "inherited" — the visual carries
          // even when the chip color matches the column default.
          !hasExplicitRole && "border-dashed",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <span>{operatorLabel}</span>
        <ChevronDown className="h-2.5 w-2.5 shrink-0" />
      </button>
      {open && !disabled && (
        <div
          role="menu"
          className={cn(
            "absolute left-0 top-full z-30 mt-1 w-44 rounded-md border border-gray-200 bg-white shadow-lg dark:border-line dark:bg-surface-subtle",
            "py-1 text-[12px]",
          )}
        >
          {/* Inherit row — special: writes null. Disabled-styled when the
              cell is already inheriting (no-op pick). */}
          <RoleMenuItem
            label="Inherit from column"
            sublabel={
              columnDefaultRole
                ? `Column default: ${RULE_ROLE_LABEL[columnDefaultRole]}`
                : "No column default set"
            }
            active={!hasExplicitRole}
            onPick={() => {
              onPick(null);
              setOpen(false);
            }}
          />
          <div className="my-1 border-t border-gray-100 dark:border-line/60" />
          {(Object.keys(RULE_ROLE_OPERATOR_LABEL) as RuleRole[]).map(
            (role) => (
              <RoleMenuItem
                key={role}
                label={`${RULE_ROLE_OPERATOR_LABEL[role]} — ${RULE_ROLE_LABEL[role]}`}
                tone={RULE_ROLE_TONE[role]}
                active={hasExplicitRole && cellRole === role}
                onPick={() => {
                  onPick(role);
                  setOpen(false);
                }}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function RoleMenuItem({
  label,
  sublabel,
  tone,
  active,
  onPick,
}: {
  label: string;
  sublabel?: string;
  tone?: { chip: string; ring: string; dot: string };
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      className={cn(
        "w-full text-left px-2.5 py-1.5 flex items-start gap-2 hover:bg-gray-50",
        "focus-visible:outline-none focus-visible:bg-gray-50",
        active && "bg-brand-50/60",
      )}
    >
      <span
        className={cn(
          "mt-1 inline-block h-2 w-2 shrink-0 rounded-full",
          tone ? tone.dot : "bg-gray-300",
        )}
        aria-hidden
      />
      <span className="flex-1 min-w-0">
        <span
          className={cn(
            "block text-[12px] leading-tight",
            active
              ? "text-gray-900 font-semibold dark:text-ink"
              : "text-gray-700 dark:text-ink-muted",
          )}
        >
          {label}
        </span>
        {sublabel && (
          <span className="block text-[10.5px] text-gray-500 mt-0.5 dark:text-ink-subtle">
            {sublabel}
          </span>
        )}
      </span>
    </button>
  );
}
