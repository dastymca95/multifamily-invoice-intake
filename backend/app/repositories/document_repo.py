from uuid import UUID

from sqlalchemy import select

from app.models.document import Document
from app.repositories.base import BaseRepository


class DocumentRepository(BaseRepository[Document]):
    model = Document

    async def get_by_batch(
        self, batch_id: UUID, limit: int = 100, offset: int = 0
    ) -> list[Document]:
        result = await self._session.execute(
            select(Document)
            .where(Document.batch_id == batch_id)
            .order_by(Document.created_at.asc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())

    async def get_by_checksum(self, checksum: str) -> Document | None:
        result = await self._session.execute(
            select(Document).where(Document.checksum_sha256 == checksum)
        )
        return result.scalar_one_or_none()

    async def get_pending_review(self, limit: int = 50) -> list[Document]:
        result = await self._session.execute(
            select(Document)
            .where(
                Document.extraction_status == "extracted",
                Document.review_status == "pending",
            )
            .order_by(Document.created_at.asc())
            .limit(limit)
        )
        return list(result.scalars().all())
