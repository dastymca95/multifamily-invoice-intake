"""Readiness validation for Import Builder templates.

Draft saves stay permissive. This service is an explicit, read-only
gate that reports whether a saved Import Builder template is ready for
runtime/export use and why not.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.extracted_invoice_fields import (
    is_known_extracted_field_key,
    normalize_extracted_field_key,
)
from app.models.invoice_pattern import InvoicePattern
from app.models.invoice_template import InvoiceTemplate
from app.repositories.gl_catalog_repo import GLCatalogRepository
from app.repositories.invoice_pattern_repo import InvoicePatternRepository
from app.repositories.property_catalog_repo import PropertyCatalogRepository
from app.repositories.vendor_catalog_repo import VendorCatalogRepository
from app.schemas.invoice_pattern import (
    InvoicePatternFieldDefinition,
    InvoicePatternFieldOption,
    InvoicePatternRegion,
    InvoicePatternSourceFile,
    build_pattern_field_options,
)
from app.schemas.invoice_template import (
    ImportTemplateValidationIssue,
    ImportTemplateValidationResult,
    ImportTemplateValidationSummary,
    InvoiceTemplateColumn,
    InvoiceTemplateRule,
    InvoiceTemplateRuleCell,
    RuleCellExtraction,
    RuleCellExtractionBinding,
    RuleRole,
    ValidationSeverity,
    effective_rule_cell_role,
    is_global_mode_compatible_with,
)


CATALOG_SOURCE_TYPES = {"vendor_field", "property_field", "gl_field"}
INVOICE_SOURCE_TYPE = "invoice_field"
ROLE_VALUES: set[str] = {"condition", "restriction", "action"}

CATALOG_KIND_BY_SOURCE: dict[str, str] = {
    "vendor_field": "vendor",
    "property_field": "property",
    "gl_field": "gl",
}

CATALOG_FIELD_ALIASES: dict[str, dict[str, str]] = {
    "vendor": {"external_id": "vendor_code"},
    "property": {
        "abbreviation": "property_abbreviation",
        "name": "property_name",
        "external_id": "property_code",
    },
    "gl": {"gl_code": "code"},
}

CATALOG_FIELDS: dict[str, set[str]] = {
    "vendor": {
        "vendor_name",
        "vendor_code",
        "external_id",
        "aliases",
        "address",
        "city",
        "state",
        "zip",
        "contact_name",
        "email",
        "phone",
        "active",
        "notes",
    },
    "property": {
        "property_name",
        "property_code",
        "property_abbreviation",
        "abbreviation",
        "name",
        "external_id",
        "address",
        "city",
        "state",
        "zip",
        "unit_number",
        "unit_type",
        "building",
        "active",
        "notes",
    },
    "gl": {"gl_code", "code", "description", "category", "active", "notes"},
}


@dataclass
class ParsedTemplate:
    columns: list[InvoiceTemplateColumn]
    rules: list[InvoiceTemplateRule]
    raw_columns: list[Any]
    raw_rules: list[Any]


class ValidationContext:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.issues: list[ImportTemplateValidationIssue] = []
        self.catalogs: dict[tuple[str, str], Any | None] = {}
        self.patterns: dict[str, InvoicePattern | None] = {}
        self.pattern_options: dict[str, dict[str, InvoicePatternFieldOption]] = {}
        self.pattern_has_visible_pages: dict[str, bool] = {}
        self.any_invoice_pattern_exists: bool | None = None

    def add(
        self,
        severity: ValidationSeverity,
        code: str,
        message: str,
        *,
        recommendation: str | None = None,
        column: InvoiceTemplateColumn | None = None,
        column_id: str | None = None,
        column_label: str | None = None,
        rule: InvoiceTemplateRule | None = None,
        rule_id: str | None = None,
        rule_label: str | None = None,
        cell_key: str | None = None,
        path: str | None = None,
        related_id: str | None = None,
        related_type: str | None = None,
    ) -> None:
        self.issues.append(
            ImportTemplateValidationIssue(
                severity=severity,
                code=code,
                message=message,
                recommendation=recommendation,
                column_id=column_id or (column.id if column else None),
                column_label=column_label or (column.name if column else None),
                rule_id=rule_id or (rule.id if rule else None),
                rule_label=rule_label,
                cell_key=cell_key,
                path=path,
                related_id=related_id,
                related_type=related_type,
            )
        )

    async def get_catalog(self, kind: str, catalog_id: str | None) -> Any | None:
        if not catalog_id:
            return None
        key = (kind, catalog_id)
        if key in self.catalogs:
            return self.catalogs[key]
        parsed_id = _parse_uuid(catalog_id)
        if parsed_id is None:
            self.catalogs[key] = None
            return None
        repo: VendorCatalogRepository | PropertyCatalogRepository | GLCatalogRepository
        if kind == "vendor":
            repo = VendorCatalogRepository(self.db)
        elif kind == "property":
            repo = PropertyCatalogRepository(self.db)
        else:
            repo = GLCatalogRepository(self.db)
        self.catalogs[key] = await repo.get(parsed_id)
        return self.catalogs[key]

    async def get_pattern(self, pattern_id: str | None) -> InvoicePattern | None:
        if not pattern_id:
            return None
        if pattern_id in self.patterns:
            return self.patterns[pattern_id]
        parsed_id = _parse_uuid(pattern_id)
        if parsed_id is None:
            self.patterns[pattern_id] = None
            return None
        self.patterns[pattern_id] = await InvoicePatternRepository(self.db).get(
            parsed_id
        )
        return self.patterns[pattern_id]

    async def has_any_invoice_pattern(self) -> bool:
        if self.any_invoice_pattern_exists is not None:
            return self.any_invoice_pattern_exists
        rows = await InvoicePatternRepository(self.db).list_recent(limit=1)
        self.any_invoice_pattern_exists = len(rows) > 0
        return self.any_invoice_pattern_exists

    def field_options_for(
        self, pattern: InvoicePattern
    ) -> dict[str, InvoicePatternFieldOption]:
        pattern_id = str(pattern.id)
        if pattern_id in self.pattern_options:
            return self.pattern_options[pattern_id]

        field_definitions = _parse_pattern_items(
            pattern.field_definitions or [],
            InvoicePatternFieldDefinition,
        )
        regions = _parse_pattern_items(pattern.regions or [], InvoicePatternRegion)
        options = build_pattern_field_options(field_definitions, regions)
        by_key: dict[str, InvoicePatternFieldOption] = {}
        for option in options:
            by_key[option.key] = option
            normalized = normalize_extracted_field_key(option.key)
            if normalized:
                by_key.setdefault(normalized, option)
        self.pattern_options[pattern_id] = by_key
        return by_key

    def pattern_has_non_deleted_page(self, pattern: InvoicePattern) -> bool:
        pattern_id = str(pattern.id)
        if pattern_id in self.pattern_has_visible_pages:
            return self.pattern_has_visible_pages[pattern_id]
        files = _parse_pattern_items(
            pattern.source_files or [],
            InvoicePatternSourceFile,
        )
        has_visible = any(
            source_file.page_count > len(set(source_file.deleted_pages or []))
            for source_file in files
        )
        self.pattern_has_visible_pages[pattern_id] = has_visible
        return has_visible


async def validate_import_template(
    template: InvoiceTemplate, db: AsyncSession
) -> ImportTemplateValidationResult:
    """Validate a saved Import Builder template without mutating it."""

    ctx = ValidationContext(db)
    parsed = _parse_template(template, ctx)

    await _validate_template_level(template, parsed, ctx)
    await _validate_columns(parsed, ctx)
    await _validate_rules(parsed, ctx)
    await _validate_required_columns(parsed, ctx)

    counts = Counter(issue.severity for issue in ctx.issues)
    summary = ImportTemplateValidationSummary(
        errors=counts["error"],
        warnings=counts["warning"],
        info=counts["info"],
    )
    return ImportTemplateValidationResult(
        template_id=str(template.id),
        template_name=template.name,
        ready=summary.errors == 0,
        summary=summary,
        issues=ctx.issues,
    )


def _parse_template(template: InvoiceTemplate, ctx: ValidationContext) -> ParsedTemplate:
    raw_columns = list(template.columns or [])
    raw_rules = list(template.rules or [])

    columns: list[InvoiceTemplateColumn] = []
    for idx, raw in enumerate(raw_columns):
        try:
            columns.append(InvoiceTemplateColumn.model_validate(raw))
        except Exception as exc:
            ctx.add(
                "error",
                "COLUMN_INVALID_SCHEMA",
                f"Column at position {idx + 1} cannot be read: {exc}",
                recommendation="Open the template, review the column, and save it again after correcting malformed data.",
                path=f"columns[{idx}]",
            )

    for rule_idx, raw_rule in enumerate(raw_rules):
        raw_cells = raw_rule.get("cells") if isinstance(raw_rule, dict) else None
        if isinstance(raw_cells, dict):
            for cell_key, raw_cell in raw_cells.items():
                if not isinstance(raw_cell, dict):
                    continue
                raw_role = raw_cell.get("role")
                if raw_role is not None and raw_role not in ROLE_VALUES:
                    ctx.add(
                        "error",
                        "RULE_ROLE_UNKNOWN",
                        f"Rule cell {cell_key} has unknown role {raw_role!r}.",
                        recommendation="Use IF, LIMIT, FILL, or clear the cell role.",
                        rule_id=str(raw_rule.get("id") or ""),
                        cell_key=str(cell_key),
                        path=f"rules[{rule_idx}].cells.{cell_key}.role",
                    )

    rules: list[InvoiceTemplateRule] = []
    for idx, raw in enumerate(raw_rules):
        try:
            rules.append(InvoiceTemplateRule.model_validate(raw))
        except Exception as exc:
            rule_id = raw.get("id") if isinstance(raw, dict) else None
            ctx.add(
                "error",
                "RULE_INVALID_SCHEMA",
                f"Rule at position {idx + 1} cannot be read: {exc}",
                recommendation="Open the rule row, review its cells, and save after correcting malformed data.",
                rule_id=str(rule_id) if rule_id else None,
                path=f"rules[{idx}]",
            )

    return ParsedTemplate(
        columns=columns,
        rules=rules,
        raw_columns=raw_columns,
        raw_rules=raw_rules,
    )


async def _validate_template_level(
    template: InvoiceTemplate, parsed: ParsedTemplate, ctx: ValidationContext
) -> None:
    if not (template.name or "").strip():
        ctx.add(
            "error",
            "TEMPLATE_NAME_MISSING",
            "Template name is missing.",
            recommendation="Give the template a stable name before using it operationally.",
            path="name",
        )

    if not parsed.raw_columns:
        ctx.add(
            "error",
            "TEMPLATE_NO_COLUMNS",
            "Template has no columns.",
            recommendation="Add at least one output column.",
            path="columns",
        )

    column_ids = [_safe_attr_or_key(raw, "id") for raw in parsed.raw_columns]
    _flag_duplicates(
        column_ids,
        ctx,
        code="DUPLICATE_COLUMN_ID",
        message="Template contains duplicate column id {value}.",
        recommendation="Regenerate one of the duplicated column ids by recreating the column.",
        path_prefix="columns",
    )

    rule_ids = [_safe_attr_or_key(raw, "id") for raw in parsed.raw_rules]
    _flag_duplicates(
        rule_ids,
        ctx,
        code="DUPLICATE_RULE_ID",
        message="Template contains duplicate rule id {value}.",
        recommendation="Duplicate the rule again or recreate one of the rows so each rule has a unique id.",
        path_prefix="rules",
    )

    for idx, column in enumerate(parsed.columns):
        if not column.id.strip():
            ctx.add(
                "error",
                "COLUMN_ID_MISSING",
                f"Column {idx + 1} has no stable id.",
                recommendation="Recreate the column so the editor can assign a stable id.",
                path=f"columns[{idx}].id",
            )
        if not column.name.strip():
            ctx.add(
                "error",
                "COLUMN_LABEL_MISSING",
                f"Column {idx + 1} is missing a label.",
                recommendation="Name the column before using this template.",
                column=column,
                path=f"columns[{idx}].name",
            )


async def _validate_columns(parsed: ParsedTemplate, ctx: ValidationContext) -> None:
    for column_idx, column in enumerate(parsed.columns):
        source_type = column.source_type or "empty"
        path = f"columns[{column_idx}]"

        if column.lock_position or column.lock_editing:
            locks = []
            if column.lock_position:
                locks.append("position")
            if column.lock_editing:
                locks.append("editing")
            ctx.add(
                "info",
                "COLUMN_LOCKED",
                f"Column {column.name} has {', '.join(locks)} lock enabled.",
                column=column,
                path=path,
            )

        if not is_global_mode_compatible_with(column.data_type, source_type):
            ctx.add(
                "warning",
                "DATA_TYPE_SOURCE_INCOMPATIBLE",
                f"Column {column.name} uses data type {column.data_type} with source {source_type}.",
                recommendation="Confirm the global behavior can produce the declared output data type.",
                column=column,
                path=f"{path}.source_type",
            )

        if column.data_type == "date" and not (column.format and column.format.date_format):
            ctx.add(
                "warning",
                "DATE_FORMAT_MISSING",
                f"Date column {column.name} has no output date format.",
                recommendation="Choose a date format so export formatting is deterministic.",
                column=column,
                path=f"{path}.format.date_format",
            )

        if column.data_type in {"dropdown", "multi_select"}:
            options = column.format.list_options if column.format else None
            if not _non_empty_list(options):
                severity: ValidationSeverity = "error" if column.required else "warning"
                ctx.add(
                    severity,
                    "DROPDOWN_OPTIONS_EMPTY",
                    f"{column.data_type.replace('_', ' ').title()} column {column.name} has no options.",
                    recommendation="Add the allowed option list or change the data type.",
                    column=column,
                    path=f"{path}.format.list_options",
                )

        if source_type == "fixed_value":
            if _is_blank(column.default_value):
                if not column.required:
                    ctx.add(
                        "warning",
                        "DEFAULT_VALUE_EMPTY",
                        f"Fixed value column {column.name} has an empty default value.",
                        recommendation="Enter the constant value or change the global behavior.",
                        column=column,
                        path=f"{path}.default_value",
                    )
            elif not _value_matches_data_type(column.default_value, column.data_type):
                ctx.add(
                    "warning",
                    "DATA_TYPE_SOURCE_INCOMPATIBLE",
                    f"Default value for {column.name} may not match data type {column.data_type}.",
                    recommendation="Check the fixed value against the column's output type.",
                    column=column,
                    path=f"{path}.default_value",
                )

        if (
            source_type == "manual_list"
            and not column.required
            and not _non_empty_list(column.manual_values)
        ):
            ctx.add(
                "warning",
                "DROPDOWN_OPTIONS_EMPTY",
                f"Manual list column {column.name} has no manual values.",
                recommendation="Add list values or choose another global behavior.",
                column=column,
                path=f"{path}.manual_values",
            )

        # Phase A — operator-selected manual_list default sanity check.
        #
        # When the wizard's "Default selected" picker writes
        # `default_value` for a manual_list column, the value MUST be
        # one of the configured `manual_values`. Otherwise the resolver
        # falls through to the manual_review path (the default cannot
        # be applied) and the operator is left with a silent mismatch.
        # Surface it here as a warning so it shows up in Validate +
        # the Column Inspector readiness without blocking save.
        #
        # Comparison normalization mirrors the resolver (strip
        # whitespace, case-sensitive). Only fires when BOTH
        # `default_value` and `manual_values` are populated — empty
        # `manual_values` is already covered by DROPDOWN_OPTIONS_EMPTY,
        # and an empty `default_value` is the expected "no selection"
        # state.
        if (
            source_type == "manual_list"
            and isinstance(column.default_value, str)
            and column.default_value.strip()
            and _non_empty_list(column.manual_values)
        ):
            default_clean = column.default_value.strip()
            available = {
                value.strip()
                for value in (column.manual_values or [])
                if isinstance(value, str) and value.strip()
            }
            if default_clean not in available:
                ctx.add(
                    "warning",
                    "MANUAL_LIST_DEFAULT_NOT_IN_LIST",
                    (
                        f"Manual list column {column.name} has a default "
                        f"value '{column.default_value}' that is not one "
                        "of the allowed manual values."
                    ),
                    recommendation=(
                        "Pick one of the allowed values as the default, "
                        "or clear the default selection."
                    ),
                    column=column,
                    path=f"{path}.default_value",
                )

        if source_type == INVOICE_SOURCE_TYPE:
            _validate_invoice_source_ref(column, ctx, f"{path}.source_ref")

        if source_type in CATALOG_SOURCE_TYPES:
            await _validate_catalog_source_ref(column, ctx, f"{path}.source_ref")


async def _validate_rules(parsed: ParsedTemplate, ctx: ValidationContext) -> None:
    column_by_id = {column.id: column for column in parsed.columns}

    for rule_idx, rule in enumerate(parsed.rules):
        path = f"rules[{rule_idx}]"

        if rule.lock_position or rule.lock_editing:
            locks = []
            if rule.lock_position:
                locks.append("position")
            if rule.lock_editing:
                locks.append("editing")
            ctx.add(
                "info",
                "RULE_LOCKED",
                f"Rule {rule_idx + 1} has {', '.join(locks)} lock enabled.",
                rule=rule,
                path=path,
            )

        has_condition_or_restriction = False
        has_action = False
        has_any_data = False

        for cell_key, cell in rule.cells.items():
            column = column_by_id.get(cell_key)
            cell_path = f"{path}.cells.{cell_key}"
            if column is None:
                ctx.add(
                    "error",
                    "RULE_CELL_UNKNOWN_COLUMN",
                    f"Rule {rule_idx + 1} contains a cell for missing column {cell_key}.",
                    recommendation="Remove the orphan cell by opening and saving the template, or recreate the missing column.",
                    rule=rule,
                    cell_key=cell_key,
                    path=cell_path,
                )
                continue

            cell_has_data = _cell_has_data(cell)
            has_any_data = has_any_data or cell_has_data
            role = _effective_role(cell, column)

            if role in {"condition", "restriction"} and cell_has_data:
                has_condition_or_restriction = True
            if role == "action" and cell_has_data:
                has_action = True

            if role == "condition" and not cell_has_data:
                ctx.add(
                    "warning",
                    "CONDITION_CELL_EMPTY",
                    f"Condition cell for {column.name} is empty.",
                    recommendation="Add a value or clear the condition role for that cell.",
                    column=column,
                    rule=rule,
                    cell_key=cell_key,
                    path=cell_path,
                )

            if role == "action" and not column.allow_rule_override and cell_has_data:
                ctx.add(
                    "warning",
                    "RULE_ACTION_IGNORED_BY_GLOBAL_OVERRIDE",
                    f"FILL/action cell under {column.name} contains data but the column prevents rule overrides.",
                    recommendation="Enable rule override for the column, or clear the FILL/action value if the global behavior should always win.",
                    column=column,
                    rule=rule,
                    cell_key=cell_key,
                    path=cell_path,
                )

            if column.source_type == INVOICE_SOURCE_TYPE:
                await _validate_cell_extraction_bindings(
                    cell,
                    ctx,
                    column=column,
                    rule=rule,
                    cell_key=cell_key,
                    path=cell_path,
                )

            if column.source_type in CATALOG_SOURCE_TYPES:
                await _validate_cell_catalog_selections(
                    cell,
                    column,
                    ctx,
                    rule=rule,
                    cell_key=cell_key,
                    path=cell_path,
                )

        if rule.is_active and has_any_data and has_action and not has_condition_or_restriction:
            ctx.add(
                "warning",
                "RULE_ACTION_WITHOUT_CONDITION",
                f"Rule {rule_idx + 1} has action cells but no condition or restriction cells.",
                recommendation="Add an IF/LIMIT cell if the action should not apply broadly.",
                rule=rule,
                path=path,
            )


async def _validate_required_columns(
    parsed: ParsedTemplate, ctx: ValidationContext
) -> None:
    for column_idx, column in enumerate(parsed.columns):
        if not column.required:
            continue

        source_type = column.source_type or "empty"
        path = f"columns[{column_idx}]"
        has_rule_action = _has_rule_action_for_column(column, parsed.rules)

        if source_type == "empty" and not has_rule_action:
            ctx.add(
                "error",
                "REQUIRED_COLUMN_NO_SOURCE",
                f"Required column {column.name} has no usable source.",
                recommendation="Assign a fixed default, catalog binding, extracted invoice field, or rule action.",
                column=column,
                path=path,
            )
            continue

        if source_type == "fixed_value" and _is_blank(column.default_value):
            ctx.add(
                "error",
                "REQUIRED_COLUMN_EMPTY_DEFAULT",
                f"Required fixed-value column {column.name} has an empty default.",
                recommendation="Enter a fixed default value.",
                column=column,
                path=f"{path}.default_value",
            )

        if source_type == "manual_list" and not _non_empty_list(column.manual_values):
            ctx.add(
                "error",
                "REQUIRED_COLUMN_NO_SOURCE",
                f"Required manual-list column {column.name} has no values.",
                recommendation="Add manual list values or choose another source.",
                column=column,
                path=f"{path}.manual_values",
            )

        if source_type == INVOICE_SOURCE_TYPE:
            has_specific_binding = _has_complete_extraction_binding_for_column(
                column, parsed.rules
            )
            if (
                column.source_ref is None or _is_blank(column.source_ref.field)
            ) and not has_specific_binding:
                ctx.add(
                    "error",
                    "REQUIRED_COLUMN_NO_SOURCE",
                    f"Required invoice field column {column.name} is missing an extracted field.",
                    recommendation="Choose the extracted invoice field this column should read.",
                    column=column,
                    path=f"{path}.source_ref.field",
                )
            elif (
                column.source_ref is None or _is_blank(column.source_ref.field)
            ) and has_specific_binding:
                ctx.add(
                    "warning",
                    "REQUIRED_INVOICE_FIELD_RULE_ONLY",
                    f"Required invoice field column {column.name} relies on rule-specific extraction bindings only.",
                    recommendation="Add a global extracted field if this column should also support broad fallback.",
                    column=column,
                    path=path,
                )
            elif not has_specific_binding:
                ctx.add(
                    "warning",
                    "REQUIRED_INVOICE_FIELD_BROAD_FALLBACK",
                    f"Required invoice field column {column.name} has no rule-specific extraction binding.",
                    recommendation="This is allowed as broad-universe fallback, but add pattern bindings when the field should come from known layouts.",
                    column=column,
                    path=path,
                )
            if not await ctx.has_any_invoice_pattern():
                ctx.add(
                    "warning",
                    "REQUIRED_INVOICE_FIELD_NO_PATTERNS",
                    f"Required invoice field column {column.name} has no saved Invoice Builder patterns to draw from.",
                    recommendation="Create Invoice Builder patterns or rely on later OCR/heuristic fallback.",
                    column=column,
                    path=path,
                )

        if source_type in CATALOG_SOURCE_TYPES:
            source_ref = column.source_ref
            kind = CATALOG_KIND_BY_SOURCE[source_type]
            if source_ref is None or _is_blank(source_ref.catalog_id):
                ctx.add(
                    "error",
                    "REQUIRED_COLUMN_CATALOG_MISSING",
                    f"Required catalog-backed column {column.name} has no {kind} catalog selected.",
                    recommendation="Choose the specific saved catalog this column should use.",
                    column=column,
                    path=f"{path}.source_ref.catalog_id",
                )
            if source_ref is None or _is_blank(source_ref.field):
                ctx.add(
                    "error",
                    "REQUIRED_COLUMN_CATALOG_FIELD_MISSING",
                    f"Required catalog-backed column {column.name} has no {kind} field selected.",
                    recommendation="Choose the catalog field this column should emit or match.",
                    column=column,
                    path=f"{path}.source_ref.field",
                )


async def _validate_catalog_source_ref(
    column: InvoiceTemplateColumn, ctx: ValidationContext, path: str
) -> None:
    source_type = column.source_type or "empty"
    kind = CATALOG_KIND_BY_SOURCE[source_type]
    source_ref = column.source_ref

    if source_ref is None:
        ctx.add(
            "error",
            "SOURCE_CATALOG_ID_MISSING",
            f"Catalog-backed column {column.name} has no source reference.",
            recommendation="Choose a catalog and field for this column.",
            column=column,
            path=path,
        )
        return

    if _is_blank(source_ref.catalog_id):
        ctx.add(
            "error",
            "SOURCE_CATALOG_ID_MISSING",
            f"Column {column.name} is missing a {kind} catalog id.",
            recommendation="Select a specific saved catalog.",
            column=column,
            path=f"{path}.catalog_id",
        )
    if _is_blank(source_ref.field):
        ctx.add(
            "error",
            "SOURCE_CATALOG_FIELD_MISSING",
            f"Column {column.name} is missing a {kind} catalog field.",
            recommendation="Select the catalog field this column should use.",
            column=column,
            path=f"{path}.field",
        )

    if source_ref.field and not _catalog_field_exists(kind, source_ref.field):
        ctx.add(
            "error",
            "CATALOG_FIELD_NOT_FOUND",
            f"Column {column.name} references unknown {kind} catalog field {source_ref.field}.",
            recommendation="Pick one of the canonical fields for that catalog type.",
            column=column,
            path=f"{path}.field",
            related_id=source_ref.field,
            related_type=f"{kind}_field",
        )

    if source_ref.catalog_id:
        catalog = await ctx.get_catalog(kind, source_ref.catalog_id)
        if catalog is None:
            ctx.add(
                "error",
                "CATALOG_NOT_FOUND",
                f"Column {column.name} references a missing {kind} catalog.",
                recommendation="Rebind the column to an existing catalog.",
                column=column,
                path=f"{path}.catalog_id",
                related_id=source_ref.catalog_id,
                related_type=f"{kind}_catalog",
            )
        elif source_ref.catalog_label and source_ref.catalog_label != catalog.name:
            ctx.add(
                "info",
                "CATALOG_LABEL_STALE",
                f"Column {column.name} cached catalog label {source_ref.catalog_label!r}, but the live catalog is {catalog.name!r}.",
                recommendation="No action is required; the catalog id still resolves.",
                column=column,
                path=f"{path}.catalog_label",
                related_id=source_ref.catalog_id,
                related_type=f"{kind}_catalog",
            )


def _validate_invoice_source_ref(
    column: InvoiceTemplateColumn, ctx: ValidationContext, path: str
) -> None:
    source_ref = column.source_ref
    if source_ref is None or _is_blank(source_ref.field):
        ctx.add(
            "warning",
            "SOURCE_FIELD_KEY_UNKNOWN",
            f"Column {column.name} is set to extracted invoice but no field is selected.",
            recommendation="Choose a canonical extracted field or leave it broad intentionally.",
            column=column,
            path=path,
        )
        return

    field_key = source_ref.field or ""
    normalized = normalize_extracted_field_key(field_key)
    if normalized != field_key:
        ctx.add(
            "info",
            "LEGACY_FIELD_ALIAS_NORMALIZED",
            f"Legacy field key {field_key} normalizes to {normalized}.",
            recommendation="Existing templates keep loading; save later if you want to persist canonical keys.",
            column=column,
            path=f"{path}.field",
            related_id=normalized,
            related_type="extracted_invoice_field",
        )
    if not is_known_extracted_field_key(field_key):
        ctx.add(
            "warning",
            "SOURCE_FIELD_KEY_UNKNOWN",
            f"Column {column.name} references unknown extracted field {field_key}.",
            recommendation="Confirm this is a pattern-specific custom field or choose a canonical extracted field.",
            column=column,
            path=f"{path}.field",
            related_id=field_key,
            related_type="extracted_invoice_field",
        )


async def _validate_cell_extraction_bindings(
    cell: InvoiceTemplateRuleCell,
    ctx: ValidationContext,
    *,
    column: InvoiceTemplateColumn,
    rule: InvoiceTemplateRule,
    cell_key: str,
    path: str,
) -> None:
    bindings = list(cell.extraction_bindings or [])
    if cell.extraction is not None:
        _validate_legacy_extraction_divergence(cell, ctx, column, rule, cell_key, path)

    seen: set[tuple[str, str]] = set()
    for idx, binding in enumerate(bindings):
        binding_path = f"{path}.extraction_bindings[{idx}]"
        await _validate_single_extraction_binding(
            binding,
            ctx,
            column=column,
            rule=rule,
            cell_key=cell_key,
            path=binding_path,
            seen=seen,
        )


async def _validate_single_extraction_binding(
    binding: RuleCellExtractionBinding | RuleCellExtraction,
    ctx: ValidationContext,
    *,
    column: InvoiceTemplateColumn,
    rule: InvoiceTemplateRule,
    cell_key: str,
    path: str,
    seen: set[tuple[str, str]],
) -> None:
    pattern_id = binding.pattern_id
    field_key = binding.field_key

    if bool(pattern_id) != bool(field_key):
        ctx.add(
            "warning",
            "EXTRACTION_BINDING_PARTIAL",
            f"Extraction binding for {column.name} is incomplete.",
            recommendation="Choose both a pattern and a field, or clear the partial binding.",
            column=column,
            rule=rule,
            cell_key=cell_key,
            path=path,
        )
        return

    if not pattern_id and not field_key:
        return

    normalized_field = normalize_extracted_field_key(field_key)
    if normalized_field != field_key:
        ctx.add(
            "info",
            "LEGACY_FIELD_ALIAS_NORMALIZED",
            f"Legacy field key {field_key} normalizes to {normalized_field}.",
            recommendation="Validation compares the canonical key while preserving the saved value.",
            column=column,
            rule=rule,
            cell_key=cell_key,
            path=f"{path}.field_key",
            related_id=normalized_field,
            related_type="extracted_invoice_field",
        )

    duplicate_key = (pattern_id or "", normalized_field or field_key or "")
    if duplicate_key in seen:
        ctx.add(
            "warning",
            "EXTRACTION_BINDING_DUPLICATE",
            f"Duplicate extraction binding for pattern {pattern_id} and field {field_key}.",
            recommendation="Remove the duplicate binding to keep resolution order clear.",
            column=column,
            rule=rule,
            cell_key=cell_key,
            path=path,
            related_id=pattern_id,
            related_type="invoice_pattern",
        )
    seen.add(duplicate_key)

    pattern = await ctx.get_pattern(pattern_id)
    if pattern is None:
        ctx.add(
            "error",
            "INVOICE_PATTERN_NOT_FOUND",
            f"Extraction binding for {column.name} references a missing invoice pattern.",
            recommendation="Rebind the cell to an existing Invoice Builder pattern or clear the stale binding.",
            column=column,
            rule=rule,
            cell_key=cell_key,
            path=f"{path}.pattern_id",
            related_id=pattern_id,
            related_type="invoice_pattern",
        )
        return

    if not ctx.pattern_has_non_deleted_page(pattern):
        ctx.add(
            "warning",
            "INVOICE_PATTERN_NO_VISIBLE_PAGES",
            f"Invoice pattern {pattern.name} has no non-deleted pages.",
            recommendation="Restore a source page or choose another pattern.",
            column=column,
            rule=rule,
            cell_key=cell_key,
            path=f"{path}.pattern_id",
            related_id=pattern_id,
            related_type="invoice_pattern",
        )

    options = ctx.field_options_for(pattern)
    option = options.get(field_key or "") or options.get(normalized_field or "")
    if option is None:
        ctx.add(
            "error",
            "INVOICE_FIELD_NOT_FOUND",
            f"Field {field_key} does not exist on invoice pattern {pattern.name}.",
            recommendation="Choose a visible field from the selected pattern.",
            column=column,
            rule=rule,
            cell_key=cell_key,
            path=f"{path}.field_key",
            related_id=field_key,
            related_type="invoice_pattern_field",
        )
        return

    if option.hidden:
        ctx.add(
            "warning",
            "INVOICE_FIELD_HIDDEN",
            f"Field {option.label} on pattern {pattern.name} is hidden.",
            recommendation="Unhide the field or confirm this binding should still use it.",
            column=column,
            rule=rule,
            cell_key=cell_key,
            path=f"{path}.field_key",
            related_id=option.key,
            related_type="invoice_pattern_field",
        )

    if option.region_count == 0:
        ctx.add(
            "warning",
            "INVOICE_FIELD_NO_REGIONS",
            f"Field {option.label} on pattern {pattern.name} has no drawn regions.",
            recommendation="Draw at least one region in Invoice Builder or rely on broad OCR fallback.",
            column=column,
            rule=rule,
            cell_key=cell_key,
            path=f"{path}.field_key",
            related_id=option.key,
            related_type="invoice_pattern_field",
        )


def _validate_legacy_extraction_divergence(
    cell: InvoiceTemplateRuleCell,
    ctx: ValidationContext,
    column: InvoiceTemplateColumn,
    rule: InvoiceTemplateRule,
    cell_key: str,
    path: str,
) -> None:
    legacy = cell.extraction
    if legacy is None or not cell.extraction_bindings:
        return
    legacy_pair = (
        legacy.pattern_id or "",
        normalize_extracted_field_key(legacy.field_key) or legacy.field_key or "",
    )
    binding_pairs = {
        (
            binding.pattern_id or "",
            normalize_extracted_field_key(binding.field_key)
            or binding.field_key
            or "",
        )
        for binding in cell.extraction_bindings
    }
    if legacy_pair not in binding_pairs:
        ctx.add(
            "warning",
            "LEGACY_EXTRACTION_DIVERGENCE",
            f"Legacy extraction binding on {column.name} differs from extraction_bindings.",
            recommendation="Review the cell and save it after confirming the intended pattern/field bindings.",
            column=column,
            rule=rule,
            cell_key=cell_key,
            path=f"{path}.extraction",
        )


async def _validate_cell_catalog_selections(
    cell: InvoiceTemplateRuleCell,
    column: InvoiceTemplateColumn,
    ctx: ValidationContext,
    *,
    rule: InvoiceTemplateRule,
    cell_key: str,
    path: str,
) -> None:
    if not cell.selections:
        return
    source_ref = column.source_ref
    source_type = column.source_type or "empty"
    kind = CATALOG_KIND_BY_SOURCE[source_type]
    if source_ref is None or _is_blank(source_ref.catalog_id):
        return
    catalog = await ctx.get_catalog(kind, source_ref.catalog_id)
    if catalog is None:
        return

    entries_by_id = {
        str(entry.get("id")): entry
        for entry in (catalog.entries or [])
        if isinstance(entry, dict) and entry.get("id") is not None
    }
    for idx, selection in enumerate(cell.selections):
        entry = entries_by_id.get(selection.entry_id)
        selection_path = f"{path}.selections[{idx}]"
        if entry is None:
            ctx.add(
                "error",
                "CATALOG_ENTRY_NOT_FOUND",
                f"Rule cell under {column.name} references a missing {kind} catalog entry.",
                recommendation="Remove the stale selection or pick a current catalog entry.",
                column=column,
                rule=rule,
                cell_key=cell_key,
                path=selection_path,
                related_id=selection.entry_id,
                related_type=f"{kind}_catalog_entry",
            )
            continue
        if source_ref.field:
            live_value = _entry_field_value(kind, entry, source_ref.field)
            if live_value is not None and str(live_value) != selection.field_value:
                ctx.add(
                    "info",
                    "CATALOG_LABEL_STALE",
                    f"Rule cell under {column.name} cached {selection.field_value!r}, but the live catalog value is {live_value!r}.",
                    recommendation="No action is required unless the cached value should be refreshed.",
                    column=column,
                    rule=rule,
                    cell_key=cell_key,
                    path=selection_path,
                    related_id=selection.entry_id,
                    related_type=f"{kind}_catalog_entry",
                )


def _flag_duplicates(
    values: list[Any],
    ctx: ValidationContext,
    *,
    code: str,
    message: str,
    recommendation: str,
    path_prefix: str,
) -> None:
    counts = Counter(v for v in values if v not in (None, ""))
    for value, count in counts.items():
        if count <= 1:
            continue
        ctx.add(
            "error",
            code,
            message.format(value=value),
            recommendation=recommendation,
            path=path_prefix,
            related_id=str(value),
        )


def _safe_attr_or_key(raw: Any, key: str) -> Any:
    if isinstance(raw, dict):
        return raw.get(key)
    return getattr(raw, key, None)


def _parse_uuid(value: str | None) -> UUID | None:
    if _is_blank(value):
        return None
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def _parse_pattern_items(items: list[Any], model: type[Any]) -> list[Any]:
    parsed: list[Any] = []
    for item in items:
        try:
            parsed.append(model.model_validate(item))
        except Exception:
            continue
    return parsed


def _is_blank(value: Any) -> bool:
    return value is None or str(value).strip() == ""


def _non_empty_list(values: list[str] | None) -> bool:
    return any(str(value).strip() for value in values or [])


def _value_matches_data_type(value: str | None, data_type: str) -> bool:
    if _is_blank(value):
        return False
    text = str(value).strip()
    if data_type in {"text", "dropdown", "multi_select"}:
        return True
    if data_type in {"number", "currency"}:
        try:
            Decimal(text.replace(",", "").replace("$", ""))
            return True
        except (InvalidOperation, ValueError):
            return False
    if data_type == "boolean":
        return text.lower() in {"true", "false", "yes", "no", "1", "0"}
    if data_type == "date":
        return any(char.isdigit() for char in text)
    return True


def _cell_has_data(cell: InvoiceTemplateRuleCell) -> bool:
    return (
        _non_empty_list(cell.values)
        or bool(cell.selections)
        or bool(cell.extraction_bindings)
        or cell.extraction is not None
    )


def _effective_role(
    cell: InvoiceTemplateRuleCell, column: InvoiceTemplateColumn
) -> RuleRole | None:
    return effective_rule_cell_role(cell, column)


def _has_rule_action_for_column(
    column: InvoiceTemplateColumn, rules: list[InvoiceTemplateRule]
) -> bool:
    for rule in rules:
        if not rule.is_active:
            continue
        cell = rule.cells.get(column.id)
        if cell is None or not _cell_has_data(cell):
            continue
        if _effective_role(cell, column) == "action":
            return True
    return False


def _has_complete_extraction_binding_for_column(
    column: InvoiceTemplateColumn, rules: list[InvoiceTemplateRule]
) -> bool:
    for rule in rules:
        cell = rule.cells.get(column.id)
        if cell is None:
            continue
        bindings = list(cell.extraction_bindings or [])
        if cell.extraction is not None:
            bindings.append(cell.extraction)
        for binding in bindings:
            if not _is_blank(binding.pattern_id) and not _is_blank(binding.field_key):
                return True
    return False


def _catalog_field_exists(kind: str, field: str) -> bool:
    return field in CATALOG_FIELDS[kind]


def _entry_field_value(kind: str, entry: dict[str, Any], field: str) -> Any | None:
    real_field = CATALOG_FIELD_ALIASES.get(kind, {}).get(field, field)
    return entry.get(real_field)
