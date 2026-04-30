"""add export run approval fields

Revision ID: b7c8d9e0f1a2
Revises: a7b8c9d0e1f2
Create Date: 2026-04-29 00:00:00.000000

Phase 6A — export run approval workflow foundation. Adds the
approval-state columns to ``export_runs`` so a persisted draft /
audit record can carry workflow metadata (request → approve /
reject) without touching the existing notes-only PATCH surface.

Phase 6A contract — even when ``approval_status`` is
``"approved_for_file_generation"``:

  * ``phase`` remains ``"draft"`` (Phase 5A lock holds).
  * ``draft_snapshot.finalized`` / ``file_generated`` /
    ``download_available`` / ``production_export_ready`` remain
    false (Phase 4F hard pins hold).
  * No file is generated, no download URL issued, no document /
    batch / template mutated, no external system contacted, no
    export batch created.
  * The persistence layer NEVER adds ``finalized_at`` /
    ``exported_at`` / ``file_id`` / ``file_url`` /
    ``download_url`` / ``posted_at`` / ``external_posting_id`` /
    ``external_system_id`` columns. The Phase 5E regression suite
    asserts the column set against the Phase 3O / 5E forbidden
    handle set.

Indexes:

  * ``approval_status`` — list endpoint will filter by it in a
    future surface.
  * ``approval_requested_at`` — supports a future "show pending
    review" admin query.

Downgrade drops the columns + indexes outright. Phase 6A is
purely additive on top of Phase 5A.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "b7c8d9e0f1a2"
down_revision: Union[str, None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "export_runs",
        sa.Column(
            "approval_status",
            sa.String(length=32),
            server_default="not_requested",
            nullable=False,
        ),
    )
    op.add_column(
        "export_runs",
        sa.Column(
            "approval_requested_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "export_runs",
        sa.Column(
            "approval_requested_by_user_id",
            sa.UUID(),
            nullable=True,
        ),
    )
    op.add_column(
        "export_runs",
        sa.Column(
            "approved_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "export_runs",
        sa.Column("approved_by_user_id", sa.UUID(), nullable=True),
    )
    op.add_column(
        "export_runs",
        sa.Column(
            "rejected_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "export_runs",
        sa.Column("rejected_by_user_id", sa.UUID(), nullable=True),
    )
    op.add_column(
        "export_runs",
        sa.Column("approval_notes", sa.Text(), nullable=True),
    )
    op.add_column(
        "export_runs",
        sa.Column("rejection_reason", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_export_runs_approval_status",
        "export_runs",
        ["approval_status"],
    )
    op.create_index(
        "ix_export_runs_approval_requested_at",
        "export_runs",
        ["approval_requested_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_export_runs_approval_requested_at",
        table_name="export_runs",
    )
    op.drop_index(
        "ix_export_runs_approval_status", table_name="export_runs"
    )
    op.drop_column("export_runs", "rejection_reason")
    op.drop_column("export_runs", "approval_notes")
    op.drop_column("export_runs", "rejected_by_user_id")
    op.drop_column("export_runs", "rejected_at")
    op.drop_column("export_runs", "approved_by_user_id")
    op.drop_column("export_runs", "approved_at")
    op.drop_column("export_runs", "approval_requested_by_user_id")
    op.drop_column("export_runs", "approval_requested_at")
    op.drop_column("export_runs", "approval_status")
