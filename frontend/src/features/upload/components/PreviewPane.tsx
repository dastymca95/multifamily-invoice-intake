"use client";

import {
  AlertTriangle,
  Eye,
  FileImage,
  FileText,
  FileWarning,
  Hash,
  Info,
  Layers,
  Loader2,
  Lock,
  RotateCcw,
  Save,
  Scissors,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { documentsApi } from "@/lib/api/documents";
import { getApiErrorMessage } from "@/lib/api";
import { displayDocumentStatus, displayRoute } from "@/lib/status";
import { cn, formatDate, formatFileSize } from "@/lib/utils";
import type { Document } from "@/types/document";

import type { PageEditMap, TrackedFile } from "../hooks/useBatchUpload";

/**
 * What the parent currently has selected. Discriminated union so we can
 * pull the right preview source without ambiguity:
 *   - "queued"   → we still have the raw `File` on the client; preview from
 *                  a blob URL of `tracked.file`.
 *   - "persisted"→ the file is on the server; fetch bytes via the JWT-
 *                  protected `documentsApi.fetchFileBlob` and preview from
 *                  the resulting blob URL.
 */
export type PreviewSelection =
  | { kind: "queued"; tracked: TrackedFile }
  | { kind: "persisted"; document: Document };

interface PreviewPaneProps {
  selection: PreviewSelection | null;
  /** Called when the user hits "Remove from batch" inside the pane. */
  onRemove?: (id: string) => void;

  // ---- Page-level editing ------------------------------------------------
  pageEdits: PageEditMap;
  pendingEditsId: string | null;
  onTogglePage: (id: string, pageNumber: number) => void;
  onRestoreAll: (id: string) => void;
  onCommitPageEdits: (id: string) => Promise<void>;
}

const PDF_MIMES = new Set(["application/pdf", "application/x-pdf"]);

function isPdfMime(mime: string | undefined): boolean {
  return mime != null && PDF_MIMES.has(mime);
}
function isImageMime(mime: string | undefined): boolean {
  return mime != null && mime.startsWith("image/");
}

type TabKey = "preview" | "pages" | "details";

/**
 * Right-column preview pane.
 *
 * Three tabs let the user switch between:
 *   - Preview: the rendered file (PDF iframe at fit-width, image, or honest
 *              placeholder). Fills the available pane height.
 *   - Pages:   the PageEditor, where individual pages can be marked for
 *              removal. For queued PDFs, "Save page changes" rewrites the
 *              file in-browser via pdf-lib. For persisted docs the
 *              annotations are preview-only — clearly labeled as such.
 *   - Details: full metadata, extraction error, and duplicate-conflict info.
 */
export function PreviewPane(props: PreviewPaneProps) {
  if (!props.selection) {
    return <EmptyState />;
  }

  return <PreviewBody {...props} selection={props.selection} />;
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="bg-white rounded-xl border h-full flex flex-col items-center justify-center text-center px-6 py-10">
      <Eye className="h-8 w-8 text-gray-300 mb-2" />
      <p className="text-sm font-medium text-gray-600">No document selected</p>
      <p className="text-xs text-gray-400 mt-1 max-w-xs">
        Click any document in the middle column to preview it here. PDFs
        render inline at fit-width; images show full-frame; other types
        show metadata only.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body — handles selection-aware data loading + tab switching
// ---------------------------------------------------------------------------

interface BodyProps extends PreviewPaneProps {
  selection: PreviewSelection;
}

function PreviewBody({
  selection,
  onRemove,
  pageEdits,
  pendingEditsId,
  onTogglePage,
  onRestoreAll,
  onCommitPageEdits,
}: BodyProps) {
  // Resolve the common shape regardless of queued/persisted source so the
  // header + tab content can be rendered uniformly.
  const id = selection.kind === "queued" ? selection.tracked.id : selection.document.id;
  const filename =
    selection.kind === "queued"
      ? selection.tracked.file.name
      : selection.document.original_filename;
  const sizeBytes =
    selection.kind === "queued"
      ? selection.tracked.file.size
      : selection.document.file_size_bytes;
  const mime =
    selection.kind === "queued"
      ? selection.tracked.file.type || ""
      : selection.document.mime_type;
  const isPdf = isPdfMime(mime);
  const isImage = isImageMime(mime);
  const kind: "pdf" | "image" | "other" = isPdf ? "pdf" : isImage ? "image" : "other";

  // Page count comes from two different places depending on source:
  //  - queued:    pdfMeta probe at add-files time wrote it onto tracked.meta
  //  - persisted: we have to round-trip the bytes ourselves because the
  //               server doesn't store it (and adding a column is more
  //               surgery than this iteration warrants). The probe runs
  //               only when this is a PDF; non-PDFs short-circuit to null.
  const persistedProbe = usePersistedPdfPageCount(selection);
  const pageCount =
    selection.kind === "queued"
      ? selection.tracked.meta?.pageCount ?? null
      : persistedProbe.pageCount;

  const [tab, setTab] = useState<TabKey>("preview");
  // Reset to Preview whenever the selection itself changes — coming back
  // to a different doc shouldn't drop the user mid-edit on the Pages tab.
  useEffect(() => {
    setTab("preview");
  }, [id]);

  // ---- Blob URL (per-source) -------------------------------------------
  // For persisted docs, pass the current checksum as a cache-bust key so
  // a trim-and-re-extract round-trip refreshes the iframe even though the
  // document id is unchanged.
  const blobUrl = useFileBlobUrl(selection);

  // ---- Header status badge ---------------------------------------------
  const headerBadge =
    selection.kind === "queued" ? (
      <TrackedStatusBadge status={selection.tracked.status} />
    ) : (
      (() => {
        const s = displayDocumentStatus(selection.document);
        return <Badge color={s.tone}>{s.label}</Badge>;
      })()
    );

  const removable = onRemove != null;
  const editsForThis = pageEdits[id];
  const editCount = editsForThis?.size ?? 0;

  // Page-edit eligibility — single source of truth for the Pages tab UI,
  // the tab label affordance, and the contextual CTA in the Preview tab.
  // The same predicate is reused by `PagesTab` to decide which copy to show.
  const pagesEligibility = computePagesEligibility(
    selection,
    persistedProbe.pageCount,
    persistedProbe.loading,
    persistedProbe.error,
  );
  const pagesEditable = pagesEligibility.kind === "editable";

  return (
    <div className="bg-white rounded-xl border h-full flex flex-col min-h-0">
      {/* ---- Header ----------------------------------------------------- */}
      <div className="px-4 py-3 border-b flex items-start gap-3 shrink-0">
        <div className="h-9 w-9 shrink-0 rounded-md bg-gray-100 flex items-center justify-center">
          {kind === "image" ? (
            <FileImage className="h-4 w-4 text-gray-500" />
          ) : kind === "pdf" ? (
            <FileText className="h-4 w-4 text-gray-500" />
          ) : (
            <FileWarning className="h-4 w-4 text-gray-500" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-gray-800 truncate" title={filename}>
            {filename}
          </h2>
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            {headerBadge}
            <span className="text-[11px] text-gray-500">
              {formatFileSize(sizeBytes)}
            </span>
            {pageCount != null && (
              <>
                <span className="text-[11px] text-gray-300">·</span>
                <span className="text-[11px] text-gray-500">
                  {pageCount} {pageCount === 1 ? "page" : "pages"}
                </span>
              </>
            )}
            {editCount > 0 && (
              <Badge color="yellow" className="text-[10px] py-0">
                {editCount} unsaved
              </Badge>
            )}
          </div>
        </div>
        {removable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onRemove!(id)}
            title="Remove from batch"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </Button>
        )}
      </div>

      {/* ---- Tabs ------------------------------------------------------- *
       * The Pages tab is ALWAYS rendered (even when not editable) so users
       * never have to guess whether the workflow exists for the current
       * document. When it isn't applicable we mute the label and add a
       * lock icon + tooltip explaining why; the tab body itself spells
       * out the reason and the alternative.                                */}
      <div className="px-2 border-b shrink-0 flex items-end gap-0">
        <TabButton active={tab === "preview"} onClick={() => setTab("preview")}>
          Preview
        </TabButton>
        <TabButton
          active={tab === "pages"}
          onClick={() => setTab("pages")}
          muted={!pagesEditable}
          title={
            pagesEditable
              ? "Remove individual pages before saving"
              : pagesEligibility.shortReason
          }
        >
          Pages
          {pagesEditable ? (
            editCount > 0 && (
              <span className="ml-1 inline-flex items-center justify-center min-w-[1.1rem] h-4 px-1 rounded-full bg-yellow-100 text-yellow-800 text-[10px] font-medium">
                {editCount}
              </span>
            )
          ) : (
            <Lock
              className="ml-1 h-3 w-3 text-gray-400"
              aria-label="Page editing not available for this document"
            />
          )}
        </TabButton>
        <TabButton active={tab === "details"} onClick={() => setTab("details")}>
          Details
        </TabButton>
      </div>

      {/* ---- Tab content ------------------------------------------------ */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "preview" && (
          <PreviewTab
            kind={kind}
            mime={mime}
            blobUrl={blobUrl.url}
            loading={blobUrl.loading}
            error={blobUrl.error}
            pagesEditable={pagesEditable}
            pageCount={pageCount}
            onSwitchToPages={() => setTab("pages")}
          />
        )}
        {tab === "pages" && (
          <PagesTab
            selection={selection}
            eligibility={pagesEligibility}
            removed={editsForThis ?? new Set()}
            pendingCommit={pendingEditsId === id}
            onTogglePage={onTogglePage}
            onRestoreAll={onRestoreAll}
            onCommitPageEdits={onCommitPageEdits}
          />
        )}
        {tab === "details" && (
          <DetailsTab selection={selection} blobUrlError={blobUrl.error} />
        )}
      </div>
    </div>
  );
}

/**
 * Why-the-Pages-tab-is-or-isn't-usable, in one place.
 *
 * Rendered as both:
 *   - the tab-label tooltip (`shortReason`)
 *   - the tab-body explanation block (`PagesTab` switches on `kind`)
 *
 * Keeping this as a discriminated union means there's exactly one source
 * of truth for "is this document eligible for page editing right now?"
 * — no chance of the tab label and the tab body disagreeing.
 *
 * `source` distinguishes queued vs persisted because the two follow very
 * different save paths (in-browser pdf-lib rewrite vs. server-side
 * pypdf rewrite + re-extract) and the user-facing copy differs accordingly.
 *
 * `pageCount` is nullable on the editable variant because for persisted
 * PDFs we don't know it until we round-trip the bytes; PagesTab probes
 * them and re-renders. For queued files the meta probe at addFiles time
 * has already filled it in.
 */
type PagesEligibility =
  | {
      kind: "editable";
      source: "queued" | "persisted";
      pageCount: number | null;
    }
  | { kind: "non_pdf"; shortReason: string }
  | { kind: "unparseable"; shortReason: string };

function computePagesEligibility(
  selection: PreviewSelection,
  /** Probed page count for persisted PDFs (null = not yet known / failed). */
  persistedPageCount: number | null = null,
  /** True while the persisted-PDF probe is still in flight. */
  persistedProbeLoading: boolean = false,
  /** Set to a human-readable reason if the persisted-PDF probe failed. */
  persistedProbeError: string | null = null,
): PagesEligibility {
  if (selection.kind === "persisted") {
    if (!isPdfMime(selection.document.mime_type)) {
      return {
        kind: "non_pdf",
        shortReason:
          "Page editing only works on PDFs. Use Remove from batch to drop this file.",
      };
    }
    // Probe failed (file is encrypted / malformed / can't be opened by
    // pdf-lib). Still surface the editor as "unparseable" with the
    // standard explanation so the user understands they can't trim it
    // even though it's a PDF.
    if (persistedProbeError) {
      return {
        kind: "unparseable",
        shortReason:
          "BillsIQ couldn't read this PDF's page structure, so per-page editing isn't available.",
      };
    }
    // Still probing OR successfully probed — both are "editable" so the
    // tab is enabled and the body renders the appropriate state
    // (loading spinner during probe, full editor once known).
    return {
      kind: "editable",
      source: "persisted",
      pageCount: persistedProbeLoading ? null : persistedPageCount,
    };
  }
  const t = selection.tracked;
  const isPdf = t.meta?.source === "pdf";
  if (!isPdf) {
    return {
      kind: "non_pdf",
      shortReason:
        "Page editing only works on PDFs. Use Remove from batch to drop this file.",
    };
  }
  const pageCount = t.meta?.pageCount ?? null;
  if (pageCount == null || pageCount === 0) {
    return {
      kind: "unparseable",
      shortReason:
        "BillsIQ couldn't parse this PDF, so per-page editing isn't available. The file will still upload normally.",
    };
  }
  return { kind: "editable", source: "queued", pageCount };
}

function TabButton({
  active,
  onClick,
  children,
  muted = false,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /**
   * Applied to "available but currently disabled" tabs (e.g. Pages tab on a
   * non-PDF file). The tab is still clickable — clicking shows the
   * explanation — but the label hints visually that nothing actionable
   * lives inside.
   */
  muted?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-disabled={muted ? "true" : undefined}
      className={cn(
        "px-3 py-2 -mb-px text-xs font-medium border-b-2 transition-colors flex items-center",
        active
          ? "border-brand-500 text-brand-700"
          : muted
            ? "border-transparent text-gray-400 hover:text-gray-500 hover:border-gray-200"
            : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300",
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Preview tab — fills available height; PDFs use #view=FitH for fit-width
// ---------------------------------------------------------------------------

function PreviewTab({
  kind,
  mime,
  blobUrl,
  loading,
  error,
  pagesEditable,
  pageCount,
  onSwitchToPages,
}: {
  kind: "pdf" | "image" | "other";
  mime: string;
  blobUrl: string | null;
  loading: boolean;
  error: string | null;
  /** Whether the Pages workflow is usable for the current document. */
  pagesEditable: boolean;
  /** Page count to mention in the CTA copy, when known. */
  pageCount: number | null;
  /** Switches the parent's tab state to the Pages tab. */
  onSwitchToPages: () => void;
}) {
  if (error) {
    return (
      <div className="p-4">
        <InlineAlert tone="error" title="Couldn't load file bytes">
          {error}
        </InlineAlert>
      </div>
    );
  }
  if (loading || blobUrl == null) {
    return (
      <div className="h-full w-full bg-gray-50 flex items-center justify-center">
        <p className="inline-flex items-center gap-2 text-xs text-gray-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading preview…
        </p>
      </div>
    );
  }

  // ---- CTA strip ---------------------------------------------------------
  // Surfaced ONLY when the Pages workflow is usable for this document and
  // there's actually more than one page to consider. This is the one
  // discoverability nudge from the preview area itself — keep it small and
  // single-line so it doesn't compete with the document.
  const cta =
    pagesEditable && pageCount != null && pageCount > 1 ? (
      <div className="border-b bg-brand-50/60 px-3 py-1.5 text-[11px] text-brand-800 flex items-center gap-1.5 shrink-0">
        <Scissors className="h-3 w-3 shrink-0 text-brand-600" />
        <span className="min-w-0 flex-1 truncate">
          {pageCount}-page PDF — remove individual pages before saving.
        </span>
        <button
          type="button"
          onClick={onSwitchToPages}
          className="font-medium text-brand-700 hover:text-brand-800 hover:underline shrink-0"
        >
          Open Pages →
        </button>
      </div>
    ) : null;

  if (kind === "pdf" || isPdfMime(mime)) {
    // Hash params steer the browser's built-in PDF viewer:
    //   view=FitH  → fit page width (the natural choice for invoices)
    //   toolbar=1  → keep the viewer's own toolbar usable (zoom, page nav)
    //   navpanes=0 → suppress the side thumbnail panel; we have our own
    //                Pages tab and the side panel eats horizontal space
    const src = `${blobUrl}#view=FitH&toolbar=1&navpanes=0`;
    return (
      <div className="h-full w-full flex flex-col min-h-0">
        {cta}
        <iframe
          src={src}
          title="PDF preview"
          className="w-full flex-1 bg-gray-50 border-0"
        />
      </div>
    );
  }
  if (kind === "image" || isImageMime(mime)) {
    return (
      <div className="h-full w-full overflow-auto bg-gray-50 flex items-center justify-center p-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={blobUrl}
          alt="Document preview"
          className="max-w-full max-h-full object-contain"
        />
      </div>
    );
  }
  return (
    <div className="h-full w-full bg-gray-50 flex flex-col items-center justify-center text-center px-6">
      <FileWarning className="h-8 w-8 text-gray-300 mb-2" />
      <p className="text-sm font-medium text-gray-600">
        Inline preview not supported for this file type.
      </p>
      <p className="text-xs text-gray-400 mt-1 max-w-sm">
        BillsIQ will still process and extract from it normally — the
        metadata in the Details tab is captured at upload time.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pages tab — page chips + Save/Restore controls
// ---------------------------------------------------------------------------

function PagesTab({
  selection,
  eligibility,
  removed,
  pendingCommit,
  onTogglePage,
  onRestoreAll,
  onCommitPageEdits,
}: {
  selection: PreviewSelection;
  eligibility: PagesEligibility;
  removed: ReadonlySet<number>;
  pendingCommit: boolean;
  onTogglePage: (id: string, pageNumber: number) => void;
  onRestoreAll: (id: string) => void;
  onCommitPageEdits: (id: string) => Promise<void>;
}) {
  const id =
    selection.kind === "queued" ? selection.tracked.id : selection.document.id;

  // Persisted-doc save is destructive (overwrites the stored file +
  // discards review state), so it requires explicit confirmation. Reset
  // the prompt whenever selection changes so it never lingers across docs.
  const [confirmingPersisted, setConfirmingPersisted] = useState(false);
  useEffect(() => {
    setConfirmingPersisted(false);
  }, [id]);

  // ---- Not editable: show a clear "what / why / what to do" block ------
  if (eligibility.kind !== "editable") {
    return <PagesUnavailable eligibility={eligibility} />;
  }

  // ---- Editable but page count not known yet (persisted probe in flight) -
  if (eligibility.pageCount == null) {
    return (
      <div className="h-full w-full bg-gray-50 flex items-center justify-center">
        <p className="inline-flex items-center gap-2 text-xs text-gray-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading PDF page count…
        </p>
      </div>
    );
  }

  // ---- Editable: full editor --------------------------------------------
  const pageCount = eligibility.pageCount;
  const editsCount = removed.size;
  const allMarked = editsCount === pageCount;
  const someMarked = editsCount > 0;
  const isPersisted = eligibility.source === "persisted";

  const handleSaveClick = () => {
    // Queued: fire immediately — the rewrite is local and reversible
    // (the user can re-add the original file).
    // Persisted: gate behind an explicit confirm so the user understands
    // the stored file gets replaced and any review state is discarded.
    if (!isPersisted) {
      void onCommitPageEdits(id);
      return;
    }
    setConfirmingPersisted(true);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* ---- Source-specific "how it works" intro --------------------- *
       * Queued: blue, just explains the in-browser rewrite.              *
       * Persisted: yellow, warns about the destructive consequences.    */}
      <div className="px-4 pt-3 shrink-0">
        {isPersisted ? (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-[11px] text-yellow-900 flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-yellow-600" />
            <div className="min-w-0">
              <p className="font-semibold">
                Trim a saved document
              </p>
              <p className="mt-0.5 text-yellow-900/80">
                Saving will replace the stored file with the trimmed version
                and re-run extraction. The previous extraction run, derived
                invoice, and any in-progress review state will be discarded.
                Mark pages now — nothing is changed until you confirm save.
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-brand-100 bg-brand-50/70 px-3 py-2 text-[11px] text-brand-900 flex items-start gap-2">
            <Scissors className="h-3.5 w-3.5 mt-0.5 shrink-0 text-brand-600" />
            <div className="min-w-0">
              <p className="font-semibold">Trim pages before upload</p>
              <p className="mt-0.5 text-brand-900/80">
                Click a page chip to mark it for removal — fully reversible
                until you save. Saving rewrites the queued PDF in your
                browser with <code className="font-mono">pdf-lib</code> and
                uploads the trimmed file. At least one page must remain.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ---- Inline confirm panel (persisted save only) -------------- */}
      {confirmingPersisted && (
        <div className="px-4 pt-3 shrink-0">
          <div className="rounded-md border border-yellow-300 bg-yellow-100/70 px-3 py-2.5 text-[11.5px] text-yellow-900 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-yellow-700" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Confirm trim and re-extract</p>
              <p className="mt-0.5 text-yellow-900/80">
                Removing{" "}
                <span className="font-medium">
                  {editsCount} page{editsCount === 1 ? "" : "s"}
                </span>{" "}
                will replace the stored file (new checksum, new bytes) and
                drop the existing extraction + invoice. This action can&apos;t
                be undone from here.
              </p>
              <div className="mt-2 flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  loading={pendingCommit}
                  onClick={() => {
                    setConfirmingPersisted(false);
                    void onCommitPageEdits(id);
                  }}
                  disabled={pendingCommit}
                >
                  <Save className="h-3.5 w-3.5" />
                  Yes, save and re-extract
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingPersisted(false)}
                  disabled={pendingCommit}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---- Toolbar -------------------------------------------------- */}
      <div className="px-4 py-2.5 mt-3 border-y bg-gray-50/50 flex items-center justify-between gap-2 flex-wrap shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-xs text-gray-700">
            <span className="font-medium">{pageCount}</span> total
            {someMarked && (
              <>
                <span className="text-gray-300 mx-1.5">·</span>
                <span className="text-yellow-700 font-medium">
                  {editsCount} marked for removal
                </span>
              </>
            )}
            {!someMarked && (
              <span className="text-gray-400 ml-2">
                Click a page to mark it for removal.
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onRestoreAll(id)}
            disabled={!someMarked || pendingCommit}
            title="Restore all pages marked for removal"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Restore all
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            loading={pendingCommit && !confirmingPersisted}
            onClick={handleSaveClick}
            disabled={
              !someMarked || allMarked || pendingCommit || confirmingPersisted
            }
            title={
              allMarked
                ? "At least one page must remain"
                : isPersisted
                  ? "Replace the stored file and re-run extraction"
                  : "Rewrite the PDF removing marked pages"
            }
          >
            <Save className="h-3.5 w-3.5" />
            {isPersisted ? "Save and re-extract" : "Save page changes"}
          </Button>
        </div>
      </div>

      {/* ---- Page grid ------------------------------------------------ */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(3.5rem,1fr))] gap-2">
          {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => {
            const isRemoved = removed.has(n);
            return (
              <button
                key={n}
                type="button"
                onClick={() => onTogglePage(id, n)}
                disabled={pendingCommit}
                aria-pressed={isRemoved}
                title={
                  isRemoved
                    ? `Page ${n} — marked for removal (click to restore)`
                    : `Page ${n} — click to mark for removal`
                }
                className={cn(
                  "relative aspect-[3/4] flex items-center justify-center rounded-md border text-xs font-medium transition-colors",
                  pendingCommit && "opacity-60 cursor-not-allowed",
                  isRemoved
                    ? "border-red-300 bg-red-50 text-red-600 line-through"
                    : "border-gray-200 bg-white text-gray-700 hover:border-brand-400 hover:bg-brand-50",
                )}
              >
                {n}
                {isRemoved && (
                  <X className="absolute h-5 w-5 text-red-500/70" strokeWidth={2.5} />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * The "this document isn't eligible for page editing" state.
 *
 * Same layout for every reason — the headline tells the user *what is being
 * shown*, the body tells them *why this document doesn't qualify*, and the
 * footer tells them *what to do instead*. That order matches how a reviewer
 * scans an unfamiliar panel: they want the headline to confirm they're in
 * the right place before reading the explanation.
 */
function PagesUnavailable({ eligibility }: { eligibility: PagesEligibility }) {
  let tone: "info" | "warning" = "info";
  let title = "";
  let why: React.ReactNode = null;
  let alternative: React.ReactNode = null;

  switch (eligibility.kind) {
    case "non_pdf":
      title = "Page editing only works on PDFs";
      why = (
        <>
          The selected file isn&apos;t a PDF, so there are no page boundaries
          to trim. Images are treated as a single page.
        </>
      );
      alternative = (
        <>
          To drop this file from the batch, click{" "}
          <span className="font-medium">Remove</span> in the header. To
          combine pages into a multi-page PDF, do that on the desktop first
          and re-add it.
        </>
      );
      break;
    case "unparseable":
      tone = "warning";
      title = "BillsIQ couldn't read the page structure";
      why = (
        <>
          The PDF parser couldn&apos;t determine a page count for this file
          — it may be encrypted, malformed, or use an unsupported encoding.
          Per-page editing is therefore disabled.
        </>
      );
      alternative = (
        <>
          The file will still upload and run through extraction normally,
          and many viewers can still display it. If you need to trim it,
          re-export the PDF from its source application and try again.
        </>
      );
      break;
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-3">
      <InlineAlert tone={tone} title={title}>
        {why}
      </InlineAlert>
      <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-700 flex items-start gap-2">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-gray-400" />
        <p>
          <span className="font-semibold text-gray-800">What to do:</span>{" "}
          {alternative}
        </p>
      </div>
      <p className="text-[11px] text-gray-500 flex items-start gap-1.5 px-1">
        <Scissors className="h-3 w-3 mt-0.5 shrink-0 text-gray-400" />
        <span>
          When page editing <em>is</em> available, this tab lets you click
          individual pages to mark them for removal, then save a trimmed
          PDF — entirely in your browser, before anything is uploaded.
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details tab — full metadata + duplicate conflict + extraction errors
// ---------------------------------------------------------------------------

function DetailsTab({
  selection,
  blobUrlError,
}: {
  selection: PreviewSelection;
  blobUrlError: string | null;
}) {
  if (selection.kind === "queued") {
    const t = selection.tracked;
    const meta = t.meta;
    const rows: { label: string; value: string; mono?: boolean }[] = [
      { label: "Filename", value: t.file.name },
      { label: "Size", value: formatFileSize(t.file.size) },
      { label: "MIME", value: t.file.type || "—" },
      ...(meta?.kindLabel ? [{ label: "Kind", value: meta.kindLabel }] : []),
      ...(meta?.pageCount != null
        ? [{ label: "Pages", value: String(meta.pageCount) }]
        : []),
      ...(t.result?.route_used
        ? [{ label: "Route", value: displayRoute(t.result.route_used) }]
        : []),
    ];
    return (
      <div className="h-full overflow-y-auto p-4 space-y-3">
        <MetaList rows={rows} />
        {t.error && (
          <InlineAlert tone="error" title="Upload failed">
            {t.error}
          </InlineAlert>
        )}
        {t.status === "duplicate" && t.result?.document_id != null && (
          <DuplicateConflictBlock conflictingDocumentId={t.result.document_id} />
        )}
      </div>
    );
  }

  // Persisted
  const d = selection.document;
  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: "Filename", value: d.original_filename },
    { label: "Size", value: formatFileSize(d.file_size_bytes) },
    { label: "MIME", value: d.mime_type || "—" },
    { label: "Route", value: displayRoute(d.route_used) },
    { label: "Uploaded", value: formatDate(d.created_at) },
    {
      label: "Checksum",
      value: d.checksum_sha256.slice(0, 16) + "…",
      mono: true,
    },
  ];
  return (
    <div className="h-full overflow-y-auto p-4 space-y-3">
      <MetaList rows={rows} />
      {blobUrlError && (
        <InlineAlert tone="error" title="Couldn't load file bytes">
          {blobUrlError}
        </InlineAlert>
      )}
      {d.error_message && (
        <InlineAlert tone="error" title="Extraction error">
          {d.error_message}
        </InlineAlert>
      )}
      <Link
        href={`/batches/${d.batch_id}`}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:text-brand-700"
      >
        Open in batch detail →
      </Link>
    </div>
  );
}

function MetaList({
  rows,
}: {
  rows: { label: string; value: string; mono?: boolean }[];
}) {
  return (
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[11.5px]">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-gray-500">{r.label}</dt>
          <dd
            className={cn(
              "text-gray-800 break-words",
              r.mono && "font-mono text-[11px]",
            )}
          >
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Duplicate conflict — fetched lazily from the server when a queued file
// resolves to status="duplicate".
// ---------------------------------------------------------------------------

function DuplicateConflictBlock({
  conflictingDocumentId,
}: {
  conflictingDocumentId: string;
}) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    documentsApi
      .get(conflictingDocumentId)
      .then((resp) => {
        if (!cancelled) setDoc(resp.document);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            getApiErrorMessage(err, "Couldn't load the conflicting document."),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [conflictingDocumentId]);

  return (
    <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-600 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-yellow-800">
            Already in BillsIQ
          </p>
          <p className="text-[11px] text-yellow-800/80 mt-0.5">
            The server matched this file by SHA-256 checksum to an existing
            document. It was not added to the current batch.
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-1.5 text-[11px] text-gray-700">
        {error && <p className="text-red-600">{error}</p>}
        {!error && doc == null && (
          <p className="text-gray-500">Loading conflict details…</p>
        )}
        {doc && (
          <>
            <DupRow icon={<FileText className="h-3.5 w-3.5" />}>
              <span className="font-medium">{doc.original_filename}</span>
            </DupRow>
            <DupRow icon={<Layers className="h-3.5 w-3.5" />}>
              <Link
                href={`/batches/${doc.batch_id}`}
                className="text-brand-600 hover:underline"
              >
                Open original batch
              </Link>
              <span className="text-gray-400 ml-1">
                · uploaded {formatDate(doc.created_at)}
              </span>
            </DupRow>
            <DupRow icon={<Hash className="h-3.5 w-3.5" />}>
              <code className="font-mono text-[10.5px] text-gray-500">
                {doc.checksum_sha256.slice(0, 16)}…
              </code>
            </DupRow>
            <div className="pt-1">
              <Badge color={displayDocumentStatus(doc).tone}>
                {displayDocumentStatus(doc).label}
              </Badge>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DupRow({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-gray-400">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// useFileBlobUrl — handles object-URL lifecycle for both queued and persisted
// ---------------------------------------------------------------------------

interface BlobState {
  url: string | null;
  loading: boolean;
  error: string | null;
}

function useFileBlobUrl(selection: PreviewSelection): BlobState {
  const queuedFile = selection.kind === "queued" ? selection.tracked.file : null;
  const persistedId = selection.kind === "persisted" ? selection.document.id : null;
  // Checksum participates in the effect deps so a server-side trim
  // (which mutates the document's bytes under the same id) refetches and
  // swaps the iframe instead of showing the cached pre-trim preview.
  // The same value is also passed as `?v=` so the browser HTTP cache
  // (Cache-Control: private, max-age=300) doesn't serve stale bytes.
  const persistedChecksum =
    selection.kind === "persisted" ? selection.document.checksum_sha256 : null;

  // For queued files we already have the bytes. useMemo keeps the URL
  // stable until the underlying File ref changes (which happens when the
  // user commits page edits and we swap in a fresh File).
  const queuedUrl = useMemo(
    () => (queuedFile ? URL.createObjectURL(queuedFile) : null),
    [queuedFile],
  );
  useEffect(() => {
    if (!queuedUrl) return;
    return () => URL.revokeObjectURL(queuedUrl);
  }, [queuedUrl]);

  // For persisted docs we have to round-trip to the server.
  const [persistedUrl, setPersistedUrl] = useState<string | null>(null);
  const [persistedLoading, setPersistedLoading] = useState(false);
  const [persistedError, setPersistedError] = useState<string | null>(null);

  useEffect(() => {
    if (persistedId == null) {
      setPersistedUrl(null);
      setPersistedLoading(false);
      setPersistedError(null);
      return;
    }
    let cancelled = false;
    let active: string | null = null;
    setPersistedUrl(null);
    setPersistedError(null);
    setPersistedLoading(true);
    documentsApi
      .fetchFileBlob(persistedId, persistedChecksum ?? undefined)
      .then((blob) => {
        if (cancelled) return;
        active = URL.createObjectURL(blob);
        setPersistedUrl(active);
      })
      .catch((err) => {
        if (!cancelled) {
          setPersistedError(getApiErrorMessage(err, "Couldn't load file."));
        }
      })
      .finally(() => {
        if (!cancelled) setPersistedLoading(false);
      });
    return () => {
      cancelled = true;
      if (active) URL.revokeObjectURL(active);
    };
  }, [persistedId, persistedChecksum]);

  if (selection.kind === "queued") {
    return { url: queuedUrl, loading: false, error: null };
  }
  return { url: persistedUrl, loading: persistedLoading, error: persistedError };
}

/**
 * Probe the page count of a persisted PDF by streaming its bytes and
 * loading them through pdf-lib. Returns `{ pageCount: null }` for non-
 * PDFs (no probe issued) and for queued selections (the meta probe
 * already filled this in at add-files time).
 *
 * Re-runs whenever the document's checksum changes, so a successful
 * trim updates the displayed page count without requiring the user
 * to re-select.
 */
function usePersistedPdfPageCount(selection: PreviewSelection): {
  pageCount: number | null;
  loading: boolean;
  error: string | null;
} {
  const isPersistedPdf =
    selection.kind === "persisted" && isPdfMime(selection.document.mime_type);
  const id = isPersistedPdf ? selection.document.id : null;
  // Re-probe when the bytes change (server-side trim flips the checksum).
  const checksum = isPersistedPdf ? selection.document.checksum_sha256 : null;

  const [pageCount, setPageCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id == null) {
      setPageCount(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setPageCount(null);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const blob = await documentsApi.fetchFileBlob(id, checksum ?? undefined);
        const buf = await blob.arrayBuffer();
        // Dynamic import keeps pdf-lib out of the initial chunk for
        // anyone who never opens the preview pane on a persisted PDF.
        const { PDFDocument } = await import("pdf-lib");
        const pdf = await PDFDocument.load(buf, {
          ignoreEncryption: true,
          updateMetadata: false,
        });
        if (cancelled) return;
        setPageCount(pdf.getPageCount());
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Couldn't read PDF page count.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, checksum]);

  return { pageCount, loading, error };
}

// ---------------------------------------------------------------------------
// TrackedFile status badge — mirrors DocumentNode's badge styling.
// ---------------------------------------------------------------------------

const QUEUED_LABEL: Record<TrackedFile["status"], string> = {
  queued: "Queued",
  uploading: "Uploading",
  uploaded: "Uploaded",
  extracted: "Extracted",
  duplicate: "Duplicate",
  failed: "Failed",
};

const QUEUED_COLOR: Record<
  TrackedFile["status"],
  "gray" | "blue" | "green" | "yellow" | "red"
> = {
  queued: "gray",
  uploading: "blue",
  uploaded: "blue",
  extracted: "green",
  duplicate: "yellow",
  failed: "red",
};

function TrackedStatusBadge({ status }: { status: TrackedFile["status"] }) {
  return <Badge color={QUEUED_COLOR[status]}>{QUEUED_LABEL[status]}</Badge>;
}
