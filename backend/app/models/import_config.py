"""
ImportConfig — a saved, named ResMan-import design preset.

The Import Builder workspace lets a user "design" how the future
ResMan-ready import file should look (which template column maps to
which logical role, etc.) and persist that design under a name so it
can be reopened and edited later. Each row of this table is one such
saved design.

Design notes:
  * The row stores ONLY the user's overrides on top of what the
    ReferenceFile + auto-classifier already provide. We do not snapshot
    the template's columns themselves — when the import_template
    reference file changes, the saved overrides apply by column NAME
    (orphaned override keys silently stop applying). This is the right
    behaviour for "preset that follows the canonical template".
  * `column_role_overrides` is a JSONB dict of `{column_name: role_str}`.
    Validation of the role string lives at the API/schema layer
    (Literal[...]) so we don't need a DB enum migration when a new
    role is added in the domain layer.
  * `created_by` is a soft FK (no constraint) for the same reason as
    on ReferenceFile — keeps the model decoupled from the auth schema.
  * No FK to reference_files: the config is conceptually a per-user
    saved view, not an extension of any one file. It composes WITH
    whatever reference files happen to be uploaded at preview time.

Future iterations (not in this phase):
  * Per-column static values ("always emit USD"), versioned snapshots,
    sharing across users, default config per workspace.
"""

import uuid

from sqlalchemy import Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class ImportConfig(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "import_configs"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Per-column role overrides. Keys are template column names
    # (verbatim, as captured from the import_template's parsed_columns
    # at edit time); values are role strings drawn from
    # `app.domain.resman_preview.ColumnRole`. The auto-classifier still
    # runs as the default — this dict only captures the user's manual
    # corrections.
    column_role_overrides: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )

    # How many preview rows to render against this config. Bounded by
    # the API; persisted so the user's choice survives reload.
    row_limit: Mapped[int] = mapped_column(
        Integer, nullable=False, default=8, server_default="8"
    )

    # Soft FK — captures who created the config for audit but no
    # constraint to the auth user table.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )

    def __repr__(self) -> str:
        return f"<ImportConfig id={self.id} name={self.name!r}>"
