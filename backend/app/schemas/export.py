import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class ExportJobCreate(BaseModel):
    format: Literal["csv", "xlsx", "json"]
    batch_id: uuid.UUID | None = None
    filters: dict | None = None


class ExportJobOut(BaseModel):
    id: uuid.UUID
    format: str
    status: str
    batch_id: uuid.UUID | None
    requested_by: uuid.UUID
    row_count: int | None
    storage_key: str | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ExportDownloadUrl(BaseModel):
    url: str
    expires_in: int
