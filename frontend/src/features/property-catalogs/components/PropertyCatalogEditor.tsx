"use client";

import {
  Building2,
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
import { cn } from "@/lib/utils";
import {
  MAX_ABBR_LENGTH,
  MAX_ADDRESS_LENGTH,
  MAX_BUILDING_LENGTH,
  MAX_CITY_LENGTH,
  MAX_CODE_LENGTH,
  MAX_ENTRIES,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_STATE_LENGTH,
  MAX_UNIT_NUMBER_LENGTH,
  MAX_UNIT_TYPE_LENGTH,
  MAX_ZIP_LENGTH,
  MIN_ENTRIES,
  type PropertyCatalogEntry,
  type PropertyCatalogSource,
  newEntryId,
} from "@/types/property-catalog";

/**
 * Property Catalog editor — a row-based grid where each row carries the
 * full property/unit entry (12 fields).
 *
 * Same vertical-row table feel as `GLCatalogEditor` so the two builder
 * pages share the editing rhythm. Both editors are built on the shared
 * `@/components/catalog-editor` shell so the performance work done here
 * (state isolation + virtualization + memoized rows + ref-equality
 * dirty check) is reused without copy-paste.
 *
 * Direct manipulation:
 *   * Inline `<input>` per editable cell — typing edits in place, no
 *     per-row "edit" mode.
 *   * Active toggle is a checkbox-with-label on the row.
 *   * "Add row" appends a fresh blank entry, scrolls it into view, and
 *     auto-focuses its property_code cell (the grid handles the
 *     scroll-and-focus retry loop internally).
 *   * Each row has a trash icon at the right edge.
 *   * Search box filters visible rows (matches against any string field
 *     — case-insensitive substring).
 *   * Save / Discard / Delete buttons sit in the title bar's actions
 *     slot.
 *
 * Validation:
 *   * `property_name` and `property_code` are required per row — the
 *     save button stays disabled while any row has either field blank.
 *   * `(property_code, unit_number || "")` pairs must be unique within
 *     the catalog — the same property_code can have many units, but a
 *     property+unit combo can't repeat. Matches the backend's
 *     `_validate_entry_invariants`.
 *
 * The editor never blocks typing — it just disables save and rings the
 * offending cells.
 */

// CSS Grid template that sums to >= 78rem so the grid keeps the same
// minimum width / column proportions the old <table> had. The 13
// columns mirror Code / Name / Abbr / Address / City / State / ZIP /
// Unit / Type / Building / Active / Notes / Actions in that order.
const GRID_TEMPLATE_COLUMNS =
  "6.5rem 12rem 5rem 12rem 8rem 4.5rem 5rem 5.5rem 6rem 6rem 5.5rem 10rem 2.5rem";

interface InitialCatalog {
  name: string;
  description: string | null;
  entries: PropertyCatalogEntry[];
  source: PropertyCatalogSource;
}

interface PropertyCatalogEditorProps {
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
    entries: PropertyCatalogEntry[];
  }) => Promise<void>;
  /** Only present when editing a saved catalog. */
  onDelete?: () => Promise<void>;
}

const blankPropertyEntry = (): PropertyCatalogEntry => ({
  id: newEntryId(),
  property_name: "",
  property_code: "",
  property_abbreviation: null,
  address: null,
  city: null,
  state: null,
  zip: null,
  unit_number: null,
  unit_type: null,
  building: null,
  active: true,
  notes: null,
});

const propertyHaystack = (e: PropertyCatalogEntry) =>
  `${e.property_code} ${e.property_name} ${e.property_abbreviation ?? ""} ` +
  `${e.address ?? ""} ${e.city ?? ""} ${e.state ?? ""} ${e.zip ?? ""} ` +
  `${e.unit_number ?? ""} ${e.unit_type ?? ""} ${e.building ?? ""} ` +
  `${e.notes ?? ""}`;

export function PropertyCatalogEditor({
  catalogKey,
  initial,
  isDraft,
  saving,
  mutationError,
  onSave,
  onDelete,
}: PropertyCatalogEditorProps) {
  const { entries, addEntry, updateEntry, removeEntry, reset, dirty: entriesDirty } =
    useCatalogEntries<PropertyCatalogEntry>(initial.entries, catalogKey, {
      min: MIN_ENTRIES,
      max: MAX_ENTRIES,
      makeBlank: blankPropertyEntry,
    });

  const titleBarRef = useRef<TitleBarHandle>(null);
  const [resetCounter, setResetCounter] = useState(0);
  const [titleDirty, setTitleDirty] = useState(false);

  // Reset on catalog switch — useCatalogEntries re-seeds entries; we
  // bump resetCounter so the title bar re-seeds, and re-mark non-dirty.
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
  // One pass over entries computes blank-required + dup-pair sets.
  // Memoized on entries so the title bar's keystrokes (which don't
  // touch entries) don't re-run it.
  const validation = useMemo(() => {
    const invalidIds = new Set<string>();
    const duplicateIds = new Set<string>();
    const idsByPair = new Map<string, string[]>();
    let blankCount = 0;
    for (const e of entries) {
      const code = e.property_code.trim();
      const namev = e.property_name.trim();
      if (!code || !namev) {
        invalidIds.add(e.id);
        blankCount += 1;
      }
      if (code) {
        const unit = (e.unit_number || "").trim().toLowerCase();
        const k = `${code.toLowerCase()}::${unit}`;
        const arr = idsByPair.get(k) ?? [];
        arr.push(e.id);
        idsByPair.set(k, arr);
      }
    }
    Array.from(idsByPair.values()).forEach((arr) => {
      if (arr.length > 1) {
        arr.forEach((id) => duplicateIds.add(id));
      }
    });
    return { invalidIds, duplicateIds, blankCount };
  }, [entries]);

  const validEntryCount =
    entries.length >= MIN_ENTRIES && entries.length <= MAX_ENTRIES;
  const hasBlankFields = validation.blankCount > 0;
  const hasDuplicatePairs = validation.duplicateIds.size > 0;

  const canSave =
    !saving &&
    !hasBlankFields &&
    !hasDuplicatePairs &&
    validEntryCount &&
    (isDraft || dirty);

  /** Trim every editable string and collapse blanks → null on optionals. */
  const cleanedEntries = useCallback(
    (): PropertyCatalogEntry[] =>
      entries.map((e) => ({
        ...e,
        property_name: e.property_name.trim(),
        property_code: e.property_code.trim(),
        property_abbreviation: e.property_abbreviation?.trim()
          ? e.property_abbreviation.trim()
          : null,
        address: e.address?.trim() ? e.address.trim() : null,
        city: e.city?.trim() ? e.city.trim() : null,
        state: e.state?.trim() ? e.state.trim() : null,
        zip: e.zip?.trim() ? e.zip.trim() : null,
        unit_number: e.unit_number?.trim() ? e.unit_number.trim() : null,
        unit_type: e.unit_type?.trim() ? e.unit_type.trim() : null,
        building: e.building?.trim() ? e.building.trim() : null,
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
  const unitRowCount = entries.filter(
    (e) => e.unit_number && e.unit_number.trim(),
  ).length;
  const propertyRowCount = entries.length - unitRowCount;

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
        unitRowCount={unitRowCount}
        propertyRowCount={propertyRowCount}
        blankCount={validation.blankCount}
        hasDuplicatePairs={hasDuplicatePairs}
      />

      {mutationError && (
        <div className="px-5 pt-3">
          <InlineAlert tone="error" title="Couldn't save">
            {mutationError}
          </InlineAlert>
        </div>
      )}

      <PropertyEditorGrid
        entries={entries}
        invalidIds={validation.invalidIds}
        duplicateIds={validation.duplicateIds}
        onAddEntry={addEntry}
        onUpdateEntry={updateEntry}
        onRemoveEntry={removeEntry}
      />

      {entries.length >= MAX_ENTRIES && (
        <p className="px-5 pb-2 text-[11px] text-yellow-700 bg-gray-50">
          Reached the {MAX_ENTRIES}-entry cap — remove rows to add more.
        </p>
      )}

      {onDelete && !isDraft && (
        <DeleteCatalogFooter saving={saving} onDelete={onDelete} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats line — pure derived content, memoized on its inputs
// ---------------------------------------------------------------------------

interface EditorStatsLineProps {
  entries: PropertyCatalogEntry[];
  activeCount: number;
  inactiveCount: number;
  unitRowCount: number;
  propertyRowCount: number;
  blankCount: number;
  hasDuplicatePairs: boolean;
}

const EditorStatsLine = memo(function EditorStatsLine({
  entries,
  activeCount,
  inactiveCount,
  unitRowCount,
  propertyRowCount,
  blankCount,
  hasDuplicatePairs,
}: EditorStatsLineProps) {
  return (
    <div className="px-5 pb-2 bg-white border-b flex items-center gap-3 text-[11px] text-gray-500 flex-wrap">
      <span>
        {entries.length} {entries.length === 1 ? "row" : "rows"}
      </span>
      <span className="text-gray-300">·</span>
      <span>
        {unitRowCount} unit row{unitRowCount === 1 ? "" : "s"}
      </span>
      {propertyRowCount > 0 && (
        <>
          <span className="text-gray-300">·</span>
          <span>
            {propertyRowCount} property-level row
            {propertyRowCount === 1 ? "" : "s"}
          </span>
        </>
      )}
      <span className="text-gray-300">·</span>
      <span>{activeCount} active</span>
      {inactiveCount > 0 && (
        <>
          <span className="text-gray-300">·</span>
          <span>{inactiveCount} inactive</span>
        </>
      )}
      {blankCount > 0 && (
        <>
          <span className="text-gray-300">·</span>
          <span className="text-red-600">
            {blankCount} row(s) missing property name or code
          </span>
        </>
      )}
      {hasDuplicatePairs && (
        <>
          <span className="text-gray-300">·</span>
          <span className="text-red-600">
            duplicate property + unit pairs detected
          </span>
        </>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Grid — owns search + add-row focus state. Schema-specific row + header
// rendering wraps the generic VirtualizedRowGrid shell.
// ---------------------------------------------------------------------------

interface PropertyEditorGridProps {
  entries: PropertyCatalogEntry[];
  invalidIds: ReadonlySet<string>;
  duplicateIds: ReadonlySet<string>;
  onAddEntry: () => string | null;
  onUpdateEntry: (id: string, patch: Partial<PropertyCatalogEntry>) => void;
  onRemoveEntry: (id: string) => void;
}

function PropertyEditorGrid({
  entries,
  invalidIds,
  duplicateIds,
  onAddEntry,
  onUpdateEntry,
  onRemoveEntry,
}: PropertyEditorGridProps) {
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const codeInputRefs = useRef<Map<string, HTMLInputElement | null>>(
    new Map(),
  );

  const { search, setSearch, filtered: filteredEntries } = useGridSearch(
    entries,
    propertyHaystack,
  );

  // Stable per-row callback bag. We build a Map keyed by entry id ONCE
  // per (filteredEntries, handlers) change so memoized EntryRow sees
  // stable identity for its callback props.
  const rowCallbacks = useMemo(() => {
    const map = new Map<
      string,
      {
        onChange: (patch: Partial<PropertyCatalogEntry>) => void;
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
    (entry: PropertyCatalogEntry) => {
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
    <div className="flex-1 min-h-0 flex flex-col bg-gray-50">
      <div className="px-5 pt-3 pb-2 flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search rows…"
            className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        {search && (
          <span className="text-[11px] text-gray-500">
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
        <div className="bg-white rounded-md border border-gray-200 h-full flex flex-col overflow-hidden">
          <VirtualizedRowGrid<PropertyCatalogEntry>
            entries={filteredEntries}
            getKey={(e) => e.id}
            minWidth="78rem"
            header={
              <GridHeaderRow gridTemplateColumns={GRID_TEMPLATE_COLUMNS}>
                <HeaderCell>Code</HeaderCell>
                <HeaderCell>Name</HeaderCell>
                <HeaderCell>Abbr</HeaderCell>
                <HeaderCell>Address</HeaderCell>
                <HeaderCell>City</HeaderCell>
                <HeaderCell>State</HeaderCell>
                <HeaderCell>ZIP</HeaderCell>
                <HeaderCell>Unit</HeaderCell>
                <HeaderCell>Type</HeaderCell>
                <HeaderCell>Building</HeaderCell>
                <HeaderCell>Active</HeaderCell>
                <HeaderCell>Notes</HeaderCell>
                <HeaderCell aria-label="Actions">{""}</HeaderCell>
              </GridHeaderRow>
            }
            renderRow={renderRow}
            emptyState={
              search ? (
                <p className="text-xs text-gray-500">
                  No rows match {`"${search}"`}.{" "}
                  <button
                    type="button"
                    className="text-brand-700 underline"
                    onClick={() => setSearch("")}
                  >
                    Clear search
                  </button>
                </p>
              ) : (
                <EmptyTablePrompt
                  icon={Building2}
                  title="No properties yet"
                  body="Add a row to start your property master table. Each row carries a property code + name (required), plus optional address, unit, and metadata fields."
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
// Single editable row (12 fields). Memoized so an unchanged row skips
// re-render when the grid re-renders.
// ---------------------------------------------------------------------------

interface EntryRowProps {
  entry: PropertyCatalogEntry;
  invalid: boolean;
  duplicate: boolean;
  codeInputRef: (el: HTMLInputElement | null) => void;
  onChange: (patch: Partial<PropertyCatalogEntry>) => void;
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
  const codeBlank = entry.property_code.trim().length === 0;
  const nameBlank = entry.property_name.trim().length === 0;

  const cellClasses = (highlight: boolean) =>
    cn(
      "w-full bg-transparent px-1.5 py-1 rounded text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-400",
      highlight && "ring-1 ring-red-300 bg-red-50/40",
      !entry.active && "text-gray-400",
    );

  return (
    <div
      className={cn(
        "transition-colors border-b border-gray-100",
        invalid || duplicate ? "bg-red-50/30" : "hover:bg-brand-50/30",
        !entry.active && "bg-gray-50/40",
      )}
      style={{
        display: "grid",
        gridTemplateColumns: GRID_TEMPLATE_COLUMNS,
        alignItems: "start",
      }}
    >
      <div className="px-2 py-1.5">
        <input
          ref={codeInputRef}
          type="text"
          value={entry.property_code}
          maxLength={MAX_CODE_LENGTH}
          placeholder="VST"
          onChange={(e) => onChange({ property_code: e.target.value })}
          className={cellClasses(codeBlank || duplicate)}
        />
        {duplicate && !codeBlank && (
          <p className="text-[10px] text-red-600 mt-0.5 px-1.5">
            Duplicate code+unit
          </p>
        )}
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={entry.property_name}
          maxLength={MAX_NAME_LENGTH}
          placeholder="Vista Apartments"
          onChange={(e) => onChange({ property_name: e.target.value })}
          className={cellClasses(nameBlank)}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={entry.property_abbreviation ?? ""}
          maxLength={MAX_ABBR_LENGTH}
          placeholder="VST"
          onChange={(e) =>
            onChange({
              property_abbreviation: e.target.value ? e.target.value : null,
            })
          }
          className={cellClasses(false)}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={entry.address ?? ""}
          maxLength={MAX_ADDRESS_LENGTH}
          placeholder="100 Sunset Drive"
          onChange={(e) =>
            onChange({ address: e.target.value ? e.target.value : null })
          }
          className={cellClasses(false)}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={entry.city ?? ""}
          maxLength={MAX_CITY_LENGTH}
          placeholder="Austin"
          onChange={(e) =>
            onChange({ city: e.target.value ? e.target.value : null })
          }
          className={cellClasses(false)}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={entry.state ?? ""}
          maxLength={MAX_STATE_LENGTH}
          placeholder="TX"
          onChange={(e) =>
            onChange({ state: e.target.value ? e.target.value : null })
          }
          className={cellClasses(false)}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={entry.zip ?? ""}
          maxLength={MAX_ZIP_LENGTH}
          placeholder="78701"
          onChange={(e) =>
            onChange({ zip: e.target.value ? e.target.value : null })
          }
          className={cellClasses(false)}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={entry.unit_number ?? ""}
          maxLength={MAX_UNIT_NUMBER_LENGTH}
          placeholder="101"
          onChange={(e) =>
            onChange({ unit_number: e.target.value ? e.target.value : null })
          }
          className={cellClasses(duplicate)}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={entry.unit_type ?? ""}
          maxLength={MAX_UNIT_TYPE_LENGTH}
          placeholder="1BR"
          onChange={(e) =>
            onChange({ unit_type: e.target.value ? e.target.value : null })
          }
          className={cellClasses(false)}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={entry.building ?? ""}
          maxLength={MAX_BUILDING_LENGTH}
          placeholder="A"
          onChange={(e) =>
            onChange({ building: e.target.value ? e.target.value : null })
          }
          className={cellClasses(false)}
        />
      </div>
      <div className="px-2 py-1.5">
        <ActiveToggle
          active={entry.active}
          onChange={(active) => onChange({ active })}
        />
      </div>
      <div className="px-2 py-1.5">
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
          className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
});

// Compact pill-style toggle for the active column.
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
        className="h-3.5 w-3.5 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
      />
      <span
        className={cn(
          "text-[11px] font-medium",
          active ? "text-gray-700" : "text-gray-400",
        )}
      >
        {active ? "Active" : "Inactive"}
      </span>
    </label>
  );
}
