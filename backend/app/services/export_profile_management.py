"""
Phase 4A — Export Profile management service.

Pure-ish CRUD layer (talks to a single repository) with the
following business rules layered on top of the raw row writes:

  * **Pydantic shape validation** — ``settings`` and ``columns`` are
    re-validated through the existing Phase 3I
    ``ExportProfileSettings`` / ``ExportProfileColumn`` types
    BEFORE persistence. A malformed payload raises
    ``ExportProfileValidationError`` (mapped to HTTP 422 by the
    API layer).
  * **Column-key uniqueness** — duplicate ``column.key`` values
    within one profile are rejected.
  * **Target system narrowing** — only the closed Phase 3I literal
    set (``custom_csv`` / ``resman`` / ``yardi`` / ``appfolio``)
    is accepted on create / update.
  * **Default uniqueness per target system** — when a profile is
    saved with ``is_default=True``, every other ACTIVE profile for
    the same target system has its ``is_default`` flag cleared in
    the same transaction. Inactive rows are left untouched on
    purpose so a soft-deleted profile doesn't get reactivated as a
    side effect.
  * **Version bump on shape changes** — updates that touch
    ``settings`` or ``columns`` increment ``version``. Pure
    metadata edits (name, description, notes, is_active flip,
    is_default flip) leave ``version`` unchanged. Documented
    explicitly in the docstrings and exercised in the service
    tests.
  * **Soft-delete** — ``delete`` flips ``is_active=False`` rather
    than dropping the row; this lets a future export run audit
    keep referring to the profile that produced it.

Hard contract:
  * No file generation, no export records, no document / batch /
    template mutation, no external posting, no OCR / AI.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.export_profile import ExportProfileRecord
from app.repositories.export_profile_repo import ExportProfileRepository
from app.schemas.export_profile import (
    ExportProfile,
    ExportProfileColumn,
    ExportProfileSettings,
)
from app.schemas.export_profile_persistence import (
    ExportProfileCreate,
    ExportProfileUpdate,
    persisted_profile_to_export_profile_contract,
)


__all__ = [
    "ExportProfileManagementError",
    "ExportProfileNotFoundError",
    "ExportProfileValidationError",
    "create_export_profile",
    "get_export_profile",
    "get_export_profile_contract",
    "list_export_profiles",
    "update_export_profile",
    "delete_export_profile",
]


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ExportProfileManagementError(Exception):
    """Base class — caught by the API layer for HTTP mapping."""


class ExportProfileNotFoundError(ExportProfileManagementError):
    """Raised when a profile id doesn't exist (or is hard-deleted)."""


class ExportProfileValidationError(ExportProfileManagementError):
    """Raised when the create/update payload fails business rules
    that aren't expressible via the request Pydantic schema alone
    (column-key uniqueness, settings/column re-validation, target
    system enum). Mapped to HTTP 422 by the API layer.
    """


_ALLOWED_TARGET_SYSTEMS: frozenset[str] = frozenset(
    {"custom_csv", "resman", "yardi", "appfolio"}
)


# ---------------------------------------------------------------------------
# Public — create
# ---------------------------------------------------------------------------


async def create_export_profile(
    db: AsyncSession,
    body: ExportProfileCreate,
    *,
    user_id: UUID | None = None,
) -> ExportProfileRecord:
    """Persist a new profile after re-validating the JSONB payloads.

    Sets ``version=1``, copies ``created_by_user_id`` /
    ``updated_by_user_id`` from the supplied ``user_id``. Enforces
    "at most one default per target_system" when ``is_default`` is
    True. Raises ``ExportProfileValidationError`` on any rule
    failure.
    """
    _validate_target_system(body.target_system)
    settings_dict = _validate_settings(body.settings)
    columns_list = _validate_columns(body.columns)

    repo = ExportProfileRepository(db)
    record = ExportProfileRecord(
        name=body.name,
        target_system=body.target_system,
        description=body.description,
        settings=settings_dict,
        columns=columns_list,
        is_active=body.is_active,
        is_default=body.is_default,
        version=1,
        source=body.source,
        notes=body.notes,
        created_by_user_id=user_id,
        updated_by_user_id=user_id,
    )
    record = await repo.save(record)

    # Default uniqueness — clear other defaults on the same target
    # system AFTER persisting the new row so the new row is the
    # winner if there's a race / concurrent flip.
    if body.is_default and body.is_active:
        await _clear_other_defaults(
            db,
            repo=repo,
            target_system=body.target_system,
            keep_id=record.id,
        )
        await db.flush()
        await db.refresh(record)

    return record


# ---------------------------------------------------------------------------
# Public — read
# ---------------------------------------------------------------------------


async def get_export_profile(
    db: AsyncSession, profile_id: UUID
) -> ExportProfileRecord:
    """Return the profile or raise ``ExportProfileNotFoundError``.

    Note: returns soft-deleted rows too — the API layer decides
    whether to expose them. CRUD endpoints currently surface the
    profile regardless of ``is_active`` so an admin can re-activate
    via PATCH.
    """
    repo = ExportProfileRepository(db)
    record = await repo.get(profile_id)
    if record is None:
        raise ExportProfileNotFoundError(
            f"Export profile {profile_id} not found"
        )
    return record


async def get_export_profile_contract(
    db: AsyncSession, profile_id: UUID
) -> ExportProfile:
    """Return the persisted profile projected into the existing
    Phase 3I ``ExportProfile`` validation contract.

    Useful when a future caller wants to validate a preview against
    a saved profile id by routing through the existing Phase 3I
    validator without inlining the payload.
    """
    record = await get_export_profile(db, profile_id)
    return persisted_profile_to_export_profile_contract(record)


async def list_export_profiles(
    db: AsyncSession,
    *,
    target_system: str | None = None,
    is_active: bool | None = True,
    limit: int = 50,
    offset: int = 0,
) -> list[ExportProfileRecord]:
    """List profiles with optional ``target_system`` / ``is_active``
    filters. Raises ``ExportProfileValidationError`` on an invalid
    target system literal so a typo doesn't silently return zero
    rows.
    """
    if target_system is not None:
        _validate_target_system(target_system)
    repo = ExportProfileRepository(db)
    return await repo.list_filtered(
        target_system=target_system,
        is_active=is_active,
        limit=limit,
        offset=offset,
    )


# ---------------------------------------------------------------------------
# Public — update
# ---------------------------------------------------------------------------


async def update_export_profile(
    db: AsyncSession,
    profile_id: UUID,
    body: ExportProfileUpdate,
    *,
    user_id: UUID | None = None,
) -> ExportProfileRecord:
    """Apply a partial update.

    Only fields the caller actually sent are applied. Sending
    ``settings`` or ``columns`` REPLACES the JSONB value outright
    AND increments ``version``. Metadata-only updates leave
    ``version`` untouched.

    When ``is_default=True`` is flipped ON, "at most one default
    per target system" is enforced — every OTHER active row on the
    same target system has its ``is_default`` cleared in the same
    transaction.
    """
    record = await get_export_profile(db, profile_id)
    repo = ExportProfileRepository(db)
    updates = body.model_dump(exclude_unset=True)

    shape_changed = False

    if "name" in updates and updates["name"] is not None:
        record.name = updates["name"]
    if "description" in updates:
        # Explicit null in the body is "clear the description".
        record.description = updates["description"]
    if "notes" in updates:
        record.notes = updates["notes"]
    if "is_active" in updates and updates["is_active"] is not None:
        record.is_active = updates["is_active"]
    if "is_default" in updates and updates["is_default"] is not None:
        record.is_default = updates["is_default"]
    if "settings" in updates and updates["settings"] is not None:
        record.settings = _validate_settings(updates["settings"])
        shape_changed = True
    if "columns" in updates and updates["columns"] is not None:
        record.columns = _validate_columns(updates["columns"])
        shape_changed = True

    if shape_changed:
        record.version = (record.version or 1) + 1

    if user_id is not None:
        record.updated_by_user_id = user_id

    record = await repo.save(record)

    # Default uniqueness — same rule as ``create_export_profile``.
    if record.is_default and record.is_active:
        await _clear_other_defaults(
            db,
            repo=repo,
            target_system=record.target_system,
            keep_id=record.id,
        )
        await db.flush()
        await db.refresh(record)

    return record


# ---------------------------------------------------------------------------
# Public — delete (soft)
# ---------------------------------------------------------------------------


async def delete_export_profile(
    db: AsyncSession,
    profile_id: UUID,
    *,
    user_id: UUID | None = None,
) -> ExportProfileRecord:
    """Soft-delete by flipping ``is_active=False``.

    Phase 4A intentionally keeps the row so a future export run
    audit can still refer to it. The list endpoint defaults to
    filtering out inactive rows so the operator UI doesn't show
    deleted profiles. Hard delete is NOT exposed today.
    """
    record = await get_export_profile(db, profile_id)
    if not record.is_active:
        # Idempotent — re-deleting an already-inactive profile is
        # a no-op rather than an error.
        return record
    record.is_active = False
    # An inactive row can't simultaneously be the default — clear
    # the flag so the next "list defaults for target system" doesn't
    # surface a soft-deleted row.
    record.is_default = False
    if user_id is not None:
        record.updated_by_user_id = user_id
    repo = ExportProfileRepository(db)
    return await repo.save(record)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _validate_target_system(value: str) -> None:
    if value not in _ALLOWED_TARGET_SYSTEMS:
        raise ExportProfileValidationError(
            f"target_system must be one of: {sorted(_ALLOWED_TARGET_SYSTEMS)}; "
            f"got {value!r}"
        )


def _validate_settings(payload: dict[str, Any]) -> dict[str, Any]:
    """Re-validate the JSONB ``settings`` blob against the existing
    Phase 3I ``ExportProfileSettings`` contract. Returns the
    canonical model_dump so what we persist matches what the
    validator will read back.
    """
    if not isinstance(payload, dict):
        raise ExportProfileValidationError(
            "settings must be a JSON object"
        )
    try:
        model = ExportProfileSettings.model_validate(payload)
    except ValidationError as exc:
        raise ExportProfileValidationError(
            f"settings failed validation: {exc.errors()}"
        ) from exc
    return model.model_dump()


def _validate_columns(payload: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Re-validate every column against ``ExportProfileColumn`` AND
    enforce intra-profile column-key uniqueness.

    Returns the canonical model_dump list so what we persist matches
    what the validator will read back.
    """
    if not isinstance(payload, list):
        raise ExportProfileValidationError(
            "columns must be a JSON array"
        )
    seen_keys: set[str] = set()
    out: list[dict[str, Any]] = []
    for idx, raw in enumerate(payload):
        if not isinstance(raw, dict):
            raise ExportProfileValidationError(
                f"columns[{idx}] must be a JSON object"
            )
        try:
            model = ExportProfileColumn.model_validate(raw)
        except ValidationError as exc:
            raise ExportProfileValidationError(
                f"columns[{idx}] failed validation: {exc.errors()}"
            ) from exc
        if model.key in seen_keys:
            raise ExportProfileValidationError(
                f"columns[{idx}] has duplicate key {model.key!r}; "
                "column keys must be unique within a profile"
            )
        seen_keys.add(model.key)
        out.append(model.model_dump())
    return out


async def _clear_other_defaults(
    db: AsyncSession,
    *,
    repo: ExportProfileRepository,
    target_system: str,
    keep_id: UUID,
) -> None:
    """Clear ``is_default`` on every ACTIVE row for the given target
    system except ``keep_id``. Inactive rows are left alone so a
    soft-deleted profile doesn't get reactivated as a side effect.
    """
    defaults = await repo.list_defaults_for_target_system(target_system)
    for other in defaults:
        if other.id == keep_id:
            continue
        other.is_default = False
        db.add(other)
