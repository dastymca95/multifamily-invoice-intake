"""
Pydantic shapes for the ResMan import preview API.

Mirrors the dataclasses in `app.domain.resman_preview` but adds the
typing constraints the FastAPI layer needs (Literals for enums, default
factories for lists). The API layer converts domain dataclasses into
these schemas at the response edge.
"""

from typing import Literal

from pydantic import BaseModel, Field

CellStatusLiteral = Literal["ok", "unresolved", "unmapped"]
CellSourceLiteral = Literal[
    "vendor_report",
    "property_report",
    "unit_report",
    "invoice",
    "synthetic",
]
ReferenceSourceLiteral = Literal[
    "vendor_report",
    "property_report",
    "unit_report",
    "import_template",
]
ColumnRoleLiteral = Literal[
    "vendor_name",
    "vendor_id",
    "property_name",
    "property_code",
    "unit",
    "location",
    "invoice_number",
    "invoice_date",
    "due_date",
    "amount_total",
    "amount_subtotal",
    "amount_tax",
    "currency",
    "description",
    "account_number",
    "gl_code",
    "unmapped",
]
RowOriginLiteral = Literal["invoice", "synthetic"]


class PreviewCellOut(BaseModel):
    """One cell in the preview grid."""

    value: str | None = None
    status: CellStatusLiteral
    source: CellSourceLiteral | None = None
    note: str | None = None


class PreviewRowOut(BaseModel):
    """One row — either a real approved invoice or a synthetic sample."""

    label: str
    origin: RowOriginLiteral
    cells: list[PreviewCellOut] = Field(default_factory=list)


class PreviewColumnOut(BaseModel):
    """Template column with its detected role and the report that backs it."""

    name: str
    role: ColumnRoleLiteral
    populated_from: ReferenceSourceLiteral | None = None
    # True when an Import Builder config pinned this column's role
    # (rather than the auto-classifier deriving it). The UI uses this
    # to decorate the column header so the user can see which roles
    # they've manually overridden.
    role_overridden: bool = False


class PreviewContributionOut(BaseModel):
    """
    What one uploaded reference source contributes to the preview.

    `columns_powered` is the list of template column names this source
    helps fill. For the import template itself it's the full column
    list (the template *defines* the shape). For the three reports it's
    the subset of template columns whose detected role maps back to that
    report.
    """

    source: ReferenceSourceLiteral
    label: str
    available: bool
    row_count: int | None = None
    columns_powered: list[str] = Field(default_factory=list)
    note: str | None = None


class ResmanPreviewResponse(BaseModel):
    """
    Top-level response from GET /reference-data/preview.

    Always returns a structurally complete response — even when the
    template hasn't been uploaded yet, `columns` / `rows` are empty
    lists rather than missing keys, so the UI can render a single
    consistent skeleton + empty-state copy.
    """

    has_template: bool
    template_filename: str | None = None
    columns: list[PreviewColumnOut] = Field(default_factory=list)
    rows: list[PreviewRowOut] = Field(default_factory=list)
    contributions: list[PreviewContributionOut] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
