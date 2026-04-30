"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import type { PersistedExportRunRead } from "@/types/export-run-persistence";

import {
  APPROVAL_NOTES_MAX_CHARS,
  REJECTION_REASON_MAX_CHARS,
  formatExportRunTimestamp,
  getApprovalControlsMode,
  getApprovalStatusDescription,
  getApprovalStatusLabel,
  getApprovalStatusTone,
  normalizeNotes,
} from "../lib/export-run-display";
import { useExportRunApprovalMutation } from "../hooks/useExportRunApprovalMutation";

import { ExportRunApprovalStatusBadge } from "./ExportRunApprovalStatusBadge";

/**
 * Phase 6B — Approval workflow section inside the audit detail
 * modal. Renders the current approval status + the metadata
 * captured at each transition + the controls for the next
 * available transition.
 *
 * Hard contract — even when the operator clicks "Approve for
 * file generation":
 *
 *   * ``phase`` remains ``"draft"`` (Phase 5A lock holds).
 *   * ``status`` is unchanged (Phase 5A vocabulary).
 *   * The embedded ``draft_snapshot`` hard pins
 *     (``draft_only`` / ``finalized`` / ``file_generated`` /
 *     ``download_available`` / ``production_export_ready``) are
 *     unchanged (Phase 4F hard pins hold).
 *   * No file is generated, no download URL issued, no document /
 *     batch / template mutated, no external system contacted, no
 *     export batch created.
 *
 * The panel deliberately exposes ONLY:
 *   * Request approval (manual click)
 *   * Approve for file generation (manual click; gated on
 *     ``status === "draft_clear"``)
 *   * Reject approval (manual click; requires non-empty
 *     ``rejection_reason``)
 *
 * NEVER renders Generate file / Download / Finalize / Send to
 * ResMan / Post to Yardi / Mark exported buttons.
 */

export function ExportRunApprovalPanel({
  record,
  onRecordUpdated,
}: {
  record: PersistedExportRunRead;
  /** Called with the freshly-saved record after a successful
   *  approval transition so the parent modal + list page can
   *  refresh in place without a full refetch. */
  onRecordUpdated: (next: PersistedExportRunRead) => void;
}) {
  const mutation = useExportRunApprovalMutation();
  const mode = getApprovalControlsMode(record.approval_status);

  const [approvalNotesDraft, setApprovalNotesDraft] = useState("");
  const [rejectionReasonDraft, setRejectionReasonDraft] = useState("");

  const tone = getApprovalStatusTone(record.approval_status);
  const description = getApprovalStatusDescription(record.approval_status);

  const draftClear = record.status === "draft_clear";
  const approveDisabled =
    !draftClear ||
    mutation.actionInFlight !== null;
  const trimmedReason = useMemo(
    () => normalizeNotes(rejectionReasonDraft),
    [rejectionReasonDraft],
  );
  const rejectDisabled =
    trimmedReason === null || mutation.actionInFlight !== null;

  // ---- Transition handlers ----------------------------------------
  const dispatchHandler =
    (run: () => Promise<PersistedExportRunRead>, resetDrafts: () => void) =>
    async () => {
      try {
        const updated = await run();
        onRecordUpdated(updated);
        resetDrafts();
      } catch {
        // The hook stores the error message on its own state; the
        // panel reads ``mutation.error`` to render the inline
        // banner. Drafts are intentionally preserved on failure
        // so the operator can retry without re-typing.
      }
    };

  const handleRequestApproval = dispatchHandler(
    () =>
      mutation.requestApproval(record.id, {
        approval_notes: normalizeNotes(approvalNotesDraft),
      }),
    () => setApprovalNotesDraft(""),
  );

  const handleApproveForFileGeneration = dispatchHandler(
    () =>
      mutation.approveForFileGeneration(record.id, {
        approval_notes: normalizeNotes(approvalNotesDraft),
      }),
    () => setApprovalNotesDraft(""),
  );

  const handleRejectApproval = dispatchHandler(
    () => {
      const reason = trimmedReason ?? "";
      return mutation.rejectApproval(record.id, {
        rejection_reason: reason,
        approval_notes: normalizeNotes(approvalNotesDraft),
      });
    },
    () => {
      setApprovalNotesDraft("");
      setRejectionReasonDraft("");
    },
  );

  return (
    <section
      className={cn(
        "rounded-md border px-3 py-2.5",
        tone.border,
        tone.bg,
      )}
      aria-label="Approval workflow"
    >
      <header className="flex flex-wrap items-center gap-2">
        <ShieldCheck
          className={cn("h-4 w-4 shrink-0", tone.text)}
          aria-hidden
        />
        <p className={cn("text-sm font-semibold", tone.text)}>
          Approval workflow
        </p>
        <ExportRunApprovalStatusBadge status={record.approval_status} />
      </header>

      {description && (
        <p className={cn("mt-1 text-[11.5px]", tone.text)}>
          {description}
        </p>
      )}

      {/* Always-on contract reminder. Sits directly under the
          status so a paste-into-Slack reader can never misread an
          "Approved for file generation" pill as proof of export. */}
      <p className="mt-1 text-[10.5px] italic text-gray-700 dark:text-ink-muted">
        Approval is a workflow gate only. Rivera still has not
        generated an export file, finalized an export, marked
        records exported, or posted to an external system.
      </p>

      {/* Metadata grid */}
      <ApprovalMetadataGrid record={record} />

      {/* Inline error banner */}
      {mutation.error && (
        <div
          className="mt-2 rounded-md border border-rose-200 bg-rose-50/80 px-2 py-1.5 text-[11px] text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100"
          role="alert"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                Approval transition failed
              </p>
              <p className="mt-0.5 font-mono text-[10px] break-words">
                {mutation.error}
              </p>
              <p className="mt-1 text-[10.5px] italic">
                If the reason mentions the current state, the
                record may not be eligible for this transition.
                See ``docs/export-run-persistence-contract.md``
                §6.1 for the rules. Your typed input has been
                preserved.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={mutation.clearStatus}
              title="Dismiss the error message."
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Inline success banner */}
      {mutation.lastSuccessAction && !mutation.error && (
        <div
          className="mt-2 rounded-md border border-cyan-200 bg-cyan-50/80 px-2 py-1.5 text-[11px] text-cyan-900 dark:border-cyan-900 dark:bg-cyan-950/40 dark:text-cyan-100"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Approval status updated.</p>
              <p className="mt-0.5">
                No file was generated. No export was finalized.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={mutation.clearStatus}
              title="Dismiss the success indicator."
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Controls — one of four modes */}
      {mode === "request" && (
        <RequestApprovalControls
          approvalNotes={approvalNotesDraft}
          onChangeApprovalNotes={setApprovalNotesDraft}
          busyAction={mutation.actionInFlight}
          rejectedSourceState={record.approval_status === "rejected"}
          onSubmit={handleRequestApproval}
        />
      )}

      {mode === "approve_or_reject" && (
        <ApproveOrRejectControls
          approvalNotes={approvalNotesDraft}
          onChangeApprovalNotes={setApprovalNotesDraft}
          rejectionReason={rejectionReasonDraft}
          onChangeRejectionReason={setRejectionReasonDraft}
          draftClear={draftClear}
          recordStatusLabel={record.status}
          approveDisabled={approveDisabled}
          rejectDisabled={rejectDisabled}
          busyAction={mutation.actionInFlight}
          onApprove={handleApproveForFileGeneration}
          onReject={handleRejectApproval}
        />
      )}

      {mode === "terminal" && <TerminalApprovedNotice />}

      {mode === "unknown" && (
        <p className="mt-2 text-[11px] italic text-gray-700 dark:text-ink-muted">
          Unknown approval state. No workflow action is available
          on this record. Approval status from the backend:{" "}
          <span className="font-mono">
            {getApprovalStatusLabel(record.approval_status)}
          </span>
          .
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Metadata grid — request / approve / reject timestamps + actors
// ---------------------------------------------------------------------------

function ApprovalMetadataGrid({
  record,
}: {
  record: PersistedExportRunRead;
}) {
  const hasRequested = !!record.approval_requested_at;
  const hasApproved = !!record.approved_at;
  const hasRejected = !!record.rejected_at;
  const hasNotes = !!record.approval_notes;
  const hasReason = !!record.rejection_reason;

  if (
    !hasRequested &&
    !hasApproved &&
    !hasRejected &&
    !hasNotes &&
    !hasReason
  ) {
    return null;
  }

  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[11.5px] sm:grid-cols-2">
      {hasRequested && (
        <DLRow
          label="Requested at"
          value={formatExportRunTimestamp(record.approval_requested_at)}
        />
      )}
      {hasRequested && (
        <DLRow
          label="Requested by"
          value={record.approval_requested_by_user_id ?? "—"}
          mono
        />
      )}
      {hasApproved && (
        <DLRow
          label="Approved at"
          value={formatExportRunTimestamp(record.approved_at)}
        />
      )}
      {hasApproved && (
        <DLRow
          label="Approved by"
          value={record.approved_by_user_id ?? "—"}
          mono
        />
      )}
      {hasRejected && (
        <DLRow
          label="Rejected at"
          value={formatExportRunTimestamp(record.rejected_at)}
        />
      )}
      {hasRejected && (
        <DLRow
          label="Rejected by"
          value={record.rejected_by_user_id ?? "—"}
          mono
        />
      )}
      {hasReason && (
        <div className="col-span-1 sm:col-span-2">
          <dt className="text-[10.5px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
            Rejection reason:
          </dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-[11.5px] text-rose-900 dark:text-rose-100">
            {record.rejection_reason}
          </dd>
        </div>
      )}
      {hasNotes && (
        <div className="col-span-1 sm:col-span-2">
          <dt className="text-[10.5px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
            Approval notes:
          </dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-[11.5px] text-gray-800 dark:text-ink">
            {record.approval_notes}
          </dd>
        </div>
      )}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Request approval controls (not_requested / rejected source states)
// ---------------------------------------------------------------------------

function RequestApprovalControls({
  approvalNotes,
  onChangeApprovalNotes,
  busyAction,
  rejectedSourceState,
  onSubmit,
}: {
  approvalNotes: string;
  onChangeApprovalNotes: (next: string) => void;
  busyAction: "request" | "approve" | "reject" | null;
  rejectedSourceState: boolean;
  onSubmit: () => void;
}) {
  const isBusy = busyAction === "request";
  return (
    <div className="mt-3 space-y-2 border-t border-gray-200 pt-2 dark:border-line">
      <ApprovalNotesTextarea
        value={approvalNotes}
        onChange={onChangeApprovalNotes}
        disabled={busyAction !== null}
        labelHint={
          rejectedSourceState
            ? "Optional context for the next reviewer."
            : "Optional context for the reviewer."
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onSubmit}
          disabled={busyAction !== null}
          title={
            rejectedSourceState
              ? "Re-request reviewer attention. Clears the previous rejection metadata."
              : "Request reviewer attention for this audit record."
          }
        >
          {isBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
          {isBusy
            ? "Requesting…"
            : rejectedSourceState
              ? "Request approval again"
              : "Request approval"}
        </Button>
        <p className="text-[10.5px] text-gray-600 dark:text-ink-muted">
          Workflow metadata only. No file is generated.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approve / reject controls (pending_review source state)
// ---------------------------------------------------------------------------

function ApproveOrRejectControls({
  approvalNotes,
  onChangeApprovalNotes,
  rejectionReason,
  onChangeRejectionReason,
  draftClear,
  recordStatusLabel,
  approveDisabled,
  rejectDisabled,
  busyAction,
  onApprove,
  onReject,
}: {
  approvalNotes: string;
  onChangeApprovalNotes: (next: string) => void;
  rejectionReason: string;
  onChangeRejectionReason: (next: string) => void;
  draftClear: boolean;
  recordStatusLabel: string;
  approveDisabled: boolean;
  rejectDisabled: boolean;
  busyAction: "request" | "approve" | "reject" | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  const approveBusy = busyAction === "approve";
  const rejectBusy = busyAction === "reject";
  return (
    <div className="mt-3 space-y-3 border-t border-gray-200 pt-2 dark:border-line">
      <ApprovalNotesTextarea
        value={approvalNotes}
        onChange={onChangeApprovalNotes}
        disabled={busyAction !== null}
        labelHint="Optional reviewer context. Stored alongside the transition."
      />

      {/* Approve sub-section */}
      <div>
        <p className="text-[11px] font-semibold text-gray-700 dark:text-ink-muted">
          Approve for file generation
        </p>
        <p className="mt-0.5 text-[10.5px] text-gray-600 dark:text-ink-muted">
          Approval is a workflow gate only. No file is generated
          and no export is finalized.
        </p>
        {!draftClear && (
          <div className="mt-1 flex items-start gap-1 rounded border border-yellow-200 bg-yellow-50 px-2 py-1 text-[10.5px] text-yellow-900 dark:border-yellow-900 dark:bg-yellow-950/30 dark:text-yellow-100">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              Only{" "}
              <span className="font-mono">draft_clear</span>{" "}
              records can be approved for file generation. The
              backend will reject this transition for status{" "}
              <span className="font-mono">{recordStatusLabel}</span>.
            </span>
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onApprove}
            disabled={approveDisabled}
            title={
              !draftClear
                ? "Only draft_clear records can be approved for file generation."
                : approveBusy
                  ? "Saving…"
                  : "Mark this audit record as approved for file generation. No file is generated."
            }
          >
            {approveBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            {approveBusy ? "Approving…" : "Approve for file generation"}
          </Button>
        </div>
      </div>

      {/* Reject sub-section */}
      <div>
        <p className="text-[11px] font-semibold text-gray-700 dark:text-ink-muted">
          Reject
        </p>
        <p className="mt-0.5 text-[10.5px] text-gray-600 dark:text-ink-muted">
          A non-empty rejection reason is required.
        </p>
        <RejectionReasonTextarea
          value={rejectionReason}
          onChange={onChangeRejectionReason}
          disabled={busyAction !== null}
        />
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onReject}
            disabled={rejectDisabled}
            title={
              rejectDisabled && !rejectBusy
                ? "Add a rejection reason before rejecting."
                : rejectBusy
                  ? "Saving…"
                  : "Reject the approval request. Persists the rejection reason on the audit record."
            }
          >
            {rejectBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
            {rejectBusy ? "Rejecting…" : "Reject approval"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal-for-this-phase notice (approved_for_file_generation)
// ---------------------------------------------------------------------------

function TerminalApprovedNotice() {
  return (
    <div className="mt-3 rounded-md border border-cyan-200 bg-cyan-50/60 px-3 py-2 text-[11px] text-cyan-900 dark:border-cyan-900 dark:bg-cyan-950/30 dark:text-cyan-100">
      <p className="font-semibold">
        Approved for file generation. No file has been generated yet.
      </p>
      <ul className="mt-1 space-y-0.5">
        <li>· No export file was generated.</li>
        <li>· No export run has been finalized.</li>
        <li>· No download URL was issued.</li>
        <li>· No document, batch, or template was marked exported.</li>
        <li>· No external accounting system was updated.</li>
      </ul>
      <p className="mt-1 text-[10.5px] italic">
        ``approved_for_file_generation`` is terminal for this
        phase. A future controlled file-generation phase MAY use
        it as a prerequisite. Until then, no further workflow
        action is available on this record.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny render helpers
// ---------------------------------------------------------------------------

function ApprovalNotesTextarea({
  value,
  onChange,
  disabled,
  labelHint,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  labelHint: string;
}) {
  return (
    <div>
      <label
        className="block text-[11px] font-semibold text-gray-700 dark:text-ink-muted"
        htmlFor="export-run-approval-notes"
      >
        Approval notes
        <span className="ml-1 text-[10.5px] font-normal text-gray-500 dark:text-ink-subtle">
          (optional)
        </span>
      </label>
      <p className="mt-0.5 text-[10.5px] text-gray-600 dark:text-ink-muted">
        {labelHint} Whitespace-only input is treated as no notes.
      </p>
      <textarea
        id="export-run-approval-notes"
        className="mt-1 w-full resize-y rounded-md border border-gray-200 bg-white px-2 py-1 text-[12px] text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300 dark:border-line dark:bg-surface-subtle dark:text-ink dark:placeholder:text-ink-subtle"
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Optional approval notes."
        disabled={disabled}
        maxLength={APPROVAL_NOTES_MAX_CHARS}
      />
    </div>
  );
}

function RejectionReasonTextarea({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-1">
      <label
        className="block text-[11px] font-semibold text-gray-700 dark:text-ink-muted"
        htmlFor="export-run-rejection-reason"
      >
        Rejection reason
        <span className="ml-1 text-[10.5px] font-normal text-rose-700 dark:text-rose-300">
          (required)
        </span>
      </label>
      <textarea
        id="export-run-rejection-reason"
        className="mt-1 w-full resize-y rounded-md border border-gray-200 bg-white px-2 py-1 text-[12px] text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300 dark:border-line dark:bg-surface-subtle dark:text-ink dark:placeholder:text-ink-subtle"
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Why is this audit record being rejected?"
        disabled={disabled}
        maxLength={REJECTION_REASON_MAX_CHARS}
      />
    </div>
  );
}

function DLRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-[10.5px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
        {label}:
      </dt>
      <dd
        className={cn(
          "min-w-0 flex-1 truncate text-gray-800 dark:text-ink",
          mono && "font-mono text-[11px]",
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
