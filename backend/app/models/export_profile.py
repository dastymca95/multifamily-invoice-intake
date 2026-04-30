"""
ExportProfileRecord — Phase 4A persisted export profile.

Persisted catalog of operator-defined export profiles (target system
+ settings + columns). Created so future export workflows can
reference a stable saved profile id instead of inlining the full
profile shape on every call.

Phase 4A guarantees:

  * **Diagnostic only** — no export engine, no file generation,
    no export run / batch / audit table, no external posting.
  * The Pydantic ``ExportProfile`` validation contract from Phase
    3I remains the source of truth for profile shape; this model
    persists ``settings`` and ``columns`` as JSONB to avoid
    premature schema churn.
  * No FK to documents / batches / templates — profiles are
    catalog-style metadata, not records of an export.
  * No FK to a user table — ``created_by_user_id`` /
    ``updated_by_user_id`` are soft FKs (nullable UUID columns)
    matching the existing project convention (see
    ``InvoiceTemplate.created_by``).

Why ``ExportProfileRecord`` (not ``ExportProfile``):

  * The Pydantic ``ExportProfile`` already exists in
    ``app.schemas.export_profile`` for validation. Reusing the
    name for the SQLAlchemy model would force readers to
    constantly disambiguate. The DB row is the persisted RECORD;
    the Pydantic class is the wire CONTRACT.
"""

import uuid

from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class ExportProfileRecord(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "export_profiles"

    name: Mapped[str] = mapped_column(String(255), nullable=False)

    # Free-text in the column so future target systems land without
    # a migration. The service layer enforces the closed Literal set
    # (``custom_csv`` / ``resman`` / ``yardi`` / ``appfolio``) on
    # create / update.
    target_system: Mapped[str] = mapped_column(
        String(32), nullable=False
    )

    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # JSONB so we can extend ``ExportProfileSettings`` /
    # ``ExportProfileColumn`` without a migration. Pydantic still
    # validates the shape on the way in via the management service.
    settings: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    columns: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )

    # Soft-delete flag — Phase 4A prefers deactivation over hard
    # delete so a future export run audit row can still reference
    # the profile that produced it. The CRUD endpoint defaults to
    # filtering inactive rows out.
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )

    # Default profile per target system. Phase 4A does NOT enforce
    # uniqueness of ``is_default=True`` in the DB — the management
    # service enforces "at most one default per target_system" so
    # the rule can be relaxed later without a migration.
    is_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # Bumped by the management service on settings / columns
    # updates. Metadata-only updates (name, description, notes,
    # is_active flip, is_default flip) leave the version untouched —
    # see the service layer for the documented behaviour.
    version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )

    # How this profile entered the catalog. Free text for the same
    # forward-compat reason as ``target_system``. Today: "manual" |
    # "built_in_seed" | "imported".
    source: Mapped[str] = mapped_column(
        String(32), nullable=False, default="manual", server_default="manual"
    )

    # Operator-only notes (paste-into-Slack-friendly).
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Soft FKs — capture the actor without constraining to the auth
    # user table. Same pattern as ``InvoiceTemplate.created_by``.
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )

    def __repr__(self) -> str:
        return (
            f"<ExportProfileRecord id={self.id} name={self.name!r} "
            f"target={self.target_system!r} v{self.version} "
            f"active={self.is_active}>"
        )
