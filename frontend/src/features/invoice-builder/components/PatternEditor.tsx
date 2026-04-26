"use client";

import {
  ChevronLeft,
  ChevronRight,
  FileSearch,
  FileText,
  GitBranch,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  Redo2,
  Rows3,
  Save,
  Settings2,
  Square,
  StretchHorizontal,
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

import { DependencyBlockerDialog } from "@/components/dependencies/DependencyBlockerDialog";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { getApiErrorMessage, invoicePatternsApi } from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import type { UsedByReport } from "@/types/dependencies";
import {
  countRegionsByFieldKey,
  effectiveDeletedPages,
  firstVisiblePage,
  formatFileSize,
  type InvoiceExtractedFieldDescriptor,
  type InvoicePatternFieldDefinition,
  type InvoicePatternOut,
  type InvoicePatternRegion,
  type InvoicePatternSourceFile,
  type InvoicePatternUpdate,
  isPageDeleted,
  MAX_PATTERN_DESCRIPTION_LENGTH,
  MAX_PATTERN_NAME_LENGTH,
  MAX_PATTERN_SOURCE_FILES,
  MAX_PATTERN_VENDOR_HINT_LENGTH,
  nonDeletedPages,
  type ResolvedField,
  resolveFieldList,
  visibleFieldList,
} from "@/types/invoice-pattern";

import {
  useInvoicePatternCoverage,
} from "../hooks/useInvoicePatternCoverage";
import {
  useRegionHistory,
  useRegionHistoryShortcuts,
} from "../hooks/useRegionHistory";
import { useViewerKeyboardShortcuts } from "../hooks/useViewerShortcuts";
import { ingestFile, isAcceptedFileType } from "../lib/file-ingest";
import {
  DEFAULT_VIEWER_TOOL,
  type ViewerTool,
  VIEWER_TOOLS,
} from "../lib/viewer-tools";
import { ContinuousDocumentStack } from "./ContinuousDocumentStack";
import { CoveragePanel } from "./CoveragePanel";
import { DocumentViewer } from "./DocumentViewer";
import { ManageFieldsModal } from "./ManageFieldsModal";
import { RegionInspector } from "./RegionInspector";
import { ThumbnailRail } from "./ThumbnailRail";

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
  const [deleteCheckLoading, setDeleteCheckLoading] = useState(false);
  const [deleteDependencyReport, setDeleteDependencyReport] =
    useState<UsedByReport | null>(null);
  const [deleteDependencyError, setDeleteDependencyError] = useState<
    string | null
  >(null);
  // Page-deletion confirm dialog — operator-confirmed because page
  // deletion is NOT undoable today (the region cascade IS undoable
  // via the region-history hook, but the source_file mutation is
  // not). Storing the candidate page rather than a boolean lets the
  // dialog name the page in its copy.
  const [pageToDelete, setPageToDelete] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [manageFieldsOpen, setManageFieldsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---- Viewer tool / zoom / view-mode state -----------------------
  //
  // Tool: "select" / "draw_rect" / "pan" / "draw_polygon" — see
  // `viewer-tools.ts`. Defaults to select so the editor opens in
  // the "click to interact" mode operators expect.
  // Zoom: 1.0 = 100%; range [0.5, 3.0]. Step size 0.1 (10%).
  // View mode: "single" / "continuous" / "thumbnails" — see the
  // toolbar segment further down for the contract.
  const [viewerTool, setViewerTool] = useState<ViewerTool>(
    DEFAULT_VIEWER_TOOL,
  );
  const [zoom, setZoom] = useState<number>(1);
  type ViewMode = "single" | "continuous" | "thumbnails";
  const [viewMode, setViewMode] = useState<ViewMode>("single");

  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3.0;
  const ZOOM_STEP = 0.1;
  const zoomIn = useCallback(
    () => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2))),
    [],
  );
  const zoomOut = useCallback(
    () => setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2))),
    [],
  );
  const resetZoom = useCallback(() => setZoom(1), []);
  // Fit-width and fit-page are aspirational — the page surface always
  // hugs its container's width up to BASE_PAGE_WIDTH_PX × zoom. So
  // "fit width" is just "set zoom such that 768px × zoom == container
  // width". Without measuring the container live, the simplest
  // interpretation is "100%" + a future enhancement to read the
  // container width. For now both buttons map to 1.0 / 0.85 so the
  // affordance is at least responsive.
  const fitWidth = useCallback(() => setZoom(1), []);
  const fitPage = useCallback(() => setZoom(0.85), []);

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
    setDeleteDependencyReport(null);
    setDeleteDependencyError(null);
    setPageToDelete(null);
    setDrawFieldKey("vendor_name");
    setUploadError(null);
    // Tool / zoom / view-mode preserved across saves — they're a UI
    // preference, not a data field. Pattern switches re-mount the
    // editor so they reset to defaults via the initial useState.
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

  // ---- Right-rail tab + Import Builder coverage scope ---------------
  //
  // Right rail flips between the per-region inspector and the
  // pattern-level coverage panel. Defaults to Region (the per-selection
  // editor is the more common interaction); the operator can flip to
  // Coverage to see which Import Builder templates use this pattern.
  //
  // `templateScopeId` is the toolbar's current narrowing filter — null
  // means "All templates", a specific id means "show me only this
  // template's coverage + only badge regions linked from that
  // template". The coverage hook always fetches the FULL set (one
  // round-trip per pattern open / refresh) and the scope filter is
  // applied client-side to keep template switching instant.
  type RightTab = "region" | "coverage";
  const [rightTab, setRightTab] = useState<RightTab>("region");
  const [templateScopeId, setTemplateScopeId] = useState<string | null>(null);
  const {
    data: coverageData,
    loading: coverageLoading,
    error: coverageError,
    refresh: refreshCoverage,
  } = useInvoicePatternCoverage(initial.id, null);

  // When the operator selects a region (e.g. clicks a region overlay)
  // auto-flip to the Region tab. Lets the Coverage panel be a
  // "background diagnostic" that doesn't block per-region edits.
  useEffect(() => {
    if (selectedRegionId) setRightTab("region");
  }, [selectedRegionId]);

  // Reset the toolbar template scope on every pattern switch — a
  // scope id from a previous pattern is meaningless on the new one
  // (templates may not even reference it). The hook above already
  // null-pattern-clears its internal state.
  useEffect(() => {
    setTemplateScopeId(null);
  }, [initial.id]);

  // Drop the scope back to "All templates" if the selected template
  // disappears from the response (e.g. operator deleted it in another
  // tab and we just refetched).
  useEffect(() => {
    if (!templateScopeId || !coverageData) return;
    const stillThere = coverageData.templates.some(
      (t) => t.template_id === templateScopeId,
    );
    if (!stillThere) setTemplateScopeId(null);
  }, [templateScopeId, coverageData]);

  // Derived field-key sets for the region overlay badges. Honours the
  // toolbar scope: when filtering to one template, only that
  // template's bound fields get the "Linked" / "REQ" badges so the
  // operator can isolate "what does THIS template need from this
  // pattern?".
  const { linkedFieldKeys, requiredFieldKeys } = useMemo(() => {
    const linked = new Set<string>();
    const required = new Set<string>();
    if (!coverageData) return { linkedFieldKeys: linked, requiredFieldKeys: required };
    const templates = templateScopeId
      ? coverageData.templates.filter(
          (t) => t.template_id === templateScopeId,
        )
      : coverageData.templates;
    for (const t of templates) {
      for (const uf of t.used_fields) {
        linked.add(uf.field_key);
        if (uf.used_by.some((u) => u.column_required)) {
          required.add(uf.field_key);
        }
      }
    }
    return { linkedFieldKeys: linked, requiredFieldKeys: required };
  }, [coverageData, templateScopeId]);

  // ---- Derived selections ---------------------------------------------

  const activeFile = useMemo(
    () => form.source_files.find((f) => f.id === activeFileId) ?? null,
    [form.source_files, activeFileId],
  );
  const selectedRegion = useMemo(
    () => regions.find((r) => r.id === selectedRegionId) ?? null,
    [regions, selectedRegionId],
  );

  // Visible (non-deleted) page list for the active file. Drives the
  // paginator + thumbnail rail so deleted pages disappear from the
  // navigation surface — they remain in the underlying data URL but
  // can't be drawn on.
  const visiblePages = useMemo(
    () => (activeFile ? nonDeletedPages(activeFile) : []),
    [activeFile],
  );
  const activePageIsDeleted =
    activeFile != null && isPageDeleted(activeFile, activePage);

  // If the operator hides / deletes the field that's currently the
  // draw target, re-pick the first visible field so the dropdown stays
  // in a valid state. No-op when the current key is still visible.
  useEffect(() => {
    if (visibleResolved.length === 0) return;
    if (!visibleResolved.some((f) => f.key === drawFieldKey)) {
      setDrawFieldKey(visibleResolved[0].key);
    }
  }, [visibleResolved, drawFieldKey]);

  // If the active page has been deleted (e.g. operator just removed
  // it and we need to slide focus elsewhere), re-anchor on the next
  // visible page. No-op when the current page is still visible.
  useEffect(() => {
    if (!activeFile) return;
    if (!isPageDeleted(activeFile, activePage)) return;
    const next = firstVisiblePage(activeFile);
    if (next != null) setActivePage(next);
  }, [activeFile, activePage]);

  // Wire keyboard shortcuts. Disabled while modals are open so a
  // Cmd+Z inside ManageFieldsModal's label input doesn't surprise the
  // operator with a region-level undo. The hook itself also skips
  // keystrokes inside form controls; the modal-open guard is belt-
  // and-braces for the case where the modal opens with focus on a
  // non-input element.
  const shortcutsEnabled =
    !manageFieldsOpen && !confirmDelete && pageToDelete == null;
  useRegionHistoryShortcuts(undo, redo, shortcutsEnabled);

  // Viewer-only shortcuts: tool switching (V/R/H), Space-pan,
  // Delete/Backspace for the selected region, Ctrl/Cmd +/-/0 for
  // zoom. Same skip rules as the history hook (text-input fields
  // never see these), gated by the same modal kill-switch.
  useViewerKeyboardShortcuts({
    tool: viewerTool,
    setTool: setViewerTool,
    onDeleteSelected: () => {
      if (!selectedRegionId) return;
      setRegions(regions.filter((r) => r.id !== selectedRegionId));
      setSelectedRegionId(null);
    },
    hasSelection: selectedRegionId != null,
    canZoomIn: zoom < ZOOM_MAX,
    canZoomOut: zoom > ZOOM_MIN,
    onZoomIn: zoomIn,
    onZoomOut: zoomOut,
    onResetZoom: resetZoom,
    enabled: shortcutsEnabled,
  });

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

  // ---- Page deletion -------------------------------------------------
  //
  // Hides one page of a file (the bytes stay; the renderer + extractor
  // skip it). Cascade-removes regions on that page so the backend's
  // cross-field consistency check can't reject the save.
  //
  // Reset (not push) the region history because the source-file
  // mutation isn't undoable; pushing the region cascade alone would
  // let undo resurrect regions that reference a deleted page →
  // backend 422. Operator intuition matches the file-removal flow:
  // page deletion is a structural action, not a tracked region edit.
  // Hence the mandatory confirm dialog.

  const performDeletePage = useCallback(
    (page: number) => {
      if (!activeFile) return;
      const file = activeFile;
      // Refuse to delete the last visible page — the source-file
      // schema validator rejects "all pages deleted" with the same
      // copy. Catching it here gives a friendlier path (operator can
      // remove the file outright instead).
      const remaining = nonDeletedPages(file).filter((p) => p !== page);
      if (remaining.length === 0) {
        setUploadError(
          "Can't delete the last visible page of a file — remove the file instead.",
        );
        return;
      }
      const nextDeleted = [
        ...effectiveDeletedPages(file),
        page,
      ].sort((a, b) => a - b);
      const nextFiles = form.source_files.map((f) =>
        f.id === file.id ? { ...f, deleted_pages: nextDeleted } : f,
      );
      const nextRegions = regions.filter(
        (r) => !(r.source_file_id === file.id && r.page === page),
      );
      setForm((curr) => ({ ...curr, source_files: nextFiles }));
      resetRegions(nextRegions);
      // If we just deleted the page the operator was viewing, slide to
      // the next visible page.
      if (activePage === page) {
        setActivePage(remaining[0]);
        setSelectedRegionId(null);
      }
    },
    [activeFile, activePage, form.source_files, regions, resetRegions],
  );

  const handleConfirmDeletePage = useCallback(() => {
    if (pageToDelete == null) return;
    const target = pageToDelete;
    setPageToDelete(null);
    performDeletePage(target);
  }, [pageToDelete, performDeletePage]);

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

  const handleRequestDelete = useCallback(async () => {
    setDeleteCheckLoading(true);
    setDeleteDependencyError(null);
    try {
      const report = await invoicePatternsApi.getUsedBy(initial.id);
      if (report.safe_to_delete) {
        setConfirmDelete(true);
      } else {
        setDeleteDependencyReport(report);
      }
    } catch (err) {
      setDeleteDependencyError(
        getApiErrorMessage(err, "Could not check where this pattern is used."),
      );
    } finally {
      setDeleteCheckLoading(false);
    }
  }, [initial.id]);

  // ---- Render ----------------------------------------------------------

  return (
    <div className="flex h-full min-h-0">
      {/* ---- Center column: header + viewer ---------------------- */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 bg-white dark:bg-surface-subtle dark:border-line space-y-2">
          <div className="flex items-start gap-3">
            <input
              type="text"
              value={form.name}
              onChange={(e) =>
                setForm((curr) => ({ ...curr, name: e.target.value }))
              }
              maxLength={MAX_PATTERN_NAME_LENGTH}
              placeholder="Untitled pattern"
              className="flex-1 min-w-0 text-[15px] font-semibold text-gray-900 dark:text-ink bg-transparent border-b border-transparent focus:border-brand-400 focus:outline-none px-0 py-0.5"
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
                className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                onClick={() => void handleRequestDelete()}
                disabled={saving}
                loading={deleteCheckLoading}
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
              className="text-[12px] text-brand-700 dark:text-brand-50 bg-transparent border-b border-transparent focus:border-brand-300 focus:outline-none px-0"
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
              className="text-[12px] text-gray-600 dark:text-ink-muted bg-transparent border-b border-transparent focus:border-brand-300 focus:outline-none px-0"
            />
          </div>
          <p className="text-[10.5px] text-gray-400 dark:text-ink-subtle">
            Last updated {formatDate(initial.updated_at)}
          </p>
        </div>

        {/* Toolbar — file thumbnails + pagination + draw-target */}
        <div className="px-4 py-2 border-b border-gray-200 bg-gray-50 dark:bg-surface-muted dark:border-line flex items-center gap-3 flex-wrap">
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
                    ? "bg-white border-brand-500 text-brand-800 shadow-sm dark:bg-surface-subtle dark:border-brand-500 dark:text-brand-50"
                    : "bg-white border-gray-200 text-gray-700 hover:border-gray-300 dark:bg-surface-subtle dark:border-line dark:text-ink-muted dark:hover:border-line-strong",
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
                  <span className="text-[9.5px] text-gray-500 dark:text-ink-subtle shrink-0 tabular-nums">
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
                  className="text-gray-400 hover:text-red-600 dark:text-ink-subtle dark:hover:text-red-400 ml-0.5 cursor-pointer"
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

          {/* Pagination — visible when active file has > 1 page.
              Steps OVER deleted pages so the operator never sees a
              "Page N" they can't open. The "Delete page" trash icon
              opens the confirmation dialog. */}
          {activeFile && visiblePages.length > 1 && (
            <div className="flex items-center gap-1 text-gray-700 dark:text-ink-muted">
              <button
                type="button"
                className="p-1 rounded hover:bg-gray-200 dark:hover:bg-surface-subtle disabled:opacity-40"
                onClick={() => {
                  const idx = visiblePages.indexOf(activePage);
                  if (idx > 0) setActivePage(visiblePages[idx - 1]);
                }}
                disabled={visiblePages.indexOf(activePage) <= 0}
                title="Previous page"
                aria-label="Previous page"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="text-[11.5px] tabular-nums">
                Page {activePage} of {activeFile.page_count}
                {activeFile.deleted_pages?.length ? (
                  <span className="text-gray-400 dark:text-ink-subtle ml-1">
                    ({activeFile.deleted_pages.length} deleted)
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                className="p-1 rounded hover:bg-gray-200 dark:hover:bg-surface-subtle disabled:opacity-40"
                onClick={() => {
                  const idx = visiblePages.indexOf(activePage);
                  if (idx >= 0 && idx < visiblePages.length - 1)
                    setActivePage(visiblePages[idx + 1]);
                }}
                disabled={
                  visiblePages.indexOf(activePage) >=
                  visiblePages.length - 1
                }
                title="Next page"
                aria-label="Next page"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              {/* Delete-page button — disabled when only one visible
                  page remains (matches the schema rule that refuses
                  to delete the last visible page). */}
              <button
                type="button"
                className="p-1 rounded hover:bg-red-50 text-gray-500 hover:text-red-600 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-500 dark:text-ink-subtle dark:hover:bg-red-950/40 dark:hover:text-red-400 dark:disabled:hover:text-ink-subtle"
                onClick={() => setPageToDelete(activePage)}
                disabled={visiblePages.length <= 1}
                title="Delete this page"
                aria-label="Delete this page"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Tool picker — segmented control. Each tool surfaces its
              keyboard shortcut in the tooltip; the polygon entry is
              rendered as "coming soon" so operators know the
              capability is in flight. */}
          <ToolPicker
            value={viewerTool}
            onChange={setViewerTool}
            disabled={saving}
          />

          {/* Zoom controls — minus / value / plus / fit-width / fit-page
              / 100%. The numeric label doubles as the "reset to 100%"
              click target so the affordance is dense. */}
          <ZoomControls
            zoom={zoom}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            onResetZoom={resetZoom}
            onFitWidth={fitWidth}
            onFitPage={fitPage}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
          />

          {/* View-mode toggle — single page, vertical scroll of all
              pages, or thumbnails sidebar. Hidden when the active
              file has only one visible page (no choice to make). */}
          {activeFile && visiblePages.length > 1 && (
            <ViewModeToggle value={viewMode} onChange={setViewMode} />
          )}

          {/* Import Builder scope selector. Filters the right-rail
              coverage panel + the region-overlay association badges
              to a single template so the operator can answer
              "what does THIS template need from this pattern?". The
              dropdown is sourced from the coverage response (every
              workspace template appears, not just wired ones) so the
              labels stay backend-authoritative. */}
          <div className="ml-auto flex items-center gap-1.5">
            <ImportTemplateScopeSelect
              templates={coverageData?.templates ?? []}
              value={templateScopeId}
              onChange={(next) => {
                setTemplateScopeId(next);
                // When the operator scopes to a specific template, flip
                // the right rail to Coverage so they see what they just
                // narrowed to. Don't flip when going back to "All".
                if (next) setRightTab("coverage");
              }}
              disabled={coverageLoading && !coverageData}
            />
          </div>

          {/* Draw-target field selector. Includes a leading colored
              swatch so the operator sees at a glance which color the
              next region they draw will land in. */}
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-gray-600 dark:text-ink-muted">
              Draw as:
            </span>
            <DrawFieldSelect
              value={drawFieldKey}
              options={visibleResolved}
              onChange={setDrawFieldKey}
            />
          </div>
        </div>

        {(uploadError || mutationError || deleteDependencyError) && (
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
            {deleteDependencyError && (
              <InlineAlert tone="error" title="Delete check failed">
                {deleteDependencyError}
              </InlineAlert>
            )}
          </div>
        )}

        {/* Viewer area. Switches between three rendering surfaces based
            on the operator's `viewMode`:
              - "single"      → DocumentViewer on the active page only.
              - "continuous"  → ContinuousDocumentStack (vertical scroll
                                of all visible pages, drawable on each).
              - "thumbnails"  → DocumentViewer in the main area, with a
                                ThumbnailRail sidebar on the left for
                                jumping between pages.
            The DocumentViewer is the same component in single + thumbnails
            modes — the rail just changes how the operator picks
            `activePage`. Continuous mode swaps to the dedicated stack
            because per-page mouse handlers + a single page surface
            don't compose. Resolved field list is forwarded down so the
            overlay tints + region inspector label/swatch all read from
            the same single source. */}
        {viewMode === "continuous" && activeFile ? (
          <ContinuousDocumentStack
            file={activeFile}
            visiblePages={visiblePages}
            regions={regions}
            drawFieldKey={drawFieldKey}
            selectedRegionId={selectedRegionId}
            resolvedFields={resolved}
            linkedFieldKeys={linkedFieldKeys}
            requiredFieldKeys={requiredFieldKeys}
            tool={viewerTool}
            zoom={zoom}
            uploading={uploading}
            onRegionsChange={setRegions}
            onSelectRegion={setSelectedRegionId}
            onFilesDropped={handleFilesDropped}
            onPageActivated={setActivePage}
          />
        ) : viewMode === "thumbnails" && activeFile ? (
          <div className="flex-1 min-h-0 flex">
            <ThumbnailRail
              file={activeFile}
              visiblePages={visiblePages}
              activePage={activePage}
              regions={regions}
              resolvedFields={resolved}
              onSelectPage={(p) => {
                setActivePage(p);
                setSelectedRegionId(null);
              }}
            />
            <div className="flex-1 min-w-0 flex flex-col">
              <DocumentViewer
                file={activeFile}
                page={activePage}
                regions={regions}
                drawFieldKey={drawFieldKey}
                selectedRegionId={selectedRegionId}
                resolvedFields={resolved}
                linkedFieldKeys={linkedFieldKeys}
                requiredFieldKeys={requiredFieldKeys}
                tool={viewerTool}
                zoom={zoom}
                uploading={uploading}
                onRegionsChange={setRegions}
                onSelectRegion={setSelectedRegionId}
                onFilesDropped={handleFilesDropped}
              />
            </div>
          </div>
        ) : (
          <DocumentViewer
            file={activeFile}
            page={activePage}
            regions={regions}
            drawFieldKey={drawFieldKey}
            selectedRegionId={selectedRegionId}
            resolvedFields={resolved}
            linkedFieldKeys={linkedFieldKeys}
            requiredFieldKeys={requiredFieldKeys}
            tool={viewerTool}
            zoom={zoom}
            uploading={uploading}
            onRegionsChange={setRegions}
            onSelectRegion={setSelectedRegionId}
            onFilesDropped={handleFilesDropped}
          />
        )}

        {activePageIsDeleted && (
          <div className="px-4 py-1.5 text-[11px] text-amber-700 bg-amber-50 border-t border-amber-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900">
            This page is marked deleted and is hidden from the
            navigator. Use the page selector to pick a visible page.
          </div>
        )}

        {/* Footer hint — only shown when no files have been uploaded
            yet. Doubles up the file-picker entry-point for operators
            who skipped the picker affordance in the toolbar. */}
        {form.source_files.length === 0 && (
          <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 text-center dark:bg-surface-muted dark:border-line">
            <FileSearch className="h-5 w-5 mx-auto text-gray-400 dark:text-ink-subtle" />
            <p className="text-[12px] text-gray-600 dark:text-ink-muted mt-1.5">
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

      {/* ---- Right rail: tabbed Region | Coverage shell -------- */}
      <div className="w-[18rem] shrink-0 flex flex-col bg-white border-l border-gray-200 dark:bg-surface-subtle dark:border-line">
        <RightRailTabs
          tab={rightTab}
          onChange={setRightTab}
          coverageBadge={
            coverageData
              ? coverageData.aggregate.missing_required_columns
              : 0
          }
        />
        <div className="flex-1 min-h-0">
          {rightTab === "region" ? (
            <RegionInspector
              region={selectedRegion}
              resolvedFields={resolved}
              regionUsageByKey={regionUsageByKey}
              disabled={saving}
              onChange={updateSelectedRegion}
              onDelete={deleteSelectedRegion}
            />
          ) : (
            <CoveragePanel
              data={coverageData}
              loading={coverageLoading}
              error={coverageError}
              scopedTemplateId={templateScopeId}
              resolvedFields={resolved}
              onRefresh={refreshCoverage}
            />
          )}
        </div>
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
            className="absolute inset-0 bg-black/30 dark:bg-black/60"
            onClick={() => setConfirmDelete(false)}
          />
          <div className="relative bg-white rounded-lg shadow-xl max-w-sm w-full mx-4 p-5 dark:bg-surface-subtle dark:border dark:border-line">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-ink">
              Delete this pattern?
            </h3>
            <p className="text-[12px] text-gray-600 dark:text-ink-muted mt-1">
              All training documents and regions in &ldquo;{form.name}&rdquo; will
              be removed. This delete is only allowed when no Import
              Builder rule cells reference the pattern.
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

      <DependencyBlockerDialog
        open={deleteDependencyReport != null}
        report={deleteDependencyReport}
        onClose={() => setDeleteDependencyReport(null)}
      />

      {/* ---- Page-deletion confirm dialog ---------------------- */}
      {/* Mandatory because page deletion is NOT undoable today: the
          region cascade is undoable via `useRegionHistory`, but the
          source_files mutation is not, and re-binding undo to also
          revive the page would require tracking source-file history
          (out of scope). We therefore require an explicit confirm and
          name the impact (region count to be removed). */}
      {pageToDelete != null && activeFile && (
        <PageDeleteConfirm
          page={pageToDelete}
          file={activeFile}
          regionCount={regions.filter(
            (r) =>
              r.source_file_id === activeFile.id &&
              r.page === pageToDelete,
          ).length}
          onCancel={() => setPageToDelete(null)}
          onConfirm={handleConfirmDeletePage}
        />
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
        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-[11.5px] text-gray-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink"
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

// ---------------------------------------------------------------------------
// ToolPicker
// ---------------------------------------------------------------------------

/**
 * Segmented control for the active viewer tool. Buttons are pressed-in
 * when active and surface the keyboard shortcut in the tooltip; the
 * polygon entry adds a "coming soon" suffix because the underlying
 * editor surface is deferred (the data model accepts polygons but the
 * draw-by-clicks UI isn't built yet).
 *
 * Wired to / from the same `viewer-tools` constants the keyboard
 * shortcut hook reads — single source of truth for tool ids, labels,
 * and shortcut letters.
 */
function ToolPicker({
  value,
  onChange,
  disabled,
}: {
  value: ViewerTool;
  onChange: (next: ViewerTool) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="inline-flex items-center rounded-md border border-gray-300 bg-white overflow-hidden dark:border-line dark:bg-surface-subtle"
      role="radiogroup"
      aria-label="Editor tool"
    >
      {VIEWER_TOOLS.map((t) => {
        const Icon = t.icon;
        const active = value === t.id;
        const tip = t.comingSoon
          ? `${t.hint}`
          : `${t.label} (${t.shortcut})`;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={t.label}
            disabled={disabled}
            onClick={() => onChange(t.id)}
            title={tip}
            className={cn(
              // `relative` for the active lime indicator dot below.
              "relative px-2 py-1 text-[11.5px] flex items-center gap-1 transition-colors",
              "border-r border-gray-200 last:border-r-0 dark:border-line",
              active
                ? "bg-brand-50 text-brand-800 dark:bg-brand-900/40 dark:text-brand-50"
                : // Hover gets a Sky Cyan tint instead of plain gray.
                  "text-gray-700 hover:bg-rivera-cyan/10 dark:text-ink-muted dark:hover:bg-rivera-cyan/15",
              t.comingSoon &&
                active &&
                "bg-amber-50 text-amber-800 dark:bg-yellow-950/40 dark:text-yellow-200",
              disabled && "opacity-50 cursor-not-allowed",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {/* Active tool gets a tiny Electric Lime dot top-right —
                Rivera selected accent. Hidden on the comingSoon
                amber state so the warning tone reads cleanly. */}
            {active && !t.comingSoon && (
              <span
                aria-hidden
                className="pointer-events-none absolute top-0.5 right-0.5 h-1 w-1 rounded-full bg-rivera-lime"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ZoomControls
// ---------------------------------------------------------------------------

/**
 * Zoom toolbar — minus / value-as-reset-button / plus, plus fit-width
 * and fit-page convenience buttons. The percentage label doubles as the
 * "reset to 100%" click target so the affordance stays compact.
 *
 * The two fit buttons are simple "set zoom to 1.0 / 0.85" today;
 * fitting against actual container width would require a live measurement
 * of the viewer surface, which we'll add when there's a clear ergonomic
 * win (single-page wide PDFs at small viewports). The current behaviour
 * still gives the operator two reasonable presets.
 */
function ZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFitWidth,
  onFitPage,
  min,
  max,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onFitWidth: () => void;
  onFitPage: () => void;
  min: number;
  max: number;
}) {
  const pct = Math.round(zoom * 100);
  return (
    <div className="inline-flex items-center gap-1">
      <div className="inline-flex items-center rounded-md border border-gray-300 bg-white overflow-hidden dark:border-line dark:bg-surface-subtle">
        <button
          type="button"
          className="px-1.5 py-1 text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:text-ink-muted dark:hover:bg-surface-muted"
          onClick={onZoomOut}
          disabled={zoom <= min}
          title="Zoom out (Ctrl/Cmd -)"
          aria-label="Zoom out"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="px-2 py-1 text-[11.5px] tabular-nums text-gray-800 hover:bg-gray-50 border-l border-r border-gray-200 min-w-[3rem] dark:text-ink dark:hover:bg-surface-muted dark:border-line"
          onClick={onResetZoom}
          title="Reset to 100% (Ctrl/Cmd 0)"
          aria-label="Reset zoom to 100%"
        >
          {pct}%
        </button>
        <button
          type="button"
          className="px-1.5 py-1 text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:text-ink-muted dark:hover:bg-surface-muted"
          onClick={onZoomIn}
          disabled={zoom >= max}
          title="Zoom in (Ctrl/Cmd +)"
          aria-label="Zoom in"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <button
        type="button"
        onClick={onFitWidth}
        className="px-1.5 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-line dark:bg-surface-subtle dark:text-ink-muted dark:hover:bg-surface-muted"
        title="Fit width"
        aria-label="Fit page width"
      >
        <StretchHorizontal className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onFitPage}
        className="px-1.5 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-line dark:bg-surface-subtle dark:text-ink-muted dark:hover:bg-surface-muted"
        title="Fit page"
        aria-label="Fit whole page"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ViewModeToggle
// ---------------------------------------------------------------------------

/**
 * Three-state segmented toggle for the page view mode:
 *
 *   * "single"      — One page at a time. Default; matches the editor's
 *                     historical behaviour.
 *   * "continuous"  — Vertical scroll of all visible pages. Useful for
 *                     skimming long PDFs to find a region to draw on
 *                     (the operator often knows the page by appearance,
 *                     not number).
 *   * "thumbnails"  — Page-thumbnails sidebar + the regular single-page
 *                     viewer. Lets the operator jump between pages
 *                     visually without giving up the focused-edit
 *                     experience.
 *
 * Hidden by the parent when the active file has only one visible page
 * (no choice to make).
 */
function ViewModeToggle({
  value,
  onChange,
}: {
  value: "single" | "continuous" | "thumbnails";
  onChange: (next: "single" | "continuous" | "thumbnails") => void;
}) {
  const items: {
    id: "single" | "continuous" | "thumbnails";
    label: string;
    icon: typeof Square;
    title: string;
  }[] = [
    {
      id: "single",
      label: "Single",
      icon: Square,
      title: "Single page",
    },
    {
      id: "continuous",
      label: "Scroll",
      icon: Rows3,
      title: "Continuous vertical scroll",
    },
    {
      id: "thumbnails",
      label: "Thumbs",
      icon: LayoutGrid,
      title: "Thumbnail rail",
    },
  ];
  return (
    <div
      className="inline-flex items-center rounded-md border border-gray-300 bg-white overflow-hidden dark:border-line dark:bg-surface-subtle"
      role="radiogroup"
      aria-label="View mode"
    >
      {items.map((it) => {
        const Icon = it.icon;
        const active = value === it.id;
        return (
          <button
            key={it.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={it.label}
            onClick={() => onChange(it.id)}
            title={it.title}
            className={cn(
              // `relative` for the active lime indicator dot.
              "relative px-2 py-1 text-[11.5px] flex items-center gap-1 transition-colors",
              "border-r border-gray-200 last:border-r-0 dark:border-line",
              active
                ? "bg-brand-50 text-brand-800 dark:bg-brand-900/40 dark:text-brand-50"
                : // Sky Cyan hover wash so the segmented control
                  // shares the cyan interaction language.
                  "text-gray-700 hover:bg-rivera-cyan/10 dark:text-ink-muted dark:hover:bg-rivera-cyan/15",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {/* Active mode gets a tiny Electric Lime dot — same
                Rivera selected accent as the ToolPicker above. */}
            {active && (
              <span
                aria-hidden
                className="pointer-events-none absolute top-0.5 right-0.5 h-1 w-1 rounded-full bg-rivera-lime"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PageDeleteConfirm
// ---------------------------------------------------------------------------

/**
 * Confirm dialog for hiding (`deleted_pages`) one page from a source
 * file. Mandatory because the action is not part of the region undo
 * stack — we re-anchor history (via `resetRegions`) so undo can't
 * resurrect orphan regions referencing a now-deleted page. Naming the
 * region count up-front gives the operator a chance to back out before
 * losing work.
 */
function PageDeleteConfirm({
  page,
  file,
  regionCount,
  onCancel,
  onConfirm,
}: {
  page: number;
  file: InvoicePatternSourceFile;
  regionCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/30 dark:bg-black/60"
        onClick={onCancel}
      />
      <div className="relative bg-white rounded-lg shadow-xl max-w-sm w-full mx-4 p-5 dark:bg-surface-subtle dark:border dark:border-line">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-ink">
          Delete page {page} from {file.file_name}?
        </h3>
        <p className="text-[12px] text-gray-600 dark:text-ink-muted mt-1">
          This page will be hidden from the editor and skipped at
          extraction time.{" "}
          {regionCount > 0 ? (
            <span className="text-amber-700 dark:text-yellow-200">
              {regionCount} region{regionCount === 1 ? "" : "s"} pinned
              to this page will be removed.
            </span>
          ) : (
            <span>No regions on this page.</span>
          )}{" "}
          You can&apos;t undo this from the region history — recover by
          re-uploading the file.
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={onConfirm}
          >
            Delete page
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RightRailTabs
// ---------------------------------------------------------------------------

/**
 * Two-tab strip for the right rail (Region | Coverage). Coverage
 * carries an optional pill with the number of unsatisfied required
 * columns so the operator notices it without having to flip tabs to
 * see whether anything's broken.
 *
 * Kept inline (not a generic tabs primitive) because there are exactly
 * two tabs and the badge logic is trivial — adding a Tabs component
 * would be over-engineering for one consumer.
 */
function RightRailTabs({
  tab,
  onChange,
  coverageBadge,
}: {
  tab: "region" | "coverage";
  onChange: (next: "region" | "coverage") => void;
  /**
   * Number of unsatisfied required columns rolled up across every
   * template in the coverage response. Surfaced as an amber pill on
   * the Coverage tab; zero hides the pill.
   */
  coverageBadge: number;
}) {
  return (
    <div
      role="tablist"
      aria-label="Right rail"
      className="flex items-center border-b border-gray-200 bg-gray-50 px-1 dark:border-line dark:bg-surface-muted"
    >
      <TabButton
        active={tab === "region"}
        onClick={() => onChange("region")}
        label="Region"
      />
      <TabButton
        active={tab === "coverage"}
        onClick={() => onChange("coverage")}
        label="Coverage"
        badge={
          coverageBadge > 0 ? (
            <span
              className="ml-1 px-1.5 py-[1px] rounded-full text-[9px] font-bold bg-amber-100 text-amber-800 tabular-nums dark:bg-yellow-950/40 dark:text-yellow-200"
              title={`${coverageBadge} required column${
                coverageBadge === 1 ? "" : "s"
              } unresolved`}
            >
              {coverageBadge}
            </span>
          ) : null
        }
      />
    </div>
  );
}

function TabButton({
  active,
  label,
  badge,
  onClick,
}: {
  active: boolean;
  label: string;
  badge?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        // `relative` + the lime indicator below: active tab gets a
        // small Electric Lime underline accent on top of the brand
        // bottom border so the active state reads as a Rivera
        // selection, not a generic Tailwind tab.
        "relative px-3 py-1.5 text-[12px] font-medium border-b-2 -mb-px transition-colors",
        active
          ? "border-rivera-blue text-brand-800 bg-white dark:bg-surface-subtle dark:text-brand-50"
          : // Idle hover gets a Sky Cyan tint — cyan in the chrome
            // around the tabs so the segmented control feels alive.
            "border-transparent text-gray-600 hover:text-gray-800 hover:bg-rivera-cyan/10 dark:text-ink-muted dark:hover:text-ink dark:hover:bg-rivera-cyan/15",
      )}
    >
      {label}
      {badge}
      {/* Electric Lime micro-bar under the active tab — sits on top
          of the existing brand bottom border for a 2-tone selected
          indicator. Kept thin (1.5px) so it reads as accent, not
          decoration. */}
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-2 right-2 -bottom-px h-[2px] rounded-full bg-rivera-lime"
        />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ImportTemplateScopeSelect
// ---------------------------------------------------------------------------

/**
 * Toolbar dropdown that filters the right-rail Coverage panel + the
 * region-overlay association badges to a single Import Builder
 * template (or "All templates"). The list is sourced from the
 * coverage response so every workspace template appears, including
 * templates that don't reference this pattern — the operator can flip
 * to one and immediately see the empty "no fields used" state to
 * confirm the wiring is intentional.
 *
 * Read-only narrowing: changing the scope NEVER writes back to either
 * the pattern or the templates. It's a UI filter, not a binding.
 */
interface ImportTemplateScopeSelectOption {
  template_id: string;
  template_name: string;
  used_field_keys: readonly string[];
}

function ImportTemplateScopeSelect({
  templates,
  value,
  onChange,
  disabled,
}: {
  templates: readonly ImportTemplateScopeSelectOption[];
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
}) {
  // Surface the wired count in the trigger ("All · 4 use this") so the
  // operator gets a one-glance "is this pattern reaching anything?"
  // before opening the dropdown.
  const wiredCount = templates.filter(
    (t) => t.used_field_keys.length > 0,
  ).length;
  const totalCount = templates.length;

  return (
    <div className="flex items-center gap-1.5">
      <GitBranch
        className="h-3 w-3 text-gray-500 dark:text-ink-subtle shrink-0"
        aria-hidden
      />
      <span className="text-[11px] text-gray-600 dark:text-ink-muted">
        Template:
      </span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-[11.5px] text-gray-800 max-w-[14rem] focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-gray-50 disabled:text-gray-400 dark:border-line dark:bg-surface dark:text-ink dark:disabled:bg-surface-muted dark:disabled:text-ink-subtle"
        title="Filter coverage + region badges to one Import Builder template"
      >
        <option value="">
          {totalCount === 0
            ? "No templates yet"
            : `All templates · ${wiredCount} of ${totalCount} use this`}
        </option>
        {templates.map((t) => (
          <option key={t.template_id} value={t.template_id}>
            {t.used_field_keys.length > 0 ? "● " : "○ "}
            {t.template_name}
          </option>
        ))}
      </select>
    </div>
  );
}
