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
    #
    # `passive_deletes=True` + `cascade="all, delete-orphan"` is required on
    # the child relationships (extraction_runs, invoice) because:
    #   1. The child FKs (extraction_runs.document_id, invoices.document_id)
    #      are NOT NULL.
    #   2. The DB schema already has ON DELETE CASCADE on those FKs (see the
    #      models in extraction_run.py / invoice.py).
    #   3. Without `passive_deletes=True`, SQLAlchemy's default behavior on
    #      `session.delete(doc)` is to load the related rows and try to
    #      *nullify* their FK first — which fails the NOT NULL constraint
    #      and surfaces as an HTTP 500 in the upload workspace's "Remove
    #      from batch" action. Trusting the DB-level cascade avoids that.
    #   4. `cascade="all, delete-orphan"` keeps the in-memory ORM graph in
    #      sync if related objects are mutated in Python before flush.
    batch: Mapped["Batch"] = relationship("Batch", back_populates="documents")
    extraction_runs: Mapped[list["ExtractionRun"]] = relationship(
        "ExtractionRun",
        back_populates="document",
        order_by="ExtractionRun.created_at.desc()",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    invoice: Mapped["Invoice | None"] = relationship(
        "Invoice",
        back_populates="document",
        uselist=False,
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return (
            f"<Document id={self.id} filename={self.original_filename!r} "
            f"route={self.route_used} status={self.extraction_status}>"
        )
