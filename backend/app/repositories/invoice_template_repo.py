from sqlalchemy import select

from app.models.invoice_template import InvoiceTemplate
from app.repositories.base import BaseRepository


class InvoiceTemplateRepository(BaseRepository[InvoiceTemplate]):
    """
    Saved Invoice Template Builder rows. Listed newest-first by
    `updated_at` so the rail's most-recently-edited template sits at
    the top — same rhythm as ImportConfigRepository.
    """

    model = InvoiceTemplate

    async def list_recent(
        self, limit: int = 50, offset: int = 0
    ) -> list[InvoiceTemplate]:
        result = await self._session.execute(
            select(InvoiceTemplate)
            .order_by(InvoiceTemplate.updated_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())
