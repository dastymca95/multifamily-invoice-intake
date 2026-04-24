"use client";

import {
  ChevronLeft,
  ChevronRight,
  FileSearch,
  FileText,
  Image as ImageIcon,
  Loader2,
  Plus,
  Redo2,
  Save,
  Settings2,
  Trash2,
  Undo2,
  Upload,
  X,
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
import { cn, formatDate } from "@/lib/utils";
import {
  countRegionsByFieldKey,
  formatFileSize,
  type InvoiceExtractedFieldDescriptor,
  type InvoicePatternFieldDefinition,
  type InvoicePatternOut,
  type InvoicePatternRegion,
  type InvoicePatternSourceFile,
  type InvoicePatternUpdate,
  MAX_PATTERN_DESCRIPTION_LENGTH,
  MAX_PATTERN_NAME_LENGTH,
  MAX_PATTERN_SOURCE_FILES,
  MAX_PATTERN_VENDOR_HINT_LENGTH,
  type ResolvedField,
  resolveFieldList,
  visibleFieldList,
} from "@/types/invoice-pattern";

import {
  useRegionHistory,
  useRegionHistoryShortcuts,
} from "../hooks/useRegionHistory";
import { ingestFile, isAcceptedFileType } from "../lib/file-ingest";
import { DocumentViewer } from "./DocumentViewer";
import { ManageFieldsModal } from "./ManageFieldsModal";
import { RegionInspector } from "./RegionInspector";

/**
 * Center workspace for one open pattern.
 *
 * Responsible for:
 *   * Pattern-level metadata editing (name, vendor hint, description).
 *   * Source-file management (upload more, switch active file, multi-
 *     page navigation, delete file — which cascades to drop its
 *     regions).
 *   * The drag-to-draw region surface (delegated to `DocumentViewer`).
 *   * Drag-and-drop of additional source files onto the viewer area.
 *   * Region editing via the right-rail inspector, with undo/redo
 *     (`useRegionHistory`) and Cmd/Ctrl+Z / Shift+Z / Ctrl+Y wired up.
 *   * Custom + built-in extraction-field universe management
 *     (`ManageFieldsModal`), including per-pattern color overrides
 *     that flow through to overlay tints, the inspector swatch, and
 *     the Draw-as dropdown.
 *   * Save / discard / delete pattern.
 *
 * State model — `formState` is the single source of truth for all
 * non-region edits (name, metadata, source_files, field_definitions).
 * Regions are owned by `useRegionHistory` so undo/redo is first-class.
 * The two get unified at save time into the PATCH body. Saving sends
 * the full source_files + regions + field_definitions arrays
 * (replace-not-merge contract — see backend repo).
 */
interface PatternEditorProps {
  patternKey: string; // re-mounts editor on selection change
  initial: InvoicePatternOut;
  saving: boolean;
  mutationError: string | null;
  canonicalFields: readonly InvoiceExtractedFieldDescriptor[];
  onSave: (id: string, body: InvoicePatternUpdate) => Promise<void>;
  onDelete: () => Promise<void>;
}

/**
 * Pattern-level form state EXCLUDING regions — regions live in
 * `useRegionHistory` so undo/redo can replay snapshots without
 * touching anything else.
 */
interface FormState {
  name: string;
  description: string;
  vendor_hint: string;
  source_files: InvoicePatternSourceFile[];
  field_definitions: InvoicePatternFieldDefinition[];
}

function fromDetail(d: InvoicePatternOut): FormState {
  return {
    name: d.name,
    description: d.description ?? "",
    vendor_hint: d.vendor_hint ?? "",
    source_files: d.source_files,
    field_definitions: d.field_definitions ?? [],
  };
}

export function PatternEditor({
  patternKey: _patternKey,
  initial,
  saving,
  mutationError,
  canonicalFields,
  onSave,
  onDelete,
}: PatternEditorProps) {
  const [form, setForm] = useState<FormState>(() => fromDetail(initial));
  // Region state lives in the history hook so Undo/Redo replays
  // snapshots without rebuilding the rest of the form. The hook's
  // `reset()` is wired into pattern-switch + file-removal flows below
  // so undo can never resurrect orphan regions referencing a now-
  // deleted source file.
  const {
    regions,
    setRegions,
    reset: resetRegions,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useRegionHistory(initial.regions);
  const [activeFileId, setActiveFileId] = useState<string | null>(
    initial.source_files[0]?.id ?? null,
  );
  const [activePage, setActivePage] = useState(1);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(
    null,
  );
  // Default draw target. May be a canonical key OR a custom one once
  // operators add fields. The "fix invalid draw target" effect below
  // re-points this whenever the current key gets hidden / deleted.
  const [drawFieldKey, setDrawFieldKey] = useState<string>("vendor_name");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [manageFieldsOpen, setManageFieldsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Re-materialize on a fresh `initial` (parent passes a re-keyed
  // `patternKey` on selection change so the component re-mounts; this
  // effect catches the post-save case where the same mounted instance
  // receives a refreshed `initial`).
  useEffect(() => {
    setForm(fromDetail(initial));
    resetRegions(initial.regions);
    setActiveFileId(initial.source_files[0]?.id ?? null);
    setActivePage(1);
    setSelectedRegionId(null);
    setConfirmDelete(false);
    setDrawFieldKey("vendor_name");
    setUploadError(null);
  }, [initial, resetRegions]);

  // ---- Resolved field universe ----------------------------------------
  //
  // Merges canonical descriptors with this pattern's per-row overrides
  // + customs into one flat list. Used by the overlay renderer
  // (color), the inspector (swatch + label), and the Draw-as dropdown
  // (visible options). `visibleResolved` filters out hidden built-ins
  // for use in inputs the operator picks from; the inspector still
  // gets the full list so a region pinned to a hidden field can
  // surface its label rather than read as "Unknown".

  const resolved = useMemo(
    () => resolveFieldList(canonicalFields, form.field_definitions),
    [canonicalFields, form.field_definitions],
  );
  const visibleResolved = useMemo(
    () => visibleFieldList(resolved),
    [resolved],
  );

  // Region usage drives ManageFieldsModal's "X is used by N regions"
  // delete-blocking copy + the orphan-key reassign affordance in the
  // inspector.
  const regionUsageByKey = useMemo(
    () => countRegionsByFieldKey(regions),
    [regions],
  );

  // ---- Derived selections ---------------------------------------------

  const activeFile = useMemo(
    () => form.source_files.find((f) => f.id === activeFileId) ?? null,
    [form.source_files, activeFileId],
  );
  const selectedRegion = useMemo(
    () => regions.find((r) => r.id === selectedRegionId) ?? null,
    [regions, selectedRegionId],
  );

  // If the operator hides / deletes the field that's currently the
  // draw target, re-pick the first visible field so the dropdown stays
  // in a valid state. No-op when the current key is still visible.
  useEffect(() => {
    if (visibleResolved.length === 0) return;
    if (!visibleResolved.some((f) => f.key === drawFieldKey)) {
      setDrawFieldKey(visibleResolved[0].key);
    }
  }, [visibleResolved, drawFieldKey]);

  // Wire keyboard shortcuts. Disabled while modals are open so a
  // Cmd+Z inside ManageFieldsModal's label input doesn't surprise the
  // operator with a region-level undo. The hook itself also skips
  // keystrokes inside form controls; the modal-open guard is belt-
  // and-braces for the case where the modal opens with focus on a
  // non-input element.
  useRegionHistoryShortcuts(
    undo,
    redo,
    !manageFieldsOpen && !confirmDelete,
  );

  // ---- Dirty check ----------------------------------------------------
  //
  // Reference equality works for source_files + regions because every
  // edit path swaps the array. `field_definitions` needs a length-and-
  // element scan because the wire shape allows `undefined` (legacy
  // rows) which `fromDetail` normalizes to `[]` — that fresh `[]` is
  // never reference-equal to a separately-normalized one even though
  // they're semantically identical.

  const dirty = useMemo(() => {
    const baselineDefs = initial.field_definitions ?? [];
    const defsDirty =
      form.field_definitions.length !== baselineDefs.length ||
      form.field_definitions.some((d, i) => d !== baselineDefs[i]);
    return (
      form.name !== initial.name ||
      form.description !== (initial.description ?? "") ||
      form.vendor_hint !== (initial.vendor_hint ?? "") ||
      form.source_files !== initial.source_files ||
      defsDirty ||
      regions !== initial.regions
    );
  }, [form, regions, initial]);

  const validName = form.name.trim().length > 0;

  // ---- File ingestion (additional + drop) ------------------------------
  //
  // Both the toolbar's "Add file" button and the viewer's drop overlay
  // funnel through `ingestAndAppend`. It runs `ingestFile()` per file
  // in parallel (size + type validation, data-URL read, PDF page-count
  // probe) and gathers errors so a single bad file doesn't sink the
  // rest of a multi-file drop.

  const ingestAndAppend = useCallback(
    async (raw: File[]) => {
      if (raw.length === 0) return;
      const remaining = MAX_PATTERN_SOURCE_FILES - form.source_files.length;
      if (remaining <= 0) {
        setUploadError(
          `Reached the ${MAX_PATTERN_SOURCE_FILES}-file cap. Remove a file before uploading more.`,
        );
        return;
      }
      const accepted = raw.slice(0, remaining);
      const overflow = raw.length - accepted.length;
      setUploading(true);
      setUploadError(null);
      try {
        const settled = await Promise.allSettled(
          accepted.map((f) => ingestFile(f)),
        );
        const successes: InvoicePatternSourceFile[] = [];
        const errors: string[] = [];
        for (let i = 0; i < settled.length; i++) {
          const r = settled[i];
          if (r.status === "fulfilled") successes.push(r.value);
          else
            errors.push(
              r.reason instanceof Error
                ? r.reason.message
                : `${accepted[i].name}: couldn't read file`,
            );
        }
        if (overflow > 0) {
          errors.push(
            `${overflow} additional file${overflow === 1 ? "" : "s"} skipped — ${MAX_PATTERN_SOURCE_FILES}-file cap reached.`,
          );
        }
        if (successes.length > 0) {
          setForm((curr) => ({
            ...curr,
            source_files: [...curr.source_files, ...successes],
          }));
          // Auto-focus the first newly-uploaded file when no file is
          // currently active so the operator can immediately start
          // drawing on it. Page resets to 1 — the new file's PDF probe
          // (or image default) gives a real page_count, but the editor
          // always opens on page 1.
          if (activeFileId == null) {
            setActiveFileId(successes[0].id);
            setActivePage(1);
          }
        }
        if (errors.length > 0) setUploadError(errors.join("\n"));
      } finally {
        setUploading(false);
      }
    },
    [form.source_files.length, activeFileId],
  );

  const onAddFiles = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      await ingestAndAppend(Array.from(files));
      // Reset the input so the same file can be re-picked after
      // removal (otherwise `change` won't fire on the same value).
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [ingestAndAppend],
  );

  const handleFilesDropped = useCallback(
    async (files: File[]) => {
      // Pre-filter to accepted types so the overlay only swallows
      // useful drops; the rest become an error message naming the
      // offender. `ingestFile` would catch this too but the inline
      // filter keeps the error message specific (drop overlay vs.
      // generic "Couldn't read file").
      const good: File[] = [];
      const bad: string[] = [];
      for (const f of files) {
        if (isAcceptedFileType(f)) good.push(f);
        else bad.push(`${f.name}: unsupported file type`);
      }
      if (good.length > 0) await ingestAndAppend(good);
      if (bad.length > 0) {
        setUploadError((prev) =>
          [prev, ...bad].filter((s): s is string => !!s).join("\n"),
        );
      }
    },
    [ingestAndAppend],
  );

  const removeFile = useCallback(
    (id: string) => {
      const nextFiles = form.source_files.filter((f) => f.id !== id);
      const nextRegions = regions.filter((r) => r.source_file_id !== id);
      setForm((curr) => ({ ...curr, source_files: nextFiles }));
      // File removal cascades into the region list. RESET (rather
      // than push) the region history so undo can't resurrect orphan
      // regions referencing a now-deleted source file. Operator
      // intuition: file removal is a structural action, not a
      // tracked region edit.
      resetRegions(nextRegions);
      if (activeFileId === id) {
        setActiveFileId(nextFiles[0]?.id ?? null);
        setActivePage(1);
        setSelectedRegionId(null);
      }
    },
    [form.source_files, regions, resetRegions, activeFileId],
  );

  // ---- Region edits ----------------------------------------------------
  //
  // All region writes go through `setRegions` from `useRegionHistory`
  // so they land in the undo stack.

  const updateSelectedRegion = useCallback(
    (next: InvoicePatternRegion) => {
      setRegions(regions.map((r) => (r.id === next.id ? next : r)));
    },
    [regions, setRegions],
  );

  const deleteSelectedRegion = useCallback(() => {
    if (!selectedRegionId) return;
    setRegions(regions.filter((r) => r.id !== selectedRegionId));
    setSelectedRegionId(null);
  }, [selectedRegionId, regions, setRegions]);

  // ---- Field definitions -----------------------------------------------

  const handleFieldDefinitionsChange = useCallback(
    (next: InvoicePatternFieldDefinition[]) => {
      setForm((curr) => ({ ...curr, field_definitions: next }));
    },
    [],
  );

  // ---- Save / delete ---------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!validName || saving) return;
    await onSave(initial.id, {
      name: form.name.trim(),
      description: form.description.trim() || null,
      vendor_hint: form.vendor_hint.trim() || null,
      source_files: form.source_files,
      regions,
      field_definitions: form.field_definitions,
    });
    // Note: the parent re-fetches and passes a fresh `initial` whose
    // arrays become the new baselines via the effect above; that
    // implicitly resets region history to the saved state.
  }, [validName, saving, onSave, initial.id, form, regions]);

  const handleDelete = useCallback(async () => {
    setConfirmDelete(false);
    await onDelete();
  }, [onDelete]);

  // ---- Render ----------------------------------------------------------

  return (
    <div className="flex h-full min-h-0">
      {/* ---- Center column: header + viewer ---------------------- */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b bg-white space-y-2">
          <div className="flex items-start gap-3">
            <input
              type="text"
              value={form.name}
              onChange={(e) =>
                setForm((curr) => ({ ...curr, name: e.target.value }))
              }
              maxLength={MAX_PATTERN_NAME_LENGTH}
              placeholder="Untitled pattern"
              className="flex-1 min-w-0 text-[15px] font-semibold text-gray-900 bg-transparent border-b border-transparent focus:border-brand-400 focus:outline-none px-0 py-0.5"
            />
            <div className="flex items-center gap-1 shrink-0">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={undo}
                disabled={!canUndo || saving}
                title="Undo (Ctrl/Cmd+Z)"
                aria-label="Undo"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={redo}
                disabled={!canRedo || saving}
                title="Redo (Ctrl/Cmd+Shift+Z)"
                aria-label="Redo"
              >
                <Redo2 className="h-3.5 w-3.5" />
              </Button>
              <span className="w-2" />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setManageFieldsOpen(true)}
                disabled={saving}
                title="Manage extraction fields"
              >
                <Settings2 className="h-3.5 w-3.5" />
                Fields
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-600 hover:bg-red-50"
                onClick={() => setConfirmDelete(true)}
                disabled={saving}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                loading={saving}
                disabled={!dirty || !validName || saving}
                onClick={handleSave}
              >
                <Save className="h-3.5 w-3.5" />
                Save
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              value={form.vendor_hint}
              onChange={(e) =>
                setForm((curr) => ({
                  ...curr,
                  vendor_hint: e.target.value,
                }))
              }
              maxLength={MAX_PATTERN_VENDOR_HINT_LENGTH}
              placeholder="Vendor hint (optional)"
              className="text-[12px] text-brand-700 bg-transparent border-b border-transparent focus:border-brand-300 focus:outline-none px-0"
            />
            <input
              type="text"
              value={form.description}
              onChange={(e) =>
                setForm((curr) => ({
                  ...curr,
                  description: e.target.value,
                }))
              }
              maxLength={MAX_PATTERN_DESCRIPTION_LENGTH}
              placeholder="Description (optional)"
              className="text-[12px] text-gray-600 bg-transparent border-b border-transparent focus:border-brand-300 focus:outline-none px-0"
            />
          </div>
          <p className="text-[10.5px] text-gray-400">
            Last updated {formatDate(initial.updated_at)}
          </p>
        </div>

        {/* Toolbar — file thumbnails + pagination + draw-target */}
        <div className="px-4 py-2 border-b bg-gray-50 flex items-center gap-3 flex-wrap">
          {/* File thumbnails */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {form.source_files.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setActiveFileId(f.id);
                  setActivePage(1);
                  setSelectedRegionId(null);
                }}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded-md text-[11.5px] border transition-colors max-w-[12rem]",
                  activeFileId === f.id
                    ? "bg-white border-brand-500 text-brand-800 shadow-sm"
                    : "bg-white border-gray-200 text-gray-700 hover:border-gray-300",
                )}
                title={`${f.file_name} (${formatFileSize(f.size_bytes)}${
                  f.page_count > 1 ? ` · ${f.page_count} pages` : ""
                })`}
              >
                {f.mime_type.startsWith("image/") ? (
                  <ImageIcon className="h-3 w-3 shrink-0" />
                ) : (
                  <FileText className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate">{f.file_name}</span>
                {f.page_count > 1 && (
                  <span className="text-[9.5px] text-gray-500 shrink-0 tabular-nums">
                    {f.page_count}p
                  </span>
                )}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(f.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      removeFile(f.id);
                    }
                  }}
                  className="text-gray-400 hover:text-red-600 ml-0.5 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            ))}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,image/*"
              multiple
              className="hidden"
              onChange={onAddFiles}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={
                uploading ||
                form.source_files.length >= MAX_PATTERN_SOURCE_FILES
              }
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              Add file
            </Button>
          </div>

          {/* Pagination — visible when active file has > 1 page */}
          {activeFile && activeFile.page_count > 1 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="p-1 rounded hover:bg-gray-200 disabled:opacity-40"
                onClick={() => setActivePage((p) => Math.max(1, p - 1))}
                disabled={activePage <= 1}
                title="Previous page"
                aria-label="Previous page"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="text-[11.5px] text-gray-700 tabular-nums">
                Page {activePage} of {activeFile.page_count}
              </span>
              <button
                type="button"
                className="p-1 rounded hover:bg-gray-200 disabled:opacity-40"
                onClick={() =>
                  setActivePage((p) =>
                    Math.min(activeFile.page_count, p + 1),
                  )
                }
                disabled={activePage >= activeFile.page_count}
                title="Next page"
                aria-label="Next page"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Draw-target field selector. Includes a leading colored
              swatch so the operator sees at a glance which color the
              next region they draw will land in. */}
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[11px] text-gray-600">Draw as:</span>
            <DrawFieldSelect
              value={drawFieldKey}
              options={visibleResolved}
              onChange={setDrawFieldKey}
            />
          </div>
        </div>

        {(uploadError || mutationError) && (
          <div className="px-4 pt-2 space-y-1.5">
            {uploadError && (
              <InlineAlert tone="error" title="Upload failed">
                <span className="whitespace-pre-line">{uploadError}</span>
              </InlineAlert>
            )}
            {mutationError && (
              <InlineAlert tone="error" title="Save failed">
                {mutationError}
              </InlineAlert>
            )}
          </div>
        )}

        {/* Viewer (with drop-target wrapping). Resolved field list is
            forwarded down so the overlay tints + region inspector
            label/swatch all read from the same single source. */}
        <DocumentViewer
          file={activeFile}
          page={activePage}
          regions={regions}
          drawFieldKey={drawFieldKey}
          selectedRegionId={selectedRegionId}
          resolvedFields={resolved}
          uploading={uploading}
          onRegionsChange={setRegions}
          onSelectRegion={setSelectedRegionId}
          onFilesDropped={handleFilesDropped}
        />

        {/* Footer hint — only shown when no files have been uploaded
            yet. Doubles up the file-picker entry-point for operators
            who skipped the picker affordance in the toolbar. */}
        {form.source_files.length === 0 && (
          <div className="px-4 py-3 bg-gray-50 border-t text-center">
            <FileSearch className="h-5 w-5 mx-auto text-gray-400" />
            <p className="text-[12px] text-gray-600 mt-1.5">
              Upload a sample bill to start pinning regions, or drag
              and drop one into the viewer area above.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus className="h-3.5 w-3.5" />
              Add file
            </Button>
          </div>
        )}
      </div>

      {/* ---- Right rail: region inspector ---------------------- */}
      <div className="w-[18rem] shrink-0">
        <RegionInspector
          region={selectedRegion}
          resolvedFields={resolved}
          regionUsageByKey={regionUsageByKey}
          disabled={saving}
          onChange={updateSelectedRegion}
          onDelete={deleteSelectedRegion}
        />
      </div>

      {/* ---- Manage fields modal ------------------------------- */}
      <ManageFieldsModal
        open={manageFieldsOpen}
        onClose={() => setManageFieldsOpen(false)}
        canonicalFields={canonicalFields}
        fieldDefinitions={form.field_definitions}
        regionUsageByKey={regionUsageByKey}
        onChange={handleFieldDefinitionsChange}
        disabled={saving}
      />

      {/* ---- Confirm-delete dialog ---------------------------- */}
      {confirmDelete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setConfirmDelete(false)}
          />
          <div className="relative bg-white rounded-lg shadow-xl max-w-sm w-full mx-4 p-5">
            <h3 className="text-sm font-semibold text-gray-900">
              Delete this pattern?
            </h3>
            <p className="text-[12px] text-gray-600 mt-1">
              All training documents and regions in &ldquo;{form.name}&rdquo; will
              be removed. Import Builder rule cells that referenced
              this pattern will fall back to the broad-universe
              extraction at runtime.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={handleDelete}
              >
                Delete pattern
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DrawFieldSelect
// ---------------------------------------------------------------------------

/**
 * Tiny composite of a color swatch + native `<select>` for the
 * Draw-as toolbar control. Kept out of the JSX tree above for
 * readability — the swatch needs the same color-resolution logic the
 * viewer overlay uses, so funnelling the option set through here
 * keeps the visual wiring consistent.
 */
function DrawFieldSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly ResolvedField[];
  onChange: (next: string) => void;
}) {
  const current = options.find((o) => o.key === value);
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block h-3 w-3 rounded-sm border border-black/10"
        style={{ backgroundColor: current?.color ?? "#9ca3af" }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-[11.5px] text-gray-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
      >
        {options.length === 0 ? (
          <option value="">No fields available</option>
        ) : (
          options.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.label}
            </option>
          ))
        )}
      </select>
    </div>
  );
}
