"""
Reference-file parser.

Reads CSV and XLSX bytes and returns a normalised summary used by both the
reference-data API (to populate the workspace cards) and — eventually —
the matching/export layer (to compare detected headers against the
canonical invoice fields the ResMan template expects).

Pure function in / pure function out: no DB, no storage, no HTTP. The
caller passes bytes + the source filename + (optionally) the reference
kind, and gets back a `ParsedReference`.

Why "kind" matters
------------------
ResMan exports prepend several rows of metadata before the real table:
the property name list, the management company name, the report title,
optional date headers, and a "Printed YYYY-MM-DD" stamp. The "All Units"
report additionally interleaves single-cell *property grouping* rows
between batches of unit rows. Treating row 0 as the header (the naive
behavior) yields a single garbage column ("1732-Hillwood Manor, Admiral
Place, …") and a sample full of metadata strings.

When the caller supplies `kind`, the parser:
  1. Skips the metadata block by scanning for the first row that matches
     the kind's header signature (e.g. units → contains "unit" + one of
     "unit type" / "sq ft" / "lease status").
  2. For "units" specifically, drops in-data property grouping rows and
     synthesizes a "Property" column from them — the property is in the
     file (as section headers), this just makes it accessible per-row.
  3. For the import template (xlsx), prefers the worksheet whose row 1
     looks like a real invoice template over data-validation lookup
     sheets that often ship in the same workbook.

When `kind` is None (or unrecognized), the parser falls back to its
original behavior: row 0 is the header, no row filtering. This keeps the
function safe for ad-hoc callers and tests.

Format support:
  * .csv  — Python stdlib csv module, utf-8 with BOM tolerance + latin-1
            fallback for ResMan's occasional CP1252 bytes (NBSP).
  * .xlsx — openpyxl in read-only mode (already a project dep).
  * .xls  — explicitly rejected; surface a clear error so the user
            re-exports as .xlsx.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from typing import Literal

# The four kinds the Reference Data workspace exposes. Ordered by how the
# UI lays them out (top-to-bottom, left-to-right). The frontend has the
# same list — keep them in sync; the API also enforces this set.
ReferenceKind = Literal["properties", "units", "vendors", "import_template"]
REFERENCE_KINDS: tuple[ReferenceKind, ...] = (
    "properties",
    "units",
    "vendors",
    "import_template",
)

# How many sample rows to keep in the DB for UI inspection. Five is enough
# to recognise the report visually without bloating JSONB.
SAMPLE_ROW_LIMIT = 5

# How many rows to scan from the top when looking for the real header.
# ResMan's metadata sections are usually 4–7 rows; 25 leaves headroom for
# unusual exports without scanning the whole file.
HEADER_SCAN_LIMIT = 25

# MIME types we accept on upload. Browsers send inconsistent strings for
# spreadsheets (especially when dragging from Excel vs. uploading a saved
# file), so we also fall back to the filename extension.
ALLOWED_MIME_TYPES = frozenset({
    "text/csv",
    "application/csv",
    "application/vnd.ms-excel",  # browsers sometimes send this for .csv
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",  # generic — extension takes over
})


class ReferenceParseError(ValueError):
    """Raised on user-correctable parse problems. Maps to HTTP 422."""


@dataclass
class ParsedReference:
    columns: list[str]
    row_count: int
    sample_rows: list[dict[str, str]] = field(default_factory=list)
    detected_format: Literal["csv", "xlsx"] = "csv"


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def parse_reference_file(
    raw_bytes: bytes,
    filename: str,
    mime_type: str,
    *,
    kind: ReferenceKind | None = None,
) -> ParsedReference:
    """
    Parse a reference file's bytes and return its summary.

    Args:
        raw_bytes: The uploaded file contents.
        filename: Used to disambiguate format when the MIME type is generic.
        mime_type: Best-effort content type; usually comes from the upload.
        kind: When supplied, enables ResMan-aware cleaning (metadata strip,
              header detection, units' Property synthesis, template sheet
              selection). Pass None for raw "row 0 is header" behavior.

    Raises:
        ReferenceParseError: empty file, unsupported format, or no usable
            header could be detected.
    """
    if not raw_bytes:
        raise ReferenceParseError("File is empty")

    fmt = _detect_format(filename, mime_type)
    if fmt == "csv":
        rows = _read_csv_rows(raw_bytes)
    elif fmt == "xlsx":
        rows = _read_xlsx_rows(raw_bytes, kind)
    elif fmt == "xls":
        raise ReferenceParseError(
            "Legacy .xls files aren't supported. Re-export as .xlsx or .csv "
            "from Excel and try again."
        )
    else:
        raise ReferenceParseError(
            f"Unsupported file format. Use .csv or .xlsx (got {filename!r}, "
            f"mime {mime_type!r})."
        )

    return _normalize_rows(rows, kind, fmt)


# ---------------------------------------------------------------------------
# Format detection + raw row readers
# ---------------------------------------------------------------------------


def _detect_format(
    filename: str, mime_type: str
) -> Literal["csv", "xlsx", "xls", "unknown"]:
    name = (filename or "").lower()
    if name.endswith(".csv"):
        return "csv"
    if name.endswith(".xlsx"):
        return "xlsx"
    if name.endswith(".xls"):
        return "xls"
    mt = (mime_type or "").lower()
    if "spreadsheetml" in mt:
        return "xlsx"
    if "csv" in mt:
        return "csv"
    return "unknown"


def _read_csv_rows(raw_bytes: bytes) -> list[list[str]]:
    """
    Decode and parse CSV bytes into a raw 2D list of cleaned strings.

    Encoding strategy: utf-8-sig (handles Excel's "Save as CSV UTF-8"
    BOM) → latin-1 fallback (always succeeds). ResMan's vendor exports
    sometimes contain CP1252 byte 0xA0 (non-breaking space) which is
    invalid UTF-8; latin-1 turns it into U+00A0 which `.strip()`
    happily removes downstream.
    """
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = raw_bytes.decode("latin-1")
        except UnicodeDecodeError as exc:  # pragma: no cover — latin-1 always works
            raise ReferenceParseError(f"Couldn't decode CSV: {exc}") from exc

    reader = csv.reader(io.StringIO(text))
    return [[_clean_cell_text(c) for c in row] for row in reader]


def _read_xlsx_rows(
    raw_bytes: bytes, kind: ReferenceKind | None
) -> list[list[str]]:
    """
    Open the workbook, pick the right sheet, materialize all rows.

    Why we eagerly slurp every sheet: sheet-selection for the import
    template needs to peek at row 1 of *every* sheet. openpyxl's
    read-only iterators behave inconsistently across versions when
    re-iterated, so slurping once into Python lists is the simplest
    correct option. Reference files are small (max ~10k rows × ~50
    cols), so memory cost is negligible.
    """
    # Lazy import keeps openpyxl off the import path of code that doesn't
    # touch reference data (e.g. extraction adapters).
    from openpyxl import load_workbook
    from openpyxl.utils.exceptions import InvalidFileException

    try:
        wb = load_workbook(
            io.BytesIO(raw_bytes), read_only=True, data_only=True
        )
    except (InvalidFileException, KeyError, ValueError, OSError) as exc:
        # KeyError/ValueError get raised on malformed zip / missing sheets.
        raise ReferenceParseError(f"Couldn't open spreadsheet: {exc}") from exc

    try:
        materialized: list[tuple[str, list[list[str]]]] = []
        for ws in wb.worksheets:
            sheet_rows: list[list[str]] = []
            for row in ws.iter_rows(values_only=True):
                cells = [_xlsx_cell_to_str(c) for c in row]
                sheet_rows.append(cells)
            materialized.append((ws.title, sheet_rows))
    finally:
        wb.close()

    if not materialized:
        raise ReferenceParseError("Spreadsheet has no sheets")

    return _pick_sheet_rows(materialized, kind)


def _pick_sheet_rows(
    sheets: list[tuple[str, list[list[str]]]],
    kind: ReferenceKind | None,
) -> list[list[str]]:
    """
    Pick the sheet most likely to be the real table for this kind.

    For non-template kinds we trust the first sheet — that's what
    Excel shows when the user opens the file, and ResMan exports of
    properties/units/vendors only have one data sheet.

    For "import_template" we score each sheet on its row-1 plausibility
    (column count + presence of canonical invoice tokens like
    "Invoice Number", "Vendor", "Amount") and pick the best. ResMan's
    invoice import workbook ships with a second "Sheet1" of
    data-validation lookup values (single-column lists like
    Bill/Credit/Check/Cash) that would parse as a meaningless preview if
    accidentally chosen as active.
    """
    if not sheets:
        return []
    if kind != "import_template":
        return sheets[0][1]

    template_tokens = (
        "invoice number",
        "invoice date",
        "accounting date",
        "vendor",
        "amount",
        "property abbreviation",
        "gl account",
        "line item description",
    )

    best_score: tuple[int, int, int] = (-1, -1, -1)
    best_rows: list[list[str]] = sheets[0][1]
    for _title, rows in sheets:
        if not rows:
            continue
        first = rows[0]
        non_empty = [c.strip() for c in first if c and c.strip()]
        if len(non_empty) < 5:
            continue
        joined = " | ".join(c.lower() for c in non_empty)
        score = sum(1 for tok in template_tokens if tok in joined)
        candidate = (score, len(non_empty), len(rows))
        if candidate > best_score:
            best_score = candidate
            best_rows = rows
    return best_rows


# ---------------------------------------------------------------------------
# Kind-aware normalization
# ---------------------------------------------------------------------------


# Per-kind tokens we look for when scanning for the "real" header row.
# A row is considered the header iff:
#   * it has at least 3 non-empty cells (excludes single-cell metadata
#     titles like "Property List" / "All Units" / "Printed …"), AND
#   * any one PRIMARY token matches, AND
#   * at least one SECONDARY token matches (defends against false hits
#     on single-word metadata that happens to contain "name" or "unit").
#
# Tokens are matched case-insensitively as substrings of " | ".join(cells).
_HEADER_SIGNATURES: dict[ReferenceKind, dict[str, tuple[str, ...]]] = {
    "properties": {
        "primary": ("name",),
        "secondary": (
            "property type",
            "abbreviation",
            "address",
            "total units",
            "legal name",
            "regional manager",
        ),
    },
    "units": {
        "primary": ("unit",),
        "secondary": (
            "unit type",
            "unit status",
            "sq ft",
            "lease status",
            "market rent",
            "rent / sq ft",
        ),
    },
    "vendors": {
        "primary": ("company", "vendor"),
        "secondary": (
            "company abbreviation",
            "customer #",
            "general address",
            "general city",
            "1099",
            "default gl",
            "payment address",
        ),
    },
    "import_template": {
        "primary": ("invoice number", "invoice date"),
        "secondary": (
            "vendor",
            "amount",
            "property abbreviation",
            "gl account",
            "line item description",
            "accounting date",
        ),
    },
}


def _normalize_rows(
    rows: list[list[str]],
    kind: ReferenceKind | None,
    fmt: Literal["csv", "xlsx"],
) -> ParsedReference:
    """
    Common normalization: header detection, blank-row drop, kind-specific
    row + column shaping. Produces the final `ParsedReference`.
    """
    if not rows:
        raise ReferenceParseError(f"{fmt.upper()} has no rows")

    header_idx = _find_header_row(rows, kind)
    raw_header = rows[header_idx]
    columns = _clean_header(raw_header)
    if not columns:
        raise ReferenceParseError(f"{fmt.upper()} header row is empty")

    # Drop fully-blank data rows (Excel exports often pad them).
    raw_data = rows[header_idx + 1 :]
    data_rows = [r for r in raw_data if any(c and c.strip() for c in r)]

    # Per-kind row + column shaping.
    if kind == "units":
        # Look back across the metadata block for the first property
        # grouping row — it sits between the "Printed …" stamp and the
        # column header in single-property exports, and we want its
        # value to seed the synthetic Property column.
        initial_property = _first_unit_grouping_before_header(rows, header_idx)
        columns, data_rows = _normalize_units_table(
            columns, data_rows, initial_property
        )

    samples = [_row_to_sample(columns, r) for r in data_rows[:SAMPLE_ROW_LIMIT]]

    return ParsedReference(
        columns=columns,
        row_count=len(data_rows),
        sample_rows=samples,
        detected_format=fmt,
    )


def _find_header_row(
    rows: list[list[str]], kind: ReferenceKind | None
) -> int:
    """
    Return the index of the row that looks like the real header.

    With a known `kind`, we use that kind's header signature. Without a
    kind (or with no signature match within HEADER_SCAN_LIMIT rows), we
    fall back to "first row with ≥3 non-empty cells" — which still beats
    naive row 0 for any export with metadata above the table.
    """
    if kind and kind in _HEADER_SIGNATURES:
        sig = _HEADER_SIGNATURES[kind]
        primary = sig["primary"]
        secondary = sig["secondary"]
        scan_limit = min(len(rows), HEADER_SCAN_LIMIT)
        for idx in range(scan_limit):
            cells = rows[idx]
            non_empty = [(c or "").strip().lower() for c in cells if c and c.strip()]
            if len(non_empty) < 3:
                continue
            joined = " | ".join(non_empty)
            primary_hit = any(p in joined for p in primary)
            if not primary_hit:
                continue
            secondary_hits = sum(1 for s in secondary if s in joined)
            if secondary_hits >= 1:
                return idx

    # Fallback (unknown kind, or signature didn't match): first row with
    # at least 3 non-empty cells. Single-cell metadata rows ("Property
    # List", "Printed …", etc.) are skipped naturally.
    for idx in range(len(rows)):
        non_empty = [c for c in rows[idx] if c and c.strip()]
        if len(non_empty) >= 3:
            return idx
    return 0


def _normalize_units_table(
    columns: list[str],
    data_rows: list[list[str]],
    initial_property: str,
) -> tuple[list[str], list[list[str]]]:
    """
    All Units exports interleave single-cell property grouping rows
    between batches of unit rows:

        [1732-Hillwood Manor, '', '', ...]   <- grouping row
        [A1, 2B1B, Ready, 888, ...]          <- unit row
        [A2, 2B1B, Ready, 888, ...]          <- unit row
        [Admiral Place Apts., '', '', ...]   <- grouping row
        [101, 1B1B, Ready, ...]              <- unit row

    We:
      1. Detect grouping rows (exactly one populated cell, in column 0,
         whose value looks like a property name — see
         `_is_unit_grouping_row` for the heuristic).
      2. Track the most recent grouping value as the "Property" for
         downstream rows. `initial_property` (from the metadata block
         before the header) seeds it.
      3. Skip grouping rows from the output.
      4. Prepend a synthesized "Property" column to retained rows.

    No-op (return unchanged) when there are no in-data grouping rows
    AND no pre-header property — i.e. the data is flat to begin with
    and we have no source for the column.
    """
    grouping_indices: set[int] = set()
    for i, row in enumerate(data_rows):
        if _is_unit_grouping_row(row):
            grouping_indices.add(i)

    has_grouping = bool(grouping_indices) or bool(initial_property)
    if not has_grouping:
        return columns, data_rows

    new_columns = ["Property"] + columns
    out_rows: list[list[str]] = []
    current_property = initial_property
    for i, row in enumerate(data_rows):
        if i in grouping_indices:
            current_property = (row[0] or "").strip()
            continue
        out_rows.append([current_property] + list(row))
    return new_columns, out_rows


def _is_unit_grouping_row(row: list[str]) -> bool:
    """
    Heuristic: a row is a property-grouping row iff exactly one cell is
    populated, that cell is in column 0, and its value looks like a
    property name (contains a space, OR is at least 8 characters long).
    Unit identifiers in ResMan exports are short tokens like "A1",
    "B17", "101" — they don't trip this heuristic.
    """
    if not row:
        return False
    populated = [(i, (c or "").strip()) for i, c in enumerate(row) if c and c.strip()]
    if len(populated) != 1:
        return False
    idx, val = populated[0]
    if idx != 0 or not val:
        return False
    if " " in val:
        return True
    return len(val) >= 8


def _first_unit_grouping_before_header(
    rows: list[list[str]], header_idx: int
) -> str:
    """
    Walk backward from the header row looking for the most recent
    pre-header property name. Skips obvious metadata like report titles,
    timestamps, and the comma-joined property roster on row 0.

    Returns "" when nothing plausible is found — the units normalizer
    treats that as "no initial property context".
    """
    for back_idx in range(header_idx - 1, -1, -1):
        row = rows[back_idx]
        non_empty = [(c or "").strip() for c in row if c and c.strip()]
        if len(non_empty) != 1:
            continue
        val = non_empty[0]
        if _looks_like_metadata_title(val):
            continue
        return val
    return ""


_METADATA_TITLES = frozenset({
    "property list",
    "vendor list",
    "all units",
    "rent roll",
    "summary",
    "unit availability",
})

_DATE_LIKE_RE = re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}$")


def _looks_like_metadata_title(s: str) -> bool:
    """
    Catch the obvious junk single-cell rows that surround the table:
    report titles, "Printed YYYY-MM-DD …" stamps, plain dates, and the
    enormous comma-joined property roster on row 0.
    """
    s_stripped = s.strip()
    s_lower = s_stripped.lower()
    if s_lower.startswith("printed "):
        return True
    if s_lower in _METADATA_TITLES:
        return True
    if _DATE_LIKE_RE.match(s_lower):
        return True
    # Property roster row 0 is hundreds of chars of comma-joined names.
    return len(s_stripped) > 200


# ---------------------------------------------------------------------------
# Cell + header utilities
# ---------------------------------------------------------------------------


# Strip control + invisible chars commonly seen in ResMan exports:
#   * 0x00–0x1F minus tab/CR/LF — control bytes
#   * U+00AD — soft hyphen
#   * U+200B–U+200F — zero-width joiners / directional marks
#   * U+202A–U+202E — embedding / override marks
#   * U+2060 — word joiner
#   * U+FEFF — zero-width no-break space (BOM, in-stream)
#   * U+FFFD — replacement char (from earlier mis-decodes)
_NON_PRINTING_RE = re.compile(
    r"[\x00-\x08\x0b\x0c\x0e-\x1f\u00ad\u200b-\u200f\u202a-\u202e\u2060\ufeff\ufffd]"
)


def _clean_cell_text(s: object) -> str:
    """Coerce to str + strip non-printing chars. Idempotent."""
    if s is None:
        return ""
    text = s if isinstance(s, str) else str(s)
    return _NON_PRINTING_RE.sub("", text)


def _clean_header(raw_header: list[str]) -> list[str]:
    """
    Strip whitespace and drop trailing blanks from a header row.

    Excel exports commonly extend the header with empty cells out to the
    last used column; if we kept those, every row would gain ghost
    columns. We trim the trailing tail but preserve interior blanks
    (turning them into "Column 4" / "Column 7" placeholders) so the
    surviving columns align with their data positions.
    """
    cleaned = [(c or "").strip() for c in raw_header]
    while cleaned and cleaned[-1] == "":
        cleaned.pop()
    return [c if c else f"Column {i + 1}" for i, c in enumerate(cleaned)]


def _row_to_sample(columns: list[str], cells: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for i, col in enumerate(columns):
        out[col] = cells[i].strip() if i < len(cells) else ""
    return out


def _xlsx_cell_to_str(cell: object) -> str:
    """
    Coerce an openpyxl cell value to a cleaned string for JSON-safe storage.

    openpyxl returns native Python types: str / int / float / datetime /
    bool / None. We don't want native types in the JSONB sample column
    because date serialisation behaves differently across drivers and
    Pydantic versions; turning everything into a string here keeps the
    sample shape predictable for the frontend.
    """
    if cell is None:
        return ""
    return _clean_cell_text(str(cell))
