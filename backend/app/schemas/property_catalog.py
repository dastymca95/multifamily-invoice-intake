"""
Pydantic shapes for the Properties (property/unit master) API.

Mirrors `gl_catalog.py` and `invoice_template.py` in shape so the
frontend gets a consistent rhythm across the three builders
(templates / GL catalogs / property catalogs).

Response shapes:
  * `PropertyEntry`      — one property/unit row inside a catalog's
                            `entries` array.
  * `PropertyCatalogOut` — full record (returned by GET / POST / PATCH).
  * `PropertyCatalogSummary` — list-row payload (entry_count instead
                            of the full entries array — keeps the
                            rail's GET cheap).
  * `PropertyCatalogDefault` — canonical built-in catalog the frontend
                            uses as a starter draft when nothing is
                            saved yet. Not persisted.
  * `ParsedPropertyUpload` — output of `POST /property-catalogs/parse-upload`.
                            One-shot per-file parse: returns RAW source
                            data + a suggested canonical-field mapping.
                            The frontend orchestrates multi-file uploads
                            by calling this endpoint once per file and
                            doing the mapping + cross-file merge
                            client-side.
  * `PropertyUploadMapping` — canonical-field → source-column-name dict
                            the mapping step works against.

Canonical schema (the source of truth for property master data):

  property_name, property_code  — required (the row identity)
  property_abbreviation         — optional (used downstream for export)
  address, city, state, zip     — optional (geographic)
  unit_number                   — optional ("" → property-level row)
  unit_type, building           — optional (unit-level metadata)
  active                        — bool, default True
  notes                         — optional internal notes

Uniqueness within a catalog: `(property_code, unit_number || "")` —
same property_code can repeat across different units, but a
property+unit combination must be unique.

`source` is a free-text Literal — adding a new origin later needs a
one-line schema change but no DB migration (the model uses a free-text
column).
"""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

# Where a catalog originated. Informational only.
PropertyCatalogSourceLiteral = Literal[
    "default", "blank", "from_upload", "custom"
]

# Sensible bounds. 1 entry minimum (a 0-row catalog isn't useful).
# 20000 max keeps the JSONB payload bounded while leaving headroom for
# large multifamily portfolios — a 50-property portfolio at 200 units
# each lands at 10k rows.
MIN_ENTRIES = 1
MAX_ENTRIES = 20000

# Field-level bounds. Most strings are short; address + notes get more
# room. These match the `<input maxLength>` caps on the frontend
# editor, so the user can't out-type the schema.
MAX_NAME_LENGTH = 255
MAX_CODE_LENGTH = 64
MAX_ABBR_LENGTH = 32
MAX_ADDRESS_LENGTH = 255
MAX_CITY_LENGTH = 120
MAX_STATE_LENGTH = 64
MAX_ZIP_LENGTH = 20
MAX_UNIT_NUMBER_LENGTH = 64
MAX_UNIT_TYPE_LENGTH = 64
MAX_BUILDING_LENGTH = 64
MAX_NOTES_LENGTH = 1000

# Hard cap on data rows the parser surfaces in
# `ParsedPropertyUpload.source_rows`. Mirrors MAX_ENTRIES so a parsed
# upload can never produce more rows than a saved catalog can hold —
# even after multi-file merging on the client.
MAX_PARSE_ROWS = MAX_ENTRIES


class PropertyEntry(BaseModel):
    """One property/unit row inside a catalog's `entries` array."""

    # Stable client-side id so the React editor can use it as a key the
    # moment it adds a row, before any server round-trip. Backend only
    # enforces uniqueness within the catalog (not strict UUID format)
    # so `e-0` style ids from a fresh draft are accepted.
    id: str = Field(min_length=1, max_length=64)

    # Required identity fields. property_name is the human label;
    # property_code is what downstream validation / lookup keys on. We
    # require both so a catalog never has anonymous rows that can't be
    # joined back to anything.
    property_name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    property_code: str = Field(min_length=1, max_length=MAX_CODE_LENGTH)

    # Short token used by exports (e.g. ResMan abbreviations). Optional
    # because not every chart provides one upfront.
    property_abbreviation: str | None = Field(default=None, max_length=MAX_ABBR_LENGTH)

    # Geographic — all optional because portfolios with one address
    # often skip per-row address fields, and unit-level imports rarely
    # carry them.
    address: str | None = Field(default=None, max_length=MAX_ADDRESS_LENGTH)
    city: str | None = Field(default=None, max_length=MAX_CITY_LENGTH)
    state: str | None = Field(default=None, max_length=MAX_STATE_LENGTH)
    zip: str | None = Field(default=None, max_length=MAX_ZIP_LENGTH)

    # Unit-level metadata. `unit_number` empty means "property-level
    # row" (e.g. a building summary entry). Same property_code + empty
    # unit can coexist with same property_code + populated unit because
    # the uniqueness key is the pair.
    unit_number: str | None = Field(default=None, max_length=MAX_UNIT_NUMBER_LENGTH)
    unit_type: str | None = Field(default=None, max_length=MAX_UNIT_TYPE_LENGTH)
    building: str | None = Field(default=None, max_length=MAX_BUILDING_LENGTH)

    # Whether this row should currently be considered usable. Defaults
    # to True so freshly-added entries are "live"; users can mark
    # legacy / decommissioned units inactive without deleting them.
    active: bool = True

    # Optional internal notes — useful for explaining unusual rows
    # ("model unit", "common-area only", etc).
    notes: str | None = Field(default=None, max_length=MAX_NOTES_LENGTH)

    @field_validator("property_name", "property_code")
    @classmethod
    def _strip_required(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("property_name / property_code cannot be blank")
        return v

    @field_validator(
        "property_abbreviation",
        "address",
        "city",
        "state",
        "zip",
        "unit_number",
        "unit_type",
        "building",
        "notes",
    )
    @classmethod
    def _strip_optional(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


def _entry_unique_key(e: PropertyEntry) -> tuple[str, str]:
    """
    Stable (property_code, unit_number-or-empty) tuple used as the
    uniqueness key within a catalog. Case-insensitive on the code and
    unit so "P1"/"p1" and "101"/"101 " collide as the user expects.
    """
    code = e.property_code.strip().lower()
    unit = (e.unit_number or "").strip().lower()
    return (code, unit)


def _validate_entry_invariants(
    entries: list[PropertyEntry],
) -> list[PropertyEntry]:
    """Shared invariants for create + update + (later) merge results.

    * Entry ids must be unique within the catalog.
    * (property_code, unit_number) pairs must be unique within the
      catalog (case-insensitive). Same property_code with two
      different units is fine; same property_code with the same unit
      twice is almost always a data-entry mistake.
    """
    ids = [e.id for e in entries]
    if len(ids) != len(set(ids)):
        raise ValueError("entry ids must be unique within the catalog")
    keys = [_entry_unique_key(e) for e in entries]
    if len(keys) != len(set(keys)):
        raise ValueError(
            "property_code + unit_number combinations must be unique "
            "within the catalog"
        )
    return entries


class PropertyCatalogCreate(BaseModel):
    """Body for POST /property-catalogs."""

    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    entries: list[PropertyEntry] = Field(
        min_length=MIN_ENTRIES, max_length=MAX_ENTRIES
    )
    source: PropertyCatalogSourceLiteral = "custom"

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name cannot be blank")
        return v

    @field_validator("entries")
    @classmethod
    def _check_entries(cls, v: list[PropertyEntry]) -> list[PropertyEntry]:
        return _validate_entry_invariants(v)


class PropertyCatalogUpdate(BaseModel):
    """
    Body for PATCH /property-catalogs/{id}. Every field optional.

    Sending `entries` REPLACES the array (no per-row patching). The
    frontend always sends the full new ordered list — that matches how
    a structural editor naturally batches edits and avoids the
    complexity of diff-based merges. Same contract as GLCatalog and
    InvoiceTemplate.
    """

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    entries: list[PropertyEntry] | None = Field(
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
        cls, v: list[PropertyEntry] | None
    ) -> list[PropertyEntry] | None:
        if v is None:
            return None
        return _validate_entry_invariants(v)


class PropertyCatalogOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    entries: list[PropertyEntry]
    source: PropertyCatalogSourceLiteral
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PropertyCatalogSummary(BaseModel):
    """List-row shape — no entries array, just its size."""

    id: uuid.UUID
    name: str
    description: str | None
    source: PropertyCatalogSourceLiteral
    entry_count: int
    created_at: datetime
    updated_at: datetime


class PropertyCatalogList(BaseModel):
    items: list[PropertyCatalogSummary] = Field(default_factory=list)


class PropertyCatalogDefault(BaseModel):
    """
    Canonical built-in catalog the frontend uses as a starting editable
    draft when nothing is saved yet. Not persisted.
    """

    name: str
    description: str | None
    entries: list[PropertyEntry]


# ---------------------------------------------------------------------------
# Upload parse + mapping shapes
# ---------------------------------------------------------------------------


class PropertyUploadMapping(BaseModel):
    """
    Mapping from BillsIQ's canonical property fields to source column
    names in an uploaded file.

    Each value is either:
      * the EXACT NAME of a column in `ParsedPropertyUpload.source_columns`
        (the frontend uses these strings as the value attribute on each
        canonical field's <select>), or
      * `None`, meaning "no source column maps to this canonical field".

    Required-field omissions (`property_name` / `property_code` left as
    None) are enforced by the frontend at mapping-confirm time and again
    by the `PropertyCatalogCreate` validator when the catalog is finally
    saved — this schema itself doesn't enforce them, since a partially-
    mapped state is valid mid-wizard. The `active` field uses the same
    truthy/falsy interpretation as GLCatalog (yes/no, true/false, 1/0,
    active/inactive).

    Backend uses this shape only for the `suggested_mapping` field of
    `ParsedPropertyUpload` (a hint the frontend may accept or override).
    Confirmed mappings never round-trip through the API — the frontend
    applies them locally to assemble canonical entries that are then
    sent to `POST /property-catalogs`.
    """

    property_name: str | None = None
    property_code: str | None = None
    property_abbreviation: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    unit_number: str | None = None
    unit_type: str | None = None
    building: str | None = None
    active: str | None = None
    notes: str | None = None


class ParsedPropertyUpload(BaseModel):
    """
    Result of `POST /property-catalogs/parse-upload`.

    One-shot per-file parse: the file isn't stored. The parser surfaces
    raw source data (header columns + data rows) and a best-effort
    `suggested_mapping` from BillsIQ's canonical property fields to
    source column names.

    Multi-file workflows are orchestrated by the FRONTEND. The client
    posts each file separately, accumulates the parsed responses,
    presents a per-file mapping UI, then merges all confirmed mappings
    into one canonical entries list before calling
    `POST /property-catalogs`. Keeping the endpoint single-file means
    progress / errors / retries are per-file, not all-or-nothing.

    Soft failures (no header row, unsupported file shape) come back as
    a successful response with empty `source_columns` / `source_rows`
    and a `parse_warning` explaining what happened — the modal renders
    a hint and lets the user pick a different file.
    """

    filename: str
    detected_format: Literal["csv", "xlsx"]
    source_columns: list[str]
    source_rows: list[list[str]]
    suggested_mapping: PropertyUploadMapping
    parse_warning: str | None = None


# ---------------------------------------------------------------------------
# Default catalog — small canonical multifamily starter
# ---------------------------------------------------------------------------
#
# Sized to be useful (not a single-row toy) but small enough to scan.
# Three sample properties, each with a property-level summary row plus
# a few unit-level rows, so the user immediately sees what
# property+unit rows look like in the canonical structure.

_DEFAULT_PROPERTIES: tuple[
    tuple[str, str, str, str, str, str, str], ...
] = (
    # (code, name, abbr, address, city, state, zip)
    (
        "VST",
        "Vista Apartments",
        "VST",
        "100 Sunset Drive",
        "Austin",
        "TX",
        "78701",
    ),
    (
        "OAK",
        "Oakwood Place",
        "OAK",
        "250 Cedar Lane",
        "Dallas",
        "TX",
        "75201",
    ),
    (
        "PNE",
        "Pine Ridge Townhomes",
        "PNE",
        "47 Ridge Way",
        "Houston",
        "TX",
        "77002",
    ),
)

_DEFAULT_UNITS: tuple[tuple[str, str, str, str], ...] = (
    # (property_code, unit_number, unit_type, building)
    ("VST", "101", "1BR", "A"),
    ("VST", "102", "1BR", "A"),
    ("VST", "201", "2BR", "A"),
    ("OAK", "1A", "Studio", "1"),
    ("OAK", "1B", "1BR", "1"),
    ("OAK", "2A", "2BR", "2"),
    ("PNE", "TH-1", "Townhouse", "Phase 1"),
    ("PNE", "TH-2", "Townhouse", "Phase 1"),
    ("PNE", "TH-3", "Townhouse", "Phase 2"),
)


def build_default_catalog() -> PropertyCatalogDefault:
    """Construct the canonical default catalog. Pure function — no I/O."""
    entries: list[PropertyEntry] = []
    by_code: dict[str, tuple[str, str, str, str, str, str, str]] = {
        p[0]: p for p in _DEFAULT_PROPERTIES
    }

    counter = 0
    for code, unit, unit_type, building in _DEFAULT_UNITS:
        prop = by_code[code]
        # prop = (code, name, abbr, address, city, state, zip)
        entries.append(
            PropertyEntry(
                id=f"d-{counter}",
                property_name=prop[1],
                property_code=prop[0],
                property_abbreviation=prop[2],
                address=prop[3],
                city=prop[4],
                state=prop[5],
                zip=prop[6],
                unit_number=unit,
                unit_type=unit_type,
                building=building,
                active=True,
                notes=None,
            )
        )
        counter += 1

    return PropertyCatalogDefault(
        name="Default Property Catalog",
        description=(
            "Built-in starter property master table with three sample "
            "multifamily properties and a handful of unit rows each. "
            "Edit freely — saving creates an independent copy you can "
            "keep refining."
        ),
        entries=entries,
    )
