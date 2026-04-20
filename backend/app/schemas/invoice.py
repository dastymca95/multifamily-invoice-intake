import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel


class LineItemOut(BaseModel):
    id: uuid.UUID
    line_number: int
    description: str
    quantity: Decimal | None
    unit: str | None
    unit_price: Decimal | None
    amount: Decimal
    gl_code: str | None

    model_config = {"from_attributes": True}


class InvoiceOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    vendor_name: str | None
    vendor_address: str | None
    property_name: str | None
    property_code: str | None
    invoice_number: str | None
    invoice_date: date | None
    due_date: date | None
    service_period_start: date | None
    service_period_end: date | None
    subtotal: Decimal | None
    tax_amount: Decimal | None
    total_amount: Decimal | None
    currency: str
    invoice_type: str
    utility_type: str | None
    account_number: str | None
    meter_number: str | None
    extraction_confidence: float | None
    lines: list[LineItemOut] = []
    updated_at: datetime

    model_config = {"from_attributes": True}


class InvoiceFieldEdit(BaseModel):
    field_name: str
    new_value: Any
    note: str | None = None
