"""
One-shot smoke for `parse_property_upload`.

Run with: python -m backend.scripts.smoke_property_upload_parse
   (or:    cd backend && python -m scripts.smoke_property_upload_parse)

Exercises the same code path the API hits:
  1. Plain flat table — usual Yardi-style export.
  2. ResMan All Units grouped report — header is unit-only, banner
     rows above each unit block. The flattener must synthesize a
     "Property Name" column and fill it down per banner.
  3. Headerless / junk-only soft failure.
  4. Single-property unit roster (no banners, header lacks property
     identity but only one implicit property -> flatten short-circuits
     to None and the plain-table path runs).

Not a formal test framework — prints PASS/FAIL per scenario and exits
non-zero on any FAIL so it can gate a CI step later.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make `app.` imports resolvable when run as a plain script from anywhere.
_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.domain.property_upload_parse import (  # noqa: E402
    parse_property_upload,
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
# Scenario 1 — plain flat table (Yardi / AppFolio style)
# =============================================================================
print("\n[scenario 1] plain flat property-list table")

flat = to_csv_bytes(
    [
        ["Property Code", "Property Name", "Address", "City", "State", "Zip"],
        ["VST", "Vista Apartments", "100 Sunset Drive", "Austin", "TX", "78701"],
        ["OAK", "Oakwood Plaza", "250 Elm Street", "Houston", "TX", "77002"],
    ]
)
res1 = parse_property_upload(flat, "property_list.csv", "text/csv")

check(
    "header detected verbatim, no flattening",
    res1.source_columns
    == ["Property Code", "Property Name", "Address", "City", "State", "Zip"],
    f"got {res1.source_columns}",
)
check(
    "2 source rows preserved",
    len(res1.source_rows) == 2,
    f"got {len(res1.source_rows)} rows",
)
check(
    "no parse warning on the happy path",
    res1.parse_warning is None,
    f"got warning={res1.parse_warning!r}",
)
check(
    "suggested_mapping picks Property Code -> property_code",
    res1.suggested_mapping.property_code == "Property Code",
)
check(
    "suggested_mapping picks Property Name -> property_name",
    res1.suggested_mapping.property_name == "Property Name",
)


# =============================================================================
# Scenario 2 — ResMan All Units grouped report
# =============================================================================
print("\n[scenario 2] ResMan All Units grouped report")

grouped = to_csv_bytes(
    [
        # Top junk — should be skipped by header detection.
        ["BillsIQ Property Group", "", "", "", ""],
        ["All Units Report", "", "", "", ""],
        ["Printed: 2026-04-22", "", "", "", ""],
        ["", "", "", "", ""],
        # Real header — unit-only, no property tokens.
        ["Unit", "Type", "Building", "Status", "Sqft"],
        # First section banner.
        ["Vista Apartments", "", "", "", ""],
        ["101", "1BR", "A", "Occupied", "650"],
        ["102", "2BR", "A", "Vacant", "900"],
        ["203", "1BR", "B", "Occupied", "650"],
        # Blank section separator.
        ["", "", "", "", ""],
        # Second section banner.
        ["Oakwood Plaza", "", "", "", ""],
        ["1A", "2BR", "Main", "Occupied", "950"],
        ["1B", "2BR", "Main", "Occupied", "950"],
        # Third section — only one unit.
        ["Mountain Crest", "", "", "", ""],
        ["301", "Studio", "Tower", "Occupied", "450"],
    ]
)
res2 = parse_property_upload(grouped, "all_units.csv", "text/csv")

check(
    "synthesized header prepends 'Property Name'",
    res2.source_columns[0] == "Property Name",
    f"got first col={res2.source_columns[0]!r}",
)
check(
    "rest of header preserved verbatim after synthesized column",
    res2.source_columns[1:] == ["Unit", "Type", "Building", "Status", "Sqft"],
    f"got {res2.source_columns}",
)
check(
    "6 unit rows produced (3 + 2 + 1, banners dropped)",
    len(res2.source_rows) == 6,
    f"got {len(res2.source_rows)} rows",
)
check(
    "first unit row attributed to Vista Apartments",
    res2.source_rows[0][0] == "Vista Apartments"
    and res2.source_rows[0][1] == "101",
)
check(
    "third unit row still attributed to Vista Apartments (fill-down)",
    res2.source_rows[2][0] == "Vista Apartments"
    and res2.source_rows[2][1] == "203",
)
check(
    "fourth unit row attributed to Oakwood Plaza (banner switch)",
    res2.source_rows[3][0] == "Oakwood Plaza"
    and res2.source_rows[3][1] == "1A",
)
check(
    "sixth unit row attributed to Mountain Crest (last banner)",
    res2.source_rows[5][0] == "Mountain Crest"
    and res2.source_rows[5][1] == "301",
)
check(
    "no banner row appears in source_rows",
    all(r[1] != "" for r in res2.source_rows),
    "expected every output row to have a non-empty Unit column",
)
check(
    "parse_warning explains the flattening",
    (res2.parse_warning or "").startswith(
        "Detected a grouped report"
    ),
    f"got warning={res2.parse_warning!r}",
)
check(
    "suggested_mapping picks 'Property Name' for property_name",
    res2.suggested_mapping.property_name == "Property Name",
    f"got {res2.suggested_mapping.property_name!r}",
)
check(
    "suggested_mapping picks 'Unit' for unit_number",
    res2.suggested_mapping.unit_number == "Unit",
    f"got {res2.suggested_mapping.unit_number!r}",
)
check(
    "suggested_mapping leaves property_code unmapped (no code column)",
    res2.suggested_mapping.property_code is None,
    f"got {res2.suggested_mapping.property_code!r}",
)


# =============================================================================
# Scenario 3 — headerless / junk-only file
# =============================================================================
print("\n[scenario 3] headerless file -> soft failure with warning")

junk = to_csv_bytes(
    [
        ["Some title", "", ""],
        ["Printed: yesterday", "", ""],
        ["", "", ""],
    ]
)
res3 = parse_property_upload(junk, "junk.csv", "text/csv")

check(
    "no source_columns returned",
    res3.source_columns == [],
    f"got {res3.source_columns}",
)
check(
    "no source_rows returned",
    res3.source_rows == [],
)
check(
    "parse_warning explains the missing header",
    "header" in (res3.parse_warning or "").lower(),
    f"got warning={res3.parse_warning!r}",
)


# =============================================================================
# Scenario 4 — single-property unit roster (no banners, header lacks property
# identity). Should NOT flatten — flatten_grouped_units returns None and the
# plain-table path runs through with the original header.
# =============================================================================
print("\n[scenario 4] single-property unit roster - flattening short-circuits")

unit_only = to_csv_bytes(
    [
        ["Unit", "Type", "Building", "Status"],
        ["101", "1BR", "A", "Occupied"],
        ["102", "2BR", "A", "Vacant"],
        ["103", "1BR", "B", "Occupied"],
    ]
)
res4 = parse_property_upload(unit_only, "unit_roster.csv", "text/csv")

check(
    "header preserved (no synthesized 'Property Name' column)",
    res4.source_columns == ["Unit", "Type", "Building", "Status"],
    f"got {res4.source_columns}",
)
check(
    "3 source rows preserved verbatim",
    len(res4.source_rows) == 3
    and res4.source_rows[0] == ["101", "1BR", "A", "Occupied"],
)
check(
    "no flatten warning emitted",
    not (res4.parse_warning or "").startswith("Detected a grouped report"),
    f"got warning={res4.parse_warning!r}",
)


# =============================================================================
# Scenario 5 — grouped report where unit rows appear BEFORE the first banner
# (orphan units). Those rows should be dropped and counted in the warning.
# =============================================================================
print("\n[scenario 5] grouped report with orphan unit rows")

orphan = to_csv_bytes(
    [
        ["Unit", "Type", "Status"],
        # Two orphan rows — no banner above them.
        ["999", "1BR", "Inactive"],
        ["998", "1BR", "Inactive"],
        # First banner.
        ["Vista Apartments", "", ""],
        ["101", "1BR", "Occupied"],
        ["102", "2BR", "Vacant"],
    ]
)
res5 = parse_property_upload(orphan, "orphans.csv", "text/csv")

check(
    "orphan unit rows dropped - only 2 rows survive",
    len(res5.source_rows) == 2,
    f"got {len(res5.source_rows)} rows",
)
check(
    "warning mentions the dropped orphans",
    "Skipped 2 unit rows" in (res5.parse_warning or ""),
    f"got warning={res5.parse_warning!r}",
)


# =============================================================================
# Scenario 6 - initial-banner recovery (first property name ABOVE the header)
#
# Mirrors a real ResMan All Units export. The first property name
# sits on a row before the unit header; subsequent blocks have their
# banner BELOW the header with a repeated unit-header at the top of
# the block. Without recovery, the first property's units would be
# dropped as orphans.
# =============================================================================
print("\n[scenario 6] initial-banner recovery (name ABOVE header)")

resman_real = to_csv_bytes(
    [
        # Top metadata.
        ["BillsIQ Property Group", "", "", "", ""],
        ["All Units Report", "", "", "", ""],
        ["Date Range: All", "", "", "", ""],
        ["", "", "", "", ""],
        # First property name appears HERE - above the unit header.
        ["1732-Hillwood Manor", "", "", "", ""],
        # Real header.
        ["Unit", "Unit Type", "Unit Status", "Sqft", "Rent"],
        # Units of the FIRST property.
        ["A101", "1BR", "Occupied", "650", "1200"],
        ["A102", "2BR", "Vacant", "900", "1500"],
        ["A203", "1BR", "Occupied", "650", "1200"],
        # Per-property total - should be filtered.
        ["Property Total", "", "", "", "3 Unit(s)"],
        # Second property starts.
        ["1850-Oakwood Plaza", "", "", "", ""],
        # Repeated header - should be filtered.
        ["Unit", "Unit Type", "Unit Status", "Sqft", "Rent"],
        ["1A", "2BR", "Occupied", "950", "1700"],
        ["1B", "2BR", "Occupied", "950", "1700"],
        ["Property Total", "", "", "", "2 Unit(s)"],
        # Grand total - should be filtered.
        ["Grand Total", "", "", "", "5 Unit(s)"],
    ]
)
res6 = parse_property_upload(resman_real, "all_units_real.csv", "text/csv")

check(
    "first property's units recovered (3 Hillwood units present)",
    sum(1 for r in res6.source_rows if r[0] == "1732-Hillwood Manor") == 3,
    f"got {sum(1 for r in res6.source_rows if r[0] == '1732-Hillwood Manor')} Hillwood rows",
)
check(
    "second property's units present (2 Oakwood units)",
    sum(1 for r in res6.source_rows if r[0] == "1850-Oakwood Plaza") == 2,
    f"got {sum(1 for r in res6.source_rows if r[0] == '1850-Oakwood Plaza')} Oakwood rows",
)
check(
    "5 total unit rows produced (no totals, no repeated headers)",
    len(res6.source_rows) == 5,
    f"got {len(res6.source_rows)} rows",
)
check(
    "no row carries 'Unit' as the unit value (header-repetition filter)",
    all(r[1] != "Unit" for r in res6.source_rows),
    f"first cells: {[r[1] for r in res6.source_rows]}",
)
check(
    "no row carries 'N Unit(s)' anywhere (summary filter)",
    all(
        not any(
            cell.endswith("Unit(s)") or cell.endswith("Units")
            for cell in r
        )
        for r in res6.source_rows
    ),
)
check(
    "no row attributed to 'Property Total' or 'Grand Total'",
    all(
        r[0] not in {"Property Total", "Grand Total", "Total"}
        for r in res6.source_rows
    ),
)
check(
    "parse_warning mentions initial-banner recovery",
    "Recovered '1732-Hillwood Manor'" in (res6.parse_warning or ""),
    f"got warning={res6.parse_warning!r}",
)
check(
    "parse_warning mentions skipped summary rows",
    "Skipped 3 summary" in (res6.parse_warning or ""),
    f"got warning={res6.parse_warning!r}",
)
check(
    "parse_warning mentions skipped repeated headers",
    "Skipped 1 repeated header" in (res6.parse_warning or ""),
    f"got warning={res6.parse_warning!r}",
)


# =============================================================================
# Scenario 7 - bare 'Total' / 'Property Total' rows must NOT be banners
# =============================================================================
print("\n[scenario 7] 'Total' alone is not a property banner")

bare_total = to_csv_bytes(
    [
        ["Unit", "Unit Type", "Status"],
        ["1732-Hillwood Manor", "", ""],
        ["A101", "1BR", "Occupied"],
        # Bare "Total" used to be misread as a NEW property banner.
        ["Total", "", ""],
        # Now this row should still be attributed to Hillwood.
        ["A102", "2BR", "Vacant"],
        # "Property Total" alone - same story.
        ["Property Total", "", ""],
        ["A203", "1BR", "Occupied"],
    ]
)
res7 = parse_property_upload(bare_total, "bare_total.csv", "text/csv")

check(
    "all 3 unit rows still attributed to Hillwood Manor",
    sum(1 for r in res7.source_rows if r[0] == "1732-Hillwood Manor") == 3,
    f"got {sum(1 for r in res7.source_rows if r[0] == '1732-Hillwood Manor')} Hillwood rows",
)
check(
    "no row attributed to 'Total' or 'Property Total' as a property",
    all(
        r[0] not in {"Total", "Property Total"} for r in res7.source_rows
    ),
)


# =============================================================================
# Scenario 8 - "Holding Unit" / "Mustang HU" pseudo-units pass through as
# real unit rows when they appear within multi-cell unit-data rows
# =============================================================================
print("\n[scenario 8] pseudo-units like 'Holding Unit' / 'Mustang HU'")

pseudo = to_csv_bytes(
    [
        ["Unit", "Unit Type", "Status"],
        ["Vista Apartments", "", ""],
        ["A101", "1BR", "Occupied"],
        # Special unit - keeps real Unit Type info; should NOT be filtered.
        ["HU01", "Holding Unit", "Available"],
        ["HU02", "Hold Unit", "Available"],
        ["MUSTANG-HU", "Holding Unit", "Available"],
        ["A102", "2BR", "Vacant"],
    ]
)
res8 = parse_property_upload(pseudo, "pseudo.csv", "text/csv")

check(
    "5 unit rows preserved (pseudo-units kept as real units)",
    len(res8.source_rows) == 5,
    f"got {len(res8.source_rows)} rows",
)
check(
    "HU01 row preserved with 'Holding Unit' as unit type",
    any(
        r[1] == "HU01" and r[2] == "Holding Unit" for r in res8.source_rows
    ),
)
check(
    "MUSTANG-HU row preserved",
    any(r[1] == "MUSTANG-HU" for r in res8.source_rows),
)


# =============================================================================
# Scenario 9 - summary row whose first cell is innocent but contains
# "267 Unit(s)" elsewhere - count pattern still catches it
# =============================================================================
print("\n[scenario 9] summary row identified via 'N Unit(s)' count cell")

count_summary = to_csv_bytes(
    [
        ["Unit", "Unit Type", "Status"],
        ["Vista Apartments", "", ""],
        ["A101", "1BR", "Occupied"],
        # First cell is blank, but the count fragment is unmistakable.
        ["", "", "267 Unit(s)"],
        ["A102", "2BR", "Vacant"],
    ]
)
res9 = parse_property_upload(count_summary, "counts.csv", "text/csv")

check(
    "2 unit rows preserved (count summary filtered)",
    len(res9.source_rows) == 2,
    f"got {len(res9.source_rows)} rows",
)
check(
    "no '267 Unit(s)' anywhere in the output",
    all("Unit(s)" not in cell for r in res9.source_rows for cell in r),
)


# =============================================================================
print(f"\n{passed} passed, {failed} failed.")
if failed > 0:
    sys.exit(1)
