"use client";

import {
  FileSpreadsheet,
  FileText,
  FileWarning,
  Loader2,
  RefreshCw,
  Sparkles,
  Upload,
  UploadCloud,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { cn, formatDate } from "@/lib/utils";
import {
  type InvoiceTemplateColumn,
  type InvoiceTemplateCreate,
  type InvoiceTemplateDefault,
  type InvoiceTemplateSource,
  newColumnId,
} from "@/types/invoice-template";

/**
 * Snapshot of a ResMan import_template upload, in the shape the modal
 * actually consumes. Decoupled from `ReferenceFile` on purpose so the
 * modal doesn't depend on reference-data internals — the parent maps
 * a `ReferenceFile` returned by `useReferenceData.upload` into this
 * shape inside `onUploadTemplate`.
 */
export interface UploadedTemplateSource {
  /** Stored filename — never null in a successful upload. */
  filename: string | null;
  /** Last-modified timestamp (ISO string) on the upload row. */
  updatedAt: string | null;
  /**
   * Parsed header row from the upload, or null when parsing failed
   * (in which case `parseError` is set).
   */
  columns: string[] | null;
  /** Present when the file is stored but parsing failed. */
  parseError: string | null;
}

/**
 * "New template" dialog.
 *
 * Opens neutral. No start mode is pre-seeded — the modal is built so
 * the user makes a deliberate, conscious choice between the three
 * starters before any of them visually claims the new template:
 *   * default     — copy the canonical default template's columns
 *   * blank       — one empty column
 *   * from_upload — copy parsed columns from a ResMan template the
 *                   user uploads INSIDE THIS DIALOG
 *
 * About `from_upload` (the strict bit):
 *
 *   The modal is session-local. It does NOT read whatever happens to
 *   live in the persistent `import_template` reference slot. Even if
 *   the user uploaded a ResMan template last week, the modal opens
 *   with no file attached — the option's sub-card shows an empty
 *   state asking the user to upload one for THIS template. Only after
 *   the user picks a file inside the modal (which we forward via
 *   `onUploadTemplate`, getting back the freshly-parsed source) does
 *   the file appear and become usable as the column baseline. This
 *   prevents a previously-uploaded file from feeling auto-attached
 *   to a brand-new template.
 *
 *   The upload still goes through the same backend endpoint (so the
 *   persistent slot does get refreshed as a side effect), but the
 *   modal's view of "the file for this draft" is purely whatever
 *   landed via `onUploadTemplate` during this open of the dialog.
 *
 * Submission of `from_upload` is gated on a parsed session upload
 * existing; submission overall is gated on a mode being picked at all.
 */
interface NewTemplateModalProps {
  open: boolean;
  saving: boolean;
  error: string | null;
  defaultTemplate: InvoiceTemplateDefault | null;

  /** True while a modal-initiated upload is in flight. */
  uploading: boolean;
  /** 0..100 — bytes uploaded for an in-flight upload. */
  uploadProgress: number;
  /** Error from the most recent upload attempt, cleared on the next try. */
  uploadError: string | null;
  /**
   * Upload a ResMan template the user picked inside this modal.
   * Resolves to the parsed source on success, or `null` on failure
   * (in which case the parent surfaces the human-readable message via
   * `uploadError`). The modal stores the returned value as its
   * session-local snapshot — so the previously-uploaded persistent
   * file is never used as a silent baseline.
   */
  onUploadTemplate: (file: File) => Promise<UploadedTemplateSource | null>;

  onClose: () => void;
  onCreate: (body: InvoiceTemplateCreate) => Promise<void>;
}

type StartMode = "blank" | "default" | "from_upload";

const ACCEPTED_FILE_TYPES = ".xlsx,.xls,.csv";

const EMPTY_SOURCE: UploadedTemplateSource = {
  filename: null,
  updatedAt: null,
  columns: null,
  parseError: null,
};

export function NewTemplateModal({
  open,
  saving,
  error,
  defaultTemplate,
  uploading,
  uploadProgress,
  uploadError,
  onUploadTemplate,
  onClose,
  onCreate,
}: NewTemplateModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // `null` means "the user hasn't picked a starter yet". We deliberately
  // don't pre-seed any mode on open — opening the modal must feel
  // neutral. Pre-selecting a mode (especially `from_upload`) made it
  // look like the new template was already attached to an existing
  // file before the user made any choice.
  const [mode, setMode] = useState<StartMode | null>(null);
  // Session-local snapshot of a file the user uploaded INSIDE this
  // open of the modal. Null on every fresh open. We never seed this
  // from any persistent state — that's the whole point of the
  // session-local behavior. It only becomes non-null after a
  // successful `onUploadTemplate(...)`.
  const [sessionUpload, setSessionUpload] =
    useState<UploadedTemplateSource | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset on (re)open. Mode → null forces an explicit pick; the session
  // upload is dropped so any file the user uploaded in a previous open
  // of the modal doesn't carry over into this one.
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setMode(null);
      setSessionUpload(null);
    }
  }, [open]);

  // If the default mode becomes invalid mid-flow (default fetch failed
  // in the background), drop back to `null` so the user has to make a
  // conscious re-pick rather than being silently switched to a different
  // starter. We don't auto-step out of `from_upload` — the user might
  // be on that option specifically to upload one. Submission is gated
  // separately so a from_upload create with no actual file isn't possible.
  useEffect(() => {
    if (mode === "default" && !defaultTemplate) setMode(null);
  }, [mode, defaultTemplate]);

  // "Did the user upload a parsable file in this modal session?"
  // Drives both the option description text and the sub-card display.
  const sessionUploadParsed =
    sessionUpload != null &&
    sessionUpload.columns != null &&
    sessionUpload.columns.length > 0;

  const trimmedName = name.trim();
  // from_upload requires a parsed session upload to submit. The sub-card
  // (visible only in that mode) gives the user a way to upload one.
  const fromUploadReady = mode !== "from_upload" || sessionUploadParsed;
  const canSubmit =
    mode != null &&
    trimmedName.length > 0 &&
    !saving &&
    !uploading &&
    fromUploadReady;

  const buildColumns = (): InvoiceTemplateColumn[] => {
    if (mode === "default" && defaultTemplate) {
      return defaultTemplate.columns.map((c) => ({
        id: newColumnId(),
        name: c.name,
        source_column: c.source_column,
      }));
    }
    if (mode === "from_upload" && sessionUpload?.columns) {
      return sessionUpload.columns.map((colName) => ({
        id: newColumnId(),
        name: colName,
        source_column: colName,
      }));
    }
    return [{ id: newColumnId(), name: "Column 1", source_column: null }];
  };

  const buildSource = (): InvoiceTemplateSource => {
    if (mode === "default") return "default";
    if (mode === "from_upload") return "from_upload";
    return "blank";
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onCreate({
      name: trimmedName,
      description: description.trim() ? description.trim() : null,
      columns: buildColumns(),
      source: buildSource(),
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
    const result = await onUploadTemplate(file);
    if (!result) {
      // Failure — parent has set `uploadError` for the sub-card to
      // display. Crucially, we don't touch `sessionUpload`, so the
      // empty state stays in place; we never fall back to whatever
      // the persistent slot might still be holding.
      return;
    }
    setSessionUpload(result);
    // Auto-select from_upload after a successful upload — the user
    // clearly wanted to use the file they just picked. (Their initial
    // click on the option is what made the file picker appear, so
    // they're already on or returning to this mode either way.)
    setMode("from_upload");
  };

  return (
    <Modal open={open} onClose={onClose} title="New invoice template" size="md">
      <div className="space-y-3">
        <div>
          <FieldLabel htmlFor="new-tpl-name">Name</FieldLabel>
          <input
            id="new-tpl-name"
            type="text"
            value={name}
            autoFocus
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Default invoice export"
            className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink dark:placeholder:text-ink-subtle"
          />
        </div>

        <div>
          <FieldLabel htmlFor="new-tpl-desc">Description</FieldLabel>
          <textarea
            id="new-tpl-desc"
            value={description}
            rows={2}
            placeholder="Optional — what's this template for?"
            onChange={(e) => setDescription(e.target.value)}
            className="w-full resize-none rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink dark:placeholder:text-ink-subtle"
          />
        </div>

        <div>
          <FieldLabel>Starting columns</FieldLabel>
          <div className="grid gap-1.5">
            <StartOption
              icon={Sparkles}
              title="From canonical default"
              description={
                defaultTemplate
                  ? `Start with ${defaultTemplate.columns.length} BillsIQ canonical fields. Rename or remove the ones you don't need after creating.`
                  : "Default template unavailable — try again later."
              }
              selected={mode === "default"}
              disabled={!defaultTemplate}
              onSelect={() => setMode("default")}
            />
            <StartOption
              icon={FileSpreadsheet}
              title="From blank"
              description="Start with one empty column and add the rest as you go."
              selected={mode === "blank"}
              onSelect={() => setMode("blank")}
            />

            {/* "From uploaded ResMan template" — option button + a
                sub-card that ONLY appears when this option is actively
                selected. The sub-card itself is session-local: until
                the user uploads a file inside this modal, it shows an
                empty state with an "Upload a template" CTA. The
                previously-uploaded persistent file (if any) is
                deliberately invisible — the user must explicitly
                upload one for this template. */}
            <div className="space-y-1.5">
              <StartOption
                icon={Upload}
                title="From uploaded ResMan template"
                description={
                  sessionUploadParsed
                    ? `Use the ${sessionUpload!.columns!.length}-column ResMan file you just uploaded.`
                    : "Upload a ResMan template now to use its columns as the starting point."
                }
                selected={mode === "from_upload"}
                onSelect={() => setMode("from_upload")}
              />
              {mode === "from_upload" && (
                <UploadedSourceCard
                  source={sessionUpload ?? EMPTY_SOURCE}
                  uploading={uploading}
                  progress={uploadProgress}
                  uploadError={uploadError}
                  onUploadClick={openFilePicker}
                />
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_FILE_TYPES}
                className="hidden"
                onChange={(e) => void handleFileChosen(e)}
              />
            </div>
          </div>
        </div>

        {error && <InlineAlert tone="error">{error}</InlineAlert>}
        {mode === "default" && !defaultTemplate && (
          <InlineAlert tone="warning" title="Couldn't load the default template">
            Pick another start option for now — defaults will return on
            the next page load.
          </InlineAlert>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={saving || uploading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            loading={saving}
            onClick={() => void handleSubmit()}
          >
            Create template
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ===========================================================================
// Sub-card: session-local upload state for "From uploaded ResMan template"
// ===========================================================================

function UploadedSourceCard({
  source,
  uploading,
  progress,
  uploadError,
  onUploadClick,
}: {
  source: UploadedTemplateSource;
  uploading: boolean;
  progress: number;
  uploadError: string | null;
  onUploadClick: () => void;
}) {
  const hasFile = source.filename != null;
  const parsed =
    hasFile && source.columns != null && source.columns.length > 0;
  const parseFailed = hasFile && source.parseError != null;

  // Three visual states on top of the shared shell:
  //   * uploading   — progress bar + filename being uploaded
  //   * has file    — metadata + Replace button (file the user
  //                   uploaded *in this modal session*)
  //   * no file     — call-to-action: "Upload a template" (the
  //                   default state every time the option is
  //                   freshly selected)
  // Plus a parse-error overlay when the just-uploaded file failed
  // to parse on the server.
  return (
    <div className="ml-10 rounded-md border border-gray-200 bg-gray-50/50 px-3 py-2.5 text-[11px] dark:border-line dark:bg-surface-muted/50">
      <p className="text-[9.5px] uppercase tracking-wide text-gray-400 font-semibold mb-1.5 dark:text-ink-subtle">
        Template file for this draft
      </p>

      {uploading ? (
        <div className="space-y-1.5">
          <p className="inline-flex items-center gap-1.5 text-gray-700 font-medium dark:text-ink-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-600" />
            Uploading ResMan template…
          </p>
          <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
            <div
              className="h-full bg-brand-500 transition-[width] duration-150"
              style={{ width: `${Math.max(2, progress)}%` }}
            />
          </div>
          <p className="text-[10px] text-gray-500 dark:text-ink-muted">
            {progress}% · once parsed, the columns will appear below.
          </p>
        </div>
      ) : parsed ? (
        <SourceMetaRow
          icon={FileText}
          tone="ok"
          filename={source.filename!}
          summary={
            <>
              <span className="font-medium">{source.columns!.length}</span>{" "}
              column{source.columns!.length === 1 ? "" : "s"}
              {source.updatedAt && (
                <>
                  <span className="text-gray-300 dark:text-line-strong mx-1">·</span>
                  Uploaded {formatDate(source.updatedAt)}
                </>
              )}
            </>
          }
        />
      ) : parseFailed ? (
        <SourceMetaRow
          icon={FileWarning}
          tone="warn"
          filename={source.filename!}
          summary={
            <>
              Stored — but BillsIQ couldn&apos;t parse it.
              {source.parseError && (
                <span className="block text-yellow-700/80 mt-0.5 italic">
                  {source.parseError}
                </span>
              )}
            </>
          }
        />
      ) : (
        <p className="text-gray-600 dark:text-ink-muted">
          No file picked yet. Upload a ResMan template to use its
          columns as the starting point for this template.
        </p>
      )}

      {uploadError && !uploading && (
        <p className="mt-2 inline-flex items-start gap-1.5 text-red-600 text-[11px]">
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
                Upload a template
              </>
            )}
          </Button>
        </div>
      )}

      {hasFile && (
        <p className="text-[10px] text-gray-400 mt-2 dark:text-ink-subtle">
          You can replace this file before creating the template — it
          only seeds the starting columns.
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
      : { iconBg: "bg-yellow-100", iconColor: "text-yellow-700" };
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
// Start-mode option card (unchanged from previous version)
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
