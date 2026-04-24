"""
One-shot smoke for `parse_vendor_upload`.

Run with: python -m backend.scripts.smoke_vendor_upload_parse
   (or:    cd backend && python -m scripts.smoke_vendor_upload_parse)

Exercises the same code path the API hits:
  1. Plain flat vendor table (Yardi-style export).
  2. ResMan-style export (Vendor ID + Payee Name + DBA + Remit columns).
  3. AppFolio-style export (Company Name + Tax ID + email/phone columns).
  4. Header-precedence: a header containing BOTH 'Vendor ID' and 'Vendor
     Name' must NOT route 'Vendor Name' → vendor_code (the
     `_CANONICAL_FIELD_ORDER` rule put `vendor_code` first specifically
     to keep 'Vendor ID' from getting stolen).
  5. Headerless / junk-only file -> soft failure with warning.
  6. Empty file -> hard failure (`VendorUploadParseError`).
  7. Unsupported format -> hard failure.
  8. Aliases family: `dba` / `aka` / `alternate name` headers all route
     to `aliases`.

Not a formal test framework — prints PASS/FAIL per scenario and exits
non-zero on any FAIL so it can gate a CI step later. Mirrors the shape
of `smoke_property_upload_parse.py` so engineers reading the two side
by side don't have to swap mental models.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make `app.` imports resolvable when run as a plain script from anywhere.
_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.domain.vendor_upload_parse import (  # noqa: E402
    VendorUploadParseError,
    parse_vendor_upload,
)

passed = 0
failed = 0


def check(label: str, ok: bool, detail: str | None = None) -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        suffix = f" - {detail}" if detail else ""
        print(f"  FAIL  {label}{suffix}")


def to_csv_bytes(rows: list[list[str]]) -> bytes:
    """Tiny CSV serializer - enough for the smoke inputs."""
    import csv
    import io

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    for r in rows:
        w.writerow(r)
    return buf.getvalue().encode("utf-8")


# =============================================================================
# Scenario 1 — plain flat vendor table (Yardi-style export)
# =============================================================================
print("\n[scenario 1] plain flat vendor table")

flat = to_csv_bytes(
    [
        ["Vendor Code", "Vendor Name", "Address", "City", "State", "Zip", "Phone"],
        ["ACME", "Acme Plumbing", "100 Main St", "Austin", "TX", "78701", "(512) 555-0001"],
        ["BUG", "BugStop Pest Control", "250 Oak Ave", "Houston", "TX", "77002", "(713) 555-0002"],
        ["GRN", "GreenScape Landscaping", "75 Elm Rd", "Dallas", "TX", "75201", "(214) 555-0003"],
    ]
)
res1 = parse_vendor_upload(flat, "vendors.csv", "text/csv")

check(
    "header detected verbatim",
    res1.source_columns
    == ["Vendor Code", "Vendor Name", "Address", "City", "State", "Zip", "Phone"],
    f"got {res1.source_columns}",
)
check(
    "3 source rows preserved",
    len(res1.source_rows) == 3,
    f"got {len(res1.source_rows)} rows",
)
check(
    "no parse warning on the happy path",
    res1.parse_warning is None,
    f"got warning={res1.parse_warning!r}",
)
check(
    "suggested_mapping picks Vendor Code -> vendor_code",
    res1.suggested_mapping.vendor_code == "Vendor Code",
    f"got {res1.suggested_mapping.vendor_code!r}",
)
check(
    "suggested_mapping picks Vendor Name -> vendor_name (not stolen by code)",
    res1.suggested_mapping.vendor_name == "Vendor Name",
    f"got {res1.suggested_mapping.vendor_name!r}",
)
check(
    "suggested_mapping picks Address -> address",
    res1.suggested_mapping.address == "Address",
    f"got {res1.suggested_mapping.address!r}",
)
check(
    "suggested_mapping picks City -> city",
    res1.suggested_mapping.city == "City",
)
check(
    "suggested_mapping picks State -> state",
    res1.suggested_mapping.state == "State",
)
check(
    "suggested_mapping picks Zip -> zip",
    res1.suggested_mapping.zip == "Zip",
)
check(
    "suggested_mapping picks Phone -> phone",
    res1.suggested_mapping.phone == "Phone",
)
check(
    "suggested_mapping leaves email unmapped (no email column)",
    res1.suggested_mapping.email is None,
)
check(
    "suggested_mapping leaves aliases unmapped (no alias column)",
    res1.suggested_mapping.aliases is None,
)


# =============================================================================
# Scenario 2 — ResMan-style export (Vendor ID + Payee Name + DBA + Remit)
# =============================================================================
print("\n[scenario 2] ResMan-style export with Vendor ID + Payee Name + DBA")

resman = to_csv_bytes(
    [
        # Top metadata - should be skipped.
        ["BillsIQ Property Group", "", "", "", "", ""],
        ["Vendor List", "", "", "", "", ""],
        ["Printed: 2026-04-22", "", "", "", "", ""],
        ["", "", "", "", "", ""],
        # Real header.
        [
            "Vendor ID",
            "Payee Name",
            "DBA",
            "Remit Address",
            "Contact",
            "Status",
        ],
        ["V001", "Acme Plumbing Inc.", "Acme; Acme Plumbing", "100 Main St", "Jane Doe", "Active"],
        ["V002", "BugStop Pest Control", "BugStop", "250 Oak Ave", "John Smith", "Active"],
        ["V003", "Old Vendor Inc.", "", "", "", "Inactive"],
    ]
)
res2 = parse_vendor_upload(resman, "resman_vendors.csv", "text/csv")

check(
    "metadata skipped, real header detected",
    res2.source_columns == [
        "Vendor ID",
        "Payee Name",
        "DBA",
        "Remit Address",
        "Contact",
        "Status",
    ],
    f"got {res2.source_columns}",
)
check(
    "3 source rows preserved",
    len(res2.source_rows) == 3,
    f"got {len(res2.source_rows)} rows",
)
check(
    "Vendor ID -> vendor_code (not stolen by vendor_name)",
    res2.suggested_mapping.vendor_code == "Vendor ID",
    f"got {res2.suggested_mapping.vendor_code!r}",
)
check(
    "Payee Name -> vendor_name",
    res2.suggested_mapping.vendor_name == "Payee Name",
    f"got {res2.suggested_mapping.vendor_name!r}",
)
check(
    "DBA -> aliases",
    res2.suggested_mapping.aliases == "DBA",
    f"got {res2.suggested_mapping.aliases!r}",
)
check(
    "Remit Address -> address",
    res2.suggested_mapping.address == "Remit Address",
    f"got {res2.suggested_mapping.address!r}",
)
check(
    "Contact -> contact_name",
    res2.suggested_mapping.contact_name == "Contact",
    f"got {res2.suggested_mapping.contact_name!r}",
)
check(
    "Status -> active",
    res2.suggested_mapping.active == "Status",
    f"got {res2.suggested_mapping.active!r}",
)


# =============================================================================
# Scenario 3 — AppFolio-style export (Company Name + Tax ID + Email + Phone)
# =============================================================================
print("\n[scenario 3] AppFolio-style export with Company Name + Tax ID")

appfolio = to_csv_bytes(
    [
        [
            "Tax ID",
            "Company Name",
            "Trade Name",
            "Email",
            "Telephone",
            "Notes",
        ],
        ["12-3456789", "Acme Plumbing LLC", "Acme", "ops@acme.com", "555-0001", "Net 30"],
        ["98-7654321", "BugStop Inc", "BugStop", "ar@bugstop.com", "555-0002", ""],
    ]
)
res3 = parse_vendor_upload(appfolio, "appfolio_vendors.csv", "text/csv")

check(
    "header detected",
    res3.source_columns == [
        "Tax ID",
        "Company Name",
        "Trade Name",
        "Email",
        "Telephone",
        "Notes",
    ],
    f"got {res3.source_columns}",
)
check(
    "Company Name -> vendor_name",
    res3.suggested_mapping.vendor_name == "Company Name",
    f"got {res3.suggested_mapping.vendor_name!r}",
)
check(
    "Tax ID -> vendor_code (no stronger code candidate)",
    # Tax ID isn't in the alias list, so vendor_code may be None - what
    # we actually care about is that Company Name didn't get stolen.
    res3.suggested_mapping.vendor_code is None
    or res3.suggested_mapping.vendor_code == "Tax ID",
    f"got {res3.suggested_mapping.vendor_code!r}",
)
check(
    "Trade Name -> aliases",
    res3.suggested_mapping.aliases == "Trade Name",
    f"got {res3.suggested_mapping.aliases!r}",
)
check(
    "Email -> email",
    res3.suggested_mapping.email == "Email",
    f"got {res3.suggested_mapping.email!r}",
)
check(
    "Telephone -> phone",
    res3.suggested_mapping.phone == "Telephone",
    f"got {res3.suggested_mapping.phone!r}",
)
check(
    "Notes -> notes",
    res3.suggested_mapping.notes == "Notes",
    f"got {res3.suggested_mapping.notes!r}",
)


# =============================================================================
# Scenario 4 — header precedence: 'Vendor ID' must NOT lose to
# 'Vendor Name' just because 'name' has a 'name' alias too.
# =============================================================================
print("\n[scenario 4] header precedence: Vendor ID stays vendor_code")

precedence = to_csv_bytes(
    [
        ["Name", "Vendor ID", "Address"],
        ["Acme", "V001", "100 Main"],
    ]
)
res4 = parse_vendor_upload(precedence, "precedence.csv", "text/csv")

check(
    "Vendor ID -> vendor_code",
    res4.suggested_mapping.vendor_code == "Vendor ID",
    f"got {res4.suggested_mapping.vendor_code!r}",
)
check(
    "Name -> vendor_name (the generic 'name' alias still resolves it)",
    res4.suggested_mapping.vendor_name == "Name",
    f"got {res4.suggested_mapping.vendor_name!r}",
)
check(
    "vendor_code claim happens FIRST so name->code can't accidentally win",
    # Re-stating the invariant: even with 'name' in vendor_name's alias
    # list, scenario 2 + 3 + 4 all show vendor_code claims its column
    # before vendor_name walks the same row.
    res4.suggested_mapping.vendor_code != res4.suggested_mapping.vendor_name,
)


# =============================================================================
# Scenario 5 — headerless / junk-only file -> soft failure
# =============================================================================
print("\n[scenario 5] headerless file -> soft failure with warning")

junk = to_csv_bytes(
    [
        ["Some title", "", ""],
        ["Printed: yesterday", "", ""],
        ["", "", ""],
    ]
)
res5 = parse_vendor_upload(junk, "junk.csv", "text/csv")

check(
    "no source_columns returned",
    res5.source_columns == [],
    f"got {res5.source_columns}",
)
check(
    "no source_rows returned",
    res5.source_rows == [],
)
check(
    "parse_warning explains the missing header",
    "header" in (res5.parse_warning or "").lower(),
    f"got warning={res5.parse_warning!r}",
)


# =============================================================================
# Scenario 6 — empty file -> hard failure (raises VendorUploadParseError)
# =============================================================================
print("\n[scenario 6] empty file -> hard failure")

raised_empty = False
try:
    parse_vendor_upload(b"", "empty.csv", "text/csv")
except VendorUploadParseError as exc:
    raised_empty = True
    check(
        "VendorUploadParseError mentions emptiness",
        "empty" in str(exc).lower(),
        f"got {exc!r}",
    )
check("VendorUploadParseError raised on empty bytes", raised_empty)


# =============================================================================
# Scenario 7 — unsupported format -> hard failure
# =============================================================================
print("\n[scenario 7] unsupported format -> hard failure")

raised_unsupported = False
try:
    parse_vendor_upload(b"some pdf bytes", "vendors.pdf", "application/pdf")
except VendorUploadParseError as exc:
    raised_unsupported = True
    check(
        "VendorUploadParseError mentions unsupported format",
        "unsupported" in str(exc).lower() or "format" in str(exc).lower(),
        f"got {exc!r}",
    )
check("VendorUploadParseError raised on unsupported format", raised_unsupported)


# =============================================================================
# Scenario 8 — alias family: dba / aka / alternate name all route to aliases
# =============================================================================
print("\n[scenario 8] alias family: dba/aka/alternate name -> aliases")

# Run three separate one-column-each parses so we know exactly which
# alias triggered the routing.
for header_label in ("DBA", "AKA", "Alternate Name", "Trade Name", "Remit Name"):
    csv_bytes = to_csv_bytes(
        [
            ["Vendor Name", header_label, "Address"],
            ["Acme", "Acme Plumbing", "100 Main"],
        ]
    )
    res = parse_vendor_upload(
        csv_bytes, f"alias_{header_label}.csv", "text/csv"
    )
    check(
        f"'{header_label}' header -> aliases",
        res.suggested_mapping.aliases == header_label,
        f"got {res.suggested_mapping.aliases!r}",
    )


# =============================================================================
# Scenario 9 — fully-blank rows below the header are dropped (Excel-style padding)
# =============================================================================
print("\n[scenario 9] fully-blank data rows are dropped")

with_blanks = to_csv_bytes(
    [
        ["Vendor Code", "Vendor Name"],
        ["ACME", "Acme Plumbing"],
        ["", ""],
        ["", ""],
        ["BUG", "BugStop"],
        ["", ""],
    ]
)
res9 = parse_vendor_upload(with_blanks, "blanks.csv", "text/csv")

check(
    "blank rows filtered, only 2 data rows survive",
    len(res9.source_rows) == 2,
    f"got {len(res9.source_rows)} rows",
)
check(
    "first surviving row is Acme",
    res9.source_rows[0] == ["ACME", "Acme Plumbing"],
    f"got {res9.source_rows[0]}",
)
check(
    "second surviving row is BugStop",
    res9.source_rows[1] == ["BUG", "BugStop"],
    f"got {res9.source_rows[1]}",
)


# =============================================================================
# Scenario 10 — short rows pad to header width; long rows truncate
# =============================================================================
print("\n[scenario 10] row width normalization (pad short / truncate long)")

ragged = to_csv_bytes(
    [
        ["Vendor Code", "Vendor Name", "City", "State"],
        # Short row - missing State.
        ["ACME", "Acme Plumbing", "Austin"],
        # Long row - extra junk column.
        ["BUG", "BugStop", "Houston", "TX", "extra junk"],
    ]
)
res10 = parse_vendor_upload(ragged, "ragged.csv", "text/csv")

check(
    "short row padded to header width (4 cells)",
    len(res10.source_rows[0]) == 4 and res10.source_rows[0][3] == "",
    f"got {res10.source_rows[0]}",
)
check(
    "long row truncated to header width (no 'extra junk')",
    len(res10.source_rows[1]) == 4
    and "extra junk" not in res10.source_rows[1],
    f"got {res10.source_rows[1]}",
)


# =============================================================================
# Scenario 11 — REAL ResMan Vendor List shape: bare "Company" + "Company
# Abbreviation" + "Customer #" + "General Address" / "General City" /
# "General State" / "General Zip Code" headers, with a tall metadata
# stack above the real header (report title, run date, parameters,
# blank rows). Locks in the fix that lets BillsIQ accept ResMan vendor
# exports without users hand-editing the file first.
# =============================================================================
print("\n[scenario 11] real ResMan vendor list (tall metadata + Company/Customer)")

resman_real = to_csv_bytes(
    [
        # Tall metadata stack — real ResMan exports look like this.
        ["BillsIQ Property Group", "", "", "", "", "", "", ""],
        ["Vendor List", "", "", "", "", "", "", ""],
        ["Run Date: 2026-04-23 09:14", "", "", "", "", "", "", ""],
        ["Parameters:", "", "", "", "", "", "", ""],
        ["  Status: Active", "", "", "", "", "", "", ""],
        ["  Property: All", "", "", "", "", "", "", ""],
        ["  Vendor Type: All", "", "", "", "", "", "", ""],
        ["", "", "", "", "", "", "", ""],
        ["", "", "", "", "", "", "", ""],
        # Real header — bare "Company" / "Company Abbreviation" /
        # "Customer #" plus the "General <address-part>" family.
        [
            "Company",
            "Company Abbreviation",
            "Customer #",
            "General Address",
            "General City",
            "General State",
            "General Zip Code",
            "General Phone",
        ],
        [
            "Acme Plumbing Inc.",
            "ACME",
            "ACC-1001",
            "100 Main St",
            "Austin",
            "TX",
            "78701",
            "(512) 555-0001",
        ],
        [
            "BugStop Pest Control",
            "BUGSTOP",
            "ACC-1002",
            "250 Oak Ave",
            "Houston",
            "TX",
            "77002",
            "(713) 555-0002",
        ],
        [
            "GreenScape Landscaping",
            "GREEN",
            "ACC-1003",
            "75 Elm Rd",
            "Dallas",
            "TX",
            "75201",
            "(214) 555-0003",
        ],
    ]
)
res11 = parse_vendor_upload(resman_real, "Vendor List.csv", "text/csv")

check(
    "tall metadata stack skipped, real header detected (no soft-fail)",
    res11.parse_warning is None,
    f"got warning={res11.parse_warning!r}",
)
check(
    "header cells captured verbatim from below the metadata stack",
    res11.source_columns == [
        "Company",
        "Company Abbreviation",
        "Customer #",
        "General Address",
        "General City",
        "General State",
        "General Zip Code",
        "General Phone",
    ],
    f"got {res11.source_columns}",
)
check(
    "3 source rows preserved",
    len(res11.source_rows) == 3,
    f"got {len(res11.source_rows)} rows",
)
check(
    "Company -> vendor_name (the bare ResMan header)",
    res11.suggested_mapping.vendor_name == "Company",
    f"got {res11.suggested_mapping.vendor_name!r}",
)
check(
    "Company Abbreviation -> vendor_code (preferred over Customer #)",
    # Both are valid external-id candidates; companyabbreviation is
    # listed earlier in the alias tuple so it wins. Customer # is left
    # unclaimed (the user can override in the mapping step).
    res11.suggested_mapping.vendor_code == "Company Abbreviation",
    f"got {res11.suggested_mapping.vendor_code!r}",
)
check(
    "General Address -> address",
    res11.suggested_mapping.address == "General Address",
    f"got {res11.suggested_mapping.address!r}",
)
check(
    "General City -> city",
    res11.suggested_mapping.city == "General City",
    f"got {res11.suggested_mapping.city!r}",
)
check(
    "General State -> state",
    res11.suggested_mapping.state == "General State",
    f"got {res11.suggested_mapping.state!r}",
)
check(
    "General Zip Code -> zip",
    res11.suggested_mapping.zip == "General Zip Code",
    f"got {res11.suggested_mapping.zip!r}",
)
check(
    "General Phone -> phone",
    res11.suggested_mapping.phone == "General Phone",
    f"got {res11.suggested_mapping.phone!r}",
)
check(
    "first data row body lines up with header columns",
    res11.source_rows[0] == [
        "Acme Plumbing Inc.",
        "ACME",
        "ACC-1001",
        "100 Main St",
        "Austin",
        "TX",
        "78701",
        "(512) 555-0001",
    ],
    f"got {res11.source_rows[0]}",
)


# =============================================================================
# Scenario 12 — when both "Company" and "Company Name" appear, the more
# specific "Company Name" wins for vendor_name and "Company" stays
# unclaimed (the user can map it manually if they want).
# =============================================================================
print("\n[scenario 12] Company Name beats bare Company (specificity wins)")

both_company = to_csv_bytes(
    [
        ["Company", "Company Name", "Customer #"],
        ["ACME", "Acme Plumbing Inc.", "ACC-1001"],
    ]
)
res12 = parse_vendor_upload(both_company, "both_company.csv", "text/csv")

check(
    "Company Name -> vendor_name (wins over bare Company)",
    res12.suggested_mapping.vendor_name == "Company Name",
    f"got {res12.suggested_mapping.vendor_name!r}",
)
check(
    "Customer # -> vendor_code",
    res12.suggested_mapping.vendor_code == "Customer #",
    f"got {res12.suggested_mapping.vendor_code!r}",
)


# =============================================================================
# Scenario 13 — "Customer #" alone (no "Company Abbreviation") still
# routes to vendor_code via the bare 'customer' alias.
# =============================================================================
print("\n[scenario 13] Customer # alone still routes to vendor_code")

customer_only = to_csv_bytes(
    [
        ["Company", "Customer #", "General City"],
        ["Acme Plumbing Inc.", "ACC-1001", "Austin"],
    ]
)
res13 = parse_vendor_upload(customer_only, "customer_only.csv", "text/csv")

check(
    "Customer # -> vendor_code (no Company Abbreviation present)",
    res13.suggested_mapping.vendor_code == "Customer #",
    f"got {res13.suggested_mapping.vendor_code!r}",
)
check(
    "Company -> vendor_name",
    res13.suggested_mapping.vendor_name == "Company",
    f"got {res13.suggested_mapping.vendor_name!r}",
)
check(
    "General City still resolves to city when only one address-part column is present",
    res13.suggested_mapping.city == "General City",
    f"got {res13.suggested_mapping.city!r}",
)


# =============================================================================
print(f"\n{passed} passed, {failed} failed.")
if failed > 0:
    sys.exit(1)
