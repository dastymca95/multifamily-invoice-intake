"""
Phase 3I — Service tests for the backend export profile validator.

These tests pin the validation contract:

  * Issue codes match the spec.
  * Severity rules match the spec (blocked / warning / info / clear).
  * Overall status maps correctly (conflict > blocked > needs_review > clear).
  * 0 and False are NEVER treated as missing.
  * Required + missing → blocked.
  * Optional + unmapped column → info.
  * Required + unmapped column → blocked.
  * Cell-status verdicts (blocked / conflict / warning) are never weakened.
  * Unknown cell status degrades to warning, doesn't crash.
  * Column matching by key, normalised label, alias.
  * Empty preview → blocked.

The tests are pure / synchronous — no fixtures, no DB, no client.
"""

from __future__ import annotations

from app.schemas.export_profile import (
    ExportPreviewCellInput,
    ExportPreviewColumnInput,
    ExportPreviewInput,
    ExportPreviewRowInput,
    ExportProfile,
    ExportProfileColumn,
    ExportProfileSettings,
)
from app.services.export_profile_validation import (
    find_preview_column_for_profile_column,
    normalize_column_label,
    normalize_profile_issue_severity,
    validate_export_preview_against_profile,
)


# ---------------------------------------------------------------------------
# Tiny builders so the tests stay readable.
# ---------------------------------------------------------------------------


def _profile(
    *,
    columns: list[ExportProfileColumn],
    target_system: str = "custom_csv",
    date_format: str = "MM/DD/YYYY",
) -> ExportProfile:
    return ExportProfile(
        id="prof-test",
        name="Test Profile",
        target_system=target_system,  # type: ignore[arg-type]
        description="unit-test profile",
        settings=ExportProfileSettings(date_format=date_format),
        columns=columns,
    )


def _col(
    key: str,
    label: str,
    *,
    required: bool = False,
    data_type: str = "text",
    aliases: list[str] | None = None,
    source_key: str | None = None,
    source_label: str | None = None,
    allowed: list[str] | None = None,
    max_length: int | None = None,
) -> ExportProfileColumn:
    return ExportProfileColumn(
        key=key,
        label=label,
        output_header=label,
        required=required,
        data_type=data_type,  # type: ignore[arg-type]
        match_aliases=aliases or [],
        source_column_key=source_key,
        source_column_label=source_label,
        allowed_values=allowed,
        max_length=max_length,
    )


def _preview(
    *,
    columns: list[ExportPreviewColumnInput],
    rows: list[ExportPreviewRowInput],
) -> ExportPreviewInput:
    return ExportPreviewInput(columns=columns, rows=rows)


def _pcol(key: str, label: str) -> ExportPreviewColumnInput:
    return ExportPreviewColumnInput(key=key, label=label)


def _row(
    row_index: int,
    cells: list[ExportPreviewCellInput],
    *,
    status: str = "clear",
) -> ExportPreviewRowInput:
    return ExportPreviewRowInput(row_index=row_index, status=status, cells=cells)


def _cell(
    column_key: str,
    *,
    value=None,
    display_value: str | None = None,
    status: str = "clear",
) -> ExportPreviewCellInput:
    return ExportPreviewCellInput(
        column_key=column_key,
        value=value,
        display_value=display_value,
        status=status,
    )


# ---------------------------------------------------------------------------
# Empty preview
# ---------------------------------------------------------------------------


def test_empty_preview_is_blocked():
    profile = _profile(columns=[_col("invoice_number", "Invoice Number")])
    preview = _preview(columns=[], rows=[])
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "blocked"
    assert any(i.code == "PROFILE_PREVIEW_HAS_NO_ROWS" for i in result.issues)
    assert result.diagnostic_only is True


def test_preview_with_columns_but_no_rows_is_blocked():
    profile = _profile(columns=[_col("invoice_number", "Invoice Number")])
    preview = _preview(
        columns=[_pcol("invoice_number", "Invoice Number")],
        rows=[],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "blocked"
    assert any(i.code == "PROFILE_PREVIEW_HAS_NO_ROWS" for i in result.issues)


# ---------------------------------------------------------------------------
# Required column / required value missing
# ---------------------------------------------------------------------------


def test_required_column_missing_is_blocked():
    profile = _profile(
        columns=[_col("amount", "Amount", required=True)],
    )
    preview = _preview(
        columns=[_pcol("invoice_number", "Invoice Number")],
        rows=[_row(0, [_cell("invoice_number", value="INV-1")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "blocked"
    codes = {i.code for i in result.issues}
    assert "PROFILE_REQUIRED_COLUMN_MISSING" in codes
    assert result.summary.unmatched_column_count == 1


def test_required_value_missing_is_blocked():
    profile = _profile(
        columns=[_col("amount", "Amount", required=True)],
    )
    preview = _preview(
        columns=[_pcol("amount", "Amount")],
        rows=[_row(0, [_cell("amount", value=None, display_value=None)])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "blocked"
    codes = {i.code for i in result.issues}
    assert "PROFILE_REQUIRED_VALUE_MISSING" in codes
    # Row rollup picks up the blocked severity.
    assert result.row_results[0].worst_severity == "blocked"
    assert result.summary.blocked_rows == 1


def test_required_value_missing_when_cell_absent():
    profile = _profile(columns=[_col("amount", "Amount", required=True)])
    preview = _preview(
        columns=[_pcol("amount", "Amount")],
        # No cell for "amount" on the row.
        rows=[_row(0, [])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "blocked"
    assert any(
        i.code == "PROFILE_REQUIRED_VALUE_MISSING" for i in result.issues
    )


def test_optional_value_missing_is_quiet():
    profile = _profile(columns=[_col("amount", "Amount", required=False)])
    preview = _preview(
        columns=[_pcol("amount", "Amount")],
        rows=[_row(0, [_cell("amount", value=None)])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "clear"
    assert result.summary.blocked_count == 0
    assert result.summary.warning_count == 0


# ---------------------------------------------------------------------------
# 0 and False are not missing
# ---------------------------------------------------------------------------


def test_zero_amount_is_not_missing():
    profile = _profile(
        columns=[_col("amount", "Amount", required=True, data_type="amount")],
    )
    preview = _preview(
        columns=[_pcol("amount", "Amount")],
        rows=[_row(0, [_cell("amount", value=0, display_value="0")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "clear"
    assert result.summary.blocked_count == 0
    assert all(i.code != "PROFILE_REQUIRED_VALUE_MISSING" for i in result.issues)


def test_false_boolean_is_not_missing():
    profile = _profile(
        columns=[_col("is_credit", "Is Credit", required=True, data_type="boolean")],
    )
    preview = _preview(
        columns=[_pcol("is_credit", "Is Credit")],
        rows=[_row(0, [_cell("is_credit", value=False, display_value="false")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "clear"
    assert result.summary.blocked_count == 0


# ---------------------------------------------------------------------------
# Cell verdicts (never weakened)
# ---------------------------------------------------------------------------


def test_blocked_cell_results_in_blocked():
    profile = _profile(
        columns=[_col("invoice_number", "Invoice Number", required=True)],
    )
    preview = _preview(
        columns=[_pcol("invoice_number", "Invoice Number")],
        rows=[
            _row(
                0,
                [_cell("invoice_number", value="INV-1", status="blocked")],
            )
        ],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "blocked"
    assert any(i.code == "PROFILE_CELL_BLOCKED" for i in result.issues)


def test_conflict_cell_results_in_conflict_overall_status():
    profile = _profile(
        columns=[_col("invoice_number", "Invoice Number", required=True)],
    )
    preview = _preview(
        columns=[_pcol("invoice_number", "Invoice Number")],
        rows=[
            _row(
                0,
                [_cell("invoice_number", value="INV-1", status="conflict")],
            )
        ],
    )
    result = validate_export_preview_against_profile(profile, preview)
    # Per spec: conflict beats blocked at the overall-status layer.
    assert result.status == "conflict"
    assert any(i.code == "PROFILE_CELL_CONFLICT" for i in result.issues)


def test_warning_cell_results_in_needs_review():
    profile = _profile(
        columns=[_col("amount", "Amount", required=False, data_type="amount")],
    )
    preview = _preview(
        columns=[_pcol("amount", "Amount")],
        rows=[
            _row(
                0,
                [_cell("amount", value="99.50", display_value="99.50", status="warning")],
            )
        ],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "needs_review"
    assert any(i.code == "PROFILE_CELL_NEEDS_REVIEW" for i in result.issues)


def test_unknown_cell_status_degrades_to_warning():
    profile = _profile(columns=[_col("invoice_number", "Invoice Number")])
    preview = _preview(
        columns=[_pcol("invoice_number", "Invoice Number")],
        rows=[
            _row(
                0,
                [_cell("invoice_number", value="INV-1", status="some_future_status")],
            )
        ],
    )
    # Should not raise — unknown status degrades to warning.
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "needs_review"
    assert any(i.code == "PROFILE_CELL_NEEDS_REVIEW" for i in result.issues)


# ---------------------------------------------------------------------------
# Optional unmapped column
# ---------------------------------------------------------------------------


def test_optional_unmapped_column_is_info():
    profile = _profile(
        columns=[
            _col("invoice_number", "Invoice Number"),
            _col("memo", "Memo", required=False),
        ],
    )
    preview = _preview(
        columns=[_pcol("invoice_number", "Invoice Number")],
        rows=[_row(0, [_cell("invoice_number", value="INV-1")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    # The "Memo" column is optional + unmapped → info, NOT blocking.
    assert result.status == "clear"
    info_codes = [i.code for i in result.issues if i.severity == "info"]
    assert "PROFILE_COLUMN_UNMAPPED" in info_codes


# ---------------------------------------------------------------------------
# Format checks
# ---------------------------------------------------------------------------


def test_amount_format_check_warns_on_non_numeric():
    profile = _profile(
        columns=[_col("amount", "Amount", required=False, data_type="amount")],
    )
    preview = _preview(
        columns=[_pcol("amount", "Amount")],
        rows=[_row(0, [_cell("amount", value="abc", display_value="abc")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "needs_review"
    assert any(
        i.code == "PROFILE_AMOUNT_FORMAT_CHECK_FAILED" for i in result.issues
    )


def test_amount_format_accepts_currency_and_negative_parens():
    profile = _profile(
        columns=[_col("amount", "Amount", required=False, data_type="amount")],
    )
    preview = _preview(
        columns=[_pcol("amount", "Amount")],
        rows=[
            _row(0, [_cell("amount", value="$1,234.56", display_value="$1,234.56")]),
            _row(1, [_cell("amount", value="(99.50)", display_value="(99.50)")]),
        ],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "clear"


def test_integer_format_rejects_fractional():
    profile = _profile(
        columns=[_col("count", "Count", required=False, data_type="integer")],
    )
    preview = _preview(
        columns=[_pcol("count", "Count")],
        rows=[_row(0, [_cell("count", value="3.5", display_value="3.5")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "needs_review"
    assert any(
        i.code == "PROFILE_AMOUNT_FORMAT_CHECK_FAILED" for i in result.issues
    )


def test_date_format_check_warns_on_obviously_invalid():
    profile = _profile(
        columns=[_col("invoice_date", "Invoice Date", required=False, data_type="date")],
        date_format="MM/DD/YYYY",
    )
    preview = _preview(
        columns=[_pcol("invoice_date", "Invoice Date")],
        rows=[
            _row(
                0,
                [_cell("invoice_date", value="not-a-date", display_value="not-a-date")],
            )
        ],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "needs_review"
    assert any(
        i.code == "PROFILE_DATE_FORMAT_CHECK_FAILED" for i in result.issues
    )


def test_date_format_accepts_iso_and_us():
    profile = _profile(
        columns=[_col("invoice_date", "Invoice Date", required=False, data_type="date")],
    )
    preview = _preview(
        columns=[_pcol("invoice_date", "Invoice Date")],
        rows=[
            _row(0, [_cell("invoice_date", value="2026-04-10", display_value="2026-04-10")]),
            _row(1, [_cell("invoice_date", value="04/10/2026", display_value="04/10/2026")]),
        ],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "clear"


# ---------------------------------------------------------------------------
# Allowed values + max length
# ---------------------------------------------------------------------------


def test_allowed_value_fail_required_is_blocked():
    profile = _profile(
        columns=[
            _col(
                "type",
                "Type",
                required=True,
                allowed=["bill", "credit"],
            )
        ],
    )
    preview = _preview(
        columns=[_pcol("type", "Type")],
        rows=[_row(0, [_cell("type", value="invoice", display_value="invoice")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "blocked"
    assert any(i.code == "PROFILE_ALLOWED_VALUE_FAILED" for i in result.issues)


def test_allowed_value_fail_optional_is_warning():
    profile = _profile(
        columns=[
            _col(
                "type",
                "Type",
                required=False,
                allowed=["bill", "credit"],
            )
        ],
    )
    preview = _preview(
        columns=[_pcol("type", "Type")],
        rows=[_row(0, [_cell("type", value="invoice", display_value="invoice")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "needs_review"
    assert any(i.code == "PROFILE_ALLOWED_VALUE_FAILED" for i in result.issues)


def test_allowed_value_case_insensitive_match():
    profile = _profile(
        columns=[
            _col("type", "Type", required=True, allowed=["bill", "credit"])
        ],
    )
    preview = _preview(
        columns=[_pcol("type", "Type")],
        rows=[_row(0, [_cell("type", value="BILL", display_value="BILL")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "clear"


def test_max_length_exceeded_warns():
    profile = _profile(
        columns=[_col("memo", "Memo", required=False, max_length=10)],
    )
    preview = _preview(
        columns=[_pcol("memo", "Memo")],
        rows=[
            _row(
                0,
                [_cell("memo", value="X" * 25, display_value="X" * 25)],
            )
        ],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.status == "needs_review"
    assert any(i.code == "PROFILE_MAX_LENGTH_EXCEEDED" for i in result.issues)


# ---------------------------------------------------------------------------
# Column matching
# ---------------------------------------------------------------------------


def test_match_by_source_column_key():
    profile = _profile(
        columns=[
            _col("invoice_number", "Invoice #", source_key="invoice_number_v2"),
        ],
    )
    preview = _preview(
        columns=[_pcol("invoice_number_v2", "Some Other Label")],
        rows=[_row(0, [_cell("invoice_number_v2", value="INV-1")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.column_results[0].matched is True
    assert result.column_results[0].matched_preview_column_key == "invoice_number_v2"


def test_match_by_normalized_label():
    profile = _profile(
        columns=[_col("invoice_number", "Invoice Number")],
    )
    preview = _preview(
        # Different spacing / casing — normalises to the same key.
        columns=[_pcol("preview_col_1", "  invoice_number  ")],
        rows=[_row(0, [_cell("preview_col_1", value="INV-1")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.column_results[0].matched is True
    assert result.column_results[0].matched_preview_column_key == "preview_col_1"


def test_match_by_alias():
    profile = _profile(
        columns=[
            _col(
                "invoice_number",
                "Invoice Number",
                aliases=["invoice #", "inv #", "invoice no"],
            )
        ],
    )
    preview = _preview(
        columns=[_pcol("col_xyz", "Inv #")],
        rows=[_row(0, [_cell("col_xyz", value="INV-1")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.column_results[0].matched is True
    assert result.column_results[0].matched_preview_column_key == "col_xyz"


def test_no_match_returns_none():
    pcol = ExportPreviewColumnInput(key="invoice_number", label="Invoice Number")
    profile_col = _col(
        "memo",
        "Memo",
        aliases=["description", "line_description"],
    )
    matched = find_preview_column_for_profile_column(profile_col, [pcol])
    assert matched is None


# ---------------------------------------------------------------------------
# Severity helpers
# ---------------------------------------------------------------------------


def test_normalize_column_label_collapses_separators():
    assert normalize_column_label("Invoice Number") == "invoice number"
    assert normalize_column_label("invoice_number") == "invoice number"
    assert normalize_column_label("invoice-number") == "invoice number"
    assert normalize_column_label("  Invoice   Number  ") == "invoice number"
    assert normalize_column_label(None) == ""


def test_normalize_severity_degrades_unknown_to_warning():
    assert normalize_profile_issue_severity("blocked") == "blocked"
    assert normalize_profile_issue_severity("warning") == "warning"
    assert normalize_profile_issue_severity("info") == "info"
    assert normalize_profile_issue_severity("clear") == "clear"
    assert normalize_profile_issue_severity("future_value") == "warning"
    assert normalize_profile_issue_severity(None) == "warning"


# ---------------------------------------------------------------------------
# Diagnostic-only flag is hard True
# ---------------------------------------------------------------------------


def test_result_is_always_diagnostic_only():
    profile = _profile(columns=[_col("invoice_number", "Invoice Number")])
    preview = _preview(
        columns=[_pcol("invoice_number", "Invoice Number")],
        rows=[_row(0, [_cell("invoice_number", value="INV-1")])],
    )
    result = validate_export_preview_against_profile(profile, preview)
    assert result.diagnostic_only is True


# ---------------------------------------------------------------------------
# Per-column rollup correctness
# ---------------------------------------------------------------------------


def test_per_column_rollup_counts_match_issues():
    profile = _profile(
        columns=[
            _col("amount", "Amount", required=True, data_type="amount"),
        ],
    )
    preview = _preview(
        columns=[_pcol("amount", "Amount")],
        rows=[
            _row(0, [_cell("amount", value="abc", display_value="abc")]),
            _row(1, [_cell("amount", value=None, display_value=None)]),
        ],
    )
    result = validate_export_preview_against_profile(profile, preview)
    # Row 0: warning (non-numeric). Row 1: blocked (required missing).
    assert result.status == "blocked"
    amount_col = next(
        c for c in result.column_results if c.profile_column_key == "amount"
    )
    assert amount_col.issue_count >= 2
    assert amount_col.worst_severity == "blocked"


# ---------------------------------------------------------------------------
# Multiple profile columns with mixed verdicts → composite status
# ---------------------------------------------------------------------------


def test_mixed_warnings_and_info_collapse_to_needs_review():
    profile = _profile(
        columns=[
            _col("invoice_number", "Invoice Number"),
            _col("memo", "Memo", required=False),  # unmapped → info
            _col("amount", "Amount", required=False, data_type="amount"),
        ],
    )
    preview = _preview(
        columns=[
            _pcol("invoice_number", "Invoice Number"),
            _pcol("amount", "Amount"),
        ],
        rows=[
            _row(
                0,
                [
                    _cell("invoice_number", value="INV-1"),
                    _cell("amount", value="abc", display_value="abc"),
                ],
            ),
        ],
    )
    result = validate_export_preview_against_profile(profile, preview)
    # info (memo unmapped) + warning (amount non-numeric) → needs_review.
    assert result.status == "needs_review"
    assert result.summary.warning_count >= 1
    assert result.summary.info_count >= 1
