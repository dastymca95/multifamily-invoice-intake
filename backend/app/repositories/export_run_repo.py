"""
Phase 5A — ExportRunRepository.

Thin wrapper around ``BaseRepository`` for the persisted Export
Run draft / audit catalog. Adds a list method that filters by
``status`` / ``phase`` / ``source`` / ``export_profile_id`` /
``target_system`` / ``document_id`` / ``batch_id`` because the
listing endpoint exposes all seven as query params, and orders
by ``created_at`` newest-first by default.

No export side effects — this is a pure CRUD repository over the
``export_runs`` table. The management service layer enforces the
Phase 5A business rules (forbidden snapshot keys, hard-pin
preservation, status mapping, phase locking) BEFORE calling here.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select

from app.models.export_run import ExportRunRecord
from app.repositories.base import BaseRepository


class ExportRunRepository(BaseRepository[ExportRunRecord]):
    model = ExportRunRecord

    async def list_filtered(
        self,
        *,
        status: str | None = None,
        phase: str | None = "draft",
        source: str | None = None,
        export_profile_id: UUID | None = None,
        target_system: str | None = None,
        document_id: UUID | None = None,
        batch_id: UUID | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[ExportRunRecord]:
        """List records newest-first by ``created_at``.

        ``phase`` defaults to ``"draft"`` so the catalog UI doesn't
        need to remember to filter — Phase 5A only writes
        ``"draft"`` rows anyway, but the default keeps the contract
        sharp for any future phase. Pass ``phase=None`` to include
        rows of every phase.

        Every other filter is None == "no filter". The service
        layer narrows the closed Literal sets BEFORE calling here,
        so any caller-supplied value that reaches this method has
        already been validated.
        """
        stmt = select(ExportRunRecord)
        if status is not None:
            stmt = stmt.where(ExportRunRecord.status == status)
        if phase is not None:
            stmt = stmt.where(ExportRunRecord.phase == phase)
        if source is not None:
            stmt = stmt.where(ExportRunRecord.source == source)
        if export_profile_id is not None:
            stmt = stmt.where(
                ExportRunRecord.export_profile_id == export_profile_id
            )
        if target_system is not None:
            stmt = stmt.where(
                ExportRunRecord.target_system == target_system
            )
        if document_id is not None:
            stmt = stmt.where(
                ExportRunRecord.document_id == document_id
            )
        if batch_id is not None:
            stmt = stmt.where(ExportRunRecord.batch_id == batch_id)
        stmt = (
            stmt.order_by(ExportRunRecord.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        result = await self._session.execute(stmt)
        return list(result.scalars().all())
