import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.invoice import LineItemOut


class DocumentOut(BaseModel):
    id: uuid.UUID
    batch_id: uuid.UUID
    original_filename: str
    mime_type: str
    file_size_bytes: int
    route_used: str
    extraction_status: str
    review_status: str
    checksum_sha256: str
    error_message: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class DocumentUploadResult(BaseModel):
    document_id: uuid.UUID
    original_filename: str
    route_used: str
    extraction_status: str
    review_status: str
    duplicate: bool


class ValidationWarningOut(BaseModel):
    field: str | None
    code: str
    message: str
    severity: str = "warning"


class ExtractionRunOut(BaseModel):
    id: uuid.UUID
    adapter_name: str
    status: str
    confidence_score: float | None
    review_required: bool
    duration_ms: int | None
    error_message: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class CanonicalLineItemPayload(BaseModel):
    line_number: int = 0
    description: str
    quantity: Decimal | None = None
    unit: str | None = None
    unit_price: Decimal | None = None
    amount: Decimal
    gl_code: str | None = None


class CanonicalInvoicePayload(BaseModel):
    """Inbound shape for review save — mirrors CanonicalInvoice but no IDs."""
    vendor_name: str | None = None
    vendor_address: str | None = None
    vendor_tax_id: str | None = None
    bill_to_name: str | None = None
    bill_to_address: str | None = None
    property_name: str | None = None
    property_code: str | None = None
    invoice_number: str | None = None
    invoice_date: date | None = None
    due_date: date | None = None
    service_period_start: date | None = None
    service_period_end: date | None = None
    payment_terms: str | None = None
    subtotal: Decimal | None = None
    tax_amount: Decimal | None = None
    total_amount: Decimal | None = None
    currency: str = "USD"
    invoice_type: str = "unknown"
    utility_type: str | None = None
    account_number: str | None = None
    meter_number: str | None = None
    line_items: list[CanonicalLineItemPayload] = Field(default_factory=list)


class DocumentDetailResponse(BaseModel):
    """Enriched response for the review screen."""
    document: DocumentOut
    extraction_run: ExtractionRunOut | None
    invoice: dict[str, Any] | None  # canonical invoice as a flat dict (incl. lines)
    warnings: list[ValidationWarningOut]
