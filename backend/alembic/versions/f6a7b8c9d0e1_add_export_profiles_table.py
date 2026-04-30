"""add export_profiles table

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-04-29 00:00:00.000000

Phase 4A — persisted export profile foundation. Adds the
``export_profiles`` table so future export workflows can reference a
stable saved profile id instead of inlining the full profile shape
on every call.

The ``settings`` and ``columns`` payloads are JSONB so the per-row
shape can extend (mirroring ``invoice_templates``) without forcing a
migration each time the Pydantic ``ExportProfile`` contract grows.

Phase 4A contract:

  * Diagnostic only — this table holds catalog rows, never export
    runs / batches / file artefacts.
  * No FK to documents / batches / templates / users.
  * Indexes added on ``target_system`` and ``is_active`` because the
    list endpoint filters on both. Name index added too because the
    catalog list rail surfaces names alphabetically.

Downgrade drops the table outright. Profiles are pure metadata —
there is nothing else in the schema that references them in this
phase.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "export_profiles",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("target_system", sa.String(length=32), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "settings",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "columns",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column(
            "is_active",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column(
            "is_default",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "version",
            sa.Integer(),
            server_default="1",
            nullable=False,
        ),
        sa.Column(
            "source",
            sa.String(length=32),
            server_default="manual",
            nullable=False,
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("updated_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    # Targeted indexes — the list endpoint filters by ``is_active``
    # and ``target_system`` and orders by ``updated_at``. Name index
    # is cheap and supports a future "search by name" filter.
    op.create_index(
        "ix_export_profiles_target_system",
        "export_profiles",
        ["target_system"],
    )
    op.create_index(
        "ix_export_profiles_is_active",
        "export_profiles",
        ["is_active"],
    )
    op.create_index(
        "ix_export_profiles_name",
        "export_profiles",
        ["name"],
    )


def downgrade() -> None:
    op.drop_index("ix_export_profiles_name", table_name="export_profiles")
    op.drop_index(
        "ix_export_profiles_is_active", table_name="export_profiles"
    )
    op.drop_index(
        "ix_export_profiles_target_system", table_name="export_profiles"
    )
    op.drop_table("export_profiles")
