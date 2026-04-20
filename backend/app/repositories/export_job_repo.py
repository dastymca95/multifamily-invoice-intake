from uuid import UUID

from sqlalchemy import select

from app.models.export_job import ExportJob
from app.repositories.base import BaseRepository


class ExportJobRepository(BaseRepository[ExportJob]):
    model = ExportJob

    async def get_by_user(self, user_id: UUID, limit: int = 50) -> list[ExportJob]:
        result = await self._session.execute(
            select(ExportJob)
            .where(ExportJob.requested_by == user_id)
            .order_by(ExportJob.created_at.desc())
            .limit(limit)
        )
        return list(result.scalars().all())
