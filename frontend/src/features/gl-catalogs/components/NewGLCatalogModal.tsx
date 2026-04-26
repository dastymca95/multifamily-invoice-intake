"use client";

import {
  ArrowLeft,
  ArrowRight,
  FileText,
  FileWarning,
  Loader2,
  RefreshCw,
  Sparkles,
  Upload,
  UploadCloud,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { getApiErrorMessage, glCatalogsApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  applyMappingToSourceRows,
  CANONICAL_GL_FIELDS,
  type CanonicalGLFieldKey,
  emptyGLUploadMapping,
  type GLCatalogCreate,
  type GLCatalogDefault,
  type GLCatalogEntry,
  type GLCatalogSource,
  type GLUploadMapping,
  newEntryId,
  type ParsedGLUpload,
} from "@/types/gl-catalog";

/**
 * "New GL catalog" dialog — a two-step wizard.
 *
 * Step 1 — SETUP (size=md):
 *   * Name + description
 *   * Pick a starter mode: default / from_upload (a "from blank" mode
 *     is intentionally NOT offered — GL catalogs always start from
 *     either the canonical default or a real chart of accounts, so
 *     the saved catalog matches BillsIQ's canonical structure from
 *     row one).
 *   * `from_upload` reveals a session-local upload sub-card. The
 *     parsed result is held in component state ONLY — never persisted
 *     beyond this dialog open.
 *   * Primary button is "Create catalog" for default, but
 *     "Continue to mapping →" for from_upload (since the canonical
 *     entries don't exist yet — they'll be assembled in step 2 from
 *     the user-confirmed mapping).
 *
 * Step 2 — MAPPING (size=lg, only reached for from_upload):
 *   * One <select> per canonical BillsIQ GL field, populated with the
 *     uploaded file's source columns + a "— None —" sentinel.
 *   * Pre-seeded from `parsed.suggested_mapping`. Always shown to the
 *     user — never silently committed. Required fields (code +
 *     description) are marked with an asterisk and gate the Create
 *     button.
 *   * Live preview of the first 5 mapped rows, plus counts of skipped
 *     blank-required rows and de-duplicated codes.
 *   * Back returns to setup with name/description/mode preserved so
 *     the user can replace the file or pick a different start mode
 *     without losing typed input.
 *
 * Why we deliberately split parsing from entry creation:
 *
 *   The uploaded file's column names can be anything. BillsIQ's
 *   canonical GL schema is the source of truth (code / description /
 *   category / active / notes). Auto-mapping headers and silently
 *   building entries from them would hide misdetections from the
 *   user — exactly the failure mode this wizard is designed to
 *   prevent. The mapping step makes the source → canonical mapping
 *   explicit and overridable.
 *
 * Session-local upload state:
 *
 *   The modal is session-local. There is NO persistent "last uploaded
 *   GL chart" slot in the system — uploads are one-shot parses by
 *   design, the file isn't stored. Even so, we belt-and-suspenders the
 *   modal: the upload state and mapping are reset on every (re)open,
 *   so a file the user uploaded in a previous open of the dialog
 *   never carries over.
 */
interface NewGLCatalogModalProps {
  open: boolean;
  saving: boolean;
  error: string | null;
  defaultCatalog: GLCatalogDefault | null;

  onClose: () => void;
  onCreate: (body: GLCatalogCreate) => Promise<void>;
}

// Note: "blank" is deliberately NOT a valid start mode for GL
// catalogs. GL catalogs must always start from either the canonical
// default or a real uploaded chart of accounts, so the saved catalog
// conforms to BillsIQ's canonical GL structure from the first row.
// Already-saved catalogs with `source = "blank"` (created before this
// restriction) keep working — only the CREATION path is restricted.
type StartMode = "default" | "from_upload";
type Step = "setup" | "mapping";

const ACCEPTED_FILE_TYPES = ".xlsx,.xls,.csv";
const PREVIEW_ROW_LIMIT = 5;

export function NewGLCatalogModal({
  open,
  saving,
  error,
  defaultCatalog,
  onClose,
  onCreate,
}: NewGLCatalogModalProps) {
  const [step, setStep] = useState<Step>("setup");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // `null` means "the user hasn't picked a starter yet". We deliberately
  // don't pre-seed any mode on open — opening the modal must feel neutral.
  const [mode, setMode] = useState<StartMode | null>(null);
  // Session-local snapshot of a file the user uploaded INSIDE this open
  // of the modal. Null on every fresh open. We never seed this from
  // anywhere else — that's the whole point of the session-local
  // behavior. It only becomes non-null after a successful parse-upload.
  const [sessionUpload, setSessionUpload] = useState<ParsedGLUpload | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // The user-edited mapping that drives the mapping step. Mirrors
  // `sessionUpload.suggested_mapping` initially but diverges as the
  // user confirms / overrides individual fields.
  const [mapping, setMapping] = useState<GLUploadMapping>(
    emptyGLUploadMapping,
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset on (re)open. Mode → null forces an explicit pick; the session
  // upload + mapping are dropped so any file the user uploaded in a
  // previous open of the modal doesn't carry over into this one.
  useEffect(() => {
    if (open) {
      setStep("setup");
      setName("");
      setDescription("");
      setMode(null);
      setSessionUpload(null);
      setUploading(false);
      setUploadProgress(0);
      setUploadError(null);
      setMapping(emptyGLUploadMapping());
    }
  }, [open]);

  // Whenever a fresh upload lands, reset the mapping to the parser's
  // suggestion. The suggestion is just a hint — the user is expected
  // to confirm / override on the mapping step. Resetting on every new
  // file means a "Replace file" mid-mapping wipes stale mappings that
  // don't exist in the new file's columns.
  useEffect(() => {
    if (sessionUpload && sessionUpload.source_columns.length > 0) {
      setMapping({ ...sessionUpload.suggested_mapping });
    } else {
      setMapping(emptyGLUploadMapping());
    }
  }, [sessionUpload]);

  // If the default mode becomes invalid mid-flow (default fetch failed
  // in the background), drop back to `null` so the user has to make a
  // conscious re-pick. We don't auto-step out of `from_upload` — the
  // user might be on that option specifically to upload one. Submission
  // is gated separately so a from_upload create with no actual file
  // isn't possible.
  useEffect(() => {
    if (mode === "default" && !defaultCatalog) setMode(null);
  }, [mode, defaultCatalog]);

  // "Did the user upload a file with at least one parseable header?"
  // This drives both the setup-step Continue button gating and the
  // sub-card display.
  const sessionUploadHasColumns =
    sessionUpload != null && sessionUpload.source_columns.length > 0;

  const trimmedName = name.trim();

  // ------------------------------------------------------------------
  // Mapping-derived state — only meaningful on step 2.
  // ------------------------------------------------------------------

  const mapped = useMemo(() => {
    if (!sessionUpload || !sessionUploadHasColumns) {
      return null;
    }
    return applyMappingToSourceRows(
      sessionUpload.source_columns,
      sessionUpload.source_rows,
      mapping,
    );
  }, [sessionUpload, sessionUploadHasColumns, mapping]);

  // Required fields gate. The schema enforces this server-side too,
  // but pre-validating here keeps the user unblocked (no
  // round-trip-then-error for a missing column).
  const requiredFieldsMapped =
    mapping.code != null &&
    mapping.code.length > 0 &&
    mapping.description != null &&
    mapping.description.length > 0;

  const canSubmitMapping =
    requiredFieldsMapped &&
    mapped != null &&
    mapped.entries.length >= 1 &&
    !saving;

  // ------------------------------------------------------------------
  // Setup-step submit gating
  // ------------------------------------------------------------------

  // For from_upload, the setup step's primary action is "Continue to
  // mapping". Its gate is just "do we have parseable columns?". For
  // default, the primary action is "Create catalog" and is gated on
  // having a name + a valid mode + nothing in flight.
  const setupReadyForFromUpload =
    mode === "from_upload" && sessionUploadHasColumns;

  const setupReadyForDirectCreate = mode === "default";

  const canAdvanceFromSetup =
    mode != null &&
    trimmedName.length > 0 &&
    !saving &&
    !uploading &&
    (setupReadyForFromUpload || setupReadyForDirectCreate);

  // ------------------------------------------------------------------
  // Action handlers
  // ------------------------------------------------------------------

  const buildDirectEntries = (): GLCatalogEntry[] => {
    // Only "default" reaches here — "from_upload" goes through the
    // mapping step, and "blank" is no longer an offered start mode.
    // canAdvanceFromSetup gates so this is never called when
    // defaultCatalog is null.
    if (mode === "default" && defaultCatalog) {
      return defaultCatalog.entries.map((e) => ({
        ...e,
        // Re-key client-side so the new draft owns its ids — keeps
        // the canonical default's `d-N` ids from leaking into a saved
        // catalog. Backend doesn't care, but it's tidier.
        id: newEntryId(),
      }));
    }
    return [];
  };

  const handleSetupPrimary = async () => {
    if (!canAdvanceFromSetup || mode == null) return;
    if (mode === "from_upload") {
      // Cross over to step 2. The mapping seed was already wired up
      // by the sessionUpload effect when the file landed.
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

  const handleConfirmMapping = async () => {
    if (!canSubmitMapping || mapped == null) return;
    await onCreate({
      name: trimmedName,
      description: description.trim() ? description.trim() : null,
      entries: mapped.entries,
      source: "from_upload" as GLCatalogSource,
    });
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleFileChosen = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    // Always reset the input so picking the same filename again still
    // fires onChange — useful when re-trying after a parse failure.
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    try {
      const parsed = await glCatalogsApi.parseUpload(file, (pct) =>
        setUploadProgress(pct),
      );
      setSessionUpload(parsed);
      // Auto-select from_upload after a successful upload — the user
      // clearly wanted to use the file they just picked. Their initial
      // click on the option is what made the file picker appear, so
      // they're already on or returning to this mode either way.
      setMode("from_upload");
    } catch (err) {
      setSessionUpload(null);
      setUploadError(
        getApiErrorMessage(
          err,
          "Couldn't parse that file. Make sure it's a .csv or .xlsx with a header row.",
        ),
      );
    } finally {
      setUploading(false);
    }
  };

  const handleFieldMappingChange = (
    field: CanonicalGLFieldKey,
    sourceColumn: string | null,
  ) => {
    setMapping((m) => ({ ...m, [field]: sourceColumn }));
  };

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const modalSize = step === "mapping" ? "lg" : "md";
  const modalTitle =
    step === "mapping"
      ? `Map columns from ${sessionUpload?.filename ?? "upload"}`
      : "New GL catalog";

  return (
    <Modal open={open} onClose={onClose} title={modalTitle} size={modalSize}>
      {step === "setup" ? (
        <SetupStep
          name={name}
          description={description}
          mode={mode}
          defaultCatalog={defaultCatalog}
          sessionUpload={sessionUpload}
          uploading={uploading}
          uploadProgress={uploadProgress}
          uploadError={uploadError}
          error={error}
          saving={saving}
          canAdvance={canAdvanceFromSetup}
          fileInputRef={fileInputRef}
          onNameChange={setName}
          onDescriptionChange={setDescription}
          onModeChange={setMode}
          onUploadClick={openFilePicker}
          onFileChosen={handleFileChosen}
          onCancel={onClose}
          onPrimary={() => void handleSetupPrimary()}
        />
      ) : (
        <MappingStep
          parsed={sessionUpload!}
          mapping={mapping}
          mapped={mapped}
          requiredFieldsMapped={requiredFieldsMapped}
          canSubmit={canSubmitMapping}
          saving={saving}
          mutationError={error}
          onMappingChange={handleFieldMappingChange}
          onBack={() => setStep("setup")}
          onCancel={onClose}
          onCreate={() => void handleConfirmMapping()}
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
  defaultCatalog: GLCatalogDefault | null;
  sessionUpload: ParsedGLUpload | null;
  uploading: boolean;
  uploadProgress: number;
  uploadError: string | null;
  error: string | null;
  saving: boolean;
  canAdvance: boolean;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onNameChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onModeChange: (m: StartMode) => void;
  onUploadClick: () => void;
  onFileChosen: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onCancel: () => void;
  onPrimary: () => void;
}

function SetupStep({
  name,
  description,
  mode,
  defaultCatalog,
  sessionUpload,
  uploading,
  uploadProgress,
  uploadError,
  error,
  saving,
  canAdvance,
  fileInputRef,
  onNameChange,
  onDescriptionChange,
  onModeChange,
  onUploadClick,
  onFileChosen,
  onCancel,
  onPrimary,
}: SetupStepProps) {
  const sessionUploadHasColumns =
    sessionUpload != null && sessionUpload.source_columns.length > 0;

  // Primary button label depends on mode — from_upload defers to
  // step 2, default goes straight to create.
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
        <FieldLabel htmlFor="new-gl-name">Name</FieldLabel>
        <input
          id="new-gl-name"
          type="text"
          value={name}
          autoFocus
          maxLength={255}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Operating Expenses 2026"
          className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink dark:placeholder:text-ink-subtle"
        />
      </div>

      <div>
        <FieldLabel htmlFor="new-gl-desc">Description</FieldLabel>
        <textarea
          id="new-gl-desc"
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
                ? `Start with ${defaultCatalog.entries.length} sensible multifamily GL accounts. Edit, add, or remove rows after creating.`
                : "Default catalog unavailable — try again later."
            }
            selected={mode === "default"}
            disabled={!defaultCatalog}
            onSelect={() => onModeChange("default")}
          />

          {/* "From uploaded chart" — option button + a sub-card that
              ONLY appears when this option is actively selected. The
              sub-card itself is session-local: until the user
              uploads a file inside this modal, it shows an empty
              state with an "Upload a chart" CTA. */}
          <div className="space-y-1.5">
            <StartOption
              icon={Upload}
              title="From uploaded chart of accounts"
              description={
                sessionUploadHasColumns
                  ? `Use the ${sessionUpload!.source_rows.length}-row file you just uploaded. Map its columns to BillsIQ's GL fields next.`
                  : "Upload your existing chart now (CSV / Excel) — we'll surface its columns so you can map them to BillsIQ's GL fields next."
              }
              selected={mode === "from_upload"}
              onSelect={() => onModeChange("from_upload")}
            />
            {mode === "from_upload" && (
              <UploadedSourceCard
                parsed={sessionUpload}
                uploading={uploading}
                progress={uploadProgress}
                uploadError={uploadError}
                onUploadClick={onUploadClick}
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              className="hidden"
              onChange={(e) => void onFileChosen(e)}
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
          disabled={saving || uploading}
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
// Step 1 sub-card — session-local upload state for "From uploaded chart"
// ===========================================================================

function UploadedSourceCard({
  parsed,
  uploading,
  progress,
  uploadError,
  onUploadClick,
}: {
  parsed: ParsedGLUpload | null;
  uploading: boolean;
  progress: number;
  uploadError: string | null;
  onUploadClick: () => void;
}) {
  const hasFile = parsed != null;
  const parsedOk = parsed != null && parsed.source_columns.length > 0;
  const parsedEmpty =
    parsed != null && parsed.source_columns.length === 0;

  return (
    <div className="ml-10 rounded-md border border-gray-200 bg-gray-50/50 px-3 py-2.5 text-[11px] dark:border-line dark:bg-surface-muted/50">
      <p className="text-[9.5px] uppercase tracking-wide text-gray-400 font-semibold mb-1.5 dark:text-ink-subtle">
        Chart file for this draft
      </p>

      {uploading ? (
        <div className="space-y-1.5">
          <p className="inline-flex items-center gap-1.5 text-gray-700 font-medium dark:text-ink-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-600" />
            Reading chart of accounts…
          </p>
          <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
            <div
              className="h-full bg-brand-500 transition-[width] duration-150"
              style={{ width: `${Math.max(2, progress)}%` }}
            />
          </div>
          <p className="text-[10px] text-gray-500 dark:text-ink-muted">
            {progress}% · once read, you&apos;ll map its columns next.
          </p>
        </div>
      ) : parsedOk ? (
        <div className="space-y-1.5">
          <SourceMetaRow
            icon={FileText}
            tone="ok"
            filename={parsed!.filename}
            summary={
              <>
                <span className="font-medium">{parsed!.source_columns.length}</span>{" "}
                column{parsed!.source_columns.length === 1 ? "" : "s"}
                <span className="text-gray-300 dark:text-line-strong mx-1">·</span>
                <span className="font-medium">{parsed!.source_rows.length}</span>{" "}
                row{parsed!.source_rows.length === 1 ? "" : "s"}
                {parsed!.detected_format && (
                  <>
                    <span className="text-gray-300 dark:text-line-strong mx-1">·</span>
                    {parsed!.detected_format.toUpperCase()}
                  </>
                )}
              </>
            }
          />
          <p className="text-[10.5px] text-gray-600 mt-1 dark:text-ink-muted">
            Click <span className="font-medium">Continue to mapping</span> to
            match these columns to BillsIQ&apos;s GL fields.
          </p>
          {parsed!.parse_warning && (
            <p className="text-[10.5px] text-yellow-700 italic dark:text-yellow-200">
              {parsed!.parse_warning}
            </p>
          )}
        </div>
      ) : parsedEmpty ? (
        <SourceMetaRow
          icon={FileWarning}
          tone="warn"
          filename={parsed!.filename}
          summary={
            <>
              No usable columns could be extracted.
              {parsed!.parse_warning && (
                <span className="block text-yellow-700/80 dark:text-yellow-200/80 mt-0.5 italic">
                  {parsed!.parse_warning}
                </span>
              )}
            </>
          }
        />
      ) : (
        <p className="text-gray-600 dark:text-ink-muted">
          No file picked yet. Upload a chart of accounts (CSV or Excel)
          to use its rows as the starting point for this catalog.
        </p>
      )}

      {uploadError && !uploading && (
        <p className="mt-2 inline-flex items-start gap-1.5 text-red-600 text-[11px] dark:text-red-400">
          <FileWarning className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{uploadError}</span>
        </p>
      )}

      {!uploading && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onUploadClick}
          >
            {hasFile ? (
              <>
                <RefreshCw className="h-3.5 w-3.5" />
                Replace file
              </>
            ) : (
              <>
                <UploadCloud className="h-3.5 w-3.5" />
                Upload a chart
              </>
            )}
          </Button>
        </div>
      )}

      {hasFile && (
        <p className="text-[10px] text-gray-400 mt-2 dark:text-ink-subtle">
          The file isn&apos;t stored — only the rows you confirm in the
          mapping step become the saved catalog.
        </p>
      )}
    </div>
  );
}

function SourceMetaRow({
  icon: Icon,
  tone,
  filename,
  summary,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: "ok" | "warn";
  filename: string;
  summary: React.ReactNode;
}) {
  const tones =
    tone === "ok"
      ? { iconBg: "bg-brand-50", iconColor: "text-brand-700" }
      : {
          iconBg: "bg-yellow-100 dark:bg-yellow-950/40",
          iconColor: "text-yellow-700 dark:text-yellow-200",
        };
  return (
    <div className="flex items-start gap-2">
      <div
        className={cn(
          "h-7 w-7 shrink-0 rounded-md flex items-center justify-center",
          tones.iconBg,
        )}
      >
        <Icon className={cn("h-3.5 w-3.5", tones.iconColor)} />
      </div>
      <div className="flex-1 min-w-0">
        <p
          className="text-[12px] font-semibold text-gray-800 truncate dark:text-ink"
          title={filename}
        >
          {filename}
        </p>
        <p className="text-[10.5px] text-gray-600 dark:text-ink-muted">{summary}</p>
      </div>
    </div>
  );
}

// ===========================================================================
// Step 2 — MAPPING
// ===========================================================================

interface MappingStepProps {
  parsed: ParsedGLUpload;
  mapping: GLUploadMapping;
  mapped: ReturnType<typeof applyMappingToSourceRows> | null;
  requiredFieldsMapped: boolean;
  canSubmit: boolean;
  saving: boolean;
  mutationError: string | null;
  onMappingChange: (
    field: CanonicalGLFieldKey,
    sourceColumn: string | null,
  ) => void;
  onBack: () => void;
  onCancel: () => void;
  onCreate: () => void;
}

function MappingStep({
  parsed,
  mapping,
  mapped,
  requiredFieldsMapped,
  canSubmit,
  saving,
  mutationError,
  onMappingChange,
  onBack,
  onCancel,
  onCreate,
}: MappingStepProps) {
  const previewRows = useMemo(
    () => (mapped ? mapped.entries.slice(0, PREVIEW_ROW_LIMIT) : []),
    [mapped],
  );

  const totalSourceRows = parsed.source_rows.length;
  const importableCount = mapped?.entries.length ?? 0;
  const blankRequiredCount = mapped?.blankRequiredCount ?? 0;
  const duplicateCodeCount = mapped?.duplicateCodeCount ?? 0;

  const activeUnmapped = mapping.active == null;

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-gray-600 dark:text-ink-muted">
        Match each BillsIQ GL field to a column from{" "}
        <span className="font-medium text-gray-800 dark:text-ink">
          {parsed.filename}
        </span>
        . Required fields are marked with{" "}
        <span className="text-red-600 font-semibold dark:text-red-400">*</span>;
        optional fields can be left as <span className="italic">— None —</span>.
      </p>

      {/* ---- Mapping grid ---------------------------------------------- */}
      <div className="rounded-md border border-gray-200 dark:border-line">
        <div className="grid grid-cols-[1fr_1fr] gap-x-4 px-3 py-2 border-b border-gray-200 bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 font-semibold dark:border-line dark:bg-surface-muted dark:text-ink-subtle">
          <span>BillsIQ GL field</span>
          <span>Column from your file</span>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-line/60">
          {CANONICAL_GL_FIELDS.map((field) => {
            const value = mapping[field.key] ?? "";
            const missingRequired = field.required && !value;
            return (
              <div
                key={field.key}
                className="grid grid-cols-[1fr_1fr] gap-x-4 px-3 py-2.5 items-start"
              >
                <div className="min-w-0">
                  <p className="text-[12.5px] font-semibold text-gray-800 dark:text-ink">
                    {field.label}
                    {field.required && (
                      <span className="text-red-600 ml-0.5 dark:text-red-400">
                        *
                      </span>
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
                      onMappingChange(
                        field.key,
                        e.target.value === "" ? null : e.target.value,
                      )
                    }
                    className={cn(
                      "w-full rounded-md border px-2 py-1.5 text-sm bg-white dark:bg-surface dark:text-ink",
                      "focus:outline-none focus:ring-2 focus:ring-brand-500",
                      missingRequired
                        ? "border-red-300 ring-1 ring-red-100 dark:border-red-900 dark:ring-red-950"
                        : "border-gray-300 dark:border-line",
                    )}
                  >
                    <option value="">— None —</option>
                    {parsed.source_columns.map((col, idx) => (
                      // Use idx in the key to disambiguate duplicate
                      // header names (rare, but possible).
                      <option key={`${col}-${idx}`} value={col}>
                        {col}
                      </option>
                    ))}
                  </select>
                  {missingRequired && (
                    <p className="text-[10px] text-red-600 mt-1 dark:text-red-400">
                      Required — pick the source column that holds this.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---- Preview ---------------------------------------------------- */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold dark:text-ink-subtle">
            Preview
          </p>
          <p className="text-[10.5px] text-gray-500 dark:text-ink-muted">
            {requiredFieldsMapped ? (
              <>
                Showing first {previewRows.length} of {importableCount}{" "}
                {importableCount === 1 ? "row" : "rows"} ready to import
              </>
            ) : (
              <>
                Pick a source column for the required fields above to see
                the preview.
              </>
            )}
          </p>
        </div>
        {requiredFieldsMapped && previewRows.length > 0 ? (
          <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-line">
            <table className="w-full text-[11.5px]">
              <thead className="bg-gray-50 border-b border-gray-200 dark:bg-surface-muted dark:border-line">
                <tr>
                  {CANONICAL_GL_FIELDS.map((f) => (
                    <th
                      key={f.key}
                      className="text-left font-semibold text-gray-600 px-2.5 py-1.5 dark:text-ink-muted"
                    >
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-t border-gray-100 odd:bg-white even:bg-gray-50/30 dark:border-line/60 dark:odd:bg-surface dark:even:bg-surface-muted/30"
                  >
                    <td className="px-2.5 py-1.5 font-mono text-gray-800 dark:text-ink">
                      {entry.code}
                    </td>
                    <td className="px-2.5 py-1.5 text-gray-700 dark:text-ink-muted">
                      {entry.description}
                    </td>
                    <td className="px-2.5 py-1.5 text-gray-600 dark:text-ink-muted">
                      {entry.category ?? (
                        <span className="text-gray-300 dark:text-ink-subtle">—</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5">
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
                    <td className="px-2.5 py-1.5 text-gray-600 dark:text-ink-muted max-w-xs truncate">
                      {entry.notes ?? (
                        <span className="text-gray-300 dark:text-ink-subtle">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-gray-300 px-3 py-6 text-center text-[11.5px] text-gray-500 dark:border-line dark:text-ink-muted">
            {requiredFieldsMapped
              ? "Mapping is set, but no rows produced importable entries — every row was either blank or a duplicate of an earlier row."
              : "Preview unavailable until the required fields are mapped."}
          </div>
        )}
      </div>

      {/* ---- Counters / warnings --------------------------------------- */}
      <ul className="space-y-1 text-[11.5px]">
        {requiredFieldsMapped && (
          <li className="text-gray-700 dark:text-ink-muted inline-flex items-center gap-1.5">
            <span className="font-semibold text-gray-900 dark:text-ink">
              {importableCount}
            </span>{" "}
            of {totalSourceRows} source row
            {totalSourceRows === 1 ? "" : "s"} ready to import.
          </li>
        )}
        {blankRequiredCount > 0 && (
          <li className="text-yellow-700 dark:text-yellow-200">
            Skipping {blankRequiredCount} row
            {blankRequiredCount === 1 ? "" : "s"} with a blank GL code.
          </li>
        )}
        {duplicateCodeCount > 0 && (
          <li className="text-yellow-700 dark:text-yellow-200">
            Dropping {duplicateCodeCount} duplicate GL code
            {duplicateCodeCount === 1 ? "" : "s"} (first occurrence wins).
          </li>
        )}
        {requiredFieldsMapped && activeUnmapped && (
          <li className="text-gray-500 dark:text-ink-muted">
            No <span className="font-medium">Active / Inactive</span>{" "}
            column mapped — every imported row defaults to active. You
            can flip individual rows in the editor.
          </li>
        )}
      </ul>

      {parsed.parse_warning && (
        <InlineAlert tone="warning" title="Parser note">
          {parsed.parse_warning}
        </InlineAlert>
      )}

      {mutationError && <InlineAlert tone="error">{mutationError}</InlineAlert>}

      {/* ---- Footer actions -------------------------------------------- */}
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
            disabled={!canSubmit}
            loading={saving}
            onClick={onCreate}
          >
            Create catalog
          </Button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Start-mode option card (visually identical to NewTemplateModal's)
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
