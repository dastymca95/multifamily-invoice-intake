from sqlalchemy import select

from app.models.vendor_pattern import VendorPattern
from app.repositories.base import BaseRepository


class VendorPatternRepository(BaseRepository[VendorPattern]):
    model = VendorPattern

    async def get_by_vendor_name(self, normalized_name: str) -> VendorPattern | None:
        result = await self._session.execute(
            select(VendorPattern).where(
                VendorPattern.vendor_name_normalized == normalized_name
            )
        )
        return result.scalar_one_or_none()

    async def search(self, query: str, limit: int = 20) -> list[VendorPattern]:
        result = await self._session.execute(
            select(VendorPattern)
            .where(VendorPattern.vendor_name_normalized.ilike(f"%{query}%"))
            .order_by(VendorPattern.confidence_score.desc())
            .limit(limit)
        )
        return list(result.scalars().all())
