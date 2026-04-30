/**
 * Phase 5B — Frontend ↔ backend Export Run persistence adapter.
 *
 * Bridges the panel's diagnostic state into the small Phase 5A
 * persistence request body, plus the operator-facing
 * source-marker copy for the new "Persisted Draft Audit Record"
 * section in the full report.
 *
 * Design rules:
 *
 *   * Pure / synchronous — no React, no fetch, no DOM.
 *   * Never mutates the inputs.
 *   * Diagnostic only — the persisted record is a draft / audit
 *     row, NOT a finalised export. The adapter NEVER includes raw
 *     resolver result, raw rows, raw documents, raw extracted
 *     facts, raw catalog hints, raw PDFs, or any PII-sized
 *     payload.
 *   * Phase 3O / 4I regression — the request body is a SUBSET of
 *     the Phase 4F draft request the backend already accepts plus
 *     the small Phase 5A persistence-specific fields
 *     (``source`` / ``notes`` / ``export_profile_*`` /
 *     ``target_system`` / ``template_id`` / ``document_id`` /
 *     ``batch_id``). The backend re-evaluates the verdict
 *     locally; the frontend NEVER sends a forged
 *     ``draft_result``.
 */

import type { OperationalResolutionResult } from "@/types/operational-resolution";
import type {
  BackendExportRunDraftInput,
  BackendExportRunDraftRequest,
  BackendExportRunDraftResult,
} from "@/types/export-run-draft";
import type {
  PersistedExportRunCreate,
  PersistedExportRunRead,
  PersistedExportRunSource,
} from "@/types/export-run-persistence";

import type { ExportProfile } from "./export-profile-contract";
import type { OperationalExportPreview } from "./operational-export-preview";
import type { ExportProfileValidationResult } from "./export-profile-validation";
import type { ExportProfileSelectionOption } from "./export-profile-selection";
import type { ExportReadinessBoundary } from "./export-readiness-boundary";

// ---------------------------------------------------------------------------
// Public — request builder
// ---------------------------------------------------------------------------

export interface BuildPersistedExportRunDraftCreatePayloadArgs {
  /** The Phase 4F draft request the panel ALREADY built via
   *  ``buildBackendExportRunDraftRequest``. Re-using it keeps the
   *  ``draft_input`` exactly identical to what the evaluator
   *  endpoint received, so the persisted snapshot's input echo
   *  matches the diagnostic banner the operator sees. */
  draftRequest: BackendExportRunDraftRequest;
  /** The current draft verdict (when available). Only included
   *  when ``staleDraftResult === false`` — a stale verdict would
   *  encourage the backend to compare against an out-of-date set
   *  of hard-pinned literals. The backend re-evaluates anyway,
   *  but the frontend should never make stale data look canonical. */
  draftResult: BackendExportRunDraftResult | null;
  /** TRUE when the draft hook is currently showing last-known-good
   *  data while a fresh request is in flight or just failed. When
   *  TRUE the adapter omits ``draft_result`` and lets the backend
   *  re-evaluate from ``draft_input`` alone. */
  staleDraftResult: boolean;
  /** Operational result so the adapter can extract template /
   *  document / batch ids when ``draft_input`` doesn't already
   *  carry them. Pure echo — never loaded from the backend. */
  result: OperationalResolutionResult | null;
  /** Operator-selected option (saved vs. built-in). Drives
   *  ``export_profile_id`` (only set for saved options) and
   *  ``export_profile_name`` / ``export_profile_version``. */
  selectedExportOption: ExportProfileSelectionOption | null;
  /** Active profile contract; provides ``target_system``. */
  selectedExportProfile: ExportProfile | null;
  /** Active validation result. Carried for parity with the
   *  evaluator request shape — currently only used to confirm a
   *  profile is selected; the backend re-evaluates regardless. */
  activeProfileValidation?: ExportProfileValidationResult | null;
  /** Active readiness boundary. Carried for parity. */
  activeReadinessBoundary?: ExportReadinessBoundary | null;
  /** Active export preview. Carried for parity — already echoed
   *  into ``draft_input``. */
  exportPreview?: OperationalExportPreview | null;
  /** Optional operator-supplied notes. Trimmed; empty becomes null. */
  notes?: string | null;
  /** Source label. Defaults to ``operational_preview``. */
  source?: PersistedExportRunSource;
}

/**
 * Build the backend ``createDraft`` request payload from the
 * panel's current diagnostic state. Pure — never mutates the
 * inputs.
 *
 * Sends ONLY:
 *   * The verbatim Phase 4F ``draft_input`` (already sanitised by
 *     the evaluator request builder).
 *   * The current ``draft_result`` when it is NOT stale.
 *   * Small persistence-specific metadata (source, notes,
 *     profile snapshot, target system, soft FKs to template /
 *     document / batch ids).
 *
 * NEVER sends raw resolver output, raw rows, raw documents, raw
 * extracted facts, raw catalog hints, raw PDFs, or any PII-sized
 * payload.
 */
export function buildPersistedExportRunDraftCreatePayload(
  args: BuildPersistedExportRunDraftCreatePayloadArgs,
): PersistedExportRunCreate {
  const {
    draftRequest,
    draftResult,
    staleDraftResult,
    result,
    selectedExportOption,
    selectedExportProfile,
    notes,
    source,
  } = args;

  // ---- draft_input — verbatim echo of the evaluator request -----
  // The Phase 4F evaluator request builder already filtered the
  // diagnostic snapshot through the ``EXPORT_RUN_DRAFT_CONTEXT_ALLOWLIST``
  // and normalised every count. Reusing the same input keeps the
  // persisted snapshot identical to what the operator just saw on
  // the panel.
  const draftInput: BackendExportRunDraftInput = draftRequest.input;

  // ---- draft_result — only when NOT stale ----------------------
  // A stale verdict was evaluated against an OLDER input
  // fingerprint than ``draft_input``. The backend would still
  // re-evaluate locally and detect the mismatch as a hard-pin
  // disagreement (or accept it if the snapshot is structurally
  // compatible) — but the frontend should never make stale data
  // look canonical.
  const includeDraftResult = !!draftResult && !staleDraftResult;

  // ---- profile snapshot ----------------------------------------
  // ``export_profile_id`` is the SAVED catalog id only. Built-in
  // starters use a non-UUID id; the backend explicitly avoids
  // coercing those into the soft FK column, so we do the same on
  // the wire.
  let exportProfileId: string | null = null;
  let exportProfileVersion: number | null = null;
  if (
    selectedExportOption &&
    selectedExportOption.source === "saved"
  ) {
    exportProfileId = selectedExportOption.persisted_profile_id;
    exportProfileVersion = selectedExportOption.version;
  }
  const exportProfileName: string | null =
    selectedExportOption?.label ??
    selectedExportProfile?.name ??
    null;

  // ---- target_system -------------------------------------------
  // Prefer the contract's target system (canonical) and fall back
  // to the option's snapshot label when the contract isn't loaded
  // yet (saved profile, contract fetch in flight).
  const targetSystem: string | null =
    selectedExportProfile?.target_system ??
    selectedExportOption?.target_system ??
    null;

  // ---- Soft FKs (template / document / batch) ------------------
  // Prefer the explicit ``draft_input`` echo; fall back to the
  // ``OperationalResolutionResult`` top-level fields when the
  // input didn't carry them. Pure echo — never loaded.
  const templateId: string | null =
    draftInput.template_id ?? result?.template_id ?? null;
  const documentId: string | null =
    draftInput.document_id ?? result?.document_id ?? null;
  const batchId: string | null =
    draftInput.batch_id ?? result?.batch_id ?? null;

  // ---- Notes (trimmed; empty → null) ---------------------------
  const trimmedNotes =
    typeof notes === "string" ? notes.trim() : notes ?? null;
  const notesValue: string | null =
    typeof trimmedNotes === "string"
      ? trimmedNotes.length > 0
        ? trimmedNotes
        : null
      : null;

  const payload: PersistedExportRunCreate = {
    draft_input: draftInput,
    source: source ?? "operational_preview",
  };
  if (includeDraftResult && draftResult) {
    payload.draft_result = draftResult;
  }
  if (notesValue !== null) {
    payload.notes = notesValue;
  }
  if (exportProfileId !== null) {
    payload.export_profile_id = exportProfileId;
  }
  if (exportProfileName !== null) {
    payload.export_profile_name = exportProfileName;
  }
  if (exportProfileVersion !== null) {
    payload.export_profile_version = exportProfileVersion;
  }
  if (targetSystem !== null) {
    payload.target_system = targetSystem;
  }
  if (templateId !== null) {
    payload.template_id = templateId;
  }
  if (documentId !== null) {
    payload.document_id = documentId;
  }
  if (batchId !== null) {
    payload.batch_id = batchId;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Public — fingerprint helper (stale-after-save detection)
// ---------------------------------------------------------------------------

/**
 * Stable fingerprint of the diagnostic snapshot the panel is
 * about to persist. The hook stamps this on the saved record so
 * the panel can detect "preview changed since save" without
 * re-fetching.
 *
 * Pure — order-stable, JSON-friendly. Built from the cheap
 * derived signals the Phase 4G hook already computes. Order
 * matters; new fields go on the END so existing fingerprints
 * stay comparable.
 */
export function exportRunDraftSaveFingerprint(
  args: Pick<
    BuildPersistedExportRunDraftCreatePayloadArgs,
    "draftRequest" | "selectedExportOption"
  >,
): string {
  const di = args.draftRequest.input;
  return [
    di.operational_result_id ?? "",
    di.template_id ?? "",
    di.document_id ?? "",
    di.batch_id ?? "",
    di.selected_profile_id ?? "",
    di.selected_profile_source ?? "",
    di.profile_validation_status ?? "",
    di.readiness_diagnostic_status ?? "",
    String(di.export_preview_row_count ?? 0),
    String(di.export_preview_issue_count ?? 0),
    String(di.blocked_row_count ?? 0),
    String(di.warning_row_count ?? 0),
    args.selectedExportOption?.option_id ?? "",
    args.selectedExportOption?.source ?? "",
    args.selectedExportOption?.source === "saved"
      ? String(args.selectedExportOption.version)
      : "",
  ].join("|");
}

// ---------------------------------------------------------------------------
// Public — operator-facing source marker (for the full report)
// ---------------------------------------------------------------------------

/**
 * Single-line operator-facing marker for Markdown reports.
 * Honest about what the persisted record IS (a draft / audit row)
 * and what it ISN'T (a finalised export, a file, an external
 * posting).
 *
 * The wording is deliberately:
 *   * Calls the id "audit record id" — never "export run id".
 *   * Always says "phase=draft" verbatim so a future approval
 *     phase can extend this without rewriting older reports.
 *   * Always reaffirms "no export file generated" so a
 *     paste-into-Slack reader can't misread the line as proof
 *     of export.
 */
export function persistedDraftRecordSourceMarker(
  record: PersistedExportRunRead | null,
): string {
  if (!record) {
    return "Persisted draft audit record: none saved.";
  }
  return (
    `Persisted draft audit record saved (id=${record.id}, ` +
    `phase=${record.phase}, status=${record.status}). ` +
    "Audit record id only — no export file was generated, no " +
    "export run was finalized."
  );
}

// ---------------------------------------------------------------------------
// Public — small operator-facing copy bucket (panel surfaces)
// ---------------------------------------------------------------------------

/**
 * Helper for the Save Draft Audit Record button's tooltip + the
 * success card body. Centralised so the wording stays consistent
 * between panel + report.
 */
export const PERSISTED_DRAFT_RECORD_DISCLAIMERS: readonly string[] = [
  "No export file was generated.",
  "This is not a finalized export.",
  "No document, batch, or template was marked exported.",
  "No external accounting system was updated.",
] as const;
