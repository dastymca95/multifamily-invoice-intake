"use client";

import {
  ArrowDownFromLine,
  ArrowUpFromLine,
  Building2,
  ChevronDown,
  Copy,
  CornerDownRight,
  FileSpreadsheet,
  GripHorizontal,
  Hash,
  ListChecks,
  Lock,
  LockKeyhole,
  Pencil,
  Pin,
  Plus,
  Scale,
  Settings2,
  Sparkles,
  Square,
  StickyNote,
  Target,
  Trash2,
  Type,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/utils";
import {
  type ColumnSourceType,
  type InvoiceTemplateColumn,
  type InvoiceTemplateRule,
  type InvoiceTemplateRuleCell,
  MAX_COLUMN_NAME_LENGTH,
  MAX_RULES,
  MAX_RULE_NOTES_LENGTH,
  RULE_ROLE_LABEL,
  type RuleRole,
  SOURCE_TYPE_LABEL,
  columnAllowsRuleOverride,
  columnLockEditing,
  columnLockPosition,
  effectiveColumnDefaultRole,
  emptyRuleCell,
} from "@/types/invoice-template";

import type { CatalogIndex } from "../hooks/useCatalogIndex";

import { RuleCellEditor } from "./RuleCellEditor";

/**
 * Sortable shift math (Part 3 of UX polish).
 *
 * Local copy of `computeReorderShift` in `TemplateEditor.tsx` —
 * intentionally duplicated rather than shared to avoid a circular
 * import (TemplateEditor already imports RuleMatrixView). The function
 * is a tiny pure helper; the duplication cost is minimal versus the
 * complexity of a separate util file.
 *
 * Returns the px translate this row should apply during a drag so it
 * "slides out of the way" of the dragged item, matching modern
 * sortable-list semantics. See the doc comment on the original in
 * `TemplateEditor.tsx` for full math; the matrix mode consumes this
 * along the Y axis (vertical row reorder).
 */
function computeReorderShift(
  idx: number,
  draggedIdx: number | null,
  dropIdx: number | null,
  size: number,
): number {
  if (draggedIdx == null || dropIdx == null || size === 0) return 0;
  if (idx === draggedIdx) return 0;
  if (draggedIdx < dropIdx) {
    if (idx > draggedIdx && idx < dropIdx) return -size;
  } else if (draggedIdx > dropIdx) {
    if (idx >= dropIdx && idx < draggedIdx) return size;
  }
  return 0;
}

/**
 * Transposed rule-matrix view of the Import Builder.
 *
 * Same `columns` + `rules` state as the spreadsheet table — only the
 * orientation flips:
 *
 *   * Table mode    — columns ACROSS the top, rules DOWN as rows.
 *   * Matrix mode   — fields DOWN as rows, rules ACROSS as columns.
 *
 * The intent: when a template grows past ~8-10 columns the table mode
 * forces wide horizontal scrolling to compare two rules side-by-side.
 * The matrix view keeps each field on a stable row on the LEFT and
 * lays each rule out as its own vertical column to the RIGHT — so two
 * rules sit next to each other and the eye can scan field-by-field
 * vertically.
 *
 * This view is NOT "one card per rule" — the field list appears ONCE
 * on the left, and rules are the repeated dimension across the page.
 *
 * Layout primitives:
 *
 *   * CSS grid: `grid-template-columns: <field-col> repeat(N, <rule-col>)`
 *   * First column (field labels) is sticky-left so it stays visible
 *     while the operator scrolls horizontally to see distant rules.
 *   * First row (rule headers) is sticky-top so it stays visible while
 *     the operator scrolls vertically through many fields.
 *   * Top-left corner cell is sticky in BOTH axes (z-30 > z-20 > z-10).
 *
 * Cell anatomy:
 *
 *   ┌──────────────┬──────────┬──────────┬──────────┐
 *   │ Field \\ Rule│ Rule #1  │ Rule #2  │ Rule #3  │
 *   ├──────────────┼──────────┼──────────┼──────────┤
 *   │ * Vendor [V] │ [editor] │ [editor] │ [editor] │
 *   ├──────────────┼──────────┼──────────┼──────────┤
 *   │   Property…  │ [editor] │ [editor] │ [editor] │
 *   ├──────────────┼──────────┼──────────┼──────────┤
 *   │ ⓘ Notes      │ [text]   │ [text]   │ [text]   │
 *   └──────────────┴──────────┴──────────┴──────────┘
 *
 * The inspector continues to operate on column ids — the field-label
 * cell carries the same gear/inspector affordance that lives on the
 * column header in table mode. The selected column highlights its
 * full row (and its label cell) across every rule, so the operator
 * can see "this is the field I'm configuring" at a glance.
 *
 * Rule controls (active toggle, duplicate, delete) live in each rule's
 * column header. Field-level concerns (name, role, source binding,
 * inspector) live in each field's row header. Both axes carry the same
 * visual language as the horizontal table headers — an operator
 * flipping modes recognises every chip and tone.
 *
 * Same data, both ways: an operator can flip between table and matrix
 * mid-edit without losing in-progress work — it's purely a render
 * orientation flip over the shared `columns` + `rules` state.
 */

interface RuleMatrixViewProps {
  columns: InvoiceTemplateColumn[];
  rules: InvoiceTemplateRule[];
  catalogIndex: CatalogIndex;
  /** Highlighted column (id) — the currently-inspected field. */
  selectedColumnId: string | null;
  // ---- Drag-and-drop reorder (shared with table mode) ---------------------
  // Both views share one `draggedIdx` / `dropIdx` pair on the parent so
  // the underlying column ordering has a single source of truth. Matrix
  // mode reads them to render the row's drag-fade and top-/bottom-edge
  // drop indicators; the geometry is vertical here (top-half / bottom-
  // half of the field-label cell) but the index semantics are identical
  // (`dropIdx === N` means "drop before row N"; `dropIdx === columns.length`
  // means "drop after the last row").
  draggedIdx: number | null;
  dropIdx: number | null;
  /**
   * Height (px) of the dragged field-label cell, sampled by the parent
   * on drag start. Drives the per-row `translateY` shift that animates
   * non-dragged rows out of the way of the in-flight drag (Part 3 of
   * UX polish). 0 when no drag is in flight.
   *
   * Lives in the parent so the SAME drag handler can serve both views
   * (table mode consumes width; matrix mode consumes height); see
   * `dragSize` in `TemplateEditor.tsx`.
   */
  dragRowHeight: number;
  /**
   * Auto-enter rename signal — id of a column whose label cell should
   * flip straight into rename mode on next mount. Set by the parent
   * after "+ add column" / explicit rename actions; the consuming cell
   * calls `onConsumedRename` after observing it so the signal clears.
   */
  pendingFocusId: string | null;
  onConsumedRename: () => void;
  /** Persist a rename. Mirrors `onChangeName` on the table HeaderCell. */
  onChangeColumnName: (columnId: string, value: string) => void;
  /**
   * Single-click on a field label — selects the column and opens the
   * inspector. Never deselects (gear toggles for that). Distinct from
   * `onOpenColumnInspector` so click-to-select stays unambiguous.
   */
  onSelectColumn: (columnId: string) => void;
  /**
   * Drag start on a field-label cell. Same callback the table mode uses
   * for headers — the parent doesn't care which orientation initiated
   * the drag. Index is the field's position in `columns`.
   */
  onFieldDragStart: (e: DragEvent<HTMLElement>, index: number) => void;
  /**
   * Drag-over on a field-label cell. Vertical geometry (top/bottom half)
   * is decided by the parent's `onFieldRowDragOver` so the splice math
   * stays identical to table mode.
   */
  onFieldDragOver: (e: DragEvent<HTMLDivElement>, index: number) => void;
  /** Commit the drop (apply the splice). Same reducer as table mode. */
  onFieldDrop: () => void;
  /** Drag-end (cancel-or-finish cleanup). Same reducer as table mode. */
  onFieldDragEnd: () => void;
  // ---- Rule controls -------------------------------------------------------
  onAddRule: () => void;
  onToggleActive: (ruleId: string) => void;
  onDuplicate: (ruleId: string) => void;
  onRemove: (ruleId: string) => void;
  onSetCell: (
    ruleId: string,
    columnId: string,
    cell: InvoiceTemplateRuleCell,
  ) => void;
  onSetNotes: (ruleId: string, notes: string) => void;
  /**
   * Open the right-rail inspector for a column. Same affordance as the
   * gear on a column header in horizontal mode — toggles open/close on
   * each click, distinct from `onSelectColumn` (which never closes).
   */
  onOpenColumnInspector: (columnId: string) => void;
  // ---- Inline "+" affordances (Part 6) -------------------------------------
  /**
   * Append a new field at the bottom of the schema. Mirrors the table
   * mode's trailing "+" header — same reducer the parent uses there
   * (`insertColumnAt(columns.length)`), exposed as a callback so this
   * view can paint the affordance inline without owning the splice.
   */
  onAddColumn: () => void;
  /** True when the column count has hit the persisted cap. */
  atColumnCap: boolean;
  // ---- Field-row menu (Part 9) ---------------------------------------------
  /**
   * Insert a new column at a specific position. Used by the per-field
   * popover menu's "Insert above / Insert below" entries to give matrix
   * mode parity with the table-mode HeaderMenu.
   */
  onInsertColumnAt: (index: number) => void;
  /**
   * Remove the column. Disabled in the menu when the schema is at
   * MIN_COLUMNS (parent reducer also guards, so this is a UX-only check).
   */
  onRemoveColumn: (columnId: string) => void;
  /**
   * Toggle `lock_position` on a column. Wired to the same reducer the
   * inspector's "E. Locks" section uses so the two surfaces stay in sync.
   */
  onToggleColumnLockPosition: (columnId: string) => void;
  /** Toggle `lock_editing` on a column. Same reducer as the inspector. */
  onToggleColumnLockEditing: (columnId: string) => void;
  /** True when the column count is at MIN_COLUMNS — disables Delete. */
  canRemoveColumn: boolean;
}

export function RuleMatrixView({
  columns,
  rules,
  catalogIndex,
  selectedColumnId,
  draggedIdx,
  dropIdx,
  dragRowHeight,
  pendingFocusId,
  onConsumedRename,
  onChangeColumnName,
  onSelectColumn,
  onFieldDragStart,
  onFieldDragOver,
  onFieldDrop,
  onFieldDragEnd,
  onAddRule,
  onToggleActive,
  onDuplicate,
  onRemove,
  onSetCell,
  onSetNotes,
  onOpenColumnInspector,
  onAddColumn,
  atColumnCap,
  onInsertColumnAt,
  onRemoveColumn,
  onToggleColumnLockPosition,
  onToggleColumnLockEditing,
  canRemoveColumn,
}: RuleMatrixViewProps) {
  // Defensive empty-state. The matrix needs at least one column to
  // have something on its sticky-left axis — otherwise there's nothing
  // for the rule columns to intersect with.
  if (columns.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-8 text-[12.5px] text-gray-500 italic dark:text-ink-subtle">
        Add a column from the table view first — the matrix view needs
        at least one field to render.
      </div>
    );
  }

  const ruleCount = rules.length;
  const atRuleCap = ruleCount >= MAX_RULES;

  // Column track template. Field column is wider (label + chips + gear
  // + chevron); rule columns share equal width so multi-rule scanning
  // has visual rhythm. The trailing `addRuleTrack` is the "+ rule"
  // track (Part 6) — narrow, only holds the inline "+" cell.
  //
  // CRITICAL invariant for the body rows below: every body row MUST
  // emit exactly `1 + ruleCount + 1` cells (field-label + N rule cells
  // + trailing placeholder). If a row emits fewer items than the grid
  // has tracks, CSS Grid auto-flow bleeds the NEXT row's first cell
  // into the empty trailing track, scrambling the visual alignment.
  // The `TrailingPlaceholder` below is the load-bearing piece of that
  // invariant — do not remove it without also using explicit grid
  // placement on every cell.
  const FIELD_COL = "280px";
  const RULE_COL = "minmax(280px, 340px)";
  const ADD_RULE_COL = "64px";
  const gridTemplateColumns =
    ruleCount === 0
      ? `${FIELD_COL} minmax(280px, 1fr) ${ADD_RULE_COL}`
      : `${FIELD_COL} repeat(${ruleCount}, ${RULE_COL}) ${ADD_RULE_COL}`;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-gray-50 dark:bg-surface">
      {/* Compact toolbar above the matrix — counts + add. The template
          editor's main toolbar already has an Add Rule button; this is
          a deliberate convenience so the operator doesn't need to
          scroll back up after rolling deep into the field list. */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-white border-b border-gray-200 dark:bg-surface-subtle dark:border-line">
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          {columns.length} field{columns.length === 1 ? "" : "s"} ·{" "}
          {ruleCount} rule{ruleCount === 1 ? "" : "s"}{" "}
          <span className="text-gray-400 dark:text-ink-subtle">
            (max {MAX_RULES})
          </span>
        </span>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={onAddRule}
          disabled={atRuleCap}
          title={
            atRuleCap
              ? `Rule cap reached (${MAX_RULES})`
              : "Append a new rule column"
          }
        >
          <Plus className="h-3.5 w-3.5" />
          Add rule
        </Button>
      </div>

      {/* Scroll surface. Owns BOTH axes of scroll so sticky positioning
          on header / left-column cells works as expected. */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div
          role="grid"
          aria-label="Rule matrix — fields as rows, rules as columns"
          className="inline-grid bg-white dark:bg-surface"
          style={{ gridTemplateColumns }}
        >
          {/* === Header row (sticky-top) =============================== */}
          <CornerCell />
          {ruleCount === 0 ? (
            <div
              role="columnheader"
              className="sticky top-0 z-20 bg-gray-50 border-b border-gray-200 px-3 py-2 text-[11px] text-gray-400 italic dark:bg-surface-muted dark:border-line dark:text-ink-subtle"
            >
              No rules yet — use “Add rule” to create the first column.
            </div>
          ) : (
            rules.map((rule, idx) => (
              <RuleHeaderCell
                key={rule.id}
                rule={rule}
                ruleIndex={idx}
                onToggleActive={() => onToggleActive(rule.id)}
                onDuplicate={() => onDuplicate(rule.id)}
                onRemove={() => onRemove(rule.id)}
              />
            ))
          )}
          {/* Inline "+ rule" header cell (Part 6).
              Sits in the trailing rule track at the rightmost edge of
              the header row so the operator can extend the rules
              without scrolling back to the toolbar. Body rows fill the
              same trailing track with a `TrailingPlaceholder` so the
              grid auto-flow stays aligned (see invariant comment on
              `gridTemplateColumns` above). */}
          <AddRuleColumnHeaderCell
            disabled={atRuleCap}
            atCap={atRuleCap}
            cap={MAX_RULES}
            onClick={onAddRule}
          />

          {/* === Field rows ========================================== */}
          {columns.map((column, idx) => (
            <FieldRow
              key={column.id}
              column={column}
              index={idx}
              total={columns.length}
              rules={rules}
              catalogIndex={catalogIndex}
              isSelected={selectedColumnId === column.id}
              isDragged={draggedIdx === idx}
              // Sortable shift in px (Part 3 of UX polish). Resolved
              // here so the row can apply the same translateY to every
              // cell it owns (label + N rule cells + trailing
              // placeholder), keeping the row visually unified during
              // a reorder. 0 when no shift is needed.
              rowShift={computeReorderShift(
                idx,
                draggedIdx,
                dropIdx,
                dragRowHeight,
              )}
              // Drop indicator on the TOP edge of this row when the
              // resolved drop target is "before this row" AND the drag
              // isn't a no-op (back to source). Mirrors the table
              // header's `isDropBefore` calc but in vertical geometry.
              isDropBefore={
                dropIdx === idx &&
                draggedIdx !== null &&
                draggedIdx !== idx &&
                !(idx === draggedIdx + 1)
              }
              // Drop indicator on the BOTTOM edge of the LAST row when
              // the drop target is "after the last row". Same idea as
              // the table mode's trailing-cell indicator.
              isDropAfterLast={
                idx === columns.length - 1 &&
                dropIdx === columns.length &&
                draggedIdx !== null &&
                draggedIdx !== columns.length - 1
              }
              autoEnterRename={pendingFocusId === column.id}
              onConsumedRename={onConsumedRename}
              onChangeName={(value) => onChangeColumnName(column.id, value)}
              onSelect={() => onSelectColumn(column.id)}
              onOpenInspector={() => onOpenColumnInspector(column.id)}
              onFieldDragStart={(e) => onFieldDragStart(e, idx)}
              onFieldDragOver={(e) => onFieldDragOver(e, idx)}
              onFieldDrop={onFieldDrop}
              onFieldDragEnd={onFieldDragEnd}
              onSetCell={(ruleId, cell) =>
                onSetCell(ruleId, column.id, cell)
              }
              // Per-field menu wiring (Part 9). Same reducers the table-
              // mode HeaderMenu invokes so the two views stay in sync.
              onInsertAbove={() => onInsertColumnAt(idx)}
              onInsertBelow={() => onInsertColumnAt(idx + 1)}
              onRemove={() => onRemoveColumn(column.id)}
              onToggleLockPosition={() =>
                onToggleColumnLockPosition(column.id)
              }
              onToggleLockEditing={() =>
                onToggleColumnLockEditing(column.id)
              }
              canInsert={!atColumnCap}
              canRemove={canRemoveColumn}
            />
          ))}

          {/* Inline "+ field" row (Part 6).
              Spans the full grid width so the operator can append a
              new schema field directly under the field list — same
              spirit as table mode's bottom-of-tbody add row. The
              callback is the parent's `insertColumnAt(columns.length)`
              so the splice math stays in one place. */}
          <AddFieldInlineRow
            disabled={atColumnCap}
            atCap={atColumnCap}
            onClick={onAddColumn}
          />

          {/* === Notes footer row (one per rule) ===================== */}
          {ruleCount > 0 && (
            <NotesRow rules={rules} onSetNotes={onSetNotes} />
          )}
        </div>

        {/* Empty-state placard — sits below the (otherwise field-only)
            grid so the field column still shows the schema. */}
        {ruleCount === 0 && (
          <div className="p-6">
            <EmptyRulesPanel onAddRule={onAddRule} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header / corner cells
// ---------------------------------------------------------------------------

function CornerCell() {
  // The top-left intersection is sticky in BOTH axes. Highest z-index
  // because it must paint above both the header row (z-20) and the
  // field column (z-10) when the operator scrolls into the body.
  return (
    <div
      role="rowheader"
      className="sticky left-0 top-0 z-30 bg-gray-100 border-b border-r border-gray-200 px-3 py-2 text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold flex items-center dark:bg-surface-muted dark:border-line dark:text-ink-subtle"
    >
      Field <span className="mx-1 text-gray-300 dark:text-line-strong">/</span>{" "}
      Rule
    </div>
  );
}

/**
 * Inline "+ rule" header cell — Part 6.
 *
 * Lives in the trailing rule track at the right edge of the header row
 * (which only this cell occupies — field rows leave the track empty).
 * Mirrors the visual language of the table mode's `AddColumnHeaderCell`
 * so the two add-affordances feel like siblings across orientations:
 * dashed border, brand-tinted hover, disabled when at cap.
 *
 * Sticky-top so the affordance stays visible when the user scrolls
 * deep into a long field list — same scroll discipline as
 * `RuleHeaderCell`.
 */
function AddRuleColumnHeaderCell({
  disabled,
  atCap,
  cap,
  onClick,
}: {
  disabled: boolean;
  atCap: boolean;
  cap: number;
  onClick: () => void;
}) {
  return (
    <div
      role="columnheader"
      className="sticky top-0 z-20 bg-gray-50 border-b border-gray-200 px-1 py-1.5 flex items-center justify-center dark:bg-surface-muted dark:border-line"
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={atCap ? `Rule cap reached (${cap}).` : "Append a new rule"}
        aria-label={atCap ? `Rule cap reached (${cap})` : "Add rule"}
        className={cn(
          "w-full inline-flex items-center justify-center rounded-md py-1.5 text-gray-500",
          "dark:text-ink-muted",
          "border border-dashed border-gray-300 hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700",
          "dark:border-line dark:hover:bg-brand-900/30 dark:hover:text-brand-50",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
          "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-gray-300 disabled:hover:bg-transparent disabled:hover:text-gray-500",
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Empty trailing-track filler for body rows.
 *
 * The grid has an `addRuleTrack` as its rightmost column (the "+ rule"
 * header lives there). Body rows (field rows + the notes row) MUST emit
 * a placeholder into that trailing track so each body row's item count
 * matches the grid's column count. Without this, CSS Grid auto-flow
 * bleeds the next row's first cell into the empty trailing slot of the
 * previous row, cascading misalignment down the entire matrix.
 *
 * The placeholder is a no-op visually (transparent / matches row tint)
 * — it exists purely to keep auto-flow honest. Marked aria-hidden so
 * screen readers don't see it as a meaningful gridcell.
 */
function TrailingPlaceholder({
  isDragged,
  isSelected,
  transformStyle,
}: {
  isDragged?: boolean;
  isSelected?: boolean;
  /**
   * Sortable shift inline style (Part 3 of UX polish). Threaded down
   * from `FieldRow` so the trailing slot moves in lockstep with the
   * label + body cells of its row during a reorder. `undefined` when
   * the row isn't shifted, so React doesn't emit an empty `style`
   * attribute in the no-drag steady state.
   */
  transformStyle?: { transform: string };
}) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      style={transformStyle}
      className={cn(
        "border-b border-gray-200 transition-[colors,opacity,transform] duration-150 dark:border-line/60",
        // Match the row tint so the trailing column reads as part of
        // the same row band rather than a separate empty column. The
        // selected tint uses the same body-cell shade (`bg-brand-50`)
        // so the row paints as one continuous filled band — see the
        // FieldLabelCell + RuleCellWrap selected state for the rest of
        // the band.
        isSelected
          ? "bg-brand-50 dark:bg-brand-900/30"
          : "bg-white dark:bg-surface",
        isDragged && "opacity-40",
      )}
    />
  );
}

/**
 * Inline "+ field" row — Part 6.
 *
 * Spans the entire grid width via `gridColumn: "1 / -1"` and sits at
 * the bottom of the field rows (just above the per-rule notes footer).
 * Mirrors the table mode's `AddRuleInlineRow` shape — same dashed
 * border, same disabled copy semantics — so operators flipping between
 * the two layouts get a consistent "add at the bottom" affordance even
 * though the axes are swapped.
 */
function AddFieldInlineRow({
  disabled,
  atCap,
  onClick,
}: {
  disabled: boolean;
  atCap: boolean;
  onClick: () => void;
}) {
  return (
    <div
      role="row"
      style={{ gridColumn: "1 / -1" }}
      className={cn(
        "border-t border-dashed border-gray-300 bg-gray-50/40 dark:border-line dark:bg-surface-muted/40",
        "px-3 py-1.5",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={atCap ? "Field cap reached" : "Add field"}
        title={
          atCap
            ? "Field cap reached."
            : "Append a new field at the bottom of the schema"
        }
        className={cn(
          "w-full inline-flex items-center justify-center gap-1.5 rounded-md py-1 text-[12px] font-medium",
          "text-gray-500 border border-dashed border-gray-300",
          "dark:text-ink-muted dark:border-line",
          "hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700",
          "dark:hover:bg-brand-900/30 dark:hover:text-brand-50",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
          "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-gray-300 disabled:hover:bg-transparent disabled:hover:text-gray-500",
        )}
      >
        <Plus className="h-3.5 w-3.5" />
        {atCap ? "Field cap reached" : "Add field"}
      </button>
    </div>
  );
}

function RuleHeaderCell({
  rule,
  ruleIndex,
  onToggleActive,
  onDuplicate,
  onRemove,
}: {
  rule: InvoiceTemplateRule;
  ruleIndex: number;
  onToggleActive: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const inactive = !rule.is_active;
  return (
    <div
      role="columnheader"
      aria-label={`Rule ${ruleIndex + 1}`}
      className={cn(
        "sticky top-0 z-20 border-b border-r border-gray-200 px-3 py-2 transition-colors dark:border-line",
        inactive
          ? "bg-gray-100 dark:bg-surface-muted/60"
          : "bg-gray-50 dark:bg-surface-muted",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-mono text-gray-400 shrink-0 dark:text-ink-subtle">
          #{ruleIndex + 1}
        </span>
        <Switch
          checked={rule.is_active}
          onChange={onToggleActive}
          size="sm"
          aria-label={
            rule.is_active
              ? `Deactivate rule ${ruleIndex + 1}`
              : `Activate rule ${ruleIndex + 1}`
          }
        />
        <span
          className={cn(
            "text-[10.5px]",
            rule.is_active
              ? "text-gray-700 dark:text-ink"
              : "text-gray-400 italic dark:text-ink-subtle",
          )}
        >
          {rule.is_active ? "Active" : "Inactive"}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onDuplicate}
          title={`Duplicate rule ${ruleIndex + 1}`}
          aria-label={`Duplicate rule ${ruleIndex + 1}`}
          className="p-0.5 rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:text-ink-subtle dark:hover:bg-surface-subtle dark:hover:text-ink"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          title={`Delete rule ${ruleIndex + 1}`}
          aria-label={`Delete rule ${ruleIndex + 1}`}
          className="p-0.5 rounded text-gray-400 hover:bg-red-50 hover:text-red-600 dark:text-ink-subtle dark:hover:bg-red-950/40 dark:hover:text-red-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field row — one per template column. Renders the sticky-left label
// cell followed by N body cells (one per rule).
// ---------------------------------------------------------------------------

function FieldRow({
  column,
  index,
  total,
  rules,
  catalogIndex,
  isSelected,
  isDragged,
  rowShift,
  isDropBefore,
  isDropAfterLast,
  autoEnterRename,
  onConsumedRename,
  onChangeName,
  onSelect,
  onOpenInspector,
  onFieldDragStart,
  onFieldDragOver,
  onFieldDrop,
  onFieldDragEnd,
  onSetCell,
  onInsertAbove,
  onInsertBelow,
  onRemove,
  onToggleLockPosition,
  onToggleLockEditing,
  canInsert,
  canRemove,
}: {
  column: InvoiceTemplateColumn;
  index: number;
  total: number;
  rules: InvoiceTemplateRule[];
  catalogIndex: CatalogIndex;
  isSelected: boolean;
  isDragged: boolean;
  /**
   * Sortable shift in px (Part 3 of UX polish). Threaded down to
   * every cell this row owns so the entire row slides as one unit
   * during a reorder. See the doc comment on `computeReorderShift` at
   * the top of this file.
   */
  rowShift: number;
  isDropBefore: boolean;
  isDropAfterLast: boolean;
  autoEnterRename: boolean;
  onConsumedRename: () => void;
  onChangeName: (value: string) => void;
  onSelect: () => void;
  onOpenInspector: () => void;
  onFieldDragStart: (e: DragEvent<HTMLElement>) => void;
  onFieldDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onFieldDrop: () => void;
  onFieldDragEnd: () => void;
  onSetCell: (ruleId: string, cell: InvoiceTemplateRuleCell) => void;
  onInsertAbove: () => void;
  onInsertBelow: () => void;
  onRemove: () => void;
  onToggleLockPosition: () => void;
  onToggleLockEditing: () => void;
  canInsert: boolean;
  canRemove: boolean;
}) {
  // Pre-compute the inline transform once so each child cell shares
  // the same object reference (and so the conditional evaluates
  // exactly once per row). When shift is 0 we pass `undefined` so React
  // doesn't emit a `style="transform: translateY(0px)"` attribute,
  // keeping the DOM clean during the no-drag steady state.
  const transformStyle =
    rowShift !== 0
      ? { transform: `translateY(${rowShift}px)` }
      : undefined;
  return (
    <>
      <FieldLabelCell
        column={column}
        index={index}
        total={total}
        isSelected={isSelected}
        isDragged={isDragged}
        transformStyle={transformStyle}
        isDropBefore={isDropBefore}
        isDropAfterLast={isDropAfterLast}
        autoEnterRename={autoEnterRename}
        onConsumedRename={onConsumedRename}
        onChangeName={onChangeName}
        onSelect={onSelect}
        onOpenInspector={onOpenInspector}
        onFieldDragStart={onFieldDragStart}
        onFieldDragOver={onFieldDragOver}
        onFieldDrop={onFieldDrop}
        onFieldDragEnd={onFieldDragEnd}
        onInsertAbove={onInsertAbove}
        onInsertBelow={onInsertBelow}
        onRemove={onRemove}
        onToggleLockPosition={onToggleLockPosition}
        onToggleLockEditing={onToggleLockEditing}
        canInsert={canInsert}
        canRemove={canRemove}
      />
      {rules.length === 0 ? (
        // Placeholder cell for the empty-state column — keeps the grid
        // visually balanced while the real rule columns are absent.
        <div
          role="gridcell"
          style={transformStyle}
          className={cn(
            "border-b border-gray-200 px-3 py-2 text-[11px] text-gray-300 italic dark:border-line/60 dark:text-ink-subtle",
            "transition-[opacity,transform] duration-150",
            // Mirror the row's drag-fade so the empty-state placeholder
            // visually travels with its label cell during a reorder.
            isDragged && "opacity-40",
          )}
        >
          —
        </div>
      ) : (
        rules.map((rule) => (
          <RuleCellWrap
            key={rule.id}
            column={column}
            cell={rule.cells[column.id] ?? emptyRuleCell()}
            isSelected={isSelected}
            isDragged={isDragged}
            transformStyle={transformStyle}
            disabled={!rule.is_active}
            catalogIndex={catalogIndex}
            onChange={(next) => onSetCell(rule.id, next)}
          />
        ))
      )}
      {/* Trailing placeholder for the addRuleTrack — fills the rightmost
          grid column on this field row so CSS Grid auto-flow doesn't
          spill the next row's first cell into the empty slot. See the
          `gridTemplateColumns` invariant comment in `RuleMatrixView`. */}
      <TrailingPlaceholder
        isDragged={isDragged}
        isSelected={isSelected}
        transformStyle={transformStyle}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Per-field popover menu (Part 9). Mirror of the table-mode HeaderMenu
// in TemplateEditor.tsx with the same set of actions:
//   * Rename
//   * Column settings (toggles inspector)
//   * Lock position / Lock editing (Pin / LockKeyhole icons; same labels
//     as the inspector's "E. Locks" section)
//   * Insert above / Insert below
//   * Delete column
// Lives at the right edge of `FieldLabelCell` next to the gear button.
// ---------------------------------------------------------------------------

function FieldMenu({
  canInsert,
  canRemove,
  lockPosition,
  lockEditing,
  onRename,
  onOpenSettings,
  onInsertAbove,
  onInsertBelow,
  onRemove,
  onToggleLockPosition,
  onToggleLockEditing,
}: {
  canInsert: boolean;
  canRemove: boolean;
  lockPosition: boolean;
  lockEditing: boolean;
  onRename: () => void;
  onOpenSettings: () => void;
  onInsertAbove: () => void;
  onInsertBelow: () => void;
  onRemove: () => void;
  onToggleLockPosition: () => void;
  onToggleLockEditing: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Trigger ref drives the portal anchor — `getBoundingClientRect()` is
  // sampled on open (and on scroll/resize) so the menu can be positioned
  // anywhere on the page without being clipped by the matrix grid's
  // overflow-hidden / sticky cells / z-index layering. See the comment
  // on `menuPos` below for the position math.
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The portal is mounted to document.body, so it lives in its OWN
  // stacking context (above every grid cell, header, badge, editor).
  // The popover ref is needed for outside-click detection — clicks
  // inside the menu must not close it even though the menu DOM lives
  // outside the FieldLabelCell that owns the trigger.
  const menuRef = useRef<HTMLDivElement>(null);
  // Viewport-relative position of the menu's top edge + right edge.
  // We anchor the menu's RIGHT side to the trigger's right edge so the
  // popover unfurls down-and-to-the-left of the chevron, matching the
  // pre-portal `right-0 top-full mt-0.5` placement.
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null,
  );

  // Compute the portal anchor from the trigger button's bounding rect.
  // Stored as { top, right } where `right` is the offset from the
  // viewport's right edge — so a `position: fixed` div with that
  // `right` value will sit flush with the trigger's right edge.
  const recomputePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos({
      // 4px gap (≈ Tailwind mt-0.5) between the chevron and the menu.
      top: r.bottom + 4,
      right: window.innerWidth - r.right,
    });
  }, []);

  // Re-sample the position synchronously on open so the first paint of
  // the menu is already at the right place (no flicker from a 0,0
  // placement on the first frame).
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    recomputePos();
  }, [open, recomputePos]);

  useEffect(() => {
    if (!open) return;
    // Outside-click guard. The menu DOM lives in document.body via
    // portal, so we have to check BOTH the trigger ref (so clicking
    // the chevron toggles closed via the button's own onClick) AND the
    // menu ref (so clicking inside the menu doesn't close it). Without
    // the menu ref check, every click on a menu item would close the
    // menu before its onClick fires.
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Scroll/resize close — re-positioning would also work but adds
    // complexity (need to track every scroll ancestor of the trigger).
    // Closing on scroll matches native <select> behavior and is the
    // least surprising option.
    const scrollHandler = () => setOpen(false);
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    window.addEventListener("scroll", scrollHandler, true);
    window.addEventListener("resize", scrollHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
      window.removeEventListener("scroll", scrollHandler, true);
      window.removeEventListener("resize", scrollHandler);
    };
  }, [open]);

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.stopPropagation()}
        title="Field menu"
        aria-label="Open field menu"
        aria-expanded={open}
        className={cn(
          "p-0.5 rounded text-gray-400 transition-opacity dark:text-ink-subtle",
          "hover:text-gray-700 hover:bg-gray-100 dark:hover:text-ink dark:hover:bg-surface-muted",
          open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
        )}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {/* Portal mount — escapes the grid's overflow + sticky-cell
          stacking context so the popover always paints above everything
          else (rows, header bar, badges, cell editors). z-index inside
          the portal is irrelevant for clipping; we keep z-50 only so
          two simultaneously-open portals (rare; outside-click closes
          the others) layer in last-opened order. */}
      {open && menuPos && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{
              position: "fixed",
              top: menuPos.top,
              right: menuPos.right,
              zIndex: 50,
            }}
            className="min-w-[11rem] rounded-md border border-gray-200 bg-white shadow-lg py-1 dark:border-line dark:bg-surface-subtle"
          >
            <FieldMenuItem
              icon={Pencil}
              onClick={() => {
                setOpen(false);
                onRename();
              }}
            >
              Rename
            </FieldMenuItem>
            <FieldMenuItem
              icon={Settings2}
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              Column settings
            </FieldMenuItem>
            <div className="border-t border-gray-100 my-1 dark:border-line/60" />
            {/* Lock toggles — mirror of the table-mode HeaderMenu so the
                two surfaces stay coherent. Same icons (Pin / LockKeyhole)
                the inspector's "E. Locks" section uses. */}
            <FieldMenuItem
              icon={Pin}
              onClick={() => {
                setOpen(false);
                onToggleLockPosition();
              }}
            >
              {lockPosition ? "Unlock position" : "Lock position"}
            </FieldMenuItem>
            <FieldMenuItem
              icon={LockKeyhole}
              onClick={() => {
                setOpen(false);
                onToggleLockEditing();
              }}
            >
              {lockEditing ? "Unlock editing" : "Lock editing"}
            </FieldMenuItem>
            <div className="border-t border-gray-100 my-1 dark:border-line/60" />
            {/* Insert above/below — vertical analog of the table-mode
                left/right insert. Splice math lives in the parent reducer. */}
            <FieldMenuItem
              icon={ArrowUpFromLine}
              disabled={!canInsert}
              onClick={() => {
                setOpen(false);
                onInsertAbove();
              }}
            >
              Insert field above
            </FieldMenuItem>
            <FieldMenuItem
              icon={ArrowDownFromLine}
              disabled={!canInsert}
              onClick={() => {
                setOpen(false);
                onInsertBelow();
              }}
            >
              Insert field below
            </FieldMenuItem>
            <div className="border-t border-gray-100 my-1 dark:border-line/60" />
            <FieldMenuItem
              icon={Trash2}
              danger
              disabled={!canRemove}
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
            >
              Delete field
            </FieldMenuItem>
          </div>,
          document.body,
        )}
    </div>
  );
}

function FieldMenuItem({
  icon: Icon,
  children,
  onClick,
  disabled,
  danger,
}: {
  icon: LucideIcon;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      disabled={disabled}
      className={cn(
        "w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-left transition-colors",
        disabled
          ? "text-gray-300 cursor-not-allowed dark:text-ink-subtle"
          : danger
            ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
            : "text-gray-700 hover:bg-gray-100 dark:text-ink dark:hover:bg-surface-muted",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 truncate">{children}</span>
    </button>
  );
}

function FieldLabelCell({
  column,
  index,
  total,
  isSelected,
  isDragged,
  transformStyle,
  isDropBefore,
  isDropAfterLast,
  autoEnterRename,
  onConsumedRename,
  onChangeName,
  onSelect,
  onOpenInspector,
  onFieldDragStart,
  onFieldDragOver,
  onFieldDrop,
  onFieldDragEnd,
  onInsertAbove,
  onInsertBelow,
  onRemove,
  onToggleLockPosition,
  onToggleLockEditing,
  canInsert,
  canRemove,
}: {
  column: InvoiceTemplateColumn;
  index: number;
  total: number;
  isSelected: boolean;
  isDragged: boolean;
  /**
   * Sortable shift inline style (Part 3 of UX polish). Threaded down
   * from `FieldRow` so the label cell + every cell in this row's
   * grid track move in lockstep during a vertical reorder.
   */
  transformStyle?: { transform: string };
  isDropBefore: boolean;
  isDropAfterLast: boolean;
  autoEnterRename: boolean;
  onConsumedRename: () => void;
  onChangeName: (value: string) => void;
  onSelect: () => void;
  onOpenInspector: () => void;
  onFieldDragStart: (e: DragEvent<HTMLElement>) => void;
  onFieldDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onFieldDrop: () => void;
  onFieldDragEnd: () => void;
  onInsertAbove: () => void;
  onInsertBelow: () => void;
  onRemove: () => void;
  onToggleLockPosition: () => void;
  onToggleLockEditing: () => void;
  canInsert: boolean;
  canRemove: boolean;
}) {
  const sourceType = column.source_type ?? "empty";
  // Resolve via the helper so the legacy `rule_role` AND the canonical
  // `default_rule_role` are reconciled in one place. Null is a real
  // authored "no default role" state, so the field header is neutral.
  const role = effectiveColumnDefaultRole(column);
  const required = column.required ?? false;
  const empty = column.name.trim().length === 0;
  const SourceIcon = SOURCE_ICONS[sourceType];
  const RoleIcon = role ? ROLE_ICONS[role] : Square;
  // Lock indicators — three distinct concepts (Part 7). Each gets its
  // own visual affordance with a distinct icon so the operator can scan
  // the field-label cell and read each lock at a glance:
  //   * Pin (gray)    — `lock_position`: row can't be drag-reordered.
  //   * LockKeyhole   — `lock_editing`:  schema (name/source/type/
  //     (slate)         format/validation) is frozen; rule cells across
  //                     this row remain editable.
  //   * Lock (amber)  — `allow_rule_override = false`: FILL/action writes
  //                     cannot override the global behavior.
  const ruleOverrideLocked = !columnAllowsRuleOverride(column);
  const lockPosition = columnLockPosition(column);
  const lockEditing = columnLockEditing(column);

  // ---- Rename mode (locally owned) ----------------------------------------
  // Mirror of HeaderCell — single click on the label SELECTS the column;
  // double click (or F2 / parent-triggered auto-enter) flips the label
  // into an editable input. Same intent as horizontal mode: text editing
  // should feel intentional, not triggered by a stray click.
  const [renaming, setRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-enter rename mode when the parent flags it (e.g. after add-
  // column from horizontal mode while matrix mode happens to be active).
  // Clear the parent's signal immediately after consuming so subsequent
  // renders don't re-trigger the flip.
  useEffect(() => {
    if (!autoEnterRename) return;
    setRenaming(true);
    onConsumedRename();
  }, [autoEnterRename, onConsumedRename]);

  // Focus + select-all + scroll-into-view whenever rename mode opens.
  // The input only exists during rename mode, so the focus contract
  // lives entirely with the cell that owns it.
  useEffect(() => {
    if (!renaming) return;
    const el = renameInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
    el.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [renaming]);

  // Drag-start guard — same `data-no-drag` ancestor pattern as the
  // table HeaderCell. The whole label cell is the drag SOURCE so the
  // operator can grab anywhere (label, chips, blank padding); only
  // explicitly-tagged children (gear, the rename input) suppress drag.
  const handleFieldDragStart = (e: DragEvent<HTMLDivElement>) => {
    if (renaming) {
      // Defensive: `draggable={!renaming}` should already prevent this,
      // but we double-cancel in case of a mid-state-flip mousedown.
      e.preventDefault();
      return;
    }
    if (lockPosition) {
      // `lock_position` rows are pinned — they can't be picked up.
      // Mirrors the table-mode HeaderCell guard so both orientations
      // honor the same lock semantics.
      e.preventDefault();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest("[data-no-drag]")) {
      e.preventDefault();
      return;
    }
    onFieldDragStart(e);
  };

  return (
    <div
      role="rowheader"
      // Whole-cell drag — operator can grab anywhere on the label cell
      // to start a row reorder. The grip icon stays as a visual hint
      // (and hover-affordance), not a hit target.
      // Position-locked rows are non-draggable — `draggable={false}`
      // prevents the browser from initiating any drag at all.
      draggable={!renaming && !lockPosition}
      onDragStart={handleFieldDragStart}
      onDragOver={onFieldDragOver}
      onDrop={(e) => {
        e.preventDefault();
        onFieldDrop();
      }}
      onDragEnd={onFieldDragEnd}
      aria-label={`Field ${index + 1} of ${total}: ${column.name || "Untitled column"}`}
      // Sortable shift (Part 3 of UX polish) — applied as inline
      // `transform: translateY(<n>px)` so non-dragged rows visibly
      // slide out of the way of the in-flight drag. The same style
      // is threaded to every cell in this row's grid track via
      // `transformStyle`, keeping the whole row moving as one unit.
      style={transformStyle}
      className={cn(
        // `transition-[colors,opacity,transform]` ties together drop-
        // indicator border-color fade, drag-source opacity dim, AND
        // the sortable-shift translate so the row reads as one
        // coordinated movement during a reorder. 150ms keeps the
        // animation snappy without feeling laggy.
        "group sticky left-0 z-10 transition-[colors,opacity,transform] duration-150",
        // Stable 2px transparent top + bottom borders so the drop
        // indicator doesn't shift row heights when it appears.
        "border-t-2 border-t-transparent",
        "border-b-2 border-b-transparent",
        // Existing borders kept (thinner gray) inset of the indicator
        // axes — left role-band lives on its own border-l-2.
        "border-r border-l-2 border-gray-200 dark:border-line",
        role ? ROLE_BAND[role] : ROLE_BAND_NONE,
        // Selected row gets a stronger brand fill on the LABEL cell
        // (`bg-brand-100`) and a paler `bg-brand-50` continues across
        // the body cells in `RuleCellWrap`, so the inspected field
        // reads as a row-highlight band rather than a hard outline.
        // The role-band left border (above) remains the only "border-
        // like" visual on the row — no ring, no heavy outline, so the
        // selected state coexists cleanly with required / locked /
        // hover / role tint without piling visuals on top of each
        // other (Part 2 of UX polish).
        isSelected
          ? "bg-brand-100 dark:bg-brand-900/40"
          : "bg-gray-50 dark:bg-surface-muted",
        "px-3 py-2",
        // Vertical drop indicators: top edge before THIS row, bottom
        // edge when the drop target is past the last row.
        isDropBefore && "!border-t-brand-500",
        isDropAfterLast && "!border-b-brand-500",
        // Drag-source fade — mirrors how the table mode dims the
        // dragged column header during a reorder.
        isDragged && "opacity-40",
        // Cursor communicates "grab anywhere"; flips to text-cursor
        // inside the rename input and to not-allowed for position-
        // locked rows so the operator discovers the locked state on
        // hover. The actual drag-blocking happens via `draggable={...}`
        // below.
        renaming
          ? "cursor-text"
          : lockPosition
            ? "cursor-not-allowed"
            : "cursor-grab active:cursor-grabbing",
      )}
    >
      <div className="flex items-center gap-1.5">
        {/* Decorative grip — visual hint that the row is draggable.
            HORIZONTAL bars suggest vertical (up/down) reordering, the
            mirror of the table mode's vertical-bar grip for sideways
            reorder. The whole cell is the drag source; this icon is
            no longer the only handle. */}
        <span
          aria-hidden="true"
          className="shrink-0 -ml-1 px-0.5 py-1 text-gray-300 group-hover:text-gray-500 transition-colors dark:text-ink-subtle dark:group-hover:text-ink-muted"
          title="Drag field to reorder"
        >
          <GripHorizontal className="h-3.5 w-3.5" />
        </span>

        {/* Required pill — replaces the prior single Asterisk glyph
            with a louder "REQ" badge that's much harder to miss when
            scanning the field list. Tone matches the table mode header
            so the two surfaces stay coherent. */}
        {required && (
          <span
            title="Required column — this column must have a resolved value at extract time."
            aria-label="Required column"
            className="shrink-0 inline-flex items-center rounded bg-red-100 text-red-700 px-1 py-px text-[9px] font-bold uppercase tracking-wide ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900"
          >
            REQ
          </span>
        )}

        {/* Position lock — Pin icon. Distinct icon + color from the
            editing/override locks so the operator can scan and see
            "this row is fixed in place" at a glance. */}
        {lockPosition && (
          <span
            title="Position locked — this column can't be drag-reordered. Toggle in the column inspector to unlock."
            aria-label="Position locked"
            className="shrink-0 inline-flex items-center justify-center rounded bg-gray-200 text-gray-600 p-0.5 ring-1 ring-gray-300 dark:bg-surface-muted dark:text-ink-muted dark:ring-line"
          >
            <Pin className="h-2.5 w-2.5" />
          </span>
        )}

        {/* Editing lock — slate LockKeyhole. Schema fields frozen;
            rule cells across this row remain editable. Distinct from
            the amber `allow_rule_override = false` lock below, which
            silences rule cells' RUNTIME effect rather than freezing
            the schema. */}
        {lockEditing && (
          <span
            title="Editing locked — schema fields (name / source / type / format / validation) are read-only. Rule cells in this row remain editable. Toggle in the column inspector to unlock."
            aria-label="Editing locked"
            className="shrink-0 inline-flex items-center justify-center rounded bg-slate-200 text-slate-700 p-0.5 ring-1 ring-slate-300"
          >
            <LockKeyhole className="h-2.5 w-2.5" />
          </span>
        )}

        {ruleOverrideLocked && (
          <span
            title="Allow rule override is OFF — FILL/action writes cannot override the global behavior. IF/LIMIT cells can still scope rules."
            aria-label="Rule override locked"
            className="shrink-0 inline-flex items-center justify-center rounded bg-amber-100 text-amber-700 p-0.5 ring-1 ring-amber-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:ring-yellow-900"
          >
            <Lock className="h-2.5 w-2.5" />
          </span>
        )}

        {renaming ? (
          <input
            data-no-drag
            ref={renameInputRef}
            type="text"
            value={column.name}
            onChange={(e) => onChangeName(e.target.value)}
            maxLength={MAX_COLUMN_NAME_LENGTH}
            placeholder="Untitled column"
            aria-label={`Rename field ${index + 1}`}
            // Stop the mousedown so the parent <div>'s drag detection
            // (and any browser auto-drag of selected text) doesn't
            // hijack the editing intent.
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={() => setRenaming(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            className={cn(
              "flex-1 min-w-0 px-1.5 py-0.5 text-[12px] font-semibold text-gray-800 dark:text-ink",
              "bg-white rounded outline-none ring-2 ring-brand-500 dark:bg-surface-subtle",
              empty && "!ring-red-300 placeholder:text-red-400",
            )}
          />
        ) : (
          <button
            type="button"
            // Single click → SELECT the column (open the inspector).
            // Never closes — gear toggles for a quick close affordance.
            onClick={onSelect}
            // Double click → enter rename mode. Same affordance as the
            // table HeaderCell so flipping modes mid-edit feels
            // identical.
            onDoubleClick={(e) => {
              e.preventDefault();
              setRenaming(true);
            }}
            // F2 — standard spreadsheet "rename" shortcut for keyboard
            // users. Enter/Space still fire onClick → select.
            onKeyDown={(e) => {
              if (e.key === "F2") {
                e.preventDefault();
                setRenaming(true);
              }
            }}
            title={`${column.name || "Untitled column"} — click to inspect, double-click to rename`}
            aria-label={`Field ${index + 1}: ${column.name || "Untitled column"}. Click to open inspector, double-click to rename.`}
            aria-pressed={isSelected}
            className={cn(
              "flex-1 min-w-0 px-1.5 py-0.5 text-left text-[12px] font-semibold rounded truncate",
              "select-none",
              "hover:bg-white/70 focus-visible:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-surface-subtle/70 dark:focus-visible:bg-surface-subtle",
              empty
                ? "text-red-400 italic ring-1 ring-red-300 dark:text-red-400 dark:ring-red-900"
                : isSelected
                  ? "text-brand-900 dark:text-brand-50"
                  : "text-gray-800 dark:text-ink",
            )}
          >
            {column.name || "Untitled column"}
          </button>
        )}

        {/* Settings gear — opens / closes the inspector. Marked
            data-no-drag + stopPropagation on mousedown so clicking the
            gear doesn't get hijacked into a row reorder. Mirror of the
            table HeaderCell's gear behavior. */}
        <button
          data-no-drag
          type="button"
          onClick={onOpenInspector}
          onMouseDown={(e) => e.stopPropagation()}
          aria-pressed={isSelected}
          aria-label={
            isSelected
              ? `Close inspector for ${column.name || "column"}`
              : `Open inspector for ${column.name || "column"}`
          }
          title={
            isSelected ? "Close column inspector" : "Open column inspector"
          }
          className={cn(
            "shrink-0 p-1 rounded transition-colors",
            isSelected
              ? "text-brand-700 bg-brand-100 hover:bg-brand-200 dark:bg-brand-900/40 dark:text-brand-50 dark:hover:bg-brand-900/60"
              : "text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:text-ink-subtle dark:hover:text-ink dark:hover:bg-surface-muted",
          )}
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
        {/* Per-field menu (Part 9). Mirrors the table-mode HeaderMenu
            with the same set of actions (rename / settings / lock toggles
            / insert / delete) so operators get parity across views.
            Wrapper carries `data-no-drag` so the chevron + popover items
            don't initiate a row reorder. */}
        <span data-no-drag>
          <FieldMenu
            canInsert={canInsert}
            canRemove={canRemove}
            lockPosition={columnLockPosition(column)}
            lockEditing={columnLockEditing(column)}
            onRename={() => setRenaming(true)}
            onOpenSettings={onOpenInspector}
            onInsertAbove={onInsertAbove}
            onInsertBelow={onInsertBelow}
            onRemove={onRemove}
            onToggleLockPosition={onToggleLockPosition}
            onToggleLockEditing={onToggleLockEditing}
          />
        </span>
      </div>
      <div className="mt-1 ml-5 flex flex-wrap items-center gap-1">
        {/* Role chip — same tone the horizontal column header uses. */}
        <span
          className={cn(
            "inline-flex items-center gap-0.5 rounded px-1 py-px text-[9.5px] font-medium uppercase tracking-wide",
            role ? ROLE_TONE[role] : ROLE_TONE_NONE,
          )}
          title={
            role ? `Rule role: ${RULE_ROLE_LABEL[role]}` : "No default rule role"
          }
        >
          <RoleIcon className="h-2.5 w-2.5" />
          {role ? ROLE_SHORT[role] : "NONE"}
        </span>
        {/* Source chip — only when there's a binding to display. */}
        {sourceType !== "empty" && (
          <span
            className="inline-flex items-center gap-0.5 rounded bg-gray-100 px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-gray-600 dark:bg-surface-muted dark:text-ink-muted"
            title={SOURCE_TYPE_LABEL[sourceType]}
          >
            <SourceIcon className="h-2.5 w-2.5" />
            <span className="truncate max-w-[6rem]">
              {SOURCE_TYPE_LABEL[sourceType]}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function RuleCellWrap({
  column,
  cell,
  isSelected,
  isDragged,
  transformStyle,
  disabled,
  catalogIndex,
  onChange,
}: {
  column: InvoiceTemplateColumn;
  cell: InvoiceTemplateRuleCell;
  isSelected: boolean;
  /**
   * The row this cell belongs to is currently being drag-reordered.
   * Mirrors the table mode behavior of fading every body cell in a
   * dragged column so the operator can see the whole row "lift" with
   * its label.
   */
  isDragged: boolean;
  /**
   * Sortable shift inline style (Part 3 of UX polish). Threaded down
   * from `FieldRow` so each rule cell moves with its label cell during
   * a reorder, keeping the row visually unified.
   */
  transformStyle?: { transform: string };
  disabled?: boolean;
  catalogIndex: CatalogIndex;
  onChange: (cell: InvoiceTemplateRuleCell) => void;
}) {
  return (
    <div
      role="gridcell"
      style={transformStyle}
      className={cn(
        "border-b border-r border-gray-200 px-2 py-2 align-top dark:border-line/60",
        // `transition-[colors,opacity,transform]` — selected-tint hover,
        // drag-source dim, and sortable shift all ease in/out instead
        // of snapping. The duration matches the field-label cell so a
        // row reorder reads as a single coordinated movement across
        // the entire row.
        "transition-[colors,opacity,transform] duration-150",
        // Row-highlight body fill when this cell's column is the
        // inspected one — paints alongside the louder `bg-brand-100`
        // on the FieldLabelCell so the entire row reads as one
        // continuous brand-tinted band (Part 2 of UX polish). No
        // border/ring here so the body cells stay scannable; the
        // role-band left border on the FieldLabelCell already provides
        // enough edge to anchor the row visually.
        isSelected
          ? "bg-brand-50 dark:bg-brand-900/30"
          : "bg-white dark:bg-surface",
        isDragged && "opacity-40",
      )}
    >
      <RuleCellEditor
        column={column}
        cell={cell}
        catalogIndex={catalogIndex}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes row — one per-rule textarea, anchored under the field rows so
// notes don't float off in their own panel.
// ---------------------------------------------------------------------------

function NotesRow({
  rules,
  onSetNotes,
}: {
  rules: InvoiceTemplateRule[];
  onSetNotes: (ruleId: string, notes: string) => void;
}) {
  return (
    <>
      <div
        role="rowheader"
        className="sticky left-0 z-10 bg-gray-50 border-b border-r border-l-2 border-l-gray-200 px-3 py-2 flex items-center gap-1.5 dark:bg-surface-muted dark:border-line dark:border-l-line"
      >
        <StickyNote className="h-3 w-3 text-gray-400 shrink-0 dark:text-ink-subtle" />
        <span className="text-[12px] font-semibold text-gray-700 dark:text-ink">
          Notes
        </span>
        <span className="text-[9.5px] text-gray-400 normal-case dark:text-ink-subtle">
          (per rule)
        </span>
      </div>
      {rules.map((rule) => (
        <div
          key={rule.id}
          role="gridcell"
          className="border-b border-r border-gray-200 px-2 py-2 bg-white dark:border-line/60 dark:bg-surface"
        >
          <input
            type="text"
            value={rule.notes ?? ""}
            onChange={(e) => onSetNotes(rule.id, e.target.value)}
            placeholder="Why does this rule exist?"
            maxLength={MAX_RULE_NOTES_LENGTH}
            disabled={!rule.is_active}
            aria-label={`Notes for rule ${rule.id}`}
            className={cn(
              "w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-[12px] text-gray-700",
              "dark:border-line dark:bg-surface-subtle dark:text-ink dark:placeholder:text-ink-subtle",
              "focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500",
              !rule.is_active &&
                "cursor-not-allowed bg-gray-50 opacity-70 dark:bg-surface-muted",
            )}
          />
        </div>
      ))}
      {/* Trailing placeholder for the addRuleTrack on the notes row.
          Same load-bearing role as the per-field-row placeholder — keeps
          CSS Grid auto-flow from stealing the trailing slot. */}
      <TrailingPlaceholder />
    </>
  );
}

// ---------------------------------------------------------------------------
// Empty-state placard for "no rules yet"
// ---------------------------------------------------------------------------

function EmptyRulesPanel({ onAddRule }: { onAddRule: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center dark:border-line dark:bg-surface-subtle">
      <p className="text-[13px] font-medium text-gray-700 dark:text-ink">
        No rules yet
      </p>
      <p className="text-[11.5px] text-gray-500 mt-1 max-w-md mx-auto dark:text-ink-muted">
        Add a rule to start scoping behavior — each rule appears as its
        own column to the right of the field list, so you can compare
        rules side-by-side without horizontal scrolling.
      </p>
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={onAddRule}
        className="mt-3"
      >
        <Plus className="h-3.5 w-3.5" />
        Add your first rule
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Visual-language constants — shared with the horizontal table header
// so an operator switching modes recognises the same chips and tones.
// ---------------------------------------------------------------------------

const SOURCE_ICONS: Record<ColumnSourceType, LucideIcon> = {
  empty: Square,
  fixed_value: Type,
  manual_list: ListChecks,
  invoice_field: FileSpreadsheet,
  property_field: Building2,
  vendor_field: Users,
  gl_field: Hash,
  derived: Sparkles,
};

const ROLE_ICONS: Record<RuleRole, LucideIcon> = {
  condition: Scale,
  restriction: CornerDownRight,
  action: Target,
};

const ROLE_TONE: Record<RuleRole, string> = {
  condition: "bg-amber-50 text-amber-700 dark:bg-yellow-950/40 dark:text-yellow-200",
  restriction: "bg-violet-50 text-violet-700 dark:bg-purple-950/40 dark:text-purple-200",
  action: "bg-emerald-50 text-emerald-700 dark:bg-green-950/40 dark:text-green-200",
};
const ROLE_TONE_NONE =
  "bg-gray-100 text-gray-600 dark:bg-surface-muted dark:text-ink-muted";

const ROLE_BAND: Record<RuleRole, string> = {
  // Thin left-edge accent on each field-label cell — keeps the role
  // band scannable down the sticky-left column at a glance.
  condition: "border-l-amber-400",
  restriction: "border-l-violet-400",
  action: "border-l-emerald-400",
};
const ROLE_BAND_NONE = "border-l-gray-300 dark:border-l-line-strong";

const ROLE_SHORT: Record<RuleRole, string> = {
  condition: "CND",
  restriction: "RST",
  action: "ACT",
};
