"""
InvoicePattern — a saved, named visual extraction template for the
new Invoice Builder module.

This is intentionally a SIBLING concept to `InvoiceTemplate` (the
Import Builder's column/rule schema), NOT a subtype:

  * **InvoiceTemplate** describes the OUTPUT schema for the import
    pipeline — which columns the user wants in their final spreadsheet,
    what binding each column has, what rules adjust which cells.
  * **InvoicePattern** describes WHERE on a real bill/invoice the
    canonical extracted fields physically live — bbox-on-page
    annotations on user-uploaded training documents (e.g. an "EPB
    Utility Bill" pattern that knows the account number sits at
    {x: 0.65, y: 0.18} on page 1).

The Import Builder integration: rule rows on `invoice_field` columns
can OPTIONALLY reference a saved pattern + a canonical field
(`{ pattern_id, field_key }`) to narrow extraction context. With no
rule cell set, extraction falls back to the broad universe of all
saved patterns + OCR + AI inference. This lives in the rule-cell
schema (see `app/schemas/invoice_template.py`); the pattern row
itself doesn't know which Import Builder rules reference it.

Why JSONB for `source_files` and `regions`:
  * The shape evolves quickly (we'll add page rotation, OCR
    confidence, multi-bbox-per-region, etc.) and we don't want a
    migration per shape change.
  * Both lists are bounded (a pattern is a few training docs at
    most, a few dozen regions at most) so we don't need separate
    rows + indexes.
  * Region records reference `source_file_id` (the file's id within
    the same pattern row) — an integrity invariant the application
    layer enforces. A separate `pattern_source_files` table would
    have given us a real FK but at the cost of three queries to
    materialize one pattern; not worth it.

Storage of uploaded training docs: the prototype carries the file
inline as a base64 data URL inside `source_files[i].data_url`, capped
to a few MB per file. When we move to production we swap the data
URL for an object-storage key without touching the rest of the model.
The shape stays the same.

`vendor_hint` is purely informational — a free-text "this pattern
is meant for EPB / Comcast / Tennessee American Water" label so the
operator can recognize patterns at a glance. No FK to vendor_catalog;
the same pattern row keeps working even if the vendor row is renamed
or deleted.

`created_by` is a soft FK (no constraint) — same audit-only contract
as the rest of the user-authored builder rows.
"""

import uuid

from sqlalchemy import String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class InvoicePattern(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "invoice_patterns"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Optional free-text recognition hint, e.g. "EPB Utility Bill" or
    # "Comcast Business Internet" — not a FK to vendor_catalog because
    # the pattern remains usable even if the vendor row is renamed or
    # deleted, and because vendor binding is stronger than what the UI
    # surface needs at the pattern level (the rule-cell layer is where
    # we narrow per-invoice extraction context).
    vendor_hint: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Uploaded training docs the operator drew regions on. Each item is
    # an `InvoicePatternSourceFile` dict — see schemas. JSONB so we can
    # add per-file metadata (page count, rotation, OCR confidence)
    # without a migration. Server default `[]` so legacy rows without
    # any uploads materialize as "empty file list" on read.
    source_files: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )

    # Region annotations — bbox-on-page assignments mapping a sub-area
    # of one source file to one canonical extracted field. Each item is
    # an `InvoicePatternRegion` dict (see schemas) carrying
    # `source_file_id`, `page`, `bbox` (normalized 0-1), `field_key`,
    # plus optional `label` / `notes`. The application layer enforces
    # the `source_file_id` ↔ `source_files[*].id` invariant.
    regions: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )

    # Operator-edited extraction-field universe for this pattern. Each
    # item is an `InvoicePatternFieldDefinition` dict carrying
    # `key`, `label`, `type` ("built_in" | "custom"), `color`, `hidden`.
    #
    #   * `type="built_in"` rows OVERRIDE the canonical field with the
    #     same key (color, label, hidden). Absence == default.
    #   * `type="custom"` rows ARE the source of truth for operator-
    #     created fields not on the canonical `Invoice` model.
    #
    # Defaults to `[]` so every existing row materializes as "no custom
    # fields, no built-in overrides" — exactly the pre-feature behavior.
    field_definitions: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )

    # Soft FK — captures who created the pattern for audit but no
    # constraint to the auth user table. Same contract as
    # InvoiceTemplate / ImportConfig.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )

    def __repr__(self) -> str:
        return (
            f"<InvoicePattern id={self.id} name={self.name!r} "
            f"files={len(self.source_files or [])} "
            f"regions={len(self.regions or [])}>"
        )
