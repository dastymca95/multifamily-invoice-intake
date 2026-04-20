import uuid
from datetime import datetime

from pydantic import BaseModel


class VendorPatternOut(BaseModel):
    id: uuid.UUID
    vendor_name_normalized: str
    vendor_name_display: str
    field_hints: dict
    confidence_score: float
    sample_count: int
    updated_at: datetime

    model_config = {"from_attributes": True}


class VendorPatternUpdate(BaseModel):
    field_hints: dict
