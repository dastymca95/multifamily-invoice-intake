"""
VendorCatalog — a saved, named vendor master-data list the user maintains
for ResMan invoice processing.

Sibling of `GLCatalog` and `PropertyCatalog` — same builder pattern, same
source-of-origin metadata, same JSONB-backed editable list. The three
form a coherent Reference Data trio:

  * `InvoiceTemplate` — column shape of an invoice export.
  * `GLCatalog`       — chart-of-accounts rows.
  * `PropertyCatalog` — property/unit master rows.
  * `VendorCatalog`   — vendor master rows.

Each VendorCatalog row stores:

  * `id`          — UUID (primary key, server-generated)
  * `name`        — user-facing label, e.g. "Active Vendors 2026"
  * `description` — optional free text
  * `entries`     — ordered JSONB list of vendor row dicts. Shape:
                    {id, vendor_name, vendor_code, aliases,
                     address, city, state, zip,
                     contact_name, email, phone, active, notes}
                    See the Pydantic schema for invariants.
  * `source`      — informational origin tag: "default" | "blank" |
                    "from_upload" | "custom". Stored as free text so
                    new origins land without a DB migration.
  * `created_by`  — soft FK (UUID) to the auth user; no DB constraint.
  * `created_at`, `updated_at` — from `TimestampMixin`.

Distinct from `VendorPattern`:

  * `VendorPattern` is a learned-extraction artifact — confidence /
    field-hint state per vendor name observed in extracted invoices.
    It's a side-effect of the extraction pipeline.
  * `VendorCatalog` is user-authored master data — the CANONICAL list
    of vendors the user maintains, with names, aliases, addresses,
    contact info, and active flags. It exists independently of any
    extraction having ever happened.

The two are deliberately separate. Vendor patterns describe what we've
SEEN; vendor catalogs describe what we KNOW. A future name-matching
workflow will resolve extracted invoice payees against vendor catalog
rows (using `vendor_name` + `aliases` as the match surface) — but that
matching logic isn't implemented yet, and shouldn't be until the
catalog is the canonical source the user actively edits.

Why JSONB on a single row instead of a child `vendor_entries` table:
  * The catalog edits as one unit — open, edit many rows, save once.
  * Order matters and survives PATCH (we replace the array outright).
  * Indexable later via PostgreSQL JSONB ops if/when we add server-side
    queries (e.g. find vendor by alias).

Uploaded vendor files are NOT persisted on this model. The frontend
posts an upload to a dedicated `parse-upload` endpoint that returns the
parsed rows + a suggested column mapping; the user runs an explicit
mapping step, then creates a normal VendorCatalog from the resulting
canonical entries with `source="from_upload"`. The original file isn't
kept — the catalog is the authoritative artifact.

Future iterations (NOT in this phase):
  * Per-row remit-to address vs physical address.
  * Tax-ID / W-9 status indicators.
  * Vendor-class / 1099 flags.
  * Soft-delete + versioning so historical exports can pin a snapshot.
  * Server-side alias-index for fuzzy name matching.
"""

import uuid

from sqlalchemy import String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class VendorCatalog(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "vendor_catalogs"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Ordered list of vendor entry dicts. See module docstring + the
    # `VendorCatalogEntry` Pydantic schema for the shape and invariants.
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
            f"<VendorCatalog id={self.id} name={self.name!r} "
            f"entries={len(self.entries or [])}>"
        )
