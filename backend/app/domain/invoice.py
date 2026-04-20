"""
Canonical invoice domain model.

This is the single source of truth for what a structured invoice looks like
after extraction, validation, and user review. All adapters (extraction, export,
posting) map to/from this shape.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class InvoiceType(StrEnum):
    UTILITY = "utility"
    VENDOR = "vendor"
    UNKNOWN = "unknown"


class UtilityType(StrEnum):
    ELECTRIC = "electric"
    GAS = "gas"
    WATER = "water"
    SEWER = "sewer"
    TRASH = "trash"
    TELECOM = "telecom"
    OTHER = "other"


class ExtractionStatus(StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    EXTRACTED = "extracted"
    FAILED = "failed"


class ReviewStatus(StrEnum):
    PENDING = "pending"
    IN_REVIEW = "in_review"
    APPROVED = "approved"
    REJECTED = "rejected"


class CanonicalLineItem(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    line_number: int = 0
    description: str
    quantity: Decimal | None = None
    unit: str | None = None
    unit_price: Decimal | None = None
    amount: Decimal
    gl_code: str | None = None

    @field_validator("amount", "unit_price", "quantity", mode="before")
    @classmethod
    def coerce_decimal(cls, v: Any) -> Decimal | None:
        if v is None:
            return None
        return Decimal(str(v))


class CanonicalInvoice(BaseModel):
    """
    Canonical invoice — the lingua franca between extraction, review, and export.

    Fields marked Optional may be absent from a source document. Extraction
    adapters should populate as many as possible; the review UI surfaces gaps
    to the reviewer.
    """

    model_config = ConfigDict(str_strip_whitespace=True)

    # ── Identifiers ────────────────────────────────────────────
    id: uuid.UUID = Field(default_factory=uuid.uuid4)
    document_id: uuid.UUID
    extraction_run_id: uuid.UUID | None = None

    # ── Vendor ─────────────────────────────────────────────────
    vendor_name: str
    vendor_address: str | None = None
    vendor_tax_id: str | None = None

    # ── Bill-to / Property ─────────────────────────────────────
    bill_to_name: str | None = None
    bill_to_address: str | None = None
    property_name: str | None = None
    property_code: str | None = None

    # ── Invoice metadata ───────────────────────────────────────
    invoice_number: str
    invoice_date: date
    due_date: date | None = None
    service_period_start: date | None = None
    service_period_end: date | None = None
    payment_terms: str | None = None

    # ── Amounts ────────────────────────────────────────────────
    subtotal: Decimal | None = None
    tax_amount: Decimal | None = None
    total_amount: Decimal
    currency: str = "USD"

    # ── Classification ─────────────────────────────────────────
    invoice_type: InvoiceType = InvoiceType.UNKNOWN
    utility_type: UtilityType | None = None
    account_number: str | None = None
    meter_number: str | None = None

    # ── Line items ─────────────────────────────────────────────
    line_items: list[CanonicalLineItem] = Field(default_factory=list)

    # ── Extraction provenance ──────────────────────────────────
    extraction_confidence: float | None = Field(None, ge=0.0, le=1.0)
    raw_text_hash: str | None = None

    @field_validator("total_amount", "subtotal", "tax_amount", mode="before")
    @classmethod
    def coerce_decimal(cls, v: Any) -> Decimal | None:
        if v is None:
            return None
        return Decimal(str(v))

    def computed_subtotal(self) -> Decimal:
        """Sum of line item amounts. Used for validation cross-check."""
        return sum((li.amount for li in self.line_items), Decimal("0"))

    def has_line_item_discrepancy(self, tolerance: Decimal = Decimal("0.02")) -> bool:
        if not self.line_items or self.subtotal is None:
            return False
        return abs(self.computed_subtotal() - self.subtotal) > tolerance
