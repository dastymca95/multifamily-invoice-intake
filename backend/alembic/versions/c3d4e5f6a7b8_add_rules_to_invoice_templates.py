"""add rules column to invoice_templates

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-04-23 00:00:00.000000

Layer 2 of the Import Builder model. The original table shipped with
just the column schema (`columns` JSONB); this revision adds the
sibling `rules` JSONB column that carries the rule-row layer
introduced by the rule-driven import composition phase.

We deliberately use `nullable=False` with a `server_default='[]'` so
existing rows get a real empty-list value on upgrade rather than
SQL NULL. The Pydantic schema uses `default_factory=list` for read,
which would tolerate either, but keeping the column NOT NULL means
the rest of the codebase can read `row.rules` without a None check.

Downgrade drops the column outright — anyone with rule data on a
downgraded environment loses it. That's the right call: the schema
that introduced rules is the one the application code depends on, so
downgrading necessarily means going back to a build that doesn't
understand the column at all.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, None] = 'b2c3d4e5f6a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'invoice_templates',
        sa.Column(
            'rules',
            postgresql.JSONB(astext_type=sa.Text()),
            server_default='[]',
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column('invoice_templates', 'rules')
