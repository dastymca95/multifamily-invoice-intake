"use client";

import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  FileText,
  FileWarning,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  UploadCloud,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { getApiErrorMessage, propertyCatalogsApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  applyMappingToSourceRows,
  CANONICAL_PROPERTY_FIELDS,
  type CanonicalPropertyFieldKey,
  emptyPropertyUploadMapping,
  type MergedPropertyResult,
  mergePropertyFiles,
  newEntryId,
  type ParsedPropertyUpload,
  type PropertyCatalogCreate,
  type PropertyCatalogDefault,
  type PropertyCatalogEntry,
  type PropertyCatalogSource,
  type PropertyFileContribution,
  type PropertyUploadMapping,
  validatePropertyEntries,
} from "@/types/property-catalog";

/**
 * "New property catalog" dialog — a three-step wizard with multi-file
 * upload support.
 *
 * Step 1 — SETUP (size=md):
 *   * Name + description
 *   * Pick a starter mode: default / from_upload (a "from blank" mode
 *     is intentionally NOT offered — property catalogs always start
 *     from either the canonical default or a real uploaded property /
 *     unit roster, so the saved catalog matches BillsIQ's canonical
 *     structure from row one).
 *   * `from_upload` reveals a session-local upload sub-card that
 *     accepts ONE OR MORE files. Each file is parsed independently;
 *     parsed files appear as chips with metadata + a remove button.
 *     Per-file errors are inline on the chip and don't block other
 *     files.
 *   * Primary button is "Create catalog" for default, but
 *     "Continue to mapping →" for from_upload (since the canonical
 *     entries don't exist yet — they'll be assembled from confirmed
 *     mappings + a cross-file merge in steps 2 and 3).
 *
 * Step 2 — MAPPING (size=xl, only reached for from_upload):
 *   * Tabs across the top — one per uploaded file. Each tab shows a
 *     small status badge: "ready" once that file's required fields
 *     are mapped; "incomplete" otherwise.
 *   * For the active file: <select> per canonical BillsIQ property
 *     field, populated with that file's source columns + a "— None —"
 *     sentinel.
 *   * Pre-seeded from each file's `suggested_mapping`. Always shown
 *     to the user — never silently committed.
 *   * "Continue to preview →" gates on EVERY file having at least one
 *     of property_code or property_name mapped (so each contributes
 *     identifiable rows). The merge does the heavy lifting in step 3.
 *
 * Step 3 — PREVIEW (size=xl, only reached for from_upload):
 *   * Runs the cross-file merge with first-non-null-wins + property-
 *     level donor broadcast.
 *   * Stats line: total source rows in / final rows out / dupes merged
 *     / donors absorbed / units enriched.
 *   * Preview table: first PREVIEW_ROW_LIMIT entries.
 *   * Validation: blocks save if any final row is missing required
 *     fields or any (property_code, unit_number) pair duplicates.
 *   * Save button submits the final merged entries to the create API.
 *
 * Why explicit mapping + merge instead of auto-build:
 *
 *   The uploaded files' column names can be anything, and one file
 *   might carry property-level fields while another carries unit-
 *   level ones. Auto-mapping would hide misdetections AND fail to
 *   express the user's intent about which file contributes what.
 *   The mapping step makes the source → canonical mapping explicit
 *   and overridable per file; the merge step makes the cross-file
 *   contribution visible BEFORE saving.
 */

interface NewPropertyCatalogModalProps {
  open: boolean;
  saving: boolean;
  error: string | null;
  defaultCatalog: PropertyCatalogDefault | null;

  onClose: () => void;
  onCreate: (body: PropertyCatalogCreate) => Promise<void>;
}

// Note: "blank" is deliberately NOT a valid start mode for property
// catalogs. Property catalogs must always start from either the
// canonical default or a real uploaded property / unit roster, so the
// saved catalog conforms to BillsIQ's canonical property structure
// from the first row. Already-saved catalogs with `source = "blank"`
// (created before this restriction) keep working — only the CREATION
// path is restricted.
type StartMode = "default" | "from_upload";
type Step = "setup" | "mapping" | "preview";

const ACCEPTED_FILE_TYPES = ".xlsx,.xls,.csv";
const PREVIEW_ROW_LIMIT = 8;

/**
 * One file the user uploaded inside this open of the modal. The
 * `parsed` snapshot is whatever the backend returned; `mapping` is
 * the user-edited mapping that drives this file's contribution to
 * the merged result.
 */
interface UploadedFile {
  /** Stable client-side id used as React key + active-file selector. */
  id: string;
  parsed: ParsedPropertyUpload;
  mapping: PropertyUploadMapping;
}

export function NewPropertyCatalogModal({
  open,
  saving,
  error,
  defaultCatalog,
  onClose,
  onCreate,
}: NewPropertyCatalogModalProps) {
  const [step, setStep] = useState<Step>("setup");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<StartMode | null>(null);

  // Multi-file session state. All uploads in `files` were parsed
  // inside THIS open of the modal. Files with parse warnings (no
  // header found) are kept so the user can see the soft failure and
  // either remove them or try a replacement.
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  // Per-file upload progress, keyed by an ephemeral upload-attempt id
  // so we can show multiple parallel parses without leaking state.
  const [uploadingCount, setUploadingCount] = useState(0);
  // Most-recent upload error (since the last file attempt). One slot
  // is plenty — users typically retry by adding the file again.
  const [uploadError, setUploadError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset on (re)open. Mode → null forces an explicit pick; the
  // session uploads are dropped so files from a previous open don't
  // carry over.
  useEffect(() => {
    if (open) {
      setStep("setup");
      setName("");
      setDescription("");
      setMode(null);
      setFiles([]);
      setActiveFileId(null);
      setUploadingCount(0);
      setUploadError(null);
    }
  }, [open]);

  // If default mode becomes invalid mid-flow, drop back to `null`.
  useEffect(() => {
    if (mode === "default" && !defaultCatalog) setMode(null);
  }, [mode, defaultCatalog]);

  // When entering the mapping step, default the active file to the
  // first one. Subsequent file additions don't auto-switch (would be
  // jarring if the user is mid-mapping).
  useEffect(() => {
    if (step === "mapping" && activeFileId == null && files.length > 0) {
      setActiveFileId(files[0].id);
    }
  }, [step, activeFileId, files]);

  // Convenience derivations -------------------------------------------------

  const trimmedName = name.trim();

  const usableFiles = useMemo(
    () => files.filter((f) => f.parsed.source_columns.length > 0),
    [files],
  );

  // For the per-file mapping gate. A file is "ready" when at least one
  // of property_code or property_name is mapped — that gives the row
  // an identity the merge can key on.
  const fileIsReady = (f: UploadedFile): boolean => {
    const code = f.mapping.property_code;
    const namev = f.mapping.property_name;
    return (code != null && code.length > 0) || (namev != null && namev.length > 0);
  };

  const allFilesReady =
    usableFiles.length > 0 && usableFiles.every(fileIsReady);

  // -------- Merged result for the preview step ----------------------------
  //
  // Captures aggregate per-file mapping stats (blank-identity drops +
  // summary-row drops) alongside the merge stats so the preview can
  // surface them. These are accumulated across every contributing file
  // — they're how the user learns that, e.g. a Yardi "Total" footer
  // row was dropped at the materialization layer rather than slipping
  // into the saved catalog as a ghost `Total / Total` entry.
  const mergedWithStats: {
    merged: MergedPropertyResult;
    blankIdentitySkipped: number;
    summaryRowsSkipped: number;
  } | null = useMemo(() => {
    if (step !== "preview") return null;
    let blankIdentitySkipped = 0;
    let summaryRowsSkipped = 0;
    const contributions: PropertyFileContribution[] = usableFiles.map((f) => {
      const mapped = applyMappingToSourceRows(
        f.parsed.source_columns,
        f.parsed.source_rows,
        f.mapping,
      );
      blankIdentitySkipped += mapped.blankIdentityCount;
      summaryRowsSkipped += mapped.summaryRowsSkipped;
      return { filename: f.parsed.filename, entries: mapped.entries };
    });
    return {
      merged: mergePropertyFiles(contributions),
      blankIdentitySkipped,
      summaryRowsSkipped,
    };
  }, [step, usableFiles]);

  const merged: MergedPropertyResult | null = mergedWithStats?.merged ?? null;

  const validation = useMemo(
    () =>
      merged
        ? validatePropertyEntries(merged.entries)
        : { ok: false, missingRequired: 0, duplicatePairs: 0 },
    [merged],
  );

  // ---- Setup-step submit gating ------------------------------------------

  const setupReadyForFromUpload = mode === "from_upload" && usableFiles.length > 0;
  const setupReadyForDirectCreate = mode === "default";

  const canAdvanceFromSetup =
    mode != null &&
    trimmedName.length > 0 &&
    !saving &&
    uploadingCount === 0 &&
    (setupReadyForFromUpload || setupReadyForDirectCreate);

  // ---- Mapping-step submit gating ----------------------------------------

  const canAdvanceFromMapping = allFilesReady && !saving;

  // ---- Preview-step submit gating ----------------------------------------

  const canSavePreview =
    !saving &&
    merged != null &&
    merged.entries.length >= 1 &&
    validation.ok;

  // ---- Action handlers ---------------------------------------------------

  const buildDirectEntries = (): PropertyCatalogEntry[] => {
    // Only "default" reaches here — "from_upload" goes through the
    // mapping + preview steps, and "blank" is no longer an offered
    // start mode. canAdvanceFromSetup gates so this is never called
    // when defaultCatalog is null.
    if (mode === "default" && defaultCatalog) {
      return defaultCatalog.entries.map((e) => ({
        ...e,
        // Re-key client-side so the new draft owns its ids — keeps
        // the canonical default's `d-N` ids out of saved catalogs.
        id: newEntryId(),
      }));
    }
    return [];
  };

  const handleSetupPrimary = async () => {
    if (!canAdvanceFromSetup || mode == null) return;
    if (mode === "from_upload") {
      setStep("mapping");
      return;
    }
    await onCreate({
      name: trimmedName,
      description: description.trim() ? description.trim() : null,
      entries: buildDirectEntries(),
      source: "default",
    });
  };

  const handleMappingContinue = () => {
    if (!canAdvanceFromMapping) return;
    setStep("preview");
  };

  const handleConfirmPreview = async () => {
    if (!canSavePreview || merged == null) return;
    await onCreate({
      name: trimmedName,
      description: description.trim() ? description.trim() : null,
      entries: merged.entries,
      source: "from_upload" as PropertyCatalogSource,
    });
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  /**
   * Process one or more files chosen by the user. Each file is parsed
   * independently — a failure on one doesn't block the others. Newly-
   * parsed files are appended in the order they were picked.
   */
  const handleFilesChosen = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const picked = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ""; // allow re-picking the same file later
    if (picked.length === 0) return;

    setUploadError(null);
    setMode("from_upload");
    setUploadingCount((n) => n + picked.length);

    // Parse in parallel; don't fail-fast — collect each result/error.
    const results = await Promise.all(
      picked.map(async (file) => {
        try {
          const parsed = await propertyCatalogsApi.parseUpload(file);
          return { ok: true as const, parsed };
        } catch (err) {
          return {
            ok: false as const,
            filename: file.name,
            message: getApiErrorMessage(
              err,
              `Couldn't parse ${file.name}. Make sure it's a .csv or .xlsx with a header row.`,
            ),
          };
        }
      }),
    );

    setUploadingCount((n) => Math.max(0, n - picked.length));

    const newFiles: UploadedFile[] = [];
    const errs: string[] = [];
    for (const r of results) {
      if (r.ok) {
        newFiles.push({
          id: newEntryId(),
          parsed: r.parsed,
          mapping: { ...r.parsed.suggested_mapping },
        });
      } else {
        errs.push(r.message);
      }
    }
    if (newFiles.length > 0) {
      setFiles((curr) => [...curr, ...newFiles]);
    }
    if (errs.length > 0) {
      setUploadError(errs.join(" "));
    }
  };

  const removeFile = (id: string) => {
    setFiles((curr) => curr.filter((f) => f.id !== id));
    if (activeFileId === id) {
      setActiveFileId((prev) => {
        const remaining = files.filter((f) => f.id !== id);
        return remaining.length > 0 ? remaining[0].id : null;
      });
    }
  };

  const updateMapping = (
    fileId: string,
    field: CanonicalPropertyFieldKey,
    sourceColumn: string | null,
  ) => {
    setFiles((curr) =>
      curr.map((f) =>
        f.id === fileId
          ? { ...f, mapping: { ...f.mapping, [field]: sourceColumn } }
          : f,
      ),
    );
  };

  // ---- Render ------------------------------------------------------------

  const modalSize: "md" | "xl" = step === "setup" ? "md" : "xl";
  const modalTitle =
    step === "setup"
      ? "New property catalog"
      : step === "mapping"
        ? `Map columns from ${usableFiles.length} file${usableFiles.length === 1 ? "" : "s"}`
        : "Review merged property table";

  return (
    <Modal open={open} onClose={onClose} title={modalTitle} size={modalSize}>
      {step === "setup" && (
        <SetupStep
          name={name}
          description={description}
          mode={mode}
          defaultCatalog={defaultCatalog}
          files={files}
          uploadingCount={uploadingCount}
          uploadError={uploadError}
          error={error}
          saving={saving}
          canAdvance={canAdvanceFromSetup}
          fileInputRef={fileInputRef}
          onNameChange={setName}
          onDescriptionChange={setDescription}
          onModeChange={setMode}
          onUploadClick={openFilePicker}
          onFilesChosen={handleFilesChosen}
          onRemoveFile={removeFile}
          onCancel={onClose}
          onPrimary={() => void handleSetupPrimary()}
        />
      )}
      {step === "mapping" && (
        <MappingStep
          files={usableFiles}
          activeFileId={activeFileId}
          allFilesReady={allFilesReady}
          canContinue={canAdvanceFromMapping}
          saving={saving}
          mutationError={error}
          onSelectFile={setActiveFileId}
          onMappingChange={updateMapping}
          onBack={() => setStep("setup")}
          onCancel={onClose}
          onContinue={handleMappingContinue}
        />
      )}
      {step === "preview" && (
        <PreviewStep
          files={usableFiles}
          merged={merged}
          blankIdentitySkipped={mergedWithStats?.blankIdentitySkipped ?? 0}
          summaryRowsSkipped={mergedWithStats?.summaryRowsSkipped ?? 0}
          validation={validation}
          canSave={canSavePreview}
          saving={saving}
          mutationError={error}
          onBack={() => setStep("mapping")}
          onCancel={onClose}
          onSave={() => void handleConfirmPreview()}
        />
      )}
    </Modal>
  );
}

// ===========================================================================
// Step 1 — SETUP
// ===========================================================================

interface SetupStepProps {
  name: string;
  description: string;
  mode: StartMode | null;
  defaultCatalog: PropertyCatalogDefault | null;
  files: UploadedFile[];
  uploadingCount: number;
  uploadError: string | null;
  error: string | null;
  saving: boolean;
  canAdvance: boolean;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onNameChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onModeChange: (m: StartMode) => void;
  onUploadClick: () => void;
  onFilesChosen: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveFile: (id: string) => void;
  onCancel: () => void;
  onPrimary: () => void;
}

function SetupStep({
  name,
  description,
  mode,
  defaultCatalog,
  files,
  uploadingCount,
  uploadError,
  error,
  saving,
  canAdvance,
  fileInputRef,
  onNameChange,
  onDescriptionChange,
  onModeChange,
  onUploadClick,
  onFilesChosen,
  onRemoveFile,
  onCancel,
  onPrimary,
}: SetupStepProps) {
  const usableCount = files.filter(
    (f) => f.parsed.source_columns.length > 0,
  ).length;

  const primaryLabel =
    mode === "from_upload" ? (
      <>
        Continue to mapping
        <ArrowRight className="h-3.5 w-3.5" />
      </>
    ) : (
      "Create catalog"
    );

  return (
    <div className="space-y-3">
      <div>
        <FieldLabel htmlFor="new-prop-name">Name</FieldLabel>
        <input
          id="new-prop-name"
          type="text"
          value={name}
          autoFocus
          maxLength={255}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Multifamily Portfolio 2026"
          className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink dark:placeholder:text-ink-subtle"
        />
      </div>

      <div>
        <FieldLabel htmlFor="new-prop-desc">Description</FieldLabel>
        <textarea
          id="new-prop-desc"
          value={description}
          rows={2}
          placeholder="Optional — what's this catalog for?"
          onChange={(e) => onDescriptionChange(e.target.value)}
          className="w-full resize-none rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink dark:placeholder:text-ink-subtle"
        />
      </div>

      <div>
        <FieldLabel>Starting rows</FieldLabel>
        <div className="grid gap-1.5">
          <StartOption
            icon={Sparkles}
            title="From canonical default"
            description={
              defaultCatalog
                ? `Start with ${defaultCatalog.entries.length} sample rows across three multifamily properties. Edit, add, or remove rows after creating.`
                : "Default catalog unavailable — try again later."
            }
            selected={mode === "default"}
            disabled={!defaultCatalog}
            onSelect={() => onModeChange("default")}
          />

          <div className="space-y-1.5">
            <StartOption
              icon={Upload}
              title="From uploaded files"
              description={
                usableCount > 0
                  ? `Use ${usableCount} uploaded file${usableCount === 1 ? "" : "s"}. Map each file's columns to BillsIQ's property fields next; multiple files merge into one canonical table.`
                  : "Upload one OR MORE files (CSV / Excel) — e.g. a property list AND a unit roster. We'll surface each file's columns so you can map them to BillsIQ's property fields, then merge across files into one canonical table."
              }
              selected={mode === "from_upload"}
              onSelect={() => onModeChange("from_upload")}
            />
            {mode === "from_upload" && (
              <UploadedSourceCard
                files={files}
                uploadingCount={uploadingCount}
                uploadError={uploadError}
                onUploadClick={onUploadClick}
                onRemove={onRemoveFile}
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              multiple
              className="hidden"
              onChange={(e) => void onFilesChosen(e)}
            />
          </div>
        </div>
      </div>

      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {mode === "default" && !defaultCatalog && (
        <InlineAlert
          tone="warning"
          title="Couldn't load the default catalog"
        >
          Pick another start option for now — defaults will return on
          the next page load.
        </InlineAlert>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={saving || uploadingCount > 0}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={!canAdvance}
          loading={saving && mode !== "from_upload"}
          onClick={onPrimary}
        >
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
}

// ===========================================================================
// Step 1 sub-card — multi-file uploads
// ===========================================================================

function UploadedSourceCard({
  files,
  uploadingCount,
  uploadError,
  onUploadClick,
  onRemove,
}: {
  files: UploadedFile[];
  uploadingCount: number;
  uploadError: string | null;
  onUploadClick: () => void;
  onRemove: (id: string) => void;
}) {
  const hasFiles = files.length > 0;

  return (
    <div className="ml-10 rounded-md border border-gray-200 bg-gray-50/50 px-3 py-2.5 text-[11px] dark:border-line dark:bg-surface-muted/50">
      <p className="text-[9.5px] uppercase tracking-wide text-gray-400 font-semibold mb-1.5 dark:text-ink-subtle">
        Files for this draft
      </p>

      {hasFiles ? (
        <ul className="space-y-1.5">
          {files.map((f) => (
            <FileChip
              key={f.id}
              file={f}
              onRemove={() => onRemove(f.id)}
            />
          ))}
        </ul>
      ) : uploadingCount === 0 ? (
        <p className="text-gray-600 dark:text-ink-muted">
          No files picked yet. Upload one or more property/unit files
          (CSV or Excel) to use as the starting point.
        </p>
      ) : null}

      {uploadingCount > 0 && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-gray-700 font-medium dark:text-ink-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-600" />
          Reading {uploadingCount} file{uploadingCount === 1 ? "" : "s"}…
        </p>
      )}

      {uploadError && uploadingCount === 0 && (
        <p className="mt-2 inline-flex items-start gap-1.5 text-red-600 text-[11px] dark:text-red-400">
          <FileWarning className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{uploadError}</span>
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onUploadClick}
          disabled={uploadingCount > 0}
        >
          {hasFiles ? (
            <>
              <Plus className="h-3.5 w-3.5" />
              Add another file
            </>
          ) : (
            <>
              <UploadCloud className="h-3.5 w-3.5" />
              Upload files
            </>
          )}
        </Button>
        <span className="text-[10px] text-gray-500 dark:text-ink-muted">
          {hasFiles
            ? "Add as many as you need — they'll merge into one canonical table."
            : "You can pick multiple files at once."}
        </span>
      </div>

      {hasFiles && (
        <p className="text-[10px] text-gray-400 mt-2 dark:text-ink-subtle">
          Files aren&apos;t stored — only the rows you confirm in the
          mapping step become the saved catalog.
        </p>
      )}
    </div>
  );
}

function FileChip({
  file,
  onRemove,
}: {
  file: UploadedFile;
  onRemove: () => void;
}) {
  const ok = file.parsed.source_columns.length > 0;
  const Icon = ok ? FileText : FileWarning;
  const iconBg = ok ? "bg-brand-50" : "bg-yellow-100";
  const iconColor = ok
    ? "text-brand-700 dark:text-brand-50"
    : "text-yellow-700 dark:text-yellow-200";

  return (
    <li className="flex items-start gap-2 rounded border border-gray-200 bg-white px-2 py-1.5 dark:border-line dark:bg-surface-subtle">
      <div
        className={cn(
          "h-7 w-7 shrink-0 rounded-md flex items-center justify-center",
          iconBg,
        )}
      >
        <Icon className={cn("h-3.5 w-3.5", iconColor)} />
      </div>
      <div className="flex-1 min-w-0">
        <p
          className="text-[12px] font-semibold text-gray-800 truncate dark:text-ink"
          title={file.parsed.filename}
        >
          {file.parsed.filename}
        </p>
        <p className="text-[10.5px] text-gray-600 dark:text-ink-muted">
          {ok ? (
            <>
              <span className="font-medium">
                {file.parsed.source_columns.length}
              </span>{" "}
              col{file.parsed.source_columns.length === 1 ? "" : "s"}
              <span className="text-gray-300 dark:text-line-strong mx-1">·</span>
              <span className="font-medium">
                {file.parsed.source_rows.length}
              </span>{" "}
              row{file.parsed.source_rows.length === 1 ? "" : "s"}
              <span className="text-gray-300 dark:text-line-strong mx-1">·</span>
              {file.parsed.detected_format.toUpperCase()}
            </>
          ) : (
            "No usable columns extracted"
          )}
        </p>
        {file.parsed.parse_warning && (
          <p className="text-[10px] text-yellow-700 italic mt-0.5 dark:text-yellow-200">
            {file.parsed.parse_warning}
          </p>
        )}
      </div>
      <button
        type="button"
        aria-label={`Remove ${file.parsed.filename}`}
        title="Remove this file"
        onClick={onRemove}
        className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 dark:text-ink-subtle dark:hover:text-red-400 dark:hover:bg-red-950/40"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

// ===========================================================================
// Step 2 — MAPPING (per-file tabs)
// ===========================================================================

interface MappingStepProps {
  files: UploadedFile[];
  activeFileId: string | null;
  allFilesReady: boolean;
  canContinue: boolean;
  saving: boolean;
  mutationError: string | null;
  onSelectFile: (id: string) => void;
  onMappingChange: (
    fileId: string,
    field: CanonicalPropertyFieldKey,
    sourceColumn: string | null,
  ) => void;
  onBack: () => void;
  onCancel: () => void;
  onContinue: () => void;
}

function MappingStep({
  files,
  activeFileId,
  allFilesReady,
  canContinue,
  saving,
  mutationError,
  onSelectFile,
  onMappingChange,
  onBack,
  onCancel,
  onContinue,
}: MappingStepProps) {
  const activeFile =
    files.find((f) => f.id === activeFileId) ?? files[0] ?? null;

  if (!activeFile) {
    // Defensive — should be unreachable because the setup step gates on
    // usableFiles.length > 0, but a clear empty state beats a crash.
    return (
      <div className="space-y-3">
        <InlineAlert tone="warning" title="No usable files">
          Go back and upload at least one CSV or Excel file with a
          recognizable header row.
        </InlineAlert>
        <div className="flex justify-between pt-1">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-gray-600 dark:text-ink-muted">
        Match each BillsIQ property field to a column from each uploaded
        file. Every file needs at least <span className="font-semibold">one</span>{" "}
        of <span className="font-semibold">Property Code</span> or{" "}
        <span className="font-semibold">Property Name</span> mapped so
        its rows have an identity. Files don&apos;t need to map the
        same identity field — when one file maps both code and name,
        we use those pairings to match name-only rows from another
        file to code-only rows of the same property in the merge step.
        Address, city, unit type, etc. can come from any single file;
        the merge fills empty cells from contributing rows of the same
        property.
      </p>

      {/* ---- File tabs ----------------------------------------------- */}
      <div className="flex items-center gap-1 border-b border-gray-200 -mx-1 px-1 overflow-x-auto dark:border-line">
        {files.map((f) => {
          const ready =
            (f.mapping.property_code != null && f.mapping.property_code.length > 0) ||
            (f.mapping.property_name != null && f.mapping.property_name.length > 0);
          const isActive = f.id === activeFile.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => onSelectFile(f.id)}
              className={cn(
                "shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-medium border-b-2 -mb-px transition-colors",
                isActive
                  ? "border-brand-600 text-brand-700"
                  : "border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300 dark:text-ink-muted dark:hover:text-ink dark:hover:border-line-strong",
              )}
              aria-pressed={isActive}
            >
              {ready ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <CircleDashed className="h-3.5 w-3.5 text-gray-400 dark:text-ink-subtle" />
              )}
              <span className="truncate max-w-[14rem]" title={f.parsed.filename}>
                {f.parsed.filename}
              </span>
              <span className="text-[10px] text-gray-400 dark:text-ink-subtle">
                ({f.parsed.source_rows.length})
              </span>
            </button>
          );
        })}
      </div>

      {/* ---- Active-file mapping form -------------------------------- */}
      <FileMappingForm
        file={activeFile}
        onChange={(field, col) => onMappingChange(activeFile.id, field, col)}
      />

      {!allFilesReady && (
        <InlineAlert
          tone="warning"
          title="Some files still need a mapping"
        >
          Each file needs Property Code or Property Name mapped before
          you can continue.
        </InlineAlert>
      )}
      {mutationError && <InlineAlert tone="error">{mutationError}</InlineAlert>}

      {/* ---- Footer actions ----------------------------------------- */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          disabled={saving}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canContinue}
            onClick={onContinue}
          >
            Continue to preview
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function FileMappingForm({
  file,
  onChange,
}: {
  file: UploadedFile;
  onChange: (
    field: CanonicalPropertyFieldKey,
    sourceColumn: string | null,
  ) => void;
}) {
  return (
    <div className="rounded-md border border-gray-200 dark:border-line">
      <div className="grid grid-cols-[1fr_1fr] gap-x-4 px-3 py-2 border-b border-gray-200 bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 font-semibold dark:border-line dark:bg-surface-muted dark:text-ink-subtle">
        <span>BillsIQ property field</span>
        <span>Column from {file.parsed.filename}</span>
      </div>
      <div className="divide-y divide-gray-100 max-h-[22rem] overflow-y-auto">
        {CANONICAL_PROPERTY_FIELDS.map((field) => {
          const value = file.mapping[field.key] ?? "";
          return (
            <div
              key={field.key}
              className="grid grid-cols-[1fr_1fr] gap-x-4 px-3 py-2 items-start"
            >
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold text-gray-800 dark:text-ink">
                  {field.label}
                  {field.required && (
                    <span className="text-red-600 ml-0.5 dark:text-red-400">*</span>
                  )}
                </p>
                <p className="text-[10.5px] text-gray-500 mt-0.5 dark:text-ink-muted">
                  {field.hint}
                </p>
              </div>
              <div>
                <select
                  value={value}
                  onChange={(e) =>
                    onChange(
                      field.key,
                      e.target.value === "" ? null : e.target.value,
                    )
                  }
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink"
                >
                  <option value="">— None —</option>
                  {file.parsed.source_columns.map((col, idx) => (
                    <option key={`${col}-${idx}`} value={col}>
                      {col}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===========================================================================
// Step 3 — PREVIEW (merged result)
// ===========================================================================

interface PreviewStepProps {
  files: UploadedFile[];
  merged: MergedPropertyResult | null;
  /** Aggregated across every contributing file's
   * `applyMappingToSourceRows` call. */
  blankIdentitySkipped: number;
  /** Aggregated across every contributing file. Counts footer/summary
   * rows the materialization layer dropped (defense in depth on top
   * of the backend's universal `_is_summary_row` filter). */
  summaryRowsSkipped: number;
  validation: { ok: boolean; missingRequired: number; duplicatePairs: number };
  canSave: boolean;
  saving: boolean;
  mutationError: string | null;
  onBack: () => void;
  onCancel: () => void;
  onSave: () => void;
}

function PreviewStep({
  files,
  merged,
  blankIdentitySkipped,
  summaryRowsSkipped,
  validation,
  canSave,
  saving,
  mutationError,
  onBack,
  onCancel,
  onSave,
}: PreviewStepProps) {
  if (!merged) {
    return (
      <div className="space-y-3">
        <InlineAlert tone="error">
          Couldn&apos;t compute a merged preview. Go back and check the
          mappings.
        </InlineAlert>
        <div className="flex justify-between">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
        </div>
      </div>
    );
  }

  const previewRows = merged.entries.slice(0, PREVIEW_ROW_LIMIT);
  const remainingRows = Math.max(
    0,
    merged.entries.length - previewRows.length,
  );
  const stats = merged.stats;

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-gray-600 dark:text-ink-muted">
        Below is the merged canonical property table built from your{" "}
        <span className="font-medium">{files.length}</span> uploaded
        file{files.length === 1 ? "" : "s"}. Cross-file duplicates
        (same property + unit) collapse to one row; rows from a
        name-only file get matched to rows from a code-bearing file
        when one file pins down the code↔name pairing; property-level
        rows without a matching unit row are kept; property-level rows
        whose property has unit rows are absorbed into them.
      </p>

      {/* ---- Stats line --------------------------------------------- */}
      <ul className="space-y-1 text-[11.5px]">
        <li className="text-gray-700 dark:text-ink-muted">
          <span className="font-semibold text-gray-900 dark:text-ink">
            {stats.totalSourceRows}
          </span>{" "}
          source row{stats.totalSourceRows === 1 ? "" : "s"} →{" "}
          <span className="font-semibold text-gray-900 dark:text-ink">
            {stats.finalRowCount}
          </span>{" "}
          canonical row{stats.finalRowCount === 1 ? "" : "s"}.
        </li>
        {stats.crossFileIdentitiesResolved > 0 && (
          <li className="text-gray-600 dark:text-ink-muted">
            {stats.crossFileIdentitiesResolved} row
            {stats.crossFileIdentitiesResolved === 1 ? "" : "s"} from a
            name-only or code-only file{" "}
            {stats.crossFileIdentitiesResolved === 1 ? "was" : "were"}{" "}
            matched to the same property via another file&apos;s
            code↔name pairing.
          </li>
        )}
        {stats.duplicatePairsMerged > 0 && (
          <li className="text-gray-600 dark:text-ink-muted">
            {stats.duplicatePairsMerged} (property, unit) duplicate
            {stats.duplicatePairsMerged === 1 ? " was" : "s were"}{" "}
            merged across files.
          </li>
        )}
        {stats.donorsAbsorbed > 0 && (
          <li className="text-gray-600 dark:text-ink-muted">
            {stats.donorsAbsorbed} property-level row
            {stats.donorsAbsorbed === 1 ? " was" : "s were"} absorbed
            into matching unit rows.
          </li>
        )}
        {stats.unitsEnrichedFromDonor > 0 && (
          <li className="text-gray-600 dark:text-ink-muted">
            {stats.unitsEnrichedFromDonor} unit row
            {stats.unitsEnrichedFromDonor === 1 ? " was" : "s were"}{" "}
            enriched with property-level fields from a donor row.
          </li>
        )}
        {summaryRowsSkipped > 0 && (
          <li className="text-gray-600 dark:text-ink-muted">
            {summaryRowsSkipped} footer / summary row
            {summaryRowsSkipped === 1 ? " was" : "s were"} dropped
            (Total / Grand Total / similar). These would have surfaced
            as ghost &ldquo;Total&rdquo; entries in the saved catalog.
          </li>
        )}
        {blankIdentitySkipped > 0 && (
          <li className="text-gray-600 dark:text-ink-muted">
            {blankIdentitySkipped} row
            {blankIdentitySkipped === 1 ? " was" : "s were"} dropped
            for missing both Property Code and Property Name.
          </li>
        )}
      </ul>

      {/* ---- Validation --------------------------------------------- */}
      {validation.missingRequired > 0 && (
        <InlineAlert tone="error" title="Missing required fields">
          {validation.missingRequired} merged row
          {validation.missingRequired === 1 ? "" : "s"} still
          {validation.missingRequired === 1 ? " has " : " have "}
          a blank Property Code or Property Name. Go back and map these
          on at least one file.
        </InlineAlert>
      )}
      {validation.duplicatePairs > 0 && (
        <InlineAlert
          tone="error"
          title="Duplicate property + unit pairs"
        >
          {validation.duplicatePairs} duplicate (property, unit) pair
          {validation.duplicatePairs === 1 ? "" : "s"} survived the
          merge. This usually means two files use different identifiers
          for the same row — go back and align the mappings.
        </InlineAlert>
      )}
      {merged.entries.length === 0 && (
        <InlineAlert tone="warning" title="Nothing to save">
          The merged result has zero rows. Go back and check that each
          file has Property Code or Property Name mapped to a column
          with values.
        </InlineAlert>
      )}

      {/* ---- Preview table ------------------------------------------ */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold dark:text-ink-subtle">
            Preview ({previewRows.length} of {merged.entries.length})
          </p>
          {remainingRows > 0 && (
            <p className="text-[10.5px] text-gray-500 dark:text-ink-muted">
              + {remainingRows} more row{remainingRows === 1 ? "" : "s"}{" "}
              not shown
            </p>
          )}
        </div>
        {previewRows.length > 0 ? (
          <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-line">
            <table className="w-full min-w-[64rem] text-[11.5px]">
              <thead className="bg-gray-50 border-b border-gray-200 dark:bg-surface-muted dark:border-line">
                <tr>
                  <th className="text-left font-semibold text-gray-600 px-2 py-1.5 dark:text-ink-muted">
                    Code
                  </th>
                  <th className="text-left font-semibold text-gray-600 px-2 py-1.5 dark:text-ink-muted">
                    Name
                  </th>
                  <th className="text-left font-semibold text-gray-600 px-2 py-1.5 dark:text-ink-muted">
                    Address
                  </th>
                  <th className="text-left font-semibold text-gray-600 px-2 py-1.5 dark:text-ink-muted">
                    City
                  </th>
                  <th className="text-left font-semibold text-gray-600 px-2 py-1.5 dark:text-ink-muted">
                    State
                  </th>
                  <th className="text-left font-semibold text-gray-600 px-2 py-1.5 dark:text-ink-muted">
                    ZIP
                  </th>
                  <th className="text-left font-semibold text-gray-600 px-2 py-1.5 dark:text-ink-muted">
                    Unit
                  </th>
                  <th className="text-left font-semibold text-gray-600 px-2 py-1.5 dark:text-ink-muted">
                    Type
                  </th>
                  <th className="text-left font-semibold text-gray-600 px-2 py-1.5 dark:text-ink-muted">
                    Building
                  </th>
                  <th className="text-left font-semibold text-gray-600 px-2 py-1.5 dark:text-ink-muted">
                    Active
                  </th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-t border-gray-100 odd:bg-white even:bg-gray-50/30 dark:border-line/60 dark:odd:bg-surface dark:even:bg-surface-muted/30"
                  >
                    <td className="px-2 py-1.5 font-mono text-gray-800 dark:text-ink">
                      {entry.property_code || (
                        <span className="text-red-500 dark:text-red-400">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-gray-700 dark:text-ink-muted">
                      {entry.property_name || (
                        <span className="text-red-500 dark:text-red-400">—</span>
                      )}
                    </td>
                    <PreviewCell value={entry.address} />
                    <PreviewCell value={entry.city} />
                    <PreviewCell value={entry.state} />
                    <PreviewCell value={entry.zip} />
                    <PreviewCell value={entry.unit_number} />
                    <PreviewCell value={entry.unit_type} />
                    <PreviewCell value={entry.building} />
                    <td className="px-2 py-1.5">
                      {entry.active ? (
                        <span className="text-emerald-700 dark:text-green-300">
                          Active
                        </span>
                      ) : (
                        <span className="text-gray-500 dark:text-ink-subtle">
                          Inactive
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-gray-300 px-3 py-6 text-center text-[11.5px] text-gray-500 dark:border-line dark:text-ink-muted">
            No rows to preview.
          </div>
        )}
      </div>

      {mutationError && <InlineAlert tone="error">{mutationError}</InlineAlert>}

      {/* ---- Footer actions ----------------------------------------- */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          disabled={saving}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canSave}
            loading={saving}
            onClick={onSave}
          >
            Save catalog
          </Button>
        </div>
      </div>
    </div>
  );
}

function PreviewCell({ value }: { value: string | null }) {
  if (!value)
    return (
      <td className="px-2 py-1.5 text-gray-300 dark:text-ink-subtle">—</td>
    );
  return (
    <td className="px-2 py-1.5 text-gray-700 max-w-[12rem] truncate dark:text-ink-muted" title={value}>
      {value}
    </td>
  );
}

// ===========================================================================
// Shared bits
// ===========================================================================

function StartOption({
  icon: Icon,
  title,
  description,
  selected,
  disabled,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        "w-full text-left rounded-md border px-3 py-2.5 transition-colors flex items-start gap-2.5",
        selected
          ? "border-brand-500 bg-brand-50/60 ring-1 ring-brand-200"
          : "border-gray-200 hover:bg-gray-50 dark:border-line dark:hover:bg-surface-muted",
        disabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
      )}
      aria-pressed={selected}
    >
      <div
        className={cn(
          "h-8 w-8 shrink-0 rounded-md flex items-center justify-center",
          selected ? "bg-brand-100" : "bg-gray-100",
        )}
      >
        <Icon
          className={cn(
            "h-4 w-4",
            selected
              ? "text-brand-700 dark:text-brand-50"
              : "text-gray-600 dark:text-ink-muted",
          )}
        />
      </div>
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            "text-[12.5px] font-semibold",
            selected
              ? "text-brand-800 dark:text-brand-50"
              : "text-gray-800 dark:text-ink",
          )}
        >
          {title}
        </p>
        <p className="text-[10.5px] text-gray-500 mt-0.5 dark:text-ink-muted">
          {description}
        </p>
      </div>
    </button>
  );
}

function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold mb-1 dark:text-ink-subtle"
    >
      {children}
    </label>
  );
}
