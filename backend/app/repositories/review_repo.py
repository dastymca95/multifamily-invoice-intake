from uuid import UUID

from sqlalchemy import select

from app.models.review_event import ReviewEvent
from app.repositories.base import BaseRepository


class ReviewRepository(BaseRepository[ReviewEvent]):
    model = ReviewEvent

    async def get_for_invoice(self, invoice_id: UUID) -> list[ReviewEvent]:
        result = await self._session.execute(
            select(ReviewEvent)
            .where(ReviewEvent.invoice_id == invoice_id)
            .order_by(ReviewEvent.created_at.asc())
        )
        return list(result.scalars().all())
