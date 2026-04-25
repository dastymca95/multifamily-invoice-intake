"""
Pydantic shapes for the **Invoice Builder** module.

The Invoice Builder is a sibling product surface to:

  * Reference Data — saved catalogs (Vendors, Properties, GL Codes).
  * Import Builder — saved column/rule schemas for the final import
    output (`InvoiceTemplate`).

Invoice Builder rows describe **where on a real bill the canonical
extracted invoice fields physically live**. Each row (called a
"pattern" in the product copy, stored as `InvoicePattern`) bundles:

  * `source_files` — uploaded training docs (PDF / image) the operator
    drew on. Carried inline as a base64 data URL during the prototype
    phase; production will swap for object-storage refs without
    touching this shape.
  * `regions` — bbox-on-page annotations. Each region pins a canonical
    invoice field (e.g. `account_number`, `invoice_date`) to a
    rectangle on a specific page of a specific source file.
  * `vendor_hint` — informational free-text label for operator
    recognition. NOT a FK to vendor_catalog.

The canonical extracted-field universe is derived from the
`Invoice` SQLAlchemy model in `app/models/invoice.py` so the pattern
editor can never assign a region to a field the runtime extractor
doesn't understand. The enum lives here (single source of truth for
the API surface) and is mirrored on the frontend.

Import Builder integration:
  * Rule cells on `invoice_field` columns can OPTIONALLY reference a
    saved `InvoicePattern` + a canonical field
    (`extraction = { pattern_id, field_key }`) to narrow the
    extraction context for that row.
  * No rule cell set → extraction falls back to the broad universe
    of all saved patterns + OCR + AI inference. **Rule cells narrow,
    they are NOT required for extraction.**
  * The `extraction` field lives on `InvoiceTemplateRuleCell` (see
    `app/schemas/invoice_template.py`); the pattern row itself
    doesn't track which Import Builder rules reference it. This is a
    deliberate one-way reference so patterns and import templates
    can evolve independently.

Region/file integrity is application-enforced:
  * Each `regions[*].source_file_id` must reference one of
    `source_files[*].id` on the same pattern row. Enforced by the
    cross-field validator on the create/update payloads.
  * Bbox coordinates are normalized to [0, 1] so the renderer can
    scale to whatever DPI it's rendering the document at.
"""

import re
import uuid
from datetime import datetime
from typing import Literal

from app.domain.extracted_invoice_fields import (
    EXTRACTED_INVOICE_FIELD_LABELS,
    EXTRACTED_INVOICE_FIELDS,
    get_extracted_field_registry,
    normalize_extracted_field_key,
)
from pydantic import BaseModel, Field, field_validator, model_validator

# ---------------------------------------------------------------------------
# Bounds — chosen to keep JSONB payloads sane while accommodating the
# realistic upper end of operator authoring (a few training docs, a few
# dozen regions per pattern). All values picked to be comfortably above
# any hand-authored real-world pattern.
# ---------------------------------------------------------------------------

MAX_NAME_LENGTH = 255
MAX_DESCRIPTION_LENGTH = 2000
MAX_VENDOR_HINT_LENGTH = 255

# A pattern is meant to capture the layout of ONE bill format — typical
# operator workflow uploads 1-3 sample bills (e.g. a recent EPB bill +
# an older one with slight layout drift). 10 is the practical ceiling.
MAX_SOURCE_FILES = 10
MAX_FILE_NAME_LENGTH = 255
MAX_MIME_TYPE_LENGTH = 128
# 10 MB per file. Inline data URLs blow this up by ~33% in transit; the
# storage layer (JSONB) can handle it but we don't want a careless
# 50 MB scanned PDF dragged into the editor to silently bloat the row.
MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

# A bill might map ~20 canonical fields plus a handful of optional ones
# (account_number, meter_number, service_period, etc.); 200 lets the
# operator pin the same field on multiple training docs (e.g. one
# region per source_file for the same canonical field) without hitting
# a cap.
MAX_REGIONS = 200
MAX_REGION_LABEL_LENGTH = 200
MAX_REGION_NOTES_LENGTH = 500

# Polygon (free-form region) bounds. The data model accepts polygon
# regions even though the editor only draws rectangles today — see
# `RegionShape` below for the migration plan. A polygon needs at
# least 3 points to enclose an area; the cap stops a runaway hand-
# drawn lasso from bloating the JSONB row.
MIN_POLYGON_POINTS = 3
MAX_POLYGON_POINTS = 200

# Operator-edited field universe (custom fields + built-in overrides).
# Sized to comfortably fit the canonical universe (~21 fields) plus a
# realistic number of operator-added customs without bloating the row.
MAX_FIELD_DEFINITIONS = 100
MAX_FIELD_KEY_LENGTH = 64
MAX_FIELD_LABEL_LENGTH = 100

# Slug-shaped field-key regex. Lowercase ASCII alpha, digits, and
# underscores; must start with a letter. Matches the canonical field
# keys (e.g. `vendor_name`, `account_number`) AND any operator-coined
# custom key the editor produces from a label via slugify (e.g.
# `service_address`). Rejecting non-conforming keys prevents storage
# of garbage values that would never match anything at extraction
# time and would also break url-style references in future surfaces.
FIELD_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")

# Hex color shape — `#RRGGBB`. The frontend palette is the source of
# truth for which colors operators can pick; the schema only enforces
# that the persisted value is a syntactically valid CSS hex color so
# the renderer can pass it through to a `style="background:…"` slot
# without sanitization.
FIELD_COLOR_PATTERN = re.compile(r"^#[0-9A-Fa-f]{6}$")

# ---------------------------------------------------------------------------
# Canonical extracted invoice fields
# ---------------------------------------------------------------------------
#
# Single source of truth for the Invoice Builder's region-target
# universe. Mirrors the column set of `app/models/invoice.py`. Adding a
# new canonical field is a TWO-STEP change:
#
#   1. Add the column to the `Invoice` model (and ship a migration).
#   2. Add the literal here (and bump the corresponding frontend
#      `INVOICE_EXTRACTED_FIELDS` constant).
#
# Keep these in lockstep — a pattern that pins a region to a field
# missing from the model can never be extracted at runtime.
#
# Provenance fields (`extraction_confidence`, `raw_text_hash`) are
# deliberately excluded — they're computed by the extractor, not
# operator-pinned.

InvoiceExtractedField = str


# Tuple form for callers that need to iterate (e.g. seed UI, validators
# that work without typing.get_args). Kept in the same order as the
# Literal above for diff-friendliness.
INVOICE_EXTRACTED_FIELDS = EXTRACTED_INVOICE_FIELDS


# Human-friendly labels for the canonical fields. Surfaced in the
# region inspector dropdown / chip — the API ships these so the
# frontend doesn't have to maintain a parallel translation table that
# can drift from the backend's view of the canonical universe.
INVOICE_EXTRACTED_FIELD_LABELS = EXTRACTED_INVOICE_FIELD_LABELS


# ---------------------------------------------------------------------------
# Source file — one uploaded training document
# ---------------------------------------------------------------------------


class InvoicePatternSourceFile(BaseModel):
    """
    One uploaded training document inside a pattern.

    Carries the file inline as a base64 data URL (`data:<mime>;base64,…`).
    This keeps the prototype self-contained — no separate object-store
    dependency. When we move to production the data URL will be swapped
    for a storage key without touching any of the surrounding shape;
    callers can detect the storage mode by checking whether `data_url`
    starts with `data:` or with the chosen scheme prefix.

    `id` is generated client-side (so the pattern editor can reference
    a freshly-added file in newly-drawn regions before the first save
    round-trip). Stored as a non-empty short string rather than a strict
    UUID so the editor's `f"f-{idx}"` style keys are valid.

    `page_count` is reported by the uploader (PDF page total or 1 for
    images). The region validator uses it to bound region.page so a
    region can't reference a non-existent page.
    """

    id: str = Field(min_length=1, max_length=64)
    file_name: str = Field(min_length=1, max_length=MAX_FILE_NAME_LENGTH)
    mime_type: str = Field(min_length=1, max_length=MAX_MIME_TYPE_LENGTH)
    # Reported size in bytes — informational. We don't rederive it from
    # `data_url` to avoid a base64 decode round-trip on every read.
    size_bytes: int = Field(ge=0, le=MAX_FILE_SIZE_BYTES)
    # Pages in the document. 1 for images. Bounds region.page below.
    page_count: int = Field(default=1, ge=1, le=500)
    # Inline payload as a data URL. Optional in case a future caller
    # ships the metadata without the bytes (e.g. summary list view that
    # strips the heavy field). Empty string is allowed but discouraged.
    data_url: str = Field(default="", max_length=MAX_FILE_SIZE_BYTES * 2)
    # When the file was uploaded — preserved across saves, set by the
    # API on first upload. Naive ISO string from the client is tolerated
    # (Pydantic parses it to datetime), the API stamps the canonical
    # value on POST.
    uploaded_at: datetime | None = None
    # 1-based page numbers the operator hid via the editor's "Delete
    # page" affordance. Pages stay physically present in the data URL
    # — the renderer just skips them, and so does the runtime
    # extractor. Defaults to `[]` so legacy rows materialise as "no
    # pages deleted". Each entry must be unique, sorted, and within
    # `[1, page_count]`; the validator enforces.
    deleted_pages: list[int] = Field(default_factory=list)

    @field_validator("file_name")
    @classmethod
    def _strip_file_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("file_name cannot be blank")
        return v

    @field_validator("mime_type")
    @classmethod
    def _strip_mime_type(cls, v: str) -> str:
        v = v.strip().lower()
        if not v:
            raise ValueError("mime_type cannot be blank")
        return v

    @model_validator(mode="after")
    def _check_deleted_pages(self) -> "InvoicePatternSourceFile":
        # Per-entry bounds + uniqueness. Sorting is normalised here so
        # the persisted shape is always deterministic regardless of the
        # order the editor pushed entries in.
        if not self.deleted_pages:
            return self
        for p in self.deleted_pages:
            if not isinstance(p, int) or isinstance(p, bool):
                raise ValueError("deleted_pages entries must be integers")
            if p < 1 or p > self.page_count:
                raise ValueError(
                    f"deleted_pages entry {p} is outside [1, {self.page_count}]"
                )
        if len(set(self.deleted_pages)) != len(self.deleted_pages):
            raise ValueError("deleted_pages entries must be unique")
        # Refusing to delete EVERY page on the file. An empty file is
        # the same shape as no file at all, but with the bytes still
        # taking up the JSONB payload — operator should remove the
        # file outright instead. This also makes downstream "first
        # visible page" logic simpler (it can rely on at least one).
        if len(self.deleted_pages) >= self.page_count:
            raise ValueError(
                "deleted_pages cannot cover every page — remove the file instead"
            )
        # Normalise to sorted unique. Mutating in place is fine post-
        # validation; the model is still mid-construction here.
        self.deleted_pages = sorted(set(self.deleted_pages))
        return self


# ---------------------------------------------------------------------------
# Region — one bbox-on-page annotation
# ---------------------------------------------------------------------------


class InvoiceRegionBBox(BaseModel):
    """
    Normalized bounding box on the page, with all four coordinates in
    the [0, 1] range (`0` = top-left of page, `1` = bottom-right). The
    renderer scales these to whatever pixel grid it's rendering the
    document at, so the same pattern stays correct across DPIs and
    viewport sizes.

    `w` and `h` are width and height (NOT x2 / y2) so a malformed bbox
    (e.g. negative width from a drag in the wrong direction) is rejected
    cleanly at the schema layer rather than producing a silently
    inverted region.
    """

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    w: float = Field(gt=0.0, le=1.0)
    h: float = Field(gt=0.0, le=1.0)

    @model_validator(mode="after")
    def _check_bounds(self) -> "InvoiceRegionBBox":
        # Reject regions that extend past the page edge. A small float
        # rounding fudge would let `x + w == 1.0000001` through; we
        # don't bother — the editor is the producer and snaps to the
        # page boundary, so any over-by-epsilon here is a real bug.
        if self.x + self.w > 1.0:
            raise ValueError("bbox extends past page right edge (x + w > 1)")
        if self.y + self.h > 1.0:
            raise ValueError("bbox extends past page bottom edge (y + h > 1)")
        return self


# Region shape discriminator. Today every region is a rectangle
# (`bbox`); polygon support lands behind a tool-mode placeholder in a
# follow-up that fills out the editor surface. The data model accepts
# both now so the wire shape can stay stable across that release.
#
# Backward compat: `shape` defaults to `"rect"` so legacy rows
# (persisted before the column existed) materialise as rectangles.
RegionShape = Literal["rect", "polygon"]


class InvoiceRegionPoint(BaseModel):
    """
    One vertex of a polygon region. Coordinates normalised to `[0, 1]`
    (top-left = (0, 0)) — same coordinate system as
    `InvoiceRegionBBox`. Three or more points define an enclosed area;
    the polygon is implicitly closed (last vertex connects back to the
    first).
    """

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)


class InvoicePatternRegion(BaseModel):
    """
    One bbox-on-page annotation pinning an extracted field to a
    rectangle on a specific page of a specific source file.

    `source_file_id` is loose-typed (string) for the same reason
    `InvoicePatternSourceFile.id` is — the editor generates ids before
    server round-trip. The cross-field validator on the create/update
    payloads enforces that every region's `source_file_id` matches one
    of the row's source files.

    `field_key` is the field this region is pinned to. Two flavors
    co-exist on the same column:

      * Canonical keys (e.g. `account_number`) — listed in the
        `InvoiceExtractedField` Literal; understood by the runtime
        extractor directly.
      * Custom keys (e.g. `service_address`) — operator-coined fields
        defined on the same row's `field_definitions`. The runtime
        treats these as opaque labels; downstream Import Builder
        consumption is rule-cell-driven.

    The schema validates the slug shape (FIELD_KEY_PATTERN) and lets
    BOTH flavors through. Frontend reconciles a region whose key isn't
    in either set as "Unknown field" + offers reassignment, so an
    operator-deleted custom field doesn't silently strand its regions.

    `label` is an optional short human-friendly tag for the region —
    defaults to the canonical field's display name on the frontend if
    blank. Useful when one canonical field has multiple regions (e.g.
    "account number — top of page" vs. "account number — remit slip")
    and the operator wants to disambiguate them.

    `notes` is operator scratch space (e.g. "this region only appears
    on bills from 2025-Q3 onwards") — preserved as-is.
    """

    id: str = Field(min_length=1, max_length=64)
    source_file_id: str = Field(min_length=1, max_length=64)
    page: int = Field(ge=1, le=500)
    bbox: InvoiceRegionBBox
    field_key: str = Field(min_length=1, max_length=MAX_FIELD_KEY_LENGTH)
    label: str | None = Field(default=None, max_length=MAX_REGION_LABEL_LENGTH)
    notes: str | None = Field(default=None, max_length=MAX_REGION_NOTES_LENGTH)
    # Region shape. Defaults to "rect" so legacy rows (persisted before
    # the field existed) keep validating without migration. The editor
    # only draws rectangles today; polygon support lands later behind a
    # tool-mode placeholder, but the wire shape accepts both now so we
    # don't have to bump anything when it ships.
    shape: RegionShape = "rect"
    # Polygon vertices. Required when `shape == "polygon"`, must be
    # absent or empty for `shape == "rect"`. Each vertex is normalised
    # to [0, 1]. The model validator below enforces both branches.
    # `bbox` is still REQUIRED for polygon regions (used as the bounding
    # rectangle for hit testing + zoom-to-region) — the editor derives
    # it from the points before persisting.
    points: list[InvoiceRegionPoint] | None = Field(default=None)

    @field_validator("field_key")
    @classmethod
    def _validate_field_key(cls, v: str) -> str:
        v = v.strip().lower()
        if not FIELD_KEY_PATTERN.match(v):
            raise ValueError(
                "field_key must be slug-shaped: lowercase letter then "
                "letters/digits/underscores"
            )
        return v

    @field_validator("label")
    @classmethod
    def _strip_label(cls, v: str | None) -> str | None:
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

    @model_validator(mode="after")
    def _check_shape_points_consistency(self) -> "InvoicePatternRegion":
        # Rectangle: `points` must be unset or empty. Tolerating an
        # empty list (rather than just None) is intentional — the
        # frontend may serialise an empty array on a fresh rect region
        # and we'd rather accept it than 422 on a no-op shape.
        if self.shape == "rect":
            if self.points:
                raise ValueError(
                    "rect regions cannot carry `points`; clear it or "
                    "switch shape to 'polygon'"
                )
            # Normalise to None so the persisted shape is canonical.
            self.points = None
            return self
        # Polygon: must have at least MIN_POLYGON_POINTS vertices and
        # at most MAX_POLYGON_POINTS. Length cap is also enforced via
        # explicit check (rather than Field(max_length=)) so we get a
        # consistent error message regardless of the entry path.
        if self.shape == "polygon":
            if not self.points:
                raise ValueError(
                    "polygon regions require `points` (at least "
                    f"{MIN_POLYGON_POINTS} vertices)"
                )
            if len(self.points) < MIN_POLYGON_POINTS:
                raise ValueError(
                    f"polygon regions need at least {MIN_POLYGON_POINTS} "
                    f"points (got {len(self.points)})"
                )
            if len(self.points) > MAX_POLYGON_POINTS:
                raise ValueError(
                    f"polygon regions support at most {MAX_POLYGON_POINTS} "
                    f"points (got {len(self.points)})"
                )
        return self


# ---------------------------------------------------------------------------
# Field definitions — operator-edited extraction-field universe
# ---------------------------------------------------------------------------


# `built_in` rows OVERRIDE a system canonical field (color/label/hidden).
# `custom` rows ARE the source of truth for an operator-coined field.
InvoicePatternFieldType = Literal["built_in", "custom"]


class InvoicePatternFieldDefinition(BaseModel):
    """
    One operator-edited entry in the pattern's extraction-field
    universe. Two flavors:

      * `type="built_in"` — overrides a canonical field's color, label,
        or visibility. Absence means "use the system default for this
        canonical field". Required for custom colors and the
        hide-from-dropdown affordance.
      * `type="custom"` — defines an operator-coined extraction field
        (e.g. "Service Address"). Required for any region whose
        `field_key` isn't in the canonical universe.

    Why this lives on the pattern row (not a workspace-wide table):
    extraction patterns ARE per-vendor / per-bill-format, and so are
    the fields the operator wants to extract. A workspace-wide field
    universe would conflate independent patterns. Per-pattern keeps
    the customization tightly coupled to where it's used.

    `key` is the persistent identifier — never auto-renamed when
    `label` changes, so saved regions stay valid. Slug-shaped (matches
    `FIELD_KEY_PATTERN`).

    `color` is a hex string (`#RRGGBB`). None means "fall back to the
    deterministic default for this key". Frontend palette is the
    source of truth for which colors operators can pick.

    `hidden` is a built-in-only affordance — lets the operator declutter
    the Draw-as dropdown by hiding canonical fields they don't use for
    the pattern. Custom fields are always visible (deletion is the
    "remove from dropdown" path for them).
    """

    key: str = Field(min_length=1, max_length=MAX_FIELD_KEY_LENGTH)
    label: str = Field(min_length=1, max_length=MAX_FIELD_LABEL_LENGTH)
    type: InvoicePatternFieldType
    color: str | None = Field(default=None, max_length=7)
    hidden: bool = False

    @field_validator("key")
    @classmethod
    def _validate_key(cls, v: str) -> str:
        v = v.strip().lower()
        if not FIELD_KEY_PATTERN.match(v):
            raise ValueError(
                "field key must be slug-shaped: lowercase letter then "
                "letters/digits/underscores"
            )
        return v

    @field_validator("label")
    @classmethod
    def _strip_label(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("field label cannot be blank")
        return v

    @field_validator("color")
    @classmethod
    def _validate_color(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if not FIELD_COLOR_PATTERN.match(v):
            raise ValueError("color must be hex like #RRGGBB")
        # Normalise to lowercase so persisted values compare cleanly.
        return v.lower()


# ---------------------------------------------------------------------------
# Create / update / response payloads
# ---------------------------------------------------------------------------


def _check_region_file_consistency(
    source_files: list[InvoicePatternSourceFile],
    regions: list[InvoicePatternRegion],
) -> None:
    """
    Application-enforced integrity: every region.source_file_id must
    match a source_files[*].id on the same row, AND region.page must
    fit inside that file's page_count, AND must not point at a page
    the operator deleted.

    Raises ValueError with a specific message — Pydantic model
    validators surface this as a 422 with the field path included.

    Page-deletion contract: a region cannot reference a page that
    appears in the file's `deleted_pages` list. The editor enforces
    this on its end via cascade-delete (deleting a page removes its
    regions through the undo stack), so a 422 here means a payload
    constructed manually or out of band.
    """
    file_index: dict[str, InvoicePatternSourceFile] = {f.id: f for f in source_files}
    for r in regions:
        owner = file_index.get(r.source_file_id)
        if owner is None:
            raise ValueError(
                f"region {r.id!r} references unknown source_file_id "
                f"{r.source_file_id!r}"
            )
        if r.page > owner.page_count:
            raise ValueError(
                f"region {r.id!r} references page {r.page} but source "
                f"file {owner.id!r} only has {owner.page_count} page(s)"
            )
        if owner.deleted_pages and r.page in owner.deleted_pages:
            raise ValueError(
                f"region {r.id!r} references page {r.page} of source "
                f"file {owner.id!r}, which has been deleted"
            )


def _check_unique_ids(
    items: list, *, label: str
) -> None:
    """Reusable id-uniqueness check for source_files and regions lists."""
    ids = [it.id for it in items]
    if len(ids) != len(set(ids)):
        raise ValueError(f"{label} ids must be unique within the pattern")


def _check_unique_field_keys(
    field_definitions: list[InvoicePatternFieldDefinition],
) -> None:
    """Field keys must be unique within the pattern's field universe."""
    keys = [d.key for d in field_definitions]
    if len(keys) != len(set(keys)):
        raise ValueError("field_definitions must have unique keys")


class InvoicePatternCreate(BaseModel):
    """Body for POST /invoice-patterns."""

    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION_LENGTH)
    vendor_hint: str | None = Field(default=None, max_length=MAX_VENDOR_HINT_LENGTH)
    # Both lists default to empty so the operator can create an empty
    # pattern shell, name it, and start uploading + drawing inside the
    # editor without an extra "you must include at least one file" gate.
    source_files: list[InvoicePatternSourceFile] = Field(
        default_factory=list, max_length=MAX_SOURCE_FILES
    )
    regions: list[InvoicePatternRegion] = Field(
        default_factory=list, max_length=MAX_REGIONS
    )
    # Operator-edited extraction-field universe. Optional / defaults to
    # empty so the legacy create-an-empty-pattern flow keeps working
    # exactly as before; an empty list means "all canonical fields
    # visible at default colors, no customs".
    field_definitions: list[InvoicePatternFieldDefinition] = Field(
        default_factory=list, max_length=MAX_FIELD_DEFINITIONS
    )

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name cannot be blank")
        return v

    @field_validator("description", "vendor_hint")
    @classmethod
    def _strip_optional_text(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None

    @model_validator(mode="after")
    def _check_consistency(self) -> "InvoicePatternCreate":
        _check_unique_ids(self.source_files, label="source_file")
        _check_unique_ids(self.regions, label="region")
        _check_unique_field_keys(self.field_definitions)
        _check_region_file_consistency(self.source_files, self.regions)
        return self


class InvoicePatternUpdate(BaseModel):
    """
    Body for PATCH /invoice-patterns/{id}. Every field optional.

    Sending `source_files`, `regions`, or `field_definitions` REPLACES
    the array (no per-row patching) — same replace-not-merge contract
    as `InvoiceTemplate`. None on a field means "leave the persisted
    value untouched".

    The cross-field consistency check fires only when BOTH
    `source_files` and `regions` are sent. If only one is sent, the
    validator can't compare against the persisted side; the API layer
    is responsible for re-running consistency post-merge against the
    in-memory row before saving (same pattern Import Builder uses for
    column/rule integrity).
    """

    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME_LENGTH)
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION_LENGTH)
    vendor_hint: str | None = Field(default=None, max_length=MAX_VENDOR_HINT_LENGTH)
    source_files: list[InvoicePatternSourceFile] | None = Field(
        default=None, max_length=MAX_SOURCE_FILES
    )
    regions: list[InvoicePatternRegion] | None = Field(
        default=None, max_length=MAX_REGIONS
    )
    field_definitions: list[InvoicePatternFieldDefinition] | None = Field(
        default=None, max_length=MAX_FIELD_DEFINITIONS
    )

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("name cannot be blank")
        return v

    @field_validator("description", "vendor_hint")
    @classmethod
    def _strip_optional_text(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None

    @model_validator(mode="after")
    def _check_consistency(self) -> "InvoicePatternUpdate":
        # Per-field uniqueness whenever the field is sent at all.
        if self.source_files is not None:
            _check_unique_ids(self.source_files, label="source_file")
        if self.regions is not None:
            _check_unique_ids(self.regions, label="region")
        if self.field_definitions is not None:
            _check_unique_field_keys(self.field_definitions)
        # Cross-field check — only meaningful when both are present in
        # the payload. The API layer must re-check post-merge.
        if self.source_files is not None and self.regions is not None:
            _check_region_file_consistency(self.source_files, self.regions)
        return self


class InvoicePatternOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    vendor_hint: str | None
    source_files: list[InvoicePatternSourceFile] = Field(default_factory=list)
    regions: list[InvoicePatternRegion] = Field(default_factory=list)
    field_definitions: list[InvoicePatternFieldDefinition] = Field(
        default_factory=list
    )
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class InvoicePatternSummary(BaseModel):
    """
    List-row shape — no `source_files` payload (heavy data URLs) or
    `regions` array. Carries counts for left-rail badges so the rail
    can render `"3 files · 12 regions"` without paying for the full
    rows up front.
    """

    id: uuid.UUID
    name: str
    description: str | None
    vendor_hint: str | None
    source_file_count: int = 0
    region_count: int = 0
    created_at: datetime
    updated_at: datetime


class InvoicePatternList(BaseModel):
    items: list[InvoicePatternSummary] = Field(default_factory=list)


class InvoiceExtractedFieldDescriptor(BaseModel):
    """
    Canonical-field descriptor surfaced via
    `GET /invoice-patterns/canonical-fields`. The frontend binds the
    region inspector dropdown to this list so the API stays the single
    source of truth.
    """

    key: str
    label: str
    description: str | None = None
    default_data_type: str | None = None
    aliases: list[str] = Field(default_factory=list)
    category: str | None = None
    built_in: bool = True
    commonly_required: bool = False
    output_only: bool = False


class InvoiceExtractedFieldsResponse(BaseModel):
    """Wrapper to keep the canonical-fields response future-extensible."""

    fields: list[InvoiceExtractedFieldDescriptor] = Field(default_factory=list)


def build_canonical_field_descriptors() -> list[InvoiceExtractedFieldDescriptor]:
    """Pure helper — assembles the canonical-fields list for the API."""
    return [
        InvoiceExtractedFieldDescriptor(
            key=field.key,
            label=field.label,
            description=field.description,
            default_data_type=field.default_data_type,
            aliases=list(field.aliases),
            category=field.category,
            built_in=field.built_in,
            commonly_required=field.commonly_required,
            output_only=field.output_only,
        )
        for field in get_extracted_field_registry()
    ]


# ---------------------------------------------------------------------------
# Per-pattern field options — lightweight payload for the Import Builder
# extraction-binding picker. Returns just the field universe for one
# pattern (canonical built-ins minus the operator's hide overrides,
# plus operator-coined custom fields). NEVER includes source files —
# the picker would otherwise pay the base64 cost on every render.
# ---------------------------------------------------------------------------


class InvoicePatternFieldOption(BaseModel):
    """
    One field a rule cell can bind to within a specific saved pattern.

    Rolled up from BOTH the canonical built-in universe and the
    pattern's operator-edited `field_definitions` overrides:

      * Canonical built-ins (e.g. `vendor_name`, `account_number`)
        appear with `type="built_in"` and the system label, unless the
        operator pinned an override on this pattern (custom label or
        custom color) — in which case the override wins.
      * Operator-coined custom fields (`type="custom"`) appear in the
        order they live on the pattern row.

    `hidden=True` means the operator declutterd the Draw-as dropdown
    by hiding this canonical field from the pattern. The picker
    EXCLUDES hidden fields from new picks by default but keeps
    surfacing them when an existing rule cell is bound to one (so the
    operator sees what's there and can clear it). Filtering is the
    consumer's responsibility — this payload reports the truth.

    `region_count` / `region_pages` carry pattern-level usage so the
    Import Builder picker can warn "(no region drawn yet)" or hint
    "5 regions on pages 1, 2, 3" without re-fetching the full pattern.
    Default 0 / `[]` so callers that don't pass `regions` (e.g. the
    coverage service, which doesn't need usage) pay nothing extra.

    Response shape stays compatible with `InvoicePatternFieldDefinition`
    plus a synthesized `built_in` row for every canonical key so the
    frontend doesn't have to fold against a separate canonical-fields
    endpoint to render the dropdown.
    """

    key: str = Field(min_length=1, max_length=MAX_FIELD_KEY_LENGTH)
    label: str = Field(min_length=1, max_length=MAX_FIELD_LABEL_LENGTH)
    type: InvoicePatternFieldType
    color: str | None = Field(default=None, max_length=7)
    # Built-in only: canonical fields the operator hid from this
    # pattern's Draw-as dropdown. False / absent on customs.
    hidden: bool = False
    # Reverse-awareness counters — number of regions on this pattern
    # pinned to this `key`, and the sorted-unique 1-based page numbers
    # those regions live on. Default 0 / `[]` for callers that don't
    # pass `regions` to the builder.
    region_count: int = 0
    region_pages: list[int] = Field(default_factory=list)


class InvoicePatternFieldOptionsResponse(BaseModel):
    """
    Response shape for `GET /invoice-patterns/{id}/fields`.

    `pattern_id` is echoed back so the frontend cache (which keys by
    pattern id) can sanity-check the response matches its request — a
    cheap defense against a router misroute or a swap-after-fetch race.

    `items` is the resolved field option universe — see
    `InvoicePatternFieldOption` for the per-row contract. Order is
    stable: built-ins in canonical order first, then custom fields in
    their persisted order.
    """

    pattern_id: str
    items: list[InvoicePatternFieldOption] = Field(default_factory=list)


def build_pattern_field_options(
    field_definitions: list[InvoicePatternFieldDefinition] | None,
    regions: list[InvoicePatternRegion] | None = None,
) -> list[InvoicePatternFieldOption]:
    """
    Assemble the per-pattern field option universe.

    Order:
      1. Canonical built-ins, in `INVOICE_EXTRACTED_FIELDS` order. Each
         carries the operator's override (label / color / hidden) when
         one exists, else the system defaults (system label, no color
         override, not hidden).
      2. Custom fields, in the order they live on the pattern. Skipped
         for built-in keys (a `field_definitions` row of type=built_in
         with a key matching a canonical field is treated as an
         override of that built-in, not a duplicate).

    `regions` (optional) — when supplied, each option carries
    pattern-level usage counters (`region_count` and sorted-unique
    `region_pages`). Drives the Import Builder picker's reverse-
    awareness UI without forcing the caller to do its own join.
    Omitting `regions` keeps the legacy zero-cost path (counts default
    to 0 / `[]`).

    Defensive against malformed data: a `field_definitions` row whose
    `key` doesn't match any canonical field AND whose `type` is
    `built_in` is treated as a stale row (the canonical universe
    presumably shrunk) and skipped — better than a corrupt-looking
    "phantom built-in" surfacing in the dropdown.
    """
    overrides_by_key: dict[str, InvoicePatternFieldDefinition] = {}
    customs: list[InvoicePatternFieldDefinition] = []
    for d in field_definitions or []:
        if d.type == "built_in":
            normalized_key = normalize_extracted_field_key(d.key) or d.key
            overrides_by_key[normalized_key] = d
        else:
            customs.append(d)

    custom_keys = {d.key for d in customs}

    def _field_usage_key(key: str) -> str:
        if key in custom_keys:
            return key
        return normalize_extracted_field_key(key) or key

    # Pre-aggregate region usage once so the per-option resolution
    # below is O(1). Pages stored as raw lists during the gather step;
    # sorted-unique lifted out at construction time.
    pages_by_key: dict[str, list[int]] = {}
    for r in regions or []:
        pages_by_key.setdefault(_field_usage_key(r.field_key), []).append(r.page)

    def _usage(key: str) -> tuple[int, list[int]]:
        pages = pages_by_key.get(key)
        if not pages:
            return (0, [])
        return (len(pages), sorted(set(pages)))

    options: list[InvoicePatternFieldOption] = []
    # 1. Built-ins, with overrides folded in.
    for key in INVOICE_EXTRACTED_FIELDS:
        override = overrides_by_key.get(key)
        rc, rp = _usage(key)
        if override is not None:
            options.append(
                InvoicePatternFieldOption(
                    key=key,
                    label=override.label,
                    type="built_in",
                    color=override.color,
                    hidden=override.hidden,
                    region_count=rc,
                    region_pages=rp,
                )
            )
        else:
            options.append(
                InvoicePatternFieldOption(
                    key=key,
                    label=INVOICE_EXTRACTED_FIELD_LABELS.get(key, key),
                    type="built_in",
                    color=None,
                    hidden=False,
                    region_count=rc,
                    region_pages=rp,
                )
            )

    # 2. Custom fields. Skip any whose key collides with a canonical
    # built-in (we already surfaced the canonical row above; a custom
    # row with the same key would be a confusing dup).
    canonical_keys = set(INVOICE_EXTRACTED_FIELDS)
    for d in customs:
        if d.key in canonical_keys:
            continue
        rc, rp = _usage(d.key)
        options.append(
            InvoicePatternFieldOption(
                key=d.key,
                label=d.label,
                type="custom",
                color=d.color,
                hidden=False,
                region_count=rc,
                region_pages=rp,
            )
        )

    return options
