from uuid import UUID

from sqlalchemy import select

from app.models.extraction_run import ExtractionRun
from app.repositories.base import BaseRepository


class ExtractionRunRepository(BaseRepository[ExtractionRun]):
    model = ExtractionRun

    async def get_latest_for_document(self, document_id: UUID) -> ExtractionRun | None:
        result = await self._session.execute(
            select(ExtractionRun)
            .where(ExtractionRun.document_id == document_id)
            .order_by(ExtractionRun.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()
