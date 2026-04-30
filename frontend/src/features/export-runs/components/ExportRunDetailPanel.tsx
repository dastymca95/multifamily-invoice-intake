"use client";

import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";
import type { PersistedExportRunRead } from "@/types/export-run-persistence";

import { useExportRunDetail } from "../hooks/useExportRunDetail";
import { useExportRunNotesMutation } from "../hooks/useExportRunNotesMutation";
import {
  NOTES_MAX_CHARS,
  extractDraftHardPins,
  extractDraftSnapshotFields,
  formatExportRunTimestamp,
  formatProfileLabel,
  getPhaseLabel,
  getReasonLabel,
  getSourceLabel,
  getTargetSystemLabel,
  normalizeNotes,
  notesEqual,
  notesNearCap,
  safeStringifySnapshot,
} from "../lib/export-run-display";

import { ExportRunApprovalPanel } from "./ExportRunApprovalPanel";
import { ExportRunStatusBadge } from "./ExportRunStatusBadge";

/**
 * Phase 5C — Audit-record detail panel.
 *
 * Renders the full ``PersistedExportRunRead`` shape with:
 *   * Identity + lifecycle (id, phase, status, source, timestamps).
 *   * Profile snapshot (name, version, target system).
 *   * Soft FKs (template / document / batch) when present.
 *   * Row counts (rows / blocked / warning / issues).
 *   * Phase 4F hard pins surfaced verbatim from the embedded
 *     ``draft_snapshot``.
 *   * Operator-facing title / message + reasons + next steps from
 *     the snapshot.
 *   * Disclaimers from the snapshot, plus the panel's own.
 *   * Optional collapsible "Technical snapshot" with the request
 *     snapshot keys.
 *   * Notes textarea + Save button (PATCH /export-runs/{id}).
 *
 * The panel deliberately exposes ONLY notes editing. No
 * finalize / download / generate / post / delete actions.
 */

export function ExportRunDetailPanel({
  runId,
  open,
  onClose,
  /** Called with the freshly-saved record after a successful
   *  notes PATCH so the parent list page can refresh the row in
   *  place without a full refetch. */
  onRecordSaved,
}: {
  runId: string | null;
  open: boolean;
  onClose: () => void;
  onRecordSaved?: (record: PersistedExportRunRead) => void;
}) {
  const detail = useExportRunDetail(open ? runId : null);
  const notesMutation = useExportRunNotesMutation();

  // Local notes draft — synced from the loaded record but
  // editable. Saving PATCHes the backend; on success the detail
  // hook's setData is called with the response so the panel
  // shows the updated row immediately.
  const [notesDraft, setNotesDraft] = useState<string>("");
  const [notesDraftDirty, setNotesDraftDirty] = useState(false);

  // Sync the local draft from the loaded record whenever a fresh
  // record arrives AND the operator hasn't edited the textarea
  // since the last sync.
  useEffect(() => {
    if (!detail.data) return;
    if (notesDraftDirty) return;
    setNotesDraft(detail.data.notes ?? "");
  }, [detail.data, notesDraftDirty]);

  // When the modal closes, reset the dirty flag so a re-open
  // starts from the persisted notes again.
  useEffect(() => {
    if (!open) {
      setNotesDraftDirty(false);
      notesMutation.clearStatus();
    }
    // We deliberately don't depend on ``notesMutation`` —
    // ``clearStatus`` is a stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSaveNotes = async () => {
    if (!detail.data) return;
    try {
      const updated = await notesMutation.saveNotes(
        detail.data.id,
        notesDraft.length > 0 ? notesDraft : null,
      );
      // Refresh the detail panel + the parent list with the
      // freshly-saved record.
      detail.setData(updated);
      onRecordSaved?.(updated);
      setNotesDraftDirty(false);
    } catch {
      // The hook stores the error message on its own state; the
      // panel reads ``notesMutation.error`` to render the inline
      // banner.
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Draft audit record"
      size="xl"
    >
      <div className="space-y-3">
        {/* Boundary banner — always present so the operator can
            never misread the panel as proof of export. */}
        <div className="rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 text-[12px] text-blue-900 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-100">
          Audit record only — no export file was generated, no
          finalized export run was created, and no document, batch,
          template, or external system was modified.
        </div>

        {detail.loading && !detail.data && (
          <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading audit record…
          </div>
        )}

        {detail.error && (
          // Phase 5D — distinguish 404 ("record gone") from other
          // failures so the operator gets the right next-step
          // copy. ``getApiErrorMessage`` already includes the HTTP
          // detail; we look for the standard FastAPI 404 phrase
          // emitted by the Phase 5A endpoint (``"… not found"``).
          (() => {
            const isMissing =
              /not found/i.test(detail.error) ||
              / 404\b/.test(detail.error);
            return (
              <div
                className="rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-[12px] text-rose-900 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-100"
                role="alert"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-300" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      {isMissing
                        ? "This audit record could not be loaded"
                        : "Could not load audit record"}
                    </p>
                    {isMissing ? (
                      <p className="mt-0.5">
                        It may no longer be available. Close this
                        panel and refresh the list.
                      </p>
                    ) : (
                      <p className="mt-0.5 font-mono text-[10px] break-words">
                        {detail.error}
                      </p>
                    )}
                  </div>
                  {!isMissing && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={detail.retry}
                      title="Retry loading the audit record."
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Retry
                    </Button>
                  )}
                </div>
              </div>
            );
          })()
        )}

        {detail.data && (
          <ExportRunDetailBody
            record={detail.data}
            notesDraft={notesDraft}
            onChangeNotesDraft={(v) => {
              setNotesDraft(v);
              setNotesDraftDirty(true);
            }}
            onSaveNotes={handleSaveNotes}
            notesBusy={notesMutation.busy}
            notesError={notesMutation.error}
            notesSaved={notesMutation.saved}
            onClearNotesStatus={notesMutation.clearStatus}
            // Phase 6B — propagate the freshly-saved record from
            // an approval transition through the same setData /
            // parent-callback path as the notes save.
            onApprovalUpdated={(updated) => {
              detail.setData(updated);
              onRecordSaved?.(updated);
            }}
          />
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ExportRunDetailBody({
  record,
  notesDraft,
  onChangeNotesDraft,
  onSaveNotes,
  notesBusy,
  notesError,
  notesSaved,
  onClearNotesStatus,
  onApprovalUpdated,
}: {
  record: PersistedExportRunRead;
  notesDraft: string;
  onChangeNotesDraft: (next: string) => void;
  onSaveNotes: () => void;
  notesBusy: boolean;
  notesError: string | null;
  notesSaved: boolean;
  onClearNotesStatus: () => void;
  /** Phase 6B — invoked with the freshly-saved record after a
   *  successful approval transition so the modal + parent list
   *  refresh in place. */
  onApprovalUpdated: (next: PersistedExportRunRead) => void;
}) {
  const hardPins = extractDraftHardPins(record.draft_snapshot);
  const fields = extractDraftSnapshotFields(record.draft_snapshot);
  const profileLabel = formatProfileLabel(record);

  // Phase 5D — dirty detection via ``normalizeNotes`` so the Save
  // button stays disabled when the operator's edit collapses to
  // the same persisted value (e.g. typed " " in an empty field).
  const persistedNotes = useMemo(
    () => normalizeNotes(record.notes ?? null),
    [record.notes],
  );
  const draftNormalised = useMemo(
    () => normalizeNotes(notesDraft),
    [notesDraft],
  );
  const notesDirty = !notesEqual(persistedNotes, draftNormalised);
  const showCharCount = notesNearCap(notesDraft);

  // Phase 5D — safe technical-snapshot rendering. Cap + JSON
  // error handling + missing-shape handling. Both blobs reuse the
  // same helper so a malformed payload produces consistent copy.
  const requestSnapshotRender = useMemo(
    () => safeStringifySnapshot(record.request_snapshot, {
      emptyLabel: "No request snapshot captured.",
    }),
    [record.request_snapshot],
  );
  const draftSnapshotRender = useMemo(
    () => safeStringifySnapshot(record.draft_snapshot, {
      emptyLabel: "No draft snapshot captured.",
    }),
    [record.draft_snapshot],
  );

  return (
    <div className="space-y-3">
      {/* Identity + lifecycle */}
      <section className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-line dark:bg-surface-subtle">
        <div className="flex flex-wrap items-center gap-2">
          <ExportRunStatusBadge status={record.status} />
          <span
            className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10.5px] font-mono uppercase tracking-wide text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted"
            title={`Phase: ${getPhaseLabel(record.phase)}`}
          >
            phase: {record.phase || "—"}
          </span>
          <span
            className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10.5px] font-mono uppercase tracking-wide text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted"
            title={`Source: ${getSourceLabel(record.source)}`}
          >
            source: {record.source || "—"}
          </span>
        </div>
        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-2">
          <DLRow label="Audit record id" value={record.id} mono />
          <DLRow label="Created at" value={formatExportRunTimestamp(record.created_at)} />
          <DLRow label="Updated at" value={formatExportRunTimestamp(record.updated_at)} />
          <DLRow label="Profile" value={profileLabel} />
          <DLRow
            label="Profile id"
            value={record.export_profile_id ?? "—"}
            mono
          />
          <DLRow
            label="Target system"
            value={getTargetSystemLabel(record.target_system)}
          />
          <DLRow
            label="Template id"
            value={record.template_id ?? "—"}
            mono
          />
          <DLRow
            label="Document id"
            value={record.document_id ?? "—"}
            mono
          />
          <DLRow
            label="Batch id"
            value={record.batch_id ?? "—"}
            mono
          />
        </dl>
      </section>

      {/* Row counts */}
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <CountCard label="Rows" value={record.row_count} />
        <CountCard
          label="Blocked"
          value={record.blocked_row_count}
          tone="rose"
        />
        <CountCard
          label="Warnings"
          value={record.warning_row_count}
          tone="amber"
        />
        <CountCard label="Issues" value={record.issue_count} />
      </section>

      {/* Hard pins from the embedded snapshot */}
      <section className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-line dark:bg-surface-subtle">
        <p className="text-[11px] font-semibold text-gray-700 dark:text-ink-muted">
          Draft snapshot — hard-pinned literals
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <HardPinPill label="draft_only" value={hardPins.draft_only} expected />
          <HardPinPill label="finalized" value={hardPins.finalized} expected={false} />
          <HardPinPill label="file_generated" value={hardPins.file_generated} expected={false} />
          <HardPinPill label="download_available" value={hardPins.download_available} expected={false} />
          <HardPinPill label="production_export_ready" value={hardPins.production_export_ready} expected={false} />
        </div>
        <p className="mt-1 text-[10.5px] text-gray-600 dark:text-ink-muted">
          The Phase 4F draft contract pins these literals at the type
          layer. A "Not provided" pill means the snapshot is missing
          the flag — never assume export readiness from absence.
        </p>
      </section>

      {/* Operator-facing snapshot fields */}
      {(fields.operator_title || fields.operator_message) && (
        <section className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-line dark:bg-surface-subtle">
          {fields.operator_title && (
            <p className="text-[12px] font-semibold text-gray-800 dark:text-ink">
              {fields.operator_title}
            </p>
          )}
          {fields.operator_message && (
            <p className="mt-0.5 text-[11.5px] text-gray-700 dark:text-ink-muted">
              {fields.operator_message}
            </p>
          )}
        </section>
      )}

      {/* Reasons + next steps */}
      {(fields.reasons.length > 0 || fields.next_steps.length > 0) && (
        <section className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {fields.reasons.length > 0 && (
            <div className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-line dark:bg-surface-subtle">
              <p className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
                Reasons ({fields.reasons.length})
              </p>
              <ul className="mt-1 space-y-0.5 text-[11.5px] text-gray-800 dark:text-ink">
                {fields.reasons.map((reason) => (
                  <li key={reason} className="flex items-start gap-1.5">
                    <span className="mt-0.5 shrink-0 text-gray-400 dark:text-ink-subtle">
                      •
                    </span>
                    <span>
                      {getReasonLabel(reason)}{" "}
                      <span className="font-mono text-[10px] text-gray-400 dark:text-ink-subtle">
                        {reason}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {fields.next_steps.length > 0 && (
            <div className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-line dark:bg-surface-subtle">
              <p className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
                Next steps ({fields.next_steps.length})
              </p>
              <ol className="mt-1 list-decimal list-inside space-y-0.5 text-[11.5px] text-gray-800 dark:text-ink">
                {fields.next_steps.map((step, idx) => (
                  <li key={idx}>{step}</li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}

      {/* Disclaimers from the snapshot */}
      {fields.disclaimers.length > 0 && (
        <section className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 dark:border-line dark:bg-surface-muted">
          <ul className="space-y-0.5 text-[11px] text-gray-700 dark:text-ink-muted">
            {fields.disclaimers.map((line) => (
              <li key={line}>· {line}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Phase 6B — Approval workflow section. Sits ABOVE the
          Notes editor so the operator reads the workflow gate
          first, then the general audit notes. The panel handles
          its own busy / error / success state and writes ONLY the
          approval columns server-side. */}
      <ExportRunApprovalPanel
        record={record}
        onRecordUpdated={onApprovalUpdated}
      />

      {/* Notes editor */}
      <section className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-line dark:bg-surface-subtle">
        <label
          className="block text-[11px] font-semibold text-gray-700 dark:text-ink-muted"
          htmlFor={`audit-notes-${record.id}`}
        >
          Notes
        </label>
        <p className="mt-0.5 text-[10.5px] text-gray-600 dark:text-ink-muted">
          Notes are the only editable field. Saving notes does NOT
          generate a file or change export status. Whitespace-only
          input is treated as no notes.
        </p>
        <textarea
          id={`audit-notes-${record.id}`}
          className="mt-1 w-full resize-y rounded-md border border-gray-200 bg-white px-2 py-1 text-[12px] text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300 dark:border-line dark:bg-surface-subtle dark:text-ink dark:placeholder:text-ink-subtle"
          rows={3}
          value={notesDraft}
          onChange={(e) => onChangeNotesDraft(e.target.value)}
          placeholder="Optional notes for this audit record."
          disabled={notesBusy}
          maxLength={NOTES_MAX_CHARS}
        />
        {/* Phase 5D — character-count indicator only when the
            operator is approaching the cap. Stays out of sight
            otherwise so the chrome doesn't add noise. */}
        {showCharCount && (
          <p
            className={cn(
              "mt-0.5 text-right text-[10.5px]",
              notesDraft.length >= NOTES_MAX_CHARS
                ? "text-rose-700 dark:text-rose-200"
                : "text-gray-500 dark:text-ink-subtle",
            )}
            aria-live="polite"
          >
            {notesDraft.length} / {NOTES_MAX_CHARS}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onSaveNotes}
            // Phase 5D — disable when nothing changed, when busy,
            // or when the typed value collapses to the persisted
            // value (whitespace-only "edit" of an empty field).
            disabled={notesBusy || !notesDirty}
            title={
              notesBusy
                ? "Saving…"
                : !notesDirty
                  ? "No changes to save."
                  : "Save the updated notes (PATCH /export-runs/{id})."
            }
          >
            {notesBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            {notesBusy ? "Saving…" : "Save notes"}
          </Button>
          {!notesDirty && !notesBusy && !notesSaved && !notesError && (
            <p className="text-[11px] text-gray-500 dark:text-ink-subtle">
              No changes to save.
            </p>
          )}
          {notesSaved && !notesError && (
            <span className="inline-flex items-center gap-1 text-[11px] text-cyan-700 dark:text-cyan-200">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Notes saved
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClearNotesStatus}
                title="Dismiss the saved indicator."
              >
                Dismiss
              </Button>
            </span>
          )}
        </div>
        {notesError && (
          <div
            className="mt-2 rounded-md border border-rose-200 bg-rose-50/60 px-2 py-1.5 text-[11px] text-rose-900 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-100"
            role="alert"
          >
            <p className="font-semibold">Could not save notes</p>
            <p className="mt-0.5 font-mono text-[10px] break-words">
              {notesError}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClearNotesStatus}
              className="mt-1"
            >
              Dismiss
            </Button>
          </div>
        )}
      </section>

      {/* Optional technical snapshot — collapsed by default.
          Phase 5D — uses ``safeStringifySnapshot`` so missing /
          malformed / oversized payloads render with a clear
          operator-facing label instead of an empty `<pre>` or
          the literal string "undefined". JSON.stringify failures
          (circular ref, BigInt, etc.) surface with "Could not
          render snapshot safely." */}
      <details className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-line dark:bg-surface-subtle">
        <summary className="cursor-pointer text-[11px] text-gray-700 dark:text-ink-muted">
          Technical snapshot (diagnostic audit data)
        </summary>
        <div className="mt-2 space-y-2">
          <SafeSnapshotBlock
            label="Request snapshot"
            render={requestSnapshotRender}
          />
          <SafeSnapshotBlock
            label="Draft snapshot"
            render={draftSnapshotRender}
          />
          {fields.developer_message && (
            <p className="text-[10.5px] italic text-gray-600 dark:text-ink-muted">
              {fields.developer_message}
            </p>
          )}
        </div>
      </details>

      {/* Final disclaimer block — always present, never hidden. */}
      <section className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 dark:border-line dark:bg-surface-muted">
        <ul className="space-y-0.5 text-[11px] text-gray-700 dark:text-ink-muted">
          <li>· This id is an audit record id, not a finalized export id.</li>
          <li>· No export file was generated.</li>
          <li>· No finalized export run was created.</li>
          <li>· No document, batch, or template was marked exported.</li>
          <li>· No external accounting system was updated.</li>
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny render helpers
// ---------------------------------------------------------------------------

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

function CountCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "rose" | "amber";
}) {
  const valueClass =
    tone === "rose"
      ? "text-rose-700 dark:text-rose-200"
      : tone === "amber"
        ? "text-yellow-800 dark:text-yellow-200"
        : "text-gray-800 dark:text-ink";
  return (
    <div className="rounded-md border border-gray-200 bg-white px-2 py-1 dark:border-line dark:bg-surface-subtle">
      <p className="text-[10.5px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
        {label}
      </p>
      <p className={cn("text-base font-semibold", valueClass)}>{value}</p>
    </div>
  );
}

function HardPinPill({
  label,
  value,
  expected,
}: {
  label: string;
  /** ``true`` / ``false`` from the snapshot, or ``null`` when the
   *  flag was missing entirely. */
  value: boolean | null;
  /** What the Phase 4F contract pins this flag to. Used to flag
   *  any mismatch loudly (rose tone) — the backend re-validates
   *  on write so a mismatch on a healthy row is a regression. */
  expected: boolean;
}) {
  let text: string;
  let toneClass: string;
  if (value === null) {
    text = "Not provided";
    toneClass =
      "border-gray-200 bg-gray-50 text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted";
  } else if (value === expected) {
    text = value ? "Yes" : "No";
    toneClass =
      "border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950/40 dark:text-cyan-200";
  } else {
    // Mismatch — surface loudly; the operator should escalate.
    text = value ? "Yes (regression)" : "No (regression)";
    toneClass =
      "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200";
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-mono uppercase tracking-wide",
        toneClass,
      )}
      title={`${label} (Phase 4F contract: ${expected ? "Yes" : "No"})`}
    >
      {label}: {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Phase 5D — Safe snapshot block
// ---------------------------------------------------------------------------

/**
 * Renders one snapshot from the ``safeStringifySnapshot`` result.
 * Pure presentation:
 *
 *   * ``missing`` — operator-friendly empty-state copy.
 *   * ``ok`` — pretty-printed JSON inside a `<pre>` with the same
 *     ``max-h-40 overflow-auto`` cap Phase 5C used.
 *   * ``truncated`` — same `<pre>`, plus an italic note explaining
 *     the cap. The truncation note is already inlined into the
 *     ``text`` field by the helper.
 *   * ``error`` — single-line operator message + the underlying
 *     error inside a smaller monospace block (so a developer
 *     debugging a malformed snapshot still has the cause).
 *
 * Never uses ``dangerouslySetInnerHTML``. Never parses values from
 * the snapshot into clickable links / actions.
 */
function SafeSnapshotBlock({
  label,
  render,
}: {
  label: string;
  render: ReturnType<typeof safeStringifySnapshot>;
}) {
  return (
    <div>
      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
        {label}
      </p>
      {render.kind === "missing" && (
        <p className="mt-1 text-[11px] italic text-gray-500 dark:text-ink-subtle">
          {render.text}
        </p>
      )}
      {(render.kind === "ok" || render.kind === "truncated") && (
        <pre className="mt-1 max-h-40 overflow-auto rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] font-mono text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
          {render.text}
        </pre>
      )}
      {render.kind === "error" && (
        <div className="mt-1 rounded border border-rose-200 bg-rose-50/60 px-2 py-1 text-[11px] text-rose-900 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-100">
          <p className="font-semibold">{render.text}</p>
          <p className="mt-0.5 font-mono text-[10px] break-words">
            {render.error}
          </p>
        </div>
      )}
    </div>
  );
}
