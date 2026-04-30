"""
Phase 6A — Service tests for the persisted export run approval
workflow foundation.

These tests pin the management-service contract for the three
approval transitions:

  * ``request_export_run_approval`` (not_requested / rejected →
    pending_review).
  * ``approve_export_run_for_file_generation`` (pending_review +
    status=draft_clear → approved_for_file_generation).
  * ``reject_export_run_approval`` (pending_review → rejected,
    requires non-empty rejection_reason).

Hard contract — even when ``approval_status`` flips to
``"approved_for_file_generation"``:

  * ``phase`` remains ``"draft"`` (Phase 5A lock).
  * ``status`` is unchanged (Phase 5A vocabulary).
  * ``draft_snapshot.draft_only`` / ``finalized`` /
    ``file_generated`` / ``download_available`` /
    ``production_export_ready`` are unchanged (Phase 4F hard pins).
  * Documents / batches / templates / export_profiles tables are
    NEVER touched.

Pure backend service tests — use the ``db_session`` fixture
directly; no HTTP client.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from app.schemas.export_run_draft import ExportRunDraftInput
from app.schemas.export_run_persistence import (
    ExportRunApproveForFileGeneration,
    ExportRunCreate,
    ExportRunRejectApproval,
    ExportRunRequestApproval,
)
from app.services.export_run_management import (
    ExportRunApprovalConflictError,
    ExportRunNotFoundError,
    approve_export_run_for_file_generation,
    create_export_run_draft_record,
    reject_export_run_approval,
    request_export_run_approval,
)


# ---------------------------------------------------------------------------
# Tiny builders (mirror the Phase 5A management service tests)
# ---------------------------------------------------------------------------


def _clear_input(**overrides: Any) -> ExportRunDraftInput:
    """Cleanest "draft_clear"-looking input — saved profile,
    clear validation, clear readiness, non-empty rows, no
    issues. The Phase 4F evaluator returns ``draft_clear`` on
    this input."""
    base = dict(
        selected_profile_id="prof-saved-6a",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=5,
        export_preview_issue_count=0,
        blocked_row_count=0,
        warning_row_count=0,
    )
    base.update(overrides)
    return ExportRunDraftInput(**base)


def _create_body(**overrides: Any) -> ExportRunCreate:
    base: dict[str, Any] = dict(
        draft_input=_clear_input(),
        source="operational_preview",
    )
    base.update(overrides)
    return ExportRunCreate(**base)


async def _make_clear(db, **overrides):
    return await create_export_run_draft_record(
        db, _create_body(**overrides)
    )


async def _make_blocked(db):
    return await create_export_run_draft_record(
        db,
        _create_body(
            draft_input=_clear_input(
                profile_validation_status="blocked",
                blocked_row_count=2,
            )
        ),
    )


async def _make_needs_review(db):
    return await create_export_run_draft_record(
        db,
        _create_body(
            draft_input=_clear_input(
                warning_row_count=1, export_preview_issue_count=1
            )
        ),
    )


# ---------------------------------------------------------------------------
# 1. Defaults — new records start as not_requested
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_new_record_defaults_approval_status_not_requested(
    db_session,
):
    record = await _make_clear(db_session)
    assert record.approval_status == "not_requested"
    assert record.approval_requested_at is None
    assert record.approval_requested_by_user_id is None
    assert record.approved_at is None
    assert record.approved_by_user_id is None
    assert record.rejected_at is None
    assert record.rejected_by_user_id is None
    assert record.approval_notes is None
    assert record.rejection_reason is None


# ---------------------------------------------------------------------------
# 2. request_approval — not_requested → pending_review
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_approval_sets_pending_review_metadata(db_session):
    record = await _make_clear(db_session)
    user_id = uuid.uuid4()
    updated = await request_export_run_approval(
        db_session,
        record.id,
        ExportRunRequestApproval(approval_notes="please review"),
        user_id=user_id,
    )
    assert updated.approval_status == "pending_review"
    assert updated.approval_requested_at is not None
    assert updated.approval_requested_by_user_id == user_id
    assert updated.approval_notes == "please review"
    assert updated.updated_by_user_id == user_id
    # Phase 5A hard pins still hold.
    assert updated.phase == "draft"
    assert updated.status == "draft_clear"
    snap = updated.draft_snapshot
    assert snap["finalized"] is False
    assert snap["file_generated"] is False
    assert snap["download_available"] is False
    assert snap["production_export_ready"] is False


@pytest.mark.asyncio
async def test_request_approval_from_pending_review_conflicts(db_session):
    record = await _make_clear(db_session)
    await request_export_run_approval(
        db_session, record.id, ExportRunRequestApproval()
    )
    with pytest.raises(
        ExportRunApprovalConflictError, match="not_requested"
    ):
        await request_export_run_approval(
            db_session, record.id, ExportRunRequestApproval()
        )


@pytest.mark.asyncio
async def test_request_approval_from_approved_conflicts(db_session):
    record = await _make_clear(db_session)
    await request_export_run_approval(
        db_session, record.id, ExportRunRequestApproval()
    )
    await approve_export_run_for_file_generation(
        db_session,
        record.id,
        ExportRunApproveForFileGeneration(),
    )
    with pytest.raises(
        ExportRunApprovalConflictError, match="not_requested"
    ):
        await request_export_run_approval(
            db_session, record.id, ExportRunRequestApproval()
        )


# ---------------------------------------------------------------------------
# 3. request_approval — rejected → pending_review (re-request)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_approval_from_rejected_clears_reject_metadata(
    db_session,
):
    record = await _make_clear(db_session)
    rejector = uuid.uuid4()
    await request_export_run_approval(
        db_session, record.id, ExportRunRequestApproval()
    )
    await reject_export_run_approval(
        db_session,
        record.id,
        ExportRunRejectApproval(rejection_reason="not yet"),
        user_id=rejector,
    )
    requester = uuid.uuid4()
    updated = await request_export_run_approval(
        db_session,
        record.id,
        ExportRunRequestApproval(approval_notes="re-requesting"),
        user_id=requester,
    )
    # New pending_review state.
    assert updated.approval_status == "pending_review"
    assert updated.approval_requested_at is not None
    assert updated.approval_requested_by_user_id == requester
    assert updated.approval_notes == "re-requesting"
    # Old rejected metadata cleared.
    assert updated.rejected_at is None
    assert updated.rejected_by_user_id is None
    assert updated.rejection_reason is None


# ---------------------------------------------------------------------------
# 4. approve — pending_review + draft_clear → approved
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approve_from_pending_draft_clear_sets_approved(db_session):
    record = await _make_clear(db_session)
    await request_export_run_approval(
        db_session, record.id, ExportRunRequestApproval()
    )
    approver = uuid.uuid4()
    updated = await approve_export_run_for_file_generation(
        db_session,
        record.id,
        ExportRunApproveForFileGeneration(approval_notes="LGTM"),
        user_id=approver,
    )
    assert updated.approval_status == "approved_for_file_generation"
    assert updated.approved_at is not None
    assert updated.approved_by_user_id == approver
    assert updated.approval_notes == "LGTM"
    assert updated.updated_by_user_id == approver
    # The approval-requested metadata is preserved (audit trail).
    assert updated.approval_requested_at is not None


# ---------------------------------------------------------------------------
# 5. approve does NOT change file/finalization fields, phase, status,
#    or snapshot
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approve_does_not_change_phase_status_or_snapshot(db_session):
    record = await _make_clear(db_session)
    await request_export_run_approval(
        db_session, record.id, ExportRunRequestApproval()
    )
    before_snap = dict(record.draft_snapshot)
    before_status = record.status
    before_phase = record.phase
    before_row_count = record.row_count

    updated = await approve_export_run_for_file_generation(
        db_session, record.id, ExportRunApproveForFileGeneration()
    )

    # phase / status / counts unchanged.
    assert updated.phase == before_phase == "draft"
    assert updated.status == before_status == "draft_clear"
    assert updated.row_count == before_row_count
    # Snapshot identical (every key, every value).
    assert updated.draft_snapshot == before_snap
    # The Phase 4F hard pins still read False / True correctly.
    snap = updated.draft_snapshot
    assert snap["draft_only"] is True
    assert snap["finalized"] is False
    assert snap["file_generated"] is False
    assert snap["download_available"] is False
    assert snap["production_export_ready"] is False


# ---------------------------------------------------------------------------
# 6. approve blocked / needs_review fails
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approve_blocked_record_conflicts(db_session):
    record = await _make_blocked(db_session)
    await request_export_run_approval(
        db_session, record.id, ExportRunRequestApproval()
    )
    with pytest.raises(
        ExportRunApprovalConflictError, match="draft_clear"
    ):
        await approve_export_run_for_file_generation(
            db_session, record.id, ExportRunApproveForFileGeneration()
        )


@pytest.mark.asyncio
async def test_approve_needs_review_record_conflicts(db_session):
    record = await _make_needs_review(db_session)
    await request_export_run_approval(
        db_session, record.id, ExportRunRequestApproval()
    )
    with pytest.raises(
        ExportRunApprovalConflictError, match="draft_clear"
    ):
        await approve_export_run_for_file_generation(
            db_session, record.id, ExportRunApproveForFileGeneration()
        )


# ---------------------------------------------------------------------------
# 7. approve from not_requested fails (must request first)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approve_from_not_requested_conflicts(db_session):
    record = await _make_clear(db_session)
    with pytest.raises(
        ExportRunApprovalConflictError, match="pending_review"
    ):
        await approve_export_run_for_file_generation(
            db_session, record.id, ExportRunApproveForFileGeneration()
        )


# ---------------------------------------------------------------------------
# 8. reject — pending_review → rejected
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reject_from_pending_sets_rejected_metadata(db_session):
    record = await _make_clear(db_session)
    await request_export_run_approval(
        db_session, record.id, ExportRunRequestApproval()
    )
    rejector = uuid.uuid4()
    updated = await reject_export_run_approval(
        db_session,
        record.id,
        ExportRunRejectApproval(
            rejection_reason="missing PO number",
            approval_notes="see ticket #42",
        ),
        user_id=rejector,
    )
    assert updated.approval_status == "rejected"
    assert updated.rejected_at is not None
    assert updated.rejected_by_user_id == rejector
    assert updated.rejection_reason == "missing PO number"
    assert updated.approval_notes == "see ticket #42"
    assert updated.updated_by_user_id == rejector


@pytest.mark.asyncio
async def test_reject_from_not_requested_conflicts(db_session):
    record = await _make_clear(db_session)
    with pytest.raises(
        ExportRunApprovalConflictError, match="pending_review"
    ):
        await reject_export_run_approval(
            db_session,
            record.id,
            ExportRunRejectApproval(rejection_reason="too early"),
        )


@pytest.mark.asyncio
async def test_reject_from_approved_conflicts(db_session):
    record = await _make_clear(db_session)
    await request_export_run_approval(
        db_session, record.id, ExportRunRequestApproval()
    )
    await approve_export_run_for_file_generation(
        db_session, record.id, ExportRunApproveForFileGeneration()
    )
    with pytest.raises(
        ExportRunApprovalConflictError, match="pending_review"
    ):
        await reject_export_run_approval(
            db_session,
            record.id,
            ExportRunRejectApproval(rejection_reason="changed mind"),
        )


# ---------------------------------------------------------------------------
# 9. reject requires non-empty rejection_reason
# ---------------------------------------------------------------------------


def test_reject_schema_requires_non_empty_reason():
    """Pydantic catches the empty / missing reason BEFORE the
    service is reached. Two cases exercised here so the schema's
    behaviour is pinned alongside the service contract."""
    from pydantic import ValidationError as PydanticValidationError

    # Missing key entirely.
    with pytest.raises(PydanticValidationError):
        ExportRunRejectApproval()  # type: ignore[call-arg]
    # Whitespace-only reason.
    with pytest.raises(PydanticValidationError, match="non-empty"):
        ExportRunRejectApproval(rejection_reason="   ")
    # Empty string.
    with pytest.raises(PydanticValidationError, match="non-empty"):
        ExportRunRejectApproval(rejection_reason="")


# ---------------------------------------------------------------------------
# 10. approved is terminal-for-this-phase
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approved_record_cannot_be_approved_again(db_session):
    record = await _make_clear(db_session)
    await request_export_run_approval(
        db_session, record.id, ExportRunRequestApproval()
    )
    await approve_export_run_for_file_generation(
        db_session, record.id, ExportRunApproveForFileGeneration()
    )
    with pytest.raises(
        ExportRunApprovalConflictError, match="pending_review"
    ):
        await approve_export_run_for_file_generation(
            db_session, record.id, ExportRunApproveForFileGeneration()
        )


# ---------------------------------------------------------------------------
# 11. Missing run id raises NotFound
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_approval_missing_id_raises(db_session):
    with pytest.raises(ExportRunNotFoundError):
        await request_export_run_approval(
            db_session, uuid.uuid4(), ExportRunRequestApproval()
        )


@pytest.mark.asyncio
async def test_approve_missing_id_raises(db_session):
    with pytest.raises(ExportRunNotFoundError):
        await approve_export_run_for_file_generation(
            db_session,
            uuid.uuid4(),
            ExportRunApproveForFileGeneration(),
        )


@pytest.mark.asyncio
async def test_reject_missing_id_raises(db_session):
    with pytest.raises(ExportRunNotFoundError):
        await reject_export_run_approval(
            db_session,
            uuid.uuid4(),
            ExportRunRejectApproval(rejection_reason="x"),
        )


# ---------------------------------------------------------------------------
# 12. No mutation of other tables (smoke check)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approval_transitions_do_not_touch_export_profiles(
    db_session,
):
    """Approval transitions only write to ``export_runs``. Smoke:
    even when ``export_profile_id`` is supplied at create time and
    the row is approved, the export_profiles table is NOT updated
    as a side effect (no last-used timestamp, no usage counter,
    nothing)."""
    from sqlalchemy import select

    from app.models.export_profile import ExportProfileRecord

    profile_id = uuid.uuid4()
    record = await create_export_run_draft_record(
        db_session, _create_body(export_profile_id=profile_id)
    )
    profiles_before = (
        await db_session.execute(select(ExportProfileRecord))
    ).scalars().all()
    await request_export_run_approval(
        db_session, record.id, ExportRunRequestApproval()
    )
    await approve_export_run_for_file_generation(
        db_session, record.id, ExportRunApproveForFileGeneration()
    )
    profiles_after = (
        await db_session.execute(select(ExportProfileRecord))
    ).scalars().all()
    assert len(profiles_before) == len(profiles_after)


# ---------------------------------------------------------------------------
# 13. Model column audit — approval columns added; forbidden absent
# ---------------------------------------------------------------------------


def test_export_run_record_has_approval_columns():
    from app.models.export_run import ExportRunRecord

    column_names = {c.name for c in ExportRunRecord.__table__.columns}
    expected = {
        "approval_status",
        "approval_requested_at",
        "approval_requested_by_user_id",
        "approved_at",
        "approved_by_user_id",
        "rejected_at",
        "rejected_by_user_id",
        "approval_notes",
        "rejection_reason",
    }
    missing = expected - column_names
    assert not missing, f"Approval columns missing on model: {sorted(missing)}"


def test_export_run_record_still_has_no_forbidden_columns():
    """Phase 6A is purely additive — the Phase 5E forbidden set
    must remain absent from the model column list. Defence-in-depth
    on top of the Phase 5E persistence-contract test."""
    from app.models.export_run import ExportRunRecord

    forbidden = {
        "file_id",
        "file_url",
        "download_url",
        "export_id",
        "export_run_id",
        "export_batch_id",
        "posted_at",
        "external_posting_id",
        "finalized_at",
        "exported_at",
        "external_system_id",
        "file_generated_at",
    }
    column_names = {c.name for c in ExportRunRecord.__table__.columns}
    leaked = column_names & forbidden
    assert not leaked, (
        f"Forbidden column name(s) on ExportRunRecord after Phase 6A: "
        f"{sorted(leaked)}"
    )
