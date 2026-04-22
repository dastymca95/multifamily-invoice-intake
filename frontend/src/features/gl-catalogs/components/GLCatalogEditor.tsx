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
 * GL Catalog editor — a row-based table where each row carries the
 * full GL entry (code / description / category / active / notes).
 *
 * Why a vertical-row table instead of the spreadsheet-style header
 * editor used for invoice templates: the GL entry is data with
 * MULTIPLE FIELDS PER ROW (code + description + category + active +
 * notes), not a single header value per column. A spreadsheet view
 * would force the user to scroll horizontally between fields of the
 * same logical row, which fights the "one chart-of-accounts entry =
 * one row" mental model. So we keep the row direction vertical and
 * spread fields across columns within each row.
 *
 * Direct manipulation:
 *   * Inline `<input>` for code, description, category, notes — typing
 *     edits in place, no per-row "edit" mode.
 *   * Active toggle is a checkbox on the row.
 *   * "Add row" button at the bottom of the table appends a fresh
 *     blank entry and auto-focuses its code cell.
 *   * Each row has a trash icon at the right edge (disabled when only
 *     MIN_ENTRIES rows remain).
 *   * Search box at the top filters visible rows (still allows editing
 *     the visible rows; matches against code / description / category /
 *     notes — case-insensitive substring).
 *   * Save / Discard / Delete buttons in the toolbar above the table.
 *
 * Validation is gentle: we don't block typing — instead, the save
 * button disables when a row has a blank code or description, and
 * each invalid row gets a subtle red ring around the offending cell
 * so the user knows where to look.
 */

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

const SOURCE_BADGE: Record<
  GLCatalogSource,
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

export function GLCatalogEditor({
  catalogKey,
  initial,
  isDraft,
  saving,
  mutationError,
  onSave,
  onDelete,
}: GLCatalogEditorProps) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [entries, setEntries] = useState<GLCatalogEntry[]>(initial.entries);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [search, setSearch] = useState("");
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);

  const codeInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Reset on catalog switch.
  useEffect(() => {
    setName(initial.name);
    setDescription(initial.description ?? "");
    setEntries(initial.entries);
    setConfirmingDelete(false);
    setSearch("");
    setPendingFocusId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogKey]);

  // Focus the code input of a freshly-added row.
  useEffect(() => {
    if (!pendingFocusId) return;
    const el = codeInputRefs.current[pendingFocusId];
    if (el) {
      el.focus();
      el.select();
      el.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
      setPendingFocusId(null);
    }
  }, [pendingFocusId, entries]);

  // ---- Validation ----------------------------------------------------------

  const trimmedName = name.trim();

  // Track which rows are invalid so the table can ring the offending
  // cell. Done in the same pass as duplicate detection so we share the
  // case-insensitive code map.
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
    // Array.from instead of `for…of` over .values() — keeps TS happy
    // under the project's older `target` setting (no downlevelIteration).
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

  const dirty = useMemo(() => {
    if (trimmedName !== initial.name) return true;
    if ((description.trim() || null) !== (initial.description ?? null))
      return true;
    if (JSON.stringify(entries) !== JSON.stringify(initial.entries))
      return true;
    return false;
  }, [trimmedName, description, entries, initial]);

  const canSave =
    !saving &&
    trimmedName.length > 0 &&
    !hasBlankFields &&
    !hasDuplicateCodes &&
    validEntryCount &&
    (isDraft || dirty);

  const handleSave = () => {
    if (!canSave) return;
    void onSave({
      name: trimmedName,
      description: description.trim() ? description.trim() : null,
      entries: entries.map((e) => ({
        ...e,
        code: e.code.trim(),
        description: e.description.trim(),
        category: e.category?.trim() ? e.category.trim() : null,
        notes: e.notes?.trim() ? e.notes.trim() : null,
      })),
    });
  };

  const handleDiscard = () => {
    setName(initial.name);
    setDescription(initial.description ?? "");
    setEntries(initial.entries);
    setConfirmingDelete(false);
    setSearch("");
  };

  // ---- Row mutations -------------------------------------------------------

  const updateEntry = useCallback(
    (id: string, patch: Partial<GLCatalogEntry>) => {
      setEntries((curr) =>
        curr.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      );
    },
    [],
  );

  const addEntry = useCallback(() => {
    if (entries.length >= MAX_ENTRIES) return;
    const id = newEntryId();
    setEntries((curr) => [
      ...curr,
      {
        id,
        code: "",
        description: "",
        category: null,
        active: true,
        notes: null,
      },
    ]);
    setPendingFocusId(id);
  }, [entries.length]);

  const removeEntry = useCallback(
    (id: string) => {
      if (entries.length <= MIN_ENTRIES) return;
      setEntries((curr) => curr.filter((e) => e.id !== id));
    },
    [entries.length],
  );

  // ---- Search filter -------------------------------------------------------

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => {
      const haystack =
        `${e.code} ${e.description} ${e.category ?? ""} ${e.notes ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [entries, search]);

  // ---- Render --------------------------------------------------------------

  const sourceBadge = SOURCE_BADGE[initial.source];
  const activeCount = entries.filter((e) => e.active).length;
  const inactiveCount = entries.length - activeCount;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ---- Toolbar ------------------------------------------------- */}
      <div className="px-5 py-3 bg-white border-b">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-[14rem]">
            <input
              type="text"
              value={name}
              autoFocus={isDraft}
              maxLength={255}
              onChange={(e) => setName(e.target.value)}
              placeholder="Catalog name"
              className="w-full text-base font-semibold text-gray-900 bg-transparent border-0 border-b border-transparent hover:border-gray-200 focus:border-brand-500 focus:outline-none px-0 py-1"
            />
          </div>
          <span
            className={cn(
              "shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5",
              sourceBadge.tone,
            )}
            title={`Source: ${sourceBadge.label}`}
          >
            {sourceBadge.label}
          </span>
          {isDraft && (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 bg-orange-100 text-orange-700 inline-flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              Draft
            </span>
          )}
          <div className="flex items-center gap-1.5 ml-auto">
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
          </div>
        </div>
        <textarea
          value={description}
          rows={1}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description — what's this catalog for? (optional)"
          className="w-full mt-1.5 text-[12.5px] text-gray-600 bg-transparent border-0 resize-none focus:outline-none placeholder:text-gray-400"
        />
        <div className="flex items-center gap-3 text-[11px] text-gray-500 mt-1">
          <span>
            {entries.length} {entries.length === 1 ? "code" : "codes"}
          </span>
          <span className="text-gray-300">·</span>
          <span>{activeCount} active</span>
          {inactiveCount > 0 && (
            <>
              <span className="text-gray-300">·</span>
              <span>{inactiveCount} inactive</span>
            </>
          )}
          {hasBlankFields && (
            <>
              <span className="text-gray-300">·</span>
              <span className="text-red-600">
                {validation.blankCount} row(s) missing code or description
              </span>
            </>
          )}
          {hasDuplicateCodes && (
            <>
              <span className="text-gray-300">·</span>
              <span className="text-red-600">
                duplicate GL codes detected
              </span>
            </>
          )}
        </div>
      </div>

      {mutationError && (
        <div className="px-5 pt-3">
          <InlineAlert tone="error" title="Couldn't save">
            {mutationError}
          </InlineAlert>
        </div>
      )}

      {/* ---- Search + table ----------------------------------------- */}
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
            onClick={addEntry}
          >
            <Plus className="h-3.5 w-3.5" />
            Add row
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-5 pb-5">
          <div className="bg-white rounded-md border border-gray-200 overflow-hidden">
            <table className="w-full text-[12.5px]">
              <thead className="bg-gray-50 text-[10.5px] uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-2.5 py-2 text-left w-[7rem]">GL code</th>
                  <th className="px-2.5 py-2 text-left">Description</th>
                  <th className="px-2.5 py-2 text-left w-[10rem]">Category</th>
                  <th className="px-2.5 py-2 text-left w-[5.5rem]">Active</th>
                  <th className="px-2.5 py-2 text-left w-[14rem]">Notes</th>
                  <th className="px-2.5 py-2 w-[2.5rem]" aria-label="Actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredEntries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center">
                      {search ? (
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
                        <EmptyTable onAdd={addEntry} />
                      )}
                    </td>
                  </tr>
                ) : (
                  filteredEntries.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      invalid={validation.invalidIds.has(entry.id)}
                      duplicate={validation.duplicateIds.has(entry.id)}
                      canRemove={entries.length > MIN_ENTRIES}
                      codeInputRef={(el) => {
                        codeInputRefs.current[entry.id] = el;
                      }}
                      onChange={(patch) => updateEntry(entry.id, patch)}
                      onRemove={() => removeEntry(entry.id)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {entries.length >= MAX_ENTRIES && (
            <p className="mt-2 text-[11px] text-yellow-700">
              Reached the {MAX_ENTRIES}-entry cap — remove rows to add more.
            </p>
          )}
        </div>
      </div>

      {/* ---- Delete (saved catalogs only) ----------------------------- */}
      {onDelete && !isDraft && (
        <div className="px-5 py-3 border-t bg-white flex items-center gap-2">
          {confirmingDelete ? (
            <>
              <span className="text-[12.5px] text-gray-700">
                Delete this catalog? This can&apos;t be undone.
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingDelete(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                loading={saving}
                onClick={() => void onDelete()}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete catalog
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-red-600 hover:bg-red-50"
              onClick={() => setConfirmingDelete(true)}
              disabled={saving}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete catalog
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single editable row
// ---------------------------------------------------------------------------

interface EntryRowProps {
  entry: GLCatalogEntry;
  invalid: boolean;
  duplicate: boolean;
  canRemove: boolean;
  codeInputRef: (el: HTMLInputElement | null) => void;
  onChange: (patch: Partial<GLCatalogEntry>) => void;
  onRemove: () => void;
}

function EntryRow({
  entry,
  invalid,
  duplicate,
  canRemove,
  codeInputRef,
  onChange,
  onRemove,
}: EntryRowProps) {
  const codeBlank = entry.code.trim().length === 0;
  const descBlank = entry.description.trim().length === 0;

  const cellClasses = (highlight: boolean) =>
    cn(
      "w-full bg-transparent px-1.5 py-1 rounded text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-400",
      highlight && "ring-1 ring-red-300 bg-red-50/40",
      !entry.active && "text-gray-400",
    );

  return (
    <tr
      className={cn(
        "transition-colors",
        invalid || duplicate ? "bg-red-50/30" : "hover:bg-brand-50/30",
        !entry.active && "bg-gray-50/40",
      )}
    >
      <td className="px-2.5 py-1.5 align-top">
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
          <p className="text-[10px] text-red-600 mt-0.5 px-1.5">
            Duplicate code
          </p>
        )}
      </td>
      <td className="px-2.5 py-1.5 align-top">
        <input
          type="text"
          value={entry.description}
          maxLength={MAX_DESCRIPTION_LENGTH}
          placeholder="e.g. Repairs & Maintenance"
          onChange={(e) => onChange({ description: e.target.value })}
          className={cellClasses(descBlank)}
        />
      </td>
      <td className="px-2.5 py-1.5 align-top">
        <input
          type="text"
          value={entry.category ?? ""}
          maxLength={MAX_CATEGORY_LENGTH}
          placeholder="Optional"
          onChange={(e) =>
            onChange({
              category: e.target.value ? e.target.value : null,
            })
          }
          className={cellClasses(false)}
        />
      </td>
      <td className="px-2.5 py-1.5 align-top">
        <ActiveToggle
          active={entry.active}
          onChange={(active) => onChange({ active })}
        />
      </td>
      <td className="px-2.5 py-1.5 align-top">
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
      </td>
      <td className="px-1 py-1.5 align-top text-right">
        <button
          type="button"
          aria-label="Delete row"
          title={
            canRemove
              ? "Delete this row"
              : "A catalog needs at least one row"
          }
          onClick={onRemove}
          disabled={!canRemove}
          className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}

// Compact pill-style toggle for the active column. Bigger + clearer
// than a raw checkbox without taking the cell over visually.
function ActiveToggle({
  active,
  onChange,
}: {
  active: boolean;
  onChange: (next: boolean) => void;
}) {
  const handle = (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked);
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

// ---------------------------------------------------------------------------
// Empty-table CTA (only when entries.length === 0 and there's no search)
// ---------------------------------------------------------------------------

function EmptyTable({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="py-2">
      <div className="mx-auto h-10 w-10 rounded-full bg-brand-50 flex items-center justify-center mb-2">
        <BookOpen className="h-5 w-5 text-brand-600" />
      </div>
      <p className="text-sm font-medium text-gray-700">
        No GL codes yet
      </p>
      <p className="text-[11px] text-gray-500 mt-1 max-w-md mx-auto">
        Add a row to start your chart of accounts. Each row carries a
        GL code, a description, an optional category, and an
        active/inactive flag.
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-3"
        onClick={onAdd}
      >
        <Plus className="h-3.5 w-3.5" />
        Add the first row
      </Button>
    </div>
  );
}
