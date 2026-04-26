"""Reverse dependency checks for destructive deletes.

The app intentionally stores builder contracts as JSONB. That keeps the
modules loosely coupled, but it means hard deletes need an application
layer used-by scan before removing catalog/pattern rows. This service is
read-only: it never edits Import Builder templates or cascades changes.
"""

from __future__ import annotations

from collections import Counter
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.invoice_template import InvoiceTemplate
from app.repositories.gl_catalog_repo import GLCatalogRepository
from app.repositories.invoice_pattern_repo import InvoicePatternRepository
from app.repositories.invoice_template_repo import InvoiceTemplateRepository
from app.repositories.property_catalog_repo import PropertyCatalogRepository
from app.repositories.vendor_catalog_repo import VendorCatalogRepository
from app.schemas.dependencies import UsedByDependent, UsedByReport


CATALOG_SOURCE_BY_KIND: dict[str, str] = {
    "vendor_catalog": "vendor_field",
    "property_catalog": "property_field",
    "gl_catalog": "gl_field",
}


async def get_vendor_catalog_usage(
    db: AsyncSession, catalog_id: UUID
) -> UsedByReport:
    catalog = await VendorCatalogRepository(db).get(catalog_id)
    return await _get_catalog_usage(
        db,
        resource_type="vendor_catalog",
        catalog_id=catalog_id,
        resource_label=catalog.name if catalog else None,
    )


async def get_property_catalog_usage(
    db: AsyncSession, catalog_id: UUID
) -> UsedByReport:
    catalog = await PropertyCatalogRepository(db).get(catalog_id)
    return await _get_catalog_usage(
        db,
        resource_type="property_catalog",
        catalog_id=catalog_id,
        resource_label=catalog.name if catalog else None,
    )


async def get_gl_catalog_usage(db: AsyncSession, catalog_id: UUID) -> UsedByReport:
    catalog = await GLCatalogRepository(db).get(catalog_id)
    return await _get_catalog_usage(
        db,
        resource_type="gl_catalog",
        catalog_id=catalog_id,
        resource_label=catalog.name if catalog else None,
    )


async def get_invoice_pattern_usage(
    db: AsyncSession, pattern_id: UUID
) -> UsedByReport:
    pattern = await InvoicePatternRepository(db).get(pattern_id)
    templates = await _list_templates(db)
    target_id = str(pattern_id)
    dependents: list[UsedByDependent] = []

    for template in templates:
        raw_columns = _as_list(template.columns)
        raw_rules = _as_list(template.rules)
        column_lookup = _column_lookup(raw_columns)
        for rule_idx, raw_rule in enumerate(raw_rules):
            if not isinstance(raw_rule, dict):
                continue
            raw_cells = raw_rule.get("cells")
            if not isinstance(raw_cells, dict):
                continue
            rule_id = _string_or_none(raw_rule.get("id"))
            rule_label = _rule_label(raw_rule, rule_idx)
            for cell_key, raw_cell in raw_cells.items():
                if not isinstance(raw_cell, dict):
                    continue
                column = column_lookup.get(str(cell_key), {})
                column_label = _column_label(column, str(cell_key))

                bindings = raw_cell.get("extraction_bindings")
                if isinstance(bindings, list):
                    for binding_idx, raw_binding in enumerate(bindings):
                        if not isinstance(raw_binding, dict):
                            continue
                        if _ids_equal(raw_binding.get("pattern_id"), target_id):
                            field_key = _string_or_none(raw_binding.get("field_key"))
                            field_label = _string_or_none(
                                raw_binding.get("field_label")
                            )
                            field_display = field_label or field_key or "unknown field"
                            dependents.append(
                                UsedByDependent(
                                    severity="blocking",
                                    dependent_type="invoice_template",
                                    dependent_id=str(template.id),
                                    dependent_label=template.name,
                                    location=(
                                        f"rules[{rule_idx}].cells.{cell_key}."
                                        f"extraction_bindings[{binding_idx}]"
                                    ),
                                    message=(
                                        f"{template.name} / {rule_label} / "
                                        f"{column_label} uses this invoice "
                                        f"pattern field {field_display}."
                                    ),
                                    recommendation=(
                                        "Remove or change this extraction "
                                        "binding before deleting the invoice pattern."
                                    ),
                                    column_id=str(cell_key),
                                    column_label=column_label,
                                    rule_id=rule_id,
                                    rule_label=rule_label,
                                    cell_key=str(cell_key),
                                    related_id=field_key,
                                    related_type="invoice_pattern_field",
                                )
                            )

                legacy = raw_cell.get("extraction")
                if isinstance(legacy, dict) and _ids_equal(
                    legacy.get("pattern_id"), target_id
                ):
                    field_key = _string_or_none(legacy.get("field_key"))
                    dependents.append(
                        UsedByDependent(
                            severity="blocking",
                            dependent_type="invoice_template",
                            dependent_id=str(template.id),
                            dependent_label=template.name,
                            location=(
                                f"rules[{rule_idx}].cells.{cell_key}.extraction"
                            ),
                            message=(
                                f"{template.name} / {rule_label} / "
                                f"{column_label} uses this invoice pattern "
                                f"through a legacy extraction binding."
                            ),
                            recommendation=(
                                "Remove or change the legacy extraction "
                                "binding before deleting the invoice pattern."
                            ),
                            column_id=str(cell_key),
                            column_label=column_label,
                            rule_id=rule_id,
                            rule_label=rule_label,
                            cell_key=str(cell_key),
                            related_id=field_key,
                            related_type="invoice_pattern_field",
                        )
                    )

    return _build_report(
        resource_type="invoice_pattern",
        resource_id=target_id,
        resource_label=pattern.name if pattern else None,
        dependents=dependents,
        empty_info="No Import Builder extraction bindings reference this invoice pattern.",
    )


async def get_invoice_template_usage(
    db: AsyncSession, template_id: UUID
) -> UsedByReport:
    template = await InvoiceTemplateRepository(db).get(template_id)
    return _build_report(
        resource_type="invoice_template",
        resource_id=str(template_id),
        resource_label=template.name if template else None,
        dependents=[],
        empty_info="No persistent dependencies were found for this Import Builder template.",
    )


async def _get_catalog_usage(
    db: AsyncSession,
    *,
    resource_type: str,
    catalog_id: UUID,
    resource_label: str | None,
) -> UsedByReport:
    templates = await _list_templates(db)
    target_id = str(catalog_id)
    expected_source = CATALOG_SOURCE_BY_KIND[resource_type]
    dependents: list[UsedByDependent] = []
    seen: set[tuple[str, str, str | None]] = set()

    for template in templates:
        raw_columns = _as_list(template.columns)
        raw_rules = _as_list(template.rules)
        column_lookup = _column_lookup(raw_columns)

        for column_idx, raw_column in enumerate(raw_columns):
            if not isinstance(raw_column, dict):
                continue
            column_id = _string_or_none(raw_column.get("id")) or f"column-{column_idx}"
            column_label = _column_label(raw_column, column_id)
            source_type = _column_source_type(raw_column)
            source_ref = raw_column.get("source_ref") or raw_column.get(
                "sourceRef"
            )
            source_ref = source_ref if isinstance(source_ref, dict) else {}

            column_catalog_ids = _collect_catalog_ids(raw_column)
            source_ref_id = source_ref.get("catalog_id")
            if _ids_equal(source_ref_id, target_id) or target_id in column_catalog_ids:
                location = f"columns[{column_idx}].source_ref.catalog_id"
                key = (str(template.id), location, column_id)
                if key not in seen:
                    seen.add(key)
                    dependents.append(
                        UsedByDependent(
                            severity="blocking",
                            dependent_type="invoice_template",
                            dependent_id=str(template.id),
                            dependent_label=template.name,
                            location=location,
                            message=(
                                f"{template.name} uses this "
                                f"{_resource_label(resource_type)} in column "
                                f"{column_label}."
                            ),
                            recommendation=(
                                "Remove or change this catalog binding before "
                                "deleting the catalog."
                            ),
                            column_id=column_id,
                            column_label=column_label,
                            related_id=_string_or_none(source_ref.get("field")),
                            related_type=f"{resource_type}_field",
                        )
                    )
            elif source_type == expected_source and not source_ref.get("catalog_id"):
                dependents.append(
                    UsedByDependent(
                        severity="info",
                        dependent_type="invoice_template",
                        dependent_id=str(template.id),
                        dependent_label=template.name,
                        location=f"columns[{column_idx}].source_ref",
                        message=(
                            f"{template.name} has {column_label} configured "
                            f"for {_resource_label(resource_type)} but no "
                            "specific catalog id is selected."
                        ),
                        recommendation=(
                            "No delete blocker was found for this catalog id, "
                            "but the template may still need configuration."
                        ),
                        column_id=column_id,
                        column_label=column_label,
                    )
                )

        for rule_idx, raw_rule in enumerate(raw_rules):
            if not isinstance(raw_rule, dict):
                continue
            raw_cells = raw_rule.get("cells")
            if not isinstance(raw_cells, dict):
                continue
            rule_id = _string_or_none(raw_rule.get("id"))
            rule_label = _rule_label(raw_rule, rule_idx)
            for cell_key, raw_cell in raw_cells.items():
                if not isinstance(raw_cell, dict):
                    continue
                cell_catalog_ids = _collect_catalog_ids(raw_cell)
                column = column_lookup.get(str(cell_key), {})
                column_source_ref = column.get("source_ref") or column.get(
                    "sourceRef"
                )
                column_source_ref = (
                    column_source_ref
                    if isinstance(column_source_ref, dict)
                    else {}
                )
                column_source_type = _column_source_type(column)
                column_uses_target = _ids_equal(
                    column_source_ref.get("catalog_id"), target_id
                )
                explicit_cell_target = target_id in cell_catalog_ids
                has_structured_selection = bool(raw_cell.get("selections"))
                if not (
                    explicit_cell_target
                    or (
                        column_uses_target
                        and column_source_type == expected_source
                        and has_structured_selection
                    )
                ):
                    continue

                column_id = str(cell_key)
                column_label = _column_label(column, column_id)
                location = f"rules[{rule_idx}].cells.{cell_key}"
                key = (str(template.id), location, column_id)
                if key in seen:
                    continue
                seen.add(key)
                dependents.append(
                    UsedByDependent(
                        severity="blocking",
                        dependent_type="invoice_template",
                        dependent_id=str(template.id),
                        dependent_label=template.name,
                        location=location,
                        message=(
                            f"{template.name} / {rule_label} / "
                            f"{column_label} has rule-cell selections "
                            f"from this {_resource_label(resource_type)}."
                        ),
                        recommendation=(
                            "Remove or change these rule-cell selections "
                            "before deleting the catalog."
                        ),
                        column_id=column_id,
                        column_label=column_label,
                        rule_id=rule_id,
                        rule_label=rule_label,
                        cell_key=str(cell_key),
                        related_id=_selection_related_id(raw_cell),
                        related_type=f"{resource_type}_entry",
                    )
                )

    return _build_report(
        resource_type=resource_type,
        resource_id=target_id,
        resource_label=resource_label,
        dependents=dependents,
        empty_info=f"No Import Builder templates reference this {_resource_label(resource_type)}.",
    )


async def _list_templates(db: AsyncSession) -> list[InvoiceTemplate]:
    repo = InvoiceTemplateRepository(db)
    limit = 500
    offset = 0
    templates: list[InvoiceTemplate] = []
    while True:
        page = await repo.list_recent(limit=limit, offset=offset)
        templates.extend(page)
        if len(page) < limit:
            return templates
        offset += limit


def _build_report(
    *,
    resource_type: str,
    resource_id: str,
    resource_label: str | None,
    dependents: list[UsedByDependent],
    empty_info: str,
) -> UsedByReport:
    if not dependents:
        dependents = [
            UsedByDependent(
                severity="info",
                dependent_type="system",
                dependent_id=None,
                dependent_label=None,
                location=None,
                message=empty_info,
                recommendation=None,
            )
        ]
    counts = Counter(d.severity for d in dependents)
    return UsedByReport(
        resource_type=resource_type,
        resource_id=resource_id,
        resource_label=resource_label,
        safe_to_delete=counts["blocking"] == 0,
        blocking_count=counts["blocking"],
        warning_count=counts["warning"],
        info_count=counts["info"],
        dependents=dependents,
    )


def _column_lookup(raw_columns: list[Any]) -> dict[str, dict[str, Any]]:
    lookup: dict[str, dict[str, Any]] = {}
    for idx, raw_column in enumerate(raw_columns):
        if not isinstance(raw_column, dict):
            continue
        column_id = _string_or_none(raw_column.get("id")) or f"column-{idx}"
        lookup[column_id] = raw_column
    return lookup


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _ids_equal(left: Any, right: str) -> bool:
    left_text = _string_or_none(left)
    return left_text == right if left_text is not None else False


def _column_label(raw_column: dict[str, Any], fallback: str) -> str:
    return (
        _string_or_none(raw_column.get("name"))
        or _string_or_none(raw_column.get("label"))
        or fallback
    )


def _rule_label(raw_rule: dict[str, Any], rule_idx: int) -> str:
    return (
        _string_or_none(raw_rule.get("label"))
        or _string_or_none(raw_rule.get("name"))
        or f"Rule #{rule_idx + 1}"
    )


def _column_source_type(raw_column: dict[str, Any]) -> str | None:
    return (
        _string_or_none(raw_column.get("source_type"))
        or _string_or_none(raw_column.get("value_source"))
        or _string_or_none(raw_column.get("source"))
    )


def _resource_label(resource_type: str) -> str:
    return resource_type.replace("_", " ")


def _collect_catalog_ids(value: Any) -> set[str]:
    found: set[str] = set()

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            for key, child in node.items():
                normalized_key = str(key).strip().lower()
                if normalized_key in {"catalog_id", "catalogid", "selected_catalog_id"}:
                    child_value = _string_or_none(child)
                    if child_value:
                        found.add(child_value)
                else:
                    visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(value)
    return found


def _selection_related_id(raw_cell: dict[str, Any]) -> str | None:
    selections = raw_cell.get("selections")
    if not isinstance(selections, list):
        return None
    for selection in selections:
        if isinstance(selection, dict):
            entry_id = _string_or_none(selection.get("entry_id"))
            if entry_id:
                return entry_id
    return None
