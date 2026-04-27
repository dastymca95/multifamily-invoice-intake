"""Parity tests: resolver runtime output vs. ValueSource substrate.

Phase 1B — visibility and contract safety only. These tests run the
production resolver (``dry_run_resolve_import_template``) against
representative column shapes for every supported ``source_type`` and
assert the resolver's actual output stays consistent with what the
matching :class:`app.domain.value_source.ValueSource` strategy
declares.

What "parity" means in this phase:

* The substrate's :class:`BaselineEvaluation` outcome must be
  consistent with the resolver's cell ``status`` and ``value``.
  We don't require exact wording — just that "resolves" outcomes
  produce non-None values with status in {resolved, fallback}, that
  "missing"/"needs_review"/"incomplete"/"not_implemented" produce
  None values, etc.
* The resolver's emitted ``issue_codes`` for a baseline must be
  either declared in the matching strategy's
  ``possible_issue_codes`` set, OR fall in
  :data:`ALLOWED_RESOLVER_LEVEL_CODES` (rule-level / row-level /
  required-missing / coercion codes that are orthogonal to per-kind
  baseline resolution).
* For required columns with no resolvable path, the row status must
  be "blocked" and the cell must carry
  ``REQUIRED_RUNTIME_VALUE_MISSING``.

If a future contributor changes resolver behavior in a way that
breaks parity (new issue code in a baseline branch, branch returns
a different status/value combination), these tests fail. The
expected response is to update the substrate (a documentation
correction, not a behavior change), then re-run the tests.

Phase 1B will NOT silently rewrite resolver behavior to match the
substrate. If a substantive disagreement is found, the test should
xfail or be marked TODO and the discrepancy reported for Phase 1C
review.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest

from app.domain.value_source import (
    BaselineEvaluation,
    DerivedSource,
    EmptySource,
    FixedValueSource,
    GLFieldSource,
    InvoiceFieldSource,
    ManualListSource,
    PropertyFieldSource,
    VendorFieldSource,
    all_value_sources,
    get_value_source,
)
from app.models.invoice_template import InvoiceTemplate
from app.schemas.import_resolver import (
    CatalogHint,
    ExtractedFact,
    ResolverInput,
)
from app.schemas.invoice_template import InvoiceTemplateColumn
from app.services import import_template_resolver as resolver
from app.services.import_template_resolver import (
    dry_run_resolve_import_template,
)


# ---------------------------------------------------------------------------
# Resolver-level (kind-orthogonal) issue codes the parity check tolerates
# ---------------------------------------------------------------------------
#
# Per the Phase 1B spec: not every emitted resolver issue belongs in a
# ValueSource.possible_issue_codes set. Codes that fire across multiple
# kinds (required-missing, type coercion, rule wiring, row-level
# diagnostics) live here so per-kind drift is still flagged but the
# orthogonal codes don't trigger false positives.
ALLOWED_RESOLVER_LEVEL_CODES: frozenset[str] = frozenset(
    {
        # Required-column gate (fired by _row_runtime_issues, not
        # any single source branch).
        "REQUIRED_RUNTIME_VALUE_MISSING",
        # Data-type coercion (post-baseline, applies to every kind
        # via _resolved_cell).
        "DATA_TYPE_COERCION_FAILED",
        "DATA_TYPE_UNKNOWN",
        # Rule-engine diagnostics (orthogonal to baseline; emitted
        # when rules fire on top of any source).
        "RULE_DISABLED_SKIPPED",
        "RULE_HAS_NO_CONDITIONS",
        "RULE_RESTRICTED_OUT",
        "RULE_ACTION_APPLIED",
        "RULE_ACTION_IGNORED_BY_GLOBAL_OVERRIDE",
        "RULE_FILL_VALUE_MISSING",
        "BASELINE_VALUE_OVERRIDDEN_BY_RULE",
        "CONFLICTING_RULE_ACTION",
        "CONDITION_NOT_MATCHED",
        "RESTRICTION_NOT_MATCHED",
        "CONDITION_NO_ACTUAL_VALUE",
        "RESTRICTION_NO_ACTUAL_VALUE",
        "CONDITION_CELL_EMPTY",
        "RESTRICTION_CELL_EMPTY",
        "NO_RULES_MATCHED",
    }
)


# ---------------------------------------------------------------------------
# Construction helpers (mirror the existing resolver test shape)
# ---------------------------------------------------------------------------
#
# We intentionally duplicate the small builder helpers here rather
# than importing from the sibling resolver test file: the existing
# resolver tests are paired with that file's helpers, and the
# Phase 1B spec asks us to avoid touching existing tests when
# possible. Keeping helpers local keeps the parity suite
# self-contained.


def _template(
    columns: list[dict],
    rules: list[dict] | None = None,
) -> InvoiceTemplate:
    return InvoiceTemplate(
        id=uuid.uuid4(),
        name="Resolver parity test",
        description=None,
        columns=columns,
        rules=rules or [],
        source="custom",
    )


def _column(
    column_id: str,
    name: str,
    *,
    required: bool = False,
    data_type: str = "text",
    source_type: str = "empty",
    default_value: str | None = None,
    source_ref: dict | None = None,
    manual_values: list[str] | None = None,
    format_: dict | None = None,
) -> dict:
    payload: dict[str, Any] = {
        "id": column_id,
        "name": name,
        "required": required,
        "data_type": data_type,
        "source_type": source_type,
        "allow_rule_override": True,
        "default_rule_role": None,
    }
    if default_value is not None:
        payload["default_value"] = default_value
    if source_ref is not None:
        payload["source_ref"] = source_ref
    if manual_values is not None:
        payload["manual_values"] = manual_values
    if format_ is not None:
        payload["format"] = format_
    return payload


def _to_column_obj(column_dict: dict) -> InvoiceTemplateColumn:
    """Convert a dict-shaped column to the validated Pydantic object
    so the substrate can evaluate it."""
    return InvoiceTemplateColumn.model_validate(column_dict)


def _cells_by_id(result) -> dict:
    return {cell.column_id: cell for cell in result.rows[0].cells}


# ---------------------------------------------------------------------------
# Parity assertions
# ---------------------------------------------------------------------------


def assert_codes_within_contract(cell, source_cls) -> None:
    """Every issue code on the cell must be either declared in the
    strategy's ``possible_issue_codes`` set OR allowed at the
    resolver level.

    Detects per-kind drift while tolerating orthogonal codes
    (REQUIRED_RUNTIME_VALUE_MISSING, coercion, rule diagnostics) that
    the substrate intentionally doesn't model.
    """

    actual = set(cell.issue_codes)
    declared = set(source_cls.possible_issue_codes)
    allowed = declared | ALLOWED_RESOLVER_LEVEL_CODES
    unexpected = actual - allowed
    assert not unexpected, (
        f"Cell emitted issue codes outside the contract for "
        f"{source_cls.__name__}: {sorted(unexpected)}.\n"
        f"  Declared by strategy: {sorted(declared)}\n"
        f"  Allowed resolver-level: {sorted(ALLOWED_RESOLVER_LEVEL_CODES)}\n"
        f"Add the code to the strategy's possible_issue_codes set "
        f"(documentation fix only — no resolver change required), or "
        f"to ALLOWED_RESOLVER_LEVEL_CODES if it is genuinely "
        f"orthogonal."
    )


def assert_outcome_consistent(verdict: BaselineEvaluation, cell) -> None:
    """Substrate verdict outcome must align with the cell's status +
    value for the cases where parity is unambiguous.

    Cases where runtime input determines the outcome are deliberately
    LOOSE — those are tested per-kind with explicit setup.
    """

    if verdict.outcome == "resolves":
        assert (
            cell.value is not None or cell.normalized_value is not None
        ), (
            f"Substrate predicted 'resolves' but resolver returned "
            f"value={cell.value!r}; status={cell.status!r}; "
            f"issue_codes={cell.issue_codes}"
        )
        assert cell.status in {"resolved", "fallback"}, (
            f"Substrate predicted 'resolves' but resolver status is "
            f"{cell.status!r} (expected 'resolved' or 'fallback')."
        )
    elif verdict.outcome == "missing":
        assert cell.value is None, (
            f"Substrate predicted 'missing' but resolver returned "
            f"value={cell.value!r}"
        )
        assert cell.status == "missing", (
            f"Substrate predicted 'missing' but resolver status is "
            f"{cell.status!r}"
        )
    elif verdict.outcome == "needs_review":
        assert cell.value is None
        assert cell.status == "manual_review"
    elif verdict.outcome == "incomplete":
        assert cell.value is None
        # The resolver may emit either "missing" or a catalog-issue
        # cell which also has status "missing" — both align with
        # "incomplete".
        assert cell.status == "missing"
    elif verdict.outcome == "not_implemented":
        assert cell.value is None
        # Derived returns status "ignored" specifically.
        assert cell.status == "ignored"
    elif verdict.outcome == "needs_runtime":
        # Caller decides whether to provide runtime input. The
        # resolver's status depends on whether input was supplied;
        # parity is asserted per-test in those cases.
        return


def assert_required_missing(result, column_id: str) -> None:
    """Required-column gate must fire for the column AND block the
    row."""
    cell = _cells_by_id(result)[column_id]
    assert "REQUIRED_RUNTIME_VALUE_MISSING" in cell.issue_codes, (
        f"Expected REQUIRED_RUNTIME_VALUE_MISSING on {column_id}; "
        f"got {cell.issue_codes}"
    )
    assert result.rows[0].status == "blocked", (
        f"Row should be blocked for required missing column "
        f"{column_id}; row status is {result.rows[0].status}"
    )


def assert_resolved_value(result, column_id: str, expected_value) -> None:
    """Cell resolved to expected value AND no required-missing fired."""
    cell = _cells_by_id(result)[column_id]
    assert cell.value == expected_value, (
        f"{column_id}: expected value {expected_value!r}, got "
        f"{cell.value!r}"
    )
    assert "REQUIRED_RUNTIME_VALUE_MISSING" not in cell.issue_codes


# ---------------------------------------------------------------------------
# A. empty / none
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_empty_optional_column_unresolved_but_not_blocked():
    column = _column("vendor", "Vendor", source_type="empty")
    template = _template([column])

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["vendor"]
    verdict = EmptySource.evaluate_baseline(_to_column_obj(column))

    # Substrate verdict
    assert verdict.outcome == "missing"

    # Resolver parity
    assert cell.value is None
    assert cell.status == "missing"
    assert "REQUIRED_RUNTIME_VALUE_MISSING" not in cell.issue_codes
    assert result.rows[0].status != "blocked"
    assert_outcome_consistent(verdict, cell)
    assert_codes_within_contract(cell, EmptySource)


@pytest.mark.asyncio
async def test_empty_required_column_blocks_with_required_missing():
    column = _column(
        "invoice_number", "Invoice Number", required=True, source_type="empty"
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["invoice_number"]
    verdict = EmptySource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "missing"
    assert_required_missing(result, "invoice_number")
    assert_outcome_consistent(verdict, cell)
    assert_codes_within_contract(cell, EmptySource)


@pytest.mark.asyncio
async def test_empty_with_legacy_default_resolves():
    """Resolver legacy fallback: source_type=empty + default_value
    set still emits a resolved cell with source_type='global_default'.
    The substrate mirrors this in EmptySource.evaluate_baseline.
    """
    column = _column(
        "currency", "Currency", source_type="empty", default_value="USD"
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["currency"]
    verdict = EmptySource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "resolves"
    assert_resolved_value(result, "currency", "USD")
    assert_outcome_consistent(verdict, cell)
    assert_codes_within_contract(cell, EmptySource)


# ---------------------------------------------------------------------------
# B. fixed_value
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fixed_value_required_with_default_resolves():
    column = _column(
        "expense_type",
        "Expense Type",
        required=True,
        source_type="fixed_value",
        default_value="General",
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["expense_type"]
    verdict = FixedValueSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "resolves"
    assert_resolved_value(result, "expense_type", "General")
    assert cell.source_type == "fixed_value"
    assert_outcome_consistent(verdict, cell)
    assert_codes_within_contract(cell, FixedValueSource)


@pytest.mark.asyncio
async def test_fixed_value_required_with_empty_default_blocks():
    column = _column(
        "expense_type",
        "Expense Type",
        required=True,
        source_type="fixed_value",
        default_value="",
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["expense_type"]
    verdict = FixedValueSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "incomplete"
    assert "FIXED_VALUE_EMPTY" in cell.issue_codes
    assert_required_missing(result, "expense_type")
    assert_outcome_consistent(verdict, cell)
    assert_codes_within_contract(cell, FixedValueSource)


@pytest.mark.asyncio
async def test_fixed_value_optional_with_default_resolves():
    column = _column(
        "currency_code",
        "Currency Code",
        source_type="fixed_value",
        default_value="USD",
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["currency_code"]
    verdict = FixedValueSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "resolves"
    assert_resolved_value(result, "currency_code", "USD")
    assert_outcome_consistent(verdict, cell)
    assert_codes_within_contract(cell, FixedValueSource)


# ---------------------------------------------------------------------------
# C. manual_list — Phase A semantics
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manual_list_single_value_resolves():
    column = _column(
        "currency",
        "Currency",
        required=True,
        source_type="manual_list",
        manual_values=["USD"],
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["currency"]
    verdict = ManualListSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "resolves"
    assert_resolved_value(result, "currency", "USD")
    assert_outcome_consistent(verdict, cell)
    assert_codes_within_contract(cell, ManualListSource)


@pytest.mark.asyncio
async def test_manual_list_multi_with_matching_default_resolves():
    column = _column(
        "bill_or_credit",
        "Bill or Credit",
        required=True,
        data_type="dropdown",
        source_type="manual_list",
        manual_values=["Bill", "Credit"],
        default_value="Bill",
        format_={"list_options": ["Bill", "Credit"]},
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["bill_or_credit"]
    verdict = ManualListSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "resolves"
    assert_resolved_value(result, "bill_or_credit", "Bill")
    assert_outcome_consistent(verdict, cell)
    assert_codes_within_contract(cell, ManualListSource)


@pytest.mark.asyncio
async def test_manual_list_multi_no_default_required_blocks():
    column = _column(
        "bill_or_credit",
        "Bill or Credit",
        required=True,
        data_type="dropdown",
        source_type="manual_list",
        manual_values=["Bill", "Credit"],
        format_={"list_options": ["Bill", "Credit"]},
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["bill_or_credit"]
    verdict = ManualListSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "needs_review"
    assert "MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION" in cell.issue_codes
    assert_required_missing(result, "bill_or_credit")
    assert_outcome_consistent(verdict, cell)
    assert_codes_within_contract(cell, ManualListSource)


@pytest.mark.asyncio
async def test_manual_list_default_not_in_list_falls_through_to_review():
    """Phase A behaviour: default_value set but not in manual_values
    falls through to manual_review (the validator separately emits
    MANUAL_LIST_DEFAULT_NOT_IN_LIST). Substrate predicts the same.
    """
    column = _column(
        "bill_or_credit",
        "Bill or Credit",
        required=True,
        data_type="dropdown",
        source_type="manual_list",
        manual_values=["Bill", "Credit"],
        default_value="Refund",
        format_={"list_options": ["Bill", "Credit"]},
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["bill_or_credit"]
    verdict = ManualListSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "needs_review"
    assert "MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION" in cell.issue_codes
    assert_required_missing(result, "bill_or_credit")
    assert_outcome_consistent(verdict, cell)
    assert_codes_within_contract(cell, ManualListSource)


# ---------------------------------------------------------------------------
# D. invoice_field
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invoice_field_with_extracted_fact_resolves():
    column = _column(
        "invoice_number",
        "Invoice Number",
        required=True,
        source_type="invoice_field",
        source_ref={"field": "invoice_number"},
    )
    template = _template([column])

    payload = ResolverInput(
        extracted_facts=[
            ExtractedFact(
                field_key="invoice_number",
                value="INV-12345",
                source_type="invoice_pattern",
            )
        ]
    )
    result = await dry_run_resolve_import_template(template, payload)
    cell = _cells_by_id(result)["invoice_number"]
    verdict = InvoiceFieldSource.evaluate_baseline(_to_column_obj(column))

    # Substrate says "needs_runtime"; we provided runtime input → resolves.
    assert verdict.outcome == "needs_runtime"
    assert verdict.detail
    assert_resolved_value(result, "invoice_number", "INV-12345")
    assert_codes_within_contract(cell, InvoiceFieldSource)


@pytest.mark.asyncio
async def test_invoice_field_alias_normalization_resolves():
    """The shared extracted-fields registry normalizes "vendor" →
    "vendor_name". A column bound to "vendor_name" must resolve from
    a fact whose field_key is "vendor".
    """
    column = _column(
        "vendor_col",
        "Vendor",
        required=True,
        source_type="invoice_field",
        source_ref={"field": "vendor_name"},
    )
    template = _template([column])

    payload = ResolverInput(
        extracted_facts=[
            ExtractedFact(
                field_key="vendor",  # alias
                value="EPB Fiber Optics",
                source_type="invoice_pattern",
            )
        ]
    )
    result = await dry_run_resolve_import_template(template, payload)
    cell = _cells_by_id(result)["vendor_col"]
    verdict = InvoiceFieldSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "needs_runtime"
    assert_resolved_value(result, "vendor_col", "EPB Fiber Optics")
    assert_codes_within_contract(cell, InvoiceFieldSource)


@pytest.mark.asyncio
async def test_invoice_field_required_no_fact_blocks():
    column = _column(
        "invoice_number",
        "Invoice Number",
        required=True,
        source_type="invoice_field",
        source_ref={"field": "invoice_number"},
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template, ResolverInput())
    cell = _cells_by_id(result)["invoice_number"]
    verdict = InvoiceFieldSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "needs_runtime"
    assert "INVOICE_FIELD_FACT_NOT_FOUND" in cell.issue_codes
    assert_required_missing(result, "invoice_number")
    assert_codes_within_contract(cell, InvoiceFieldSource)


@pytest.mark.asyncio
async def test_invoice_field_optional_no_fact_does_not_block():
    column = _column(
        "po_number",
        "PO Number",
        source_type="invoice_field",
        source_ref={"field": "po_number"},
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template, ResolverInput())
    cell = _cells_by_id(result)["po_number"]
    verdict = InvoiceFieldSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "needs_runtime"
    assert cell.value is None
    assert "INVOICE_FIELD_FACT_NOT_FOUND" in cell.issue_codes
    assert "REQUIRED_RUNTIME_VALUE_MISSING" not in cell.issue_codes
    assert result.rows[0].status != "blocked"
    assert_codes_within_contract(cell, InvoiceFieldSource)


@pytest.mark.asyncio
async def test_invoice_field_incomplete_no_field_bound():
    """source_type=invoice_field but source_ref.field is null —
    substrate says "incomplete"; resolver normalizes the empty key
    to None, finds no matching fact, and emits
    INVOICE_FIELD_FACT_NOT_FOUND. Both outcomes are consistent
    (column is structurally unfinished + runtime can't resolve)."""
    column = _column(
        "vendor_col",
        "Vendor",
        required=True,
        source_type="invoice_field",
        source_ref={"field": None},
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template, ResolverInput())
    cell = _cells_by_id(result)["vendor_col"]
    verdict = InvoiceFieldSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "incomplete"
    # Resolver still hits the missing-fact branch — code falls in the
    # InvoiceFieldSource.possible_issue_codes set.
    assert "INVOICE_FIELD_FACT_NOT_FOUND" in cell.issue_codes
    assert_required_missing(result, "vendor_col")
    assert_codes_within_contract(cell, InvoiceFieldSource)


# ---------------------------------------------------------------------------
# E. catalog kinds (vendor / property / gl)
# ---------------------------------------------------------------------------
#
# Catalog parity tests intentionally cover the configuration-shape
# branches the substrate DOES model:
#   * source_ref.catalog_id missing → CATALOG_NOT_CONFIGURED
#   * source_ref.field missing      → SOURCE_CATALOG_FIELD_MISSING
#   * field not in canonical set    → CATALOG_FIELD_NOT_FOUND
#   * db=None at resolve time       → CATALOG_MATCHER_NOT_IMPLEMENTED
#                                     (Phase 1B parity-test discovery)
#
# Successful catalog matching requires DB fixtures + monkeypatching
# the catalog loader. The existing resolver tests cover that path
# (`test_catalog_hint_resolves_baseline_catalog_field`); we don't
# duplicate that brittle setup here. Document in the report as a
# limitation.


def _bypass_validate(monkeypatch):
    """Helper — stub the inline validator call so the resolver can
    run without a real DB session for column-shape tests."""

    async def fake_validate(*_args, **_kwargs):
        return SimpleNamespace(issues=[])

    monkeypatch.setattr(resolver, "validate_import_template", fake_validate)


@pytest.mark.asyncio
async def test_vendor_field_no_catalog_id_emits_not_configured(monkeypatch):
    _bypass_validate(monkeypatch)
    column = _column(
        "vendor_col",
        "Vendor",
        required=True,
        source_type="vendor_field",
        source_ref={"field": "vendor_name"},
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(
        template, ResolverInput(), db=object()
    )
    cell = _cells_by_id(result)["vendor_col"]
    verdict = VendorFieldSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "incomplete"
    assert "CATALOG_NOT_CONFIGURED" in cell.issue_codes
    assert_required_missing(result, "vendor_col")
    assert_codes_within_contract(cell, VendorFieldSource)


@pytest.mark.asyncio
async def test_property_field_no_catalog_id_emits_not_configured(monkeypatch):
    _bypass_validate(monkeypatch)
    column = _column(
        "property_col",
        "Property",
        required=True,
        source_type="property_field",
        source_ref={"field": "property_name"},
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(
        template, ResolverInput(), db=object()
    )
    cell = _cells_by_id(result)["property_col"]
    verdict = PropertyFieldSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "incomplete"
    assert "CATALOG_NOT_CONFIGURED" in cell.issue_codes
    assert_required_missing(result, "property_col")
    assert_codes_within_contract(cell, PropertyFieldSource)


@pytest.mark.asyncio
async def test_gl_field_no_catalog_field_emits_field_missing(monkeypatch):
    """catalog_id set but field is missing → resolver emits
    SOURCE_CATALOG_FIELD_MISSING. Substrate predicts "incomplete".
    """
    _bypass_validate(monkeypatch)
    column = _column(
        "gl_col",
        "GL Account",
        required=True,
        source_type="gl_field",
        source_ref={"catalog_id": "cat-1", "field": None},
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(
        template, ResolverInput(), db=object()
    )
    cell = _cells_by_id(result)["gl_col"]
    verdict = GLFieldSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "incomplete"
    assert "SOURCE_CATALOG_FIELD_MISSING" in cell.issue_codes
    assert_required_missing(result, "gl_col")
    assert_codes_within_contract(cell, GLFieldSource)


@pytest.mark.asyncio
async def test_catalog_db_none_emits_matcher_not_implemented(monkeypatch):
    """When db=None at resolve time, the resolver emits
    CATALOG_MATCHER_NOT_IMPLEMENTED. The substrate declares this
    code (added in Phase 1B after the parity tests caught the
    documentation drift)."""
    _bypass_validate(monkeypatch)
    column = _column(
        "vendor_col",
        "Vendor",
        required=True,
        source_type="vendor_field",
        source_ref={"catalog_id": "cat-1", "field": "vendor_name"},
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(
        template, ResolverInput(catalog_hints={"vendor": CatalogHint(text="EPB")}),
        db=None,
    )
    cell = _cells_by_id(result)["vendor_col"]
    verdict = VendorFieldSource.evaluate_baseline(_to_column_obj(column))

    # Substrate predicts "needs_runtime" — configuration is complete.
    # Resolver returns CATALOG_MATCHER_NOT_IMPLEMENTED because db=None.
    assert verdict.outcome == "needs_runtime"
    assert "CATALOG_MATCHER_NOT_IMPLEMENTED" in cell.issue_codes
    assert_codes_within_contract(cell, VendorFieldSource)


# ---------------------------------------------------------------------------
# F. derived
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_derived_optional_emits_not_implemented():
    column = _column("misc", "Misc Derived", source_type="derived")
    template = _template([column])

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["misc"]
    verdict = DerivedSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "not_implemented"
    assert "DERIVED_RESOLVER_NOT_IMPLEMENTED" in DerivedSource.possible_issue_codes
    assert "DERIVED_RESOLVER_NOT_IMPLEMENTED" in cell.issue_codes
    assert cell.status == "ignored"
    assert cell.value is None
    assert_outcome_consistent(verdict, cell)
    assert_codes_within_contract(cell, DerivedSource)


@pytest.mark.asyncio
async def test_derived_required_blocks_with_required_missing():
    """Required derived column → resolver returns ignored cell
    AND fires required-missing because cell.status='ignored' triggers
    the row gate. Substrate says 'not_implemented'; both outcomes
    are consistent with "the resolver cannot produce a value here."""
    column = _column(
        "computed", "Computed", required=True, source_type="derived"
    )
    template = _template([column])

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["computed"]
    verdict = DerivedSource.evaluate_baseline(_to_column_obj(column))

    assert verdict.outcome == "not_implemented"
    assert "DERIVED_RESOLVER_NOT_IMPLEMENTED" in cell.issue_codes
    assert_required_missing(result, "computed")
    assert_codes_within_contract(cell, DerivedSource)


# ---------------------------------------------------------------------------
# G. Cross-kind issue-code coverage smoke test
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_every_registered_kind_has_a_parity_test_case_above():
    """Sanity: every kind in the registry must be exercised by at
    least one parity test in this file. Catches the case where a
    new ValueSource is added but the parity suite is not extended."""

    # Names of test functions in this module that target each kind.
    # If a new kind is added, add a coverage entry here AND a real
    # parity test. The assertion below trips when a kind has no
    # representative test.
    coverage = {
        "empty": "test_empty_optional_column_unresolved_but_not_blocked",
        "fixed_value": "test_fixed_value_required_with_default_resolves",
        "manual_list": "test_manual_list_single_value_resolves",
        "invoice_field": "test_invoice_field_with_extracted_fact_resolves",
        "vendor_field": "test_vendor_field_no_catalog_id_emits_not_configured",
        "property_field": (
            "test_property_field_no_catalog_id_emits_not_configured"
        ),
        "gl_field": "test_gl_field_no_catalog_field_emits_field_missing",
        "derived": "test_derived_optional_emits_not_implemented",
    }
    registered = {cls.kind for cls in all_value_sources()}
    missing = registered - set(coverage)
    assert not missing, (
        f"New ValueSource kind(s) registered without parity test "
        f"coverage: {sorted(missing)}. Add a representative case to "
        f"this file."
    )

    # Bonus: validate every covered test name actually exists in
    # this module (catches typos in the coverage map above).
    import sys

    module = sys.modules[__name__]
    for kind, test_name in coverage.items():
        assert hasattr(module, test_name), (
            f"Coverage map references missing test {test_name!r} "
            f"for kind {kind!r}."
        )


def test_every_registered_kind_resolves_via_get_value_source():
    """Registry round-trip: get_value_source(kind) → strategy class."""
    for source_cls in all_value_sources():
        assert get_value_source(source_cls.kind) is source_cls
