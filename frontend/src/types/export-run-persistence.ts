/**
 * Phase 5B — Frontend mirror of the Phase 5A backend persisted
 * Export Run Draft / audit contract
 * (``backend/app/schemas/export_run_persistence.py``).
 *
 * The endpoint family:
 *
 *   POST  /api/v1/export-runs/drafts        -> create
 *   GET   /api/v1/export-runs               -> list (summaries)
 *   GET   /api/v1/export-runs/{id}          -> read full record
 *   PATCH /api/v1/export-runs/{id}          -> notes-only update
 *
 * persists the verdict from the diagnostic Phase 4F draft endpoint
 * as an audit row. The persisted ``id`` is a DRAFT / AUDIT record
 * id — NOT a finalized export id, NOT a file id, NOT proof of
 * export, and does NOT imply document / batch / template /
 * external-system mutation. See ``docs/export-run-draft-contract.md``
 * §11 for the full contract.
 *
 * Why a dedicated ``Persisted*`` namespace:
 *   * Keeps the type sharp on the wire (closed enums for status /
 *     phase / source).
 *   * Forward-compat: status / source / phase fields are widened
 *     to plain ``string`` so a future backend extension renders
 *     gracefully.
 *   * The frontend deliberately uses the field name ``id`` — never
 *     ``export_run_id`` — to keep the Phase 3O / 4I forbidden-handle
 *     audit sharp on every other surface.
 */

import type {
  BackendExportRunDraftInput,
  BackendExportRunDraftResult,
} from "./export-run-draft";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type PersistedExportRunStatus =
  | "draft_clear"
  | "needs_review"
  | "blocked"
  // Forward-compat — gracefully accept future literals.
  | (string & {});

export type PersistedExportRunPhase =
  | "draft"
  // Forward-compat — a future export-engine phase may add e.g.
  // ``"approved"`` / ``"finalized"``. The frontend should NEVER
  // synthesise such a value; it only renders what the backend
  // returns.
  | (string & {});

export type PersistedExportRunSource =
  | "operational_preview"
  | "api"
  | "manual"
  | (string & {});

/**
 * Phase 6A — closed-vocab approval workflow gate. Mirrors
 * ``ExportRunApprovalStatus`` in
 * ``backend/app/schemas/export_run_persistence.py``.
 *
 * Hard contract — even when the value is
 * ``"approved_for_file_generation"``:
 *
 *   * ``phase`` remains ``"draft"`` (Phase 5A lock holds).
 *   * ``draft_snapshot.draft_only`` / ``finalized`` /
 *     ``file_generated`` / ``download_available`` /
 *     ``production_export_ready`` remain false (Phase 4F hard pins
 *     hold).
 *   * No file is generated, no download URL issued, no document /
 *     batch / template mutated, no external system contacted, no
 *     export batch created.
 *
 * Forward-compat — a future state (e.g. ``"approval_revoked"``)
 * lands gracefully through the ``string & {}`` branch.
 */
export type PersistedExportRunApprovalStatus =
  | "not_requested"
  | "pending_review"
  | "approved_for_file_generation"
  | "rejected"
  | (string & {});

// ---------------------------------------------------------------------------
// Request envelope
// ---------------------------------------------------------------------------

/**
 * Body for ``POST /api/v1/export-runs/drafts``.
 *
 * The backend service ALWAYS re-evaluates the verdict locally via
 * ``build_export_run_draft_from_input(draft_input)``. The optional
 * ``draft_result`` is accepted for forward-compat (the backend
 * compares hard-pinned literals against the local re-evaluation
 * and rejects mismatches), but the persisted snapshot is sourced
 * from the local re-evaluation regardless.
 *
 * ``request_snapshot`` is sanitised by the backend against the
 * Phase 3O / 4I forbidden-handle set; the frontend MUST NOT send
 * any ``download_url`` / ``file_url`` / ``file_id`` /
 * ``export_id`` / ``export_run_id`` / ``export_batch_id`` /
 * ``posted_at`` / ``external_posting_id`` / ``finalized_at`` /
 * ``exported_at`` / ``external_system_id`` keys at any depth.
 */
export interface PersistedExportRunCreate {
  draft_input: BackendExportRunDraftInput;
  draft_result?: BackendExportRunDraftResult | null;
  source?: PersistedExportRunSource;
  notes?: string | null;
  export_profile_id?: string | null;
  export_profile_name?: string | null;
  export_profile_version?: number | null;
  target_system?: string | null;
  template_id?: string | null;
  document_id?: string | null;
  batch_id?: string | null;
  request_snapshot?: Record<string, unknown> | null;
}

/**
 * Body for ``PATCH /api/v1/export-runs/{id}``.
 *
 * Phase 5A intentionally restricts PATCH to notes-only updates —
 * status / phase / snapshot mutation belongs to a future explicit
 * approval-workflow phase, not here. ``notes: null`` clears the
 * field.
 *
 * Phase 6A — approval fields are NOT writable through this PATCH
 * endpoint; the backend uses ``extra="forbid"`` so a forged body
 * containing ``approval_status`` / ``approval_notes`` / etc. will
 * 422. Approval transitions go through the dedicated POST
 * endpoints below.
 */
export interface PersistedExportRunUpdate {
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Phase 6B — Approval workflow request payloads
// ---------------------------------------------------------------------------

/**
 * Body for
 * ``POST /api/v1/export-runs/{id}/request-approval``.
 *
 * Optional ``approval_notes`` are operator-supplied context for
 * the reviewer. The backend trims; whitespace-only collapses to
 * ``null`` so the persisted column stays honest. The backend
 * uses ``extra="forbid"`` so a forged body cannot smuggle a
 * status / phase / snapshot field through this endpoint.
 */
export interface PersistedExportRunRequestApprovalPayload {
  approval_notes?: string | null;
}

/**
 * Body for
 * ``POST /api/v1/export-runs/{id}/approve-for-file-generation``.
 *
 * Hard contract: approving a record sets
 * ``approval_status = "approved_for_file_generation"`` and the
 * approved-by / approved-at metadata. It does NOT generate a
 * file, finalise the export, change phase / status / snapshot,
 * mutate any document / batch / template, post anywhere
 * externally, or create any export batch. The endpoint name
 * calls out the future gate explicitly so the contract intent
 * is visible at the route layer.
 */
export interface PersistedExportRunApproveForFileGenerationPayload {
  approval_notes?: string | null;
}

/**
 * Body for
 * ``POST /api/v1/export-runs/{id}/reject-approval``.
 *
 * ``rejection_reason`` is REQUIRED and must be non-empty after
 * trimming on the backend (Pydantic 422s on missing / empty /
 * whitespace-only strings). Optional ``approval_notes`` are
 * additional reviewer context.
 */
export interface PersistedExportRunRejectApprovalPayload {
  rejection_reason: string;
  approval_notes?: string | null;
}

// ---------------------------------------------------------------------------
// Response payloads
// ---------------------------------------------------------------------------

/**
 * Full read shape returned by POST / GET / PATCH endpoints.
 *
 * Carries the persisted catalog metadata + the JSONB
 * ``draft_snapshot`` and ``request_snapshot``. The
 * ``draft_snapshot`` is the canonical Phase 4F
 * ``BackendExportRunDraftResult`` — the backend re-validates it
 * through the Pydantic ``ExportRunDraft`` Literal types before
 * write so the hard pins (``draft_only=true`` / ``finalized=false``
 * / ``file_generated=false`` / ``download_available=false`` /
 * ``production_export_ready=false``) are guaranteed to be present
 * + correct on every persisted row.
 */
export interface PersistedExportRunRead {
  /** Draft / audit record id. NOT an export id, NOT a file id,
   *  NOT proof of export. */
  id: string;
  status: PersistedExportRunStatus;
  /** Phase 5A pins this to ``"draft"``. Forward-compat to accept
   *  future phases without a frontend release; the panel renders
   *  the literal verbatim regardless. */
  phase: PersistedExportRunPhase;
  source: PersistedExportRunSource;

  export_profile_id?: string | null;
  export_profile_name?: string | null;
  export_profile_version?: number | null;
  template_id?: string | null;
  document_id?: string | null;
  batch_id?: string | null;
  target_system?: string | null;

  row_count: number;
  blocked_row_count: number;
  warning_row_count: number;
  issue_count: number;

  /** The full Phase 4F verdict serialised by the backend. Typed
   *  as ``BackendExportRunDraftResult`` so the panel + reports can
   *  read the hard pins back without a cast. */
  draft_snapshot: BackendExportRunDraftResult;
  request_snapshot?: Record<string, unknown> | null;
  notes?: string | null;

  // Phase 6A — approval workflow metadata. Even when
  // ``approval_status === "approved_for_file_generation"``, the
  // ``draft_snapshot`` hard pins remain false and ``phase`` stays
  // ``"draft"`` — see ``PersistedExportRunApprovalStatus``.
  approval_status: PersistedExportRunApprovalStatus;
  approval_requested_at?: string | null;
  approval_requested_by_user_id?: string | null;
  approved_at?: string | null;
  approved_by_user_id?: string | null;
  rejected_at?: string | null;
  rejected_by_user_id?: string | null;
  approval_notes?: string | null;
  rejection_reason?: string | null;

  created_at: string;
  updated_at: string;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
}

/**
 * Lightweight summary shape returned in the list response. No
 * JSONB payloads — keeps the list endpoint cheap.
 *
 * Phase 6A — also surfaces the approval status so the audit list
 * can render it without round-tripping to GET-by-id. Full
 * approval timestamps + actors live on ``PersistedExportRunRead``
 * only.
 */
export interface PersistedExportRunSummary {
  id: string;
  status: PersistedExportRunStatus;
  phase: PersistedExportRunPhase;
  source: PersistedExportRunSource;
  export_profile_name?: string | null;
  export_profile_version?: number | null;
  target_system?: string | null;
  row_count: number;
  blocked_row_count: number;
  warning_row_count: number;
  issue_count: number;
  approval_status: PersistedExportRunApprovalStatus;
  created_at: string;
  updated_at: string;
}

export interface PersistedExportRunListResponse {
  items: PersistedExportRunSummary[];
}

/**
 * Filter shape for the list endpoint. Mirrors the Phase 5A
 * backend params — ``status_`` is the FastAPI shadow-name for
 * ``status`` (the backend imports the HTTP ``status`` module
 * which collides with the param name).
 */
export interface PersistedExportRunListParams {
  status_?: PersistedExportRunStatus | null;
  phase?: PersistedExportRunPhase | null;
  source?: PersistedExportRunSource | null;
  export_profile_id?: string | null;
  target_system?: string | null;
  document_id?: string | null;
  batch_id?: string | null;
  limit?: number;
  offset?: number;
}
