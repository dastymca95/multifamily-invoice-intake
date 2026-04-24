from sqlalchemy import select

from app.models.invoice_pattern import InvoicePattern
from app.repositories.base import BaseRepository


class InvoicePatternRepository(BaseRepository[InvoicePattern]):
    """
    Saved Invoice Builder visual extraction patterns. Listed
    newest-first by `updated_at` so the rail's most-recently-edited
    pattern sits at the top — same rhythm as
    `InvoiceTemplateRepository` and `ImportConfigRepository`.
    """

    model = InvoicePattern

    async def list_recent(
        self, limit: int = 50, offset: int = 0
    ) -> list[InvoicePattern]:
        result = await self._session.execute(
            select(InvoicePattern)
            .order_by(InvoicePattern.updated_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())
