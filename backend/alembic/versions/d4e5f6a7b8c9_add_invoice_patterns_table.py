"""add invoice_patterns table

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-04-23 00:00:01.000000

The Invoice Builder module's storage backbone. Sibling table to
`invoice_templates` (Import Builder), NOT a child or subtype — see
`app/models/invoice_pattern.py` for the design rationale.

`source_files` and `regions` are JSONB so the per-row shape can
evolve (page rotation, OCR confidence, multi-bbox-per-region,
object-storage refs replacing inline data URLs) without a migration
per change. Both default to `'[]'` so legacy rows without uploads or
annotations materialize as empty lists rather than NULL on read.

`vendor_hint` is intentionally a free-text column — no FK to
vendor_catalog. The pattern remains usable if the vendor row is
renamed / deleted, and the rule-cell layer is where we narrow per-
invoice extraction context anyway.

Downgrade drops the table outright. Anyone with patterns on a
downgraded environment loses them; that's the right call because
the application code that reads `invoice_patterns` is the one this
revision introduces.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'd4e5f6a7b8c9'
down_revision: Union[str, None] = 'c3d4e5f6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'invoice_patterns',
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('vendor_hint', sa.String(length=255), nullable=True),
        sa.Column(
            'source_files',
            postgresql.JSONB(astext_type=sa.Text()),
            server_default='[]',
            nullable=False,
        ),
        sa.Column(
            'regions',
            postgresql.JSONB(astext_type=sa.Text()),
            server_default='[]',
            nullable=False,
        ),
        sa.Column('created_by', sa.UUID(), nullable=True),
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    op.drop_table('invoice_patterns')
