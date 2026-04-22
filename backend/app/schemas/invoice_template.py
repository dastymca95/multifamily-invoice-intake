"""
Pydantic shapes for the Invoice Template Builder API.

The four response shapes:

  * `InvoiceTemplateColumn`  — one column entry (id + name + optional
                               source_column pointer).
  * `InvoiceTemplateOut`     — a full template record. Returned by
                               GET / POST / PATCH detail responses.
  * `InvoiceTemplateSummary` — list-row payload (no columns array).
                               Used for the left-rail list so we don't
                               ship every column for every saved
                               template on the index endpoint.
  * `InvoiceTemplateDefault` — the canonical built-in template the
                               frontend uses as the starting editable
                               shape when nothing is uploaded and
                               nothing is saved yet. Not persisted —
                               served from a hardcoded constant.

Source values are validated as Literal so the frontend can safely
trust a string union; new origins added later need a one-line schema
change but no DB migration (the model uses a free-text column).
"""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

# What an InvoiceTemplate's `source` field can take. Informational
# only — drives the UI's "where did this come from?" hint.
TemplateSourceLiteral = Literal["default", "blank", "from_upload", "custom"]

# Sensible bounds. 1 column minimum (otherwise the template is
# meaningless); 200 column maximum is well above any real ResMan
# template (the canonical ones top out around 25–30 columns) but bounds
# the JSONB payload size for safety.
MIN_COLUMNS = 1
MAX_COLUMNS = 200
MAX_COLUMN_NAME_LENGTH = 200


class InvoiceTemplateColumn(BaseModel):
    """One column inside a template's `columns` array."""

    # UUID-ish stable key. Generated client-side so the frontend can
    # use it as a React key from the moment it adds a row, before any
    # server round-trip. Validated as a non-empty string rather than
    # strict UUID so we don't reject perfectly-good `c-0` style keys.
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=MAX_COLUMN_NAME_LENGTH)
    # Original column name from the uploaded ResMan template, when this
    # column was seeded from one. Null otherwise. Kept around so a future
    # export step can recover "this user-named column maps to that
    # template column" without re-classifying.
    source_column: str | None = Field(default=None, max_length=MAX_COLUMN_NAME_LENGTH)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("column name cannot be blank")
        return v


class InvoiceTemplateCreate(BaseModel):
    """Body for POST /invoice-templates."""

    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    columns: list[InvoiceTemplateColumn] = Field(
        min_length=MIN_COLUMNS, max_length=MAX_COLUMNS
    )
    source: TemplateSourceLiteral = "custom"

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name cannot be blank")
        return v

    @field_validator("columns")
    @classmethod
    def _unique_ids(
        cls, v: list[InvoiceTemplateColumn]
    ) -> list[InvoiceTemplateColumn]:
        ids = [c.id for c in v]
        if len(ids) != len(set(ids)):
            raise ValueError("column ids must be unique within the template")
        return v


class InvoiceTemplateUpdate(BaseModel):
    """
    Body for PATCH /invoice-templates/{id}. Every field optional.

    Sending `columns` REPLACES the array (no per-row patching). The
    frontend always sends the full new ordered list — that matches how
    a structural editor naturally batches edits and avoids the
    complexity of diff-based merges.
    """

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    columns: list[InvoiceTemplateColumn] | None = Field(
        default=None, min_length=MIN_COLUMNS, max_length=MAX_COLUMNS
    )
    # `source` is set at create time and not editable via PATCH —
    # there's no good UX for "change where this template originated
    # from" after the fact.

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("name cannot be blank")
        return v

    @field_validator("columns")
    @classmethod
    def _unique_ids(
        cls, v: list[InvoiceTemplateColumn] | None
    ) -> list[InvoiceTemplateColumn] | None:
        if v is None:
            return None
        ids = [c.id for c in v]
        if len(ids) != len(set(ids)):
            raise ValueError("column ids must be unique within the template")
        return v


class InvoiceTemplateOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    columns: list[InvoiceTemplateColumn]
    source: TemplateSourceLiteral
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class InvoiceTemplateSummary(BaseModel):
    """List-row shape — no columns array, just its size."""

    id: uuid.UUID
    name: str
    description: str | None
    source: TemplateSourceLiteral
    column_count: int
    created_at: datetime
    updated_at: datetime


class InvoiceTemplateList(BaseModel):
    items: list[InvoiceTemplateSummary] = Field(default_factory=list)


class InvoiceTemplateDefault(BaseModel):
    """
    The canonical built-in template the frontend uses as a starting
    editable shape when nothing else is available. Not persisted.
    """

    name: str
    description: str | None
    columns: list[InvoiceTemplateColumn]


# ---------------------------------------------------------------------------
# Default template — the canonical ResMan invoice import shape
# ---------------------------------------------------------------------------
#
# This is the column set the frontend renders as a draft when the user
# first lands on the Invoice Template Builder with no saved templates
# AND no uploaded ResMan template. Mirrors the canonical fields the
# `_pick_sheet_rows` heuristic in `reference_parse.py` looks for, so
# users who later upload a real ResMan template see column names that
# rhyme with what they already designed.
#
# Adjust this list cautiously — every existing user starts a draft from
# it, so adding/removing columns affects the "fresh start" experience.
# Renaming an entry here does NOT affect any saved template (those
# carry their own copy of the columns once persisted).

_DEFAULT_COLUMN_NAMES: tuple[str, ...] = (
    "Invoice Number",
    "Invoice Date",
    "Accounting Date",
    "Vendor",
    "Vendor Code",
    "Property Abbreviation",
    "Property Name",
    "Unit",
    "GL Account",
    "Line Item Description",
    "Amount",
    "Tax",
    "Total",
    "Currency",
    "Due Date",
    "PO Number",
    "Notes",
)


def build_default_template() -> InvoiceTemplateDefault:
    """Construct the canonical default template. Pure function — no I/O."""
    columns = [
        InvoiceTemplateColumn(
            id=f"d-{i}",
            name=name,
            source_column=None,
        )
        for i, name in enumerate(_DEFAULT_COLUMN_NAMES)
    ]
    return InvoiceTemplateDefault(
        name="Default ResMan Invoice Template",
        description=(
            "Built-in starting template covering the canonical ResMan "
            "invoice import fields. Edit freely — saving creates an "
            "independent copy."
        ),
        columns=columns,
    )
