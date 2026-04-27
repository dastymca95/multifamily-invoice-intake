"""Tests for the Phase 1 ValueSource substrate.

These tests pin the contract each strategy declares (kind label,
runtime-input flag, possible issue codes, required inputs,
``evaluate_baseline`` outcomes). They DO NOT exercise the production
resolver — the substrate is parallel documentation today, not a
dispatch path. Parity with the resolver is verified by the existing
``test_import_template_resolver.py`` suite, which still owns the
runtime contract.

If the resolver semantics ever change (new source type, new branch
inside an existing source type), the matching strategy here MUST be
updated in lockstep, and these tests will catch the drift.
"""

from __future__ import annotations

from app.domain.value_source import (
    BaselineEvaluation,
    DerivedSource,
    EmptySource,
    FixedValueSource,
    GLFieldSource,
    InvoiceFieldSource,
    ManualListSource,
    PropertyFieldSource,
    RequiredInputDescriptor,
    VendorFieldSource,
    all_possible_issue_codes,
    all_value_source_kinds,
    all_value_sources,
    get_value_source,
)
from app.schemas.invoice_template import (
    ColumnSourceRef,
    InvoiceTemplateColumn,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _column(
    *,
    source_type: str = "empty",
    default_value: str | None = None,
    manual_values: list[str] | None = None,
    source_ref: dict | None = None,
    required: bool = False,
    data_type: str = "text",
    bypass_validation: bool = False,
) -> InvoiceTemplateColumn:
    """Build a minimal column for substrate testing.

    Substrate strategies don't need rules / catalogs / db — they're
    pure functions over a single column. This helper keeps the test
    bodies focused on the column shape that matters for each case.

    The schema's ``_check_source_consistency`` model validator
    enforces cross-field invariants (e.g. ``manual_list`` REQUIRES
    non-empty ``manual_values``). For substrate tests that
    intentionally exercise resolver branches the schema rejects at
    construction time — empty / blanks-only manual_list, etc. — pass
    ``bypass_validation=True`` to use ``model_construct`` and skip
    the validators. The substrate strategies themselves are pure
    functions over the field shape and do not depend on schema
    invariants.
    """

    payload: dict = {
        "id": "col-1",
        "name": "Test Column",
        "required": required,
        "data_type": data_type,
        "source_type": source_type,
    }
    if default_value is not None:
        payload["default_value"] = default_value
    if manual_values is not None:
        payload["manual_values"] = manual_values
    if source_ref is not None:
        payload["source_ref"] = source_ref
    if bypass_validation:
        return InvoiceTemplateColumn.model_construct(**payload)
    return InvoiceTemplateColumn.model_validate(payload)


def _construct_default_column_for_kind(kind: str) -> InvoiceTemplateColumn:
    """Build the smallest schema-valid column for a given source kind.

    Used by smoke tests that iterate over the registry — each kind
    needs a slightly different shape to satisfy the schema's
    cross-field validators (e.g. ``manual_list`` requires non-empty
    ``manual_values``; catalog kinds auto-create ``source_ref``).
    """
    if kind == "manual_list":
        return _column(source_type=kind, manual_values=["only"])
    if kind in {"vendor_field", "property_field", "gl_field"}:
        return _column(source_type=kind, source_ref={"field": "x"})
    if kind == "invoice_field":
        return _column(source_type=kind, source_ref={"field": "invoice_number"})
    return _column(source_type=kind)


# ---------------------------------------------------------------------------
# Registry-level invariants
# ---------------------------------------------------------------------------


def test_registry_contains_every_known_source_type():
    expected = {
        "empty",
        "fixed_value",
        "manual_list",
        "invoice_field",
        "vendor_field",
        "property_field",
        "gl_field",
        "derived",
    }
    assert set(all_value_source_kinds()) == expected


def test_get_value_source_falls_back_to_empty_for_unknown_kind():
    assert get_value_source("not_a_real_kind") is EmptySource
    assert get_value_source(None) is EmptySource


def test_each_strategy_declares_its_own_kind():
    for source_cls in all_value_sources():
        assert get_value_source(source_cls.kind) is source_cls


def test_all_possible_issue_codes_includes_known_canonical_codes():
    codes = all_possible_issue_codes()
    # Sanity-check a few well-known codes that exist in the resolver.
    assert "FIXED_VALUE_EMPTY" in codes
    assert "MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION" in codes
    assert "MANUAL_VALUE_REQUIRED" in codes
    assert "INVOICE_FIELD_FACT_NOT_FOUND" in codes
    assert "CATALOG_HINT_MISSING" in codes
    assert "DERIVED_RESOLVER_NOT_IMPLEMENTED" in codes


# ---------------------------------------------------------------------------
# EmptySource
# ---------------------------------------------------------------------------


def test_empty_source_no_default_is_missing():
    column = _column(source_type="empty")

    verdict = EmptySource.evaluate_baseline(column)

    assert verdict.outcome == "missing"
    assert "VALUE_NOT_RESOLVED" in verdict.issue_codes


def test_empty_source_with_legacy_default_resolves():
    """Resolver legacy fallback: source_type=empty + default_value
    set still emits a resolved cell with source_type=global_default.
    """
    column = _column(source_type="empty", default_value="Bill")

    verdict = EmptySource.evaluate_baseline(column)

    assert verdict.outcome == "resolves"
    assert verdict.issue_codes == ()


def test_empty_source_does_not_need_runtime_input():
    assert EmptySource.needs_runtime_input is False
    assert EmptySource.required_inputs(_column()) == ()


# ---------------------------------------------------------------------------
# FixedValueSource
# ---------------------------------------------------------------------------


def test_fixed_value_source_with_default_resolves():
    column = _column(source_type="fixed_value", default_value="General")

    verdict = FixedValueSource.evaluate_baseline(column)

    assert verdict.outcome == "resolves"
    assert verdict.issue_codes == ()
    assert "General" in verdict.detail


def test_fixed_value_source_without_default_is_incomplete():
    column = _column(source_type="fixed_value")

    verdict = FixedValueSource.evaluate_baseline(column)

    assert verdict.outcome == "incomplete"
    assert "FIXED_VALUE_EMPTY" in verdict.issue_codes


def test_fixed_value_source_treats_whitespace_default_as_empty():
    """Mirrors resolver _has_value() — pure whitespace is empty."""
    column = _column(source_type="fixed_value", default_value="   ")

    verdict = FixedValueSource.evaluate_baseline(column)

    assert verdict.outcome == "incomplete"
    assert "FIXED_VALUE_EMPTY" in verdict.issue_codes


def test_fixed_value_source_does_not_need_runtime_input():
    assert FixedValueSource.needs_runtime_input is False


# ---------------------------------------------------------------------------
# ManualListSource — Phase A semantics
# ---------------------------------------------------------------------------


def test_manual_list_source_single_value_resolves():
    column = _column(
        source_type="manual_list",
        manual_values=["USD"],
    )

    verdict = ManualListSource.evaluate_baseline(column)

    assert verdict.outcome == "resolves"
    assert verdict.issue_codes == ()


def test_manual_list_source_multi_value_no_default_needs_review():
    column = _column(
        source_type="manual_list",
        manual_values=["Bill", "Credit"],
    )

    verdict = ManualListSource.evaluate_baseline(column)

    assert verdict.outcome == "needs_review"
    assert "MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION" in verdict.issue_codes


def test_manual_list_source_with_matching_default_resolves():
    """Phase A behaviour: explicit default that matches one of the
    allowed values resolves immediately."""
    column = _column(
        source_type="manual_list",
        manual_values=["Bill", "Credit"],
        default_value="Bill",
    )

    verdict = ManualListSource.evaluate_baseline(column)

    assert verdict.outcome == "resolves"
    assert verdict.issue_codes == ()
    assert "Bill" in verdict.detail


def test_manual_list_source_with_whitespace_default_resolves():
    """Whitespace around default_value is trimmed before comparison."""
    column = _column(
        source_type="manual_list",
        manual_values=["Bill", "Credit"],
        default_value="  Bill  ",
    )

    verdict = ManualListSource.evaluate_baseline(column)

    assert verdict.outcome == "resolves"


def test_manual_list_source_with_default_not_in_list_falls_through_to_review():
    """Phase A: default_value set but NOT in manual_values falls
    through to the manual_review branch (the validator separately
    emits MANUAL_LIST_DEFAULT_NOT_IN_LIST).
    """
    column = _column(
        source_type="manual_list",
        manual_values=["Bill", "Credit"],
        default_value="Refund",
    )

    verdict = ManualListSource.evaluate_baseline(column)

    assert verdict.outcome == "needs_review"
    assert "MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION" in verdict.issue_codes


def test_manual_list_source_empty_values_is_missing():
    # The schema's _check_source_consistency rejects manual_list
    # with no values at construction time. We bypass validation here
    # to exercise the substrate's own defensive branch — the resolver
    # likewise handles this corner during dry-run when persisted
    # templates pre-date the validator (legacy data) or after a
    # column-shape mutation that elided the values list.
    column = _column(
        source_type="manual_list",
        manual_values=["", "  "],
        bypass_validation=True,
    )

    verdict = ManualListSource.evaluate_baseline(column)

    assert verdict.outcome == "missing"
    assert "MANUAL_VALUE_REQUIRED" in verdict.issue_codes


# ---------------------------------------------------------------------------
# InvoiceFieldSource
# ---------------------------------------------------------------------------


def test_invoice_field_source_without_field_is_incomplete():
    column = _column(
        source_type="invoice_field",
        source_ref={"field": None},
    )

    verdict = InvoiceFieldSource.evaluate_baseline(column)

    assert verdict.outcome == "incomplete"


def test_invoice_field_source_with_field_needs_runtime():
    column = _column(
        source_type="invoice_field",
        source_ref={"field": "invoice_number"},
    )

    verdict = InvoiceFieldSource.evaluate_baseline(column)

    assert verdict.outcome == "needs_runtime"
    assert "invoice_number" in verdict.detail


def test_invoice_field_source_required_inputs_describe_extracted_fact():
    column = _column(
        source_type="invoice_field",
        source_ref={"field": "invoice_number"},
    )

    inputs = InvoiceFieldSource.required_inputs(column)

    assert len(inputs) == 1
    assert inputs[0].kind == "extracted_fact"
    assert inputs[0].field_key == "invoice_number"


def test_invoice_field_source_required_inputs_normalize_alias():
    """Aliases (e.g. "vendor" → "vendor_name") are normalized through
    the canonical extracted-fields registry."""
    column = _column(
        source_type="invoice_field",
        source_ref={"field": "vendor"},
    )

    inputs = InvoiceFieldSource.required_inputs(column)

    assert len(inputs) == 1
    assert inputs[0].field_key == "vendor_name"


def test_invoice_field_source_with_no_field_has_no_required_inputs():
    column = _column(
        source_type="invoice_field",
        source_ref={"field": None},
    )

    inputs = InvoiceFieldSource.required_inputs(column)

    assert inputs == ()


def test_invoice_field_source_needs_runtime_input_flag():
    assert InvoiceFieldSource.needs_runtime_input is True


# ---------------------------------------------------------------------------
# Catalog sources (vendor / property / gl)
# ---------------------------------------------------------------------------


def test_vendor_source_without_catalog_is_incomplete():
    column = _column(
        source_type="vendor_field",
        source_ref={"field": "vendor_name"},
    )

    verdict = VendorFieldSource.evaluate_baseline(column)

    assert verdict.outcome == "incomplete"
    assert "CATALOG_NOT_CONFIGURED" in verdict.issue_codes


def test_vendor_source_with_catalog_no_field_is_incomplete():
    column = _column(
        source_type="vendor_field",
        source_ref={"catalog_id": "cat-1", "field": None},
    )

    verdict = VendorFieldSource.evaluate_baseline(column)

    assert verdict.outcome == "incomplete"
    assert "SOURCE_CATALOG_FIELD_MISSING" in verdict.issue_codes


def test_vendor_source_fully_configured_needs_runtime():
    column = _column(
        source_type="vendor_field",
        source_ref={"catalog_id": "cat-1", "field": "vendor_name"},
    )

    verdict = VendorFieldSource.evaluate_baseline(column)

    assert verdict.outcome == "needs_runtime"


def test_vendor_source_required_inputs_describe_catalog_hint():
    column = _column(
        source_type="vendor_field",
        source_ref={"catalog_id": "cat-1", "field": "vendor_name"},
    )

    inputs = VendorFieldSource.required_inputs(column)

    assert len(inputs) == 1
    assert inputs[0].kind == "catalog_hint"
    assert inputs[0].catalog_kind == "vendor"


def test_property_source_required_inputs_describe_catalog_hint():
    column = _column(
        source_type="property_field",
        source_ref={"catalog_id": "cat-2", "field": "property_name"},
    )

    inputs = PropertyFieldSource.required_inputs(column)

    assert len(inputs) == 1
    assert inputs[0].catalog_kind == "property"


def test_gl_source_required_inputs_describe_catalog_hint():
    column = _column(
        source_type="gl_field",
        source_ref={"catalog_id": "cat-3", "field": "code"},
    )

    inputs = GLFieldSource.required_inputs(column)

    assert len(inputs) == 1
    assert inputs[0].catalog_kind == "gl"


def test_all_catalog_sources_share_possible_issue_code_set():
    """All three catalog sources delegate to the same matcher in the
    resolver and therefore declare the same possible issue codes."""
    assert (
        VendorFieldSource.possible_issue_codes
        == PropertyFieldSource.possible_issue_codes
        == GLFieldSource.possible_issue_codes
    )


def test_catalog_sources_need_runtime_input():
    for source_cls in (VendorFieldSource, PropertyFieldSource, GLFieldSource):
        assert source_cls.needs_runtime_input is True


# ---------------------------------------------------------------------------
# DerivedSource
# ---------------------------------------------------------------------------


def test_derived_source_is_not_implemented():
    column = _column(source_type="derived")

    verdict = DerivedSource.evaluate_baseline(column)

    assert verdict.outcome == "not_implemented"
    assert "DERIVED_RESOLVER_NOT_IMPLEMENTED" in verdict.issue_codes


def test_derived_source_does_not_need_runtime_input():
    assert DerivedSource.needs_runtime_input is False
    assert DerivedSource.required_inputs(_column()) == ()


# ---------------------------------------------------------------------------
# Strategy / dataclass shape sanity
# ---------------------------------------------------------------------------


def test_required_input_descriptor_is_immutable():
    descriptor = RequiredInputDescriptor(
        kind="extracted_fact",
        field_key="invoice_number",
    )
    # Frozen dataclass → mutation raises.
    try:
        descriptor.kind = "catalog_hint"  # type: ignore[misc]
    except Exception:  # noqa: BLE001
        return
    raise AssertionError("RequiredInputDescriptor must be frozen.")


def test_baseline_evaluation_is_immutable():
    verdict = BaselineEvaluation(outcome="resolves")
    try:
        verdict.outcome = "missing"  # type: ignore[misc]
    except Exception:  # noqa: BLE001
        return
    raise AssertionError("BaselineEvaluation must be frozen.")


def test_every_source_class_declares_a_label_and_explanation():
    for source_cls in all_value_sources():
        assert isinstance(source_cls.label, str) and source_cls.label
        assert (
            isinstance(source_cls.explanation, str)
            and source_cls.explanation
        )


def test_every_source_class_evaluate_baseline_returns_evaluation():
    """Smoke test — calling evaluate_baseline on a default column for
    every kind returns a BaselineEvaluation. Catches a future
    contributor adding a strategy that forgets the method."""
    for source_cls in all_value_sources():
        column = _construct_default_column_for_kind(source_cls.kind)
        verdict = source_cls.evaluate_baseline(column)
        assert isinstance(verdict, BaselineEvaluation)
