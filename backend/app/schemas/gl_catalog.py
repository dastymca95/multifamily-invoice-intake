"""
Pydantic shapes for the GL Codes (chart of accounts) API.

Mirrors `invoice_template.py` in shape so the frontend gets a
consistent rhythm across the two builders (templates / catalogs).

Response shapes:
  * `GLCatalogEntry`   — one GL row inside a catalog's `entries` array.
  * `GLCatalogOut`     — full record (returned by GET / POST / PATCH).
  * `GLCatalogSummary` — list-row payload (entry_count instead of the
                          full entries array — keeps the rail's GET
                          cheap when the user has many catalogs).
  * `GLCatalogDefault` — canonical built-in catalog the frontend uses
                          as a starter draft when nothing is saved yet.
                          Not persisted.
  * `ParsedGLUpload`   — output of `POST /gl-catalogs/parse-upload`. A
                          one-shot parse: returns the RAW source columns
                          and rows from the uploaded file plus a
                          `suggested_mapping` (canonical-field → source-
                          column hint). The frontend then runs an
                          explicit column-mapping step before assembling
                          the canonical entries — the parser deliberately
                          does NOT pre-build entries, since BillsIQ's
                          canonical schema is the source of truth and
                          the user must confirm (or override) the
                          mapping. The file itself isn't stored.
  * `GLUploadMapping`  — canonical-field → source-column-name dict the
                          mapping step works against. Sentinel `None`
                          means "no source column maps to this field".

`source` is a free-text Literal — adding a new origin later needs a
one-line schema change but no DB migration (the model uses a
free-text column).
"""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

# Where a catalog originated. Informational only.
GLCatalogSourceLiteral = Literal["default", "blank", "from_upload", "custom"]

# Sensible bounds. 1 entry minimum (a 0-row catalog is a placeholder,
# not a chart of accounts). 5000 max keeps the JSONB payload bounded
# while leaving headroom for any realistic chart we'll see — the
# canonical multifamily charts top out around a few hundred codes.
MIN_ENTRIES = 1
MAX_ENTRIES = 5000

MAX_CODE_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 500
MAX_CATEGORY_LENGTH = 120
MAX_NOTES_LENGTH = 1000

# Hard cap on data rows the parser surfaces in `ParsedGLUpload.source_rows`.
# Mirrors MAX_ENTRIES so a parsed upload never contains more rows than a
# saved catalog can hold — prevents the "upload 50k-row file, mapping
# step looks fine, save fails at the entries-length validator" cliff.
MAX_PARSE_ROWS = MAX_ENTRIES


class GLCatalogEntry(BaseModel):
    """One GL row inside a catalog's `entries` array."""

    # Stable client-side id so the React editor can use it as a key the
    # moment it adds a row, before any server round-trip. The backend
    # only enforces uniqueness within the catalog (not strict UUID
    # format) so `e-0` style ids from a fresh draft are accepted.
    id: str = Field(min_length=1, max_length=64)

    # The GL account code (e.g. "5100", "6010-01", "1100.10"). Stored
    # as a free-text string — different orgs use different conventions
    # (numeric, dotted, hierarchical) and we don't want the model to
    # privilege any one of them.
    code: str = Field(min_length=1, max_length=MAX_CODE_LENGTH)

    # Human-readable description of the account. Required (a code with
    # no description is borderline useless — and uploaded charts always
    # have one).
    description: str = Field(min_length=1, max_length=MAX_DESCRIPTION_LENGTH)

    # Optional category / group label, e.g. "Operating Expenses",
    # "Asset", "Income". Free text — different ResMan exports use
    # slightly different vocabulary; we don't validate.
    category: str | None = Field(default=None, max_length=MAX_CATEGORY_LENGTH)

    # Whether this account should currently be considered usable.
    # Defaults to True so a new entry is "live" by default; users can
    # mark legacy / closed accounts inactive without deleting them.
    active: bool = True

    # Optional internal notes — useful for explaining unusual codes
    # to teammates ("use only for HOA pass-throughs", etc).
    notes: str | None = Field(default=None, max_length=MAX_NOTES_LENGTH)

    @field_validator("code")
    @classmethod
    def _strip_code(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("GL code cannot be blank")
        return v

    @field_validator("description")
    @classmethod
    def _strip_description(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("GL description cannot be blank")
        return v

    @field_validator("category")
    @classmethod
    def _strip_category(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None

    @field_validator("notes")
    @classmethod
    def _strip_notes(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


def _validate_entry_invariants(
    entries: list[GLCatalogEntry],
) -> list[GLCatalogEntry]:
    """Shared invariants for create + update + parse-upload responses.

    * Entry ids must be unique within the catalog.
    * GL codes must be unique within the catalog (case-insensitive) —
      same code twice is almost always a data-entry mistake and we'd
      rather catch it at save time than during downstream validation.
    """
    ids = [e.id for e in entries]
    if len(ids) != len(set(ids)):
        raise ValueError("entry ids must be unique within the catalog")
    codes_lower = [e.code.strip().lower() for e in entries]
    if len(codes_lower) != len(set(codes_lower)):
        raise ValueError("GL codes must be unique within the catalog")
    return entries


class GLCatalogCreate(BaseModel):
    """Body for POST /gl-catalogs."""

    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    entries: list[GLCatalogEntry] = Field(
        min_length=MIN_ENTRIES, max_length=MAX_ENTRIES
    )
    source: GLCatalogSourceLiteral = "custom"

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name cannot be blank")
        return v

    @field_validator("entries")
    @classmethod
    def _check_entries(cls, v: list[GLCatalogEntry]) -> list[GLCatalogEntry]:
        return _validate_entry_invariants(v)


class GLCatalogUpdate(BaseModel):
    """
    Body for PATCH /gl-catalogs/{id}. Every field optional.

    Sending `entries` REPLACES the array (no per-row patching). The
    frontend always sends the full new ordered list — that matches how
    a structural editor naturally batches edits and avoids the
    complexity of diff-based merges. Same contract as InvoiceTemplate.
    """

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    entries: list[GLCatalogEntry] | None = Field(
        default=None, min_length=MIN_ENTRIES, max_length=MAX_ENTRIES
    )
    # `source` is set at create time and not editable via PATCH.

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("name cannot be blank")
        return v

    @field_validator("entries")
    @classmethod
    def _check_entries(
        cls, v: list[GLCatalogEntry] | None
    ) -> list[GLCatalogEntry] | None:
        if v is None:
            return None
        return _validate_entry_invariants(v)


class GLCatalogOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    entries: list[GLCatalogEntry]
    source: GLCatalogSourceLiteral
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class GLCatalogSummary(BaseModel):
    """List-row shape — no entries array, just its size."""

    id: uuid.UUID
    name: str
    description: str | None
    source: GLCatalogSourceLiteral
    entry_count: int
    created_at: datetime
    updated_at: datetime


class GLCatalogList(BaseModel):
    items: list[GLCatalogSummary] = Field(default_factory=list)


class GLCatalogDefault(BaseModel):
    """
    Canonical built-in catalog the frontend uses as a starting editable
    draft when nothing is saved yet. Not persisted.
    """

    name: str
    description: str | None
    entries: list[GLCatalogEntry]


class GLUploadMapping(BaseModel):
    """
    Mapping from BillsIQ's canonical GL fields to source column names
    in the uploaded file.

    Each value is either:
      * the EXACT NAME of a column in `ParsedGLUpload.source_columns`
        (the frontend uses these strings as the value attribute on
        each canonical field's <select>), or
      * `None`, meaning "no source column maps to this canonical field".

    Required-field omissions (`code` / `description` left as None) are
    enforced by the frontend at mapping-confirm time and again by the
    `GLCatalogCreate` validator when the catalog is finally saved —
    this schema itself doesn't enforce them, since a partially-mapped
    state is valid mid-wizard.

    Backend uses this shape only for the `suggested_mapping` field of
    `ParsedGLUpload` (a hint the frontend may accept or override). The
    final user-confirmed mapping never round-trips through the API —
    the frontend applies it locally to assemble canonical entries that
    are then sent to `POST /gl-catalogs`.
    """

    code: str | None = None
    description: str | None = None
    category: str | None = None
    active: str | None = None
    notes: str | None = None


class ParsedGLUpload(BaseModel):
    """
    Result of `POST /gl-catalogs/parse-upload`.

    One-shot parse: the file isn't stored. The parser surfaces the
    raw source data (header columns + data rows) and a best-effort
    `suggested_mapping` from BillsIQ's canonical GL fields to source
    column names. The frontend then runs an EXPLICIT column-mapping
    step where the user confirms or overrides the suggestion before
    the canonical entries are assembled and sent to POST /gl-catalogs.

    Why we deliberately don't pre-build entries here:
      * BillsIQ's canonical GL schema (code/description/category/
        active/notes) is the source of truth. A raw uploaded file's
        column names can be anything — the user must explicitly
        confirm the mapping before any row becomes a canonical entry.
      * Parsing-as-mapping silently couples header detection to entry
        creation and hides misdetections from the user. Splitting the
        two steps surfaces the mapping decision as a first-class one.

    Soft failures (no header row, unsupported file shape) come back
    as a successful response with empty `source_columns` /
    `source_rows` and a `parse_warning` explaining what happened —
    the modal renders a hint and lets the user pick a different file.
    """

    filename: str
    detected_format: Literal["csv", "xlsx"]
    source_columns: list[str]
    """Column headers as they appeared in the uploaded file, in order.
    Empty list when no header row was recognized — `parse_warning`
    explains why and the frontend's mapping step is short-circuited."""
    source_rows: list[list[str]]
    """Data rows below the header, each padded / truncated to
    `len(source_columns)` so column index N is meaningful for every
    row. Capped at `MAX_PARSE_ROWS`."""
    suggested_mapping: GLUploadMapping
    """Best-effort canonical-field → source-column-name guess. Always
    set (sentinel `None` for fields the parser couldn't match), so
    the frontend can pre-populate dropdowns the user then confirms
    or overrides. Never silently committed — the user always sees
    and can change every choice."""
    parse_warning: str | None = None
    """Set when the parser still returned a response but something is
    worth telling the user about — e.g. no recognizable header row,
    or the file produced more rows than `MAX_PARSE_ROWS` and was
    truncated."""


# ---------------------------------------------------------------------------
# Default catalog — a small, sensible starter
# ---------------------------------------------------------------------------
#
# This is the canonical chart the frontend renders as a draft on first
# landing. Sized to be useful (not just a single-row toy) but small
# enough that the user can scan it and decide what to keep / edit.
#
# Codes follow the common multifamily property-management 4-digit
# convention: 1xxx = assets, 2xxx = liabilities, 3xxx = equity,
# 4xxx = income, 5xxx-6xxx = operating expenses. Adjust cautiously —
# every fresh draft starts from this list, so adding/removing entries
# affects the "first GL catalog" experience.

_DEFAULT_ENTRIES: tuple[tuple[str, str, str], ...] = (
    # (code, description, category)
    ("1100", "Cash - Operating", "Asset"),
    ("1200", "Accounts Receivable", "Asset"),
    ("2100", "Accounts Payable", "Liability"),
    ("2200", "Accrued Expenses", "Liability"),
    ("4000", "Rental Income", "Income"),
    ("4100", "Other Income", "Income"),
    ("5100", "Repairs & Maintenance", "Operating Expense"),
    ("5110", "HVAC Maintenance", "Operating Expense"),
    ("5120", "Plumbing", "Operating Expense"),
    ("5130", "Electrical", "Operating Expense"),
    ("5200", "Cleaning & Janitorial", "Operating Expense"),
    ("5300", "Landscaping", "Operating Expense"),
    ("5400", "Pest Control", "Operating Expense"),
    ("5500", "Utilities - Common Area", "Operating Expense"),
    ("5600", "Property Insurance", "Operating Expense"),
    ("5700", "Property Tax", "Operating Expense"),
    ("6100", "Office Supplies", "Operating Expense"),
    ("6200", "Marketing & Advertising", "Operating Expense"),
    ("6300", "Professional Fees", "Operating Expense"),
    ("6400", "Bank Fees", "Operating Expense"),
)


def build_default_catalog() -> GLCatalogDefault:
    """Construct the canonical default catalog. Pure function — no I/O."""
    entries = [
        GLCatalogEntry(
            id=f"d-{i}",
            code=code,
            description=desc,
            category=category,
            active=True,
            notes=None,
        )
        for i, (code, desc, category) in enumerate(_DEFAULT_ENTRIES)
    ]
    return GLCatalogDefault(
        name="Default GL Catalog",
        description=(
            "Built-in starter chart of accounts covering common "
            "multifamily property accounting categories. Edit freely — "
            "saving creates an independent copy you can keep refining."
        ),
        entries=entries,
    )
