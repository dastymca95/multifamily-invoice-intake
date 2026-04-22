"""
ReferenceFile — single row per reference-data kind.

This is the storage backing the Reference Data workspace where the user
uploads the four ResMan inputs that the eventual export pipeline will need
to consult:

  * properties        — ResMan property report
  * units             — ResMan unit report
  * vendors           — ResMan vendor report
  * import_template   — ResMan default invoice import template

The (kind) column has a UNIQUE constraint because the workspace is a
"current state of the world" surface, not a history log: re-uploading
properties replaces the previous properties file. The repository handles
the storage-key swap; the DB row is updated in place.

Future iterations (matching engine, ResMan-shaped export) will read from
this table — `parsed_columns` and `sample_rows` are stored as JSONB so
the matching layer can compare detected headers against the canonical
invoice fields without re-parsing the file on every request.
"""

import uuid

from sqlalchemy import BigInteger, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class ReferenceFile(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "reference_files"

    # Discriminator. Values constrained at the API/schema layer rather than
    # via a DB enum so adding a new kind later doesn't require a migration.
    # See `app.domain.reference_parse.REFERENCE_KINDS` for the canonical
    # list and labels.
    kind: Mapped[str] = mapped_column(String(32), nullable=False)

    # Originals (preserved for the audit trail and for re-download).
    original_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(1024), nullable=False, unique=True)
    mime_type: Mapped[str] = mapped_column(String(127), nullable=False)
    file_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    checksum_sha256: Mapped[str] = mapped_column(String(64), nullable=False)

    # Parser output. `parse_status` is the source of truth for the UI badge:
    #   parsed       — header + row count + sample extracted cleanly
    #   parse_failed — extraction raised; `parse_error` carries the message
    parse_status: Mapped[str] = mapped_column(String(32), nullable=False, default="parsed")
    parse_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Detected header row, in source order. List of stripped strings.
    parsed_columns: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # Total data rows (excluding the header). Null if the parser couldn't
    # determine it (e.g. unreadable file).
    parsed_row_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # First few data rows as list[dict[str, str]] for quick UI inspection.
    # We don't store the whole sheet in JSONB — that's what storage is for.
    sample_rows: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # User who last uploaded this kind. Soft FK (string) to keep the model
    # decoupled from the auth Users table the JWT comes from.
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    __table_args__ = (
        # One current file per kind. Re-uploading the same kind overwrites
        # the existing row (the repository handles the storage swap).
        UniqueConstraint("kind", name="uq_reference_files_kind"),
    )

    def __repr__(self) -> str:
        return (
            f"<ReferenceFile kind={self.kind!r} "
            f"file={self.original_filename!r} status={self.parse_status}>"
        )
