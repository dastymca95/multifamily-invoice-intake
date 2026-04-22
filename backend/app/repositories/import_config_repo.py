from sqlalchemy import select

from app.models.import_config import ImportConfig
from app.repositories.base import BaseRepository


class ImportConfigRepository(BaseRepository[ImportConfig]):
    """
    Saved Import Builder presets. Listed newest-first by `updated_at`
    so the rail's most-recently-edited config sits at the top — that's
    what the user is most likely to be working on.
    """

    model = ImportConfig

    async def list_recent(
        self, limit: int = 50, offset: int = 0
    ) -> list[ImportConfig]:
        result = await self._session.execute(
            select(ImportConfig)
            .order_by(ImportConfig.updated_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())
