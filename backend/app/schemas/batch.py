import uuid
from datetime import datetime

from pydantic import BaseModel


class BatchCreate(BaseModel):
    name: str
    description: str | None = None


class BatchOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    created_by: uuid.UUID
    total_documents: int
    processed_documents: int
    failed_documents: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
