"""add export_runs table

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-04-29 00:00:00.000000

Phase 5A — persisted export run draft / audit foundation. Adds the
``export_runs`` table so an operator (or a future caller) can keep
the verdict from the diagnostic Phase 4F draft endpoint as an
audit row instead of recomputing it on every paste.

The ``draft_snapshot`` and ``request_snapshot`` payloads are JSONB
so the per-row shape can extend (mirrors ``export_profiles``)
without forcing a migration each time the Pydantic
``ExportRunDraft`` contract grows.

Phase 5A contract — every row written through this table:

  * Has ``phase="draft"``. Future phases (``approved`` /
    ``finalized``) land BEHIND explicit export-engine work; the
    persistence service rejects any other value today.
  * Carries an ``id`` that is the DRAFT / AUDIT record id. It is
    NOT a finalized export id, NOT a file id, NOT proof of
    export, and does NOT imply document / batch / template /
    external-system mutation.
  * NEVER contains ``file_id`` / ``file_url`` / ``download_url`` /
    ``export_id`` / ``export_run_id`` / ``export_batch_id`` /
    ``posted_at`` / ``external_posting_id`` / ``finalized_at`` /
    ``exported_at``. The columns are absent at the schema level
    so a forward-compat regression cannot accidentally add them.

Indexes:

  * ``status`` and ``phase`` — list endpoint filters.
  * ``source`` — list endpoint filter (operational_preview vs.
    api vs. manual).
  * ``export_profile_id`` — "show me every draft for this profile"
    audit query.
  * ``target_system`` — "show me every draft for ResMan / Yardi".
  * ``document_id`` and ``batch_id`` — operator-side audit.
  * ``created_at`` — list endpoint orders newest-first by default.

Downgrade drops the table outright. Phase 5A is purely additive —
nothing else in the schema references this table yet.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, None] = "f6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "export_runs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column(
            "phase",
            sa.String(length=32),
            server_default="draft",
            nullable=False,
        ),
        sa.Column(
            "source",
            sa.String(length=32),
            server_default="operational_preview",
            nullable=False,
        ),
        sa.Column("export_profile_id", sa.UUID(), nullable=True),
        sa.Column(
            "export_profile_name", sa.String(length=255), nullable=True
        ),
        sa.Column("export_profile_version", sa.Integer(), nullable=True),
        sa.Column("template_id", sa.UUID(), nullable=True),
        sa.Column("document_id", sa.UUID(), nullable=True),
        sa.Column("batch_id", sa.UUID(), nullable=True),
        sa.Column("target_system", sa.String(length=32), nullable=True),
        sa.Column(
            "row_count",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column(
            "blocked_row_count",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column(
            "warning_row_count",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column(
            "issue_count",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column(
            "draft_snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "request_snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
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
    # Targeted indexes — keyed off the list-endpoint filter set so
    # the catalog read paths stay sub-millisecond once volume grows.
    op.create_index(
        "ix_export_runs_status", "export_runs", ["status"]
    )
    op.create_index(
        "ix_export_runs_phase", "export_runs", ["phase"]
    )
    op.create_index(
        "ix_export_runs_source", "export_runs", ["source"]
    )
    op.create_index(
        "ix_export_runs_export_profile_id",
        "export_runs",
        ["export_profile_id"],
    )
    op.create_index(
        "ix_export_runs_target_system",
        "export_runs",
        ["target_system"],
    )
    op.create_index(
        "ix_export_runs_document_id", "export_runs", ["document_id"]
    )
    op.create_index(
        "ix_export_runs_batch_id", "export_runs", ["batch_id"]
    )
    op.create_index(
        "ix_export_runs_created_at", "export_runs", ["created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_export_runs_created_at", table_name="export_runs")
    op.drop_index("ix_export_runs_batch_id", table_name="export_runs")
    op.drop_index("ix_export_runs_document_id", table_name="export_runs")
    op.drop_index(
        "ix_export_runs_target_system", table_name="export_runs"
    )
    op.drop_index(
        "ix_export_runs_export_profile_id", table_name="export_runs"
    )
    op.drop_index("ix_export_runs_source", table_name="export_runs")
    op.drop_index("ix_export_runs_phase", table_name="export_runs")
    op.drop_index("ix_export_runs_status", table_name="export_runs")
    op.drop_table("export_runs")
