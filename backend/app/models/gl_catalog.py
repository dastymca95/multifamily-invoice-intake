"""
GLCatalog — a saved, named definition of a chart of accounts the user
maintains for ResMan invoice processing.

Mirrors `InvoiceTemplate` in shape and rhythm — same builder pattern,
same source-of-origin metadata, same JSONB-backed editable list. The
two are deliberately decoupled: an InvoiceTemplate defines the COLUMN
SHAPE of an invoice export; a GLCatalog defines the ROWS of a chart of
accounts (one per GL code) the user later validates / maps invoice
line-items against.

Each GLCatalog row stores:

  * `id`          — UUID (primary key, server-generated)
  * `name`        — user-facing label, e.g. "Operating Expenses 2026"
  * `description` — optional free text
  * `entries`     — ordered JSONB list of GL row dicts. Shape:
                    {id, code, description, category, active, notes}
                    (see the Pydantic schema for invariants).
  * `source`      — informational origin tag: "default" | "blank" |
                    "from_upload" | "custom". Stored as free text to
                    sidestep enum migrations when new origins land.
  * `created_by`  — soft FK (UUID) to the auth user; no DB constraint.
  * `created_at`, `updated_at` — from `TimestampMixin`.

Why JSONB on a single row instead of a child `gl_entries` table:
  * The catalog edits as one unit — the user opens it, edits multiple
    rows, saves once. We never query individual entries server-side
    yet (validation/mapping happen later, against a denormalized
    snapshot anyway).
  * Order matters and survives PATCH (we replace the array outright);
    JSONB preserves insertion order without an explicit `position`
    column.
  * Indexable later via PostgreSQL JSONB ops (e.g. find catalogs that
    contain code "5100") if/when that becomes useful.

Uploaded GL files are NOT persisted on this model. The frontend posts
an upload to a dedicated `parse-upload` endpoint that returns the
parsed entries; the user then creates a normal GLCatalog from those
entries with `source="from_upload"`. The original file isn't kept —
the catalog is the authoritative artifact, and uploads are just a
starting point that the user is expected to keep editing.

Future iterations (not in this phase):
  * Per-entry `parent_code` / hierarchy markers.
  * Used-by / referenced-by indexing once the export pipeline starts
    consuming catalogs.
  * Soft-delete + versioning so historical exports can pin a snapshot.
"""

import uuid

from sqlalchemy import String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class GLCatalog(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "gl_catalogs"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Ordered list of GL entry dicts. See module docstring + the
    # `GLCatalogEntry` Pydantic schema for the shape and invariants.
    entries: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )

    # Where this catalog was originally seeded — informational for the
    # UI. One of: "default" | "blank" | "from_upload" | "custom".
    source: Mapped[str] = mapped_column(
        String(32), nullable=False, default="custom", server_default="custom"
    )

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )

    def __repr__(self) -> str:
        return (
            f"<GLCatalog id={self.id} name={self.name!r} "
            f"entries={len(self.entries or [])}>"
        )
