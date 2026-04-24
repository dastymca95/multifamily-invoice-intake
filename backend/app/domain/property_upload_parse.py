"""
Property master upload parser.

One-shot parser used by `POST /property-catalogs/parse-upload`. Takes
raw bytes (csv or xlsx), pulls out the header + data rows, and returns
a `ParsedPropertyUpload` containing:

  * `source_columns`    — header cells verbatim (the file's own names).
  * `source_rows`       — data rows, padded / truncated to the header
                          width so column index N is meaningful for
                          every row. Capped at `MAX_PARSE_ROWS`.
  * `suggested_mapping` — best-effort canonical-field → source-column-
                          name guess across all 12 property canonical
                          fields. Used by the frontend's mapping step
                          to pre-populate dropdowns; NEVER silently
                          committed.
  * `parse_warning`     — soft-failure explainer.

The endpoint is **single-file**. The frontend orchestrates multi-file
property uploads by calling this endpoint once per file, accumulating
the parsed responses, presenting a per-file mapping UI, then merging
all confirmed mappings into one canonical entries list before calling
`POST /property-catalogs`. Keeping the endpoint per-file means
progress / errors / retries are per-file, not all-or-nothing — and the
backend stays a thin parser, not a multi-file integration engine.

Two structural shapes the parser knows how to flatten:

  1. Plain table — header row up top (or a few rows down), then flat
     data rows. The classic Yardi / AppFolio "Property List" export.

  2. Grouped report — interleaved property-name section headers and
     unit rows beneath each section. The classic ResMan "All Units"
     report. The unit header (e.g. "Unit  Type  Status  …") doesn't
     itself carry a property identifier — the property name lives in
     a banner row above each block of units. `_flatten_grouped_units`
     detects this layout and synthesizes a leading "Property Name"
     column so the file looks like a flat table downstream.

What this parser explicitly does NOT do:

  * Build `PropertyEntry` objects. BillsIQ's canonical schema is the
    source of truth and the user must confirm the column mapping
    before any source row becomes a canonical entry. Assembling
    entries (and merging across files) is the frontend's job (see
    `applyMappingToSourceRows` and `mergePropertyFiles` in
    `types/property-catalog.ts`).

  * Interpret the `active` column. Source values vary wildly
    ("Y"/"N", "Yes"/"No", "1"/"0", "Active"/"Inactive", "Occupied"
    blank-means-active, blank-means-inactive). The frontend applies
    a shared interpretation only AFTER the user confirms which source
    column represents `active` — same pattern as GL upload parsing.

Distinct from `gl_upload_parse.py`:

  * Different alias tables (12 canonical property fields vs 5 GL
    fields). The header detector also accepts unit-style headers
    ("Unit Number", "Apt") as primary signals because some uploads
    are unit-level only without an explicit "Property" header.
  * Same overall mechanics: exact-after-normalize matching, header
    scan limit, soft-fail on missing header, padding to header width.

Distinct from `reference_parse.py`:

  * That parser handles ResMan-style reports that prepend metadata
    rows. Property exports — whether from ResMan, Yardi, AppFolio,
    or a plain spreadsheet — usually have one header row + flat data
    rows, OR (for ResMan All Units) a grouped structure that
    `_flatten_grouped_units` here turns into a flat table.

The file itself is NOT persisted. The catalog the user creates from
the merged + mapped rows is the authoritative artifact.
"""

from __future__ import annotations

import csv
import io
import re
from typing import Literal

from app.schemas.property_catalog import (
    MAX_PARSE_ROWS,
    ParsedPropertyUpload,
    PropertyUploadMapping,
)

# How many rows from the top to scan when looking for the header.
# Property exports rarely prepend metadata, but a couple of vendors
# (Yardi "Property List" reports) put a title + run-date above the
# header — 15 rows is plenty of slack without scanning the whole file.
HEADER_SCAN_LIMIT = 15

# Minimum non-empty cells in a candidate header row. Single-cell title
# rows ("Property Master", "Printed 2026-04-22") are skipped naturally.
MIN_HEADER_CELLS = 2

# MIME types we accept — same set as GL upload + reference parsing.
ALLOWED_MIME_TYPES = frozenset({
    "text/csv",
    "application/csv",
    "application/vnd.ms-excel",  # browsers often send this for .csv
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",  # generic — extension takes over
})


class PropertyUploadParseError(ValueError):
    """Raised on user-correctable parse problems. Maps to HTTP 422."""


# ---------------------------------------------------------------------------
# Header → canonical-field alias tables
# ---------------------------------------------------------------------------
#
# Each canonical field has a tuple of normalized header tokens we
# recognize. Matching is exact-after-normalize (lowercased,
# non-alphanumeric stripped). Order matters: the first alias in the
# tuple that hits an unclaimed header takes precedence, so put the
# most specific names first ("propertycode" before "code").
#
# Process order (declared in `_CANONICAL_FIELD_ORDER`) is also
# important — more specific fields run first so a generic token like
# "name" doesn't get stolen by `notes` before `property_name` sees it.

_FieldKey = Literal[
    "property_code",
    "property_name",
    "property_abbreviation",
    "unit_number",
    "unit_type",
    "building",
    "address",
    "city",
    "state",
    "zip",
    "active",
    "notes",
]

_CANONICAL_FIELD_ORDER: tuple[_FieldKey, ...] = (
    "property_code",
    "property_name",
    "property_abbreviation",
    "unit_number",
    "unit_type",
    "building",
    "address",
    "city",
    "state",
    "zip",
    "active",
    "notes",
)

_HEADER_ALIASES: dict[_FieldKey, tuple[str, ...]] = {
    "property_code": (
        "propertycode",
        "propcode",
        "propertyid",
        "propid",
        "propertynumber",
        "propertyno",
        "propertyabbreviation",  # last-resort: some files only have an abbr column
        "propertyabbr",
        "code",  # generic — last
        "id",
    ),
    "property_name": (
        "propertyname",
        "propertyfullname",
        "propertytitle",
        "property",
        "name",  # generic — last
    ),
    "property_abbreviation": (
        "propertyabbreviation",
        "propertyabbr",
        "abbreviation",
        "abbr",
        "shortcode",
        "shortname",
        "abbrev",
    ),
    "unit_number": (
        "unitnumber",
        "unitno",
        "unitid",
        "apartmentnumber",
        "aptnumber",
        "aptno",
        "apt",
        "apartment",
        "unit",  # generic — last
        "room",
        "suite",
    ),
    "unit_type": (
        "unittype",
        "floorplan",
        "floorplanname",
        "plan",
        "planname",
        "bedrooms",  # heuristic — many reports use bedroom count as the type
        "beds",
        "type",  # generic — last
    ),
    "building": (
        "buildingname",
        "buildingnumber",
        "buildingno",
        "buildingid",
        "phase",
        "block",
        "building",  # generic — last
    ),
    "address": (
        "streetaddress",
        "addressline1",
        "address1",
        "propertyaddress",
        "physicaladdress",
        "mailingaddress",
        "address",  # generic — last
        "street",
    ),
    "city": (
        "city",
        "town",
        "municipality",
    ),
    "state": (
        "stateprovince",
        "state",
        "province",
        "region",
    ),
    "zip": (
        "zipcode",
        "postalcode",
        "postcode",
        "zip",
    ),
    "active": (
        "isactive",
        "active",
        "status",
        "propertystatus",
        "unitstatus",
        "occupied",
        "enabled",
    ),
    "notes": (
        "notes",
        "comment",
        "comments",
        "memo",
        "remark",
        "remarks",
        "description",
    ),
}

_NORMALIZE_RE = re.compile(r"[^a-z0-9]")


def _normalize_header(s: str) -> str:
    return _NORMALIZE_RE.sub("", (s or "").lower())


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def parse_property_upload(
    raw_bytes: bytes,
    filename: str,
    mime_type: str,
) -> ParsedPropertyUpload:
    """
    Parse a property master upload and return source columns / rows +
    a suggested canonical-field mapping.

    Args:
        raw_bytes: Uploaded file contents.
        filename:  Used for format detection when MIME is generic.
        mime_type: Best-effort content type.

    Raises:
        PropertyUploadParseError: empty file, unsupported format, or the
            spreadsheet couldn't be opened. Soft failures (no header
            found) come back as a successful response with empty
            columns/rows and `parse_warning` set.
    """
    if not raw_bytes:
        raise PropertyUploadParseError("File is empty")

    fmt = _detect_format(filename, mime_type)
    if fmt == "csv":
        rows = _read_csv_rows(raw_bytes)
    elif fmt == "xlsx":
        rows = _read_xlsx_rows(raw_bytes)
    elif fmt == "xls":
        raise PropertyUploadParseError(
            "Legacy .xls files aren't supported. Re-export as .xlsx or "
            ".csv from Excel and try again."
        )
    else:
        raise PropertyUploadParseError(
            f"Unsupported file format. Use .csv or .xlsx (got {filename!r}, "
            f"mime {mime_type!r})."
        )

    if not rows:
        return _empty_response(
            filename, fmt, "No rows found in the uploaded file."
        )

    header_idx = _find_header_row(rows)
    if header_idx is None:
        return _empty_response(
            filename,
            fmt,
            "Couldn't find a header row with recognizable column names "
            "(looked for things like 'Property', 'Property Code', 'Unit', "
            "'Address'). Re-export the file with a header row on top and "
            "try again.",
        )

    header_cells = [c.strip() for c in rows[header_idx]]
    # Trim trailing empty columns so we don't pollute the mapping
    # dropdown with anonymous "" options.
    while header_cells and not header_cells[-1]:
        header_cells.pop()

    if not header_cells:
        return _empty_response(
            filename,
            fmt,
            "Header row was recognized but contained no usable column "
            "names. Re-export the file and try again.",
        )

    # Detect grouped reports (ResMan "All Units"-style layouts) and
    # flatten them BEFORE the rest of the pipeline runs. When a grouping
    # layout is recognized, `_flatten_grouped_units` returns a synthetic
    # header that prepends a "Property Name" column plus the flattened
    # data rows; downstream code is none the wiser. The flattener also
    # applies summary/header-repetition filtering inside its own loop
    # so its banner detection isn't fooled by total rows — any rows it
    # returns have already passed the filter.
    flatten_warning: str | None = None
    flattened = _flatten_grouped_units(rows, header_idx, header_cells)
    if flattened is not None:
        header_cells, data_rows_all, flatten_warning = flattened
        flat_table_path = False
    else:
        data_rows_all = rows[header_idx + 1 :]
        flat_table_path = True

    width = len(header_cells)

    # Universal summary / header-repetition filter.
    #
    # The grouped path runs the same filter inside `_flatten_grouped_units`
    # so this is a no-op there. For FLAT tables (Yardi / AppFolio
    # property-list exports), this is the ONLY layer that strips
    # "Total" / "Grand Total" footer rows — without it, a `Total` cell
    # in the property_name column survives all the way through
    # `applyMappingToSourceRows` and `mergePropertyFiles`'s PASS-3
    # mirror, surfacing as a ghost `Total / Total` entry in the saved
    # catalog. Applying the same `_is_summary_row` heuristic universally
    # closes that gap at the parse layer.
    source_rows: list[list[str]] = []
    truncated = 0
    flat_summary_skipped = 0
    flat_header_repeat_skipped = 0
    for raw_row in data_rows_all:
        # Drop fully-blank rows — Excel pads them and they'd just bloat
        # the preview.
        if not any(c and c.strip() for c in raw_row):
            continue
        if flat_table_path:
            cells_for_check = [(c or "").strip() for c in raw_row]
            if _is_summary_row(cells_for_check):
                flat_summary_skipped += 1
                continue
            if _is_header_repetition(cells_for_check, header_cells):
                flat_header_repeat_skipped += 1
                continue
        if len(source_rows) >= MAX_PARSE_ROWS:
            truncated += 1
            continue
        source_rows.append(_pad_or_truncate(raw_row, width))

    suggested_mapping = _suggest_mapping(header_cells)

    warnings: list[str] = []
    if flatten_warning:
        warnings.append(flatten_warning)
    if flat_summary_skipped:
        warnings.append(
            f"Skipped {flat_summary_skipped} summary "
            f"row{'' if flat_summary_skipped == 1 else 's'} "
            "(Total / Grand Total / similar footer)."
        )
    if flat_header_repeat_skipped:
        warnings.append(
            f"Skipped {flat_header_repeat_skipped} repeated header "
            f"row{'' if flat_header_repeat_skipped == 1 else 's'} "
            "found between data rows."
        )
    if truncated:
        warnings.append(
            f"File contained more than {MAX_PARSE_ROWS} data rows; "
            f"dropped the last {truncated}. Trim the source and re-upload "
            f"if you need those rows."
        )
    if not source_rows:
        warnings.append(
            "No data rows below the header — every row was blank."
        )

    parse_warning = " ".join(warnings) if warnings else None

    return ParsedPropertyUpload(
        filename=filename or "upload",
        detected_format=fmt,  # type: ignore[arg-type]
        source_columns=header_cells,
        source_rows=source_rows,
        suggested_mapping=suggested_mapping,
        parse_warning=parse_warning,
    )


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
    """Decode CSV bytes (utf-8-sig → latin-1 fallback) and split."""
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = raw_bytes.decode("latin-1")
        except UnicodeDecodeError as exc:  # pragma: no cover — latin-1 always works
            raise PropertyUploadParseError(
                f"Couldn't decode CSV: {exc}"
            ) from exc

    reader = csv.reader(io.StringIO(text))
    return [[_clean_cell_text(c) for c in row] for row in reader]


def _read_xlsx_rows(raw_bytes: bytes) -> list[list[str]]:
    """
    Open the workbook and materialize the first non-empty sheet's rows.

    Property exports almost always have a single data sheet. We pick
    the first sheet that actually has rows — same heuristic as the GL
    upload parser.
    """
    # Lazy import keeps openpyxl off any code path that doesn't need it.
    from openpyxl import load_workbook
    from openpyxl.utils.exceptions import InvalidFileException

    try:
        wb = load_workbook(
            io.BytesIO(raw_bytes), read_only=True, data_only=True
        )
    except (InvalidFileException, KeyError, ValueError, OSError) as exc:
        raise PropertyUploadParseError(
            f"Couldn't open spreadsheet: {exc}"
        ) from exc

    try:
        for ws in wb.worksheets:
            sheet_rows: list[list[str]] = []
            for row in ws.iter_rows(values_only=True):
                cells = [_xlsx_cell_to_str(c) for c in row]
                sheet_rows.append(cells)
            if any(any(c.strip() for c in r) for r in sheet_rows):
                return sheet_rows
    finally:
        wb.close()

    return []


# ---------------------------------------------------------------------------
# Header detection + suggested mapping
# ---------------------------------------------------------------------------


def _find_header_row(rows: list[list[str]]) -> int | None:
    """
    Return the index of the first row that looks like a real header.

    A row is considered a header iff it has ≥`MIN_HEADER_CELLS` non-empty
    cells AND at least one of those cells normalizes to a known token
    in the property-identity OR unit-identity alias families. Either
    one is enough — some uploads are property-only (no per-unit rows),
    others are unit-only with an implicit single-property context.

    Falling back to "the first row with enough cells" is risky here
    (the first row of a headerless export looks identical to a header),
    so we'd rather return None and let the caller render an
    empty-with-warning state.
    """
    primary_tokens = (
        set(_HEADER_ALIASES["property_code"])
        | set(_HEADER_ALIASES["property_name"])
        | set(_HEADER_ALIASES["unit_number"])
    )
    scan_limit = min(len(rows), HEADER_SCAN_LIMIT)
    for idx in range(scan_limit):
        cells = rows[idx]
        normalized = [_normalize_header(c) for c in cells if c and c.strip()]
        if len(normalized) < MIN_HEADER_CELLS:
            continue
        if any(n in primary_tokens for n in normalized):
            return idx
    return None


def _suggest_mapping(header_cells: list[str]) -> PropertyUploadMapping:
    """
    Best-effort canonical-field → source-column-name suggestion.

    Walks each canonical field's alias list in priority order; the
    first alias that hits an unclaimed header column wins. A column
    can only be claimed once, so a header named "Property" goes to
    `property_name` (its first alias hit) rather than being double-
    claimed by something else later. The returned value is ALWAYS
    shown to the user on the mapping step — never silently applied to
    assemble entries — so a misdetection is visible and overridable.
    """
    normalized_headers = [_normalize_header(c) for c in header_cells]
    claimed: set[int] = set()
    picked: dict[_FieldKey, str | None] = {f: None for f in _CANONICAL_FIELD_ORDER}

    # Order matters — process more specific fields first so a generic
    # token like "name" doesn't get stolen by `notes`/`description`
    # before `property_name` sees it.
    for field in _CANONICAL_FIELD_ORDER:
        for alias in _HEADER_ALIASES[field]:
            for col_idx, norm in enumerate(normalized_headers):
                if col_idx in claimed:
                    continue
                if norm == alias:
                    picked[field] = header_cells[col_idx]
                    claimed.add(col_idx)
                    break
            if picked[field] is not None:
                break

    return PropertyUploadMapping(
        property_code=picked["property_code"],
        property_name=picked["property_name"],
        property_abbreviation=picked["property_abbreviation"],
        unit_number=picked["unit_number"],
        unit_type=picked["unit_type"],
        building=picked["building"],
        address=picked["address"],
        city=picked["city"],
        state=picked["state"],
        zip=picked["zip"],
        active=picked["active"],
        notes=picked["notes"],
    )


# ---------------------------------------------------------------------------
# Grouped-report flattening (ResMan "All Units"-style layouts)
# ---------------------------------------------------------------------------
#
# A grouped report doesn't carry property identity in its header — the
# header is unit-only ("Unit  Type  Status  …") and the property name
# lives in standalone banner rows interleaved with unit blocks:
#
#     1732-Hillwood Manor                              ← initial banner ABOVE header
#     Unit    Type    Status    …                      ← real header
#     A101    1BR     Occupied  …
#     A102    2BR     Vacant    …
#     Property Total           50 Unit(s)              ← summary row (drop)
#     1850-Oakwood Plaza                               ← next banner BELOW header
#     Unit    Type    Status    …                      ← REPEATED header (drop)
#     1A      2BR     Occupied  …
#     Grand Total              267 Unit(s)             ← grand total (drop)
#
# To make this look like a flat table downstream, we:
#
#   1. Detect the layout (header has unit tokens but no property tokens
#      AND ≥1 single-cell banner row exists below the header).
#   2. Synthesize a leading "Property Name" column on the header.
#   3. Walk the data rows, treating banner rows as state changes ("we're
#      now inside Vista Apartments") and prepending the active banner
#      to every following unit row.
#   4. Drop the banner rows themselves — they're not unit data.
#
# What this filter explicitly handles (post-Phase-13-cleanup):
#
#   * Initial banner ABOVE the header (Pattern A — standard ResMan):
#     the first property name is on a row before the unit header. We
#     scan up to INITIAL_BANNER_LOOKBACK rows above the header for it
#     and seed `current_banner` so that property's units don't get
#     dropped as orphans.
#   * Repeated header rows: ResMan re-emits the unit header at the
#     top of each property block. `_is_header_repetition` matches and
#     drops them, so the synthesized table doesn't end up with rows
#     like ("Vista Apartments", "Unit", "Unit Type", "Status", …).
#   * Summary / total rows: "Property Total | 50 Unit(s)",
#     "Grand Total: 267", "Subtotal …". `_is_summary_row` matches
#     these and drops them. Without this, the count cell ("267 Unit(s)")
#     would land in the synthesized table's Unit column and look
#     like a fake unit.
#   * Bare "Total" / "Property Total" / "Grand Total" rows: tightened
#     `_looks_like_property_name` rejects these so they can't be
#     misread as a new property banner.
#
# `_is_summary_row` and `_is_header_repetition` are ALSO applied by
# `parse_property_upload`'s outer row loop on the FLAT table path
# (Yardi / AppFolio property-list exports). Without that universal
# layer, a `Total` footer in a flat property list would survive into
# the canonical entries and surface as a ghost `Total / Total` row
# after the merge step's PASS-3 code/name mirror. The grouped path
# already filters internally, so the outer filter is a no-op there.
#
# Layout caveats this DOES NOT handle (kept narrow on purpose):
#
#   * Header below first banner ("Pattern B") with NO unit header
#     above. Vanishingly rare; would need a separate detector.
#   * Multi-row banners (property name + address row). The first
#     non-empty cell of the first row of a multi-row banner becomes the
#     synthesized name; extra banner rows are treated as junk and
#     dropped.
#
# What makes a row a "banner":
#   - Exactly ONE non-empty cell (after trimming trailing blanks).
#   - That cell looks like a property name (`_looks_like_property_name`).
#   - It does NOT match any header alias OR any total-prefix exclusion.

# How many rows immediately above the detected header to scan looking
# for the FIRST property-section banner. ResMan's All Units report
# typically writes the first property name on the line just before the
# unit header (then repeats the header at the top of each subsequent
# block). 8 is generous slack — accounts for files that prepend a
# multi-line title block above that first banner.
INITIAL_BANNER_LOOKBACK = 8

# Phrases that mean "this row is a summary / footer, not a property
# banner or a unit row." Compared case-insensitively against the FIRST
# non-empty cell of a row. Anchored — "totally awesome" doesn't match
# because we require either an exact equality or a "<prefix> <stuff>" /
# "<prefix>: <stuff>" / "<prefix>- <stuff>" continuation.
_SUMMARY_PREFIXES: tuple[str, ...] = (
    "total",
    "totals",
    "subtotal",
    "sub total",
    "sub-total",
    "property total",
    "property totals",
    "property subtotal",
    "grand total",
    "grand totals",
    "report total",
    "report totals",
    "summary",
    "page total",
)

# Matches "267 Unit(s)" / "1,247 Units" / "267 unit" — the count cell
# ResMan emits in summary rows. Used as a secondary signal (any cell
# matching this pattern marks the row as a summary).
_UNIT_COUNT_RE = re.compile(
    r"^\s*\d[\d,]*\s*unit\(s\)\s*$|^\s*\d[\d,]*\s*units?\s*$",
    re.IGNORECASE,
)


def _is_summary_token(s: str) -> bool:
    """
    True iff `s` is a bare summary label, anchored.

    Matches:
      * exact equality with a summary prefix ("Total", "Grand Total",
        "Property Total", "Subtotal", …)
      * a prefix followed by ":" or "-" continuation ("Total: 50",
        "Property Total - 12")

    Deliberately does NOT match `"<prefix> <words>"` — that would
    false-positive on real property names that happen to start with
    the word "Total" (e.g. "Total Wine Plaza"). Cells that are
    "<prefix> <something>" without a colon or dash are kept as
    candidate property names; the count-pattern check downstream
    catches the actual ResMan-style summary rows by hitting the
    "N Unit(s)" cell elsewhere on the same row.
    """
    norm = (s or "").strip().lower()
    if not norm:
        return False
    for prefix in _SUMMARY_PREFIXES:
        if norm == prefix:
            return True
        if norm.startswith(prefix + ":"):
            return True
        if norm.startswith(prefix + "-"):
            return True
    return False


def _looks_like_property_name(cell: str) -> bool:
    """
    Heuristic: does `cell` look like a human-readable property name?

    Conservative — we'd rather miss a banner row than treat a stray
    note as one. The check rejects:
      * bare numbers, dates, currency strings (no letters),
      * very short / single-word strings (< 4 chars and no space),
      * column-name lookalikes (anything that normalizes to a known
        header alias),
      * bare-summary lookalikes ("Total", "Property Total", "Total: 50",
        "Subtotal- 12") — see `_is_summary_token` for the exact rule.
        Real property names that just happen to start with the word
        "Total" (e.g. "Total Wine Plaza") still pass — we deliberately
        do NOT reject `"<prefix> <words>"` because it would false-
        positive real names.
      * "N Unit(s)" / "N Units" count fragments.
    """
    s = (cell or "").strip()
    if not s:
        return False
    # Need at least one letter so "12345" / "$123.45" / "2026-04-22"
    # never qualify.
    if not any(ch.isalpha() for ch in s):
        return False
    # Either reasonably long OR multi-word — both signals of a real
    # property name vs an accidental short value.
    if len(s) < 4 and " " not in s:
        return False
    # Don't mistake a column-name lookalike ("Property Code", "Status",
    # "Address") for a banner.
    norm = _normalize_header(s)
    for aliases in _HEADER_ALIASES.values():
        if norm in aliases:
            return False
    # Don't mistake a total/footer label for a banner.
    if _is_summary_token(s):
        return False
    # Don't mistake a count-only string ("267 Unit(s)") for a banner.
    if _UNIT_COUNT_RE.match(s):
        return False
    return True


def _is_banner_row(cells: list[str]) -> str | None:
    """
    Return the banner's property name if `cells` is a section banner;
    None otherwise.

    A banner has exactly one non-empty cell whose text passes the
    `_looks_like_property_name` heuristic. Trailing blanks are
    ignored (Excel commonly pads banners out to the sheet width).
    """
    non_empty = [c for c in cells if c and c.strip()]
    if len(non_empty) != 1:
        return None
    candidate = non_empty[0].strip()
    if _looks_like_property_name(candidate):
        return candidate
    return None


def _is_summary_row(cells: list[str]) -> bool:
    """
    True iff `cells` is a ResMan-style total/subtotal/footer row.

    Detection (either signal is enough):
      1. The FIRST non-empty cell IS a bare summary token — exact
         "Total" / "Property Total" / "Grand Total" / "Subtotal" / …,
         OR a "<prefix>:..." / "<prefix>-..." continuation. Bare-only
         on purpose: a real property called "Total Wine Plaza" should
         NOT be filtered out of the file just because its name starts
         with the word "Total". See `_is_summary_token`.
      2. ANY cell matches the "N Unit(s)" / "N Units" count pattern.
         ResMan totals carry the count in a non-first column; this
         is the strongest signal and catches summary rows whose label
         text doesn't match a known prefix.

    Used both in `_flatten_grouped_units` (to keep the count cell
    "267 Unit(s)" out of the synthesized Unit column) AND in
    `parse_property_upload`'s outer row loop (to drop "Total" footer
    rows from FLAT property-list exports too — without this, a Yardi
    "Total" row would survive as a name="Total" entry and surface as
    a ghost "Total / Total" entry after the merge step's PASS-3 mirror).
    """
    first_non_empty: str | None = None
    for c in cells:
        s = (c or "").strip()
        if s:
            first_non_empty = s
            break
    if first_non_empty is not None and _is_summary_token(first_non_empty):
        return True
    for c in cells:
        s = (c or "").strip()
        if s and _UNIT_COUNT_RE.match(s):
            return True
    return False


def _is_header_repetition(cells: list[str], header_cells: list[str]) -> bool:
    """
    True iff `cells` is (essentially) a repetition of the unit header.

    ResMan paginates the All Units report by property and re-emits the
    column header row at the top of each property block. After
    flattening, those rows would land as fake unit rows with literal
    values like "Unit", "Unit Type", "Unit Status" in the data cells.

    Match strategy: normalize both rows and require that the MAJORITY
    of `cells`' non-empty entries appear as normalized header tokens.
    Robust to ResMan adding/removing one or two blank cells in the
    repeated header (column widths sometimes drift block-to-block).
    """
    norm_header = {_normalize_header(c) for c in header_cells if c.strip()}
    if not norm_header:
        return False
    matches = 0
    non_empty = 0
    for c in cells:
        s = (c or "").strip()
        if not s:
            continue
        non_empty += 1
        if _normalize_header(s) in norm_header:
            matches += 1
    if non_empty < 2:
        # A single-cell row that happens to equal a header token (e.g.
        # an isolated "Status" cell) is more likely a banner / orphan
        # than a repeated header. Defer to the other detectors.
        return False
    # Majority rule: enough cells line up that this row is the header
    # restated, not a coincidence of one or two overlaps.
    return matches >= (non_empty // 2 + 1)


def _header_has_property_identity(header_cells: list[str]) -> bool:
    """
    Does this header already carry a property-identity column?

    True iff any header cell normalizes to a property_code or
    property_name alias. Used as the "skip flattening" gate — if the
    header already has property identity, the file is a flat table
    and we don't need to synthesize a name column.
    """
    code_aliases = set(_HEADER_ALIASES["property_code"])
    name_aliases = set(_HEADER_ALIASES["property_name"])
    identity_aliases = code_aliases | name_aliases
    for cell in header_cells:
        if _normalize_header(cell) in identity_aliases:
            return True
    return False


def _header_has_unit_identity(header_cells: list[str]) -> bool:
    """True iff the header has a unit_number alias somewhere."""
    unit_aliases = set(_HEADER_ALIASES["unit_number"])
    for cell in header_cells:
        if _normalize_header(cell) in unit_aliases:
            return True
    return False


def _flatten_grouped_units(
    rows: list[list[str]],
    header_idx: int,
    header_cells: list[str],
) -> tuple[list[str], list[list[str]], str] | None:
    """
    Detect a ResMan All Units-style grouped layout and flatten it.

    Returns `(new_header, flat_data_rows, warning)` when the file
    matches the grouped layout, or `None` otherwise. When None, the
    caller should fall back to the plain-table path.

    Detection signals (ALL required):
      1. Header has unit-identity tokens (Unit, Apt, Unit Number, …).
      2. Header has NO property-identity tokens (Property, Property
         Code, Property Name, …). If it does, the file is already
         flat and doesn't need synthesizing.
      3. ≥1 row in the file (above OR below the header) passes
         `_is_banner_row`. The above-header scan is the
         initial-banner-recovery step described below.

    Initial-banner recovery: ResMan typically writes the FIRST
    property name on a row immediately above the unit header (and
    repeats the header at the top of each subsequent block). Without
    recovery, every unit of that first property would appear before
    any below-header banner and be dropped as an orphan. We scan up
    to `INITIAL_BANNER_LOOKBACK` rows above the header for a banner
    and seed `current_banner` with the closest match.

    Per-row filtering inside the main loop, in order:
      * blank rows (skipped silently — section separator)
      * summary rows (`_is_summary_row`) — Property Total / Grand
        Total / "267 Unit(s)" — dropped + counted
      * repeated header rows (`_is_header_repetition`) — dropped +
        counted. ResMan emits these at the top of each block.
      * banner rows (`_is_banner_row`) — switch `current_banner`
      * everything else: prepend `current_banner` and emit, OR drop
        as orphan if no banner is active yet.

    The new header is `("Property Name", *header_cells)`. Banner
    rows themselves are dropped from the output.
    """
    if not _header_has_unit_identity(header_cells):
        return None
    if _header_has_property_identity(header_cells):
        return None

    data_rows = rows[header_idx + 1 :]

    # ---- Initial-banner recovery -------------------------------------
    # Scan UP from the header (closest row first) looking for a banner.
    # Tightened `_is_banner_row` already rejects "Total"-shaped rows,
    # so we won't accidentally seed with a footer from a previous
    # report.
    initial_banner: str | None = None
    lookback_start = max(0, header_idx - INITIAL_BANNER_LOOKBACK)
    for above_idx in range(header_idx - 1, lookback_start - 1, -1):
        cells_above = [(c or "").strip() for c in rows[above_idx]]
        candidate_banner = _is_banner_row(cells_above)
        if candidate_banner is not None:
            initial_banner = candidate_banner
            break

    # First-pass scan: do we see at least one banner anywhere (above
    # OR below the header)? Without one, this is just a flat unit-only
    # file (e.g. unit roster for a single implicit property) and the
    # plain-table path handles it correctly.
    saw_below_banner = False
    for raw_row in data_rows:
        cells = [(c or "").strip() for c in raw_row]
        if _is_summary_row(cells):
            continue
        if _is_header_repetition(cells, header_cells):
            continue
        if _is_banner_row(cells) is not None:
            saw_below_banner = True
            break
    if not (saw_below_banner or initial_banner):
        return None

    new_header: list[str] = ["Property Name", *header_cells]

    flat_rows: list[list[str]] = []
    current_banner: str | None = initial_banner
    # The recovered initial banner counts as a found section; it just
    # came from above the header rather than below it.
    banner_count = 1 if initial_banner else 0
    orphan_unit_count = 0
    summary_count = 0
    header_repeat_count = 0

    for raw_row in data_rows:
        cells = [(c or "").strip() for c in raw_row]
        if not any(cells):
            # Blank rows separate sections — preserve the active banner
            # so the next unit row still attributes correctly.
            continue
        # Filter total/footer rows BEFORE banner detection — a row like
        # "Property Total | | 267 Unit(s)" used to leak through and
        # become a fake unit row with "267 Unit(s)" in the Unit column.
        if _is_summary_row(cells):
            summary_count += 1
            continue
        # Filter the per-block repeated unit header — without this,
        # rows like ("Vista Apartments", "Unit", "Unit Type", "Status",
        # …) would land in the synthesized output.
        if _is_header_repetition(cells, header_cells):
            header_repeat_count += 1
            continue
        banner = _is_banner_row(cells)
        if banner is not None:
            current_banner = banner
            banner_count += 1
            continue
        if current_banner is None:
            # Unit row before any banner — we have no name to attach.
            # Drop it and count it for the warning copy.
            orphan_unit_count += 1
            continue
        flat_rows.append([current_banner, *cells])

    if not flat_rows:
        # Banners / recovery fired but nothing usable came out — fall
        # back to the plain-table path so the user at least sees the
        # raw header (and a parser-found-no-rows warning later).
        return None

    parts: list[str] = [
        "Detected a grouped report (property-name banner rows interleaved "
        "with unit rows). Flattened it into a table by adding a "
        'synthesized "Property Name" column and filling each unit row '
        f"with the banner above it ({banner_count} property "
        f"section{'' if banner_count == 1 else 's'} found)."
    ]
    if initial_banner:
        parts.append(
            f"Recovered '{initial_banner}' as the first property block's "
            "banner — it appeared above the unit header, so its units "
            "would otherwise have been dropped."
        )
    if summary_count:
        parts.append(
            f"Skipped {summary_count} summary "
            f"row{'' if summary_count == 1 else 's'} (Property Total / "
            "Grand Total / similar footer)."
        )
    if header_repeat_count:
        parts.append(
            f"Skipped {header_repeat_count} repeated header "
            f"row{'' if header_repeat_count == 1 else 's'} that appeared "
            "between property blocks."
        )
    if orphan_unit_count:
        parts.append(
            f"Skipped {orphan_unit_count} unit "
            f"row{'' if orphan_unit_count == 1 else 's'} that appeared "
            "before any property banner — those couldn't be attributed "
            "to a property."
        )
    warning = " ".join(parts)

    return new_header, flat_rows, warning


# ---------------------------------------------------------------------------
# Row padding
# ---------------------------------------------------------------------------


def _pad_or_truncate(row: list[str], width: int) -> list[str]:
    """
    Normalize a data row to exactly `width` cells.

    Shorter rows are padded with empty strings (CSV dialect where
    trailing empty cells get elided); longer rows are truncated to
    the header width (anything beyond the last named column is
    ignored — we can't map it anywhere canonical).
    """
    cleaned = [(c or "").strip() for c in row[:width]]
    if len(cleaned) < width:
        cleaned.extend([""] * (width - len(cleaned)))
    return cleaned


# ---------------------------------------------------------------------------
# Empty-response helper
# ---------------------------------------------------------------------------


def _empty_response(
    filename: str,
    fmt: Literal["csv", "xlsx"],
    warning: str,
) -> ParsedPropertyUpload:
    return ParsedPropertyUpload(
        filename=filename or "upload",
        detected_format=fmt,
        source_columns=[],
        source_rows=[],
        suggested_mapping=PropertyUploadMapping(),
        parse_warning=warning,
    )


# ---------------------------------------------------------------------------
# Cell utilities (mirrors `gl_upload_parse._clean_cell_text`)
# ---------------------------------------------------------------------------


_NON_PRINTING_RE = re.compile(
    r"[\x00-\x08\x0b\x0c\x0e-\x1f\u00ad\u200b-\u200f\u202a-\u202e\u2060\ufeff\ufffd]"
)


def _clean_cell_text(s: object) -> str:
    """Coerce to str + strip non-printing chars. Idempotent."""
    if s is None:
        return ""
    text = s if isinstance(s, str) else str(s)
    return _NON_PRINTING_RE.sub("", text)


def _xlsx_cell_to_str(cell: object) -> str:
    """openpyxl cell value → cleaned string. Mirrors gl_upload_parse."""
    if cell is None:
        return ""
    return _clean_cell_text(str(cell))
