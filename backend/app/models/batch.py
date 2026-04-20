import uuid
from typing import TYPE_CHECKING

from sqlalchemy import String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey

if TYPE_CHECKING:
    from app.models.document import Document


class Batch(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "batches"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    # Denormalised counters updated by triggers/workers to avoid full-table counts
    total_documents: Mapped[int] = mapped_column(default=0, nullable=False)
    processed_documents: Mapped[int] = mapped_column(default=0, nullable=False)
    failed_documents: Mapped[int] = mapped_column(default=0, nullable=False)

    documents: Mapped[list["Document"]] = relationship("Document", back_populates="batch")

    def __repr__(self) -> str:
        return f"<Batch id={self.id} name={self.name!r}>"
