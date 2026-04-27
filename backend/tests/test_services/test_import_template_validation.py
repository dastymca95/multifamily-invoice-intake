"""Validator tests for the Phase A manual_list/default contract.

The validator's catalog and invoice_field branches use the AsyncSession
to look up references, but the manual_list and fixed_value branches do
not — they're pure column-shape checks. These tests exercise only the
DB-free paths so we don't need to spin up a Postgres test database for
fast unit coverage.

If a future check adds a DB call to the manual_list path, swap the
`unittest.mock.MagicMock` stub for the project's `db_session` fixture
(see `backend/tests/conftest.py`).
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest

from app.models.invoice_template import InvoiceTemplate
from app.services.import_template_validation import validate_import_template


def _template(columns: list[dict], rules: list[dict] | None = None) -> InvoiceTemplate:
    return InvoiceTemplate(
        id=uuid.uuid4(),
        name="Validator manual_list test",
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
    source_type: str = "manual_list",
    default_value: str | None = None,
    manual_values: list[str] | None = None,
    format_: dict | None = None,
) -> dict:
    data = {
        "id": column_id,
        "name": name,
        "required": required,
        "data_type": data_type,
        "source_type": source_type,
        "allow_rule_override": True,
        "default_rule_role": None,
    }
    if default_value is not None:
        data["default_value"] = default_value
    if manual_values is not None:
        data["manual_values"] = manual_values
    if format_ is not None:
        data["format"] = format_
    return data


def _codes(result) -> list[str]:
    return [issue.code for issue in result.issues]


@pytest.mark.asyncio
async def test_manual_list_default_in_list_no_warning():
    """Happy path: default_value matches a manual_values entry."""
    template = _template(
        [
            _column(
                "bill_or_credit",
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

    result = await validate_import_template(template, MagicMock())

    assert "MANUAL_LIST_DEFAULT_NOT_IN_LIST" not in _codes(result)


@pytest.mark.asyncio
async def test_manual_list_default_not_in_list_emits_warning():
    """Case D — default_value set but not in manual_values."""
    template = _template(
        [
            _column(
                "bill_or_credit",
                "Bill or Credit",
                required=True,
                data_type="dropdown",
                source_type="manual_list",
                manual_values=["Bill", "Credit"],
                default_value="Refund",  # not in manual_values
                format_={"list_options": ["Bill", "Credit"]},
            )
        ]
    )

    result = await validate_import_template(template, MagicMock())

    issue = next(
        (i for i in result.issues if i.code == "MANUAL_LIST_DEFAULT_NOT_IN_LIST"),
        None,
    )
    assert issue is not None, _codes(result)
    assert issue.severity == "warning"
    # The warning must NOT block save: ready depends only on errors.
    assert issue.severity != "error"


@pytest.mark.asyncio
async def test_manual_list_default_whitespace_match_does_not_warn():
    """Whitespace around default_value is trimmed before comparison.

    Mirrors the resolver's normalization so the validator and resolver
    agree on whether the default is honored.
    """
    template = _template(
        [
            _column(
                "bill_or_credit",
                "Bill or Credit",
                source_type="manual_list",
                manual_values=["Bill", "Credit"],
                default_value="  Bill  ",
            )
        ]
    )

    result = await validate_import_template(template, MagicMock())

    assert "MANUAL_LIST_DEFAULT_NOT_IN_LIST" not in _codes(result)


@pytest.mark.asyncio
async def test_manual_list_no_default_does_not_warn():
    """No default_value at all is the legitimate "operator picks at runtime"
    state; the new advisory must only fire when a default is set."""
    template = _template(
        [
            _column(
                "bill_or_credit",
                "Bill or Credit",
                source_type="manual_list",
                manual_values=["Bill", "Credit"],
            )
        ]
    )

    result = await validate_import_template(template, MagicMock())

    assert "MANUAL_LIST_DEFAULT_NOT_IN_LIST" not in _codes(result)


@pytest.mark.asyncio
async def test_fixed_value_default_does_not_trigger_manual_list_warning():
    """Sanity: the new check is scoped to manual_list source only."""
    template = _template(
        [
            _column(
                "expense_type",
                "Expense Type",
                source_type="fixed_value",
                default_value="General",
            )
        ]
    )

    result = await validate_import_template(template, MagicMock())

    assert "MANUAL_LIST_DEFAULT_NOT_IN_LIST" not in _codes(result)
