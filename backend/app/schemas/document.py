import uuid
from datetime import datetime

from pydantic import BaseModel


class DocumentOut(BaseModel):
    id: uuid.UUID
    batch_id: uuid.UUID
    original_filename: str
    mime_type: str
    file_size_bytes: int
    document_kind: str
    extraction_status: str
    review_status: str
    checksum_sha256: str
    error_message: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class DocumentUploadResult(BaseModel):
    document_id: uuid.UUID
    original_filename: str
    document_kind: str
    duplicate: bool
