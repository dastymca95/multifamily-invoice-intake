import uuid

from sqlalchemy import Float, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class ExtractionRun(Base, UUIDPrimaryKey, TimestampMixin):
    """Records each attempt to extract structured data from a document.

    A document may have multiple runs if re-extraction is triggered (e.g. after
    a user corrects the vendor pattern and requests a re-run).
    """

    __tablename__ = "extraction_runs"

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    adapter_name: Mapped[str] = mapped_column(String(64), nullable=False)  # native_pdf | ocr_stub | …
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    raw_output: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(nullable=True)

    document = relationship("Document", back_populates="extraction_runs")

    def __repr__(self) -> str:
        return f"<ExtractionRun id={self.id} doc={self.document_id} adapter={self.adapter_name} status={self.status}>"
