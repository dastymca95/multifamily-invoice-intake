"""
InvoiceTemplate — a saved, named definition for the Import Builder.

Carries TWO layers:

  * `columns` (Layer 1) — the column schema. Which columns exist, in
    what order, with what label, required flag, source binding,
    manual-list values, validation hints, and rule role
    (condition / restriction / action). See `app/schemas/invoice_template.py`
    for the full shape; the model just persists it as JSONB.

  * `rules` (Layer 2 — added in the rules phase) — ordered list of
    rule rows. Each rule has an id, an `is_active` flag, an optional
    `notes` string, and a `cells` dict keyed by column id. A rule's
    intent: when its condition cells match invoice context, its
    restriction cells narrow the matching universe and its action
    cells suggest values for the final import. The runtime that
    consumes rules is intentionally deferred — Phase 1 stores the
    model and the editing surface; the resolver lands incrementally.

Both `columns` and `rules` live in JSONB so we can extend the per-row
shape without a migration. Each layer carries its own bounded payload
caps (see `MAX_COLUMNS` / `MAX_RULES` in the schema module).

`source` is informational metadata for the frontend — "where did this
template originate?" It's not enforced by the model and there's no FK
to `reference_files`: a template that originated `from_upload` keeps
working even if the upload is later replaced.

Differs from ImportConfig (the older "Import Preview" preset model,
relocated to /import-preview):

  * **InvoiceTemplate** owns BOTH the column structure and the rule
    layer. The user edits this directly in the Import Builder.
  * **ImportConfig** owns ROLE OVERRIDES on top of an inferred column
    structure for the preview workspace.

Why not seed the canonical default in the DB on first request?
Because the default is a code-defined constant, not user data. Seeding
it would force a migration every time we tweak the canonical shape.
Instead the API exposes the default via a dedicated endpoint and the
frontend uses it as an unsaved-draft starting point — saving promotes
the draft to a real row whose columns and rules are then independent
of the constant.
"""

import uuid

from sqlalchemy import String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class InvoiceTemplate(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "invoice_templates"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Ordered list of column dicts. See module docstring for the shape.
    # JSONB so we can index/inspect later if we need to (e.g. "find every
    # template that includes a column named 'GL Account'").
    columns: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )

    # Ordered list of rule rows. JSONB for the same reasons as `columns`:
    # we want the per-row shape to be extensible without forcing a
    # migration every time we add a rule attribute. Server default `[]`
    # so legacy rows (created before this column existed) materialize
    # as "no rules" rather than null on read.
    rules: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )

    # How this template was originally seeded — informational for the UI.
    # One of: "default" | "blank" | "from_upload" | "custom". Stored as
    # a free-text column rather than an enum so adding new origins later
    # doesn't need a DB migration.
    source: Mapped[str] = mapped_column(
        String(32), nullable=False, default="custom", server_default="custom"
    )

    # Soft FK — captures who created the template for audit but no
    # constraint to the auth user table.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )

    def __repr__(self) -> str:
        return (
            f"<InvoiceTemplate id={self.id} name={self.name!r} "
            f"cols={len(self.columns or [])} "
            f"rules={len(self.rules or [])}>"
        )
