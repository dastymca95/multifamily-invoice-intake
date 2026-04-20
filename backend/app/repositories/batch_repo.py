from uuid import UUID

from sqlalchemy import select, update

from app.models.batch import Batch
from app.repositories.base import BaseRepository


class BatchRepository(BaseRepository[Batch]):
    model = Batch

    async def get_by_user(self, user_id: UUID, limit: int = 50, offset: int = 0) -> list[Batch]:
        result = await self._session.execute(
            select(Batch)
            .where(Batch.created_by == user_id)
            .order_by(Batch.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())

    async def increment_counter(self, batch_id: UUID, field: str, delta: int = 1) -> None:
        col = getattr(Batch, field)
        await self._session.execute(
            update(Batch).where(Batch.id == batch_id).values({field: col + delta})
        )
