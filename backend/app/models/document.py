import uuid
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey

if TYPE_CHECKING:
    from app.models.batch import Batch
    from app.models.extraction_run import ExtractionRun
    from app.models.invoice import Invoice


class Document(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "documents"

    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("batches.id", ondelete="CASCADE"), nullable=False, index=True
    )

    original_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(1024), nullable=False, unique=True)
    mime_type: Mapped[str] = mapped_column(String(127), nullable=False)
    file_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    checksum_sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # Routing decision set by app.domain.routing.route_document at ingest time.
    # Values: native_pdf | scanned_or_image | unsupported
    route_used: Mapped[str] = mapped_column(
        String(32), nullable=False, default="unsupported"
    )

    extraction_status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="pending"
    )  # pending | processing | extracted | failed

    review_status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="pending"
    )  # pending | in_review | approved | rejected

    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Relationships
    batch: Mapped["Batch"] = relationship("Batch", back_populates="documents")
    extraction_runs: Mapped[list["ExtractionRun"]] = relationship(
        "ExtractionRun",
        back_populates="document",
        order_by="ExtractionRun.created_at.desc()",
    )
    invoice: Mapped["Invoice | None"] = relationship(
        "Invoice", back_populates="document", uselist=False
    )

    def __repr__(self) -> str:
        return (
            f"<Document id={self.id} filename={self.original_filename!r} "
            f"route={self.route_used} status={self.extraction_status}>"
        )
