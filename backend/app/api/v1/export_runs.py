"""
Phase 5A — Export Run Draft / audit persistence API.

Sibling to the Phase 4F stateless evaluator
(``/api/v1/export-run-drafts/evaluate``). The evaluator stays
stateless and Phase 3O / 4I forbid it from returning any
``export_run_id`` flavour. THIS endpoint family persists a
draft / audit row and exposes its database id as ``id``.

Endpoints:

  * ``POST /api/v1/export-runs/drafts``
      Persist a new draft / audit row from a diagnostic snapshot.
  * ``GET  /api/v1/export-runs``
      List persisted draft / audit rows newest-first.
  * ``GET  /api/v1/export-runs/{id}``
      Read one record.
  * ``PATCH /api/v1/export-runs/{id}``
      Notes-only update.

Hard contract — every response from this router:

  * Carries ``id`` as the draft / audit record id. Phase 5A
    intentionally avoids the field name ``export_run_id`` to
    keep the Phase 3O / 4I forbidden-handle audit sharp.
  * Has ``phase="draft"``. Future phases may flip this BEHIND
    explicit export-engine work.
  * Has the Phase 4F hard pins (``draft_only=True`` /
    ``finalized=False`` / ``file_generated=False`` /
    ``download_available=False`` /
    ``production_export_ready=False``) on the embedded
    ``draft_snapshot``.
  * Carries no ``download_url`` / ``file_url`` / ``file_id`` /
    ``export_id`` / ``export_run_id`` / ``export_batch_id`` /
    ``posted_at`` / ``external_posting_id`` / ``finalized_at`` /
    ``exported_at``.
  * Triggers no file generation, no Review Queue write, no
    document / batch / template mutation, no external posting,
    no background processing, no OCR / AI.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status

from app.dependencies import DB, CurrentUser
from app.schemas.export_run_persistence import (
    ExportRunApproveForFileGeneration,
    ExportRunCreate,
    ExportRunListResponse,
    ExportRunRead,
    ExportRunRejectApproval,
    ExportRunRequestApproval,
    ExportRunSummary,
    ExportRunUpdate,
)
from app.services.export_run_management import (
    ExportRunApprovalConflictError,
    ExportRunNotFoundError,
    ExportRunValidationError,
    approve_export_run_for_file_generation,
    create_export_run_draft_record,
    get_export_run,
    list_export_runs,
    reject_export_run_approval,
    request_export_run_approval,
    update_export_run_notes,
)


router = APIRouter(
    prefix="/export-runs",
    tags=["export-runs"],
)


# ---------------------------------------------------------------------------
# Persist a new draft / audit row
# ---------------------------------------------------------------------------


@router.post(
    "/drafts",
    response_model=ExportRunRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_export_run_draft(
    body: ExportRunCreate,
    db: DB,
    user: CurrentUser,
) -> ExportRunRead:
    """Persist a new draft / audit row.

    The service ALWAYS re-evaluates the verdict locally via
    ``build_export_run_draft_from_input`` so the persisted
    snapshot cannot be poisoned by a stale / forged caller-
    supplied verdict. The Phase 4F hard pins (``draft_only=True``
    / ``finalized=False`` / ``file_generated=False`` /
    ``download_available=False`` /
    ``production_export_ready=False``) are guaranteed on the
    persisted ``draft_snapshot``.

    The returned ``id`` is a draft / audit record id. It is NOT
    a finalized export id, NOT a file id, and does NOT imply
    document / batch / template / external-system mutation —
    see ``docs/export-run-draft-contract.md`` §
    "Persisted draft audit records".
    """
    user_id = _user_id_from_token(user)
    try:
        record = await create_export_run_draft_record(
            db, body, user_id=user_id
        )
    except ExportRunValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ExportRunRead.model_validate(record)


# ---------------------------------------------------------------------------
# List persisted draft / audit rows
# ---------------------------------------------------------------------------


@router.get("", response_model=ExportRunListResponse)
async def list_export_run_records(
    db: DB,
    user: CurrentUser,
    status_: str | None = None,
    phase: str | None = "draft",
    source: str | None = None,
    export_profile_id: uuid.UUID | None = None,
    target_system: str | None = None,
    document_id: uuid.UUID | None = None,
    batch_id: uuid.UUID | None = None,
    limit: int = 50,
    offset: int = 0,
) -> ExportRunListResponse:
    """List persisted draft / audit rows newest-first by ``created_at``.

    Filter parameters:

      * ``status_`` — narrow to one of ``draft_clear`` /
        ``needs_review`` / ``blocked``. Invalid values yield 422.
      * ``phase`` — defaults to ``"draft"``. Phase 5A persists
        only ``"draft"``; passing anything else yields 422 so a
        future regression that flips a row out of draft cannot
        accidentally hide it from the default listing.
      * ``source`` — narrow to one of ``operational_preview`` /
        ``api`` / ``manual``.
      * ``export_profile_id`` — exact match.
      * ``target_system`` — narrow to the closed Phase 3I set.
      * ``document_id`` / ``batch_id`` — exact match.

    Note: FastAPI exposes the ``status`` filter as ``status_``
    here because the imported ``status`` (HTTP status) shadows
    the name in this module's scope.
    """
    try:
        rows = await list_export_runs(
            db,
            status=status_,
            phase=phase,
            source=source,
            export_profile_id=export_profile_id,
            target_system=target_system,
            document_id=document_id,
            batch_id=batch_id,
            limit=limit,
            offset=offset,
        )
    except ExportRunValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    items = [ExportRunSummary.model_validate(r) for r in rows]
    return ExportRunListResponse(items=items)


# ---------------------------------------------------------------------------
# Read a single draft / audit row
# ---------------------------------------------------------------------------


@router.get("/{run_id}", response_model=ExportRunRead)
async def get_export_run_record(
    run_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> ExportRunRead:
    """Return one persisted draft / audit row by id.

    The returned ``id`` is a draft / audit record id (see the
    POST docstring). Missing ids yield 404.
    """
    try:
        record = await get_export_run(db, run_id)
    except ExportRunNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return ExportRunRead.model_validate(record)


# ---------------------------------------------------------------------------
# Notes-only update
# ---------------------------------------------------------------------------


@router.patch("/{run_id}", response_model=ExportRunRead)
async def update_export_run_record(
    run_id: uuid.UUID,
    body: ExportRunUpdate,
    db: DB,
    user: CurrentUser,
) -> ExportRunRead:
    """Apply a notes-only update.

    Phase 5A intentionally does NOT expose status / phase /
    snapshot mutation. A future approval phase may add explicit
    transition endpoints behind explicit export-engine work.
    Sending ``notes: null`` clears the field. Missing ids yield
    404.
    """
    user_id = _user_id_from_token(user)
    try:
        record = await update_export_run_notes(
            db, run_id, body, user_id=user_id
        )
    except ExportRunNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ExportRunValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ExportRunRead.model_validate(record)


# ---------------------------------------------------------------------------
# Phase 6A — Approval workflow transitions
# ---------------------------------------------------------------------------
#
# Three explicit, narrowly-scoped endpoints. Each one mutates ONLY
# the approval columns + ``updated_by_user_id``; phase / status /
# draft_snapshot / row counts / FKs / created_at are read-only on
# this surface. The Phase 5A PATCH endpoint above remains
# notes-only (``ExportRunUpdate.extra="forbid"``) — approval
# transitions MUST go through these explicit routes so a forged
# generic PATCH cannot smuggle approval state.
#
# Hard contract — even when ``approval_status`` becomes
# ``"approved_for_file_generation"``:
#
#   * ``phase`` remains ``"draft"``.
#   * ``status`` is unchanged.
#   * ``draft_snapshot.draft_only`` / ``finalized`` /
#     ``file_generated`` / ``download_available`` /
#     ``production_export_ready`` are unchanged.
#   * No file is generated, no download URL issued, no document /
#     batch / template mutated, no external system contacted, no
#     export batch created, no Review Queue record created.


@router.post(
    "/{run_id}/request-approval",
    response_model=ExportRunRead,
)
async def request_export_run_approval_endpoint(
    run_id: uuid.UUID,
    body: ExportRunRequestApproval,
    db: DB,
    user: CurrentUser,
) -> ExportRunRead:
    """Move a draft / audit record into ``pending_review``.

    Allowed source states: ``not_requested`` (initial request) or
    ``rejected`` (re-request after a previous rejection clears
    the prior rejection metadata). Any other source state yields
    HTTP 409.

    Phase / status / snapshot are unchanged. Documents / batches
    / templates / export batches are NEVER touched.
    """
    user_id = _user_id_from_token(user)
    try:
        record = await request_export_run_approval(
            db, run_id, body, user_id=user_id
        )
    except ExportRunNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ExportRunApprovalConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExportRunValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ExportRunRead.model_validate(record)


@router.post(
    "/{run_id}/approve-for-file-generation",
    response_model=ExportRunRead,
)
async def approve_export_run_for_file_generation_endpoint(
    run_id: uuid.UUID,
    body: ExportRunApproveForFileGeneration,
    db: DB,
    user: CurrentUser,
) -> ExportRunRead:
    """Move a record into ``approved_for_file_generation``.

    Allowed only when the source state is ``"pending_review"``
    AND the draft verdict's ``status`` is ``"draft_clear"``.
    Approving a ``blocked`` / ``needs_review`` record yields
    HTTP 409 — approving a draft the resolver is unhappy with
    would be operationally dishonest.

    The endpoint name calls out the future gate explicitly so
    the contract intent is visible at the route layer. **It does
    NOT generate a file, finalise the export, change phase /
    status / snapshot, mutate any document / batch / template,
    post anywhere externally, or create any export batch.** See
    ``docs/export-run-persistence-contract.md`` § "Approval
    workflow foundation".
    """
    user_id = _user_id_from_token(user)
    try:
        record = await approve_export_run_for_file_generation(
            db, run_id, body, user_id=user_id
        )
    except ExportRunNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ExportRunApprovalConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExportRunValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ExportRunRead.model_validate(record)


@router.post(
    "/{run_id}/reject-approval",
    response_model=ExportRunRead,
)
async def reject_export_run_approval_endpoint(
    run_id: uuid.UUID,
    body: ExportRunRejectApproval,
    db: DB,
    user: CurrentUser,
) -> ExportRunRead:
    """Move a record into ``rejected``.

    Allowed only when the source state is ``"pending_review"``;
    any other source state yields HTTP 409. The
    ``rejection_reason`` is required and must be non-empty
    (Pydantic ``ExportRunRejectApproval`` enforces this BEFORE
    this method is reached).
    """
    user_id = _user_id_from_token(user)
    try:
        record = await reject_export_run_approval(
            db, run_id, body, user_id=user_id
        )
    except ExportRunNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ExportRunApprovalConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExportRunValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ExportRunRead.model_validate(record)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _user_id_from_token(user: dict) -> uuid.UUID | None:
    """Project the JWT ``sub`` claim into a UUID for the
    created_by_user_id / updated_by_user_id audit columns. Returns
    ``None`` when the claim is absent or not a parseable UUID — the
    soft FK accepts NULL and the row is still saved. Mirrors the
    ``export_profiles`` API helper.
    """
    sub = user.get("sub") if isinstance(user, dict) else None
    if not sub:
        return None
    try:
        return uuid.UUID(str(sub))
    except (ValueError, AttributeError):
        return None
