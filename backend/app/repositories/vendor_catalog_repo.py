from sqlalchemy import select

from app.models.vendor_catalog import VendorCatalog
from app.repositories.base import BaseRepository


class VendorCatalogRepository(BaseRepository[VendorCatalog]):
    """
    Saved vendor catalogs. Listed newest-first by `updated_at` so the
    rail's most-recently-edited catalog sits at the top — same rhythm
    as `GLCatalogRepository` / `PropertyCatalogRepository`.
    """

    model = VendorCatalog

    async def list_recent(
        self, limit: int = 50, offset: int = 0
    ) -> list[VendorCatalog]:
        result = await self._session.execute(
            select(VendorCatalog)
            .order_by(VendorCatalog.updated_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())
