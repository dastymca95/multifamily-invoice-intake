from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.models.invoice import Invoice
from app.repositories.base import BaseRepository


class InvoiceRepository(BaseRepository[Invoice]):
    model = Invoice

    async def get_with_lines(self, invoice_id: UUID) -> Invoice | None:
        result = await self._session.execute(
            select(Invoice)
            .options(selectinload(Invoice.lines))
            .where(Invoice.id == invoice_id)
        )
        return result.scalar_one_or_none()

    async def get_by_document(self, document_id: UUID) -> Invoice | None:
        result = await self._session.execute(
            select(Invoice).where(Invoice.document_id == document_id)
        )
        return result.scalar_one_or_none()

    async def get_approved_for_export(
        self,
        batch_id: UUID | None = None,
        limit: int = 500,
        offset: int = 0,
    ) -> list[Invoice]:
        from app.models.document import Document

        stmt = (
            select(Invoice)
            .join(Document, Invoice.document_id == Document.id)
            .where(Document.review_status == "approved")
            .options(selectinload(Invoice.lines))
            .limit(limit)
            .offset(offset)
        )
        if batch_id is not None:
            stmt = stmt.where(Document.batch_id == batch_id)
        result = await self._session.execute(stmt)
        return list(result.scalars().all())
