"""
InvoiceTemplate — a saved, named definition of the column shape for a
ResMan invoice import.

Differs from ImportConfig (the existing "Import Builder preset" model)
in scope:

  * **InvoiceTemplate** owns the COLUMN STRUCTURE itself — which
    columns exist, what they're called, what order they're in. The
    user edits this directly in the Invoice Template Builder.
  * **ImportConfig** owns ROLE OVERRIDES on top of an inferred column
    structure (today: derived from the uploaded ResMan template's
    parsed_columns; eventually: derived from a chosen InvoiceTemplate).

The two models are deliberately decoupled. InvoiceTemplate stores
columns as an ordered JSONB list of `{id, name, source_column}` objects:

  * `id`             — UUID-ish stable key. Survives renames + reorders
                       so the frontend can use it as a React key without
                       generating one client-side. The backend doesn't
                       look at the value beyond uniqueness within the
                       row.
  * `name`           — display header (e.g. "Invoice Number"). The
                       string the user actually sees and renames.
  * `source_column`  — optional pointer back to the original ResMan
                       template column name when the template was
                       created `from_upload`. Lets a future export step
                       know "this user-named column maps to that
                       upload column" without re-doing classification.
                       Null for blank/default-derived columns.

`source` is informational metadata for the frontend — "where did this
template originate?" It's not enforced by the model and there's no FK
to `reference_files`: a template that originated `from_upload` keeps
working even if the upload is later replaced.

Why not just persist the canonical default in the DB on first request?
Because the default is a code-defined constant, not user data. Seeding
it would force a migration every time we tweak the canonical shape.
Instead the API exposes the default via a dedicated endpoint and the
frontend uses it as an unsaved-draft starting point — saving promotes
the draft to a real row whose columns are then independent of the
constant.

Future iterations (not in this phase):
  * Per-column `data_type` / `required` / `default_value`.
  * Soft-delete / versioning so an "archived" template can still be
    referenced by historic exports.
  * Sharing across users; default-template-per-workspace.
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
            f"cols={len(self.columns or [])}>"
        )
