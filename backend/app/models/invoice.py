import uuid
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import Date, ForeignKey, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey

if TYPE_CHECKING:
    from app.models.document import Document
    from app.models.invoice_line import InvoiceLine
    from app.models.review_event import ReviewEvent


class Invoice(Base, UUIDPrimaryKey, TimestampMixin):
    """Structured invoice data after extraction and optional user correction."""

    __tablename__ = "invoices"

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    extraction_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("extraction_runs.id", ondelete="SET NULL"),
        nullable=True,
    )

    # Vendor
    vendor_name: Mapped[str] = mapped_column(String(512), nullable=False, index=True)
    vendor_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    vendor_tax_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Bill-to / Property
    bill_to_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    bill_to_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    property_name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    property_code: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)

    # Invoice metadata
    invoice_number: Mapped[str] = mapped_column(String(128), nullable=False)
    invoice_date: Mapped[date] = mapped_column(Date, nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    service_period_start: Mapped[date | None] = mapped_column(Date, nullable=True)
    service_period_end: Mapped[date | None] = mapped_column(Date, nullable=True)
    payment_terms: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # Amounts (NUMERIC to avoid floating-point rounding)
    subtotal: Mapped[Decimal | None] = mapped_column(Numeric(14, 4), nullable=True)
    tax_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 4), nullable=True)
    total_amount: Mapped[Decimal] = mapped_column(Numeric(14, 4), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")

    # Classification
    invoice_type: Mapped[str] = mapped_column(String(32), nullable=False, default="unknown")
    utility_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    account_number: Mapped[str | None] = mapped_column(String(128), nullable=True)
    meter_number: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # Provenance
    extraction_confidence: Mapped[float | None] = mapped_column(nullable=True)
    raw_text_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Relationships
    document: Mapped["Document"] = relationship("Document", back_populates="invoice")
    lines: Mapped[list["InvoiceLine"]] = relationship(
        "InvoiceLine", back_populates="invoice", cascade="all, delete-orphan"
    )
    review_events: Mapped[list["ReviewEvent"]] = relationship(
        "ReviewEvent", back_populates="invoice"
    )

    def __repr__(self) -> str:
        return f"<Invoice id={self.id} vendor={self.vendor_name!r} inv={self.invoice_number!r}>"
