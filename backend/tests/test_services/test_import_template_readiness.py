"""Service tests for the Phase 1C readiness preview.

Pure service-level tests — they call
:func:`preview_import_template_readiness` directly with a
constructed :class:`ImportTemplateReadinessPreviewRequest`. No HTTP,
no DB, no resolver dry-run. The 15 cases below cover every
canonical scenario from the Phase 1C spec.
"""

from __future__ import annotations

from typing import Any

from app.schemas.import_readiness import (
    ImportTemplateReadinessPreviewRequest,
    ReadinessItemOut,
)
from app.services.import_template_readiness import (
    preview_import_template_readiness,
)


# ---------------------------------------------------------------------------
# Construction helpers
# ---------------------------------------------------------------------------


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
    default_rule_role: str | None = None,
    allow_rule_override: bool = True,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": column_id,
        "name": name,
        "required": required,
        "data_type": data_type,
        "source_type": source_type,
        "allow_rule_override": allow_rule_override,
        "default_rule_role": default_rule_role,
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


def _cell(
    role: str | None,
    values: list[str] | None = None,
    extraction_bindings: list[dict] | None = None,
) -> dict[str, Any]:
    return {
        "role": role,
        "values": values or [],
        "extraction_bindings": extraction_bindings or [],
    }


def _rule(rule_id: str, cells: dict[str, dict], *, active: bool = True) -> dict:
    return {"id": rule_id, "is_active": active, "cells": cells}


def _request(columns: list[dict], rules: list[dict] | None = None):
    return ImportTemplateReadinessPreviewRequest.model_validate(
        {
            "template_id": "tpl-1",
            "template_name": "Test template",
            "columns": columns,
            "rules": rules or [],
        }
    )


def _column_by_name(response, name: str):
    for column in response.columns:
        if column.column_name == name:
            return column
    raise AssertionError(
        f"Column {name!r} not in response: "
        f"{[c.column_name for c in response.columns]}"
    )


def _has_code(items: list[ReadinessItemOut], code: str) -> bool:
    return any(item.code == code for item in items)


# ---------------------------------------------------------------------------
# 1. Bill or Credit — manual_list with default → ready
# ---------------------------------------------------------------------------


def test_bill_or_credit_manual_list_default_ready():
    request = _request(
        [
            _column(
                "boc",
                "Bill or Credit",
                required=True,
                data_type="dropdown",
                source_type="manual_list",
                manual_values=["Bill", "Credit"],
                default_value="Bill",
                format_={"list_options": ["Bill", "Credit"]},
            )
        ]
    )

    response = preview_import_template_readiness(request)
    column = response.columns[0]

    assert response.status == "ready"
    assert column.status == "ready"
    assert column.expectation == "should_resolve"
    assert column.value_source.status == "ready"
    assert "Bill" in column.value_source.label
    # No required-missing readiness item should be emitted.
    assert not _has_code(column.items, "REQUIRED_RUNTIME_VALUE_MISSING")


# ---------------------------------------------------------------------------
# 2. Bill or Credit — manual_list NO default → not ready
# ---------------------------------------------------------------------------


def test_bill_or_credit_manual_list_no_default_not_ready():
    request = _request(
        [
            _column(
                "boc",
                "Bill or Credit",
                required=True,
                data_type="dropdown",
                source_type="manual_list",
                manual_values=["Bill", "Credit"],
                format_={"list_options": ["Bill", "Credit"]},
            )
        ]
    )

    response = preview_import_template_readiness(request)
    column = response.columns[0]

    assert response.status == "blocked"
    assert column.status == "blocked"
    assert column.expectation == "will_be_missing"
    assert _has_code(column.items, "MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION")
    assert _has_code(column.items, "REQUIRED_RUNTIME_VALUE_MISSING")


# ---------------------------------------------------------------------------
# 3. manual_list default not in list → still flagged (resolver falls
# through to manual_review). This is Phase A semantics; the validator
# separately surfaces MANUAL_LIST_DEFAULT_NOT_IN_LIST. The readiness
# preview reflects the resolver behavior.
# ---------------------------------------------------------------------------


def test_manual_list_default_not_in_list_warns():
    request = _request(
        [
            _column(
                "boc",
                "Bill or Credit",
                required=True,
                data_type="dropdown",
                source_type="manual_list",
                manual_values=["Bill", "Credit"],
                default_value="Refund",  # not in list
                format_={"list_options": ["Bill", "Credit"]},
            )
        ]
    )

    response = preview_import_template_readiness(request)
    column = response.columns[0]

    assert column.status == "blocked"
    # MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION is the resolver code that
    # fires when the default doesn't match (substrate mirrors this).
    assert _has_code(column.items, "MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION")
    assert _has_code(column.items, "REQUIRED_RUNTIME_VALUE_MISSING")


# ---------------------------------------------------------------------------
# 4. fixed_value with default → ready
# ---------------------------------------------------------------------------


def test_fixed_value_default_ready():
    request = _request(
        [
            _column(
                "currency",
                "Currency",
                required=True,
                source_type="fixed_value",
                default_value="USD",
            )
        ]
    )

    response = preview_import_template_readiness(request)
    column = response.columns[0]

    assert column.status == "ready"
    assert column.expectation == "should_resolve"
    assert column.value_source.status == "ready"
    assert not column.value_source.conditional


# ---------------------------------------------------------------------------
# 5. fixed_value required + missing default → blocked
# ---------------------------------------------------------------------------


def test_fixed_value_missing_required_blocked():
    request = _request(
        [
            _column(
                "currency",
                "Currency",
                required=True,
                source_type="fixed_value",
                default_value="",
            )
        ]
    )

    response = preview_import_template_readiness(request)
    column = response.columns[0]

    assert column.status == "blocked"
    assert column.expectation == "will_be_missing"
    assert _has_code(column.items, "FIXED_VALUE_EMPTY")


# ---------------------------------------------------------------------------
# 6. invoice_field required → may_be_missing (runtime dependent)
# ---------------------------------------------------------------------------


def test_invoice_field_required_is_runtime_dependent():
    request = _request(
        [
            _column(
                "inv",
                "Invoice Number",
                required=True,
                source_type="invoice_field",
                source_ref={"field": "invoice_number"},
            )
        ]
    )

    response = preview_import_template_readiness(request)
    column = response.columns[0]

    # Configuration is correct → status not blocked, but expectation
    # is may_be_missing (needs runtime extracted fact).
    assert column.expectation == "may_be_missing"
    assert column.value_source.status == "ready"
    assert column.value_source.conditional is True
    # The required-runtime-dependent advisory item should be present.
    assert _has_code(column.items, "READINESS_REQUIRED_RUNTIME_DEPENDENT")


# ---------------------------------------------------------------------------
# 7. invoice_field with no field bound → blocked
# ---------------------------------------------------------------------------


def test_invoice_field_missing_field_blocked():
    request = _request(
        [
            _column(
                "inv",
                "Invoice Number",
                required=True,
                source_type="invoice_field",
                source_ref={"field": None},
            )
        ]
    )

    response = preview_import_template_readiness(request)
    column = response.columns[0]

    assert column.status == "blocked"
    assert column.expectation == "will_be_missing"
    assert column.value_source.status == "blocked"


# ---------------------------------------------------------------------------
# 8. vendor_field with catalog + field → may_be_missing (runtime)
# ---------------------------------------------------------------------------


def test_vendor_field_catalog_runtime_dependent():
    request = _request(
        [
            _column(
                "vendor",
                "Vendor",
                required=True,
                source_type="vendor_field",
                source_ref={
                    "catalog_id": "cat-1",
                    "field": "vendor_name",
                },
            )
        ]
    )

    response = preview_import_template_readiness(request)
    column = response.columns[0]

    assert column.expectation == "may_be_missing"
    assert column.value_source.status == "ready"
    assert column.value_source.conditional is True


# ---------------------------------------------------------------------------
# 9. catalog source missing catalog → blocked
# ---------------------------------------------------------------------------


def test_catalog_source_missing_catalog_blocked():
    request = _request(
        [
            _column(
                "vendor",
                "Vendor",
                required=True,
                source_type="vendor_field",
                source_ref={"catalog_id": None, "field": "vendor_name"},
            )
        ]
    )

    response = preview_import_template_readiness(request)
    column = response.columns[0]

    assert column.status == "blocked"
    assert column.expectation == "will_be_missing"
    assert _has_code(column.items, "CATALOG_NOT_CONFIGURED")


# ---------------------------------------------------------------------------
# 10. required column with IF-only rule → warning, no fill path
# ---------------------------------------------------------------------------


def test_required_column_if_only_does_not_fill():
    request = _request(
        [
            _column("vendor", "Vendor"),
            _column(
                "boc",
                "Bill or Credit",
                required=True,
                source_type="empty",
                default_rule_role="condition",
            ),
        ],
        [
            _rule(
                "r1",
                {
                    "vendor": _cell("condition", ["EPB"]),
                    "boc": _cell("condition", ["Bill"]),
                },
            )
        ],
    )

    response = preview_import_template_readiness(request)
    boc = _column_by_name(response, "Bill or Credit")

    # No FILL anywhere + required + no default → blocked.
    assert boc.status == "blocked"
    assert _has_code(boc.items, "REQUIRED_RUNTIME_VALUE_MISSING")
    # The IF/LIMIT advisory should fire because role == condition.
    assert _has_code(boc.items, "READINESS_IF_LIMIT_DOES_NOT_FILL")


# ---------------------------------------------------------------------------
# 11. required column with unconditional FILL path → ready
# ---------------------------------------------------------------------------


def test_required_column_unconditional_fill_path_ready():
    request = _request(
        [
            _column(
                "boc",
                "Bill or Credit",
                required=True,
                source_type="empty",
                default_rule_role="action",
            )
        ],
        [
            # No IF/LIMIT siblings → unconditional fill.
            _rule(
                "r1",
                {"boc": _cell("action", ["Bill"])},
            )
        ],
    )

    response = preview_import_template_readiness(request)
    column = response.columns[0]

    assert column.status == "ready"
    assert column.expectation == "should_resolve"
    assert _has_code(column.items, "READINESS_UNCONDITIONAL_FILL")


# ---------------------------------------------------------------------------
# 12. required column with conditional FILL path → may_be_missing
# ---------------------------------------------------------------------------


def test_required_column_conditional_fill_path_may_be_missing():
    request = _request(
        [
            _column("vendor", "Vendor"),
            _column(
                "inv",
                "Invoice Number",
                required=True,
                source_type="empty",
                default_rule_role="action",
            ),
        ],
        [
            _rule(
                "r1",
                {
                    "vendor": _cell("condition", ["EPB"]),
                    "inv": _cell("action", ["INV-1"]),
                },
            )
        ],
    )

    response = preview_import_template_readiness(request)
    inv = _column_by_name(response, "Invoice Number")

    assert inv.expectation == "may_be_missing"
    # Status should be warning (conditional fill carries the row in
    # rule_runtime; required-runtime advisory is also warning, not
    # blocked).
    assert inv.status == "warning"
    assert _has_code(inv.items, "READINESS_CONDITIONAL_FILL_ONLY")


# ---------------------------------------------------------------------------
# 13. derived required → blocked
# ---------------------------------------------------------------------------


def test_derived_required_blocked():
    request = _request(
        [
            _column(
                "computed",
                "Computed Total",
                required=True,
                source_type="derived",
            )
        ]
    )

    response = preview_import_template_readiness(request)
    column = response.columns[0]

    assert column.status == "blocked"
    assert column.expectation == "will_be_missing"
    assert _has_code(column.items, "DERIVED_RESOLVER_NOT_IMPLEMENTED")


# ---------------------------------------------------------------------------
# 14. dropdown with empty list_options → blocked
# ---------------------------------------------------------------------------


def test_dropdown_empty_options_blocked():
    request = _request(
        [
            _column(
                "boc",
                "Bill or Credit",
                required=True,
                data_type="dropdown",
                source_type="fixed_value",
                default_value="Bill",
                # No format → list_options is None
            )
        ]
    )

    response = preview_import_template_readiness(request)
    column = response.columns[0]

    assert column.status == "blocked"
    assert _has_code(column.items, "DROPDOWN_OPTIONS_EMPTY")


# ---------------------------------------------------------------------------
# 15. Template-level rollup with mixed columns
# ---------------------------------------------------------------------------


def test_overall_template_status_rollup():
    request = _request(
        [
            # Ready
            _column(
                "currency",
                "Currency",
                source_type="fixed_value",
                default_value="USD",
            ),
            # Warning (runtime-dependent invoice field on required col)
            _column(
                "inv",
                "Invoice Number",
                required=True,
                source_type="invoice_field",
                source_ref={"field": "invoice_number"},
            ),
            # Blocked (required + no source)
            _column(
                "vendor",
                "Vendor",
                required=True,
                source_type="empty",
            ),
        ]
    )

    response = preview_import_template_readiness(request)

    # Rollup: at least one blocked → template status blocked.
    assert response.status == "blocked"
    assert response.summary.column_count == 3
    assert response.summary.blocked_columns >= 1
    assert response.summary.warning_columns >= 1
    assert response.summary.ready_columns >= 1
    # Per-column status should be exactly one of each.
    statuses = sorted(c.status for c in response.columns)
    assert statuses == ["blocked", "ready", "warning"]
    # Echo template metadata.
    assert response.template_id == "tpl-1"
    assert response.template_name == "Test template"


# ---------------------------------------------------------------------------
# Bonus sanity: every emitted item carries source="backend_readiness"
# so the wizard can disambiguate it from local heuristic items.
# ---------------------------------------------------------------------------


def test_every_item_carries_backend_readiness_source():
    request = _request(
        [
            _column(
                "currency",
                "Currency",
                source_type="fixed_value",
                default_value="USD",
            )
        ]
    )

    response = preview_import_template_readiness(request)
    for column in response.columns:
        for item in column.items:
            assert item.source == "backend_readiness"
