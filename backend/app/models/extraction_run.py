import uuid

from sqlalchemy import Boolean, Float, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class ExtractionRun(Base, UUIDPrimaryKey, TimestampMixin):
    """
    Records each extraction attempt for a document.

    raw_output_json:        unmodified adapter output (provenance / debugging)
    normalized_output_json: adapter output mapped onto the CanonicalInvoice shape.
                            This is the snapshot the review UI starts from.
    review_required:        always True in Phase 1 — every extraction is reviewed.
                            Reserved for later auto-approval rules.
    """

    __tablename__ = "extraction_runs"

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    adapter_name: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")

    confidence_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    review_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    raw_output_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    normalized_output_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(nullable=True)

    document = relationship("Document", back_populates="extraction_runs")

    def __repr__(self) -> str:
        return (
            f"<ExtractionRun id={self.id} doc={self.document_id} "
            f"adapter={self.adapter_name} status={self.status}>"
        )
