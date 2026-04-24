from sqlalchemy import select

from app.models.property_catalog import PropertyCatalog
from app.repositories.base import BaseRepository


class PropertyCatalogRepository(BaseRepository[PropertyCatalog]):
    """
    Saved property catalogs. Listed newest-first by `updated_at` so the
    rail's most-recently-edited catalog sits at the top — same rhythm as
    GLCatalogRepository and InvoiceTemplateRepository.
    """

    model = PropertyCatalog

    async def list_recent(
        self, limit: int = 50, offset: int = 0
    ) -> list[PropertyCatalog]:
        result = await self._session.execute(
            select(PropertyCatalog)
            .order_by(PropertyCatalog.updated_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())
