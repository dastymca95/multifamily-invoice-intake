from sqlalchemy import select

from app.models.reference_file import ReferenceFile
from app.repositories.base import BaseRepository


class ReferenceFileRepository(BaseRepository[ReferenceFile]):
    """
    Single-row-per-kind store. The (kind) column has a UNIQUE constraint;
    callers should `get_by_kind` and update in place rather than creating
    a new row.
    """

    model = ReferenceFile

    async def get_by_kind(self, kind: str) -> ReferenceFile | None:
        result = await self._session.execute(
            select(ReferenceFile).where(ReferenceFile.kind == kind)
        )
        return result.scalar_one_or_none()

    async def list_all(self) -> list[ReferenceFile]:
        """Return every stored reference row (at most 4 today)."""
        result = await self._session.execute(select(ReferenceFile))
        return list(result.scalars().all())
