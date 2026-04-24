"""add field_definitions to invoice_patterns

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-04-24 00:00:00.000000

Extends `invoice_patterns` with a `field_definitions` JSONB column —
the operator-edited extraction-field universe for the pattern:

  * Each item is `{key, label, type, color, hidden}`.
  * `type = "built_in"` rows OVERRIDE the system canonical field of the
    same key (color, label, or hidden flag). Absence means "use the
    system default".
  * `type = "custom"` rows ARE the source of truth for an operator-
    created extraction field (e.g. "Service Address") that doesn't
    exist on the canonical `Invoice` model.

The list defaults to `'[]'` so every existing row materializes as "no
custom fields, no built-in overrides" — i.e. exactly the pre-feature
behavior. No data migration needed; the column reads cleanly on every
existing row.

Downgrade drops the column. Operators lose any custom fields and color
overrides on a downgrade — that's the right call because the
application code that reads `field_definitions` is the one this
revision introduces. Existing region.field_key values referencing
canonical fields keep working post-downgrade since they validate
against the legacy `InvoiceExtractedField` Literal too.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'e5f6a7b8c9d0'
down_revision: Union[str, None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'invoice_patterns',
        sa.Column(
            'field_definitions',
            postgresql.JSONB(astext_type=sa.Text()),
            server_default='[]',
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column('invoice_patterns', 'field_definitions')
