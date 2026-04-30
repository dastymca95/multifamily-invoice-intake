"""
Phase 4A — Persisted Export Profile CRUD schemas.

Lives in its own module so ``app.schemas.export_profile`` (the
diagnostic validation contract from Phase 3I) stays focused on the
shape the validator + frontend mirror.

What this module IS:
  * Pydantic schemas for create / update / read / list responses.
  * A converter from a persisted ``ExportProfileRecord`` row into
    the existing ``ExportProfile`` validation contract so the
    Phase 3I validator can be reused over a saved profile id.

What this module is NOT:
  * NOT an export engine.
  * NOT an export run / batch shape.
  * NOT a side-effecting layer.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.export_profile import (
    ExportProfile,
    ExportProfileColumn,
    ExportProfileSettings,
    ExportTargetSystem,
)


# ---------------------------------------------------------------------------
# Source vocabulary
# ---------------------------------------------------------------------------


# How a row entered the catalog. Closed Literal so a future
# "imported from another tenant" path lands explicitly. Stored on
# the row as free-text — service layer narrows on create / update.
ExportProfileRecordSource = str  # Validated narrowly on the request schemas.


_ALLOWED_SOURCES: frozenset[str] = frozenset(
    {"manual", "built_in_seed", "imported"}
)


# ---------------------------------------------------------------------------
# Create / update / read schemas
# ---------------------------------------------------------------------------


class ExportProfileCreate(BaseModel):
    """Body for ``POST /api/v1/export-profiles``.

    The ``settings`` and ``columns`` payloads are validated against
    the existing ``ExportProfile`` contract via the management
    service before they touch the DB. We do NOT wrap them in
    ``ExportProfileSettings`` / ``ExportProfileColumn`` Pydantic
    types here because Phase 4A wants to evolve those shapes via
    JSONB without forcing a CRUD-side migration on every change.
    """

    name: str = Field(min_length=1, max_length=255)
    target_system: ExportTargetSystem
    description: str | None = None
    settings: dict[str, Any] = Field(default_factory=dict)
    columns: list[dict[str, Any]] = Field(default_factory=list)
    is_active: bool = True
    is_default: bool = False
    source: str = "manual"
    notes: str | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name must be non-empty")
        return v

    @field_validator("source")
    @classmethod
    def _check_source(cls, v: str) -> str:
        if v not in _ALLOWED_SOURCES:
            raise ValueError(
                f"source must be one of: {sorted(_ALLOWED_SOURCES)}"
            )
        return v


class ExportProfileUpdate(BaseModel):
    """Body for ``PATCH /api/v1/export-profiles/{id}``.

    Every field is optional. Sending ``description: null``
    explicitly clears the description (matching ``InvoiceTemplate``
    semantics). Sending ``columns`` / ``settings`` REPLACES the
    array / dict outright — partial-merge would defeat the
    operator's expectation that "what I sent is what's saved".
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    settings: dict[str, Any] | None = None
    columns: list[dict[str, Any]] | None = None
    is_active: bool | None = None
    is_default: bool | None = None
    notes: str | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("name must be non-empty")
        return v


class ExportProfileRead(BaseModel):
    """Read shape returned by GET / POST / PATCH endpoints.

    Carries the persisted catalog metadata + the JSONB ``settings``
    / ``columns`` payloads. Diagnostic-only — no
    ``download_url`` / ``export_id`` / etc. (see Phase 3O contract
    test ``test_operational_preview_contract.py``).
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    target_system: str
    description: str | None = None
    settings: dict[str, Any]
    columns: list[dict[str, Any]]
    is_active: bool
    is_default: bool
    version: int
    source: str
    notes: str | None = None
    created_by_user_id: UUID | None = None
    updated_by_user_id: UUID | None = None
    created_at: datetime
    updated_at: datetime


class ExportProfileSummary(BaseModel):
    """Lightweight item for list responses — no JSONB payloads."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    target_system: str
    description: str | None = None
    is_active: bool
    is_default: bool
    version: int
    source: str
    created_at: datetime
    updated_at: datetime


class ExportProfileListResponse(BaseModel):
    items: list[ExportProfileSummary] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Conversion to the Phase 3I validation contract
# ---------------------------------------------------------------------------


def persisted_profile_to_export_profile_contract(record: Any) -> ExportProfile:
    """Project a persisted ``ExportProfileRecord`` row into the
    existing Pydantic ``ExportProfile`` validation contract from
    Phase 3I.

    Used by the optional ``GET /export-profiles/{id}/contract``
    endpoint and by any future code path that wants to validate a
    saved profile against a preview through the existing Phase 3I
    validator without re-implementing the conversion.

    The persisted ``settings`` / ``columns`` JSONB payloads are
    re-validated through ``ExportProfileSettings`` /
    ``ExportProfileColumn`` here — anything that survived the CRUD
    write but is now incompatible with the contract surfaces as a
    Pydantic ``ValidationError`` rather than a silent shape mismatch
    later in the validator.
    """
    settings = ExportProfileSettings.model_validate(record.settings or {})
    columns = [
        ExportProfileColumn.model_validate(c) for c in (record.columns or [])
    ]
    return ExportProfile(
        id=str(record.id),
        name=record.name,
        target_system=record.target_system,
        description=record.description,
        settings=settings,
        columns=columns,
        diagnostic_only=True,
    )
