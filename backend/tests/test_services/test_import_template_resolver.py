import uuid
from types import SimpleNamespace

import pytest

from app.models.invoice_template import InvoiceTemplate
from app.schemas.import_resolver import CatalogHint, ExtractedFact, ResolverInput
from app.services import import_template_resolver as resolver
from app.services.import_template_resolver import dry_run_resolve_import_template


def _template(columns: list[dict], rules: list[dict] | None = None) -> InvoiceTemplate:
    return InvoiceTemplate(
        id=uuid.uuid4(),
        name="Resolver dry-run test",
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
    allow_rule_override: bool = True,
) -> dict:
    data = {
        "id": column_id,
        "name": name,
        "required": required,
        "data_type": data_type,
        "source_type": source_type,
        "allow_rule_override": allow_rule_override,
        "default_rule_role": None,
    }
    if default_value is not None:
        data["default_value"] = default_value
    if source_ref is not None:
        data["source_ref"] = source_ref
    return data


def _cell(
    role: str,
    values: list[str] | None = None,
    extraction_bindings: list[dict] | None = None,
) -> dict:
    return {
        "role": role,
        "values": values or [],
        "extraction_bindings": extraction_bindings or [],
    }


def _rule(rule_id: str, cells: dict[str, dict], *, active: bool = True) -> dict:
    return {"id": rule_id, "is_active": active, "cells": cells}


def _cells_by_id(result) -> dict:
    return {cell.column_id: cell for cell in result.rows[0].cells}


@pytest.mark.asyncio
async def test_empty_template_returns_empty_ready_row():
    result = await dry_run_resolve_import_template(_template([]))

    assert result.rows[0].status == "ready"
    assert result.rows[0].cells == []


@pytest.mark.asyncio
async def test_fixed_default_resolves_ready_with_provenance():
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

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["expense_type"]

    assert result.rows[0].status == "ready"
    assert cell.value == "General"
    assert cell.provenance.source_type == "fixed_value"


@pytest.mark.asyncio
async def test_required_missing_baseline_blocks_row():
    template = _template([_column("invoice_number", "Invoice Number", required=True)])

    result = await dry_run_resolve_import_template(template)

    assert result.rows[0].status == "blocked"
    assert "REQUIRED_RUNTIME_VALUE_MISSING" in _cells_by_id(result)["invoice_number"].issue_codes


@pytest.mark.asyncio
async def test_required_missing_resolved_by_fill_becomes_ready():
    template = _template(
        [
            _column("vendor", "Vendor"),
            _column("gl", "GL Account", required=True),
        ],
        [
            _rule(
                "r1",
                {
                    "vendor": _cell("condition", ["EPB"]),
                    "gl": _cell("action", ["6915"]),
                },
            )
        ],
    )

    result = await dry_run_resolve_import_template(
        template, ResolverInput(document_metadata={"Vendor": "EPB"})
    )
    cell = _cells_by_id(result)["gl"]

    assert result.rows[0].status == "ready"
    assert cell.value == "6915"
    assert "REQUIRED_RUNTIME_VALUE_MISSING" not in cell.issue_codes
    assert cell.provenance.rule_id == "r1"


@pytest.mark.asyncio
async def test_conflicting_fill_actions_mark_conflict():
    template = _template(
        [_column("vendor", "Vendor"), _column("gl", "GL Account")],
        [
            _rule("r1", {"vendor": _cell("condition", ["EPB"]), "gl": _cell("action", ["6915"])}),
            _rule("r2", {"vendor": _cell("condition", ["EPB"]), "gl": _cell("action", ["6910"])}),
        ],
    )

    result = await dry_run_resolve_import_template(
        template, ResolverInput(document_metadata={"Vendor": "EPB"})
    )
    cell = _cells_by_id(result)["gl"]

    assert result.rows[0].status == "conflict"
    assert cell.value == "6915"
    assert "CONFLICTING_RULE_ACTION" in cell.issue_codes


@pytest.mark.asyncio
async def test_allow_rule_override_false_ignores_fill():
    template = _template(
        [
            _column("vendor", "Vendor"),
            _column(
                "expense_type",
                "Expense Type",
                source_type="fixed_value",
                default_value="General",
                allow_rule_override=False,
            ),
        ],
        [
            _rule(
                "r1",
                {
                    "vendor": _cell("condition", ["EPB"]),
                    "expense_type": _cell("action", ["Repairs"]),
                },
            )
        ],
    )

    result = await dry_run_resolve_import_template(
        template, ResolverInput(document_metadata={"Vendor": "EPB"})
    )
    cell = _cells_by_id(result)["expense_type"]

    assert result.rows[0].status == "needs_review"
    assert cell.value == "General"
    assert "RULE_ACTION_IGNORED_BY_GLOBAL_OVERRIDE" in cell.issue_codes


@pytest.mark.asyncio
async def test_catalog_hint_resolves_baseline_catalog_field(monkeypatch):
    async def fake_validate(*_args, **_kwargs):
        return SimpleNamespace(issues=[])

    async def fake_load_catalog_entries(*_args, **_kwargs):
        return resolver.LoadedCatalog(
            kind="vendor",
            catalog_id="catalog-1",
            label="Vendor Catalog",
            entries=[{"id": "vendor-1", "vendor_name": "EPB", "vendor_code": "V-100"}],
        )

    monkeypatch.setattr(resolver, "validate_import_template", fake_validate)
    monkeypatch.setattr(resolver, "load_catalog_entries", fake_load_catalog_entries)
    template = _template(
        [
            _column(
                "vendor",
                "Vendor",
                source_type="vendor_field",
                source_ref={"catalog_id": "catalog-1", "field": "vendor_code"},
            )
        ]
    )

    result = await dry_run_resolve_import_template(
        template,
        ResolverInput(catalog_hints={"vendor": CatalogHint(text="EPB")}),
        db=object(),
    )
    cell = _cells_by_id(result)["vendor"]

    assert result.rows[0].status == "ready"
    assert cell.value == "V-100"
    assert cell.provenance.catalog_id == "catalog-1"
    assert cell.provenance.entry_id == "vendor-1"


@pytest.mark.asyncio
async def test_missing_catalog_hint_blocks_required_catalog_column(monkeypatch):
    async def fake_validate(*_args, **_kwargs):
        return SimpleNamespace(issues=[])

    async def fake_load_catalog_entries(*_args, **_kwargs):
        return resolver.LoadedCatalog(
            kind="vendor",
            catalog_id="catalog-1",
            label="Vendor Catalog",
            entries=[{"id": "vendor-1", "vendor_name": "EPB"}],
        )

    monkeypatch.setattr(resolver, "validate_import_template", fake_validate)
    monkeypatch.setattr(resolver, "load_catalog_entries", fake_load_catalog_entries)
    template = _template(
        [
            _column(
                "vendor",
                "Vendor",
                required=True,
                source_type="vendor_field",
                source_ref={"catalog_id": "catalog-1", "field": "vendor_name"},
            )
        ]
    )

    result = await dry_run_resolve_import_template(template, ResolverInput(), db=object())
    cell = _cells_by_id(result)["vendor"]

    assert result.rows[0].status == "blocked"
    assert "CATALOG_HINT_MISSING" in cell.issue_codes
    assert "REQUIRED_RUNTIME_VALUE_MISSING" in cell.issue_codes


@pytest.mark.asyncio
async def test_if_failed_rule_does_not_apply_fill():
    template = _template(
        [_column("vendor", "Vendor"), _column("gl", "GL Account")],
        [
            _rule("r1", {"vendor": _cell("condition", ["HWEA"]), "gl": _cell("action", ["6915"])})
        ],
    )

    result = await dry_run_resolve_import_template(
        template, ResolverInput(document_metadata={"Vendor": "EPB"})
    )

    assert _cells_by_id(result)["gl"].value is None
    assert result.rows[0].matched_rules[0].eligible_for_actions is False


@pytest.mark.asyncio
async def test_limit_restricted_out_rule_does_not_apply_fill():
    template = _template(
        [_column("vendor", "Vendor"), _column("property", "Property"), _column("gl", "GL Account")],
        [
            _rule(
                "r1",
                {
                    "vendor": _cell("condition", ["EPB"]),
                    "property": _cell("restriction", ["Other"]),
                    "gl": _cell("action", ["6915"]),
                },
            )
        ],
    )

    result = await dry_run_resolve_import_template(
        template, ResolverInput(document_metadata={"Vendor": "EPB", "Property": "ADM"})
    )

    assert _cells_by_id(result)["gl"].value is None
    assert result.rows[0].matched_rules[0].restricted_out is True
    assert result.rows[0].matched_rules[0].eligible_for_actions is False


@pytest.mark.asyncio
async def test_extracted_fact_alias_satisfies_invoice_field_baseline():
    template = _template(
        [
            _column(
                "amount",
                "Amount",
                data_type="currency",
                source_type="invoice_field",
                source_ref={"field": "total_amount"},
            )
        ]
    )

    result = await dry_run_resolve_import_template(
        template,
        ResolverInput(
            extracted_facts=[
                ExtractedFact(field_key="amount", value="123.45", source_type="invoice_pattern")
            ]
        ),
    )
    cell = _cells_by_id(result)["amount"]

    assert result.rows[0].status == "ready"
    assert cell.normalized_value == 123.45
    assert cell.provenance.normalized_field_key == "total_amount"


@pytest.mark.asyncio
async def test_invalid_data_type_coercion_produces_blocking_issue_for_required_column():
    template = _template(
        [
            _column(
                "amount",
                "Amount",
                required=True,
                data_type="number",
                source_type="fixed_value",
                default_value="not-a-number",
            )
        ]
    )

    result = await dry_run_resolve_import_template(template)
    cell = _cells_by_id(result)["amount"]

    assert result.rows[0].status == "blocked"
    assert "DATA_TYPE_COERCION_FAILED" in cell.issue_codes
