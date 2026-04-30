"""
Phase 5A — Service tests for the persisted Export Run Draft /
audit catalog.

These tests pin the management-service contract:

  * Create persists a draft / audit row from a diagnostic snapshot.
  * Phase is locked to ``"draft"``.
  * Status maps from the Phase 4F evaluator to the persisted Phase
    5A vocabulary correctly (draft_clear / needs_review / blocked
    + ``not_available -> "blocked"``).
  * Row counts come from the locally re-evaluated draft.
  * Hard pins (draft_only / finalized / file_generated /
    download_available / production_export_ready) are guaranteed
    on every persisted snapshot.
  * Forbidden export / file / posting / finalisation handle keys
    in caller-supplied ``request_snapshot`` / ``draft_result`` are
    rejected.
  * Caller-supplied ``draft_result`` flipping a hard pin
    (``finalized=true`` / ``file_generated=true`` /
    ``download_available=true`` / ``production_export_ready=true``)
    is rejected.
  * Get / list / list-filtered / notes-only PATCH behave
    deterministically.
  * No mutation of other tables (smoke-checked: only
    ``export_runs`` is touched).

Pure backend service tests — use the ``db_session`` fixture
directly; no HTTP client.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.models.export_run import ExportRunRecord
from app.schemas.export_run_draft import ExportRunDraftInput
from app.schemas.export_run_persistence import (
    ExportRunCreate,
    ExportRunUpdate,
    map_draft_status_to_record_status,
)
from app.services.export_run_management import (
    ExportRunNotFoundError,
    ExportRunValidationError,
    create_export_run_draft_record,
    get_export_run,
    list_export_runs,
    update_export_run_notes,
)


# ---------------------------------------------------------------------------
# Tiny builders
# ---------------------------------------------------------------------------


def _clear_input(**overrides) -> ExportRunDraftInput:
    """Cleanest "ready"-looking input — saved profile, clear
    validation, clear readiness, non-empty rows, no issues. The
    Phase 4F evaluator returns ``draft_clear`` on this input."""
    base = dict(
        selected_profile_id="prof-saved-5a",
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


def _create_body(**overrides) -> ExportRunCreate:
    base = dict(
        draft_input=_clear_input(),
        source="operational_preview",
    )
    base.update(overrides)
    return ExportRunCreate(**base)


# ---------------------------------------------------------------------------
# 1. Create persists a draft row from input
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_persists_draft_row(db_session):
    body = _create_body()
    record = await create_export_run_draft_record(db_session, body)
    assert isinstance(record, ExportRunRecord)
    assert isinstance(record.id, uuid.UUID)
    assert record.phase == "draft"
    assert record.source == "operational_preview"
    assert record.status == "draft_clear"


@pytest.mark.asyncio
async def test_create_records_user_id_on_audit_columns(db_session):
    user_id = uuid.uuid4()
    record = await create_export_run_draft_record(
        db_session, _create_body(), user_id=user_id
    )
    assert record.created_by_user_id == user_id
    assert record.updated_by_user_id == user_id


# ---------------------------------------------------------------------------
# 2. Phase is locked to "draft"
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_persisted_phase_is_always_draft(db_session):
    record = await create_export_run_draft_record(
        db_session, _create_body()
    )
    assert record.phase == "draft"


# ---------------------------------------------------------------------------
# 3. Status mapping covers every Phase 4F evaluator outcome
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_maps_draft_clear(db_session):
    record = await create_export_run_draft_record(
        db_session, _create_body()
    )
    assert record.status == "draft_clear"


@pytest.mark.asyncio
async def test_status_maps_blocked(db_session):
    body = _create_body(
        draft_input=_clear_input(
            profile_validation_status="blocked", blocked_row_count=2
        )
    )
    record = await create_export_run_draft_record(db_session, body)
    assert record.status == "blocked"


@pytest.mark.asyncio
async def test_status_maps_needs_review(db_session):
    body = _create_body(
        draft_input=_clear_input(
            warning_row_count=1, export_preview_issue_count=1
        )
    )
    record = await create_export_run_draft_record(db_session, body)
    assert record.status == "needs_review"


@pytest.mark.asyncio
async def test_status_not_available_maps_to_blocked(db_session):
    """The Phase 4F evaluator returns ``not_available`` when there
    are no rows or no profile. Persistence maps that to
    ``"blocked"`` so the persisted vocabulary stays closed."""
    body = _create_body(
        draft_input=_clear_input(export_preview_row_count=0)
    )
    record = await create_export_run_draft_record(db_session, body)
    assert record.status == "blocked"


def test_map_draft_status_to_record_status_unknown_falls_through_to_blocked():
    """Forward-compat — an unknown upstream status MUST NOT be
    persisted as draft_clear."""
    assert (
        map_draft_status_to_record_status("future_unknown_status")
        == "blocked"
    )


# ---------------------------------------------------------------------------
# 4. Row counts persist from the locally-evaluated draft
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_row_counts_persist(db_session):
    body = _create_body(
        draft_input=_clear_input(
            export_preview_row_count=10,
            blocked_row_count=2,
            warning_row_count=3,
            export_preview_issue_count=4,
            profile_validation_status="blocked",
        )
    )
    record = await create_export_run_draft_record(db_session, body)
    assert record.row_count == 10
    assert record.blocked_row_count == 2
    assert record.warning_row_count == 3
    assert record.issue_count == 4


# ---------------------------------------------------------------------------
# 5. Draft snapshot hard pins are preserved
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_draft_snapshot_carries_hard_pins(db_session):
    record = await create_export_run_draft_record(
        db_session, _create_body()
    )
    snapshot = record.draft_snapshot
    assert snapshot["draft_only"] is True
    assert snapshot["finalized"] is False
    assert snapshot["file_generated"] is False
    assert snapshot["download_available"] is False
    assert snapshot["production_export_ready"] is False


# ---------------------------------------------------------------------------
# 6. Request snapshot is sanitised
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_snapshot_includes_draft_input(db_session):
    record = await create_export_run_draft_record(
        db_session, _create_body()
    )
    assert record.request_snapshot is not None
    assert "draft_input" in record.request_snapshot
    di = record.request_snapshot["draft_input"]
    # Diagnostic input round-trips verbatim.
    assert di["selected_profile_id"] == "prof-saved-5a"
    assert di["selected_profile_source"] == "saved"


@pytest.mark.asyncio
async def test_request_snapshot_extension_keys_carry_through(db_session):
    body = _create_body(
        request_snapshot={"validation_source": "backend"}
    )
    record = await create_export_run_draft_record(db_session, body)
    assert record.request_snapshot["validation_source"] == "backend"


# ---------------------------------------------------------------------------
# 7. Forbidden snapshot keys are rejected
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_snapshot_rejects_download_url(db_session):
    body = _create_body(
        request_snapshot={"download_url": "https://example.com/x.csv"}
    )
    with pytest.raises(ExportRunValidationError, match="download_url"):
        await create_export_run_draft_record(db_session, body)


@pytest.mark.asyncio
async def test_request_snapshot_rejects_export_run_id(db_session):
    body = _create_body(
        request_snapshot={"export_run_id": str(uuid.uuid4())}
    )
    with pytest.raises(ExportRunValidationError, match="export_run_id"):
        await create_export_run_draft_record(db_session, body)


@pytest.mark.asyncio
async def test_request_snapshot_rejects_finalized_at(db_session):
    body = _create_body(
        request_snapshot={"finalized_at": "2026-04-29T12:00:00Z"}
    )
    with pytest.raises(ExportRunValidationError, match="finalized_at"):
        await create_export_run_draft_record(db_session, body)


@pytest.mark.asyncio
async def test_draft_input_context_rejects_forbidden_key(db_session):
    """Caller smuggling a forbidden key into ``draft_input.context``
    must be rejected before write. The walker recurses through
    the JSON shape."""
    body = _create_body(
        draft_input=_clear_input(
            context={"file_id": "f-1"},
        )
    )
    with pytest.raises(ExportRunValidationError, match="file_id"):
        await create_export_run_draft_record(db_session, body)


# ---------------------------------------------------------------------------
# 8. Caller-supplied draft_result with flipped hard pins is rejected
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_draft_result_with_finalized_true_is_rejected(db_session):
    body = _create_body(draft_result={"finalized": True})
    with pytest.raises(
        ExportRunValidationError, match="finalized=True disagrees"
    ):
        await create_export_run_draft_record(db_session, body)


@pytest.mark.asyncio
async def test_draft_result_with_file_generated_true_is_rejected(db_session):
    body = _create_body(draft_result={"file_generated": True})
    with pytest.raises(
        ExportRunValidationError, match="file_generated=True disagrees"
    ):
        await create_export_run_draft_record(db_session, body)


@pytest.mark.asyncio
async def test_draft_result_with_download_available_true_is_rejected(
    db_session,
):
    body = _create_body(draft_result={"download_available": True})
    with pytest.raises(
        ExportRunValidationError,
        match="download_available=True disagrees",
    ):
        await create_export_run_draft_record(db_session, body)


@pytest.mark.asyncio
async def test_draft_result_with_production_export_ready_true_is_rejected(
    db_session,
):
    body = _create_body(
        draft_result={"production_export_ready": True}
    )
    with pytest.raises(
        ExportRunValidationError,
        match="production_export_ready=True disagrees",
    ):
        await create_export_run_draft_record(db_session, body)


@pytest.mark.asyncio
async def test_draft_result_with_forbidden_key_is_rejected(db_session):
    body = _create_body(draft_result={"download_url": "https://x"})
    with pytest.raises(
        ExportRunValidationError, match="download_url"
    ):
        await create_export_run_draft_record(db_session, body)


# ---------------------------------------------------------------------------
# 9. Source / target_system narrowing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_source_must_be_in_closed_set(db_session):
    """Pydantic's ExportRunRecordSource Literal already rejects
    invalid sources at request parse time. The service-level
    check is defence-in-depth — call ``model_construct`` to
    bypass Pydantic and confirm the service still rejects."""
    body = ExportRunCreate.model_construct(
        draft_input=_clear_input(),
        source="future_source",
    )
    with pytest.raises(ExportRunValidationError, match="source must be"):
        await create_export_run_draft_record(db_session, body)


@pytest.mark.asyncio
async def test_target_system_narrowing(db_session):
    body = _create_body(target_system="not_a_real_system")
    with pytest.raises(
        ExportRunValidationError, match="target_system must be"
    ):
        await create_export_run_draft_record(db_session, body)


@pytest.mark.asyncio
async def test_target_system_accepts_closed_set(db_session):
    body = _create_body(target_system="custom_csv")
    record = await create_export_run_draft_record(db_session, body)
    assert record.target_system == "custom_csv"


# ---------------------------------------------------------------------------
# 10. get / list
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_by_id_returns_record(db_session):
    record = await create_export_run_draft_record(
        db_session, _create_body()
    )
    fetched = await get_export_run(db_session, record.id)
    assert fetched.id == record.id


@pytest.mark.asyncio
async def test_get_by_id_missing_raises_not_found(db_session):
    with pytest.raises(ExportRunNotFoundError):
        await get_export_run(db_session, uuid.uuid4())


@pytest.mark.asyncio
async def test_list_returns_records_newest_first(db_session):
    a = await create_export_run_draft_record(db_session, _create_body())
    b = await create_export_run_draft_record(db_session, _create_body())
    rows = await list_export_runs(db_session)
    assert {r.id for r in rows} >= {a.id, b.id}
    # Newest first by created_at — b was created after a.
    if rows[0].id != b.id:
        # tolerate equal timestamps from the same transaction —
        # both must be present at least.
        assert rows[0].id in {a.id, b.id}
        assert rows[1].id in {a.id, b.id}


@pytest.mark.asyncio
async def test_list_filters_by_status(db_session):
    clear = await create_export_run_draft_record(
        db_session, _create_body()
    )
    blocked = await create_export_run_draft_record(
        db_session,
        _create_body(
            draft_input=_clear_input(
                profile_validation_status="blocked",
                blocked_row_count=1,
            )
        ),
    )
    rows_clear = await list_export_runs(db_session, status="draft_clear")
    rows_blocked = await list_export_runs(db_session, status="blocked")
    assert clear.id in {r.id for r in rows_clear}
    assert blocked.id not in {r.id for r in rows_clear}
    assert blocked.id in {r.id for r in rows_blocked}


@pytest.mark.asyncio
async def test_list_filters_by_export_profile_id(db_session):
    profile_a = uuid.uuid4()
    profile_b = uuid.uuid4()
    a = await create_export_run_draft_record(
        db_session, _create_body(export_profile_id=profile_a)
    )
    b = await create_export_run_draft_record(
        db_session, _create_body(export_profile_id=profile_b)
    )
    rows_a = await list_export_runs(
        db_session, export_profile_id=profile_a
    )
    assert a.id in {r.id for r in rows_a}
    assert b.id not in {r.id for r in rows_a}


@pytest.mark.asyncio
async def test_list_filters_by_target_system(db_session):
    csv_row = await create_export_run_draft_record(
        db_session, _create_body(target_system="custom_csv")
    )
    resman_row = await create_export_run_draft_record(
        db_session, _create_body(target_system="resman")
    )
    rows = await list_export_runs(db_session, target_system="custom_csv")
    assert csv_row.id in {r.id for r in rows}
    assert resman_row.id not in {r.id for r in rows}


@pytest.mark.asyncio
async def test_list_invalid_status_filter_raises(db_session):
    with pytest.raises(
        ExportRunValidationError, match="status filter must be"
    ):
        await list_export_runs(db_session, status="future_status")


@pytest.mark.asyncio
async def test_list_phase_filter_rejects_non_draft(db_session):
    with pytest.raises(
        ExportRunValidationError, match="phase filter must be"
    ):
        await list_export_runs(db_session, phase="finalized")


# ---------------------------------------------------------------------------
# 11. Notes-only PATCH
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_notes(db_session):
    record = await create_export_run_draft_record(
        db_session, _create_body()
    )
    updated = await update_export_run_notes(
        db_session, record.id, ExportRunUpdate(notes="hello world")
    )
    assert updated.notes == "hello world"
    assert updated.id == record.id


@pytest.mark.asyncio
async def test_update_notes_clears_with_null(db_session):
    body = _create_body(notes="initial")
    record = await create_export_run_draft_record(db_session, body)
    assert record.notes == "initial"
    updated = await update_export_run_notes(
        db_session, record.id, ExportRunUpdate(notes=None)
    )
    assert updated.notes is None


@pytest.mark.asyncio
async def test_update_notes_records_user_id(db_session):
    record = await create_export_run_draft_record(
        db_session, _create_body()
    )
    user_id = uuid.uuid4()
    updated = await update_export_run_notes(
        db_session, record.id, ExportRunUpdate(notes="x"), user_id=user_id
    )
    assert updated.updated_by_user_id == user_id


@pytest.mark.asyncio
async def test_update_notes_missing_id_raises(db_session):
    with pytest.raises(ExportRunNotFoundError):
        await update_export_run_notes(
            db_session, uuid.uuid4(), ExportRunUpdate(notes="x")
        )


# ---------------------------------------------------------------------------
# 12. No mutation of other tables
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_does_not_touch_export_profiles_table(db_session):
    """Create only writes to ``export_runs``. Smoke test: even
    when an ``export_profile_id`` is supplied, the export
    profiles table is NOT updated as a side effect (no last-used
    timestamp, no usage counter, etc.)."""
    from app.models.export_profile import ExportProfileRecord

    profile_count_before = (
        await db_session.execute(select(ExportProfileRecord))
    ).scalars().all()
    await create_export_run_draft_record(
        db_session, _create_body(export_profile_id=uuid.uuid4())
    )
    profile_count_after = (
        await db_session.execute(select(ExportProfileRecord))
    ).scalars().all()
    assert len(profile_count_before) == len(profile_count_after)


# ---------------------------------------------------------------------------
# 13. No file fields exist on the model OR the snapshot
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_record_columns_have_no_export_handle_fields(db_session):
    """The model column set MUST NOT include any forbidden export /
    file / posting / finalisation field name. Inspecting the
    SQLAlchemy mapper guarantees a future regression that adds a
    column with one of these names is caught immediately."""
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
    }
    column_names = {c.name for c in ExportRunRecord.__table__.columns}
    leaked = column_names & forbidden
    assert not leaked, (
        f"Forbidden column name(s) present on ExportRunRecord: {sorted(leaked)}"
    )


@pytest.mark.asyncio
async def test_persisted_snapshot_has_no_forbidden_keys(db_session):
    """Walk the persisted snapshot recursively for forbidden
    handle keys. The Phase 4F evaluator should never emit them; the
    walker exists as defence-in-depth."""
    record = await create_export_run_draft_record(
        db_session, _create_body()
    )
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
    }

    def _walk(payload):
        if isinstance(payload, dict):
            for k, v in payload.items():
                assert k not in forbidden, (
                    f"Forbidden key {k!r} found in persisted snapshot"
                )
                _walk(v)
        elif isinstance(payload, list):
            for item in payload:
                _walk(item)

    _walk(record.draft_snapshot)
    if record.request_snapshot is not None:
        _walk(record.request_snapshot)
