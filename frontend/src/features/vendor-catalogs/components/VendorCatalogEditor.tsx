"use client";

import {
  Briefcase,
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
import { vendorCatalogsApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  joinAliases,
  MAX_ADDRESS_LENGTH,
  MAX_CITY_LENGTH,
  MAX_CODE_LENGTH,
  MAX_CONTACT_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_ENTRIES,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PHONE_LENGTH,
  MAX_STATE_LENGTH,
  MAX_ZIP_LENGTH,
  MIN_ENTRIES,
  newEntryId,
  splitAliasCell,
  type VendorCatalogEntry,
  type VendorCatalogSource,
} from "@/types/vendor-catalog";

/**
 * Vendor Catalog editor — a row-based grid where each row carries the
 * full vendor entry (12 fields).
 *
 * Sibling of `GLCatalogEditor` and `PropertyCatalogEditor` — same shared
 * shell (title bar + virtualized grid + ref-equality dirty tracking +
 * memoized rows), same direct-manipulation idiom, same validation
 * pattern. The big difference is the schema: vendor entries are wide
 * (12 fields) and one of them — aliases — is a `string[]` rendered as
 * a delimited text input.
 *
 * Direct manipulation:
 *   * Inline `<input>` per editable cell — typing edits in place, no
 *     per-row "edit" mode.
 *   * Aliases cell is a comma-joined text input with local draft state;
 *     on blur, the raw text is fed through `splitAliasCell` to produce
 *     the canonical `string[]`. This keeps the user's mid-edit text
 *     ("Acme, Acm…") stable while still persisting a clean structured
 *     list.
 *   * Active is a checkbox-with-label on the row.
 *   * "Add row" appends a fresh blank entry, scrolls it into view, and
 *     auto-focuses its name cell.
 *   * Each row has a trash icon at the right edge.
 *   * Search box at the top filters visible rows (matches against
 *     name / code / aliases / address fields — case-insensitive
 *     substring).
 *
 * Validation:
 *   * `vendor_name` is required per row — the save button stays
 *     disabled while any row has it blank.
 *   * `vendor_code` uniqueness is enforced ONLY when present
 *     (case-insensitive). Multiple rows without a code aren't a
 *     collision (the codes are absent, not equal). Matches the
 *     backend's `_validate_entry_invariants`.
 *   * `vendor_name` uniqueness is NOT enforced — different operating
 *     entities can legitimately share names.
 *
 * The editor never blocks typing — it just disables save and rings the
 * offending cells.
 */

// 13-column grid (12 vendor fields + actions). Sums to a wide minimum
// so all columns stay usable; horizontal scroll kicks in below that.
// Property catalog uses ~78rem for 13 columns; vendors get a bit more
// to give the contact/email/notes columns breathing room.
const GRID_TEMPLATE_COLUMNS =
  "12rem 6.5rem 13rem 12rem 8rem 5rem 5.5rem 10rem 12rem 8rem 5.5rem 10rem 2.5rem";
const GRID_MIN_WIDTH = "112rem";

interface InitialCatalog {
  name: string;
  description: string | null;
  entries: VendorCatalogEntry[];
  source: VendorCatalogSource;
}

interface VendorCatalogEditorProps {
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
    entries: VendorCatalogEntry[];
  }) => Promise<void>;
  /** Only present when editing a saved catalog. */
  onDelete?: () => Promise<void>;
}

const blankVendorEntry = (): VendorCatalogEntry => ({
  id: newEntryId(),
  vendor_name: "",
  vendor_code: null,
  aliases: [],
  address: null,
  city: null,
  state: null,
  zip: null,
  contact_name: null,
  email: null,
  phone: null,
  active: true,
  notes: null,
});

const vendorHaystack = (e: VendorCatalogEntry) =>
  `${e.vendor_name} ${e.vendor_code ?? ""} ${e.aliases.join(" ")} ` +
  `${e.address ?? ""} ${e.city ?? ""} ${e.state ?? ""} ${e.zip ?? ""} ` +
  `${e.contact_name ?? ""} ${e.email ?? ""} ${e.phone ?? ""} ` +
  `${e.notes ?? ""}`;

export function VendorCatalogEditor({
  catalogKey,
  initial,
  isDraft,
  saving,
  mutationError,
  onSave,
  onDelete,
}: VendorCatalogEditorProps) {
  const { entries, addEntry, updateEntry, removeEntry, reset, dirty: entriesDirty } =
    useCatalogEntries<VendorCatalogEntry>(initial.entries, catalogKey, {
      min: MIN_ENTRIES,
      max: MAX_ENTRIES,
      makeBlank: blankVendorEntry,
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
    // vendor_code uniqueness ONLY when present — a duplicate "no
    // code" across rows isn't a collision.
    const codeIdsByLower = new Map<string, string[]>();
    let blankCount = 0;
    for (const e of entries) {
      const name = e.vendor_name.trim();
      if (!name) {
        invalidIds.add(e.id);
        blankCount += 1;
      }
      const code = (e.vendor_code ?? "").trim();
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

  // Trim text fields and collapse blank → null on save. Aliases are
  // kept as-is (already structured + length-bounded by the per-row
  // alias editor below).
  const cleanedEntries = useCallback(
    (): VendorCatalogEntry[] =>
      entries.map((e) => ({
        ...e,
        vendor_name: e.vendor_name.trim(),
        vendor_code: e.vendor_code?.trim() ? e.vendor_code.trim() : null,
        address: e.address?.trim() ? e.address.trim() : null,
        city: e.city?.trim() ? e.city.trim() : null,
        state: e.state?.trim() ? e.state.trim() : null,
        zip: e.zip?.trim() ? e.zip.trim() : null,
        contact_name: e.contact_name?.trim()
          ? e.contact_name.trim()
          : null,
        email: e.email?.trim() ? e.email.trim() : null,
        phone: e.phone?.trim() ? e.phone.trim() : null,
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

      <VendorEditorGrid
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
          onCheckDependencies={() => vendorCatalogsApi.getUsedBy(catalogKey)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats line — pure derived content, memoized on its inputs
// ---------------------------------------------------------------------------

interface EditorStatsLineProps {
  entries: VendorCatalogEntry[];
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
        {entries.length} {entries.length === 1 ? "vendor" : "vendors"}
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
            {blankCount} row(s) missing vendor name
          </span>
        </>
      )}
      {hasDuplicateCodes && (
        <>
          <span className="text-gray-300 dark:text-line-strong">·</span>
          <span className="text-red-600">duplicate vendor codes detected</span>
        </>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Grid — owns search + add-row focus state. Schema-specific row + header
// rendering wraps the generic VirtualizedRowGrid shell.
// ---------------------------------------------------------------------------

interface VendorEditorGridProps {
  entries: VendorCatalogEntry[];
  invalidIds: ReadonlySet<string>;
  duplicateIds: ReadonlySet<string>;
  onAddEntry: () => string | null;
  onUpdateEntry: (id: string, patch: Partial<VendorCatalogEntry>) => void;
  onRemoveEntry: (id: string) => void;
}

function VendorEditorGrid({
  entries,
  invalidIds,
  duplicateIds,
  onAddEntry,
  onUpdateEntry,
  onRemoveEntry,
}: VendorEditorGridProps) {
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const nameInputRefs = useRef<Map<string, HTMLInputElement | null>>(
    new Map(),
  );

  const { search, setSearch, filtered: filteredEntries } = useGridSearch(
    entries,
    vendorHaystack,
  );

  // Stable per-row callback bag — same pattern as GL / property
  // editors. The bag is rebuilt only when filteredEntries identity
  // changes; row-level edits don't recreate it.
  const rowCallbacks = useMemo(() => {
    const map = new Map<
      string,
      {
        onChange: (patch: Partial<VendorCatalogEntry>) => void;
        onRemove: () => void;
        nameInputRef: (el: HTMLInputElement | null) => void;
      }
    >();
    for (const entry of filteredEntries) {
      const id = entry.id;
      map.set(id, {
        onChange: (patch) => onUpdateEntry(id, patch),
        onRemove: () => onRemoveEntry(id),
        nameInputRef: (el) => {
          if (el === null) {
            nameInputRefs.current.delete(id);
          } else {
            nameInputRefs.current.set(id, el);
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
    (entry: VendorCatalogEntry) => {
      const cb = rowCallbacks.get(entry.id)!;
      return (
        <EntryRow
          entry={entry}
          invalid={invalidIds.has(entry.id)}
          duplicate={duplicateIds.has(entry.id)}
          onChange={cb.onChange}
          onRemove={cb.onRemove}
          nameInputRef={cb.nameInputRef}
        />
      );
    },
    [rowCallbacks, invalidIds, duplicateIds],
  );

  const resolveFocusTarget = useCallback(
    (id: string) => nameInputRefs.current.get(id) ?? null,
    [],
  );

  return (
    // Outer grid wrapper. The catalog editor's search/add-row toolbar
    // and the grid card sit inside this band — without the dark
    // counterpart the band stayed light around an otherwise-dark grid
    // and read as a stranded white strip. Matches GL's editor wrapper.
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
          <VirtualizedRowGrid<VendorCatalogEntry>
            entries={filteredEntries}
            getKey={(e) => e.id}
            minWidth={GRID_MIN_WIDTH}
            header={
              <GridHeaderRow gridTemplateColumns={GRID_TEMPLATE_COLUMNS}>
                <HeaderCell>Vendor name</HeaderCell>
                <HeaderCell>Code</HeaderCell>
                <HeaderCell>Aliases</HeaderCell>
                <HeaderCell>Address</HeaderCell>
                <HeaderCell>City</HeaderCell>
                <HeaderCell>State</HeaderCell>
                <HeaderCell>ZIP</HeaderCell>
                <HeaderCell>Contact</HeaderCell>
                <HeaderCell>Email</HeaderCell>
                <HeaderCell>Phone</HeaderCell>
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
                    className="text-brand-700 underline"
                    onClick={() => setSearch("")}
                  >
                    Clear search
                  </button>
                </p>
              ) : (
                <EmptyTablePrompt
                  icon={Briefcase}
                  title="No vendors yet"
                  body="Add a row to start your vendor master list. Each row carries a vendor name (required), plus optional code, aliases, address, contact info, and active/inactive flag."
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
  entry: VendorCatalogEntry;
  invalid: boolean;
  duplicate: boolean;
  nameInputRef: (el: HTMLInputElement | null) => void;
  onChange: (patch: Partial<VendorCatalogEntry>) => void;
  onRemove: () => void;
}

const EntryRow = memo(function EntryRow({
  entry,
  invalid,
  duplicate,
  nameInputRef,
  onChange,
  onRemove,
}: EntryRowProps) {
  const nameBlank = entry.vendor_name.trim().length === 0;
  const codeBlank = (entry.vendor_code ?? "").trim().length === 0;

  const cellClasses = (highlight: boolean) =>
    cn(
      "w-full bg-transparent px-1.5 py-1 rounded text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-400",
      highlight && "ring-1 ring-red-300 bg-red-50/40",
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
      <div className="px-2 py-1.5">
        <input
          ref={nameInputRef}
          type="text"
          value={entry.vendor_name}
          maxLength={MAX_NAME_LENGTH}
          placeholder="Acme Plumbing Inc."
          onChange={(e) => onChange({ vendor_name: e.target.value })}
          className={cellClasses(nameBlank)}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={entry.vendor_code ?? ""}
          maxLength={MAX_CODE_LENGTH}
          placeholder="ACME"
          onChange={(e) =>
            onChange({
              vendor_code: e.target.value ? e.target.value : null,
            })
          }
          className={cellClasses(duplicate && !codeBlank)}
        />
        {duplicate && !codeBlank && (
          <p className="text-[10px] text-red-600 mt-0.5 px-1.5">
            Duplicate code
          </p>
        )}
      </div>
      <div className="px-2 py-1.5">
        <AliasesCell
          aliases={entry.aliases}
          disabled={!entry.active}
          onCommit={(next) => onChange({ aliases: next })}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={entry.address ?? ""}
          maxLength={MAX_ADDRESS_LENGTH}
          placeholder="123 Main St"
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
          placeholder="City"
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
          placeholder="ST"
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
          placeholder="ZIP"
          onChange={(e) =>
            onChange({ zip: e.target.value ? e.target.value : null })
          }
          className={cellClasses(false)}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={entry.contact_name ?? ""}
          maxLength={MAX_CONTACT_NAME_LENGTH}
          placeholder="Contact"
          onChange={(e) =>
            onChange({
              contact_name: e.target.value ? e.target.value : null,
            })
          }
          className={cellClasses(false)}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="email"
          value={entry.email ?? ""}
          maxLength={MAX_EMAIL_LENGTH}
          placeholder="contact@vendor.com"
          onChange={(e) =>
            onChange({ email: e.target.value ? e.target.value : null })
          }
          className={cellClasses(false)}
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="tel"
          value={entry.phone ?? ""}
          maxLength={MAX_PHONE_LENGTH}
          placeholder="(555) 555-5555"
          onChange={(e) =>
            onChange({ phone: e.target.value ? e.target.value : null })
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
          className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 dark:text-ink-subtle dark:hover:text-red-400 dark:hover:bg-red-950/40"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Aliases cell — local draft text + canonical commit on blur
// ---------------------------------------------------------------------------

/**
 * Aliases live in the canonical schema as `string[]` (one slot per
 * alternate name). Splitting/joining on every keystroke would erase
 * the user's mid-edit text — typing "Acme, Acm" mid-word would round-
 * trip to "Acme, Acm" but a fresh re-render from the canonical value
 * could re-stringify and lose trailing whitespace, fight cursor
 * position, etc.
 *
 * So this cell keeps a LOCAL `text` that mirrors what the user is
 * actively typing, and only commits to the canonical structured list
 * on blur (or when the canonical list changes externally — e.g.
 * Discard reset).
 *
 * The committed structured list is the canonical source of truth.
 * The text is just an editor view of it.
 */
function AliasesCell({
  aliases,
  disabled,
  onCommit,
}: {
  aliases: readonly string[];
  disabled: boolean;
  onCommit: (next: string[]) => void;
}) {
  const [text, setText] = useState(() => joinAliases(aliases));
  // Track the last canonical we emitted so we know when an external
  // reset has come in (and we should re-sync the local text). Stored
  // as a ref to avoid re-render churn.
  const lastEmittedRef = useRef<string>(joinAliases(aliases));

  // Sync the local draft when the canonical list changes from the
  // outside (catalog switch, discard, etc). We compare against the
  // last value WE emitted so an in-progress edit doesn't get clobbered
  // by the parent re-render that follows our own commit.
  useEffect(() => {
    const canonical = joinAliases(aliases);
    if (canonical !== lastEmittedRef.current) {
      setText(canonical);
      lastEmittedRef.current = canonical;
    }
  }, [aliases]);

  const handleBlur = () => {
    const next = splitAliasCell(text);
    const nextJoined = joinAliases(next);
    // Repaint the cell with the canonical join so the user sees what
    // actually got saved (e.g. "Acme,acme , ACME" → "Acme").
    setText(nextJoined);
    lastEmittedRef.current = nextJoined;
    // Only commit if the canonical list actually changed — keeps
    // ref-equality dirty tracking honest.
    const same =
      next.length === aliases.length &&
      next.every((a, i) => a === aliases[i]);
    if (!same) {
      onCommit(next);
    }
  };

  return (
    <input
      type="text"
      value={text}
      placeholder="dba1, dba2"
      onChange={(e) => setText(e.target.value)}
      onBlur={handleBlur}
      className={cn(
        "w-full bg-transparent px-1.5 py-1 rounded text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-400",
        disabled && "text-gray-400",
      )}
    />
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
