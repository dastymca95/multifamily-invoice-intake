"use client";

import {
  ArrowLeftFromLine,
  ArrowRightFromLine,
  ChevronDown,
  FileSpreadsheet,
  GripVertical,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { cn } from "@/lib/utils";
import {
  MAX_COLUMNS,
  MAX_COLUMN_NAME_LENGTH,
  MIN_COLUMNS,
  type InvoiceTemplateColumn,
  type InvoiceTemplateSource,
  newColumnId,
} from "@/types/invoice-template";

/**
 * Spreadsheet-first invoice template editor.
 *
 * The table itself is the editing surface. Top of the pane is a
 * compact toolbar (name + description + save / discard / delete);
 * everything below is the spreadsheet, which dominates the viewport.
 *
 * Direct manipulation:
 *
 *   * Header rename — each header cell is an inline `<input>`. Clicking
 *     puts focus in the input; typing edits the column name. Enter
 *     blurs. There is no separate vertical "rename" panel.
 *
 *   * Drag-and-drop reorder — every header has a visible grip handle
 *     (`GripVertical`) on its left. The handle is the HTML5 drag
 *     source; the header cell is the drop target. As the user drags,
 *     a 2px brand-colored insertion indicator appears on the left
 *     border of the header that the cursor's hovering nearer to (or
 *     on the trailing "+" cell when dropping at the end). The
 *     dragged column dims to 40% opacity for live feedback. Drop
 *     splices the column into the new position.
 *
 *   * Add column — a "+" `<th>` sits at the right end of the header
 *     row. Clicking it appends a new column and auto-focuses its
 *     header input. Each column's contextual menu also offers
 *     "Insert column left/right".
 *
 *   * Remove column — each header has a contextual `…` menu (visible
 *     on hover or when open) with "Delete column". Disabled when only
 *     one column remains (MIN_COLUMNS=1).
 *
 *   * Horizontal scroll — the spreadsheet sits in a single
 *     `overflow-auto` container with a real scrollbar. The header row
 *     is `sticky top-0`; the first body column (row index) is
 *     `sticky left-0`. The corner cell stacks above both.
 *
 * Form state is local; the editor seeds itself from `initial` and
 * resets whenever `templateKey` changes (selecting a different
 * template, or flipping between draft and a real row). Save sends
 * the full triple (name + description + columns) up to the parent,
 * which decides whether to call create or update.
 */

interface InitialTemplate {
  name: string;
  description: string | null;
  columns: InvoiceTemplateColumn[];
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
  onSave: (body: {
    name: string;
    description: string | null;
    columns: InvoiceTemplateColumn[];
  }) => Promise<void>;
  /** Only present when editing a saved template. */
  onDelete?: () => Promise<void>;
}

const SOURCE_BADGE: Record<
  InvoiceTemplateSource,
  { label: string; tone: string }
> = {
  default: { label: "Default", tone: "bg-blue-50 text-blue-700" },
  blank: { label: "Blank", tone: "bg-gray-100 text-gray-700" },
  from_upload: {
    label: "From upload",
    tone: "bg-purple-50 text-purple-700",
  },
  custom: { label: "Custom", tone: "bg-brand-50 text-brand-700" },
};

const PREVIEW_ROW_COUNT = 12;

export function TemplateEditor({
  templateKey,
  initial,
  isDraft,
  saving,
  mutationError,
  onSave,
  onDelete,
}: TemplateEditorProps) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [columns, setColumns] = useState<InvoiceTemplateColumn[]>(
    initial.columns,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Reset on template switch.
  useEffect(() => {
    setName(initial.name);
    setDescription(initial.description ?? "");
    setColumns(initial.columns);
    setConfirmingDelete(false);
    setDraggedIdx(null);
    setDropIdx(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateKey]);

  // ---- Dirty / save gates --------------------------------------------------

  const dirty = useMemo(() => {
    if (name.trim() !== initial.name) return true;
    if ((description.trim() || null) !== (initial.description ?? null))
      return true;
    if (JSON.stringify(columns) !== JSON.stringify(initial.columns))
      return true;
    return false;
  }, [name, description, columns, initial]);

  const trimmedColumnNames = columns.map((c) => c.name.trim());
  const hasEmptyColumnName = trimmedColumnNames.some((n) => n.length === 0);
  const validColumnCount =
    columns.length >= MIN_COLUMNS && columns.length <= MAX_COLUMNS;
  const canSave =
    !saving &&
    name.trim().length > 0 &&
    !hasEmptyColumnName &&
    validColumnCount &&
    (isDraft || dirty);

  const handleSave = () => {
    if (!canSave) return;
    void onSave({
      name: name.trim(),
      description: description.trim() ? description.trim() : null,
      columns: columns.map((c, i) => ({ ...c, name: trimmedColumnNames[i] })),
    });
  };

  const handleDiscard = () => {
    setName(initial.name);
    setDescription(initial.description ?? "");
    setColumns(initial.columns);
  };

  // ---- Header input refs (for focus-after-add and "Rename" menu action) ----

  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingFocusId) return;
    const el = inputRefs.current[pendingFocusId];
    if (el) {
      el.focus();
      el.select();
      // Make sure the new column is in view after horizontal-scrolling
      // the table — useful when adding to the far right.
      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      setPendingFocusId(null);
    }
  }, [pendingFocusId, columns]);

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
  }, []);

  /** Insert a fresh column at the given absolute position (0..length). */
  const insertColumnAt = useCallback((position: number) => {
    const newCol: InvoiceTemplateColumn = {
      id: newColumnId(),
      name: "New column",
      source_column: null,
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

  // ---- Drag-and-drop reorder ----------------------------------------------
  // HTML5 native drag/drop, no extra dependency. Drag source = the
  // grip handle in each header. Drop target = the header cell (and the
  // trailing "+" cell for end-of-row drops). Insertion indicator is a
  // 2px brand-colored left border on the target header.

  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const onHandleDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>, index: number) => {
      setDraggedIdx(index);
      setDropIdx(index);
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

  const finishDrop = useCallback(() => {
    if (draggedIdx == null || dropIdx == null) {
      setDraggedIdx(null);
      setDropIdx(null);
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
    setDraggedIdx(null);
    setDropIdx(null);
  }, [draggedIdx, dropIdx]);

  const onAnyDragEnd = useCallback(() => {
    setDraggedIdx(null);
    setDropIdx(null);
  }, []);

  // ---- Render --------------------------------------------------------------

  const sourceBadge = SOURCE_BADGE[initial.source];
  const atMaxColumns = columns.length >= MAX_COLUMNS;
  const canDelete = !isDraft && Boolean(onDelete);

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
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ------------------ Compact toolbar (name + actions) ------------------ */}
      <header className="border-b bg-white shrink-0">
        <div className="flex items-center gap-2 px-4 pt-3">
          <FileSpreadsheet className="h-4 w-4 text-brand-700 shrink-0" />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Untitled template"
            maxLength={255}
            aria-label="Template name"
            className={cn(
              "flex-1 max-w-md min-w-0 text-[14px] font-semibold text-gray-800",
              "bg-transparent rounded-md px-2 py-1 outline-none",
              "hover:bg-gray-50 focus:bg-white focus:ring-2 focus:ring-brand-500",
              name.trim().length === 0 && "ring-1 ring-red-300",
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
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-orange-50 text-orange-700 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              <Sparkles className="h-2.5 w-2.5" />
              Unsaved
            </span>
          )}
          {dirty && !isDraft && (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-orange-600">
              Unsaved changes
            </span>
          )}
          <span className="shrink-0 text-[10.5px] text-gray-400">
            {columns.length} / {MAX_COLUMNS} cols
          </span>
          <div className="flex-1" />
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
              onClick={() => setConfirmingDelete(true)}
              title="Delete this template"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        <div className="px-4 pt-1 pb-2 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold shrink-0">
            About
          </span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe this template (optional)"
            aria-label="Template description"
            className="flex-1 min-w-0 text-[11.5px] text-gray-600 bg-transparent rounded-md px-2 py-1 outline-none hover:bg-gray-50 focus:bg-white focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {(mutationError || hasEmptyColumnName || name.trim().length === 0) && (
          <div className="px-4 pb-2 space-y-1.5">
            {mutationError && (
              <InlineAlert tone="error">{mutationError}</InlineAlert>
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
          <div className="mx-4 mb-3 rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2.5 text-[11.5px] text-yellow-900 space-y-1.5">
            <p className="font-semibold">Delete this template?</p>
            <p className="text-yellow-900/80">
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

      {/* ------------------------ Spreadsheet workspace ----------------------- */}
      <div className="flex-1 min-h-0 overflow-hidden p-4 bg-gray-50">
        <div className="h-full rounded-lg border border-gray-200 bg-white shadow-sm flex flex-col min-h-0">
          {/* Help strip — quick reminder of what the table supports. */}
          <div className="border-b bg-gray-50/60 px-3 py-1.5 text-[10.5px] text-gray-500 flex items-center gap-3 flex-wrap shrink-0">
            <span className="inline-flex items-center gap-1">
              <GripVertical className="h-3 w-3 text-gray-400" />
              Drag a header to reorder
            </span>
            <span className="text-gray-300">·</span>
            <span className="inline-flex items-center gap-1">
              <Pencil className="h-3 w-3 text-gray-400" />
              Click a header to rename
            </span>
            <span className="text-gray-300">·</span>
            <span className="inline-flex items-center gap-1">
              <ChevronDown className="h-3 w-3 text-gray-400" />
              Header menu for insert / delete
            </span>
            <span className="text-gray-300">·</span>
            <span className="inline-flex items-center gap-1">
              <Plus className="h-3 w-3 text-gray-400" />
              Use the trailing cell to add a column
            </span>
          </div>

          {/* Scroll surface — single source of horizontal scroll. */}
          <div className="flex-1 min-h-0 overflow-auto">
            <table className="border-collapse text-[12px] w-max">
              <thead>
                <tr>
                  {/* Sticky-top + sticky-left corner */}
                  <th
                    className="sticky top-0 left-0 z-30 bg-gray-100 border-r border-b border-gray-200 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wide w-[3rem] min-w-[3rem]"
                    aria-label="Row index"
                  >
                    #
                  </th>

                  {columns.map((col, i) => (
                    <HeaderCell
                      key={col.id}
                      col={col}
                      index={i}
                      total={columns.length}
                      atMaxColumns={atMaxColumns}
                      isDragged={draggedIdx === i}
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
                      registerInputRef={(el) => {
                        inputRefs.current[col.id] = el;
                      }}
                      onChangeName={(value) =>
                        updateColumn(col.id, { name: value })
                      }
                      onRename={() => setPendingFocusId(col.id)}
                      onInsertLeft={() => insertColumnAt(i)}
                      onInsertRight={() => insertColumnAt(i + 1)}
                      onRemove={() => removeColumn(col.id)}
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
                      className="px-3 py-6 text-center text-[11.5px] text-gray-500 italic"
                    >
                      Add a column with the &quot;+&quot; cell at the right
                      to get started.
                    </td>
                  </tr>
                ) : (
                  Array.from({ length: PREVIEW_ROW_COUNT }).map((_, ri) => {
                    const stripeClass =
                      ri % 2 === 0 ? "bg-white" : "bg-gray-50/40";
                    return (
                      <tr key={ri} className={stripeClass}>
                        <th
                          scope="row"
                          className={cn(
                            "sticky left-0 z-10 border-r border-b border-gray-200 px-2 py-1 text-left align-middle text-[10px] font-mono text-gray-400 w-[3rem] min-w-[3rem]",
                            stripeClass,
                          )}
                        >
                          {ri + 1}
                        </th>
                        {columns.map((col, ci) => (
                          <td
                            key={col.id}
                            className={cn(
                              "border-r border-b border-gray-200 px-3 py-1 text-gray-300 italic whitespace-nowrap min-w-[12rem] max-w-[20rem]",
                              draggedIdx === ci && "opacity-40",
                            )}
                          >
                            —
                          </td>
                        ))}
                        {/* Spacer cell aligns with the trailing add header */}
                        <td className="border-b border-gray-100 w-[3.5rem] min-w-[3.5rem]" />
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Footer caption — rules + tips */}
          <div className="border-t bg-gray-50/60 px-3 py-1.5 text-[10.5px] text-gray-500 flex items-center justify-between gap-3 shrink-0">
            <span>
              {columns.length} column{columns.length === 1 ? "" : "s"} ·{" "}
              minimum {MIN_COLUMNS}, maximum {MAX_COLUMNS}.
            </span>
            <span className="text-gray-400">
              Placeholder rows are illustrative — invoice data renders
              into this shape on export.
            </span>
          </div>
        </div>
      </div>
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
  isDropBefore: boolean;
  isDropAfterLast: boolean;
  registerInputRef: (el: HTMLInputElement | null) => void;
  onChangeName: (value: string) => void;
  onRename: () => void;
  onInsertLeft: () => void;
  onInsertRight: () => void;
  onRemove: () => void;
  onHandleDragStart: (e: DragEvent<HTMLDivElement>) => void;
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
  isDropBefore,
  isDropAfterLast,
  registerInputRef,
  onChangeName,
  onRename,
  onInsertLeft,
  onInsertRight,
  onRemove,
  onHandleDragStart,
  onHeaderDragOver,
  onDrop,
  onDragEnd,
}: HeaderCellProps) {
  const empty = col.name.trim().length === 0;

  return (
    <th
      scope="col"
      className={cn(
        "group sticky top-0 z-20 bg-gray-50",
        // Stable 2px transparent borders so the drop indicator doesn't
        // shift cell widths when it appears.
        "border-l-2 border-l-transparent border-r border-b border-gray-200",
        "px-2 py-1.5 text-left align-top whitespace-nowrap",
        "min-w-[12rem] max-w-[20rem]",
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
        {/* Drag handle — the only draggable element inside the header.
            Keeps text editing inside the input click-to-focus. */}
        <div
          draggable
          onDragStart={onHandleDragStart}
          onDragEnd={onDragEnd}
          className="shrink-0 -ml-1 px-0.5 py-1 rounded text-gray-300 hover:text-gray-600 hover:bg-gray-100 cursor-grab active:cursor-grabbing"
          title="Drag to reorder"
          aria-label={`Drag column ${index + 1} to reorder`}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </div>

        <input
          ref={registerInputRef}
          type="text"
          value={col.name}
          onChange={(e) => onChangeName(e.target.value)}
          maxLength={MAX_COLUMN_NAME_LENGTH}
          placeholder="Untitled column"
          aria-label={`Header for column ${index + 1}`}
          // Stop the event from triggering parent drag attempts in
          // browsers that bubble mousedown into draggable ancestors.
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          className={cn(
            "flex-1 min-w-0 px-1.5 py-1 text-[12.5px] font-semibold text-gray-800",
            "bg-transparent rounded outline-none",
            "hover:bg-white focus:bg-white focus:ring-2 focus:ring-brand-500",
            empty && "ring-1 ring-red-300 placeholder:text-red-400",
          )}
        />

        <HeaderMenu
          canInsert={!atMaxColumns}
          canRemove={total > MIN_COLUMNS}
          onRename={onRename}
          onInsertLeft={onInsertLeft}
          onInsertRight={onInsertRight}
          onRemove={onRemove}
        />
      </div>
      <p className="text-[9.5px] text-gray-400 font-mono mt-0.5 ml-5 truncate max-w-[18rem]">
        col {index + 1}
        {col.source_column && (
          <>
            <span className="mx-1 text-gray-300">·</span>
            from {col.source_column}
          </>
        )}
      </p>
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
        "sticky top-0 z-20 bg-gray-50",
        "border-l-2 border-l-transparent border-r border-b border-gray-200",
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
          "w-full inline-flex items-center justify-center rounded-md py-1.5 text-gray-500",
          "border border-dashed border-gray-300 hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700",
          "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-gray-300 disabled:hover:bg-transparent disabled:hover:text-gray-500",
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </th>
  );
}

// ===========================================================================
// Header context menu
// ===========================================================================

function HeaderMenu({
  canInsert,
  canRemove,
  onRename,
  onInsertLeft,
  onInsertRight,
  onRemove,
}: {
  canInsert: boolean;
  canRemove: boolean;
  onRename: () => void;
  onInsertLeft: () => void;
  onInsertRight: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Column menu"
        aria-label="Open column menu"
        aria-expanded={open}
        className={cn(
          "p-0.5 rounded text-gray-400 transition-opacity",
          "hover:text-gray-700 hover:bg-gray-100",
          open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
        )}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-0.5 z-40 min-w-[11rem] rounded-md border border-gray-200 bg-white shadow-lg py-1"
          role="menu"
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
          <div className="border-t border-gray-100 my-1" />
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
        </div>
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
          ? "text-red-600 hover:bg-red-50"
          : "text-gray-700 hover:bg-gray-50",
        "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {children}
    </button>
  );
}
