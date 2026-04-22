"""
Orchestration helper for the ResMan import preview.

Both `GET /reference-data/preview` and the `/import-configs` detail
endpoints need to:

  1. load all four reference files,
  2. load up to N approved invoices,
  3. hand them to `build_preview()` (with optional per-config role
     overrides), and
  4. shape the dataclass result into the Pydantic response.

That orchestration is identical in both call sites; only the overrides
and row_limit vary. Keeping it here means the API endpoints stay thin
and the reference / invoice repos are queried in exactly the same way
no matter which entry point is rendering the preview.
"""

from typing import cast

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.resman_preview import (
    DEFAULT_PREVIEW_ROW_LIMIT,
    ColumnRole,
    InvoiceFacts,
    build_preview,
)
from app.models.invoice import Invoice
from app.models.reference_file import ReferenceFile
from app.repositories.invoice_repo import InvoiceRepository
from app.repositories.reference_file_repo import ReferenceFileRepository
from app.schemas.resman_preview import (
    PreviewCellOut,
    PreviewColumnOut,
    PreviewContributionOut,
    PreviewRowOut,
    ResmanPreviewResponse,
)

# Hard ceiling for the row_limit knob — matches the Pydantic schema's
# ROW_LIMIT_MAX so the preview can't be asked for unbounded data even
# if the caller bypasses the schema.
PREVIEW_ROW_LIMIT_HARD_CAP = 50


def _invoice_to_facts(inv: Invoice) -> InvoiceFacts:
    """Lift the SQLAlchemy invoice into the framework-free dataclass
    the domain layer accepts. Pulls the first line's description for
    the `description` template column when present."""
    first_line_desc: str | None = None
    if inv.lines:
        first = inv.lines[0]
        first_line_desc = first.description if first.description else None
    return InvoiceFacts(
        invoice_id=str(inv.id),
        vendor_name=inv.vendor_name,
        property_name=inv.property_name,
        property_code=inv.property_code,
        invoice_number=inv.invoice_number,
        invoice_date=inv.invoice_date,
        due_date=inv.due_date,
        total_amount=inv.total_amount,
        subtotal=inv.subtotal,
        tax_amount=inv.tax_amount,
        currency=inv.currency,
        account_number=inv.account_number,
        first_line_description=first_line_desc,
    )


async def render_preview(
    db: AsyncSession,
    *,
    row_limit: int = DEFAULT_PREVIEW_ROW_LIMIT,
    column_role_overrides: dict[str, str] | None = None,
) -> ResmanPreviewResponse:
    """
    Build a `ResmanPreviewResponse` against the CURRENT reference uploads
    and the most-recent approved invoices.

    `column_role_overrides` keys are template column names (verbatim);
    values are role strings drawn from `ColumnRole`. Invalid role values
    are filtered out here defensively — the schema layer catches typos
    at PATCH/POST time, but the persisted JSONB might in principle hold
    legacy values from a removed role; this keeps the preview robust.
    """
    row_limit = max(1, min(row_limit, PREVIEW_ROW_LIMIT_HARD_CAP))

    ref_repo = ReferenceFileRepository(db)
    inv_repo = InvoiceRepository(db)

    rows = await ref_repo.list_all()
    by_kind: dict[str, ReferenceFile] = {r.kind: r for r in rows}
    template = by_kind.get("import_template")
    properties = by_kind.get("properties")
    units = by_kind.get("units")
    vendors = by_kind.get("vendors")

    invoices = await inv_repo.get_approved_for_export(limit=row_limit)

    # Defensive narrowing: drop any override whose role string is no
    # longer a valid ColumnRole (e.g. role removed in a later release).
    valid_overrides: dict[str, ColumnRole] | None = None
    if column_role_overrides:
        valid_role_strs = set(ColumnRole.__args__)  # type: ignore[attr-defined]
        valid_overrides = {
            k: cast(ColumnRole, v)
            for k, v in column_role_overrides.items()
            if v in valid_role_strs
        }

    result = build_preview(
        template_columns=template.parsed_columns if template else None,
        template_filename=template.original_filename if template else None,
        properties_columns=properties.parsed_columns if properties else None,
        properties_samples=properties.sample_rows if properties else None,
        properties_row_count=properties.parsed_row_count if properties else None,
        units_columns=units.parsed_columns if units else None,
        units_samples=units.sample_rows if units else None,
        units_row_count=units.parsed_row_count if units else None,
        vendors_columns=vendors.parsed_columns if vendors else None,
        vendors_samples=vendors.sample_rows if vendors else None,
        vendors_row_count=vendors.parsed_row_count if vendors else None,
        invoices=(_invoice_to_facts(i) for i in invoices),
        row_limit=row_limit,
        column_role_overrides=valid_overrides,
    )

    return ResmanPreviewResponse(
        has_template=result.has_template,
        template_filename=result.template_filename,
        columns=[
            PreviewColumnOut(
                name=c.name,
                role=c.role,
                populated_from=c.populated_from,
                role_overridden=c.role_overridden,
            )
            for c in result.columns
        ],
        rows=[
            PreviewRowOut(
                label=r.label,
                origin=r.origin,
                cells=[
                    PreviewCellOut(
                        value=cell.value,
                        status=cell.status,
                        source=cell.source,
                        note=cell.note,
                    )
                    for cell in r.cells
                ],
            )
            for r in result.rows
        ],
        contributions=[
            PreviewContributionOut(
                source=c.source,
                label=c.label,
                available=c.available,
                row_count=c.row_count,
                columns_powered=c.columns_powered,
                note=c.note,
            )
            for c in result.contributions
        ],
        notes=result.notes,
    )
