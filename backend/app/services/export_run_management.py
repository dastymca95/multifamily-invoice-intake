"""
Phase 5A — Export Run Draft / audit persistence service.

Pure-ish CRUD layer that talks to a single repository
(``ExportRunRepository``) with the following business rules
layered on top of the raw row writes:

  * **Stateless evaluator stays canonical.** Every persistence
    call re-evaluates the verdict locally via
    ``build_export_run_draft_from_input`` so the persisted
    ``draft_snapshot`` cannot be poisoned by a stale / forged
    caller-supplied verdict. The Phase 4F endpoint remains the
    source of truth for the verdict shape.
  * **Hard-pin preservation.** The persisted snapshot MUST carry
    ``draft_only=True`` / ``finalized=False`` /
    ``file_generated=False`` / ``download_available=False`` /
    ``production_export_ready=False``. The service re-validates
    through Pydantic ``ExportRunDraft`` AND a hand-rolled
    ``assert_draft_snapshot_hard_pins`` walker so a future
    Pydantic regression doesn't silently widen the contract.
  * **Forbidden-key audit on snapshots.** Every JSONB payload
    written through this service is walked recursively for
    forbidden export / file / posting / finalisation handles.
    See ``FORBIDDEN_SNAPSHOT_KEYS`` in
    ``app.schemas.export_run_persistence``.
  * **Closed Literal narrowing.** Caller-supplied ``source`` /
    ``target_system`` are narrowed against the Phase 5A closed
    sets before write. Invalid values raise
    ``ExportRunValidationError`` (mapped to HTTP 422 by the API
    layer).
  * **Phase locking.** Phase 5A pins ``phase="draft"`` for every
    persisted row. A future approval phase can add an explicit
    ``approve_export_run`` service that flips the phase under
    different rules — until then, every row is a draft.
  * **Status mapping.** The Phase 4F evaluator's
    ``not_available`` value maps to persisted ``"blocked"`` (see
    ``map_draft_status_to_record_status``); ``draft_clear`` /
    ``needs_review`` / ``blocked`` round-trip identically.
  * **No mutation of other records.** The service never writes
    to documents, batches, templates, export profiles, or any
    other table.

Hard contract:
  * No file generation, no export records (other than this
    table), no document / batch / template mutation, no external
    posting, no OCR / AI, no background jobs.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from datetime import UTC, datetime

from app.models.export_run import ExportRunRecord
from app.repositories.export_run_repo import ExportRunRepository
from app.schemas.export_run_draft import ExportRunDraft
from app.schemas.export_run_persistence import (
    DRAFT_STATUS_TO_RECORD_STATUS,
    ExportRunApproveForFileGeneration,
    ExportRunCreate,
    ExportRunRejectApproval,
    ExportRunRequestApproval,
    ExportRunUpdate,
    assert_draft_snapshot_hard_pins,
    assert_no_forbidden_snapshot_keys,
    map_draft_status_to_record_status,
    serialize_draft_to_snapshot,
)
from app.services.export_run_draft import (
    build_export_run_draft_from_input,
)


__all__ = [
    "ExportRunManagementError",
    "ExportRunNotFoundError",
    "ExportRunValidationError",
    "ExportRunApprovalConflictError",
    "create_export_run_draft_record",
    "get_export_run",
    "list_export_runs",
    "update_export_run_notes",
    "request_export_run_approval",
    "approve_export_run_for_file_generation",
    "reject_export_run_approval",
]


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ExportRunManagementError(Exception):
    """Base class — caught by the API layer for HTTP mapping."""


class ExportRunNotFoundError(ExportRunManagementError):
    """Raised when a draft / audit id doesn't exist."""


class ExportRunValidationError(ExportRunManagementError):
    """Raised when a payload fails business rules
    that aren't expressible via the request Pydantic schema alone
    (forbidden snapshot keys, target system narrowing, source
    narrowing, hard-pin preservation). Mapped to HTTP 422 by the
    API layer.
    """


class ExportRunApprovalConflictError(ExportRunManagementError):
    """Phase 6A — raised when a requested approval transition is
    not allowed from the current ``approval_status`` (e.g.
    approving a record that's still ``not_requested``, or
    approving a ``blocked`` draft). Mapped to HTTP 409 by the API
    layer so the operator gets a meaningful "current state vs.
    requested state" signal instead of a generic 422.
    """


# Closed sets — narrow caller-supplied values BEFORE write.
_ALLOWED_SOURCES: frozenset[str] = frozenset(
    {"operational_preview", "api", "manual"}
)
_ALLOWED_TARGET_SYSTEMS: frozenset[str] = frozenset(
    {"custom_csv", "resman", "yardi", "appfolio"}
)
_ALLOWED_RECORD_STATUSES: frozenset[str] = frozenset(
    {"draft_clear", "needs_review", "blocked"}
)
_LOCKED_PHASE: str = "draft"


# ---------------------------------------------------------------------------
# Public — create
# ---------------------------------------------------------------------------


async def create_export_run_draft_record(
    db: AsyncSession,
    body: ExportRunCreate,
    *,
    user_id: UUID | None = None,
) -> ExportRunRecord:
    """Persist a new draft / audit row.

    Always pins ``phase="draft"``. Always re-evaluates the verdict
    locally — the caller's optional ``draft_result`` field is
    accepted for forward-compat but NOT used to populate the
    snapshot today; the snapshot is built from
    ``build_export_run_draft_from_input(body.draft_input)``.

    Raises:
      * ``ExportRunValidationError`` on any business-rule failure
        (invalid source / target system, forbidden snapshot key,
        hard-pin mismatch).
    """
    # ---- Closed-set narrowing -------------------------------------
    _validate_source(body.source)
    if body.target_system is not None:
        _validate_target_system(body.target_system)

    # ---- Sanitise the request snapshot ----------------------------
    request_snapshot = _sanitize_request_snapshot(body)

    # ---- Re-evaluate the verdict locally --------------------------
    # The Phase 4F evaluator is pure + deterministic. Re-running
    # it here means a stale / forged caller-supplied verdict
    # cannot poison the persisted snapshot.
    draft = build_export_run_draft_from_input(body.draft_input)

    # ---- Hard-pin defence in depth --------------------------------
    # Pydantic ``Literal[True]`` / ``Literal[False]`` already
    # enforce the five hard pins on ``draft``; we re-validate the
    # serialised dict so a future Pydantic regression that drops
    # the literal types still surfaces here.
    snapshot = serialize_draft_to_snapshot(draft)
    assert_draft_snapshot_hard_pins(snapshot)
    try:
        assert_no_forbidden_snapshot_keys(snapshot, path="$.draft_snapshot")
    except ValueError as exc:
        # The Phase 4F service should never emit a forbidden key,
        # but if it does we surface it loudly instead of writing.
        raise ExportRunValidationError(str(exc)) from exc

    # ---- Caller-supplied draft_result (forward-compat) ------------
    # Today: validated for forbidden keys + hard pins, then
    # ignored. A future caller may want it copied verbatim into
    # the snapshot — we'll opt in explicitly behind a phase flag
    # rather than retro-fitting the behaviour here.
    if body.draft_result is not None:
        try:
            assert_no_forbidden_snapshot_keys(
                body.draft_result, path="$.draft_result"
            )
        except ValueError as exc:
            raise ExportRunValidationError(str(exc)) from exc
        # If hard-pin flags are present in the caller's draft_result,
        # they MUST agree with the locally-evaluated snapshot. This
        # catches a caller that hand-rolled
        # ``finalized=true`` / ``file_generated=true`` /
        # ``download_available=true`` / ``production_export_ready=true``.
        for flag in (
            "draft_only",
            "finalized",
            "file_generated",
            "download_available",
            "production_export_ready",
        ):
            if (
                flag in body.draft_result
                and body.draft_result[flag] != snapshot[flag]
            ):
                raise ExportRunValidationError(
                    f"draft_result.{flag}={body.draft_result[flag]!r} "
                    f"disagrees with the canonical evaluator "
                    f"({snapshot[flag]!r}); refusing to persist."
                )

    # ---- Map status + counts --------------------------------------
    record_status = map_draft_status_to_record_status(draft.status)
    if record_status not in _ALLOWED_RECORD_STATUSES:
        # Defensive — every value in DRAFT_STATUS_TO_RECORD_STATUS
        # is in the allowed set, but a future regression might
        # widen the map. Surface the breach instead of writing.
        raise ExportRunValidationError(
            f"computed record status {record_status!r} is not allowed; "
            f"expected one of {sorted(_ALLOWED_RECORD_STATUSES)}"
        )

    # ---- Snapshot the profile id / name / version -----------------
    # If the caller supplied ``export_profile_id`` directly, use
    # it; otherwise leave NULL. We deliberately do NOT try to
    # parse ``draft_input.selected_profile_id`` as UUID because
    # built-in / inline ids are non-UUID strings and we don't want
    # to silently coerce them into the soft FK column.
    export_profile_id: UUID | None = body.export_profile_id

    repo = ExportRunRepository(db)
    record = ExportRunRecord(
        status=record_status,
        phase=_LOCKED_PHASE,
        source=body.source,
        export_profile_id=export_profile_id,
        export_profile_name=body.export_profile_name,
        export_profile_version=body.export_profile_version,
        template_id=body.template_id,
        document_id=body.document_id,
        batch_id=body.batch_id,
        target_system=body.target_system,
        row_count=int(draft.row_count),
        blocked_row_count=int(draft.blocked_row_count),
        warning_row_count=int(draft.warning_row_count),
        # Phase 4F's ``ExportRunDraft`` does not currently carry an
        # explicit ``issue_count`` — it's the count fed to the
        # evaluator on the input side. We pull it from the input
        # so the audit list endpoint can surface it without
        # re-reading the JSONB blob.
        issue_count=int(body.draft_input.export_preview_issue_count or 0),
        draft_snapshot=snapshot,
        request_snapshot=request_snapshot,
        notes=body.notes,
        created_by_user_id=user_id,
        updated_by_user_id=user_id,
    )
    return await repo.save(record)


# ---------------------------------------------------------------------------
# Public — read
# ---------------------------------------------------------------------------


async def get_export_run(
    db: AsyncSession, run_id: UUID
) -> ExportRunRecord:
    """Return the record or raise ``ExportRunNotFoundError``."""
    repo = ExportRunRepository(db)
    record = await repo.get(run_id)
    if record is None:
        raise ExportRunNotFoundError(
            f"Export run draft {run_id} not found"
        )
    return record


async def list_export_runs(
    db: AsyncSession,
    *,
    status: str | None = None,
    phase: str | None = "draft",
    source: str | None = None,
    export_profile_id: UUID | None = None,
    target_system: str | None = None,
    document_id: UUID | None = None,
    batch_id: UUID | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[ExportRunRecord]:
    """List persisted draft / audit records newest-first.

    Validates the closed Literal filter values BEFORE the repo
    call so a typo doesn't silently return zero rows.
    """
    if status is not None and status not in _ALLOWED_RECORD_STATUSES:
        raise ExportRunValidationError(
            f"status filter must be one of: "
            f"{sorted(_ALLOWED_RECORD_STATUSES)}; got {status!r}"
        )
    # Phase locking — Phase 5A only persists "draft" phase, but the
    # filter narrows here so a future caller passing
    # ``phase="finalized"`` against this endpoint surfaces a 422
    # instead of returning zero rows.
    if phase is not None and phase != _LOCKED_PHASE:
        raise ExportRunValidationError(
            f"phase filter must be {_LOCKED_PHASE!r} or unset; got {phase!r}"
        )
    if source is not None:
        _validate_source(source)
    if target_system is not None:
        _validate_target_system(target_system)

    repo = ExportRunRepository(db)
    return await repo.list_filtered(
        status=status,
        phase=phase,
        source=source,
        export_profile_id=export_profile_id,
        target_system=target_system,
        document_id=document_id,
        batch_id=batch_id,
        limit=limit,
        offset=offset,
    )


# ---------------------------------------------------------------------------
# Public — update (notes only)
# ---------------------------------------------------------------------------


async def update_export_run_notes(
    db: AsyncSession,
    run_id: UUID,
    body: ExportRunUpdate,
    *,
    user_id: UUID | None = None,
) -> ExportRunRecord:
    """Apply a notes-only update.

    Phase 5A intentionally does NOT expose status / phase /
    snapshot mutation — a future approval phase can add explicit
    transition endpoints. Sending ``notes: null`` clears the
    field; not sending ``notes`` at all is a no-op (the row's
    ``updated_at`` still bumps because we save the row).
    """
    record = await get_export_run(db, run_id)
    updates = body.model_dump(exclude_unset=True)
    if "notes" in updates:
        record.notes = updates["notes"]
    if user_id is not None:
        record.updated_by_user_id = user_id
    repo = ExportRunRepository(db)
    return await repo.save(record)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _validate_source(value: str) -> None:
    if value not in _ALLOWED_SOURCES:
        raise ExportRunValidationError(
            f"source must be one of: {sorted(_ALLOWED_SOURCES)}; "
            f"got {value!r}"
        )


def _validate_target_system(value: str) -> None:
    if value not in _ALLOWED_TARGET_SYSTEMS:
        raise ExportRunValidationError(
            f"target_system must be one of: "
            f"{sorted(_ALLOWED_TARGET_SYSTEMS)}; got {value!r}"
        )


def _sanitize_request_snapshot(body: ExportRunCreate) -> dict[str, Any]:
    """Build the request_snapshot from caller-supplied data.

    Includes:
      * ``draft_input`` payload (Pydantic ``.model_dump(mode="json")``).
      * The caller-supplied ``request_snapshot`` dict if any
        (merged AFTER the draft input so the caller can extend
        but not override the draft input).

    The combined dict is walked for forbidden export / file /
    posting / finalisation handles. Any hit raises
    ``ExportRunValidationError`` (HTTP 422).
    """
    out: dict[str, Any] = {
        "draft_input": body.draft_input.model_dump(mode="json"),
    }
    if body.request_snapshot is not None:
        try:
            assert_no_forbidden_snapshot_keys(
                body.request_snapshot, path="$.request_snapshot"
            )
        except ValueError as exc:
            raise ExportRunValidationError(str(exc)) from exc
        # Shallow-merge — caller-supplied keys land alongside the
        # draft input. If the caller wants to override the draft
        # input snapshot, they should change ``draft_input`` itself.
        for key, value in body.request_snapshot.items():
            if key == "draft_input":
                continue
            out[key] = value
    # Phase 3O regression — also walk the draft_input itself so a
    # forbidden key smuggled in via context surfaces here.
    try:
        assert_no_forbidden_snapshot_keys(
            out["draft_input"], path="$.request_snapshot.draft_input"
        )
    except ValueError as exc:
        raise ExportRunValidationError(str(exc)) from exc
    return out


def _coerce_export_run_draft(snapshot: dict[str, Any]) -> ExportRunDraft:
    """Round-trip a JSONB snapshot through the Pydantic
    ``ExportRunDraft`` contract. Re-raises Pydantic
    ``ValidationError`` as ``ExportRunValidationError``.

    Used by tests + by future code paths that want to read a
    persisted snapshot back into the typed verdict.
    """
    try:
        return ExportRunDraft.model_validate(snapshot)
    except ValidationError as exc:
        raise ExportRunValidationError(
            f"draft_snapshot failed re-validation: {exc.errors()}"
        ) from exc


# ---------------------------------------------------------------------------
# Phase 6A — Approval workflow transitions
# ---------------------------------------------------------------------------
#
# Hard contract — even when ``approval_status`` flips to
# ``"approved_for_file_generation"``:
#
#   * ``phase`` remains ``"draft"`` (Phase 5A lock).
#   * ``status`` is unchanged (Phase 5A vocabulary).
#   * ``draft_snapshot.draft_only`` / ``finalized`` /
#     ``file_generated`` / ``download_available`` /
#     ``production_export_ready`` are unchanged (Phase 4F hard pins).
#   * No file is generated, no download URL issued, no document /
#     batch / template mutated, no external system contacted, no
#     export batch created, no Review Queue record created.
#
# All three transition entry points share the same defensive
# pattern: load the row, validate the source state, mutate only
# the approval columns + ``updated_by_user_id``, save.


def _now_utc() -> datetime:
    """Single source of UTC ``now`` for the approval transitions
    so a future test that wants to freeze time can monkey-patch
    one symbol instead of three."""
    return datetime.now(UTC)


async def request_export_run_approval(
    db: AsyncSession,
    run_id: UUID,
    body: ExportRunRequestApproval,
    *,
    user_id: UUID | None = None,
) -> ExportRunRecord:
    """Move a draft / audit record into ``pending_review``.

    Allowed source states:
      * ``not_requested`` — the most common path (operator just
        saved the draft and now wants reviewer attention).
      * ``rejected`` — re-request after a previous rejection.
        Clears the prior rejected metadata + rejection reason so
        the audit trail reflects the most recent request.

    Forbidden source states:
      * ``pending_review`` — already pending; no-op transitions
        are surfaced as 409 so the operator notices.
      * ``approved_for_file_generation`` — Phase 6A keeps approved
        as terminal-for-this-phase. A future approval-revoke
        endpoint can add a separate transition.

    Phase / status / snapshot remain unchanged. Documents /
    batches / templates / export batches are NEVER touched.
    """
    record = await get_export_run(db, run_id)
    current = record.approval_status
    if current not in {"not_requested", "rejected"}:
        raise ExportRunApprovalConflictError(
            f"Cannot request approval from approval_status={current!r}; "
            "expected 'not_requested' or 'rejected'."
        )
    now = _now_utc()
    record.approval_status = "pending_review"
    record.approval_requested_at = now
    record.approval_requested_by_user_id = user_id
    if body.approval_notes is not None:
        record.approval_notes = body.approval_notes
    # Re-request after reject: clear the prior rejected metadata
    # so the audit trail reflects the freshest request only.
    if current == "rejected":
        record.approved_at = None
        record.approved_by_user_id = None
        record.rejected_at = None
        record.rejected_by_user_id = None
        record.rejection_reason = None
    if user_id is not None:
        record.updated_by_user_id = user_id
    repo = ExportRunRepository(db)
    return await repo.save(record)


async def approve_export_run_for_file_generation(
    db: AsyncSession,
    run_id: UUID,
    body: ExportRunApproveForFileGeneration,
    *,
    user_id: UUID | None = None,
) -> ExportRunRecord:
    """Move a record into ``approved_for_file_generation``.

    Allowed only when:
      * ``approval_status == "pending_review"``, AND
      * ``status == "draft_clear"`` (the draft verdict must be
        clean before the workflow gate can flip — approving a
        ``blocked`` / ``needs_review`` row would be operationally
        dishonest).

    Hard contract — this method:
      * Sets ``approval_status = "approved_for_file_generation"``.
      * Sets ``approved_at`` and ``approved_by_user_id``.
      * Updates ``approval_notes`` if supplied.
      * Clears the rejected metadata (defensive — rejected
        records cannot be approved directly today, but if a
        future re-request flow ever lets a rejected row reach
        ``pending_review`` and then ``approved`` we want the
        audit trail to be honest).
      * Does NOT change ``phase``, ``status``, ``draft_snapshot``,
        ``request_snapshot``, row counts, or any FK column.
      * Does NOT generate a file, finalise the export, mutate
        any document / batch / template, or post anywhere.
    """
    record = await get_export_run(db, run_id)
    if record.approval_status != "pending_review":
        raise ExportRunApprovalConflictError(
            "Cannot approve from approval_status="
            f"{record.approval_status!r}; expected 'pending_review'."
        )
    if record.status != "draft_clear":
        raise ExportRunApprovalConflictError(
            "Cannot approve a record with status="
            f"{record.status!r}; expected 'draft_clear'. Approving "
            "a blocked or needs-review draft is not allowed."
        )
    now = _now_utc()
    record.approval_status = "approved_for_file_generation"
    record.approved_at = now
    record.approved_by_user_id = user_id
    if body.approval_notes is not None:
        record.approval_notes = body.approval_notes
    # Clear rejected metadata defensively (see docstring).
    record.rejected_at = None
    record.rejected_by_user_id = None
    record.rejection_reason = None
    if user_id is not None:
        record.updated_by_user_id = user_id
    repo = ExportRunRepository(db)
    return await repo.save(record)


async def reject_export_run_approval(
    db: AsyncSession,
    run_id: UUID,
    body: ExportRunRejectApproval,
    *,
    user_id: UUID | None = None,
) -> ExportRunRecord:
    """Move a record into ``rejected``.

    Allowed only when ``approval_status == "pending_review"``. A
    rejection from any other state is a 409 — the operator should
    see "the row isn't pending review" rather than silently
    flipping it to rejected.

    The Pydantic ``ExportRunRejectApproval`` schema already
    enforces a non-empty ``rejection_reason`` (HTTP 422 before
    this method is reached).

    Hard contract — this method:
      * Sets ``approval_status = "rejected"``.
      * Sets ``rejected_at`` and ``rejected_by_user_id``.
      * Sets ``rejection_reason``.
      * Updates ``approval_notes`` if supplied.
      * Clears the approved metadata (defensive — if a future
        flow ever lets a row leave the approved state we want the
        audit trail to be honest).
      * Does NOT change ``phase``, ``status``, ``draft_snapshot``,
        or any other persisted column.
    """
    record = await get_export_run(db, run_id)
    if record.approval_status != "pending_review":
        raise ExportRunApprovalConflictError(
            "Cannot reject from approval_status="
            f"{record.approval_status!r}; expected 'pending_review'."
        )
    now = _now_utc()
    record.approval_status = "rejected"
    record.rejected_at = now
    record.rejected_by_user_id = user_id
    record.rejection_reason = body.rejection_reason
    if body.approval_notes is not None:
        record.approval_notes = body.approval_notes
    # Defensive — see ``approve_export_run_for_file_generation``.
    record.approved_at = None
    record.approved_by_user_id = None
    if user_id is not None:
        record.updated_by_user_id = user_id
    repo = ExportRunRepository(db)
    return await repo.save(record)
