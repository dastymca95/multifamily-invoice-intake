import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class ReviewEvent(Base, UUIDPrimaryKey, TimestampMixin):
    """
    Immutable audit log of every user action on an invoice.

    Captures the before/after state for each field edit so we can reconstruct
    exactly what changed, who changed it, and when. This is the basis for
    vendor pattern learning.
    """

    __tablename__ = "review_events"

    invoice_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("invoices.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    reviewer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)

    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    # event_type: field_edit | status_change | line_add | line_delete | line_edit | approve | reject

    field_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    value_before: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    value_after: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    invoice = relationship("Invoice", back_populates="review_events")

    def __repr__(self) -> str:
        return f"<ReviewEvent id={self.id} type={self.event_type} field={self.field_name}>"
