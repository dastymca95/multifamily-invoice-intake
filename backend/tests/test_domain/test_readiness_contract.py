"""Tests for the Phase 1 readiness-contract substrate.

Pure type / helper tests — no service-layer dependencies, no
database, no resolver. Confirms the dataclasses are constructable,
the enums are stable, the helpers behave deterministically, and the
public API surface stays additive (new fields → existing tests still
pass).
"""

from __future__ import annotations

from app.domain.readiness_contract import (
    ColumnReadiness,
    IssueCodeDescriptor,
    ReadinessItem,
    ReadinessStatus,
    ResolverExpectation,
    TemplateReadiness,
    ValueSourceVerdict,
    status_for_category,
    summarize,
)


# ---------------------------------------------------------------------------
# Status + expectation enum stability
# ---------------------------------------------------------------------------


def test_readiness_status_values_are_stable():
    """The wizard already renders these three literals — adding new
    statuses requires a coordinated frontend change, so this test
    pins the canonical set."""
    expected = {"ready", "warning", "blocked"}
    # Construction smoke — every literal must build a usable item.
    for status in expected:
        item = ReadinessItem(
            status=status,  # type: ignore[arg-type]
            category="structure",
            label="test",
        )
        assert item.status == status


def test_resolver_expectation_values_are_stable():
    expected = {"should_resolve", "may_be_missing", "will_be_missing"}
    for expectation in expected:
        readiness = ColumnReadiness(
            column_id="col-1",
            column_label="Test",
            structure=(),
            value_source=ValueSourceVerdict(
                kind="empty",
                status="ready",
                label="No source",
            ),
            rule_runtime=(),
            expectation=expectation,  # type: ignore[arg-type]
        )
        assert readiness.expectation == expectation


def test_readiness_category_values_are_stable():
    """Three categories drive the wizard's Step-5 grouping."""
    expected = {"structure", "value_source", "rule_runtime"}
    for category in expected:
        item = ReadinessItem(
            status="ready",
            category=category,  # type: ignore[arg-type]
            label="test",
        )
        assert item.category == category


# ---------------------------------------------------------------------------
# Construction sanity
# ---------------------------------------------------------------------------


def test_readiness_item_construction_with_minimal_args():
    item = ReadinessItem(
        status="ready",
        category="structure",
        label="Column has a name",
    )
    assert item.detail == ""
    assert item.fix_step is None
    assert item.code is None


def test_readiness_item_construction_with_full_args():
    item = ReadinessItem(
        status="warning",
        category="value_source",
        label="No default selected",
        detail="Operator must pick at runtime.",
        fix_step=3,
        code="MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION",
    )
    assert item.fix_step == 3
    assert item.code == "MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION"


def test_readiness_item_is_frozen():
    item = ReadinessItem(
        status="ready", category="structure", label="x"
    )
    try:
        item.status = "warning"  # type: ignore[misc]
    except Exception:  # noqa: BLE001
        return
    raise AssertionError("ReadinessItem must be frozen.")


def test_value_source_verdict_construction():
    verdict = ValueSourceVerdict(
        kind="manual_list",
        status="ready",
        label='Default selected: "Bill"',
        detail="Resolver picks this when no rule overrides.",
        conditional=False,
    )
    assert verdict.kind == "manual_list"
    assert verdict.conditional is False


def test_value_source_verdict_default_conditional_is_false():
    verdict = ValueSourceVerdict(
        kind="fixed_value",
        status="ready",
        label='Always emits "USD"',
    )
    assert verdict.conditional is False


def test_issue_code_descriptor_construction():
    descriptor = IssueCodeDescriptor(
        code="REQUIRED_RUNTIME_VALUE_MISSING",
        severity="error",
        scope="runtime",
        emitted_by=("resolver",),
        explanation=(
            "Required column has no resolved value after baseline "
            "and rules."
        ),
        recommendation=(
            "Provide a fixed/default value, extracted fact, catalog "
            "match, or eligible rule FILL/action."
        ),
    )
    assert descriptor.code == "REQUIRED_RUNTIME_VALUE_MISSING"
    assert descriptor.emitted_by == ("resolver",)
    assert descriptor.severity == "error"


def test_issue_code_descriptor_can_declare_dual_emission():
    """A few codes are emitted by both validator + resolver; the
    descriptor must accept multiple emitters."""
    descriptor = IssueCodeDescriptor(
        code="CATALOG_ENTRY_NOT_FOUND",
        severity="error",
        scope="cell",
        emitted_by=("validator", "resolver"),
        explanation="Catalog selection no longer resolves.",
    )
    assert "validator" in descriptor.emitted_by
    assert "resolver" in descriptor.emitted_by


def test_issue_code_descriptor_is_frozen():
    descriptor = IssueCodeDescriptor(
        code="FIXED_VALUE_EMPTY",
        severity="warning",
        scope="readiness",
        emitted_by=("validator",),
        explanation="x",
    )
    try:
        descriptor.severity = "error"  # type: ignore[misc]
    except Exception:  # noqa: BLE001
        return
    raise AssertionError("IssueCodeDescriptor must be frozen.")


def test_column_readiness_construction():
    readiness = ColumnReadiness(
        column_id="col-bill-or-credit",
        column_label="Bill or Credit",
        structure=(
            ReadinessItem(
                status="ready",
                category="structure",
                label="Column has a name",
            ),
        ),
        value_source=ValueSourceVerdict(
            kind="manual_list",
            status="ready",
            label='Default selected: "Bill"',
        ),
        rule_runtime=(),
        expectation="should_resolve",
        expectation_detail="Default Bill resolves the column.",
    )
    assert readiness.column_id == "col-bill-or-credit"
    assert readiness.expectation == "should_resolve"


def test_template_readiness_construction():
    template = TemplateReadiness(
        template_id="tpl-1",
        template_name="Main Template",
        columns=(),
        template_status="ready",
    )
    assert template.template_status == "ready"
    assert template.columns == ()


# ---------------------------------------------------------------------------
# summarize() — worst-case reduction
# ---------------------------------------------------------------------------


def test_summarize_empty_returns_ready():
    """Vacuous truth — no items means nothing's failing."""
    assert summarize([]) == "ready"


def test_summarize_all_ready_returns_ready():
    items = [
        ReadinessItem(status="ready", category="structure", label="a"),
        ReadinessItem(status="ready", category="structure", label="b"),
    ]
    assert summarize(items) == "ready"


def test_summarize_promotes_warning_over_ready():
    items = [
        ReadinessItem(status="ready", category="structure", label="a"),
        ReadinessItem(status="warning", category="value_source", label="b"),
    ]
    assert summarize(items) == "warning"


def test_summarize_blocked_wins_over_warning_and_ready():
    items = [
        ReadinessItem(status="ready", category="structure", label="a"),
        ReadinessItem(status="warning", category="value_source", label="b"),
        ReadinessItem(status="blocked", category="rule_runtime", label="c"),
    ]
    assert summarize(items) == "blocked"


def test_summarize_handles_iterator_input():
    """Generators / iterables (not just lists) must work."""
    def gen():
        yield ReadinessItem(
            status="warning", category="structure", label="a"
        )
        yield ReadinessItem(
            status="ready", category="structure", label="b"
        )

    assert summarize(gen()) == "warning"


# ---------------------------------------------------------------------------
# status_for_category() — per-section reduction with empty-category
# distinguishing
# ---------------------------------------------------------------------------


def test_status_for_category_returns_none_when_no_items_match():
    items = [
        ReadinessItem(status="warning", category="structure", label="a"),
    ]
    assert status_for_category(items, "value_source") is None


def test_status_for_category_returns_worst_within_category():
    items = [
        ReadinessItem(status="ready", category="structure", label="a"),
        ReadinessItem(status="warning", category="structure", label="b"),
        ReadinessItem(status="ready", category="value_source", label="c"),
    ]
    assert status_for_category(items, "structure") == "warning"
    assert status_for_category(items, "value_source") == "ready"


def test_status_for_category_blocked_wins_within_category():
    items = [
        ReadinessItem(status="warning", category="rule_runtime", label="a"),
        ReadinessItem(status="blocked", category="rule_runtime", label="b"),
    ]
    assert status_for_category(items, "rule_runtime") == "blocked"
