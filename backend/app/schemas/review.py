import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel


class ReviewEventOut(BaseModel):
    id: uuid.UUID
    invoice_id: uuid.UUID
    reviewer_id: uuid.UUID
    event_type: str
    field_name: str | None
    value_before: dict | None
    value_after: dict | None
    note: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ApproveRequest(BaseModel):
    pass


class RejectRequest(BaseModel):
    note: str | None = None
