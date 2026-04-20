import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class ExportJob(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "export_jobs"

    batch_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("batches.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    requested_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    format: Mapped[str] = mapped_column(String(16), nullable=False)  # csv | xlsx | json
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    # pending | processing | completed | failed

    filters: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    storage_key: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    row_count: Mapped[int | None] = mapped_column(nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    def __repr__(self) -> str:
        return f"<ExportJob id={self.id} format={self.format} status={self.status}>"
