"""
PropertyCatalog — a saved, named definition of a property master table
the user maintains for ResMan invoice processing.

Mirrors `GLCatalog` and `InvoiceTemplate` in shape and rhythm — same
builder pattern, same source-of-origin metadata, same JSONB-backed
editable list. The three are deliberately decoupled:

  * InvoiceTemplate defines the COLUMN SHAPE of an invoice export.
  * GLCatalog defines the ROWS of a chart of accounts.
  * PropertyCatalog defines the ROWS of a property/unit master table
    that powers later property validation, abbreviation lookup, address
    lookup, and unit lookup.

Each PropertyCatalog row stores:

  * `id`          — UUID (primary key, server-generated).
  * `name`        — user-facing label, e.g. "Multifamily Portfolio 2026".
  * `description` — optional free text.
  * `entries`     — ordered JSONB list of property/unit row dicts. Shape:
                    {id, property_name, property_code, property_abbreviation,
                     address, city, state, zip, unit_number, unit_type,
                     building, active, notes}
                    (see the Pydantic schema for invariants).
  * `source`      — informational origin tag: "default" | "blank" |
                    "from_upload" | "custom". Stored as free text to
                    sidestep enum migrations when new origins land.
  * `created_by`  — soft FK (UUID) to the auth user; no DB constraint.
  * `created_at`, `updated_at` — from `TimestampMixin`.

Why JSONB on a single row instead of a child `property_entries` table:
  * The catalog edits as one unit — the user opens it, edits multiple
    rows, saves once. We never query individual entries server-side
    yet (validation/mapping happen later, against a denormalized
    snapshot anyway).
  * Order matters and survives PATCH (we replace the array outright);
    JSONB preserves insertion order without an explicit `position`
    column.
  * Indexable later via PostgreSQL JSONB ops if/when "find catalogs
    that contain property code X" becomes useful.

Uploaded property files are NOT persisted on this model. The frontend
posts each file (one or many) to a dedicated `parse-upload` endpoint
that returns the source columns + rows + a suggested canonical-field
mapping; the user then runs an explicit per-file mapping step in the
client and creates a normal PropertyCatalog from the merged canonical
rows with `source="from_upload"`. The original files aren't kept — the
catalog is the authoritative artifact.

Future iterations (not in this phase):
  * Per-entry parent-child relationships (parent property → child units).
  * Cross-catalog uniqueness for property codes (today: per-catalog only).
  * Used-by / referenced-by indexing once invoice validation starts
    consuming property catalogs.
  * Soft-delete + versioning so historical exports can pin a snapshot.
"""

import uuid

from sqlalchemy import String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class PropertyCatalog(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "property_catalogs"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Ordered list of property/unit entry dicts. See module docstring +
    # the `PropertyEntry` Pydantic schema for the shape and invariants.
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
            f"<PropertyCatalog id={self.id} name={self.name!r} "
            f"entries={len(self.entries or [])}>"
        )
