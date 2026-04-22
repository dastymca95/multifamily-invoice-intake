from sqlalchemy import select

from app.models.gl_catalog import GLCatalog
from app.repositories.base import BaseRepository


class GLCatalogRepository(BaseRepository[GLCatalog]):
    """
    Saved GL catalogs. Listed newest-first by `updated_at` so the rail's
    most-recently-edited catalog sits at the top — same rhythm as
    InvoiceTemplateRepository.
    """

    model = GLCatalog

    async def list_recent(
        self, limit: int = 50, offset: int = 0
    ) -> list[GLCatalog]:
        result = await self._session.execute(
            select(GLCatalog)
            .order_by(GLCatalog.updated_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())
