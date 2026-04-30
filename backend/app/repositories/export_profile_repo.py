"""
Phase 4A — ExportProfileRepository.

Thin wrapper around ``BaseRepository`` for the persisted export
profile catalog. Adds a list method that filters by
``target_system`` and ``is_active`` because the listing endpoint
exposes both as query params, and orders by ``updated_at`` newest
first to match the convention used by ``InvoiceTemplateRepository``.

No export side effects — this is a pure CRUD repository over the
``export_profiles`` table. The management service layer enforces
validation rules (target system enum, column key uniqueness, etc.)
before calling into here.
"""

from __future__ import annotations

from sqlalchemy import select

from app.models.export_profile import ExportProfileRecord
from app.repositories.base import BaseRepository


class ExportProfileRepository(BaseRepository[ExportProfileRecord]):
    model = ExportProfileRecord

    async def list_filtered(
        self,
        *,
        target_system: str | None = None,
        is_active: bool | None = True,
        limit: int = 50,
        offset: int = 0,
    ) -> list[ExportProfileRecord]:
        """List profiles newest-first by ``updated_at``.

        ``is_active`` defaults to ``True`` so the catalog UI doesn't
        have to remember to filter out soft-deleted rows. Pass
        ``is_active=None`` to include both active and inactive
        rows (used by tests + admin paths).

        ``target_system`` is an exact string match — None means
        "no filter". The service layer narrows the value to the
        Phase 3I closed Literal set BEFORE calling here.
        """
        stmt = select(ExportProfileRecord)
        if target_system is not None:
            stmt = stmt.where(
                ExportProfileRecord.target_system == target_system
            )
        if is_active is not None:
            stmt = stmt.where(ExportProfileRecord.is_active == is_active)
        stmt = (
            stmt.order_by(ExportProfileRecord.updated_at.desc())
            .limit(limit)
            .offset(offset)
        )
        result = await self._session.execute(stmt)
        return list(result.scalars().all())

    async def list_defaults_for_target_system(
        self, target_system: str
    ) -> list[ExportProfileRecord]:
        """Return every active row currently flagged as default for
        the given target system. Used by the management service to
        enforce "at most one default per target system" on the
        ``is_default`` flip.
        """
        stmt = select(ExportProfileRecord).where(
            ExportProfileRecord.target_system == target_system,
            ExportProfileRecord.is_default.is_(True),
            ExportProfileRecord.is_active.is_(True),
        )
        result = await self._session.execute(stmt)
        return list(result.scalars().all())
