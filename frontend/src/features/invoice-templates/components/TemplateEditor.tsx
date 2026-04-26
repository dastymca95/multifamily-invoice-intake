"use client";

import {
  ArrowLeftFromLine,
  ArrowRightFromLine,
  Building2,
  ChevronDown,
  Copy,
  CornerDownRight,
  FileSpreadsheet,
  GripVertical,
  Hash,
  ListChecks,
  Lock,
  LockKeyhole,
  Pencil,
  Pin,
  Plus,
  Save,
  Scale,
  Settings2,
  Sparkles,
  Square,
  Target,
  Trash2,
  Type,
  Undo2,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { DependencyBlockerDialog } from "@/components/dependencies/DependencyBlockerDialog";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Switch } from "@/components/ui/Switch";
import { getApiErrorMessage, invoiceTemplatesApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { UsedByReport } from "@/types/dependencies";
import {
  MAX_COLUMNS,
  MAX_COLUMN_NAME_LENGTH,
  MAX_RULES,
  MIN_COLUMNS,
  RULE_ROLE_LABEL,
  SOURCE_TYPE_LABEL,
  type ColumnSourceType,
  type ImportTemplateValidationResult,
  type InvoiceTemplateColumn,
  type InvoiceTemplateRule,
  type InvoiceTemplateRuleCell,
  type InvoiceTemplateSource,
  type RuleRole,
  columnAllowsRuleOverride,
  columnLockEditing,
  columnLockPosition,
  cloneInvoiceTemplateRule,
  defaultColumnMetadata,
  effectiveCellRole,
  effectiveColumnDefaultRole,
  emptyRuleCell,
  newColumnId,
  newRule,
} from "@/types/invoice-template";

import type { CatalogIndex } from "../hooks/useCatalogIndex";

import { ColumnInspector } from "./ColumnInspector";
import { ImportTemplateValidationPanel } from "./ImportTemplateValidationPanel";
import {
  type BuilderLayoutMode,
  LayoutToggle,
  readLayoutMode,
  writeLayoutMode,
} from "./LayoutToggle";
import { RuleCellEditor } from "./RuleCellEditor";
import { RuleMatrixView } from "./RuleMatrixView";

/**
 * Spreadsheet-first Import Builder editor.
 *
 * The table is the operating surface. The header row is the column
 * SCHEMA (Layer 1). Each body row beneath the header is an EDITABLE
 * RULE ROW (Layer 2) — actual structured data, not a placeholder.
 * Rule rows scope runtime behavior: cells in `condition` columns
 * gate when the rule applies, cells in `restriction` columns narrow
 * the candidate set for that column, cells in `action` columns
 * suggest / set output values.
 *
 * Direct manipulation:
 *
 *   * Header rename — each header cell is an inline `<input>`.
 *
 *   * Drag-and-drop reorder — every header has a visible grip handle
 *     (`GripVertical`). The handle is the drag source; the header
 *     cell is the drop target. A 2px brand-colored insertion
 *     indicator marks the resolved insert position; the dragged
 *     column dims to 40% opacity. Drop splices the column.
 *
 *   * Add column — a "+" `<th>` sits at the right end of the header
 *     row. Clicking appends a new column and auto-focuses its header
 *     input.
 *
 *   * Remove column — each header has a contextual `…` menu with
 *     "Delete column". Removing a column ALSO scrubs that column's
 *     id out of every rule's `cells` dict so saved rule rows don't
 *     keep ghost data for columns that no longer exist.
 *
 *   * Per-column inspector — a gear button on each header opens the
 *     `ColumnInspector` (right side). The inspector owns the column
 *     contract: required toggle, rule role (condition / restriction /
 *     action), source kind, source binding, manual list values,
 *     validation hints.
 *
 *   * Per-column header chips — required columns get a red asterisk;
 *     a tiny rule-role chip ("CND" / "RST" / "ACT") shows the
 *     column's role at a glance; a source-type chip shows the
 *     binding kind (orange tint when incomplete).
 *
 *   * Editable rule rows — each body row carries a left-side toolbar
 *     (drag handle placeholder, row index, active Switch, duplicate,
 *     delete) and one cell per column. Cell editor is dispatched per
 *     column source type (multi-tag chip input for catalog/invoice
 *     bindings, multi-select pills for manual lists, free text for
 *     fixed/empty, locked placeholder for derived). Inactive rules
 *     remain visible but greyed out and read-only — toggle the
 *     active Switch to re-edit.
 *
 *   * Add rule — a "+ Add rule" button under the table appends a
 *     fresh active rule row with empty cells.
 *
 *   * Horizontal scroll — single `overflow-auto` container.
 *     Header row is `sticky top-0`; row toolbar + index column is
 *     `sticky left-0`.
 *
 * Form state is local; the editor seeds from `initial` and resets
 * on `templateKey` change. Save sends `{name, description, columns,
 * rules}` up; the parent decides create vs. update.
 */

interface InitialTemplate {
  name: string;
  description: string | null;
  columns: InvoiceTemplateColumn[];
  /**
   * Existing rule rows. Empty array for templates created before the
   * rule-rows feature; the backend defaults to `[]` for legacy rows.
   */
  rules: InvoiceTemplateRule[];
  source: InvoiceTemplateSource;
}

interface TemplateEditorProps {
  /** Stable identity (real id, or "draft"). Changes reset local form state. */
  templateKey: string;
  initial: InitialTemplate;
  /** True iff editing the unsaved canonical-default draft. */
  isDraft: boolean;
  saving: boolean;
  mutationError: string | null;
  /**
   * Saved catalog summaries (vendors / properties / GL codes) used by
   * the column inspector to disambiguate catalog-backed source
   * bindings. Owned at the page level so column-switches don't refetch.
   */
  catalogIndex: CatalogIndex;
  onSave: (body: {
    name: string;
    description: string | null;
    columns: InvoiceTemplateColumn[];
    rules: InvoiceTemplateRule[];
  }) => Promise<void>;
  /** Only present when editing a saved template. */
  onDelete?: () => Promise<void>;
}

const SOURCE_BADGE: Record<
  InvoiceTemplateSource,
  { label: string; tone: string }
> = {
  default: {
    label: "Default",
    tone: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-200",
  },
  blank: {
    label: "Blank",
    tone:
      "bg-gray-100 text-gray-700 dark:bg-surface-muted dark:text-ink-muted",
  },
  from_upload: {
    label: "From upload",
    tone:
      "bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-200",
  },
  custom: {
    label: "Custom",
    tone:
      "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-50",
  },
};

// Same icon set the inspector uses; mirrored here so the per-header
// chip stays visually consistent with the inspector's source list.
const HEADER_SOURCE_ICONS: Record<ColumnSourceType, LucideIcon> = {
  empty: Square,
  fixed_value: Type,
  manual_list: ListChecks,
  invoice_field: FileSpreadsheet,
  property_field: Building2,
  vendor_field: Users,
  gl_field: Hash,
  derived: Sparkles,
};

// Rule-role chip on the column header. Same icons as the inspector's
// rule-role picker so the visual language stays consistent. Per-role
// background tint also tints the corresponding column body cells in
// rule rows so the operator can scan "what kind of cell am I editing"
// at a glance.
const HEADER_RULE_ROLE_ICONS: Record<RuleRole, LucideIcon> = {
  condition: Scale,
  restriction: CornerDownRight,
  action: Target,
};

// Compact 3-letter labels for the column-header role chip — fits in
// the same horizontal slot as the source-type chip without truncation.
const HEADER_RULE_ROLE_SHORT: Record<RuleRole, string> = {
  condition: "CND",
  restriction: "RST",
  action: "ACT",
};

// Per-role tinting for the column-header chip and the body cells of
// rule rows. Same swatch in both places so a scan of one column down
// the table reads as a single colored band.
const HEADER_RULE_ROLE_CHIP_TONE: Record<RuleRole, string> = {
  condition: "bg-amber-50 text-amber-700 dark:bg-yellow-950/40 dark:text-yellow-200",
  restriction: "bg-violet-50 text-violet-700 dark:bg-purple-950/40 dark:text-purple-200",
  action: "bg-emerald-50 text-emerald-700 dark:bg-green-950/40 dark:text-green-200",
};
const HEADER_NO_RULE_ROLE_CHIP_TONE =
  "bg-gray-100 text-gray-600 dark:bg-surface-muted dark:text-ink-muted";

const BODY_RULE_ROLE_CELL_TONE: Record<RuleRole, string> = {
  // Translucent body tints — kept light in light mode and shifted to a
  // mid-slate tint with a hint of color in dark mode so the role band
  // still scans down the column without burning the eye.
  condition: "bg-amber-50/40 dark:bg-yellow-950/20",
  restriction: "bg-violet-50/40 dark:bg-purple-950/20",
  action: "bg-emerald-50/30 dark:bg-green-950/20",
};
const BODY_NO_RULE_ROLE_CELL_TONE = "bg-gray-50/40 dark:bg-surface-muted/20";

// Padding row count used when the template has zero rule rows — keeps
// the table feeling like a workspace rather than collapsing to a
// single header row. Once the user adds rules, the padding rows
// disappear; rule rows themselves take over.
const EMPTY_PLACEHOLDER_ROW_COUNT = 6;

/**
 * Sortable-transform shift math (Part 3 of UX polish).
 *
 * Given a row/column at `idx`, the currently-dragged index, the resolved
 * drop-before index, and the dragged element's size in the relevant
 * axis, returns the px offset that this row/column should translate by
 * to "make room" for the drag — the modern sortable-list "items slide
 * out of the way" effect.
 *
 * Index semantics:
 *   * `dropIdx === N` means "drop BEFORE position N" (so dropIdx can
 *     equal `length` to mean "drop at the end").
 *   * The dragged item itself NEVER shifts — it stays at its source
 *     position with `opacity-40` while the cursor carries a drag image.
 *   * Items between source and target shift by ±size:
 *       - Forward drag (draggedIdx < dropIdx): items in (draggedIdx,
 *         dropIdx) shift by `-size` (they slide back to fill the gap
 *         the dragged item leaves).
 *       - Backward drag (draggedIdx > dropIdx): items in [dropIdx,
 *         draggedIdx) shift by `+size` (they slide forward to make
 *         room).
 *
 * Returns 0 (no shift) when:
 *   * No drag is active (`draggedIdx == null` or `dropIdx == null`).
 *   * Size is 0 (drag started but rect not yet measured).
 *   * `idx === draggedIdx` (the dragged item itself).
 *   * The drop is a no-op (`dropIdx === draggedIdx` or
 *     `dropIdx === draggedIdx + 1`).
 *
 * Consumers apply the result as `transform: translateX/Y(<n>px)` plus
 * a CSS transition on transform (`transition-[..,transform]`) so the
 * shift animates smoothly. After drop the data updates AND draggedIdx
 * resets in lockstep — every cell re-renders with shift=0, and because
 * the cells are keyed by stable ids, React preserves the same DOM
 * elements; the shift→0 transition smoothly settles them into the
 * sorted positions (the preview-shifted positions ARE the post-drop
 * positions, so there's no visible jump).
 */
export function computeReorderShift(
  idx: number,
  draggedIdx: number | null,
  dropIdx: number | null,
  size: number,
): number {
  if (draggedIdx == null || dropIdx == null || size === 0) return 0;
  if (idx === draggedIdx) return 0;
  if (draggedIdx < dropIdx) {
    // Forward drag — items strictly between source and the drop slot
    // slide BACKWARD by size.
    if (idx > draggedIdx && idx < dropIdx) return -size;
  } else if (draggedIdx > dropIdx) {
    // Backward drag — items in [dropIdx, draggedIdx) slide FORWARD.
    if (idx >= dropIdx && idx < draggedIdx) return size;
  }
  return 0;
}

export function TemplateEditor({
  templateKey,
  initial,
  isDraft,
  saving,
  mutationError,
  catalogIndex,
  onSave,
  onDelete,
}: TemplateEditorProps) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [columns, setColumns] = useState<InvoiceTemplateColumn[]>(
    initial.columns,
  );
  // Rule rows live in their own piece of state so column ops (insert /
  // delete / reorder) and rule ops are independent. Both arrays travel
  // together on save.
  const [rules, setRules] = useState<InvoiceTemplateRule[]>(initial.rules);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [validationLoading, setValidationLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationResult, setValidationResult] =
    useState<ImportTemplateValidationResult | null>(null);
  const [deleteCheckLoading, setDeleteCheckLoading] = useState(false);
  const [deleteDependencyReport, setDeleteDependencyReport] =
    useState<UsedByReport | null>(null);
  const [deleteDependencyError, setDeleteDependencyError] = useState<
    string | null
  >(null);
  // Two independent column-attention states:
  //
  //   * `selectedColumnId` — the column the operator is currently
  //     focused on / scanning. Drives the Soft Lime column highlight
  //     across header + body cells. Set by clicking the column NAME
  //     (table mode) or the field LABEL (matrix mode); never opens
  //     the inspector on its own.
  //
  //   * `inspectorColumnId` — the column whose inspector dialog is
  //     currently open. Drives the floating ColumnInspector + the
  //     gear icon's "active" lime chip. Set by clicking the GEAR
  //     icon next to the column name. Toggling the same gear closes;
  //     clicking the gear of a different column swaps the inspector
  //     to that column (and sweeps the highlight along).
  //
  // Splitting the two means an operator can scan / highlight columns
  // without the modal-style inspector backdrop popping up. The
  // inspector becomes an explicit "open settings" gesture instead
  // of an implicit byproduct of selection.
  //
  // Both are cleared on template switch + when the underlying column
  // is removed.
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const [inspectorColumnId, setInspectorColumnId] = useState<string | null>(null);

  // Layout mode — horizontal (spreadsheet, default) vs vertical
  // (transposed rule matrix: fields down as rows, rules across as
  // columns; see RuleMatrixView). Persisted per-user in localStorage;
  // the toggle in the toolbar flips it. Both modes operate on the
  // SAME local `columns` + `rules` state — the toggle never forks
  // data, only presentation. Initial value is the persisted preference
  // (or "horizontal" when no preference is saved / localStorage is
  // unavailable). We don't reset it on `templateKey` change because
  // it's a per-user preference, not a per-template setting.
  const [layoutMode, setLayoutModeState] =
    useState<BuilderLayoutMode>("horizontal");
  // Two-step init so SSR doesn't choke on `localStorage` access. The
  // post-mount effect rehydrates from storage; until then we render in
  // the default mode (matches legacy behavior).
  useEffect(() => {
    setLayoutModeState(readLayoutMode());
  }, []);
  const handleSetLayoutMode = useCallback((next: BuilderLayoutMode) => {
    setLayoutModeState(next);
    writeLayoutMode(next);
  }, []);

  // Reset on template switch.
  useEffect(() => {
    setName(initial.name);
    setDescription(initial.description ?? "");
    setColumns(initial.columns);
    setRules(initial.rules);
    setConfirmingDelete(false);
    setValidationOpen(false);
    setValidationLoading(false);
    setValidationError(null);
    setValidationResult(null);
    setDeleteCheckLoading(false);
    setDeleteDependencyReport(null);
    setDeleteDependencyError(null);
    setDraggedIdx(null);
    setDropIdx(null);
    setSelectedColumnId(null);
    setInspectorColumnId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateKey]);

  // ---- Dirty / save gates --------------------------------------------------

  const dirty = useMemo(() => {
    if (name.trim() !== initial.name) return true;
    if ((description.trim() || null) !== (initial.description ?? null))
      return true;
    if (JSON.stringify(columns) !== JSON.stringify(initial.columns))
      return true;
    // JSON-string compare is fine here — rule shapes are small (<500
    // rows, sub-100 cells each), and we don't need structural equality
    // semantics beyond "did anything change".
    if (JSON.stringify(rules) !== JSON.stringify(initial.rules)) return true;
    return false;
  }, [name, description, columns, rules, initial]);

  const trimmedColumnNames = columns.map((c) => c.name.trim());
  const hasEmptyColumnName = trimmedColumnNames.some((n) => n.length === 0);
  const validColumnCount =
    columns.length >= MIN_COLUMNS && columns.length <= MAX_COLUMNS;
  const validRuleCount = rules.length <= MAX_RULES;
  const canSave =
    !saving &&
    name.trim().length > 0 &&
    !hasEmptyColumnName &&
    validColumnCount &&
    validRuleCount &&
    (isDraft || dirty);

  const handleSave = () => {
    if (!canSave) return;
    void onSave({
      name: name.trim(),
      description: description.trim() ? description.trim() : null,
      columns: columns.map((c, i) => ({ ...c, name: trimmedColumnNames[i] })),
      rules,
    });
  };

  const handleDiscard = () => {
    setName(initial.name);
    setDescription(initial.description ?? "");
    setColumns(initial.columns);
    setRules(initial.rules);
  };

  const handleValidate = useCallback(async () => {
    setValidationOpen(true);
    setValidationResult(null);
    if (isDraft) {
      setValidationError("Save this template before checking readiness.");
      return;
    }

    setValidationLoading(true);
    setValidationError(null);
    try {
      const result = await invoiceTemplatesApi.validate(templateKey);
      setValidationResult(result);
    } catch (err) {
      setValidationError(
        getApiErrorMessage(err, "Could not validate this template."),
      );
    } finally {
      setValidationLoading(false);
    }
  }, [isDraft, templateKey]);

  const handleRequestDelete = useCallback(async () => {
    if (isDraft) return;
    setDeleteCheckLoading(true);
    setDeleteDependencyError(null);
    try {
      const report = await invoiceTemplatesApi.getUsedBy(templateKey);
      if (report.safe_to_delete) {
        setConfirmingDelete(true);
      } else {
        setDeleteDependencyReport(report);
      }
    } catch (err) {
      setDeleteDependencyError(
        getApiErrorMessage(err, "Could not check where this template is used."),
      );
    } finally {
      setDeleteCheckLoading(false);
    }
  }, [isDraft, templateKey]);

  // ---- Auto-enter rename signal -------------------------------------------
  // After "+ add column" we want the new header to flip straight into
  // rename mode so the operator can type a name without an extra
  // click. Both views (`HeaderCell` in table mode, `FieldLabelCell` in
  // matrix mode) observe `pendingFocusId` via an `autoEnterRename`
  // prop; whichever one is currently mounted consumes it and clears
  // the signal. The cells now own their own input refs + focus +
  // scroll-into-view, so the parent doesn't track per-cell input refs
  // anymore.
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const consumePendingFocus = useCallback(() => {
    setPendingFocusId(null);
  }, []);

  // ---- Column ops ----------------------------------------------------------

  const updateColumn = useCallback(
    (id: string, patch: Partial<InvoiceTemplateColumn>) => {
      setColumns((curr) =>
        curr.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      );
    },
    [],
  );

  const removeColumn = useCallback((id: string) => {
    setColumns((curr) => {
      if (curr.length <= MIN_COLUMNS) return curr;
      return curr.filter((c) => c.id !== id);
    });
    // Scrub the deleted column's id out of every rule's `cells` dict.
    // Without this, we'd persist orphan cell data the resolver can never
    // reach (the column id is no longer in `columns`). The schema
    // tolerates orphans on the wire (no FK validation), so this is a
    // hygiene step rather than a hard requirement — but it makes the
    // saved JSONB cleaner and keeps the editor's mental model honest.
    setRules((curr) =>
      curr.map((r) => {
        if (!(id in r.cells)) return r;
        const nextCells: Record<string, InvoiceTemplateRuleCell> = {};
        for (const [colId, cell] of Object.entries(r.cells)) {
          if (colId !== id) nextCells[colId] = cell;
        }
        return { ...r, cells: nextCells };
      }),
    );
    // If we just removed the column the inspector was bound to, hide
    // the inspector — there's nothing to display anymore. Also clear
    // the highlight so the empty visual band doesn't linger.
    setSelectedColumnId((curr) => (curr === id ? null : curr));
    setInspectorColumnId((curr) => (curr === id ? null : curr));
  }, []);

  // ---- Rule ops -----------------------------------------------------------

  /** Append a fresh rule row keyed to the current column ids. */
  const addRule = useCallback(() => {
    setRules((curr) => {
      if (curr.length >= MAX_RULES) return curr;
      const ids = columns.map((c) => c.id);
      return [...curr, newRule(ids)];
    });
  }, [columns]);

  /** Remove a rule by id. */
  const removeRule = useCallback((ruleId: string) => {
    setRules((curr) => curr.filter((r) => r.id !== ruleId));
  }, []);

  /** Toggle a rule's `is_active` flag. */
  const toggleRuleActive = useCallback((ruleId: string) => {
    setRules((curr) =>
      curr.map((r) =>
        r.id === ruleId ? { ...r, is_active: !r.is_active } : r,
      ),
    );
  }, []);

  /** Duplicate a rule (new id, full semantic clone). Inserted after source. */
  const duplicateRule = useCallback((ruleId: string) => {
    setRules((curr) => {
      if (curr.length >= MAX_RULES) return curr;
      const idx = curr.findIndex((r) => r.id === ruleId);
      if (idx === -1) return curr;
      const source = curr[idx];
      // Deep-clone the whole rule so edits on the duplicate never mutate
      // the source. Both the legacy `values` array AND the structured
      // `selections`, `role`, `extraction`, and `extraction_bindings`
      // paths need their own copies; notes carry over verbatim.
      const dup = cloneInvoiceTemplateRule(source);
      const next = curr.slice();
      next.splice(idx + 1, 0, dup);
      return next;
    });
  }, []);

  /** Patch one cell of one rule. */
  const setRuleCell = useCallback(
    (ruleId: string, columnId: string, cell: InvoiceTemplateRuleCell) => {
      setRules((curr) =>
        curr.map((r) =>
          r.id === ruleId
            ? { ...r, cells: { ...r.cells, [columnId]: cell } }
            : r,
        ),
      );
    },
    [],
  );

  /** Edit a rule's notes. Empty string clears to null. */
  const setRuleNotes = useCallback((ruleId: string, notes: string) => {
    setRules((curr) =>
      curr.map((r) =>
        r.id === ruleId
          ? { ...r, notes: notes.trim() ? notes : null }
          : r,
      ),
    );
  }, []);

  /** Insert a fresh column at the given absolute position (0..length). */
  const insertColumnAt = useCallback((position: number) => {
    // New columns get explicit baseline metadata (required: false,
    // source_type: "empty", everything else null) instead of relying on
    // the schema defaults to materialize them on save. Makes the
    // inspector show consistent state the moment you select a fresh
    // column.
    const newCol: InvoiceTemplateColumn = {
      id: newColumnId(),
      name: "New column",
      source_column: null,
      ...defaultColumnMetadata(),
    };
    setColumns((curr) => {
      if (curr.length >= MAX_COLUMNS) return curr;
      const clamped = Math.max(0, Math.min(position, curr.length));
      const next = curr.slice();
      next.splice(clamped, 0, newCol);
      return next;
    });
    setPendingFocusId(newCol.id);
  }, []);

  /**
   * Toggle the floating inspector dialog for `id`.
   *   * Same id → closes (the gear becomes a quick-close affordance).
   *   * Different id → swaps the inspector to the new column AND
   *     sweeps the highlight along, so the lime band always points
   *     at whatever the inspector is currently bound to.
   *   * Fresh click on a column with no inspector open → opens the
   *     inspector and highlights the column.
   *
   * Wired to the gear icon ONLY. Clicking the column name no longer
   * opens the dialog — see `selectColumn` for the highlight-only
   * alternative wired to name clicks.
   */
  const toggleInspector = useCallback((id: string) => {
    setInspectorColumnId((curr) => {
      const next = curr === id ? null : id;
      // When OPENING (or swapping), keep the highlight aligned with
      // the inspected column. When CLOSING (next === null) we leave
      // the highlight alone — operators often close the inspector and
      // continue scanning the same column visually.
      if (next != null) setSelectedColumnId(next);
      return next;
    });
  }, []);

  /**
   * Select a column for highlight — never deselects, never opens the
   * inspector. Used by the single-click on the header label / matrix
   * field label, where "click" should always mean "make this the
   * actively-scanned column" without forcing the inspector dialog
   * (with its dimmed backdrop) to pop.
   *
   * Distinct from `toggleInspector`, which is wired to the gear icon
   * and is the ONLY way to open the floating inspector dialog.
   */
  const selectColumn = useCallback((id: string) => {
    setSelectedColumnId(id);
  }, []);

  // ---- Drag-and-drop reorder ----------------------------------------------
  // HTML5 native drag/drop, no extra dependency. The whole header cell
  // is the drag SOURCE in both views (table mode <th>, matrix mode
  // sticky-left field cell) — operators can grab anywhere in the
  // header instead of hunting for the small grip icon. Drop targets:
  //   * Table mode — every header cell + the trailing "+" cell for
  //     end-of-row drops. Insertion indicator = a 2px brand-colored
  //     LEFT border (or right border on the last cell).
  //   * Matrix mode — every field-label cell. Insertion indicator = a
  //     2px brand-colored TOP border (or bottom border on the last
  //     row), since drag is vertical there.
  // Both modes share the same `draggedIdx` / `dropIdx` state and the
  // same `finishDrop` reducer — only the geometry of the drop-over
  // detection differs (left/right halves vs top/bottom halves).

  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  // Bounding rect of the dragged element, sampled once on drag start.
  // Drives the "items slide out of the way" transform math (Part 3 of
  // UX polish). Width is consumed by table mode (horizontal reorder);
  // height is consumed by matrix mode (vertical reorder). Stored as
  // an object rather than a single value so the SAME drag handler can
  // serve both orientations without branching at the source.
  const [dragSize, setDragSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const onHandleDragStart = useCallback(
    (e: DragEvent<HTMLElement>, index: number) => {
      setDraggedIdx(index);
      setDropIdx(index);
      // Snapshot the source element's size for the sortable shift
      // math. We measure ONCE here (not on every dragOver) because the
      // dragged element's own size doesn't change mid-drag — only its
      // perceived index does. This keeps the transform stable across
      // the entire drag.
      const rect = e.currentTarget.getBoundingClientRect();
      setDragSize({ width: rect.width, height: rect.height });
      e.dataTransfer.effectAllowed = "move";
      // Firefox requires a payload to start the drag.
      e.dataTransfer.setData("text/plain", String(index));
    },
    [],
  );

  const onHeaderDragOver = useCallback(
    (e: DragEvent<HTMLTableCellElement>, index: number) => {
      if (draggedIdx == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const isLeftHalf = e.clientX < rect.left + rect.width / 2;
      const next = isLeftHalf ? index : index + 1;
      if (next !== dropIdx) setDropIdx(next);
    },
    [draggedIdx, dropIdx],
  );

  const onTrailingDragOver = useCallback(
    (e: DragEvent<HTMLTableCellElement>) => {
      if (draggedIdx == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const target = columns.length;
      if (target !== dropIdx) setDropIdx(target);
    },
    [columns.length, draggedIdx, dropIdx],
  );

  /**
   * Vertical drag-over for matrix mode's field rows. Mirrors
   * `onHeaderDragOver` but uses the Y axis (top-half / bottom-half)
   * since fields stack vertically as rows there. Same `dropIdx`
   * semantics — `dropIdx === N` means "drop before row N".
   */
  const onFieldRowDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>, index: number) => {
      if (draggedIdx == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const isTopHalf = e.clientY < rect.top + rect.height / 2;
      const next = isTopHalf ? index : index + 1;
      if (next !== dropIdx) setDropIdx(next);
    },
    [draggedIdx, dropIdx],
  );

  const finishDrop = useCallback(() => {
    if (draggedIdx == null || dropIdx == null) {
      setDraggedIdx(null);
      setDropIdx(null);
      setDragSize({ width: 0, height: 0 });
      return;
    }
    setColumns((curr) => {
      let target = dropIdx;
      // If we're moving forward, the splice-removal shifts later indices.
      if (target > draggedIdx) target -= 1;
      if (target === draggedIdx) return curr;
      const next = curr.slice();
      const [moved] = next.splice(draggedIdx, 1);
      next.splice(target, 0, moved);
      return next;
    });
    // Reset drag state in lockstep with the splice — the next render
    // sees the new column order AND draggedIdx=null, so every cell's
    // computed shift drops back to 0. Because cells are keyed by
    // column id, React preserves the same DOM elements; the shift-→-0
    // transition smoothly settles them into their new sorted positions
    // (the preview-shifted positions ARE the post-drop positions, so
    // there's no visible jump for the un-dragged items).
    setDraggedIdx(null);
    setDropIdx(null);
    setDragSize({ width: 0, height: 0 });
  }, [draggedIdx, dropIdx]);

  const onAnyDragEnd = useCallback(() => {
    setDraggedIdx(null);
    setDropIdx(null);
    setDragSize({ width: 0, height: 0 });
  }, []);

  // ---- Render --------------------------------------------------------------

  const sourceBadge = SOURCE_BADGE[initial.source];
  const atMaxColumns = columns.length >= MAX_COLUMNS;
  const canDelete = !isDraft && Boolean(onDelete);
  // Resolve the currently-highlighted column (or null). Drives the
  // Soft Lime band across header + body cells. We always pull fresh
  // from local state so the highlight follows in-flight column edits.
  const selectedColumn = selectedColumnId
    ? columns.find((c) => c.id === selectedColumnId) ?? null
    : null;
  // Resolve the column whose floating inspector dialog is currently
  // open (or null). Independent from `selectedColumn` so the operator
  // can scan a column with the lime band without forcing the modal
  // backdrop to pop.
  const inspectorColumn = inspectorColumnId
    ? columns.find((c) => c.id === inspectorColumnId) ?? null
    : null;

  // Hide drop indicators when the resolved insertion would put the
  // column back in its current position (drag to self == no-op). The
  // resolved target shifts by -1 when moving forward because the
  // splice-remove vacates the source position first.
  const resolvedTarget =
    draggedIdx != null && dropIdx != null
      ? dropIdx > draggedIdx
        ? dropIdx - 1
        : dropIdx
      : null;
  const noOpDrop =
    resolvedTarget != null && draggedIdx != null && resolvedTarget === draggedIdx;

  return (
    <div className="flex-1 min-h-0 flex">
      {/* The editor body (toolbar + spreadsheet) keeps the full height
          and takes 100% of the available width. The column inspector
          renders as a `position: fixed` floating draggable window (see
          ColumnInspector) rather than a docked side rail, so the table
          stays the dominant surface and the inspector floats over it
          without claiming any flex track of its own. */}
      <div className="flex-1 min-w-0 flex flex-col">
      {/* ------------------ Compact toolbar (name + actions) ------------------ */}
      <header className="border-b border-gray-200 bg-white shrink-0 dark:border-line dark:bg-surface-subtle">
        <div className="flex items-center gap-2 px-4 pt-3">
          <FileSpreadsheet className="h-4 w-4 text-brand-700 dark:text-brand-50 shrink-0" />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Untitled template"
            maxLength={255}
            aria-label="Template name"
            className={cn(
              "flex-1 max-w-md min-w-0 text-[14px] font-semibold text-gray-800 dark:text-ink",
              "bg-transparent rounded-md px-2 py-1 outline-none placeholder:text-gray-400 dark:placeholder:text-ink-subtle",
              "hover:bg-gray-50 focus:bg-white focus:ring-2 focus:ring-brand-500 dark:hover:bg-surface-muted dark:focus:bg-surface",
              name.trim().length === 0 && "ring-1 ring-red-300 dark:ring-red-900",
            )}
          />
          <span
            className={cn(
              "shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              sourceBadge.tone,
            )}
          >
            {sourceBadge.label}
          </span>
          {isDraft && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-orange-50 text-orange-700 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide dark:bg-orange-950/40 dark:text-orange-200">
              <Sparkles className="h-2.5 w-2.5" />
              Unsaved
            </span>
          )}
          {dirty && !isDraft && (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-orange-600 dark:text-orange-400">
              Unsaved changes
            </span>
          )}
          <span className="shrink-0 text-[10.5px] text-gray-400 dark:text-ink-subtle">
            {columns.length} / {MAX_COLUMNS} cols
          </span>
          <div className="flex-1" />
          <LayoutToggle mode={layoutMode} onChange={handleSetLayoutMode} />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={validationLoading}
            loading={validationLoading}
            onClick={handleValidate}
            title={
              isDraft
                ? "Save this template before checking readiness."
                : dirty
                  ? "Checks the last saved version."
                  : "Check readiness"
            }
          >
            <ListChecks className="h-3.5 w-3.5" />
            Validate
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canSave}
            loading={saving}
            onClick={handleSave}
          >
            <Save className="h-3.5 w-3.5" />
            {isDraft
              ? "Save as new template"
              : dirty
                ? "Save changes"
                : "Saved"}
          </Button>
          {!isDraft && dirty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={handleDiscard}
            >
              <Undo2 className="h-3.5 w-3.5" />
              Discard
            </Button>
          )}
          {canDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              loading={deleteCheckLoading}
              onClick={() => void handleRequestDelete()}
              title="Delete this template"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        <div className="px-4 pt-1 pb-2 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold shrink-0 dark:text-ink-subtle">
            About
          </span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe this template (optional)"
            aria-label="Template description"
            className="flex-1 min-w-0 text-[11.5px] text-gray-600 bg-transparent rounded-md px-2 py-1 outline-none hover:bg-gray-50 focus:bg-white focus:ring-2 focus:ring-brand-500 dark:text-ink-muted dark:placeholder:text-ink-subtle dark:hover:bg-surface-muted dark:focus:bg-surface"
          />
        </div>

        {(mutationError ||
          hasEmptyColumnName ||
          name.trim().length === 0 ||
          deleteDependencyError) && (
          <div className="px-4 pb-2 space-y-1.5">
            {mutationError && (
              <InlineAlert tone="error">{mutationError}</InlineAlert>
            )}
            {deleteDependencyError && (
              <InlineAlert tone="error" title="Delete check failed">
                {deleteDependencyError}
              </InlineAlert>
            )}
            {name.trim().length === 0 && (
              <InlineAlert tone="warning">
                Name is required before saving.
              </InlineAlert>
            )}
            {hasEmptyColumnName && (
              <InlineAlert tone="warning">
                One or more columns are missing a name. Click the empty
                header in the table to fill it in.
              </InlineAlert>
            )}
          </div>
        )}

        {confirmingDelete && onDelete && (
          <div className="mx-4 mb-3 rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2.5 text-[11.5px] text-yellow-900 space-y-1.5 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-200">
            <p className="font-semibold">Delete this template?</p>
            <p className="text-yellow-900/80 dark:text-yellow-200/80">
              The column shape and its name will be lost. Existing
              exports already produced with this template are not
              affected.
            </p>
            <div className="flex gap-1.5">
              <Button
                type="button"
                variant="danger"
                size="sm"
                loading={saving}
                onClick={() => {
                  setConfirmingDelete(false);
                  void onDelete();
                }}
              >
                Yes, delete
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </header>

      <DependencyBlockerDialog
        open={deleteDependencyReport != null}
        report={deleteDependencyReport}
        onClose={() => setDeleteDependencyReport(null)}
      />

      {/* ------------------------ Workspace body ----------------------- */}
      {/* Two presentations over the same `columns` + `rules` state:
            * horizontal — the spreadsheet table (columns across, rules down)
            * vertical   — the transposed rule matrix (fields down,
                           rules across as columns) — see RuleMatrixView.
          The toggle in the toolbar flips between them; both edit the
          same underlying state, so flipping mid-edit is a no-op for
          the data. */}
      {layoutMode === "vertical" ? (
        <RuleMatrixView
          columns={columns}
          rules={rules}
          catalogIndex={catalogIndex}
          selectedColumnId={selectedColumnId}
          inspectorColumnId={inspectorColumnId}
          // Same drag state as table mode — both views share one
          // `draggedIdx` / `dropIdx` so the parent reducer stays the
          // single source of truth for column ordering.
          draggedIdx={draggedIdx}
          dropIdx={dropIdx}
          // Sortable-transform shift size (Part 3 of UX polish). The
          // parent samples the dragged element's bounding rect on
          // drag start; matrix mode consumes the HEIGHT axis (rows
          // stack vertically). 0 when no drag is in flight.
          dragRowHeight={dragSize.height}
          // Same auto-enter rename signal as table mode — whichever
          // view is currently mounted picks it up after "+ add column".
          pendingFocusId={pendingFocusId}
          onConsumedRename={consumePendingFocus}
          onChangeColumnName={(colId, value) =>
            updateColumn(colId, { name: value })
          }
          onSelectColumn={selectColumn}
          onFieldDragStart={onHandleDragStart}
          onFieldDragOver={onFieldRowDragOver}
          onFieldDrop={finishDrop}
          onFieldDragEnd={onAnyDragEnd}
          onAddRule={addRule}
          onToggleActive={(id) => toggleRuleActive(id)}
          onDuplicate={(id) => duplicateRule(id)}
          onRemove={(id) => removeRule(id)}
          onSetCell={(ruleId, columnId, cell) =>
            setRuleCell(ruleId, columnId, cell)
          }
          onSetNotes={(ruleId, notes) => setRuleNotes(ruleId, notes)}
          onOpenColumnInspector={(id) => toggleInspector(id)}
          // Inline "+" affordances (Part 6). Splice math stays in the
          // parent reducer — the matrix view only paints the buttons.
          onAddColumn={() => insertColumnAt(columns.length)}
          atColumnCap={atMaxColumns}
          // Per-field menu (Part 9). All splice / lock operations go
          // through the parent reducer so table mode and matrix mode
          // share the same source of truth for column edits.
          onInsertColumnAt={(index) => insertColumnAt(index)}
          onRemoveColumn={(id) => removeColumn(id)}
          onToggleColumnLockPosition={(id) => {
            const col = columns.find((c) => c.id === id);
            if (!col) return;
            updateColumn(id, { lock_position: !columnLockPosition(col) });
          }}
          onToggleColumnLockEditing={(id) => {
            const col = columns.find((c) => c.id === id);
            if (!col) return;
            updateColumn(id, { lock_editing: !columnLockEditing(col) });
          }}
          canRemoveColumn={columns.length > MIN_COLUMNS}
        />
      ) : (
      <div className="flex-1 min-h-0 overflow-hidden p-4 bg-gray-50 dark:bg-surface">
        <div className="h-full rounded-lg border border-gray-200 bg-white shadow-sm flex flex-col min-h-0 dark:border-line dark:bg-surface-subtle">
          {/* Help strip — quick reminder of what the table supports.
              Two distinct concerns: schema (header) and rules (rows). */}
          <div className="border-b border-gray-200 bg-gray-50/60 px-3 py-1.5 text-[10.5px] text-gray-500 flex items-center gap-3 flex-wrap shrink-0 dark:border-line dark:bg-surface-muted/60 dark:text-ink-muted">
            <span className="inline-flex items-center gap-1">
              <GripVertical className="h-3 w-3 text-gray-400 dark:text-ink-subtle" />
              Drag a header to reorder
            </span>
            <span className="text-gray-300 dark:text-line-strong">·</span>
            <span className="inline-flex items-center gap-1">
              <Settings2 className="h-3 w-3 text-gray-400 dark:text-ink-subtle" />
              Open the inspector for column-level contract
            </span>
            <span className="text-gray-300 dark:text-line-strong">·</span>
            <span className="inline-flex items-center gap-1">
              <Plus className="h-3 w-3 text-gray-400 dark:text-ink-subtle" />
              Add columns at the trailing cell, rules at the bottom
            </span>
            <span className="text-gray-300 dark:text-line-strong">·</span>
            <span className="inline-flex items-center gap-1">
              <Scale className="h-3 w-3 text-amber-600 dark:text-yellow-400" />
              <span className="text-amber-700 font-semibold dark:text-yellow-200">
                CND
              </span>
              <CornerDownRight className="h-3 w-3 ml-2 text-violet-600 dark:text-purple-300" />
              <span className="text-violet-700 font-semibold dark:text-purple-200">
                RST
              </span>
              <Target className="h-3 w-3 ml-2 text-emerald-600 dark:text-green-400" />
              <span className="text-emerald-700 font-semibold dark:text-green-200">
                ACT
              </span>
            </span>
          </div>

          {/* Scroll surface — single source of horizontal scroll. */}
          <div className="flex-1 min-h-0 overflow-auto">
            <table className="border-collapse text-[12px] w-max">
              <thead>
                <tr>
                  {/* Sticky-top + sticky-left corner. Wider than the
                      old "#" cell because it now stacks above each
                      rule row's left toolbar (active switch + index
                      + actions), not just a row number. */}
                  <th
                    className="sticky top-0 left-0 z-30 bg-gray-100 border-r border-b border-gray-200 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wide w-[7rem] min-w-[7rem] dark:bg-surface-muted dark:border-line dark:text-ink-subtle"
                    aria-label="Rule"
                  >
                    Rule
                  </th>

                  {columns.map((col, i) => (
                    <HeaderCell
                      key={col.id}
                      col={col}
                      index={i}
                      total={columns.length}
                      atMaxColumns={atMaxColumns}
                      isDragged={draggedIdx === i}
                      isSelected={selectedColumnId === col.id}
                      isInspectorOpen={inspectorColumnId === col.id}
                      // Sortable-transform shift in px (Part 3 of UX
                      // polish). 0 when this column isn't between the
                      // drag source and the drop target — see
                      // `computeReorderShift` for the math. The same
                      // shift is applied to every body cell in this
                      // column inside `RuleRow`.
                      reorderShift={computeReorderShift(
                        i,
                        draggedIdx,
                        dropIdx,
                        dragSize.width,
                      )}
                      isDropBefore={
                        !noOpDrop &&
                        dropIdx === i &&
                        draggedIdx !== null &&
                        draggedIdx !== i
                      }
                      isDropAfterLast={
                        !noOpDrop &&
                        i === columns.length - 1 &&
                        dropIdx === columns.length &&
                        draggedIdx !== null
                      }
                      autoEnterRename={pendingFocusId === col.id}
                      onConsumedRename={consumePendingFocus}
                      onChangeName={(value) =>
                        updateColumn(col.id, { name: value })
                      }
                      onSelect={() => selectColumn(col.id)}
                      onInsertLeft={() => insertColumnAt(i)}
                      onInsertRight={() => insertColumnAt(i + 1)}
                      onRemove={() => removeColumn(col.id)}
                      onOpenSettings={() => toggleInspector(col.id)}
                      onToggleLockPosition={() =>
                        updateColumn(col.id, {
                          lock_position: !columnLockPosition(col),
                        })
                      }
                      onToggleLockEditing={() =>
                        updateColumn(col.id, {
                          lock_editing: !columnLockEditing(col),
                        })
                      }
                      onHandleDragStart={(e) => onHandleDragStart(e, i)}
                      onHeaderDragOver={(e) => onHeaderDragOver(e, i)}
                      onDrop={finishDrop}
                      onDragEnd={onAnyDragEnd}
                    />
                  ))}

                  <TrailingAddCell
                    isDropTarget={
                      !noOpDrop &&
                      dropIdx === columns.length &&
                      draggedIdx !== null
                    }
                    disabled={atMaxColumns}
                    onClick={() => insertColumnAt(columns.length)}
                    onDragOver={onTrailingDragOver}
                    onDrop={finishDrop}
                  />
                </tr>
              </thead>

              <tbody>
                {columns.length === 0 ? (
                  <tr>
                    <td
                      colSpan={2}
                      className="px-3 py-6 text-center text-[11.5px] text-gray-500 italic dark:text-ink-muted"
                    >
                      Add a column with the &quot;+&quot; cell at the right
                      to get started.
                    </td>
                  </tr>
                ) : rules.length === 0 ? (
                  /* No rule rows yet — render a few faint placeholder
                     rows + a centered call-to-action so the table doesn't
                     collapse to a single header strip. The placeholders
                     are inert; the real "add" button sits below the
                     scroll surface (so it stays visible regardless of
                     horizontal scroll position). */
                  <>
                    {Array.from({ length: EMPTY_PLACEHOLDER_ROW_COUNT }).map(
                      (_, ri) => {
                        const stripeClass =
                          ri % 2 === 0
                            ? "bg-white dark:bg-surface"
                            : "bg-gray-50/40 dark:bg-surface-muted/40";
                        return (
                          <tr key={`placeholder-${ri}`} className={stripeClass}>
                            <th
                              scope="row"
                              className={cn(
                                "sticky left-0 z-10 border-r border-b border-gray-200 px-2 py-1 text-left align-middle text-[10px] font-mono text-gray-300 w-[7rem] min-w-[7rem] dark:border-line dark:text-ink-subtle",
                                stripeClass,
                              )}
                            >
                              —
                            </th>
                            {columns.map((col, ci) => {
                              // Sortable-transform shift for placeholder
                              // rows too (Part 3 of UX polish) — without
                              // this the empty-state placeholders stay
                              // put while the header above them slides,
                              // breaking the "whole column moves as one
                              // unit" illusion.
                              const phShift = computeReorderShift(
                                ci,
                                draggedIdx,
                                dropIdx,
                                dragSize.width,
                              );
                              return (
                                <td
                                  key={col.id}
                                  style={
                                    phShift !== 0
                                      ? {
                                          transform: `translateX(${phShift}px)`,
                                        }
                                      : undefined
                                  }
                                  className={cn(
                                    "border-r border-b border-gray-200 px-3 py-1 text-gray-200 italic whitespace-nowrap min-w-[12rem] max-w-[20rem] dark:border-line dark:text-line-strong",
                                    "transition-[opacity,transform] duration-150",
                                    draggedIdx === ci && "opacity-40",
                                    // Carry the column-wide selected tint
                                    // through the placeholder rows so the
                                    // band runs uninterrupted from header
                                    // to footer even on a fresh template.
                                    // Solid Soft Lime — same intensity as
                                    // the header + body rule cells so the
                                    // selected band reads as one
                                    // continuous color stripe regardless
                                    // of which row type fills the column.
                                    selectedColumnId === col.id &&
                                      "bg-rivera-soft-lime dark:bg-rivera-lime/15",
                                  )}
                                >
                                  —
                                </td>
                              );
                            })}
                            <td className="border-b border-gray-100 w-[3.5rem] min-w-[3.5rem] dark:border-line/60" />
                          </tr>
                        );
                      },
                    )}
                  </>
                ) : (
                  <>
                    {rules.map((rule, ri) => (
                      <RuleRow
                        key={rule.id}
                        rule={rule}
                        ruleIndex={ri}
                        columns={columns}
                        draggedIdx={draggedIdx}
                        // Sortable-transform shift state (Part 3 of
                        // UX polish). Threaded down so each body cell
                        // can compute its own translateX from its
                        // column index — keeps the header AND every
                        // rule cell in the same column moving in
                        // lockstep so the column reads as one unit
                        // sliding aside.
                        dropIdx={dropIdx}
                        dragColWidth={dragSize.width}
                        // Column-wide selected highlight — body cells in
                        // the inspected column get a faint brand tint so
                        // the selected column reads as a vertical band
                        // running the full table height, not just a
                        // tinted header.
                        selectedColumnId={selectedColumnId}
                        catalogIndex={catalogIndex}
                        onToggleActive={() => toggleRuleActive(rule.id)}
                        onDuplicate={() => duplicateRule(rule.id)}
                        onRemove={() => removeRule(rule.id)}
                        onSetCell={(columnId, cell) =>
                          setRuleCell(rule.id, columnId, cell)
                        }
                        onSetNotes={(notes) => setRuleNotes(rule.id, notes)}
                      />
                    ))}
                    {/* Inline "+ Add rule" row (Part 5).
                        Sits at the bottom of the rules so the operator
                        can extend the matrix without scrolling to the
                        footer button. The footer button stays as the
                        always-visible fallback (handy when the table
                        scrolls horizontally and the inline row's
                        button has scrolled off screen). */}
                    <AddRuleInlineRow
                      columnCount={columns.length}
                      disabled={rules.length >= MAX_RULES}
                      atCap={rules.length >= MAX_RULES}
                      cap={MAX_RULES}
                      onClick={addRule}
                    />
                  </>
                )}
              </tbody>
            </table>
          </div>

          {/* Footer — Add-rule action + counts. Sits below the scroll
              surface so the action stays visible regardless of how
              far the user has horizontally scrolled the table. */}
          <div className="border-t border-gray-200 bg-gray-50/60 px-3 py-2 flex items-center justify-between gap-3 shrink-0 flex-wrap dark:border-line dark:bg-surface-muted/60">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={addRule}
              disabled={rules.length >= MAX_RULES || columns.length === 0}
              title={
                rules.length >= MAX_RULES
                  ? `Rule cap reached (${MAX_RULES}).`
                  : columns.length === 0
                    ? "Add a column before adding rules."
                    : "Append a new rule row"
              }
            >
              <Plus className="h-3.5 w-3.5" />
              Add rule
            </Button>
            <div className="text-[10.5px] text-gray-500 flex items-center gap-3 dark:text-ink-muted">
              <span>
                {columns.length} column{columns.length === 1 ? "" : "s"} ·{" "}
                {rules.length} rule{rules.length === 1 ? "" : "s"} (max{" "}
                {MAX_RULES})
              </span>
              {rules.length === 0 && columns.length > 0 && (
                <span className="text-gray-400 italic dark:text-ink-subtle">
                  No rules yet — add one to start scoping behavior.
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
      )}
      </div>

      {/* ------------------ Floating column inspector ------------------------- */}
      {/* Renders as a centered, draggable, modal-style dialog — does NOT
          participate in the surrounding flex track. Bound to the gear
          icon's `inspectorColumnId` (NOT the column-highlight
          `selectedColumnId`) so plain selection no longer forces the
          backdrop to pop. See ColumnInspector for the dialog UX. */}
      {inspectorColumn && (
        <ColumnInspector
          column={inspectorColumn}
          catalogIndex={catalogIndex}
          onChange={(patch) => updateColumn(inspectorColumn.id, patch)}
          onClose={() => setInspectorColumnId(null)}
        />
      )}
      <ImportTemplateValidationPanel
        open={validationOpen}
        loading={validationLoading}
        error={validationError}
        result={validationResult}
        hasUnsavedChanges={dirty && !isDraft}
        onClose={() => setValidationOpen(false)}
      />
    </div>
  );
}

// ===========================================================================
// Header cell
// ===========================================================================

interface HeaderCellProps {
  col: InvoiceTemplateColumn;
  index: number;
  total: number;
  atMaxColumns: boolean;
  isDragged: boolean;
  /** Column has the Soft Lime highlight (set by name-click). */
  isSelected: boolean;
  /**
   * Floating ColumnInspector dialog is currently bound to this column
   * (set by gear-click). Independent from `isSelected`: the gear icon
   * paints its lime "active" chip + flips its aria/title labels
   * around this prop, while the column body fill stays driven by
   * `isSelected`.
   */
  isInspectorOpen: boolean;
  isDropBefore: boolean;
  isDropAfterLast: boolean;
  /**
   * Sortable-transform shift in px (Part 3 of UX polish). Resolved by
   * the parent via `computeReorderShift(index, draggedIdx, dropIdx,
   * dragColWidth)`. Applied as `transform: translateX(<n>px)` so the
   * cell slides out of the way of an in-flight drag, matching modern
   * sortable-list semantics. 0 when no shift is needed.
   */
  reorderShift: number;
  /**
   * Parent-driven signal that this column should ENTER rename mode
   * (e.g., right after the operator clicks "+ add column"). When the
   * cell consumes the signal it calls `onConsumedRename` to clear it.
   * Replaces the previous "share a focusable input ref with the
   * parent" pattern — the cell now owns its rename input lifecycle.
   */
  autoEnterRename: boolean;
  onConsumedRename: () => void;
  onChangeName: (value: string) => void;
  /**
   * Single-click on the header label — selects the column and ensures
   * the inspector is open. NEVER closes / deselects (use the gear or
   * the inspector's own close button for that). Distinct from
   * `onOpenSettings` so the header label and the gear can have
   * intentionally different semantics.
   */
  onSelect: () => void;
  onInsertLeft: () => void;
  onInsertRight: () => void;
  onRemove: () => void;
  onOpenSettings: () => void;
  onToggleLockPosition: () => void;
  onToggleLockEditing: () => void;
  onHandleDragStart: (e: DragEvent<HTMLTableCellElement>) => void;
  onHeaderDragOver: (e: DragEvent<HTMLTableCellElement>) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

function HeaderCell({
  col,
  index,
  total,
  atMaxColumns,
  isDragged,
  isSelected,
  isInspectorOpen,
  isDropBefore,
  isDropAfterLast,
  reorderShift,
  autoEnterRename,
  onConsumedRename,
  onChangeName,
  onSelect,
  onInsertLeft,
  onInsertRight,
  onRemove,
  onOpenSettings,
  onToggleLockPosition,
  onToggleLockEditing,
  onHandleDragStart,
  onHeaderDragOver,
  onDrop,
  onDragEnd,
}: HeaderCellProps) {
  const empty = col.name.trim().length === 0;
  const sourceType: ColumnSourceType = col.source_type ?? "empty";
  const required = col.required ?? false;
  // Resolve via the helper so the legacy `rule_role` AND the canonical
  // `default_rule_role` are reconciled in one place. Null is a real
  // authored "no default role" state, so the header renders neutral.
  const ruleRole = effectiveColumnDefaultRole(col);
  // When the column's `allow_rule_override` is OFF, FILL/action writes
  // under this column cannot replace the global behavior. IF/LIMIT cells
  // may still scope rules, so this is a write-precedence lock.
  const ruleOverrideLocked = !columnAllowsRuleOverride(col);
  // Phase 2 — separate lock concepts (Part 7). Each has its own visual
  // affordance with a distinct icon:
  //   * Pin (gray)    — `lock_position`: column can't be drag-reordered.
  //   * LockKeyhole   — `lock_editing`:  column schema (name/source/
  //     (slate)         type/format/validation) is frozen; rule cells
  //                     under it remain editable.
  //   * Lock (amber)  — `allow_rule_override = false`: FILL/action writes
  //                     cannot override the global behavior.
  // Three distinct icons + colors so the operator can scan a header
  // and read each lock at a glance without hovering for tooltips.
  const lockPosition = columnLockPosition(col);
  const lockEditing = columnLockEditing(col);
  // We only show the source chip when the column declares a non-empty
  // binding — otherwise every header would carry an "empty" pill that
  // adds visual noise without information.
  const showSourceChip = sourceType !== "empty";
  const SourceIcon = HEADER_SOURCE_ICONS[sourceType];
  const RoleIcon = ruleRole ? HEADER_RULE_ROLE_ICONS[ruleRole] : Square;
  // The ref-binding kinds need a target field to actually emit a value;
  // we surface "no field picked yet" inline with an orange tint on the
  // chip so the operator notices the gap without opening the inspector.
  const refBindingMissingField =
    (sourceType === "invoice_field" ||
      sourceType === "property_field" ||
      sourceType === "vendor_field" ||
      sourceType === "gl_field") &&
    (col.source_ref?.field ?? null) === null;
  // Manual list with no real entries also can't satisfy the contract.
  const manualListMissingValues =
    sourceType === "manual_list" &&
    (col.manual_values ?? []).filter((v) => v.trim().length > 0).length === 0;
  const sourceIncomplete = refBindingMissingField || manualListMissingValues;

  // ---- Rename mode (locally owned) -----------------------------------------
  // The header label is a *button* by default — single click selects,
  // double click (or F2 / parent-triggered auto-enter) flips it into
  // an input for editing. Keeps text editing intentional rather than
  // accidental, which was the old single-click-to-focus problem.
  const [renaming, setRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-enter rename mode when the parent flags it (after add /
  // explicit rename action) — then immediately tell the parent we
  // consumed the signal so subsequent renders don't re-trigger it.
  useEffect(() => {
    if (!autoEnterRename) return;
    setRenaming(true);
    onConsumedRename();
  }, [autoEnterRename, onConsumedRename]);

  // Focus + select-all + scroll-into-view whenever rename mode opens.
  // Subsumes the parent's old `inputRefs` + focus useEffect — the
  // input only exists during rename mode, so the focus contract lives
  // entirely with the cell that owns it.
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

  // Drag-start guard: the entire <th> is draggable, but a few children
  // (gear, menu, the rename input) need to swallow drag attempts so
  // their own clicks aren't hijacked into reorder. Each of those
  // children is tagged with `data-no-drag`; we cancel the drag when
  // it originates inside any such ancestor.
  const handleHeaderDragStart = (e: DragEvent<HTMLTableCellElement>) => {
    if (renaming) {
      // Defensive: `draggable={!renaming}` should already prevent this,
      // but we double-cancel to avoid a half-started drag if the user
      // mousedowns mid-state-flip.
      e.preventDefault();
      return;
    }
    if (lockPosition) {
      // `lock_position` columns are pinned — they can't be picked up.
      // The `draggable={...}` prop below should already prevent this
      // from firing, but we double-cancel for the same race-condition
      // safety as the renaming guard above.
      e.preventDefault();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest("[data-no-drag]")) {
      e.preventDefault();
      return;
    }
    onHandleDragStart(e);
  };

  return (
    <th
      scope="col"
      // Whole-header drag: the cell itself is the drag source so the
      // operator can grab anywhere in the header (label, chips, blank
      // padding) instead of hunting for the tiny grip icon. The grip
      // icon stays as a visual hint of the affordance.
      // Position-locked columns are non-draggable — `draggable={false}`
      // is the cheapest way to prevent the browser from initiating any
      // drag at all, and the `cursor-not-allowed` class below makes
      // the locked state legible on hover.
      draggable={!renaming && !lockPosition}
      onDragStart={handleHeaderDragStart}
      onDragEnd={onDragEnd}
      // Sortable shift (Part 3 of UX polish). Applied as an inline
      // `transform: translateX(<n>px)` rather than a Tailwind class
      // because the px value is dynamic. The transition list in
      // className includes `transform` so the shift animates smoothly,
      // including the post-drop settle-back-to-0 (the data has already
      // been re-spliced by then, so settling to translate=0 lands the
      // cell at its new sorted position).
      style={
        reorderShift !== 0
          ? { transform: `translateX(${reorderShift}px)` }
          : undefined
      }
      className={cn(
        "group sticky top-0 z-20",
        // Smooth transitions for drag feedback (Part 3):
        //   * `transition-colors` makes the drop-indicator border-color
        //     fade instead of snapping in.
        //   * `transition-opacity` softens the dragged-source fade so
        //     pickup/release reads as a lift rather than a flicker.
        //   * `transition-transform` (added in Part 3 UX polish) drives
        //     the sortable "items slide out of the way" animation when
        //     `reorderShift` toggles between 0 and ±dragColWidth.
        //   * `duration-150` matches the rest of the editor's micro-
        //     animations (Switch toggle, hover bg).
        "transition-[colors,opacity,transform] duration-150",
        // Selected column gets a STRONGER Soft Lime fill on the header
        // cell (`bg-rivera-soft-lime`) plus a paler `bg-rivera-soft-lime/60`
        // on every body cell in the same column — so the inspected
        // column reads as a continuous filled vertical band from header
        // through the bottom of the rules list, even when the inspector
        // itself is scrolled offscreen. Soft Lime (#ECFFD2) was chosen
        // over the previous Real Estate Blue tint so the selected band
        // sits in the same color family as the saved-list selected row
        // (Electric Lime) — both surfaces feel like the same "selected"
        // moment in two different intensities. In dark mode we drop to
        // a translucent Electric Lime so the navy backdrop reads through.
        // No ring/outline here (Part 2 of UX polish): the border-based
        // drop indicator and the role-tint body cells remain
        // unobstructed, and the selected state coexists cleanly with
        // required / locked / hover without piling visuals on top of
        // each other.
        isSelected
          ? "bg-rivera-soft-lime dark:bg-rivera-lime/15"
          : "bg-gray-50 dark:bg-surface-muted",
        // Stable 2px transparent borders so the drop indicator doesn't
        // shift cell widths when it appears.
        "border-l-2 border-l-transparent border-r border-b border-gray-200 dark:border-line",
        "px-2 py-1.5 text-left align-top whitespace-nowrap",
        "min-w-[12rem] max-w-[20rem]",
        // Grab cursor on the entire header — communicates "this whole
        // surface is draggable", not just the grip icon. When the
        // column is position-locked, switch to a not-allowed cursor so
        // operators discover the locked state on hover. The actual
        // drag-blocking happens via `draggable={...}` below.
        renaming
          ? "cursor-text"
          : lockPosition
            ? "cursor-not-allowed"
            : "cursor-grab active:cursor-grabbing",
        isDropBefore && "!border-l-brand-500",
        isDropAfterLast && "border-r-2 !border-r-brand-500",
        isDragged && "opacity-40",
      )}
      onDragOver={onHeaderDragOver}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <div className="flex items-center gap-1">
        {/* Decorative grip — visual hint that the header is draggable.
            The whole <th> above is the drag source; this icon is no
            longer the only handle, so we mark it aria-hidden and let
            it ride along with the cell-level drag. */}
        <span
          aria-hidden="true"
          className="shrink-0 -ml-1 px-0.5 py-1 text-gray-300 group-hover:text-gray-500 transition-colors dark:text-ink-subtle dark:group-hover:text-ink-muted"
          title="Drag header to reorder"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>

        {renaming ? (
          <input
            data-no-drag
            ref={renameInputRef}
            type="text"
            value={col.name}
            onChange={(e) => onChangeName(e.target.value)}
            maxLength={MAX_COLUMN_NAME_LENGTH}
            placeholder="Untitled column"
            aria-label={`Rename column ${index + 1}`}
            // Stop the mousedown so the parent <th>'s drag detection
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
              "flex-1 min-w-0 px-1.5 py-1 text-[12.5px] font-semibold text-gray-800 dark:text-ink",
              "bg-white rounded outline-none ring-2 ring-brand-500 dark:bg-surface-subtle",
              empty &&
                "!ring-red-300 placeholder:text-red-400 dark:!ring-red-900 dark:placeholder:text-red-400",
            )}
          />
        ) : (
          <button
            type="button"
            // Single click → highlight the column with the Soft Lime
            // band. Never closes the highlight; never opens the
            // floating inspector dialog (the gear icon to the right
            // is the only entry point for that). Keeps "select" as a
            // stable, unambiguous action that doesn't surprise the
            // operator with a modal backdrop.
            onClick={onSelect}
            // Double click → enter rename mode. Makes text editing
            // intentional rather than triggered by a stray click.
            onDoubleClick={(e) => {
              e.preventDefault();
              setRenaming(true);
            }}
            // F2 is the standard spreadsheet "rename" shortcut once a
            // header has keyboard focus — gives keyboard users the
            // same affordance as a double-click without changing the
            // Enter/Space semantics (those still fire onClick → select).
            onKeyDown={(e) => {
              if (e.key === "F2") {
                e.preventDefault();
                setRenaming(true);
              }
            }}
            title={`${col.name || "Untitled column"} — click to highlight, gear to open inspector, double-click to rename`}
            aria-label={`Column ${index + 1}: ${col.name || "Untitled column"}. Click to highlight; click the gear to open inspector; double-click to rename.`}
            aria-pressed={isSelected}
            className={cn(
              "flex-1 min-w-0 px-1.5 py-1 text-left text-[12.5px] font-semibold rounded truncate",
              "select-none",
              "hover:bg-white/70 focus-visible:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-surface-subtle/70 dark:focus-visible:bg-surface-subtle",
              empty
                ? "text-red-400 italic ring-1 ring-red-300 dark:text-red-400 dark:ring-red-900"
                : isSelected
                  ? // Deep Navy on Soft Lime in light mode reads
                    // crisply; Electric Lime on the translucent dark
                    // tint keeps the selected label legible against
                    // the navy backdrop.
                    "text-rivera-navy dark:text-rivera-lime"
                  : "text-gray-800 dark:text-ink",
            )}
          >
            {col.name || "Untitled column"}
          </button>
        )}

        {/* Required pill — replaces the prior single Asterisk glyph
            with a louder "REQ" badge that's much harder to miss when
            scanning a wide header row. Tone matches the inspector's
            required affordance so the two surfaces stay coherent. */}
        {required && (
          <span
            title="Required column — this column must have a resolved value at extract time."
            aria-label="Required column"
            className="shrink-0 inline-flex items-center rounded bg-red-100 text-red-700 px-1 py-px text-[9px] font-bold uppercase tracking-wide ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900"
          >
            REQ
          </span>
        )}

        {/* Position lock — Pin icon on a neutral chip. Distinct icon +
            color from the editing/override locks so the operator can
            scan and see "this column is fixed in place" at a glance
            without disambiguating tooltips. */}
        {lockPosition && (
          <span
            title="Position locked — this column can't be drag-reordered. Toggle in the column inspector to unlock."
            aria-label="Position locked"
            className="shrink-0 inline-flex items-center justify-center rounded bg-gray-200 text-gray-600 p-0.5 ring-1 ring-gray-300 dark:bg-surface-muted dark:text-ink-muted dark:ring-line"
          >
            <Pin className="h-3 w-3" />
          </span>
        )}

        {/* Editing lock — slate LockKeyhole. Communicates "the column
            schema (name / source / type / format / validation) is
            frozen". Rule cells under this column REMAIN editable —
            distinct from `allow_rule_override = false`, which silences
            the rule cells' RUNTIME effect rather than freezing the
            schema. */}
        {lockEditing && (
          <span
            title="Editing locked — schema fields (name / source / type / format / validation) are read-only. Rule cells under this column remain editable. Toggle in the column inspector to unlock."
            aria-label="Editing locked"
            className="shrink-0 inline-flex items-center justify-center rounded bg-slate-200 text-slate-700 p-0.5 ring-1 ring-slate-300 dark:bg-surface-muted dark:text-ink-muted dark:ring-line"
          >
            <LockKeyhole className="h-3 w-3" />
          </span>
        )}

        {ruleOverrideLocked && (
          <span
            title="Allow rule override is OFF — FILL/action writes cannot override the global behavior. IF/LIMIT cells can still scope rules."
            aria-label="Rule override locked"
            className="shrink-0 inline-flex items-center justify-center rounded bg-amber-100 text-amber-700 p-0.5 ring-1 ring-amber-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:ring-yellow-900"
          >
            <Lock className="h-3 w-3" />
          </span>
        )}

        {/* Settings gear — same affordance as the menu's "Column
            settings" item, but reachable from the header without a
            menu round-trip. Marked data-no-drag so clicking the gear
            doesn't get hijacked into a column reorder. */}
        <button
          data-no-drag
          type="button"
          onClick={onOpenSettings}
          onMouseDown={(e) => e.stopPropagation()}
          // aria-pressed / aria-label / title now key off
          // `isInspectorOpen` (the gear's own toggle state), not
          // `isSelected` (the column highlight). They were conflated
          // when selecting auto-opened the inspector; splitting them
          // means the gear truthfully reflects whether THIS gear's
          // dialog is open.
          aria-pressed={isInspectorOpen}
          aria-label={
            isInspectorOpen
              ? `Close inspector for column ${index + 1}`
              : `Open inspector for column ${index + 1}`
          }
          title={
            isInspectorOpen ? "Close column inspector" : "Open column inspector"
          }
          className={cn(
            "shrink-0 p-0.5 rounded transition-opacity cursor-pointer",
            // Gear opacity stays driven by `isSelected || hover` so
            // the affordance remains discoverable: hovering the
            // header shows the gear, and once the column is the
            // active scan target it stays visible.
            isSelected || isInspectorOpen
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus:opacity-100",
            // Lime "active" chip ONLY paints when this gear's
            // inspector dialog is currently open — that's the
            // semantically correct moment for the on-state.
            isInspectorOpen
              ? "text-rivera-navy bg-rivera-soft-lime hover:bg-rivera-soft-lime/80 dark:bg-rivera-lime/15 dark:text-rivera-lime dark:hover:bg-rivera-lime/25"
              : "text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:text-ink-subtle dark:hover:text-ink dark:hover:bg-surface-muted",
          )}
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>

        {/* Header menu wrapper is data-no-drag so clicking the chevron
            (or the popover's items) doesn't initiate a column drag. */}
        <span data-no-drag>
          <HeaderMenu
            canInsert={!atMaxColumns}
            canRemove={total > MIN_COLUMNS}
            lockPosition={lockPosition}
            lockEditing={lockEditing}
            onRename={() => setRenaming(true)}
            onInsertLeft={onInsertLeft}
            onInsertRight={onInsertRight}
            onRemove={onRemove}
            onOpenSettings={onOpenSettings}
            onToggleLockPosition={onToggleLockPosition}
            onToggleLockEditing={onToggleLockEditing}
          />
        </span>
      </div>
      <div className="mt-0.5 ml-5 flex items-center gap-1 max-w-[18rem]">
        <span className="text-[9.5px] text-gray-400 font-mono shrink-0 dark:text-ink-subtle">
          col {index + 1}
        </span>
        {/* Rule-role chip — always shown (even for `action`, the
            default) so the user can scan the role band down each
            column without ambiguity. The same color tint shows up in
            the corresponding rule-row body cells. */}
        <span
          title={
            ruleRole
              ? `Rule role: ${RULE_ROLE_LABEL[ruleRole]}`
              : "No default rule role"
          }
          className={cn(
            "shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide",
            ruleRole
              ? HEADER_RULE_ROLE_CHIP_TONE[ruleRole]
              : HEADER_NO_RULE_ROLE_CHIP_TONE,
          )}
        >
          <RoleIcon className="h-2.5 w-2.5" />
          {ruleRole ? HEADER_RULE_ROLE_SHORT[ruleRole] : "NONE"}
        </span>
        {showSourceChip && (
          <span
            title={
              sourceIncomplete
                ? `${SOURCE_TYPE_LABEL[sourceType]} — incomplete; open the inspector to finish`
                : SOURCE_TYPE_LABEL[sourceType]
            }
            className={cn(
              "shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide",
              sourceIncomplete
                ? "bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-200"
                : "bg-gray-100 text-gray-600 dark:bg-surface-muted dark:text-ink-muted",
            )}
          >
            <SourceIcon className="h-2.5 w-2.5" />
            <span className="truncate max-w-[6.5rem]">
              {SOURCE_TYPE_LABEL[sourceType]}
            </span>
          </span>
        )}
        {col.source_column && (
          <span
            className="text-[9.5px] text-gray-400 font-mono truncate dark:text-ink-subtle"
            title={`Original upload header: ${col.source_column}`}
          >
            · from {col.source_column}
          </span>
        )}
      </div>
    </th>
  );
}

// ===========================================================================
// Trailing "+" cell (also a drop target for end-of-row reorder)
// ===========================================================================

function TrailingAddCell({
  isDropTarget,
  disabled,
  onClick,
  onDragOver,
  onDrop,
}: {
  isDropTarget: boolean;
  disabled: boolean;
  onClick: () => void;
  onDragOver: (e: DragEvent<HTMLTableCellElement>) => void;
  onDrop: () => void;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "sticky top-0 z-20 bg-gray-50 dark:bg-surface-muted",
        "border-l-2 border-l-transparent border-r border-b border-gray-200 dark:border-line",
        "px-1 py-1.5 align-middle w-[3.5rem] min-w-[3.5rem]",
        isDropTarget && "!border-l-brand-500",
      )}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={
          disabled
            ? "Maximum column count reached."
            : "Add column at the end"
        }
        aria-label="Add column"
        className={cn(
          "w-full inline-flex items-center justify-center rounded-md py-1.5 text-gray-500 dark:text-ink-muted",
          "border border-dashed border-gray-300 hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700 dark:border-line dark:hover:bg-brand-900/30 dark:hover:text-brand-50",
          "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-gray-300 disabled:hover:bg-transparent disabled:hover:text-gray-500",
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </th>
  );
}

// ===========================================================================
// Inline "+ Add rule" row — Part 5
// ===========================================================================

/**
 * One-row footer-style affordance that lives INSIDE the `<tbody>` so the
 * operator can append a new rule from the bottom of the rules list
 * without traversing past the table to the footer button. Spans the full
 * matrix width via `colSpan` rather than mirroring every column cell —
 * the row is purely an action surface, not a data row, so the
 * stripe/sticky-cell discipline doesn't apply.
 *
 * Visual contract:
 *   * Dashed top border with a centered button — visually echoes the
 *     trailing "+" column header so the two add-affordances feel like
 *     siblings.
 *   * Disabled state when the rule cap is reached: button is greyed and
 *     the button label flips to "Rule cap reached (N)" so the operator
 *     gets immediate feedback rather than a silent no-op click.
 */
function AddRuleInlineRow({
  columnCount,
  disabled,
  atCap,
  cap,
  onClick,
}: {
  columnCount: number;
  disabled: boolean;
  atCap: boolean;
  cap: number;
  onClick: () => void;
}) {
  return (
    <tr>
      <td
        // +2 covers the leading numbered/handle cell AND the trailing
        // spacer cell that aligns with the "+ column" header.
        colSpan={columnCount + 2}
        className={cn(
          "border-t border-dashed border-gray-300 bg-gray-50/40 dark:border-line dark:bg-surface-muted/40",
          "px-3 py-1.5",
        )}
      >
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={atCap ? `Rule cap reached (${cap})` : "Add rule"}
          title={
            atCap
              ? `Rule cap reached (${cap}).`
              : "Append a new rule at the bottom"
          }
          className={cn(
            "w-full inline-flex items-center justify-center gap-1.5 rounded-md py-1 text-[12px] font-medium",
            "text-gray-500 border border-dashed border-gray-300 dark:text-ink-muted dark:border-line",
            "hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-900/30 dark:hover:text-brand-50",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
            "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-gray-300 disabled:hover:bg-transparent disabled:hover:text-gray-500",
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          {atCap ? `Rule cap reached (${cap})` : "Add rule"}
        </button>
      </td>
    </tr>
  );
}

// ===========================================================================
// Header context menu
// ===========================================================================

function HeaderMenu({
  canInsert,
  canRemove,
  lockPosition,
  lockEditing,
  onRename,
  onInsertLeft,
  onInsertRight,
  onRemove,
  onOpenSettings,
  onToggleLockPosition,
  onToggleLockEditing,
}: {
  canInsert: boolean;
  canRemove: boolean;
  lockPosition: boolean;
  lockEditing: boolean;
  onRename: () => void;
  onInsertLeft: () => void;
  onInsertRight: () => void;
  onRemove: () => void;
  onOpenSettings: () => void;
  onToggleLockPosition: () => void;
  onToggleLockEditing: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Portal-anchor refs (mirror of `FieldMenu` in RuleMatrixView). The
  // header cell uses `position: sticky` AND lives inside a horizontally-
  // scrolling table-wrap, so a child-positioned `absolute` popover gets
  // clipped by every layer above it (the cell's own border, the next
  // header, the table's overflow). Rendering into document.body via a
  // portal escapes the entire stacking-context chain.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null,
  );

  // Sample the trigger's bounding rect on open so the portal mounts in
  // the right place from the very first frame.
  const recomputePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos({
      top: r.bottom + 4,
      right: window.innerWidth - r.right,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    recomputePos();
  }, [open, recomputePos]);

  useEffect(() => {
    if (!open) return;
    // Outside-click guard — must check BOTH the trigger ref and the
    // portaled menu ref because the menu DOM lives outside the
    // <th>/HeaderCell that owns the trigger. Without the menu-ref
    // check, every click on a menu item would be treated as "outside"
    // and close the menu before its onClick fires.
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Close on scroll/resize — cheap "match native <select>" behavior
    // that avoids tracking every scroll ancestor of the trigger.
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
        title="Column menu"
        aria-label="Open column menu"
        aria-expanded={open}
        className={cn(
          "p-0.5 rounded text-gray-400 transition-opacity dark:text-ink-subtle",
          "hover:text-gray-700 hover:bg-gray-100 dark:hover:text-ink dark:hover:bg-surface-muted",
          open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
        )}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {/* Portal mount — see the matching comment on `FieldMenu` in
          RuleMatrixView. Mounting into document.body lifts the popover
          out of the <th>'s stacking context so it always paints above
          neighbouring header cells, badge chips, and the body's
          stripe/role tints. */}
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
            <MenuItem
              icon={Pencil}
              onClick={() => {
                setOpen(false);
                onRename();
              }}
            >
              Rename
            </MenuItem>
            <MenuItem
              icon={Settings2}
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              Column settings
            </MenuItem>
            <div className="border-t border-gray-100 my-1 dark:border-line/60" />
            {/* Lock toggles surface inline (Part 9) so operators don't have
                to open the inspector for these high-frequency actions.
                Mirrors the inspector's "E. Locks" section with the same
                icons (Pin / LockKeyhole) for visual continuity. */}
            <MenuItem
              icon={Pin}
              onClick={() => {
                setOpen(false);
                onToggleLockPosition();
              }}
            >
              {lockPosition ? "Unlock position" : "Lock position"}
            </MenuItem>
            <MenuItem
              icon={LockKeyhole}
              onClick={() => {
                setOpen(false);
                onToggleLockEditing();
              }}
            >
              {lockEditing ? "Unlock editing" : "Lock editing"}
            </MenuItem>
            <div className="border-t border-gray-100 my-1 dark:border-line/60" />
            <MenuItem
              icon={ArrowLeftFromLine}
              disabled={!canInsert}
              onClick={() => {
                setOpen(false);
                onInsertLeft();
              }}
            >
              Insert column left
            </MenuItem>
            <MenuItem
              icon={ArrowRightFromLine}
              disabled={!canInsert}
              onClick={() => {
                setOpen(false);
                onInsertRight();
              }}
            >
              Insert column right
            </MenuItem>
            <div className="border-t border-gray-100 my-1 dark:border-line/60" />
            <MenuItem
              icon={Trash2}
              danger
              disabled={!canRemove}
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
            >
              Delete column
            </MenuItem>
          </div>,
          document.body,
        )}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  children,
  onClick,
  disabled,
  danger,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-[11.5px]",
        danger
          ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          : "text-gray-700 hover:bg-gray-50 dark:text-ink dark:hover:bg-surface-muted",
        "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {children}
    </button>
  );
}

// ===========================================================================
// Rule row — one editable rule
// ===========================================================================
//
// Layout:
//   * Sticky-left toolbar (drag handle is a future hook, row index +
//     active Switch + duplicate + delete buttons)
//   * One body cell per column, dispatched to `RuleCellEditor`
//   * Optional notes row underneath, expanded only when the row has
//     notes set or the user is editing them
//
// Inactive rules render their toolbar in a faded state and pass
// `disabled` down to every cell editor — values stay visible (so the
// operator can review what the rule will do once re-activated) but
// can't be changed without flipping the switch back on.

interface RuleRowProps {
  rule: InvoiceTemplateRule;
  ruleIndex: number;
  columns: InvoiceTemplateColumn[];
  draggedIdx: number | null;
  /**
   * Resolved drop-before index for the in-flight drag, threaded from
   * the parent so each body cell can compute its own sortable shift
   * (Part 3 of UX polish). See `computeReorderShift` for the math.
   * `null` when no drag is in flight.
   */
  dropIdx: number | null;
  /**
   * Width (px) of the dragged header cell, sampled by the parent on
   * drag start. Drives the per-body-cell `translateX` shift so every
   * cell in a sliding column moves by the same amount as its header.
   * `0` when no drag is in flight.
   */
  dragColWidth: number;
  /**
   * Id of the currently-inspected column, or null when the inspector
   * is closed. Threaded down so body cells in the inspected column can
   * carry a faint brand tint — the selected column then reads as a
   * full-height vertical band, not just a tinted header strip.
   */
  selectedColumnId: string | null;
  /**
   * Threaded down so each cell's editor can dispatch catalog source
   * kinds to the searchable picker. Same instance the inspector reads
   * — fetches deduplicate across the whole editor surface.
   */
  catalogIndex: CatalogIndex;
  onToggleActive: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onSetCell: (columnId: string, cell: InvoiceTemplateRuleCell) => void;
  onSetNotes: (notes: string) => void;
}

function RuleRow({
  rule,
  ruleIndex,
  columns,
  draggedIdx,
  dropIdx,
  dragColWidth,
  selectedColumnId,
  catalogIndex,
  onToggleActive,
  onDuplicate,
  onRemove,
  onSetCell,
  onSetNotes,
}: RuleRowProps) {
  // Notes editor is hidden by default to keep rows compact; opened on
  // demand. Uncontrolled "show editor" toggle keeps the table dense
  // until the operator actually wants to annotate.
  const [notesOpen, setNotesOpen] = useState(
    Boolean(rule.notes && rule.notes.length > 0),
  );

  const stripeClass =
    ruleIndex % 2 === 0
      ? "bg-white dark:bg-surface"
      : "bg-gray-50/40 dark:bg-surface-muted/40";
  const inactive = !rule.is_active;

  return (
    <>
      <tr className={cn(stripeClass, inactive && "opacity-60")}>
        {/* Sticky toolbar cell — same width as the corner header so
            the column boundary lines up. */}
        <th
          scope="row"
          className={cn(
            "sticky left-0 z-10 border-r border-b border-gray-200 px-1.5 py-1 align-top w-[7rem] min-w-[7rem] dark:border-line",
            stripeClass,
          )}
        >
          <div className="flex items-center gap-1">
            <span
              className="text-[10px] font-mono text-gray-400 w-5 shrink-0 text-right dark:text-ink-subtle"
              title={`Rule #${ruleIndex + 1}`}
            >
              {ruleIndex + 1}
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
            <div className="flex-1" />
            <button
              type="button"
              onClick={onDuplicate}
              title="Duplicate rule"
              aria-label={`Duplicate rule ${ruleIndex + 1}`}
              className="p-0.5 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-ink-subtle dark:hover:bg-surface-muted dark:hover:text-ink"
            >
              <Copy className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              title="Delete rule"
              aria-label={`Delete rule ${ruleIndex + 1}`}
              className="p-0.5 rounded text-gray-400 hover:bg-red-50 hover:text-red-600 dark:text-ink-subtle dark:hover:bg-red-950/40 dark:hover:text-red-400"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setNotesOpen((v) => !v)}
            className={cn(
              "mt-0.5 ml-5 text-[9.5px] uppercase tracking-wide font-semibold transition-colors",
              notesOpen || rule.notes
                ? "text-brand-700 dark:text-brand-50"
                : "text-gray-400 hover:text-gray-600 dark:text-ink-subtle dark:hover:text-ink-muted",
            )}
            aria-expanded={notesOpen}
            title={notesOpen ? "Hide notes" : "Add a note"}
          >
            {rule.notes ? "Notes ✓" : "+ Notes"}
          </button>
        </th>

        {columns.map((col, ci) => {
          // Cell may legitimately not exist yet — `addRule` seeds cells
          // for the columns present at creation time, but a column added
          // AFTER this rule has no entry. Materialise an empty cell on
          // the fly so the editor always has a stable target.
          const cell = rule.cells[col.id] ?? emptyRuleCell();
          // Body cell tint follows the EFFECTIVE per-cell role so a
          // cell that overrides the column default (e.g. column says
          // "FILL" but this cell pinned itself to "IF") paints with
          // its own band color rather than the column's. Null remains
          // neutral; it no longer falls back to legacy action.
          const ruleRole = effectiveCellRole(cell, col);
          const isSelectedColumn = selectedColumnId === col.id;
          // Sortable shift (Part 3 of UX polish) — same math the
          // header above uses, computed inline per body cell so every
          // cell in a column moves in lockstep with its header during
          // a reorder. Applied as inline transform; the className's
          // `transition-[opacity,transform]` smoothly animates the
          // shift in (and the post-drop settle back to 0).
          const cellShift = computeReorderShift(
            ci,
            draggedIdx,
            dropIdx,
            dragColWidth,
          );
          return (
            <td
              key={col.id}
              style={
                cellShift !== 0
                  ? { transform: `translateX(${cellShift}px)` }
                  : undefined
              }
              className={cn(
                "border-r border-b border-gray-200 px-2 py-1 align-top whitespace-nowrap min-w-[12rem] max-w-[20rem] dark:border-line/60",
                // Smooth transitions (Part 3) — opacity for the
                // dragged-source dim, transform for the sortable
                // "make room" slide. Both share the 150ms duration so
                // the column reads as a single coordinated unit during
                // drag.
                "transition-[opacity,transform] duration-150",
                ruleRole
                  ? BODY_RULE_ROLE_CELL_TONE[ruleRole]
                  : BODY_NO_RULE_ROLE_CELL_TONE,
                draggedIdx === ci && "opacity-40",
                // Column-wide selected highlight — paints a SOLID Soft
                // Lime fill on top of the role band so the inspected
                // column reads as a continuous filled vertical strip
                // from header through every rule row (Part 2 of UX
                // polish).
                //
                // Two notes on this exact recipe:
                //   * Solid (no `/N` opacity modifier) in light mode —
                //     a 60% Soft Lime over a white role band only
                //     produces ~#F4FFE4, indistinguishable from white;
                //     full opacity #ECFFD2 is the smallest tint that
                //     actually reads as "this column is selected".
                //   * `!` prefix is mandatory: Tailwind generates
                //     `bg-*` utilities alphabetically, so role-band
                //     tones whose color follows `rivera` (e.g.
                //     `bg-violet-50/40` for restriction rows) would
                //     otherwise win the background-color cascade and
                //     silently swallow the highlight. `!important`
                //     guarantees the selected tint paints regardless
                //     of which role band sits underneath.
                isSelectedColumn &&
                  "!bg-rivera-soft-lime dark:!bg-rivera-lime/15",
              )}
            >
              <RuleCellEditor
                column={col}
                cell={cell}
                catalogIndex={catalogIndex}
                onChange={(nextCell) => onSetCell(col.id, nextCell)}
                disabled={inactive}
              />
            </td>
          );
        })}
        {/* Spacer cell aligns with the trailing add header */}
        <td className="border-b border-gray-100 w-[3.5rem] min-w-[3.5rem]" />
      </tr>

      {notesOpen && (
        <tr className={stripeClass}>
          <td
            colSpan={columns.length + 2}
            className="border-b border-gray-100 px-3 py-1.5 dark:border-line/60"
          >
            <div className="flex items-start gap-2">
              <span className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mt-1.5 shrink-0 dark:text-ink-subtle">
                Notes
              </span>
              <input
                type="text"
                value={rule.notes ?? ""}
                onChange={(e) => onSetNotes(e.target.value)}
                placeholder="Optional annotation for this rule (e.g. why it exists, which exception it covers)…"
                maxLength={500}
                disabled={inactive}
                aria-label={`Notes for rule ${ruleIndex + 1}`}
                className={cn(
                  "flex-1 min-w-0 rounded-md border border-gray-300 bg-white px-2 py-1 text-[12px] text-gray-700 dark:border-line dark:bg-surface dark:text-ink-muted dark:placeholder:text-ink-subtle",
                  "focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500",
                  inactive && "cursor-not-allowed bg-gray-50 opacity-70",
                )}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
