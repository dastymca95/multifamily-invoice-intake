"""
Pydantic shapes for the Vendors API.

Mirrors `gl_catalog.py` in shape so the frontend gets a consistent
rhythm across the three Reference Data builders (templates / GL /
properties / vendors).

Response shapes:
  * `VendorCatalogEntry`   — one vendor row inside `entries`.
  * `VendorCatalogOut`     — full record (returned by GET / POST / PATCH).
  * `VendorCatalogSummary` — list-row payload (entry_count instead of
                              the full entries array — keeps the rail's
                              GET cheap when the user has many catalogs).
  * `VendorCatalogDefault` — canonical built-in catalog the frontend
                              uses as a starter draft when nothing is
                              saved yet. Not persisted.
  * `ParsedVendorUpload`   — output of `POST /vendor-catalogs/parse-upload`.
                              A one-shot parse: returns the RAW source
                              columns and rows from the uploaded file
                              plus a `suggested_mapping` (canonical-field
                              → source-column hint). The frontend then
                              runs an explicit column-mapping step before
                              assembling the canonical entries — the
                              parser deliberately does NOT pre-build
                              entries, since BillsIQ's canonical schema
                              is the source of truth and the user must
                              confirm (or override) the mapping. The
                              file itself isn't stored.
  * `VendorUploadMapping`  — canonical-field → source-column-name dict
                              the mapping step works against. Sentinel
                              `None` means "no source column maps to
                              this field".

Why `aliases` is a list of strings (not a comma-separated string):

  * Future invoice-payee matching iterates aliases per vendor; doing
    string-split on every match call would be wasteful.
  * The editor renders aliases as a comma-joined text input (low
    friction); the canonical persisted shape stays structured.
  * Per-alias length bounds are easy to enforce on a list.

Required-field invariants:

  * `vendor_name` is the SOLE hard-required canonical field. A row
    without a name isn't a vendor.
  * `vendor_code` is optional but, when present, must be unique within
    the catalog (case-insensitive). External IDs that collide are
    almost always a data-entry mistake.
  * `vendor_name` uniqueness is NOT enforced — different operating
    entities can legitimately share a name (different "Smith
    Plumbing"s in different cities). The editor surfaces a soft
    warning, not a save block.

`source` is a free-text Literal — adding a new origin later needs a
one-line schema change but no DB migration (the model uses a free-text
column).
"""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

# Where a catalog originated. Informational only.
VendorCatalogSourceLiteral = Literal["default", "blank", "from_upload", "custom"]

# Sensible bounds. 1 entry minimum (a 0-row catalog is a placeholder,
# not a vendor master). 5000 max is plenty for real-world catalogs —
# even a large multi-property operator rarely has more than a few
# thousand active vendors.
MIN_ENTRIES = 1
MAX_ENTRIES = 5000

MAX_NAME_LENGTH = 255
MAX_CODE_LENGTH = 64
MAX_ALIAS_LENGTH = 255
MAX_ALIASES_PER_ENTRY = 16
MAX_ADDRESS_LENGTH = 500
MAX_CITY_LENGTH = 120
MAX_STATE_LENGTH = 64
MAX_ZIP_LENGTH = 32
MAX_CONTACT_NAME_LENGTH = 255
MAX_EMAIL_LENGTH = 320  # RFC 5321 cap.
MAX_PHONE_LENGTH = 64
MAX_NOTES_LENGTH = 1000

# Hard cap on data rows the parser surfaces in `ParsedVendorUpload.source_rows`.
# Mirrors MAX_ENTRIES so a parsed upload never contains more rows than a
# saved catalog can hold.
MAX_PARSE_ROWS = MAX_ENTRIES


def _strip_or_none(v: str | None) -> str | None:
    """Trim a nullable string; collapse blank-after-trim to None."""
    if v is None:
        return None
    v = v.strip()
    return v or None


class VendorCatalogEntry(BaseModel):
    """One vendor row inside a catalog's `entries` array."""

    # Stable client-side id so the React editor can use it as a key the
    # moment it adds a row, before any server round-trip. The backend
    # only enforces uniqueness within the catalog (not strict UUID
    # format) so `e-0` style ids from a fresh draft are accepted.
    id: str = Field(min_length=1, max_length=64)

    # Primary vendor name — the canonical display label and the
    # primary surface future invoice-payee matching will resolve
    # against. Required; a row without a name isn't a vendor.
    vendor_name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)

    # External identifier — the ResMan / Yardi / AppFolio vendor code,
    # tax ID, or whatever short stable key the user maintains. Optional
    # but strongly suggested; when present it's the secondary match key
    # for invoice resolution.
    vendor_code: str | None = Field(default=None, max_length=MAX_CODE_LENGTH)

    # Alternate names the same vendor goes by — DBA names, abbreviations,
    # historical names, common misspellings. Future invoice-payee
    # matching will try each alias against the extracted payee text.
    # Stored as a structured list (not a comma-string) so per-alias
    # iteration is O(1) and per-alias bounds enforce cleanly.
    aliases: list[str] = Field(
        default_factory=list, max_length=MAX_ALIASES_PER_ENTRY
    )

    address: str | None = Field(default=None, max_length=MAX_ADDRESS_LENGTH)
    city: str | None = Field(default=None, max_length=MAX_CITY_LENGTH)
    # Free text — international users have regions, provinces, etc; we
    # don't validate against a US state list.
    state: str | None = Field(default=None, max_length=MAX_STATE_LENGTH)
    zip: str | None = Field(default=None, max_length=MAX_ZIP_LENGTH)

    contact_name: str | None = Field(
        default=None, max_length=MAX_CONTACT_NAME_LENGTH
    )
    email: str | None = Field(default=None, max_length=MAX_EMAIL_LENGTH)
    phone: str | None = Field(default=None, max_length=MAX_PHONE_LENGTH)

    # Whether this vendor should currently be considered usable for new
    # invoice processing. Defaults to True; users can mark legacy /
    # closed accounts inactive without deleting them.
    active: bool = True

    notes: str | None = Field(default=None, max_length=MAX_NOTES_LENGTH)

    @field_validator("vendor_name")
    @classmethod
    def _strip_vendor_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("vendor_name cannot be blank")
        return v

    @field_validator("vendor_code")
    @classmethod
    def _strip_vendor_code(cls, v: str | None) -> str | None:
        return _strip_or_none(v)

    @field_validator("aliases")
    @classmethod
    def _clean_aliases(cls, v: list[str]) -> list[str]:
        cleaned: list[str] = []
        seen: set[str] = set()
        for raw in v:
            if not isinstance(raw, str):
                raise ValueError("each alias must be a string")
            stripped = raw.strip()
            if not stripped:
                # Drop blank aliases silently — they're noise from
                # comma-split editor input.
                continue
            if len(stripped) > MAX_ALIAS_LENGTH:
                raise ValueError(
                    f"alias exceeds {MAX_ALIAS_LENGTH}-character limit"
                )
            key = stripped.lower()
            if key in seen:
                # De-dupe within an entry — same alias listed twice is a
                # data-entry mistake, not a meaningful distinction.
                continue
            seen.add(key)
            cleaned.append(stripped)
        return cleaned

    @field_validator("address", "city", "state", "zip")
    @classmethod
    def _strip_address_parts(cls, v: str | None) -> str | None:
        return _strip_or_none(v)

    @field_validator("contact_name", "phone", "notes")
    @classmethod
    def _strip_contact_misc(cls, v: str | None) -> str | None:
        return _strip_or_none(v)

    @field_validator("email")
    @classmethod
    def _strip_email(cls, v: str | None) -> str | None:
        # Format validation deliberately permissive — vendor email
        # fields land in catalogs as whatever the user pasted; enforcing
        # strict RFC compliance here would reject perfectly usable rows
        # from messy uploads. The backend trims; the UI hints.
        return _strip_or_none(v)


def _validate_entry_invariants(
    entries: list[VendorCatalogEntry],
) -> list[VendorCatalogEntry]:
    """Shared invariants for create + update + parse-upload responses.

    * Entry ids must be unique within the catalog.
    * `vendor_code`, when present, must be unique (case-insensitive).
      Same external ID twice is almost always a data-entry mistake.
    * `vendor_name` collisions are NOT raised — duplicate names are
      sometimes legitimate (different operating entities sharing a
      name). The editor surfaces this as a soft warning instead.
    """
    ids = [e.id for e in entries]
    if len(ids) != len(set(ids)):
        raise ValueError("entry ids must be unique within the catalog")
    codes_lower = [
        e.vendor_code.strip().lower() for e in entries if e.vendor_code
    ]
    if len(codes_lower) != len(set(codes_lower)):
        raise ValueError(
            "vendor codes must be unique within the catalog (when set)"
        )
    return entries


class VendorCatalogCreate(BaseModel):
    """Body for POST /vendor-catalogs."""

    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    entries: list[VendorCatalogEntry] = Field(
        min_length=MIN_ENTRIES, max_length=MAX_ENTRIES
    )
    source: VendorCatalogSourceLiteral = "custom"

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name cannot be blank")
        return v

    @field_validator("entries")
    @classmethod
    def _check_entries(
        cls, v: list[VendorCatalogEntry]
    ) -> list[VendorCatalogEntry]:
        return _validate_entry_invariants(v)


class VendorCatalogUpdate(BaseModel):
    """
    Body for PATCH /vendor-catalogs/{id}. Every field optional.

    Sending `entries` REPLACES the array (no per-row patching). The
    frontend always sends the full new ordered list — that matches how
    a structural editor naturally batches edits and avoids the
    complexity of diff-based merges. Same contract as GLCatalog.
    """

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    entries: list[VendorCatalogEntry] | None = Field(
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
        cls, v: list[VendorCatalogEntry] | None
    ) -> list[VendorCatalogEntry] | None:
        if v is None:
            return None
        return _validate_entry_invariants(v)


class VendorCatalogOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    entries: list[VendorCatalogEntry]
    source: VendorCatalogSourceLiteral
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class VendorCatalogSummary(BaseModel):
    """List-row shape — no entries array, just its size."""

    id: uuid.UUID
    name: str
    description: str | None
    source: VendorCatalogSourceLiteral
    entry_count: int
    created_at: datetime
    updated_at: datetime


class VendorCatalogList(BaseModel):
    items: list[VendorCatalogSummary] = Field(default_factory=list)


class VendorCatalogDefault(BaseModel):
    """
    Canonical built-in catalog the frontend uses as a starting editable
    draft when nothing is saved yet. Not persisted.
    """

    name: str
    description: str | None
    entries: list[VendorCatalogEntry]


class VendorUploadMapping(BaseModel):
    """
    Mapping from BillsIQ's canonical vendor fields to source column names
    in the uploaded file.

    Each value is either:
      * the EXACT NAME of a column in `ParsedVendorUpload.source_columns`
        (the frontend uses these strings as the value attribute on
        each canonical field's <select>), or
      * `None`, meaning "no source column maps to this canonical field".

    The required-field omission (`vendor_name` left as None) is enforced
    by the frontend at mapping-confirm time and again by the
    `VendorCatalogCreate` validator when the catalog is finally saved —
    this schema itself doesn't enforce it, since a partially-mapped
    state is valid mid-wizard.

    Backend uses this shape only for the `suggested_mapping` field of
    `ParsedVendorUpload` (a hint the frontend may accept or override).
    The final user-confirmed mapping never round-trips through the API —
    the frontend applies it locally to assemble canonical entries that
    are then sent to `POST /vendor-catalogs`.

    Note: `aliases` accepts a single source column whose value the
    frontend will split on common separators (comma / semicolon / slash
    / pipe). Multi-column alias mapping isn't supported in this phase —
    it'd add UI complexity for very little real-world gain (most exports
    keep aliases in a single delimited column).
    """

    vendor_name: str | None = None
    vendor_code: str | None = None
    aliases: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    contact_name: str | None = None
    email: str | None = None
    phone: str | None = None
    active: str | None = None
    notes: str | None = None


class ParsedVendorUpload(BaseModel):
    """
    Result of `POST /vendor-catalogs/parse-upload`.

    One-shot parse: the file isn't stored. The parser surfaces the
    raw source data (header columns + data rows) and a best-effort
    `suggested_mapping` from BillsIQ's canonical vendor fields to
    source column names. The frontend then runs an EXPLICIT column-
    mapping step where the user confirms or overrides the suggestion
    before the canonical entries are assembled and sent to
    POST /vendor-catalogs.

    Why we deliberately don't pre-build entries here:
      * BillsIQ's canonical vendor schema (vendor_name / vendor_code /
        aliases / address / contact / etc.) is the source of truth.
        A raw uploaded file's column names can be anything — the user
        must explicitly confirm the mapping before any row becomes a
        canonical entry.
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
    suggested_mapping: VendorUploadMapping
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
# This is the canonical vendor list the frontend renders as a draft on
# first landing. Sized to be useful (not just a single-row toy) but
# small enough that the user can scan it and decide what to keep / edit.
#
# The starter rows are deliberately generic-multifamily vendor categories
# rather than real company names — every fresh draft starts here, and we
# don't want to nudge users toward specific vendor relationships. Real
# catalog rows will replace these on first edit / save.

_DEFAULT_ENTRIES: tuple[dict, ...] = (
    {
        "vendor_name": "City Water & Power",
        "vendor_code": "UTIL-001",
        "aliases": ["City W&P", "CWP Utilities"],
        "category_hint": "Utilities — water and electricity provider.",
    },
    {
        "vendor_name": "Acme Plumbing Services",
        "vendor_code": "MAINT-PLM-01",
        "aliases": ["Acme Plumbing", "Acme Plumb"],
        "category_hint": "Plumbing repair and maintenance.",
    },
    {
        "vendor_name": "GreenScape Landscaping",
        "vendor_code": "LAND-001",
        "aliases": ["GreenScape", "Green Scape Lawn Care"],
        "category_hint": "Grounds and landscaping vendor.",
    },
    {
        "vendor_name": "BugStop Pest Control",
        "vendor_code": "PEST-001",
        "aliases": ["BugStop", "Bug Stop Pest"],
        "category_hint": "Pest control service provider.",
    },
    {
        "vendor_name": "Reliable HVAC Co.",
        "vendor_code": "MAINT-HVAC-01",
        "aliases": ["Reliable HVAC", "Reliable Heating & Cooling"],
        "category_hint": "HVAC installation and repair.",
    },
    {
        "vendor_name": "SparkPro Electrical",
        "vendor_code": "MAINT-ELEC-01",
        "aliases": ["SparkPro", "Spark Pro Electric"],
        "category_hint": "Electrical contractor.",
    },
    {
        "vendor_name": "Property Insurance Group",
        "vendor_code": "INS-001",
        "aliases": ["PIG Insurance", "Property Insurance Grp"],
        "category_hint": "Property insurance carrier.",
    },
    {
        "vendor_name": "ClearView Window Cleaning",
        "vendor_code": "CLEAN-001",
        "aliases": ["ClearView Windows"],
        "category_hint": "Window cleaning service.",
    },
)


def build_default_catalog() -> VendorCatalogDefault:
    """Construct the canonical default catalog. Pure function — no I/O."""
    entries = [
        VendorCatalogEntry(
            id=f"d-{i}",
            vendor_name=row["vendor_name"],
            vendor_code=row["vendor_code"],
            aliases=list(row["aliases"]),
            address=None,
            city=None,
            state=None,
            zip=None,
            contact_name=None,
            email=None,
            phone=None,
            active=True,
            notes=row.get("category_hint"),
        )
        for i, row in enumerate(_DEFAULT_ENTRIES)
    ]
    return VendorCatalogDefault(
        name="Default Vendor Catalog",
        description=(
            "Built-in starter list of common multifamily vendor "
            "categories. Replace these with your real vendors — saving "
            "creates an independent copy you can keep refining. Aliases "
            "feed future invoice-payee matching once that's wired up."
        ),
        entries=entries,
    )
