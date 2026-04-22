"""
Pydantic shapes for the Import Builder API.

Three response shapes — three audiences:

  * `ImportConfigSummary`  — for the left-rail list. Lightweight: id,
                             name, override count, timestamps. No
                             preview computation.
  * `ImportConfigOut`      — full config record (includes overrides).
                             Used as a building block of the detail
                             response and as the PATCH echo.
  * `ImportConfigDetail`   — config + a freshly-rendered preview of
                             how the future ResMan import would look
                             with this config applied. Computed against
                             the CURRENT reference uploads, so opening
                             a saved config always reflects the live
                             state of the world.

The role-override values are constrained to the same Literal as
`PreviewColumnOut.role` so a typo at PATCH time is rejected with a 422
rather than silently persisted.
"""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.schemas.resman_preview import ColumnRoleLiteral, ResmanPreviewResponse

# Bounds for the row_limit knob. Keeps the preview useful (>= 1 row) and
# bounded (the panel's vertical scroll caps out around 50).
ROW_LIMIT_MIN = 1
ROW_LIMIT_MAX = 50


class ImportConfigCreate(BaseModel):
    """Body for POST /import-configs. All fields except `name` optional."""

    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    column_role_overrides: dict[str, ColumnRoleLiteral] = Field(default_factory=dict)
    row_limit: int = Field(default=8, ge=ROW_LIMIT_MIN, le=ROW_LIMIT_MAX)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name cannot be blank")
        return v


class ImportConfigUpdate(BaseModel):
    """
    Body for PATCH /import-configs/{id}. Every field optional —
    omitting a field leaves the persisted value unchanged. Sending
    `column_role_overrides: {}` explicitly REPLACES the dict (use that
    to clear all overrides); sending `null` for `description` clears it.
    """

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    # NOTE: distinguishing "field omitted" from "field set to {}" relies
    # on FastAPI's default serialization treating absent keys as "not
    # present". The endpoint uses `model_dump(exclude_unset=True)` to
    # apply only the keys the caller actually sent.
    column_role_overrides: dict[str, ColumnRoleLiteral] | None = None
    row_limit: int | None = Field(default=None, ge=ROW_LIMIT_MIN, le=ROW_LIMIT_MAX)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("name cannot be blank")
        return v


class ImportConfigOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    column_role_overrides: dict[str, str]
    row_limit: int
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ImportConfigSummary(BaseModel):
    """List-row shape — no overrides dict, just its size."""

    id: uuid.UUID
    name: str
    description: str | None
    row_limit: int
    override_count: int
    created_at: datetime
    updated_at: datetime


class ImportConfigDetail(BaseModel):
    """
    GET / POST / PATCH detail response. Bundles the config with its
    rendered preview so the workspace can update both atomically from
    a single round-trip.
    """

    config: ImportConfigOut
    preview: ResmanPreviewResponse


class ImportConfigList(BaseModel):
    items: list[ImportConfigSummary] = Field(default_factory=list)
