"""Shared dependency/used-by response shapes.

These schemas power destructive-action guards. They are deliberately
generic so Reference Data, Import Builder, and Invoice Builder can all
return the same report shape without coupling their own schemas.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


UsedBySeverity = Literal["blocking", "warning", "info"]


class UsedByDependent(BaseModel):
    severity: UsedBySeverity
    dependent_type: str = Field(min_length=1, max_length=80)
    dependent_id: str | None = Field(default=None, max_length=128)
    dependent_label: str | None = Field(default=None, max_length=255)
    location: str | None = Field(default=None, max_length=255)
    message: str = Field(min_length=1, max_length=500)
    recommendation: str | None = Field(default=None, max_length=500)
    column_id: str | None = Field(default=None, max_length=128)
    column_label: str | None = Field(default=None, max_length=255)
    rule_id: str | None = Field(default=None, max_length=128)
    rule_label: str | None = Field(default=None, max_length=255)
    cell_key: str | None = Field(default=None, max_length=128)
    related_id: str | None = Field(default=None, max_length=128)
    related_type: str | None = Field(default=None, max_length=80)


class UsedByReport(BaseModel):
    resource_type: str = Field(min_length=1, max_length=80)
    resource_id: str = Field(min_length=1, max_length=128)
    resource_label: str | None = Field(default=None, max_length=255)
    safe_to_delete: bool
    blocking_count: int = 0
    warning_count: int = 0
    info_count: int = 0
    dependents: list[UsedByDependent] = Field(default_factory=list)
