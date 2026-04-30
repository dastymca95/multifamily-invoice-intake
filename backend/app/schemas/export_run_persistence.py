"""
Phase 5A — Persisted Export Run Draft / audit CRUD schemas.

Lives in its own module so ``app.schemas.export_run_draft`` (the
diagnostic verdict contract from Phase 4F) stays focused on the
shape the stateless ``/export-run-drafts/evaluate`` endpoint
returns.

What this module IS:
  * Pydantic schemas for create / update / read / list responses
    of the persisted draft / audit row.
  * Closed Literal sets for the Phase 5A vocabulary
    (``ExportRunRecordStatus`` / ``ExportRunRecordPhase`` /
    ``ExportRunRecordSource``).
  * A canonical map from the Phase 4F ``ExportRunDraft.status`` to
    the persisted ``ExportRunRecord.status`` (Phase 5A's
    ``not_available`` ``→`` ``"blocked"`` rule lives here).

What this module is NOT:
  * NOT a finalised export shape.
  * NOT an export batch shape.
  * NOT a side-effecting layer.
  * NEVER carries ``file_id`` / ``file_url`` / ``download_url`` /
    ``export_id`` / ``export_run_id`` / ``export_batch_id`` /
    ``posted_at`` / ``external_posting_id`` / ``finalized_at`` /
    ``exported_at`` fields. The endpoint surfaces the record as
    ``id`` only — see ``docs/export-run-draft-contract.md`` §
    "Persisted draft audit records".
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.export_run_draft import (
    ExportRunDraft,
    ExportRunDraftInput,
)


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------


# Phase 5A persisted statuses. ``not_available`` from the Phase 4F
# evaluator is mapped to ``"blocked"`` on the persistence side
# (see ``DRAFT_STATUS_TO_RECORD_STATUS``) so every persisted row
# falls into a closed set the list endpoint can filter on.
ExportRunRecordStatus = Literal[
    "draft_clear",
    "needs_review",
    "blocked",
]


# Lifecycle phase. Phase 5A pins this to ``"draft"``. Future
# phases may add ``"approved"`` / ``"finalized"`` BEHIND explicit
# export-engine work; the Literal is closed today so a regression
# can't accidentally widen it.
ExportRunRecordPhase = Literal["draft"]


# How the row was created. Closed Literal — service narrows on
# create. ``api`` covers programmatic callers; ``manual`` covers a
# future UI that lets an operator stamp a row outside the
# Operational Preview flow.
ExportRunRecordSource = Literal[
    "operational_preview",
    "api",
    "manual",
]


# Phase 6A — closed Literal for the approval-workflow gate.
#
# Hard contract — even when the value is
# ``"approved_for_file_generation"``:
#
#   * ``phase`` remains ``"draft"`` (Phase 5A lock holds).
#   * ``draft_snapshot.finalized`` / ``file_generated`` /
#     ``download_available`` / ``production_export_ready`` remain
#     false (Phase 4F hard pins hold).
#   * No file is generated, no download URL issued, no document /
#     batch / template mutated, no external system contacted, no
#     export batch created.
#
# The vocabulary is small and closed today; a future phase that
# needs an additional state (e.g. ``"approval_revoked"``) MUST
# extend the Literal AND update
# ``docs/export-run-persistence-contract.md``.
ExportRunApprovalStatus = Literal[
    "not_requested",
    "pending_review",
    "approved_for_file_generation",
    "rejected",
]


# Set form for the service-level transition rules. Sourced once
# so the service + tests + API stay in lockstep.
EXPORT_RUN_APPROVAL_STATUSES: frozenset[str] = frozenset(
    {
        "not_requested",
        "pending_review",
        "approved_for_file_generation",
        "rejected",
    }
)


# Closed list of forbidden snapshot keys (Phase 3O / 4I parity).
# Used by the management service to reject any caller-supplied
# ``draft_input`` / ``draft_result`` / ``request_snapshot`` that
# carries one of these handles. Never copied into the DB row.
FORBIDDEN_SNAPSHOT_KEYS: frozenset[str] = frozenset(
    {
        "download_url",
        "file_url",
        "file_id",
        "export_id",
        "export_run_id",
        "export_batch_id",
        "posted_at",
        "external_posting_id",
        "finalized_at",
        "exported_at",
        "external_system_id",
    }
)


# Hard-pinned-True flags that MUST be true on the draft snapshot
# (the Phase 4F ``ExportRunDraft`` contract guarantees them).
_REQUIRED_TRUE_DRAFT_FLAGS: tuple[str, ...] = ("draft_only",)

# Hard-pinned-False flags that MUST be false on the draft snapshot
# (the Phase 4F ``ExportRunDraft`` contract guarantees them).
_REQUIRED_FALSE_DRAFT_FLAGS: tuple[str, ...] = (
    "finalized",
    "file_generated",
    "download_available",
    "production_export_ready",
)


# Map the Phase 4F ``ExportRunDraft.status`` vocabulary to the
# persisted ``ExportRunRecord.status``. ``not_available`` is
# mapped to ``"blocked"`` on the persistence side because a row
# that the evaluator considered "not draftable" is, on the audit
# side, a row that cannot proceed.
DRAFT_STATUS_TO_RECORD_STATUS: dict[str, ExportRunRecordStatus] = {
    "draft_clear": "draft_clear",
    "needs_review": "needs_review",
    "blocked": "blocked",
    "not_available": "blocked",
}


# ---------------------------------------------------------------------------
# Create / read / update / list schemas
# ---------------------------------------------------------------------------


class ExportRunCreate(BaseModel):
    """Body for ``POST /api/v1/export-runs/drafts``.

    The caller MUST supply ``draft_input`` (the Phase 4F snapshot
    shape). The service ALWAYS re-evaluates the verdict locally
    via ``build_export_run_draft_from_input`` so the persisted
    ``draft_snapshot`` cannot be poisoned by a stale / forged
    caller-supplied verdict.

    Optional ``draft_result`` is accepted for forward-compatibility
    (e.g. a future caller that already has the verdict in hand) —
    the service compares it against the locally re-evaluated
    verdict and rejects any mismatch on the hard-pinned literals.
    Today the service ignores the field entirely; a future phase
    can opt in.

    Optional ``export_profile_id`` may be supplied independently
    of ``draft_input.selected_profile_id`` so a future caller can
    persist a draft against a saved profile id even when
    ``draft_input`` carries a built-in / inline profile id.
    """

    model_config = ConfigDict(extra="forbid")

    draft_input: ExportRunDraftInput = Field(
        default_factory=ExportRunDraftInput
    )
    draft_result: dict[str, Any] | None = None
    source: ExportRunRecordSource = "operational_preview"
    notes: str | None = None
    export_profile_id: UUID | None = None
    export_profile_name: str | None = None
    export_profile_version: int | None = None
    target_system: str | None = None
    template_id: UUID | None = None
    document_id: UUID | None = None
    batch_id: UUID | None = None
    request_snapshot: dict[str, Any] | None = None

    @field_validator("notes")
    @classmethod
    def _trim_notes(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


class ExportRunUpdate(BaseModel):
    """Body for ``PATCH /api/v1/export-runs/{id}``.

    Notes-only update — Phase 5A intentionally does NOT expose
    status / phase / snapshot mutation. A future approval phase
    can add explicit transition endpoints; doing it through PATCH
    today would blur the diagnostic / production boundary.

    Sending ``notes: null`` explicitly clears the notes field.
    """

    model_config = ConfigDict(extra="forbid")

    notes: str | None = None

    @field_validator("notes")
    @classmethod
    def _trim_notes(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


class ExportRunRead(BaseModel):
    """Full read shape returned by GET / POST / PATCH endpoints.

    Carries the persisted draft / audit metadata + the JSONB
    ``draft_snapshot`` and ``request_snapshot``.

    Diagnostic-only — the field set is deliberately a subset of
    what a future ``ExportRunFinalized`` shape will eventually
    carry (see ``docs/export-run-draft-contract.md`` §8). No
    ``download_url`` / ``file_id`` / ``export_id`` / etc.

    Phase 6A — also carries the approval-workflow metadata.
    ``approval_status="approved_for_file_generation"`` is a
    workflow gate ONLY; the embedded snapshot's hard pins
    (``draft_only=True`` / ``finalized=False`` /
    ``file_generated=False`` / ``download_available=False`` /
    ``production_export_ready=False``) and ``phase="draft"`` hold
    regardless.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    status: str
    phase: str
    source: str
    export_profile_id: UUID | None = None
    export_profile_name: str | None = None
    export_profile_version: int | None = None
    template_id: UUID | None = None
    document_id: UUID | None = None
    batch_id: UUID | None = None
    target_system: str | None = None
    row_count: int
    blocked_row_count: int
    warning_row_count: int
    issue_count: int
    draft_snapshot: dict[str, Any]
    request_snapshot: dict[str, Any] | None = None
    notes: str | None = None
    # Phase 6A — approval workflow metadata.
    approval_status: str
    approval_requested_at: datetime | None = None
    approval_requested_by_user_id: UUID | None = None
    approved_at: datetime | None = None
    approved_by_user_id: UUID | None = None
    rejected_at: datetime | None = None
    rejected_by_user_id: UUID | None = None
    approval_notes: str | None = None
    rejection_reason: str | None = None
    created_by_user_id: UUID | None = None
    updated_by_user_id: UUID | None = None
    created_at: datetime
    updated_at: datetime


class ExportRunSummary(BaseModel):
    """Lightweight item for list responses — no JSONB payloads.

    Phase 6A — also surfaces the approval status so the audit
    list can filter / display without round-tripping to GET-by-id.
    The full approval timestamps + actors live on
    ``ExportRunRead`` only.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    status: str
    phase: str
    source: str
    export_profile_name: str | None = None
    export_profile_version: int | None = None
    target_system: str | None = None
    row_count: int
    blocked_row_count: int
    warning_row_count: int
    issue_count: int
    # Phase 6A — approval status only on the summary; full
    # timestamps live on ExportRunRead.
    approval_status: str
    created_at: datetime
    updated_at: datetime


class ExportRunListResponse(BaseModel):
    items: list[ExportRunSummary] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Phase 6A — Approval transition request schemas
# ---------------------------------------------------------------------------


class ExportRunRequestApproval(BaseModel):
    """Body for ``POST /api/v1/export-runs/{id}/request-approval``.

    Optional ``approval_notes`` are operator-supplied context for
    the reviewer. Whitespace-only collapses to ``None`` so the
    persisted column stays honest. ``extra="forbid"`` so a forged
    body cannot smuggle a status / phase / snapshot field through
    this endpoint.
    """

    model_config = ConfigDict(extra="forbid")

    approval_notes: str | None = None

    @field_validator("approval_notes")
    @classmethod
    def _trim_notes(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


class ExportRunApproveForFileGeneration(BaseModel):
    """Body for ``POST /api/v1/export-runs/{id}/approve-for-file-generation``.

    Hard contract: approving a record sets ``approval_status =
    "approved_for_file_generation"`` and the approved-by /
    approved-at metadata. It does NOT generate a file, finalise
    the export, change phase / status / snapshot, mutate any
    document / batch / template, post anywhere externally, or
    create any export batch. The endpoint name calls out the
    future gate explicitly so the contract intent is visible at
    the route layer.
    """

    model_config = ConfigDict(extra="forbid")

    approval_notes: str | None = None

    @field_validator("approval_notes")
    @classmethod
    def _trim_notes(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


class ExportRunRejectApproval(BaseModel):
    """Body for ``POST /api/v1/export-runs/{id}/reject-approval``.

    ``rejection_reason`` is required and must be non-empty after
    trimming — an audit-honest reject MUST carry a reason. The
    optional ``approval_notes`` are additional context. The
    schema rejects extra fields so a forged body cannot smuggle a
    status / phase / snapshot field through this endpoint.
    """

    model_config = ConfigDict(extra="forbid")

    rejection_reason: str
    approval_notes: str | None = None

    @field_validator("rejection_reason")
    @classmethod
    def _require_reason(cls, v: str) -> str:
        if not isinstance(v, str):
            raise ValueError("rejection_reason must be a string")
        v = v.strip()
        if not v:
            raise ValueError(
                "rejection_reason must be non-empty"
            )
        return v

    @field_validator("approval_notes")
    @classmethod
    def _trim_notes(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


# ---------------------------------------------------------------------------
# Helpers (re-exported for the management service + tests)
# ---------------------------------------------------------------------------


def map_draft_status_to_record_status(
    draft_status: str,
) -> ExportRunRecordStatus:
    """Project a Phase 4F ``ExportRunDraft.status`` value into the
    closed Phase 5A ``ExportRunRecordStatus`` set. Unknown values
    fall through to ``"blocked"`` (conservative — an unrecognised
    upstream status MUST NOT be persisted as ``draft_clear``).
    """
    return DRAFT_STATUS_TO_RECORD_STATUS.get(draft_status, "blocked")


def assert_no_forbidden_snapshot_keys(
    payload: Any, *, path: str = "$"
) -> None:
    """Recursively walk a JSON-shaped payload and raise
    ``ValueError`` if any forbidden export / file / posting /
    finalisation handle key appears.

    Mirrors Phase 3O's ``assert_no_export_handles`` walker but
    raises a plain ValueError so the management service can map
    it cleanly to ``ExportRunValidationError`` / HTTP 422.
    """
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in FORBIDDEN_SNAPSHOT_KEYS:
                raise ValueError(
                    f"Forbidden snapshot key {key!r} at {path}.{key} — "
                    "Export Run Draft persistence does not accept this "
                    "(see docs/export-run-draft-contract.md §4)."
                )
            assert_no_forbidden_snapshot_keys(
                value, path=f"{path}.{key}"
            )
    elif isinstance(payload, list):
        for idx, item in enumerate(payload):
            assert_no_forbidden_snapshot_keys(
                item, path=f"{path}[{idx}]"
            )


def assert_draft_snapshot_hard_pins(snapshot: dict[str, Any]) -> None:
    """Validate that a draft snapshot dict carries the Phase 4F
    hard-pinned literals correctly. Raises ValueError on any
    mismatch (caller catches + re-raises as
    ``ExportRunValidationError``).

    Catches the case where a caller hand-rolls a
    ``draft_result`` that flips a hard pin (deliberately or by
    accident).
    """
    if not isinstance(snapshot, dict):
        raise ValueError("draft_snapshot must be a JSON object")
    for flag in _REQUIRED_TRUE_DRAFT_FLAGS:
        if flag not in snapshot:
            raise ValueError(
                f"draft_snapshot is missing required true flag {flag!r}"
            )
        if snapshot[flag] is not True:
            raise ValueError(
                f"draft_snapshot.{flag} must be True; got {snapshot[flag]!r}"
            )
    for flag in _REQUIRED_FALSE_DRAFT_FLAGS:
        if flag not in snapshot:
            raise ValueError(
                f"draft_snapshot is missing required false flag {flag!r}"
            )
        if snapshot[flag] is not False:
            raise ValueError(
                f"draft_snapshot.{flag} must be False; got {snapshot[flag]!r}"
            )


def serialize_draft_to_snapshot(draft: ExportRunDraft) -> dict[str, Any]:
    """Convert a Phase 4F ``ExportRunDraft`` Pydantic instance into
    a JSON-friendly dict ready for the JSONB column. Uses
    ``model_dump(mode="json")`` so any nested non-trivial types
    (UUIDs, datetimes) are coerced to JSON-native form.

    Pure — never mutates the input.
    """
    return draft.model_dump(mode="json")
