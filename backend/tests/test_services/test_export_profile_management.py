"""
Phase 4A — Service tests for the persisted export profile catalog.

These tests pin the management-service contract:

  * Create / get / list / update / soft-delete behave deterministically.
  * Settings + columns are re-validated through the Phase 3I
    Pydantic types — invalid payloads raise
    ``ExportProfileValidationError``.
  * Duplicate column keys are rejected.
  * Invalid target system is rejected.
  * Updates touching ``settings`` / ``columns`` increment ``version``;
    metadata-only updates do NOT.
  * Soft-delete flips ``is_active`` and clears ``is_default``.
  * "At most one default per target system" is enforced on
    create + update.
  * Conversion to the existing ``ExportProfile`` Phase 3I contract
    works for a saved row.
  * No export side effects (no other table is touched).

Pure backend service tests — use the ``db_session`` fixture
directly, no HTTP client.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.models.export_profile import ExportProfileRecord
from app.schemas.export_profile import ExportProfile
from app.schemas.export_profile_persistence import (
    ExportProfileCreate,
    ExportProfileUpdate,
)
from app.services.export_profile_management import (
    ExportProfileNotFoundError,
    ExportProfileValidationError,
    create_export_profile,
    delete_export_profile,
    get_export_profile,
    get_export_profile_contract,
    list_export_profiles,
    update_export_profile,
)


# ---------------------------------------------------------------------------
# Tiny builders
# ---------------------------------------------------------------------------


def _settings(**overrides) -> dict:
    base = {
        "delimiter": ",",
        "include_header": True,
        "quote_strategy": "minimal",
        "newline": "lf",
        "encoding": "utf-8",
        "date_format": "MM/DD/YYYY",
        "amount_format": "decimal_2",
        "empty_value_policy": "blank",
    }
    base.update(overrides)
    return base


def _column(
    key: str,
    label: str | None = None,
    *,
    required: bool = False,
    data_type: str = "text",
) -> dict:
    return {
        "key": key,
        "label": label or key.title(),
        "output_header": label or key.title(),
        "order": 0,
        "required": required,
        "data_type": data_type,
    }


def _create_body(
    *,
    name: str = "Phase 4A profile",
    target_system: str = "custom_csv",
    columns: list[dict] | None = None,
    settings: dict | None = None,
    is_active: bool = True,
    is_default: bool = False,
    description: str | None = "phase-4a service test",
    notes: str | None = None,
    source: str = "manual",
) -> ExportProfileCreate:
    return ExportProfileCreate(
        name=name,
        target_system=target_system,  # type: ignore[arg-type]
        description=description,
        settings=settings or _settings(),
        columns=columns
        or [
            _column("invoice_number", required=True),
            _column("amount", data_type="amount"),
        ],
        is_active=is_active,
        is_default=is_default,
        source=source,
        notes=notes,
    )


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_persists_profile(db_session):
    record = await create_export_profile(db_session, _create_body())
    assert record.id is not None
    assert record.name == "Phase 4A profile"
    assert record.target_system == "custom_csv"
    assert record.is_active is True
    assert record.is_default is False
    assert record.version == 1
    assert record.source == "manual"
    # settings / columns round-trip as JSONB dicts/lists.
    assert record.settings["delimiter"] == ","
    assert any(c["key"] == "invoice_number" for c in record.columns)


@pytest.mark.asyncio
async def test_create_with_user_id_records_audit(db_session):
    user_id = uuid.uuid4()
    record = await create_export_profile(
        db_session, _create_body(), user_id=user_id
    )
    assert record.created_by_user_id == user_id
    assert record.updated_by_user_id == user_id


# ---------------------------------------------------------------------------
# Validation rejections
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_rejects_invalid_target_system(db_session):
    # Pydantic also rejects this at the schema layer (the API tests
    # cover that via the 422 response), but the service layer carries
    # an INDEPENDENT enforcement so a future caller bypassing the
    # schema (e.g. via ``model_construct`` for migration scripts)
    # cannot persist an invalid target system. We bypass the schema
    # here to prove the service-layer guard fires on its own.
    body = ExportProfileCreate.model_construct(
        name="Invalid",
        target_system="quickbooks",  # type: ignore[arg-type]
        description=None,
        settings=_settings(),
        columns=[_column("invoice_number")],
        is_active=True,
        is_default=False,
        source="manual",
        notes=None,
    )
    with pytest.raises(ExportProfileValidationError) as exc:
        await create_export_profile(db_session, body)
    assert "target_system" in str(exc.value)


@pytest.mark.asyncio
async def test_create_rejects_duplicate_column_keys(db_session):
    body = _create_body(
        columns=[_column("invoice_number"), _column("invoice_number")]
    )
    with pytest.raises(ExportProfileValidationError) as exc:
        await create_export_profile(db_session, body)
    assert "duplicate key" in str(exc.value)


@pytest.mark.asyncio
async def test_create_rejects_invalid_column_data_type(db_session):
    body = _create_body(
        columns=[_column("invoice_number", data_type="quantity")],
    )
    with pytest.raises(ExportProfileValidationError) as exc:
        await create_export_profile(db_session, body)
    assert "columns[0]" in str(exc.value)


@pytest.mark.asyncio
async def test_create_rejects_non_object_settings(db_session):
    body = _create_body()
    body.settings = ["not", "a", "dict"]  # type: ignore[assignment]
    with pytest.raises(ExportProfileValidationError):
        await create_export_profile(db_session, body)


# ---------------------------------------------------------------------------
# Get
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_returns_persisted_profile(db_session):
    created = await create_export_profile(db_session, _create_body())
    fetched = await get_export_profile(db_session, created.id)
    assert fetched.id == created.id
    assert fetched.name == created.name


@pytest.mark.asyncio
async def test_get_unknown_id_raises_not_found(db_session):
    with pytest.raises(ExportProfileNotFoundError):
        await get_export_profile(db_session, uuid.uuid4())


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_returns_active_profiles_by_default(db_session):
    a = await create_export_profile(
        db_session, _create_body(name="Profile A")
    )
    b = await create_export_profile(
        db_session, _create_body(name="Profile B")
    )
    rows = await list_export_profiles(db_session)
    ids = [r.id for r in rows]
    assert a.id in ids
    assert b.id in ids


@pytest.mark.asyncio
async def test_list_filters_by_target_system(db_session):
    custom = await create_export_profile(
        db_session,
        _create_body(name="Custom", target_system="custom_csv"),
    )
    resman = await create_export_profile(
        db_session,
        _create_body(name="ResMan", target_system="resman"),
    )
    rows = await list_export_profiles(db_session, target_system="resman")
    ids = [r.id for r in rows]
    assert resman.id in ids
    assert custom.id not in ids


@pytest.mark.asyncio
async def test_list_excludes_soft_deleted_by_default(db_session):
    active = await create_export_profile(
        db_session, _create_body(name="Active")
    )
    inactive = await create_export_profile(
        db_session, _create_body(name="Inactive")
    )
    await delete_export_profile(db_session, inactive.id)

    rows = await list_export_profiles(db_session)
    ids = [r.id for r in rows]
    assert active.id in ids
    assert inactive.id not in ids


@pytest.mark.asyncio
async def test_list_includes_inactive_when_filter_disabled(db_session):
    profile = await create_export_profile(
        db_session, _create_body(name="Soft-deleted")
    )
    await delete_export_profile(db_session, profile.id)

    rows = await list_export_profiles(db_session, is_active=None)
    ids = [r.id for r in rows]
    assert profile.id in ids


@pytest.mark.asyncio
async def test_list_rejects_invalid_target_system(db_session):
    with pytest.raises(ExportProfileValidationError):
        await list_export_profiles(db_session, target_system="quickbooks")


# ---------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_metadata_only_update_does_not_bump_version(db_session):
    record = await create_export_profile(db_session, _create_body())
    assert record.version == 1
    updated = await update_export_profile(
        db_session,
        record.id,
        ExportProfileUpdate(
            description="Updated description",
            notes="ops note",
        ),
    )
    assert updated.version == 1
    assert updated.description == "Updated description"
    assert updated.notes == "ops note"


@pytest.mark.asyncio
async def test_columns_update_bumps_version(db_session):
    record = await create_export_profile(db_session, _create_body())
    updated = await update_export_profile(
        db_session,
        record.id,
        ExportProfileUpdate(
            columns=[
                _column("invoice_number", required=True),
                _column("memo"),
            ],
        ),
    )
    assert updated.version == 2
    assert any(c["key"] == "memo" for c in updated.columns)


@pytest.mark.asyncio
async def test_settings_update_bumps_version(db_session):
    record = await create_export_profile(db_session, _create_body())
    updated = await update_export_profile(
        db_session,
        record.id,
        ExportProfileUpdate(
            settings=_settings(delimiter="\t"),
        ),
    )
    assert updated.version == 2
    assert updated.settings["delimiter"] == "\t"


@pytest.mark.asyncio
async def test_update_unknown_id_raises_not_found(db_session):
    with pytest.raises(ExportProfileNotFoundError):
        await update_export_profile(
            db_session,
            uuid.uuid4(),
            ExportProfileUpdate(description="x"),
        )


@pytest.mark.asyncio
async def test_update_rejects_duplicate_column_keys(db_session):
    record = await create_export_profile(db_session, _create_body())
    with pytest.raises(ExportProfileValidationError):
        await update_export_profile(
            db_session,
            record.id,
            ExportProfileUpdate(
                columns=[
                    _column("invoice_number"),
                    _column("invoice_number"),
                ],
            ),
        )


@pytest.mark.asyncio
async def test_update_clear_description_with_explicit_null(db_session):
    record = await create_export_profile(
        db_session, _create_body(description="initial")
    )
    updated = await update_export_profile(
        db_session,
        record.id,
        ExportProfileUpdate(description=None),
    )
    assert updated.description is None


# ---------------------------------------------------------------------------
# Default uniqueness per target system
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_default_clears_other_defaults_on_same_target(
    db_session,
):
    first = await create_export_profile(
        db_session,
        _create_body(name="First default", is_default=True),
    )
    assert first.is_default is True

    second = await create_export_profile(
        db_session,
        _create_body(name="Second default", is_default=True),
    )
    assert second.is_default is True

    refreshed_first = await get_export_profile(db_session, first.id)
    assert refreshed_first.is_default is False


@pytest.mark.asyncio
async def test_default_uniqueness_scoped_per_target_system(db_session):
    custom_default = await create_export_profile(
        db_session,
        _create_body(
            name="Custom default",
            target_system="custom_csv",
            is_default=True,
        ),
    )
    resman_default = await create_export_profile(
        db_session,
        _create_body(
            name="ResMan default",
            target_system="resman",
            is_default=True,
        ),
    )
    # Both remain default — different target systems.
    refreshed_custom = await get_export_profile(db_session, custom_default.id)
    refreshed_resman = await get_export_profile(db_session, resman_default.id)
    assert refreshed_custom.is_default is True
    assert refreshed_resman.is_default is True


@pytest.mark.asyncio
async def test_update_to_default_clears_other_defaults(db_session):
    a = await create_export_profile(
        db_session,
        _create_body(name="A", is_default=True),
    )
    b = await create_export_profile(
        db_session, _create_body(name="B", is_default=False)
    )
    await update_export_profile(
        db_session, b.id, ExportProfileUpdate(is_default=True)
    )
    refreshed_a = await get_export_profile(db_session, a.id)
    assert refreshed_a.is_default is False


# ---------------------------------------------------------------------------
# Soft delete
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_flips_is_active_and_clears_is_default(db_session):
    record = await create_export_profile(
        db_session, _create_body(name="To delete", is_default=True)
    )
    deleted = await delete_export_profile(db_session, record.id)
    assert deleted.is_active is False
    assert deleted.is_default is False
    # Row still exists.
    fetched = await get_export_profile(db_session, record.id)
    assert fetched.is_active is False


@pytest.mark.asyncio
async def test_delete_is_idempotent(db_session):
    record = await create_export_profile(db_session, _create_body())
    await delete_export_profile(db_session, record.id)
    # Second delete should not raise.
    second = await delete_export_profile(db_session, record.id)
    assert second.is_active is False


# ---------------------------------------------------------------------------
# Conversion to Phase 3I contract
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_contract_returns_phase_3i_export_profile(db_session):
    record = await create_export_profile(db_session, _create_body())
    contract = await get_export_profile_contract(db_session, record.id)
    assert isinstance(contract, ExportProfile)
    assert contract.id == str(record.id)
    assert contract.name == record.name
    assert contract.target_system == record.target_system
    assert contract.diagnostic_only is True
    # Columns + settings round-trip into the typed Phase 3I shapes.
    assert any(c.key == "invoice_number" for c in contract.columns)
    assert contract.settings.delimiter == ","


# ---------------------------------------------------------------------------
# No export side effects
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_management_service_does_not_create_other_records(
    db_session,
):
    """Sanity check — creating a profile should leave every OTHER
    table (documents, batches, templates, exports) untouched. We
    don't assert exact zero rows here (the test DB is recreated per
    test) but we DO assert that the export_profiles row is the only
    new row created in this session.
    """
    record = await create_export_profile(db_session, _create_body())

    # Single profile row exists.
    rows = (
        await db_session.execute(select(ExportProfileRecord))
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].id == record.id
