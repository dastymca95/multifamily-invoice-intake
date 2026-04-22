"""
ResMan import preview — pure logic.

Builds a spreadsheet-shaped preview of how the future ResMan-ready
import file would look, given:

  * an uploaded import template (its parsed column headers ARE the
    preview's column structure);
  * the three uploaded reference reports (properties / units / vendors),
    used as lookup pools to populate or validate matched fields;
  * up to N recently approved invoices, used as the source for the
    "live" rows. When no approved invoices exist yet, we fall back to a
    synthetic preview built from the reference reports' sample rows so
    the user still sees the table shape.

This module is intentionally framework-free: no DB, no HTTP, no
Pydantic. It takes plain-Python inputs (the API layer pulls them from
SQLAlchemy) and returns a `PreviewResult` dataclass that the schema
layer turns into JSON. That makes it cheap to unit-test the matching
heuristics later without spinning up a session.

What it deliberately does NOT do (yet):
  * No fuzzy matching (Levenshtein, token-set ratio). Matching is
    case-insensitive whitespace-normalised string equality only — small
    enough to reason about and honest about its blind spots.
  * No multi-row matching ("which vendor row best fits this invoice?").
    A vendor name either matches one entry in the report or it doesn't.
  * No persistence of mapping rules. The role classifier is hardcoded
    keyword tables; per-customer overrides come in a future phase.
  * No reading of the FULL reference file from storage — we only see
    the up-to-5 sample rows the parser persisted. This means the lookup
    pool is the sample rows, not the entire report. The UI surfaces this
    limitation honestly via a note rather than silently mismatching.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Iterable, Literal, Sequence

# ---------------------------------------------------------------------------
# Type aliases
# ---------------------------------------------------------------------------

ColumnRole = Literal[
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

CellStatus = Literal["ok", "unresolved", "unmapped"]

CellSource = Literal[
    "vendor_report",
    "property_report",
    "unit_report",
    "invoice",
    "synthetic",
]

ReferenceSource = Literal[
    "vendor_report",
    "property_report",
    "unit_report",
    "import_template",
]

# How many real-invoice rows to surface by default. Eight fits comfortably
# in the panel without scrolling on a typical laptop.
DEFAULT_PREVIEW_ROW_LIMIT = 8

# ---------------------------------------------------------------------------
# Column-role classifier
# ---------------------------------------------------------------------------
#
# Template column names are arbitrary strings the customer chose when
# they built their ResMan import. We can't enumerate every possible
# wording, but a small priority-ordered keyword table catches the
# overwhelming majority of real-world ResMan templates without false
# positives.
#
# Order matters: more specific patterns must come before more general
# ones (e.g. "vendor id" before "vendor"). First match wins.
#
# Patterns are matched against the *normalised* column name (lowercased,
# non-alphanumeric characters collapsed to single spaces) so "Vendor ID",
# "vendor_id", "Vendor#ID", and "VENDOR  ID" all map to the same role.

_RolePattern = tuple[ColumnRole, tuple[str, ...]]

_ROLE_PATTERNS: tuple[_RolePattern, ...] = (
    # ---- Vendor (id before name) ---------------------------------------
    ("vendor_id", ("vendor id", "vendor code", "vendor no", "vendor number", "vendorid", "supplier id", "supplier code")),
    ("vendor_name", ("vendor name", "vendor", "supplier", "payee", "company name", "biller")),
    # ---- Property (code/abbrev before name) ----------------------------
    (
        "property_code",
        (
            "property code", "property abbrev", "property abbreviation",
            "property id", "prop code", "prop abbrev", "property short",
            "site code", "community code",
        ),
    ),
    ("property_name", ("property name", "property", "site", "community", "building")),
    # ---- Unit / Location -----------------------------------------------
    # ResMan calls the per-unit field "Location"; map both wordings to a
    # unit-report-driven cell.
    ("location", ("location",)),
    ("unit", ("unit number", "unit", "apartment", "apt", "unit id")),
    # ---- Invoice metadata ----------------------------------------------
    ("invoice_number", ("invoice number", "invoice no", "invoice id", "invoice #", "inv number", "inv no", "invoice ref", "reference number", "ref no", "ref number", "bill number")),
    # Date roles: more-specific dues before invoice_date's bare "date"
    # fallback, otherwise "Due Date" classifies as invoice_date.
    ("due_date", ("due date", "due")),
    ("invoice_date", ("invoice date", "inv date", "bill date", "transaction date", "date")),
    # ---- Amounts (specifics before "amount") ---------------------------
    ("amount_subtotal", ("subtotal", "sub total", "net amount", "net")),
    ("amount_tax", ("tax amount", "tax", "vat", "gst", "sales tax")),
    ("amount_total", ("total amount", "amount due", "invoice amount", "total", "amount", "gross", "balance")),
    # ---- Misc ----------------------------------------------------------
    ("currency", ("currency", "ccy")),
    ("account_number", ("account number", "account no", "account #", "account")),
    ("description", ("description", "memo", "notes", "details", "narrative")),
    ("gl_code", ("gl code", "gl account", "gl", "account code", "expense code", "category")),
)

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _norm(s: str) -> str:
    """
    Lowercase + collapse runs of non-alphanumerics to single spaces.

    Used both for column-role classification ("Vendor_ID" → "vendor id")
    and value matching ("Acme  Plumbing, Inc." vs "acme plumbing inc").
    """
    return _NON_ALNUM.sub(" ", (s or "").lower()).strip()


def classify_column(name: str) -> ColumnRole:
    """Map a template column header to a known role, or 'unmapped'."""
    norm = _norm(name)
    if not norm:
        return "unmapped"
    for role, keywords in _ROLE_PATTERNS:
        for kw in keywords:
            # Substring match on the normalised string. Anchored words
            # would be safer in theory but real templates do things like
            # "Vendor Name (required)" so we accept a containment match.
            if kw in norm:
                return role
    return "unmapped"


# Roles → which uploaded reference report (if any) is the canonical source.
_ROLE_TO_REFERENCE: dict[ColumnRole, ReferenceSource | None] = {
    "vendor_name": "vendor_report",
    "vendor_id": "vendor_report",
    "property_name": "property_report",
    "property_code": "property_report",
    "unit": "unit_report",
    "location": "unit_report",
    # Invoice-derived roles aren't backed by a reference report.
    "invoice_number": None,
    "invoice_date": None,
    "due_date": None,
    "amount_total": None,
    "amount_subtotal": None,
    "amount_tax": None,
    "currency": None,
    "description": None,
    "account_number": None,
    "gl_code": None,
    "unmapped": None,
}


def reference_for_role(role: ColumnRole) -> ReferenceSource | None:
    return _ROLE_TO_REFERENCE.get(role)


# ---------------------------------------------------------------------------
# Reference indexer
# ---------------------------------------------------------------------------
#
# For each reference report we need to pick the "name" column (the one
# we'll match invoice values against) and, where applicable, an "id /
# code" column (what the export needs to emit). Same priority-ordered
# keyword approach as the role classifier.

_ReferenceColumnPick = tuple[str, ...]  # ordered keyword candidates

_NAME_COLUMN_HINTS: dict[ReferenceSource, _ReferenceColumnPick] = {
    "vendor_report": ("vendor name", "vendor", "supplier", "payee", "company name", "name"),
    "property_report": ("property name", "property", "site", "community", "name"),
    "unit_report": ("unit name", "unit", "unit number", "apartment", "apt", "name"),
}

_CODE_COLUMN_HINTS: dict[ReferenceSource, _ReferenceColumnPick] = {
    "vendor_report": ("vendor id", "vendor code", "vendor no", "vendor number", "code", "id"),
    "property_report": ("property code", "property abbrev", "property abbreviation", "property id", "code", "abbrev", "abbreviation", "id"),
    "unit_report": ("unit id", "unit code", "code", "id"),
}


def _pick_column(columns: Sequence[str], hints: _ReferenceColumnPick) -> str | None:
    """
    Return the first column whose normalised form contains any hint.

    Falls through to None rather than guessing — the caller decides
    whether to fall back to "first column" or skip the lookup entirely.
    """
    norm_cols = [(c, _norm(c)) for c in columns]
    for hint in hints:
        for raw, norm in norm_cols:
            if hint in norm:
                return raw
    return None


@dataclass
class ReferenceIndex:
    """
    A small in-memory lookup of one reference report's sample rows.

    `name_column` is the column we'll use to match invoice values
    against; `code_column` is what the export wants to emit. Either may
    be None if the report doesn't have an obvious match — the caller
    treats that as "no lookup possible".

    `by_name` maps the *normalised* name back to the original sample row
    so we can pull either the display name or the code from a hit.
    """

    source: ReferenceSource
    available: bool
    row_count: int  # total rows in the source (not just sampled)
    sample_rows: list[dict[str, str]]
    name_column: str | None = None
    code_column: str | None = None
    by_name: dict[str, dict[str, str]] = field(default_factory=dict)

    @classmethod
    def empty(cls, source: ReferenceSource) -> "ReferenceIndex":
        return cls(source=source, available=False, row_count=0, sample_rows=[])

    @classmethod
    def build(
        cls,
        source: ReferenceSource,
        columns: Sequence[str] | None,
        sample_rows: Sequence[dict[str, str]] | None,
        row_count: int | None,
    ) -> "ReferenceIndex":
        if not columns:
            return cls.empty(source)
        name_col = _pick_column(columns, _NAME_COLUMN_HINTS[source])
        code_col = _pick_column(columns, _CODE_COLUMN_HINTS[source])
        # If we couldn't pick a name column, fall back to the first
        # column. It's a guess, but for an unknown layout it's better
        # than emitting nothing.
        if name_col is None and columns:
            name_col = columns[0]

        rows = [dict(r) for r in (sample_rows or [])]
        by_name: dict[str, dict[str, str]] = {}
        if name_col:
            for row in rows:
                key = _norm(row.get(name_col, ""))
                if key and key not in by_name:
                    by_name[key] = row

        return cls(
            source=source,
            available=True,
            row_count=row_count or len(rows),
            sample_rows=rows,
            name_column=name_col,
            code_column=code_col,
            by_name=by_name,
        )

    def lookup(self, value: str | None) -> dict[str, str] | None:
        """Find the reference row matching `value` by normalised name."""
        if not value:
            return None
        return self.by_name.get(_norm(value))


# ---------------------------------------------------------------------------
# Row builder — invoice-driven
# ---------------------------------------------------------------------------

@dataclass
class InvoiceFacts:
    """
    Just the invoice fields the preview cares about, lifted out of the
    SQLAlchemy model so the domain layer stays ORM-free.
    """

    invoice_id: str  # uuid stringified — used only for row labelling
    vendor_name: str | None
    property_name: str | None
    property_code: str | None
    invoice_number: str | None
    invoice_date: date | None
    due_date: date | None
    total_amount: Decimal | None
    subtotal: Decimal | None
    tax_amount: Decimal | None
    currency: str | None
    account_number: str | None
    first_line_description: str | None  # one-liner from the first invoice line


@dataclass
class Cell:
    value: str | None
    status: CellStatus
    source: CellSource | None = None
    note: str | None = None


@dataclass
class PreviewRow:
    label: str
    origin: Literal["invoice", "synthetic"]
    cells: list[Cell]


@dataclass
class ColumnInfo:
    name: str
    role: ColumnRole
    populated_from: ReferenceSource | None  # which report (if any) backs this column
    # True when the role was set by a user-saved Import Builder
    # override (rather than the auto-classifier). Surfaced in the UI so
    # the user can see which columns they've manually pinned.
    role_overridden: bool = False


@dataclass
class Contribution:
    source: ReferenceSource
    label: str
    available: bool
    row_count: int | None
    columns_powered: list[str]
    note: str | None = None


@dataclass
class PreviewResult:
    has_template: bool
    template_filename: str | None
    columns: list[ColumnInfo]
    rows: list[PreviewRow]
    contributions: list[Contribution]
    notes: list[str]


# ---------------------------------------------------------------------------
# Cell resolution
# ---------------------------------------------------------------------------


def _date_str(d: date | None) -> str | None:
    return d.isoformat() if d else None


def _decimal_str(n: Decimal | None) -> str | None:
    if n is None:
        return None
    # Two-decimal display — ResMan templates almost always expect money
    # to two places. Quantize defensively in case the DB stored more.
    return f"{n.quantize(Decimal('0.01'))}"


def _resolve_invoice_cell(
    role: ColumnRole,
    invoice: InvoiceFacts,
    vendor_idx: ReferenceIndex,
    property_idx: ReferenceIndex,
    unit_idx: ReferenceIndex,
) -> Cell:
    """Compute one cell for one (role, invoice) pair."""

    # ---- Vendor lookups -------------------------------------------------
    if role == "vendor_name":
        if not invoice.vendor_name:
            return Cell(value=None, status="unresolved", source="invoice", note="No vendor extracted")
        hit = vendor_idx.lookup(invoice.vendor_name)
        if hit and vendor_idx.name_column:
            return Cell(
                value=hit.get(vendor_idx.name_column, invoice.vendor_name),
                status="ok",
                source="vendor_report",
                note="Matched against vendor report",
            )
        # No vendor report match — surface the extracted value but flag.
        return Cell(
            value=invoice.vendor_name,
            status="unresolved",
            source="invoice",
            note=(
                "Extracted from invoice; no match in vendor report sample"
                if vendor_idx.available
                else "Extracted from invoice; vendor report not uploaded"
            ),
        )

    if role == "vendor_id":
        if not invoice.vendor_name:
            return Cell(value=None, status="unresolved", source=None, note="No vendor to look up")
        hit = vendor_idx.lookup(invoice.vendor_name)
        if hit and vendor_idx.code_column:
            val = hit.get(vendor_idx.code_column, "").strip()
            if val:
                return Cell(value=val, status="ok", source="vendor_report")
        return Cell(
            value=None,
            status="unresolved",
            source=None,
            note=(
                "Vendor not found in report sample"
                if vendor_idx.available
                else "Vendor report not uploaded"
            ),
        )

    # ---- Property lookups ---------------------------------------------
    if role == "property_name":
        if not invoice.property_name:
            return Cell(value=None, status="unresolved", source=None, note="No property extracted")
        hit = property_idx.lookup(invoice.property_name)
        if hit and property_idx.name_column:
            return Cell(
                value=hit.get(property_idx.name_column, invoice.property_name),
                status="ok",
                source="property_report",
            )
        return Cell(
            value=invoice.property_name,
            status="unresolved",
            source="invoice",
            note=(
                "Extracted from invoice; no match in property report sample"
                if property_idx.available
                else "Extracted from invoice; property report not uploaded"
            ),
        )

    if role == "property_code":
        # Prefer the property report's code column when we can match the name.
        if invoice.property_name:
            hit = property_idx.lookup(invoice.property_name)
            if hit and property_idx.code_column:
                val = hit.get(property_idx.code_column, "").strip()
                if val:
                    return Cell(value=val, status="ok", source="property_report")
        # Fall back to the code the extractor pulled directly from the invoice.
        if invoice.property_code:
            return Cell(
                value=invoice.property_code,
                status="unresolved",
                source="invoice",
                note="Extracted from invoice; not validated against property report",
            )
        return Cell(value=None, status="unresolved", source=None)

    # ---- Unit / Location ----------------------------------------------
    if role in ("unit", "location"):
        # Today's invoice schema doesn't carry a unit field — we'd need
        # to extract it from line items. That's a future phase; mark
        # unresolved but explain why.
        if unit_idx.available:
            return Cell(
                value=None,
                status="unresolved",
                source=None,
                note="No unit field on extracted invoice yet — needs line-item parsing",
            )
        return Cell(value=None, status="unresolved", source=None, note="Unit report not uploaded")

    # ---- Direct invoice fields ----------------------------------------
    if role == "invoice_number":
        return _ok_or_blank(invoice.invoice_number, "invoice")
    if role == "invoice_date":
        return _ok_or_blank(_date_str(invoice.invoice_date), "invoice")
    if role == "due_date":
        return _ok_or_blank(_date_str(invoice.due_date), "invoice")
    if role == "amount_total":
        return _ok_or_blank(_decimal_str(invoice.total_amount), "invoice")
    if role == "amount_subtotal":
        return _ok_or_blank(_decimal_str(invoice.subtotal), "invoice")
    if role == "amount_tax":
        return _ok_or_blank(_decimal_str(invoice.tax_amount), "invoice")
    if role == "currency":
        return _ok_or_blank(invoice.currency, "invoice")
    if role == "account_number":
        return _ok_or_blank(invoice.account_number, "invoice")
    if role == "description":
        return _ok_or_blank(invoice.first_line_description, "invoice")

    if role == "gl_code":
        return Cell(
            value=None,
            status="unresolved",
            source=None,
            note="GL coding not implemented yet — future phase",
        )

    # role == "unmapped"
    return Cell(
        value=None,
        status="unmapped",
        source=None,
        note="Template column has no recognised role yet",
    )


def _ok_or_blank(value: str | None, source: CellSource) -> Cell:
    if value is None or value == "":
        return Cell(value=None, status="unresolved", source=source, note="Field blank on invoice")
    return Cell(value=value, status="ok", source=source)


# ---------------------------------------------------------------------------
# Row builders
# ---------------------------------------------------------------------------


def _row_label_for_invoice(inv: InvoiceFacts) -> str:
    if inv.invoice_number:
        return f"Invoice {inv.invoice_number}"
    return f"Invoice {inv.invoice_id[:8]}"


def _build_invoice_row(
    invoice: InvoiceFacts,
    columns: Sequence[ColumnInfo],
    vendor_idx: ReferenceIndex,
    property_idx: ReferenceIndex,
    unit_idx: ReferenceIndex,
) -> PreviewRow:
    cells = [
        _resolve_invoice_cell(c.role, invoice, vendor_idx, property_idx, unit_idx)
        for c in columns
    ]
    return PreviewRow(
        label=_row_label_for_invoice(invoice),
        origin="invoice",
        cells=cells,
    )


def _build_synthetic_rows(
    columns: Sequence[ColumnInfo],
    vendor_idx: ReferenceIndex,
    property_idx: ReferenceIndex,
    unit_idx: ReferenceIndex,
    max_rows: int = 5,
) -> list[PreviewRow]:
    """
    Build preview rows from the reference samples when no approved
    invoices are available yet. We zip the three reports' sample rows
    positionally so each row reads like a plausible "if invoice N came
    from vendor sample N at property sample N…" demonstration.

    Honest caveats:
      * The pairing is positional, not semantic — there's no claim that
        sample-vendor 1 actually serves sample-property 1.
      * Invoice-derived columns (number, date, amount, …) stay blank
        with status "unresolved" and a note, since synthetic rows have
        no invoice to draw from.
    """
    n = max(
        min(len(vendor_idx.sample_rows), 5) if vendor_idx.sample_rows else 0,
        min(len(property_idx.sample_rows), 5) if property_idx.sample_rows else 0,
        min(len(unit_idx.sample_rows), 5) if unit_idx.sample_rows else 0,
    )
    if n == 0:
        return []
    n = min(n, max_rows)

    rows: list[PreviewRow] = []
    for i in range(n):
        cells: list[Cell] = []
        for col in columns:
            cells.append(
                _synthetic_cell(col.role, i, vendor_idx, property_idx, unit_idx)
            )
        rows.append(
            PreviewRow(label=f"Sample row {i + 1}", origin="synthetic", cells=cells)
        )
    return rows


def _synthetic_cell(
    role: ColumnRole,
    i: int,
    vendor_idx: ReferenceIndex,
    property_idx: ReferenceIndex,
    unit_idx: ReferenceIndex,
) -> Cell:
    def _from(idx: ReferenceIndex, col: str | None, source: CellSource) -> Cell:
        if not col or i >= len(idx.sample_rows):
            return Cell(value=None, status="unresolved", source=None)
        val = (idx.sample_rows[i].get(col) or "").strip()
        if not val:
            return Cell(value=None, status="unresolved", source=source)
        return Cell(value=val, status="ok", source=source, note="From reference sample")

    if role in ("vendor_name",):
        return _from(vendor_idx, vendor_idx.name_column, "vendor_report")
    if role == "vendor_id":
        return _from(vendor_idx, vendor_idx.code_column, "vendor_report")
    if role == "property_name":
        return _from(property_idx, property_idx.name_column, "property_report")
    if role == "property_code":
        return _from(property_idx, property_idx.code_column, "property_report")
    if role in ("unit", "location"):
        return _from(unit_idx, unit_idx.name_column, "unit_report")

    if role == "unmapped":
        return Cell(value=None, status="unmapped", source=None)

    # Invoice-derived: synthetic preview can't fill these.
    return Cell(
        value=None,
        status="unresolved",
        source=None,
        note="Will populate from extracted invoices",
    )


# ---------------------------------------------------------------------------
# Contributions block — "what each uploaded report adds"
# ---------------------------------------------------------------------------


_CONTRIBUTION_LABELS: dict[ReferenceSource, str] = {
    "vendor_report": "Vendor report",
    "property_report": "Property report",
    "unit_report": "Unit report",
    "import_template": "Invoice import template",
}


def _compute_contributions(
    columns: Sequence[ColumnInfo],
    vendor_idx: ReferenceIndex,
    property_idx: ReferenceIndex,
    unit_idx: ReferenceIndex,
    has_template: bool,
    template_columns: Sequence[str] | None,
) -> list[Contribution]:
    """One Contribution per known reference source, with what it powers."""

    by_source: dict[ReferenceSource, list[str]] = {
        "vendor_report": [],
        "property_report": [],
        "unit_report": [],
        "import_template": list(template_columns or []),
    }
    for col in columns:
        if col.populated_from in ("vendor_report", "property_report", "unit_report"):
            by_source[col.populated_from].append(col.name)

    out: list[Contribution] = []

    out.append(
        Contribution(
            source="import_template",
            label=_CONTRIBUTION_LABELS["import_template"],
            available=has_template,
            row_count=len(template_columns) if template_columns else None,
            columns_powered=by_source["import_template"],
            note=(
                "Defines the column shape and order of the export"
                if has_template
                else "Upload an import template to set the export shape"
            ),
        )
    )
    out.append(_index_to_contribution(vendor_idx, by_source["vendor_report"]))
    out.append(_index_to_contribution(property_idx, by_source["property_report"]))
    out.append(_index_to_contribution(unit_idx, by_source["unit_report"]))
    return out


def _index_to_contribution(
    idx: ReferenceIndex, columns_powered: list[str]
) -> Contribution:
    label = _CONTRIBUTION_LABELS[idx.source]
    if not idx.available:
        return Contribution(
            source=idx.source,
            label=label,
            available=False,
            row_count=None,
            columns_powered=[],
            note=f"Upload a {label.lower()} to populate / validate matched values",
        )
    if not columns_powered:
        return Contribution(
            source=idx.source,
            label=label,
            available=True,
            row_count=idx.row_count,
            columns_powered=[],
            note="No template columns map to this report yet",
        )
    return Contribution(
        source=idx.source,
        label=label,
        available=True,
        row_count=idx.row_count,
        columns_powered=columns_powered,
        note=None,
    )


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------


def build_preview(
    *,
    template_columns: Sequence[str] | None,
    template_filename: str | None,
    properties_columns: Sequence[str] | None,
    properties_samples: Sequence[dict[str, str]] | None,
    properties_row_count: int | None,
    units_columns: Sequence[str] | None,
    units_samples: Sequence[dict[str, str]] | None,
    units_row_count: int | None,
    vendors_columns: Sequence[str] | None,
    vendors_samples: Sequence[dict[str, str]] | None,
    vendors_row_count: int | None,
    invoices: Iterable[InvoiceFacts],
    row_limit: int = DEFAULT_PREVIEW_ROW_LIMIT,
    column_role_overrides: dict[str, ColumnRole] | None = None,
) -> PreviewResult:
    """
    Single entry point used by the API layer.

    `column_role_overrides` is the per-template-column role pinning saved
    on an ImportConfig. Keys match template column names verbatim;
    overrides for columns that aren't in the current template are
    silently ignored (the saved override goes dormant rather than
    becoming an error — the user might re-upload the matching template
    later).
    """

    has_template = bool(template_columns)
    overrides = column_role_overrides or {}

    vendor_idx = ReferenceIndex.build("vendor_report", vendors_columns, vendors_samples, vendors_row_count)
    property_idx = ReferenceIndex.build("property_report", properties_columns, properties_samples, properties_row_count)
    unit_idx = ReferenceIndex.build("unit_report", units_columns, units_samples, units_row_count)

    columns: list[ColumnInfo] = []
    for raw in template_columns or []:
        # Per-config override beats the auto-classifier. Anything not
        # in `overrides` falls through to the standard heuristic.
        if raw in overrides:
            role: ColumnRole = overrides[raw]
            overridden = True
        else:
            role = classify_column(raw)
            overridden = False
        columns.append(
            ColumnInfo(
                name=raw,
                role=role,
                populated_from=reference_for_role(role),
                role_overridden=overridden,
            )
        )

    invoice_list = list(invoices)[:row_limit]
    if invoice_list:
        rows = [
            _build_invoice_row(inv, columns, vendor_idx, property_idx, unit_idx)
            for inv in invoice_list
        ]
    else:
        rows = _build_synthetic_rows(columns, vendor_idx, property_idx, unit_idx)

    contributions = _compute_contributions(
        columns, vendor_idx, property_idx, unit_idx, has_template, template_columns
    )

    # Overrides whose key isn't in the current template — surface as a
    # note so the user knows their saved override has gone dormant
    # (likely because the template was re-uploaded with renamed columns).
    template_col_set = set(template_columns or [])
    orphaned_overrides = [
        k for k in overrides.keys() if k not in template_col_set
    ]
    applied_overrides = sum(1 for c in columns if c.role_overridden)

    notes = _build_notes(
        has_template=has_template,
        invoice_count=len(invoice_list),
        synthetic=not invoice_list and bool(rows),
        unmapped_count=sum(1 for c in columns if c.role == "unmapped"),
        any_reference_missing=not (vendor_idx.available and property_idx.available and unit_idx.available),
        applied_override_count=applied_overrides,
        orphaned_override_keys=orphaned_overrides,
    )

    return PreviewResult(
        has_template=has_template,
        template_filename=template_filename,
        columns=columns,
        rows=rows,
        contributions=contributions,
        notes=notes,
    )


def _build_notes(
    *,
    has_template: bool,
    invoice_count: int,
    synthetic: bool,
    unmapped_count: int,
    any_reference_missing: bool,
    applied_override_count: int = 0,
    orphaned_override_keys: list[str] | None = None,
) -> list[str]:
    notes: list[str] = []
    if not has_template:
        notes.append(
            "Upload an import template to define the column shape of the preview."
        )
        return notes
    if invoice_count > 0:
        notes.append(
            f"Showing {invoice_count} approved invoice{'s' if invoice_count != 1 else ''} "
            f"as preview rows. Reference reports are used as lookup pools for matched cells."
        )
    elif synthetic:
        notes.append(
            "No approved invoices yet — showing synthetic rows built from the "
            "reference reports' sample rows. Once invoices flow through review, "
            "they'll populate here automatically."
        )
    else:
        notes.append(
            "No preview rows can be built yet — upload at least one reference "
            "report (vendor / property / unit) or approve an invoice in review."
        )
    if applied_override_count > 0:
        notes.append(
            f"{applied_override_count} column role{'s' if applied_override_count != 1 else ''} "
            "pinned by this configuration's overrides."
        )
    if orphaned_override_keys:
        sample = ", ".join(repr(k) for k in orphaned_override_keys[:3])
        more = (
            f" (+{len(orphaned_override_keys) - 3} more)"
            if len(orphaned_override_keys) > 3
            else ""
        )
        notes.append(
            f"{len(orphaned_override_keys)} saved override"
            f"{'s' if len(orphaned_override_keys) != 1 else ''} no longer match a "
            f"template column and won't apply — likely the template was "
            f"re-uploaded with renamed columns ({sample}{more})."
        )
    if any_reference_missing:
        notes.append(
            "Some reference reports aren't uploaded yet — cells they would "
            "populate are marked unresolved."
        )
    if unmapped_count > 0:
        notes.append(
            f"{unmapped_count} template column{'s' if unmapped_count != 1 else ''} "
            f"don't match a known role yet (shown with a slash pattern). "
            "Use the column-role override on the right to pin them."
        )
    notes.append(
        "Lookups use the parsed sample rows stored with each reference report "
        "(up to 5 rows). Matching against the full reports is a future phase."
    )
    return notes
