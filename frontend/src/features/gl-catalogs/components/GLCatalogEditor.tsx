"use client";

import {
  BookOpen,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  type ChangeEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  DeleteCatalogFooter,
  EmptyTablePrompt,
  GridHeaderRow,
  HeaderCell,
  IsolatedTitleBar,
  type TitleBarHandle,
  SourceBadge,
  useCatalogEntries,
  useGridSearch,
  VirtualizedRowGrid,
} from "@/components/catalog-editor";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { glCatalogsApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  MAX_CATEGORY_LENGTH,
  MAX_CODE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_ENTRIES,
  MAX_NOTES_LENGTH,
  MIN_ENTRIES,
  type GLCatalogEntry,
  type GLCatalogSource,
  newEntryId,
} from "@/types/gl-catalog";

/**
 * GL Catalog editor — a row-based table where each row carries the full
 * GL entry (code / description / category / active / notes).
 *
 * Why a vertical-row table instead of the spreadsheet-style header
 * editor used for invoice templates: the GL entry is data with MULTIPLE
 * FIELDS PER ROW (code + description + category + active + notes), not
 * a single header value per column. A spreadsheet view would force the
 * user to scroll horizontally between fields of the same logical row,
 * which fights the "one chart-of-accounts entry = one row" mental
 * model. So we keep the row direction vertical and spread fields across
 * columns within each row.
 *
 * Built on the shared `@/components/catalog-editor` shell (same one
 * Properties uses) so the editor inherits row virtualization, title-bar
 * state isolation, ref-equality dirty tracking, and stable per-row
 * callbacks for free. A 5,000-row chart of accounts is responsive on
 * the same code path that keeps Properties responsive at the same
 * scale.
 *
 * Direct manipulation:
 *   * Inline `<input>` for code, description, category, notes — typing
 *     edits in place, no per-row "edit" mode.
 *   * Active toggle is a checkbox on the row.
 *   * "Add row" appends a fresh blank entry, scrolls it into view, and
 *     auto-focuses its code cell.
 *   * Each row has a trash icon at the right edge.
 *   * Search box at the top filters visible rows (matches against
 *     code / description / category / notes — case-insensitive
 *     substring).
 *   * Save / Discard / Delete buttons sit in the title bar.
 *
 * Validation is gentle: we don't block typing — instead, the save
 * button disables when a row has a blank code or description, and each
 * invalid row gets a subtle red ring around the offending cell so the
 * user knows where to look.
 */

// CSS Grid template covering: Code / Description / Category / Active /
// Notes / Actions. Sums to a comfortable min-width that leaves room
// for the description column to breathe; horizontal scroll kicks in
// only on very narrow viewports.
const GRID_TEMPLATE_COLUMNS = "7rem 1fr 10rem 5.5rem 14rem 2.5rem";
const GRID_MIN_WIDTH = "52rem";

interface InitialCatalog {
  name: string;
  description: string | null;
  entries: GLCatalogEntry[];
  source: GLCatalogSource;
}

interface GLCatalogEditorProps {
  /** Stable identity (real id, or "draft"). Changes reset local form state. */
  catalogKey: string;
  initial: InitialCatalog;
  /** True iff editing the unsaved canonical-default draft. */
  isDraft: boolean;
  saving: boolean;
  mutationError: string | null;
  onSave: (body: {
    name: string;
    description: string | null;
    entries: GLCatalogEntry[];
  }) => Promise<void>;
  /** Only present when editing a saved catalog. */
  onDelete?: () => Promise<void>;
}

const blankGLEntry = (): GLCatalogEntry => ({
  id: newEntryId(),
  code: "",
  description: "",
  category: null,
  active: true,
  notes: null,
});

const glHaystack = (e: GLCatalogEntry) =>
  `${e.code} ${e.description} ${e.category ?? ""} ${e.notes ?? ""}`;

export function GLCatalogEditor({
  catalogKey,
  initial,
  isDraft,
  saving,
  mutationError,
  onSave,
  onDelete,
}: GLCatalogEditorProps) {
  const { entries, addEntry, updateEntry, removeEntry, reset, dirty: entriesDirty } =
    useCatalogEntries<GLCatalogEntry>(initial.entries, catalogKey, {
      min: MIN_ENTRIES,
      max: MAX_ENTRIES,
      makeBlank: blankGLEntry,
    });

  const titleBarRef = useRef<TitleBarHandle>(null);
  const [resetCounter, setResetCounter] = useState(0);
  const [titleDirty, setTitleDirty] = useState(false);

  // Reset on catalog switch.
  useEffect(() => {
    setResetCounter((n) => n + 1);
    setTitleDirty(false);
    if (isDraft) {
      requestAnimationFrame(() => titleBarRef.current?.focusName());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogKey]);

  const dirty = entriesDirty || titleDirty;

  // ---- Validation ----------------------------------------------------------

  // One pass over entries computes blank-required + duplicate-code
  // sets. Runs only when entries change — title-bar keystrokes don't
  // touch entries, so this stays cached.
  const validation = useMemo(() => {
    const invalidIds = new Set<string>();
    const duplicateIds = new Set<string>();
    const codeIdsByLower = new Map<string, string[]>();
    let blankCount = 0;
    for (const e of entries) {
      const code = e.code.trim();
      const desc = e.description.trim();
      if (!code || !desc) {
        invalidIds.add(e.id);
        blankCount += 1;
      }
      if (code) {
        const k = code.toLowerCase();
        const arr = codeIdsByLower.get(k) ?? [];
        arr.push(e.id);
        codeIdsByLower.set(k, arr);
      }
    }
    Array.from(codeIdsByLower.values()).forEach((arr) => {
      if (arr.length > 1) {
        arr.forEach((id) => duplicateIds.add(id));
      }
    });
    return { invalidIds, duplicateIds, blankCount };
  }, [entries]);

  const validEntryCount =
    entries.length >= MIN_ENTRIES && entries.length <= MAX_ENTRIES;
  const hasBlankFields = validation.blankCount > 0;
  const hasDuplicateCodes = validation.duplicateIds.size > 0;

  const canSave =
    !saving &&
    !hasBlankFields &&
    !hasDuplicateCodes &&
    validEntryCount &&
    (isDraft || dirty);

  const cleanedEntries = useCallback(
    (): GLCatalogEntry[] =>
      entries.map((e) => ({
        ...e,
        code: e.code.trim(),
        description: e.description.trim(),
        category: e.category?.trim() ? e.category.trim() : null,
        notes: e.notes?.trim() ? e.notes.trim() : null,
      })),
    [entries],
  );

  const handleSave = useCallback(() => {
    if (!canSave) return;
    const tb = titleBarRef.current;
    const trimmedName = (tb?.getName() ?? "").trim();
    const description = (tb?.getDescription() ?? "").trim();
    if (trimmedName.length === 0) return;
    void onSave({
      name: trimmedName,
      description: description ? description : null,
      entries: cleanedEntries(),
    });
  }, [canSave, onSave, cleanedEntries]);

  const handleDiscard = useCallback(() => {
    reset();
    setResetCounter((n) => n + 1);
    titleBarRef.current?.reset();
    setTitleDirty(false);
  }, [reset]);

  // ---- Stats ----------------------------------------------------------------

  const activeCount = entries.filter((e) => e.active).length;
  const inactiveCount = entries.length - activeCount;

  return (
    <div className="flex flex-col h-full min-h-0">
      <IsolatedTitleBar
        ref={titleBarRef}
        initialName={initial.name}
        initialDescription={initial.description ?? ""}
        autoFocus={isDraft}
        resetCounter={resetCounter}
        onTitleDirtyChange={setTitleDirty}
        rightSlot={
          <>
            <SourceBadge source={initial.source} />
            {isDraft && (
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 bg-orange-100 text-orange-700 inline-flex items-center gap-1">
                <Sparkles className="h-3 w-3" />
                Draft
              </span>
            )}
          </>
        }
        actionsSlot={
          <>
            {!isDraft && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleDiscard}
                disabled={saving || !dirty}
              >
                <Undo2 className="h-3.5 w-3.5" />
                Discard
              </Button>
            )}
            <Button
              type="button"
              variant="primary"
              size="sm"
              loading={saving}
              disabled={!canSave}
              onClick={handleSave}
            >
              <Save className="h-3.5 w-3.5" />
              {isDraft ? "Save catalog" : "Save changes"}
            </Button>
          </>
        }
      />

      <EditorStatsLine
        entries={entries}
        activeCount={activeCount}
        inactiveCount={inactiveCount}
        blankCount={validation.blankCount}
        hasDuplicateCodes={hasDuplicateCodes}
      />

      {mutationError && (
        <div className="px-5 pt-3">
          <InlineAlert tone="error" title="Couldn't save">
            {mutationError}
          </InlineAlert>
        </div>
      )}

      <GLEditorGrid
        entries={entries}
        invalidIds={validation.invalidIds}
        duplicateIds={validation.duplicateIds}
        onAddEntry={addEntry}
        onUpdateEntry={updateEntry}
        onRemoveEntry={removeEntry}
      />

      {entries.length >= MAX_ENTRIES && (
        <p className="px-5 pb-2 text-[11px] text-yellow-700 bg-gray-50 dark:text-yellow-200 dark:bg-surface">
          Reached the {MAX_ENTRIES}-entry cap — remove rows to add more.
        </p>
      )}

      {onDelete && !isDraft && (
        <DeleteCatalogFooter
          saving={saving}
          onDelete={onDelete}
          onCheckDependencies={() => glCatalogsApi.getUsedBy(catalogKey)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats line — pure derived content, memoized on its inputs
// ---------------------------------------------------------------------------

interface EditorStatsLineProps {
  entries: GLCatalogEntry[];
  activeCount: number;
  inactiveCount: number;
  blankCount: number;
  hasDuplicateCodes: boolean;
}

const EditorStatsLine = memo(function EditorStatsLine({
  entries,
  activeCount,
  inactiveCount,
  blankCount,
  hasDuplicateCodes,
}: EditorStatsLineProps) {
  return (
    <div className="px-5 pb-2 bg-white border-b border-gray-200 flex items-center gap-3 text-[11px] text-gray-500 flex-wrap dark:bg-surface-subtle dark:border-line dark:text-ink-muted">
      <span>
        {entries.length} {entries.length === 1 ? "code" : "codes"}
      </span>
      <span className="text-gray-300 dark:text-line-strong">·</span>
      <span>{activeCount} active</span>
      {inactiveCount > 0 && (
        <>
          <span className="text-gray-300 dark:text-line-strong">·</span>
          <span>{inactiveCount} inactive</span>
        </>
      )}
      {blankCount > 0 && (
        <>
          <span className="text-gray-300 dark:text-line-strong">·</span>
          <span className="text-red-600">
            {blankCount} row(s) missing code or description
          </span>
        </>
      )}
      {hasDuplicateCodes && (
        <>
          <span className="text-gray-300 dark:text-line-strong">·</span>
          <span className="text-red-600">duplicate GL codes detected</span>
        </>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Grid — owns search + add-row focus state. Schema-specific row + header
// rendering wraps the generic VirtualizedRowGrid shell.
// ---------------------------------------------------------------------------

interface GLEditorGridProps {
  entries: GLCatalogEntry[];
  invalidIds: ReadonlySet<string>;
  duplicateIds: ReadonlySet<string>;
  onAddEntry: () => string | null;
  onUpdateEntry: (id: string, patch: Partial<GLCatalogEntry>) => void;
  onRemoveEntry: (id: string) => void;
}

function GLEditorGrid({
  entries,
  invalidIds,
  duplicateIds,
  onAddEntry,
  onUpdateEntry,
  onRemoveEntry,
}: GLEditorGridProps) {
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const codeInputRefs = useRef<Map<string, HTMLInputElement | null>>(
    new Map(),
  );

  const { search, setSearch, filtered: filteredEntries } = useGridSearch(
    entries,
    glHaystack,
  );

  // Stable per-row callback bag — same pattern as the property editor.
  const rowCallbacks = useMemo(() => {
    const map = new Map<
      string,
      {
        onChange: (patch: Partial<GLCatalogEntry>) => void;
        onRemove: () => void;
        codeInputRef: (el: HTMLInputElement | null) => void;
      }
    >();
    for (const entry of filteredEntries) {
      const id = entry.id;
      map.set(id, {
        onChange: (patch) => onUpdateEntry(id, patch),
        onRemove: () => onRemoveEntry(id),
        codeInputRef: (el) => {
          if (el === null) {
            codeInputRefs.current.delete(id);
          } else {
            codeInputRefs.current.set(id, el);
          }
        },
      });
    }
    return map;
  }, [filteredEntries, onUpdateEntry, onRemoveEntry]);

  const handleAdd = useCallback(() => {
    const id = onAddEntry();
    if (!id) return;
    setSearch("");
    setPendingFocusId(id);
  }, [onAddEntry, setSearch]);

  const renderRow = useCallback(
    (entry: GLCatalogEntry) => {
      const cb = rowCallbacks.get(entry.id)!;
      return (
        <EntryRow
          entry={entry}
          invalid={invalidIds.has(entry.id)}
          duplicate={duplicateIds.has(entry.id)}
          onChange={cb.onChange}
          onRemove={cb.onRemove}
          codeInputRef={cb.codeInputRef}
        />
      );
    },
    [rowCallbacks, invalidIds, duplicateIds],
  );

  const resolveFocusTarget = useCallback(
    (id: string) => codeInputRefs.current.get(id) ?? null,
    [],
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-gray-50 dark:bg-surface">
      <div className="px-5 pt-3 pb-2 flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 dark:text-ink-subtle" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search rows…"
            className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-line dark:bg-surface-subtle dark:text-ink dark:placeholder:text-ink-subtle"
          />
        </div>
        {search && (
          <span className="text-[11px] text-gray-500 dark:text-ink-muted">
            {filteredEntries.length} of {entries.length} match
          </span>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="ml-auto"
          disabled={entries.length >= MAX_ENTRIES}
          onClick={handleAdd}
        >
          <Plus className="h-3.5 w-3.5" />
          Add row
        </Button>
      </div>

      <div className="flex-1 min-h-0 px-5 pb-5">
        <div className="bg-white rounded-md border border-gray-200 h-full flex flex-col overflow-hidden dark:bg-surface-subtle dark:border-line">
          <VirtualizedRowGrid<GLCatalogEntry>
            entries={filteredEntries}
            getKey={(e) => e.id}
            minWidth={GRID_MIN_WIDTH}
            header={
              <GridHeaderRow gridTemplateColumns={GRID_TEMPLATE_COLUMNS}>
                <HeaderCell>GL code</HeaderCell>
                <HeaderCell>Description</HeaderCell>
                <HeaderCell>Category</HeaderCell>
                <HeaderCell>Active</HeaderCell>
                <HeaderCell>Notes</HeaderCell>
                <HeaderCell aria-label="Actions">{""}</HeaderCell>
              </GridHeaderRow>
            }
            renderRow={renderRow}
            emptyState={
              search ? (
                <p className="text-xs text-gray-500 dark:text-ink-muted">
                  No rows match {`"${search}"`}.{" "}
                  <button
                    type="button"
                    className="text-brand-700 underline dark:text-brand-50"
                    onClick={() => setSearch("")}
                  >
                    Clear search
                  </button>
                </p>
              ) : (
                <EmptyTablePrompt
                  icon={BookOpen}
                  title="No GL codes yet"
                  body="Add a row to start your chart of accounts. Each row carries a GL code, a description, an optional category, and an active/inactive flag."
                  onAdd={handleAdd}
                />
              )
            }
            pendingFocusId={pendingFocusId}
            resolveFocusTarget={resolveFocusTarget}
            onPendingFocusHandled={() => setPendingFocusId(null)}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single editable row. Memoized so an unchanged row skips re-render
// when the grid re-renders.
// ---------------------------------------------------------------------------

interface EntryRowProps {
  entry: GLCatalogEntry;
  invalid: boolean;
  duplicate: boolean;
  codeInputRef: (el: HTMLInputElement | null) => void;
  onChange: (patch: Partial<GLCatalogEntry>) => void;
  onRemove: () => void;
}

const EntryRow = memo(function EntryRow({
  entry,
  invalid,
  duplicate,
  codeInputRef,
  onChange,
  onRemove,
}: EntryRowProps) {
  const codeBlank = entry.code.trim().length === 0;
  const descBlank = entry.description.trim().length === 0;

  const cellClasses = (highlight: boolean) =>
    cn(
      "w-full bg-transparent px-1.5 py-1 rounded text-[12.5px] text-gray-800 dark:text-ink focus:outline-none focus:ring-2 focus:ring-brand-400 placeholder:text-gray-400 dark:placeholder:text-ink-subtle",
      highlight &&
        "ring-1 ring-red-300 bg-red-50/40 dark:ring-red-900 dark:bg-red-950/40",
      !entry.active && "text-gray-400 dark:text-ink-subtle",
    );

  return (
    <div
      className={cn(
        "transition-colors border-b border-gray-100 dark:border-line/60",
        invalid || duplicate
          ? "bg-red-50/30 dark:bg-red-950/30"
          : "hover:bg-brand-50/30 dark:hover:bg-brand-900/20",
        !entry.active && "bg-gray-50/40 dark:bg-surface-muted/40",
      )}
      style={{
        display: "grid",
        gridTemplateColumns: GRID_TEMPLATE_COLUMNS,
        alignItems: "start",
      }}
    >
      <div className="px-2.5 py-1.5">
        <input
          ref={codeInputRef}
          type="text"
          value={entry.code}
          maxLength={MAX_CODE_LENGTH}
          placeholder="e.g. 5100"
          onChange={(e) => onChange({ code: e.target.value })}
          className={cellClasses(codeBlank || duplicate)}
        />
        {duplicate && !codeBlank && (
          <p className="text-[10px] text-red-600 dark:text-red-400 mt-0.5 px-1.5">
            Duplicate code
          </p>
        )}
      </div>
      <div className="px-2.5 py-1.5">
        <input
          type="text"
          value={entry.description}
          maxLength={MAX_DESCRIPTION_LENGTH}
          placeholder="e.g. Repairs & Maintenance"
          onChange={(e) => onChange({ description: e.target.value })}
          className={cellClasses(descBlank)}
        />
      </div>
      <div className="px-2.5 py-1.5">
        <input
          type="text"
          value={entry.category ?? ""}
          maxLength={MAX_CATEGORY_LENGTH}
          placeholder="Optional"
          onChange={(e) =>
            onChange({ category: e.target.value ? e.target.value : null })
          }
          className={cellClasses(false)}
        />
      </div>
      <div className="px-2.5 py-1.5">
        <ActiveToggle
          active={entry.active}
          onChange={(active) => onChange({ active })}
        />
      </div>
      <div className="px-2.5 py-1.5">
        <input
          type="text"
          value={entry.notes ?? ""}
          maxLength={MAX_NOTES_LENGTH}
          placeholder="Optional"
          onChange={(e) =>
            onChange({ notes: e.target.value ? e.target.value : null })
          }
          className={cellClasses(false)}
        />
      </div>
      <div className="px-1 py-1.5 text-right">
        <button
          type="button"
          aria-label="Delete row"
          title="Delete this row"
          onClick={onRemove}
          className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 dark:text-ink-subtle dark:hover:text-red-400 dark:hover:bg-red-950/40"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
});

// Compact pill-style toggle for the active column. Bigger + clearer
// than a raw checkbox without taking the cell over visually.
function ActiveToggle({
  active,
  onChange,
}: {
  active: boolean;
  onChange: (next: boolean) => void;
}) {
  const handle = (e: ChangeEvent<HTMLInputElement>) =>
    onChange(e.target.checked);
  return (
    <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={active}
        onChange={handle}
        className="h-3.5 w-3.5 rounded border-gray-300 text-brand-600 focus:ring-brand-500 dark:border-line dark:bg-surface"
      />
      <span
        className={cn(
          "text-[11px] font-medium",
          active
            ? "text-gray-700 dark:text-ink"
            : "text-gray-400 dark:text-ink-subtle",
        )}
      >
        {active ? "Active" : "Inactive"}
      </span>
    </label>
  );
}
