"""Dry-run contract implementation for the future Import Builder resolver.

The dry-run endpoint accepts optional ResolverInput context, loads the
saved Import Builder template, and returns one inspectable ResolverResult
without mutating persisted template data. It currently resolves
column-level baselines, deterministic catalog hints, IF/LIMIT rule
eligibility, and same-column FILL/action candidates from provided facts
or authored rule values. It deliberately does not export, enqueue review
work, call OCR/AI, fetch PDFs, or perform cross-column actions.

Status priority is blocked > conflict > needs_review > ready. Readiness
validation issues and runtime dry-run issues are both returned so the UI
can separate authoring readiness from row-level resolution behavior.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.extracted_invoice_fields import normalize_extracted_field_key
from app.models.invoice_template import InvoiceTemplate
from app.repositories.gl_catalog_repo import GLCatalogRepository
from app.repositories.property_catalog_repo import PropertyCatalogRepository
from app.repositories.vendor_catalog_repo import VendorCatalogRepository
from app.schemas.import_resolver import (
    CatalogHint,
    CellProvenance,
    ExtractedFact,
    MatchedRuleResult,
    ResolvedCellSourceType,
    ResolvedImportCell,
    ResolvedImportRow,
    ResolverInput,
    ResolverIssue,
    ResolverResult,
    ResolverStatus,
    ResolverSummary,
    RuleConditionEvaluation,
    RuleRestrictionEvaluation,
)
from app.schemas.invoice_template import (
    ImportTemplateValidationIssue,
    ColumnFormat,
    InvoiceTemplateColumn,
    InvoiceTemplateRule,
    InvoiceTemplateRuleCell,
    effective_rule_cell_role,
)
from app.services.import_template_validation import validate_import_template


CATALOG_SOURCE_TYPES = {"vendor_field", "property_field", "gl_field"}
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
    "gl": {"gl_code": "code", "account_code": "code", "account_name": "description"},
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
    "gl": {"gl_code", "code", "account_code", "description", "account_name", "category", "active", "notes"},
}
CATALOG_MATCH_FIELDS: dict[str, tuple[str, ...]] = {
    "vendor": (
        "vendor_name",
        "company",
        "name",
        "vendor",
        "company_abbreviation",
        "abbreviation",
    ),
    "property": (
        "property_code",
        "property_name",
        "property_abbreviation",
        "address",
    ),
    "gl": ("code", "gl_code", "account_code", "description", "account_name"),
}
CATALOG_ALIAS_FIELDS: dict[str, tuple[str, ...]] = {
    "vendor": ("aliases", "alternate_names", "alternate_vendor_names"),
    "property": (),
    "gl": (),
}
DEFAULT_FACT_CONFIDENCE: dict[str, float] = {
    "manual": 1.0,
    "invoice_pattern": 0.9,
    "ocr": 0.7,
    "heuristic": 0.6,
    "ai": 0.4,
}

# Stable runtime issue-code inventory for the dry-run resolver. Readiness
# validation contributes its own codes from import_template_validation.py.
RESOLVER_RUNTIME_ISSUE_CODES: frozenset[str] = frozenset(
    {
        "BASELINE_VALUE_OVERRIDDEN_BY_RULE",
        "CATALOG_ENTRY_AMBIGUOUS",
        "CATALOG_ENTRY_NOT_FOUND",
        "CATALOG_FIELD_NOT_FOUND",
        "CATALOG_HINT_MISSING",
        "CATALOG_MATCHER_NOT_IMPLEMENTED",
        "CATALOG_NOT_CONFIGURED",
        "CATALOG_NOT_FOUND",
        "CATALOG_VALUE_MISSING",
        "COLUMN_INVALID_SCHEMA",
        "CONDITION_CELL_EMPTY",
        "CONDITION_NO_ACTUAL_VALUE",
        "CONDITION_NOT_MATCHED",
        "CONFLICTING_RULE_ACTION",
        "DATA_TYPE_COERCION_FAILED",
        "DATA_TYPE_UNKNOWN",
        "DERIVED_RESOLVER_NOT_IMPLEMENTED",
        "EXTRACTED_FACT_SOURCE_UNKNOWN",
        "FIXED_VALUE_EMPTY",
        "INVOICE_FIELD_FACT_NOT_FOUND",
        "MANUAL_VALUE_REQUIRED",
        "MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION",
        "NO_RULES_MATCHED",
        "READINESS_VALIDATION_NOT_RUN",
        "REQUIRED_RUNTIME_VALUE_MISSING",
        "RESOLVER_INPUT_TEMPLATE_ID_MISMATCH",
        "RESTRICTION_CELL_EMPTY",
        "RESTRICTION_NO_ACTUAL_VALUE",
        "RESTRICTION_NOT_MATCHED",
        "RULE_ACTION_APPLIED",
        "RULE_ACTION_COERCION_FAILED",
        "RULE_ACTION_IGNORED_BY_GLOBAL_OVERRIDE",
        "RULE_DISABLED_SKIPPED",
        "RULE_FILL_EXTRACTION_VALUE_NOT_FOUND",
        "RULE_FILL_MULTIPLE_VALUES",
        "RULE_FILL_VALUE_MISSING",
        "RULE_HAS_NO_CONDITIONS",
        "RULE_INVALID_SCHEMA",
        "RULE_RESTRICTED_OUT",
        "SOURCE_CATALOG_FIELD_MISSING",
        "VALUE_NOT_RESOLVED",
    }
)


@dataclass(frozen=True)
class ValueCoercion:
    normalized_value: Any | None
    formatted_value: str | None
    warnings: list[str]
    issue_codes: list[str]
    failed: bool = False


@dataclass(frozen=True)
class LoadedCatalog:
    kind: str
    catalog_id: str
    label: str | None
    entries: list[dict[str, Any]]


@dataclass(frozen=True)
class CatalogMatch:
    status: str
    entry: dict[str, Any] | None = None
    confidence: float | None = None
    detail: str | None = None


@dataclass(frozen=True)
class RuleFillCandidate:
    value: Any | None = None
    source_type: ResolvedCellSourceType = "rule_fill"
    confidence: float | None = None
    provenance: CellProvenance | None = None
    warnings: list[str] = field(default_factory=list)
    issue_codes: list[str] = field(default_factory=list)
    issues: list[ResolverIssue] = field(default_factory=list)
    apply_value: bool = False


async def dry_run_resolve_import_template(
    template: InvoiceTemplate,
    input_payload: ResolverInput | None = None,
    db: AsyncSession | None = None,
) -> ResolverResult:
    """Return a non-mutating placeholder resolver result.

    The path-loaded `template` is the source of truth. `input_payload`
    may provide extracted facts and document context, but this function
    never edits the template or persists any derived state.
    """

    payload = input_payload or ResolverInput(template_id=str(template.id))
    issues: list[ResolverIssue] = []

    if payload.template_id and payload.template_id != str(template.id):
        issues.append(
            ResolverIssue(
                severity="warning",
                code="RESOLVER_INPUT_TEMPLATE_ID_MISMATCH",
                scope="runtime",
                message=(
                    "Resolver input template_id does not match the path-loaded "
                    "template; the path-loaded template was used."
                ),
                recommendation="Omit template_id from the body or send the same id as the path.",
            )
    )

    columns = _parse_columns(template, issues)
    rules = _parse_rules(template, issues)

    if db is not None:
        readiness = await validate_import_template(template, db)
        issues.extend(_validation_issues_to_resolver(readiness.issues))
    else:
        issues.append(
            ResolverIssue(
                severity="info",
                code="READINESS_VALIDATION_NOT_RUN",
                scope="readiness",
                message="Readiness validation was not run because no database session was provided.",
                recommendation="Call the API endpoint or pass a database session for full readiness diagnostics.",
            )
        )

    fact_index = _build_fact_index(payload.extracted_facts)
    cells: list[ResolvedImportCell] = []
    for column in columns:
        cells.append(
            await _resolve_column_baseline(
                column,
                fact_index,
                catalog_hints=payload.catalog_hints,
                db=db,
            )
        )
    matched_rules, rule_issues = _evaluate_condition_rules(
        rules,
        columns,
        cells,
        payload,
        fact_index,
    )
    action_issues = _apply_rule_actions(
        rules=rules,
        matched_rules=matched_rules,
        columns=columns,
        cells=cells,
        fact_index=fact_index,
    )
    row_issues = _dedupe_issues([
        *rule_issues,
        *action_issues,
        *_row_runtime_issues(columns, cells),
    ])
    row_status = _row_status(cells, row_issues)
    row = ResolvedImportRow(
        row_index=0,
        status=row_status,
        cells=cells,
        issues=row_issues,
        matched_rules=matched_rules,
        confidence=_average_confidence(cells),
    )

    result_status = _combine_statuses([row.status], issues)
    all_issues = _dedupe_issues([*issues, *row_issues])
    return ResolverResult(
        template_id=str(template.id),
        template_name=template.name,
        status=result_status,
        rows=[row],
        issues=all_issues,
        summary=_build_summary([row], all_issues),
    )


def _parse_columns(
    template: InvoiceTemplate, issues: list[ResolverIssue]
) -> list[InvoiceTemplateColumn]:
    parsed: list[InvoiceTemplateColumn] = []
    for idx, raw_column in enumerate(template.columns or []):
        try:
            parsed.append(InvoiceTemplateColumn.model_validate(raw_column))
        except Exception as exc:
            issues.append(
                ResolverIssue(
                    severity="error",
                    code="COLUMN_INVALID_SCHEMA",
                    scope="runtime",
                    message=f"Column at position {idx + 1} cannot be read: {exc}",
                    recommendation="Open the template, review the column, and save it again after correcting malformed data.",
                    path=f"columns[{idx}]",
                )
            )
    return parsed


def _parse_rules(
    template: InvoiceTemplate, issues: list[ResolverIssue]
) -> list[InvoiceTemplateRule]:
    parsed: list[InvoiceTemplateRule] = []
    for idx, raw_rule in enumerate(getattr(template, "rules", None) or []):
        try:
            parsed.append(InvoiceTemplateRule.model_validate(_normalize_rule_aliases(raw_rule)))
        except Exception as exc:
            issues.append(
                ResolverIssue(
                    severity="error",
                    code="RULE_INVALID_SCHEMA",
                    scope="runtime",
                    message=f"Rule at position {idx + 1} cannot be read: {exc}",
                    recommendation="Open the template, review the rule, and save it again after correcting malformed data.",
                    path=f"rules[{idx}]",
                )
            )
    return parsed


def _normalize_rule_aliases(raw_rule: Any) -> Any:
    if not isinstance(raw_rule, dict):
        return raw_rule
    raw_cells = raw_rule.get("cells")
    if not isinstance(raw_cells, dict):
        return raw_rule

    next_cells: dict[str, Any] = {}
    changed = False
    for column_id, raw_cell in raw_cells.items():
        if not isinstance(raw_cell, dict):
            next_cells[column_id] = raw_cell
            continue
        role = raw_cell.get("role")
        normalized_role = _normalize_role_alias(role)
        if normalized_role != role:
            next_cell = dict(raw_cell)
            next_cell["role"] = normalized_role
            next_cells[column_id] = next_cell
            changed = True
        else:
            next_cells[column_id] = raw_cell

    if not changed:
        return raw_rule
    next_rule = dict(raw_rule)
    next_rule["cells"] = next_cells
    return next_rule


def _normalize_role_alias(role: Any) -> Any:
    if not isinstance(role, str):
        return role
    normalized = role.strip().lower()
    aliases = {
        "if": "condition",
        "condition": "condition",
        "limit": "restriction",
        "restriction": "restriction",
        "fill": "action",
        "action": "action",
    }
    return aliases.get(normalized, role)


def _build_fact_index(
    facts: list[ExtractedFact],
) -> dict[str, list[ExtractedFact]]:
    index: dict[str, list[ExtractedFact]] = {}
    for fact in facts:
        normalized = fact.normalized_field_key or normalize_extracted_field_key(
            fact.field_key
        )
        if not normalized:
            continue
        index.setdefault(normalized, []).append(fact)
    return index


def _evaluate_condition_rules(
    rules: list[InvoiceTemplateRule],
    columns: list[InvoiceTemplateColumn],
    cells: list[ResolvedImportCell],
    payload: ResolverInput,
    fact_index: dict[str, list[ExtractedFact]],
) -> tuple[list[MatchedRuleResult], list[ResolverIssue]]:
    column_by_id = {column.id: column for column in columns}
    cell_by_column_id = {cell.column_id: cell for cell in cells}
    results: list[MatchedRuleResult] = []
    row_issues: list[ResolverIssue] = []

    for idx, rule in enumerate(rules):
        rule_label = _rule_label(rule, idx)
        if not rule.is_active:
            issue = ResolverIssue(
                severity="info",
                code="RULE_DISABLED_SKIPPED",
                message=f"{rule_label} is disabled and was skipped during IF evaluation.",
                recommendation="Enable the rule if it should participate in resolver matching.",
                rule_id=rule.id,
                rule_label=rule_label,
            )
            results.append(
                MatchedRuleResult(
                    rule_id=rule.id,
                    rule_label=rule_label,
                    matched=False,
                    skipped=True,
                    skip_reason="Rule is disabled.",
                    issues=[issue],
                )
            )
            row_issues.append(issue)
            continue

        condition_evaluations: list[RuleConditionEvaluation] = []
        rule_issues: list[ResolverIssue] = []
        for column_id, cell in rule.cells.items():
            column = column_by_id.get(column_id)
            if column is None:
                continue
            role = effective_rule_cell_role(cell, column)
            if _condition_role(role) != "condition":
                continue
            evaluation, condition_issues = _evaluate_condition_cell(
                rule=rule,
                rule_label=rule_label,
                cell=cell,
                column=column,
                baseline_cell=cell_by_column_id.get(column.id),
                payload=payload,
                fact_index=fact_index,
            )
            condition_evaluations.append(evaluation)
            rule_issues.extend(condition_issues)

        if not condition_evaluations:
            issue = ResolverIssue(
                severity="warning",
                code="RULE_HAS_NO_CONDITIONS",
                message=f"{rule_label} has no IF/condition cells and matches broadly.",
                recommendation="Add at least one IF/condition cell if this rule should only apply to specific invoices.",
                rule_id=rule.id,
                rule_label=rule_label,
            )
            restriction_evaluations, restriction_issues = _evaluate_restrictions_for_rule(
                rule=rule,
                rule_label=rule_label,
                column_by_id=column_by_id,
                cell_by_column_id=cell_by_column_id,
                payload=payload,
                fact_index=fact_index,
            )
            restrictions_failed = _restriction_failure_count(restriction_evaluations)
            restricted_out = restrictions_failed > 0
            if restricted_out:
                restricted_issue = _rule_restricted_out_issue(rule, rule_label)
                restriction_issues.append(restricted_issue)
            result = MatchedRuleResult(
                rule_id=rule.id,
                rule_label=rule_label,
                matched=True,
                condition_count=0,
                conditions_passed=0,
                conditions_failed=0,
                restriction_count=len(restriction_evaluations),
                restrictions_passed=len(restriction_evaluations) - restrictions_failed,
                restrictions_failed=restrictions_failed,
                restricted_out=restricted_out,
                eligible_for_actions=not restricted_out,
                issues=[issue, *restriction_issues],
                restrictions=restriction_evaluations,
            )
            results.append(result)
            row_issues.append(issue)
            row_issues.extend(restriction_issues)
            continue

        failed = [
            evaluation
            for evaluation in condition_evaluations
            if "CONDITION_NOT_MATCHED" in evaluation.issue_codes
        ]
        matched = len(failed) == 0
        restriction_evaluations: list[RuleRestrictionEvaluation] = []
        restriction_issues: list[ResolverIssue] = []
        restrictions_failed = 0
        restricted_out = False
        if matched:
            restriction_evaluations, restriction_issues = _evaluate_restrictions_for_rule(
                rule=rule,
                rule_label=rule_label,
                column_by_id=column_by_id,
                cell_by_column_id=cell_by_column_id,
                payload=payload,
                fact_index=fact_index,
            )
            restrictions_failed = _restriction_failure_count(restriction_evaluations)
            restricted_out = restrictions_failed > 0
            if restricted_out:
                restriction_issues.append(_rule_restricted_out_issue(rule, rule_label))

        result = MatchedRuleResult(
            rule_id=rule.id,
            rule_label=rule_label,
            matched=matched,
            condition_count=len(condition_evaluations),
            conditions_passed=len(condition_evaluations) - len(failed),
            conditions_failed=len(failed),
            restriction_count=len(restriction_evaluations),
            restrictions_passed=len(restriction_evaluations) - restrictions_failed,
            restrictions_failed=restrictions_failed,
            restricted_out=restricted_out,
            eligible_for_actions=matched and not restricted_out,
            issues=[*rule_issues, *restriction_issues],
            matched_conditions=condition_evaluations,
            restrictions=restriction_evaluations,
        )
        results.append(result)
        row_issues.extend(rule_issues)
        row_issues.extend(restriction_issues)

    active_results = [result for result in results if not result.skipped]
    if rules and active_results and not any(result.matched for result in active_results):
        row_issues.append(
            ResolverIssue(
                severity="warning",
                code="NO_RULES_MATCHED",
                message="No active Import Builder rules matched this dry-run input.",
                recommendation="Review IF conditions or provide resolver input that represents the invoice being tested.",
            )
        )
    elif rules and not active_results:
        row_issues.append(
            ResolverIssue(
                severity="info",
                code="NO_RULES_MATCHED",
                message="No rules matched because every rule was skipped.",
                recommendation="Enable at least one rule if this template should use rule matching.",
            )
        )

    return results, row_issues


def _evaluate_condition_cell(
    *,
    rule: InvoiceTemplateRule,
    rule_label: str,
    cell: InvoiceTemplateRuleCell,
    column: InvoiceTemplateColumn,
    baseline_cell: ResolvedImportCell | None,
    payload: ResolverInput,
    fact_index: dict[str, list[ExtractedFact]],
) -> tuple[RuleConditionEvaluation, list[ResolverIssue]]:
    expected_values = _condition_expected_values(cell)
    actual_values = _condition_actual_values(
        column=column,
        baseline_cell=baseline_cell,
        payload=payload,
        fact_index=fact_index,
    )
    issues: list[ResolverIssue] = []
    role = _condition_role(effective_rule_cell_role(cell, column)) or "condition"

    if not expected_values:
        issue = ResolverIssue(
            severity="warning",
            code="CONDITION_CELL_EMPTY",
            message=f"{rule_label} condition cell for {column.name} has no expected values and was ignored.",
            recommendation="Add a value to the IF cell, or change its role if it should not participate in matching.",
            column_id=column.id,
            column_label=column.name,
            rule_id=rule.id,
            rule_label=rule_label,
        )
        issues.append(issue)
        return (
            RuleConditionEvaluation(
                column_id=column.id,
                column_label=column.name,
                rule_id=rule.id,
                role=role,
                expected_values=[],
                actual_values=actual_values,
                matched=True,
                match_reason="Blank IF cell ignored.",
                source_type=column.source_type,
                issue_codes=["CONDITION_CELL_EMPTY"],
            ),
            issues,
        )

    if not actual_values:
        issue = ResolverIssue(
            severity="warning",
            code="CONDITION_NO_ACTUAL_VALUE",
            message=f"{rule_label} condition cell for {column.name} had no actual value to compare.",
            recommendation="Provide matching resolver input, extracted facts, catalog hints, or a baseline value for this column.",
            column_id=column.id,
            column_label=column.name,
            rule_id=rule.id,
            rule_label=rule_label,
        )
        issues.append(issue)
        return (
            RuleConditionEvaluation(
                column_id=column.id,
                column_label=column.name,
                rule_id=rule.id,
                role=role,
                expected_values=expected_values,
                actual_values=[],
                matched=False,
                match_reason="No actual value available.",
                source_type=column.source_type,
                issue_codes=["CONDITION_NO_ACTUAL_VALUE", "CONDITION_NOT_MATCHED"],
            ),
            issues,
        )

    matched_expected, matched_actual = _match_any_condition_value(
        expected_values, actual_values
    )
    if matched_expected is not None:
        return (
            RuleConditionEvaluation(
                column_id=column.id,
                column_label=column.name,
                rule_id=rule.id,
                role=role,
                expected_values=expected_values,
                actual_values=actual_values,
                matched=True,
                match_reason=f"{matched_expected!r} matched {matched_actual!r}.",
                source_type=column.source_type,
                issue_codes=["CONDITION_MATCHED"],
            ),
            issues,
        )

    issue = ResolverIssue(
        severity="info",
        code="CONDITION_NOT_MATCHED",
        message=f"{rule_label} condition cell for {column.name} did not match.",
        recommendation=None,
        column_id=column.id,
        column_label=column.name,
        rule_id=rule.id,
        rule_label=rule_label,
    )
    issues.append(issue)
    return (
        RuleConditionEvaluation(
            column_id=column.id,
            column_label=column.name,
            rule_id=rule.id,
            role=role,
            expected_values=expected_values,
            actual_values=actual_values,
            matched=False,
            match_reason="No exact normalized match.",
            source_type=column.source_type,
            issue_codes=["CONDITION_NOT_MATCHED"],
        ),
        issues,
    )


def _evaluate_restrictions_for_rule(
    *,
    rule: InvoiceTemplateRule,
    rule_label: str,
    column_by_id: dict[str, InvoiceTemplateColumn],
    cell_by_column_id: dict[str, ResolvedImportCell],
    payload: ResolverInput,
    fact_index: dict[str, list[ExtractedFact]],
) -> tuple[list[RuleRestrictionEvaluation], list[ResolverIssue]]:
    evaluations: list[RuleRestrictionEvaluation] = []
    issues: list[ResolverIssue] = []
    for column_id, cell in rule.cells.items():
        column = column_by_id.get(column_id)
        if column is None:
            continue
        role = effective_rule_cell_role(cell, column)
        if _restriction_role(role) != "restriction":
            continue
        evaluation, restriction_issues = _evaluate_restriction_cell(
            rule=rule,
            rule_label=rule_label,
            cell=cell,
            column=column,
            baseline_cell=cell_by_column_id.get(column.id),
            payload=payload,
            fact_index=fact_index,
        )
        evaluations.append(evaluation)
        issues.extend(restriction_issues)
    return evaluations, issues


def _evaluate_restriction_cell(
    *,
    rule: InvoiceTemplateRule,
    rule_label: str,
    cell: InvoiceTemplateRuleCell,
    column: InvoiceTemplateColumn,
    baseline_cell: ResolvedImportCell | None,
    payload: ResolverInput,
    fact_index: dict[str, list[ExtractedFact]],
) -> tuple[RuleRestrictionEvaluation, list[ResolverIssue]]:
    expected_values = _condition_expected_values(cell)
    actual_values = _condition_actual_values(
        column=column,
        baseline_cell=baseline_cell,
        payload=payload,
        fact_index=fact_index,
    )
    role = _restriction_role(effective_rule_cell_role(cell, column)) or "restriction"
    issues: list[ResolverIssue] = []

    if not expected_values:
        issue = ResolverIssue(
            severity="warning",
            code="RESTRICTION_CELL_EMPTY",
            message=f"{rule_label} restriction cell for {column.name} has no expected values and was ignored.",
            recommendation="Add a value to the LIMIT cell, or change its role if it should not restrict the rule.",
            column_id=column.id,
            column_label=column.name,
            rule_id=rule.id,
            rule_label=rule_label,
        )
        issues.append(issue)
        return (
            RuleRestrictionEvaluation(
                column_id=column.id,
                column_label=column.name,
                rule_id=rule.id,
                role=role,
                expected_values=[],
                actual_values=actual_values,
                passed=True,
                restricted_out=False,
                match_reason="Blank LIMIT cell ignored.",
                source_type=column.source_type,
                issue_codes=["RESTRICTION_CELL_EMPTY"],
            ),
            issues,
        )

    if not actual_values:
        issue = ResolverIssue(
            severity="warning",
            code="RESTRICTION_NO_ACTUAL_VALUE",
            message=f"{rule_label} restriction cell for {column.name} had no actual value to compare.",
            recommendation="Provide matching resolver input, extracted facts, catalog hints, or a baseline value so this restriction can be verified.",
            column_id=column.id,
            column_label=column.name,
            rule_id=rule.id,
            rule_label=rule_label,
        )
        issues.append(issue)
        return (
            RuleRestrictionEvaluation(
                column_id=column.id,
                column_label=column.name,
                rule_id=rule.id,
                role=role,
                expected_values=expected_values,
                actual_values=[],
                passed=False,
                restricted_out=True,
                match_reason="No actual value available; restricted out for safety.",
                source_type=column.source_type,
                issue_codes=["RESTRICTION_NO_ACTUAL_VALUE", "RESTRICTION_NOT_MATCHED"],
            ),
            issues,
        )

    matched_expected, matched_actual = _match_any_condition_value(
        expected_values, actual_values
    )
    if matched_expected is not None:
        return (
            RuleRestrictionEvaluation(
                column_id=column.id,
                column_label=column.name,
                rule_id=rule.id,
                role=role,
                expected_values=expected_values,
                actual_values=actual_values,
                passed=True,
                restricted_out=False,
                match_reason=f"{matched_expected!r} matched {matched_actual!r}.",
                source_type=column.source_type,
                issue_codes=["RESTRICTION_MATCHED"],
            ),
            issues,
        )

    issue = ResolverIssue(
        severity="info",
        code="RESTRICTION_NOT_MATCHED",
        message=f"{rule_label} restriction cell for {column.name} did not match.",
        recommendation=None,
        column_id=column.id,
        column_label=column.name,
        rule_id=rule.id,
        rule_label=rule_label,
    )
    issues.append(issue)
    return (
        RuleRestrictionEvaluation(
            column_id=column.id,
            column_label=column.name,
            rule_id=rule.id,
            role=role,
            expected_values=expected_values,
            actual_values=actual_values,
            passed=False,
            restricted_out=True,
            match_reason="No exact normalized match; rule restricted out.",
            source_type=column.source_type,
            issue_codes=["RESTRICTION_NOT_MATCHED"],
        ),
        issues,
    )


def _restriction_failure_count(
    evaluations: list[RuleRestrictionEvaluation],
) -> int:
    return sum(1 for evaluation in evaluations if evaluation.restricted_out)


def _rule_restricted_out_issue(
    rule: InvoiceTemplateRule, rule_label: str
) -> ResolverIssue:
    return ResolverIssue(
        severity="info",
        code="RULE_RESTRICTED_OUT",
        message=f"{rule_label} matched its IF conditions but was restricted out by LIMIT cells.",
        recommendation="Review LIMIT values or resolver input if this rule should remain eligible for future FILL actions.",
        rule_id=rule.id,
        rule_label=rule_label,
    )


def _apply_rule_actions(
    *,
    rules: list[InvoiceTemplateRule],
    matched_rules: list[MatchedRuleResult],
    columns: list[InvoiceTemplateColumn],
    cells: list[ResolvedImportCell],
    fact_index: dict[str, list[ExtractedFact]],
) -> list[ResolverIssue]:
    column_by_id = {column.id: column for column in columns}
    cell_by_column_id = {cell.column_id: cell for cell in cells}
    result_by_rule_id = {result.rule_id: result for result in matched_rules}
    row_issues: list[ResolverIssue] = []

    for idx, rule in enumerate(rules):
        result = result_by_rule_id.get(rule.id)
        if result is None or not result.eligible_for_actions:
            continue
        rule_label = result.rule_label or _rule_label(rule, idx)

        for column_id, rule_cell in rule.cells.items():
            column = column_by_id.get(column_id)
            if column is None:
                continue
            role = effective_rule_cell_role(rule_cell, column)
            if _action_role(role) != "action":
                continue

            target_cell = cell_by_column_id.get(column.id)
            if target_cell is None:
                continue

            if not column.allow_rule_override:
                issue = _rule_action_issue(
                    severity="warning",
                    code="RULE_ACTION_IGNORED_BY_GLOBAL_OVERRIDE",
                    message=(
                        f"{rule_label} FILL/action for {column.name} was ignored "
                        "because the column prevents rule overrides."
                    ),
                    recommendation=(
                        "Enable rule override for this column, or clear the "
                        "FILL/action value if the global/default behavior should win."
                    ),
                    column=column,
                    rule=rule,
                    rule_label=rule_label,
                )
                _record_rule_action_issue(result, issue)
                result.actions_ignored += 1
                target_cell.warnings.append(issue.message)
                _append_issue_code(target_cell, issue.code)
                row_issues.append(issue)
                continue

            candidate = _extract_rule_fill_candidate(
                rule=rule,
                rule_label=rule_label,
                column=column,
                cell=rule_cell,
                fact_index=fact_index,
            )
            for issue in candidate.issues:
                _record_rule_action_issue(result, issue)
                row_issues.append(issue)

            if not candidate.apply_value:
                result.actions_ignored += 1
                _mark_unapplied_rule_action(target_cell, candidate)
                continue

            applied, apply_issues = _apply_rule_fill_candidate(
                target_cell=target_cell,
                column=column,
                rule=rule,
                rule_label=rule_label,
                candidate=candidate,
            )
            for issue in apply_issues:
                _record_rule_action_issue(result, issue)
                row_issues.append(issue)
            if applied:
                result.actions_applied += 1
            else:
                result.actions_ignored += 1

    return row_issues


def _extract_rule_fill_candidate(
    *,
    rule: InvoiceTemplateRule,
    rule_label: str,
    column: InvoiceTemplateColumn,
    cell: InvoiceTemplateRuleCell,
    fact_index: dict[str, list[ExtractedFact]],
) -> RuleFillCandidate:
    bindings = list(cell.extraction_bindings or [])
    if not bindings and cell.extraction is not None:
        bindings = [cell.extraction]
    if bindings:
        return _rule_fill_from_extraction_bindings(
            rule=rule,
            rule_label=rule_label,
            column=column,
            bindings=bindings,
            fact_index=fact_index,
        )

    if cell.selections:
        return _rule_fill_from_selections(
            rule=rule,
            rule_label=rule_label,
            column=column,
            cell=cell,
        )

    if cell.values:
        return _rule_fill_from_values(
            rule=rule,
            rule_label=rule_label,
            column=column,
            cell=cell,
        )

    issue = _rule_action_issue(
        severity="warning",
        code="RULE_FILL_VALUE_MISSING",
        message=f"{rule_label} FILL/action for {column.name} has no value to apply.",
        recommendation="Add a literal value, catalog selection, or extraction binding to the FILL/action cell.",
        column=column,
        rule=rule,
        rule_label=rule_label,
    )
    return RuleFillCandidate(
        issues=[issue],
        issue_codes=[issue.code],
        warnings=[issue.message],
    )


def _rule_fill_from_extraction_bindings(
    *,
    rule: InvoiceTemplateRule,
    rule_label: str,
    column: InvoiceTemplateColumn,
    bindings: list[Any],
    fact_index: dict[str, list[ExtractedFact]],
) -> RuleFillCandidate:
    matches: list[tuple[Any, ExtractedFact]] = []
    for binding in bindings:
        matches.extend(
            (binding, fact)
            for fact in _facts_for_extraction_binding(binding, fact_index)
            if _has_value(_fact_value(fact))
        )

    if not matches:
        issue = _rule_action_issue(
            severity="warning",
            code="RULE_FILL_EXTRACTION_VALUE_NOT_FOUND",
            message=(
                f"{rule_label} FILL/action for {column.name} could not find "
                "a provided extracted fact for its extraction binding."
            ),
            recommendation="Provide extracted_facts for the bound field, or clear the extraction binding for this dry run.",
            column=column,
            rule=rule,
            rule_label=rule_label,
        )
        return RuleFillCandidate(
            issues=[issue],
            issue_codes=[issue.code],
            warnings=[issue.message],
        )

    normalized_values = {
        _normalized_output_key(_fact_value(fact))
        for _, fact in matches
        if _normalized_output_key(_fact_value(fact)) is not None
    }
    if len(normalized_values) > 1:
        issue = _rule_action_issue(
            severity="warning",
            code="CONFLICTING_RULE_ACTION",
            message=(
                f"{rule_label} FILL/action for {column.name} found multiple "
                "different extracted values."
            ),
            recommendation="Narrow the extraction bindings or review the extracted facts before operational use.",
            column=column,
            rule=rule,
            rule_label=rule_label,
        )
        return RuleFillCandidate(
            issues=[issue],
            issue_codes=[issue.code],
            warnings=[issue.message],
        )

    binding, fact = matches[0]
    binding_field_key = getattr(binding, "field_key", None)
    normalized_field_key = normalize_extracted_field_key(
        binding_field_key or fact.field_key
    )
    fact_source_type = _source_type_from_fact(fact)
    return RuleFillCandidate(
        value=_fact_value(fact),
        source_type=fact_source_type if fact_source_type != "none" else "rule_fill",
        confidence=_fact_confidence(fact),
        provenance=CellProvenance(
            rule_id=rule.id,
            rule_label=rule_label,
            column_id=column.id,
            column_label=column.name,
            pattern_id=fact.pattern_id or getattr(binding, "pattern_id", None),
            field_key=binding_field_key or fact.field_key,
            normalized_field_key=normalized_field_key,
            source_label=(
                fact.provenance_label
                or getattr(binding, "field_label", None)
                or fact.source_type
            ),
            source_detail=f"Rule FILL extraction binding | {_fact_source_detail(fact)}",
        ),
        apply_value=True,
    )


def _rule_fill_from_selections(
    *,
    rule: InvoiceTemplateRule,
    rule_label: str,
    column: InvoiceTemplateColumn,
    cell: InvoiceTemplateRuleCell,
) -> RuleFillCandidate:
    values = [
        _selection_output_value(selection)
        for selection in cell.selections
        if _has_value(_selection_output_value(selection))
    ]
    values = _dedupe_values(values)
    if not values:
        issue = _rule_action_issue(
            severity="warning",
            code="RULE_FILL_VALUE_MISSING",
            message=f"{rule_label} FILL/action for {column.name} has empty catalog selections.",
            recommendation="Choose a catalog entry with a value, or clear the FILL/action cell.",
            column=column,
            rule=rule,
            rule_label=rule_label,
        )
        return RuleFillCandidate(
            issues=[issue],
            issue_codes=[issue.code],
            warnings=[issue.message],
        )

    if len(values) > 1 and column.data_type != "multi_select":
        issue = _rule_action_issue(
            severity="error" if column.required else "warning",
            code="RULE_FILL_MULTIPLE_VALUES",
            message=(
                f"{rule_label} FILL/action for {column.name} has multiple "
                "catalog selections for a single-value column."
            ),
            recommendation="Pick one catalog value, or change the column data type to multi-select if multiple values are intended.",
            column=column,
            rule=rule,
            rule_label=rule_label,
        )
        return RuleFillCandidate(
            issues=[issue],
            issue_codes=[issue.code],
            warnings=[issue.message],
        )

    single_selection = cell.selections[0] if len(cell.selections) == 1 else None
    catalog_id = column.source_ref.catalog_id if column.source_ref else None
    value: Any = values if column.data_type == "multi_select" else values[0]
    return RuleFillCandidate(
        value=value,
        source_type="catalog",
        confidence=1.0,
        provenance=CellProvenance(
            rule_id=rule.id,
            rule_label=rule_label,
            column_id=column.id,
            column_label=column.name,
            catalog_id=catalog_id,
            entry_id=single_selection.entry_id if single_selection else None,
            source_label="Rule catalog selection",
            source_detail="Rule FILL catalog selection",
        ),
        apply_value=True,
    )


def _rule_fill_from_values(
    *,
    rule: InvoiceTemplateRule,
    rule_label: str,
    column: InvoiceTemplateColumn,
    cell: InvoiceTemplateRuleCell,
) -> RuleFillCandidate:
    values = _dedupe_values([value for value in cell.values if _has_value(value)])
    if not values:
        issue = _rule_action_issue(
            severity="warning",
            code="RULE_FILL_VALUE_MISSING",
            message=f"{rule_label} FILL/action for {column.name} has no literal value to apply.",
            recommendation="Add a literal value or another supported FILL source.",
            column=column,
            rule=rule,
            rule_label=rule_label,
        )
        return RuleFillCandidate(
            issues=[issue],
            issue_codes=[issue.code],
            warnings=[issue.message],
        )

    if len(values) > 1 and column.data_type != "multi_select":
        issue = _rule_action_issue(
            severity="error" if column.required else "warning",
            code="RULE_FILL_MULTIPLE_VALUES",
            message=(
                f"{rule_label} FILL/action for {column.name} has multiple "
                "literal values for a single-value column."
            ),
            recommendation="Keep one value, or change the column data type to multi-select if multiple values are intended.",
            column=column,
            rule=rule,
            rule_label=rule_label,
        )
        return RuleFillCandidate(
            issues=[issue],
            issue_codes=[issue.code],
            warnings=[issue.message],
        )

    value: Any = values if column.data_type == "multi_select" else values[0]
    return RuleFillCandidate(
        value=value,
        confidence=1.0,
        provenance=CellProvenance(
            rule_id=rule.id,
            rule_label=rule_label,
            column_id=column.id,
            column_label=column.name,
            source_label="Rule literal value",
            source_detail="Rule FILL literal/manual value",
        ),
        apply_value=True,
    )


def _apply_rule_fill_candidate(
    *,
    target_cell: ResolvedImportCell,
    column: InvoiceTemplateColumn,
    rule: InvoiceTemplateRule,
    rule_label: str,
    candidate: RuleFillCandidate,
) -> tuple[bool, list[ResolverIssue]]:
    issues: list[ResolverIssue] = []
    coercion = coerce_resolved_value(candidate.value, column.data_type, column.format)
    next_issue_codes = [*candidate.issue_codes, *coercion.issue_codes]
    next_warnings = [*candidate.warnings, *coercion.warnings]

    if coercion.failed:
        issue = _rule_action_issue(
            severity="error" if column.required else "warning",
            code="RULE_ACTION_COERCION_FAILED",
            message=(
                f"{rule_label} FILL/action for {column.name} could not be "
                "coerced to the column data type."
            ),
            recommendation="Adjust the FILL value, column data type, or column format.",
            column=column,
            rule=rule,
            rule_label=rule_label,
        )
        issues.append(issue)
        next_issue_codes.append(issue.code)
        next_warnings.append(issue.message)

    existing_rule_value = (
        target_cell.provenance is not None and target_cell.provenance.rule_id is not None
    )
    if existing_rule_value and _has_value(target_cell.value):
        existing_key = _normalized_output_key(target_cell.normalized_value)
        candidate_key = _normalized_output_key(coercion.normalized_value)
        if existing_key == candidate_key:
            issue = _rule_action_issue(
                severity="info",
                code="RULE_ACTION_APPLIED",
                message=(
                    f"{rule_label} FILL/action for {column.name} matched an "
                    "earlier rule action value, so the first value was kept."
                ),
                recommendation=None,
                column=column,
                rule=rule,
                rule_label=rule_label,
            )
            issues.append(issue)
            return False, issues

        issue = _rule_action_issue(
            severity="warning",
            code="CONFLICTING_RULE_ACTION",
            message=(
                f"{rule_label} FILL/action for {column.name} conflicts with "
                "an earlier eligible rule action. The first value was kept."
            ),
            recommendation="Review rule order or add IF/LIMIT cells so only one action can fill this column.",
            column=column,
            rule=rule,
            rule_label=rule_label,
        )
        target_cell.status = "conflict"
        target_cell.warnings.append(issue.message)
        _append_issue_code(target_cell, issue.code)
        issues.append(issue)
        return False, issues

    baseline_had_value = _has_value(target_cell.value)
    baseline_key = _normalized_output_key(target_cell.normalized_value)
    candidate_key = _normalized_output_key(coercion.normalized_value)
    if baseline_had_value and baseline_key != candidate_key:
        issue = _rule_action_issue(
            severity="info",
            code="BASELINE_VALUE_OVERRIDDEN_BY_RULE",
            message=(
                f"{rule_label} FILL/action for {column.name} replaced the "
                "baseline/global dry-run value."
            ),
            recommendation=None,
            column=column,
            rule=rule,
            rule_label=rule_label,
        )
        issues.append(issue)

    _write_rule_fill_cell(
        target_cell=target_cell,
        column=column,
        candidate=candidate,
        coercion=coercion,
        warnings=next_warnings,
        issue_codes=next_issue_codes,
    )
    issue = _rule_action_issue(
        severity="info",
        code="RULE_ACTION_APPLIED",
        message=f"{rule_label} FILL/action resolved {column.name}.",
        recommendation=None,
        column=column,
        rule=rule,
        rule_label=rule_label,
    )
    issues.append(issue)
    return True, issues


def _write_rule_fill_cell(
    *,
    target_cell: ResolvedImportCell,
    column: InvoiceTemplateColumn,
    candidate: RuleFillCandidate,
    coercion: ValueCoercion,
    warnings: list[str],
    issue_codes: list[str],
) -> None:
    target_cell.value = candidate.value
    target_cell.normalized_value = coercion.normalized_value
    target_cell.formatted_value = coercion.formatted_value
    target_cell.status = "manual_review" if coercion.failed else "resolved"
    target_cell.source_type = candidate.source_type
    target_cell.confidence = candidate.confidence
    target_cell.provenance = _provenance_with_source_type(
        candidate.provenance
        or CellProvenance(
            column_id=column.id,
            column_label=column.name,
            source_label="Rule FILL",
            source_detail="Rule FILL/action value",
        ),
        candidate.source_type,
    )
    target_cell.warnings = _dedupe_strings(warnings)
    target_cell.issue_codes = _dedupe_strings(issue_codes)


def _mark_unapplied_rule_action(
    target_cell: ResolvedImportCell, candidate: RuleFillCandidate
) -> None:
    if not candidate.issue_codes and not candidate.warnings:
        return
    if "CONFLICTING_RULE_ACTION" in candidate.issue_codes:
        target_cell.status = "conflict"
    elif target_cell.status in {"missing", "ignored"}:
        target_cell.status = "manual_review"
    for warning in candidate.warnings:
        if warning not in target_cell.warnings:
            target_cell.warnings.append(warning)
    for code in candidate.issue_codes:
        _append_issue_code(target_cell, code)


def _facts_for_extraction_binding(
    binding: Any, fact_index: dict[str, list[ExtractedFact]]
) -> list[ExtractedFact]:
    field_key = getattr(binding, "field_key", None)
    normalized = normalize_extracted_field_key(field_key)
    if not normalized:
        return []
    facts = fact_index.get(normalized, [])
    pattern_id = getattr(binding, "pattern_id", None)
    if not pattern_id:
        return facts
    exact = [fact for fact in facts if fact.pattern_id == pattern_id]
    return exact or facts


def _selection_output_value(selection: Any) -> Any | None:
    for value in (selection.field_value, selection.label, selection.entry_id):
        if _has_value(value):
            return value
    return None


def _record_rule_action_issue(
    result: MatchedRuleResult, issue: ResolverIssue
) -> None:
    result.issues.append(issue)
    result.action_issues.append(issue)


def _rule_action_issue(
    *,
    severity: str,
    code: str,
    message: str,
    recommendation: str | None,
    column: InvoiceTemplateColumn,
    rule: InvoiceTemplateRule,
    rule_label: str,
) -> ResolverIssue:
    return ResolverIssue(
        severity=severity,  # type: ignore[arg-type]
        code=code,
        scope="runtime",
        message=message,
        recommendation=recommendation,
        column_id=column.id,
        column_label=column.name,
        rule_id=rule.id,
        rule_label=rule_label,
    )


def _append_issue_code(cell: ResolvedImportCell, code: str) -> None:
    if code not in cell.issue_codes:
        cell.issue_codes.append(code)


def _provenance_with_source_type(
    provenance: CellProvenance, source_type: str | None
) -> CellProvenance:
    if not source_type or provenance.source_type:
        return provenance
    return provenance.model_copy(update={"source_type": source_type})


def _normalized_output_key(value: Any | None) -> str | None:
    if isinstance(value, (list, tuple, set)):
        return normalize_catalog_text("|".join(str(item) for item in value))
    return normalize_catalog_text(value)


def _dedupe_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        output.append(value)
    return output


def _rule_label(rule: InvoiceTemplateRule, index: int) -> str:
    return f"Rule {index + 1}"


def _condition_role(role: Any | None) -> str | None:
    normalized = _normalize_role_alias(role)
    return "condition" if normalized == "condition" else None


def _restriction_role(role: Any | None) -> str | None:
    normalized = _normalize_role_alias(role)
    return "restriction" if normalized == "restriction" else None


def _action_role(role: Any | None) -> str | None:
    normalized = _normalize_role_alias(role)
    return "action" if normalized == "action" else None


def _condition_expected_values(cell: InvoiceTemplateRuleCell) -> list[Any]:
    values: list[Any] = []
    values.extend(cell.values)
    for selection in cell.selections:
        values.extend([selection.entry_id, selection.field_value, selection.label])
    return _dedupe_values([value for value in values if _has_value(value)])


def _condition_actual_values(
    *,
    column: InvoiceTemplateColumn,
    baseline_cell: ResolvedImportCell | None,
    payload: ResolverInput,
    fact_index: dict[str, list[ExtractedFact]],
) -> list[Any]:
    values: list[Any] = []

    if baseline_cell is not None:
        values.extend(
            [
                baseline_cell.value,
                baseline_cell.normalized_value,
                baseline_cell.formatted_value,
            ]
        )
        if baseline_cell.provenance is not None:
            values.append(baseline_cell.provenance.entry_id)

    source_type = column.source_type or "empty"
    if source_type in CATALOG_SOURCE_TYPES:
        kind = CATALOG_KIND_BY_SOURCE[source_type]
        hint = _catalog_hint_for_kind(payload.catalog_hints, kind)
        if hint is not None:
            values.extend(_catalog_hint_raw_values(hint))

    if source_type == "invoice_field":
        field_key = column.source_ref.field if column.source_ref else None
        normalized = normalize_extracted_field_key(field_key)
        for fact in fact_index.get(normalized or "", []):
            values.extend(
                [
                    _fact_value(fact),
                    fact.text_value,
                    fact.field_key,
                    fact.normalized_field_key,
                    fact.provenance_label,
                ]
            )

    values.extend(_document_metadata_values(column, payload.document_metadata))
    return _dedupe_values([value for value in values if _has_value(value)])


def _catalog_hint_raw_values(hint: CatalogHint) -> list[Any]:
    values: list[Any] = [hint.entry_id, hint.text]
    for key, value in hint.field_values.items():
        values.append(key)
        if isinstance(value, list):
            values.extend(value)
        else:
            values.append(value)
    return values


def _document_metadata_values(
    column: InvoiceTemplateColumn, document_metadata: dict[str, Any]
) -> list[Any]:
    keys = [column.id, column.name]
    if column.source_ref and column.source_ref.field:
        keys.append(column.source_ref.field)
    values: list[Any] = []
    for key in keys:
        if key in document_metadata:
            values.append(document_metadata[key])
    return values


def _match_any_condition_value(
    expected_values: list[Any], actual_values: list[Any]
) -> tuple[Any | None, Any | None]:
    for expected in expected_values:
        expected_normalized = normalize_catalog_text(expected)
        if expected_normalized is None:
            continue
        for actual in actual_values:
            actual_normalized = normalize_catalog_text(actual)
            if actual_normalized is None:
                continue
            if expected_normalized == actual_normalized:
                return expected, actual
    return None, None


def _dedupe_values(values: list[Any]) -> list[Any]:
    seen: set[str] = set()
    deduped: list[Any] = []
    for value in values:
        key = normalize_catalog_text(value)
        if key is None:
            continue
        if key in seen:
            continue
        seen.add(key)
        deduped.append(value)
    return deduped


async def _resolve_column_baseline(
    column: InvoiceTemplateColumn,
    fact_index: dict[str, list[ExtractedFact]],
    *,
    catalog_hints: dict[str, CatalogHint],
    db: AsyncSession | None,
) -> ResolvedImportCell:
    source_type = column.source_type or "empty"
    has_default = _has_value(column.default_value)

    if source_type == "fixed_value":
        if not has_default:
            return _missing_cell(
                column,
                issue_code="FIXED_VALUE_EMPTY",
                warning="Fixed/default source is selected but no default value is configured.",
                source_type="fixed_value",
            )
        source: ResolvedCellSourceType = (
            "fixed_value" if source_type == "fixed_value" else "global_default"
        )
        return _resolved_cell(
            column,
            value=column.default_value,
            source_type=source,
            confidence=1.0,
            provenance=CellProvenance(
                column_id=column.id,
                column_label=column.name,
                source_label="Column default",
                source_detail="Column fixed/default value",
            ),
        )

    if source_type == "empty" and has_default:
        return _resolved_cell(
            column,
            value=column.default_value,
            source_type="global_default",
            confidence=1.0,
            provenance=CellProvenance(
                column_id=column.id,
                column_label=column.name,
                source_label="Column default",
                source_detail="Legacy default_value on an otherwise empty source.",
            ),
        )

    if source_type == "manual_list":
        manual_values = column.manual_values or []
        if len(manual_values) == 1:
            return _resolved_cell(
                column,
                value=manual_values[0],
                source_type="manual",
                confidence=1.0,
                provenance=CellProvenance(
                    column_id=column.id,
                    column_label=column.name,
                    source_label="Manual list",
                    source_detail="Column manual list has one available value.",
                ),
            )
        if len(manual_values) > 1:
            return _manual_review_cell(
                column,
                issue_code="MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION",
                warning=(
                    "Manual/list source has multiple values and no selected "
                    "column-level default."
                ),
                source_type="manual",
                source_label="Manual list",
                source_detail="Multiple manual list values require operator selection.",
            )
        return _missing_cell(
            column,
            issue_code="MANUAL_VALUE_REQUIRED",
            warning="Manual/list source is selected but no values are configured.",
            source_type="manual",
        )

    if source_type == "invoice_field":
        field_key = column.source_ref.field if column.source_ref else None
        normalized = normalize_extracted_field_key(field_key)
        fact = _first_fact_for_key(normalized, fact_index)
        if fact is not None:
            resolved_source = _source_type_from_fact(fact)
            status = "resolved" if resolved_source != "none" else "fallback"
            warnings = (
                ["Extracted fact source type is unknown."]
                if resolved_source == "none"
                else []
            )
            return _resolved_cell(
                column,
                value=_fact_value(fact),
                source_type=resolved_source,
                confidence=_fact_confidence(fact),
                status=status,
                warnings=warnings,
                issue_codes=["EXTRACTED_FACT_SOURCE_UNKNOWN"] if warnings else [],
                provenance=CellProvenance(
                    column_id=column.id,
                    column_label=column.name,
                    pattern_id=fact.pattern_id,
                    field_key=fact.field_key,
                    normalized_field_key=fact.normalized_field_key
                    or normalize_extracted_field_key(fact.field_key),
                    source_label=fact.provenance_label or fact.source_type,
                    source_detail=_fact_source_detail(fact),
                ),
            )
        return _missing_cell(
            column,
            issue_code="INVOICE_FIELD_FACT_NOT_FOUND",
            warning="No extracted fact matched the column-level invoice field binding.",
        )

    if source_type in CATALOG_SOURCE_TYPES:
        return await _resolve_catalog_baseline(
            column,
            source_type=source_type,
            catalog_hints=catalog_hints,
            db=db,
        )

    if source_type == "derived":
        return ResolvedImportCell(
            column_id=column.id,
            column_label=column.name,
            status="ignored",
            source_type="derived",
            confidence=None,
            provenance=CellProvenance(
                column_id=column.id,
                column_label=column.name,
                source_label="Derived",
                source_detail="Derived resolution is not implemented in this dry run.",
                source_type="derived",
            ),
            warnings=["Derived resolution is not implemented in this dry run."],
            issue_codes=["DERIVED_RESOLVER_NOT_IMPLEMENTED"],
        )

    return _missing_cell(column)


def _resolved_cell(
    column: InvoiceTemplateColumn,
    *,
    value: Any,
    source_type: ResolvedCellSourceType,
    confidence: float | None,
    provenance: CellProvenance,
    status: str = "resolved",
    warnings: list[str] | None = None,
    issue_codes: list[str] | None = None,
) -> ResolvedImportCell:
    coercion = coerce_resolved_value(value, column.data_type, column.format)
    next_warnings = [*(warnings or []), *coercion.warnings]
    next_issue_codes = [*(issue_codes or []), *coercion.issue_codes]
    next_status = "manual_review" if coercion.failed else status
    return ResolvedImportCell(
        column_id=column.id,
        column_label=column.name,
        value=value,
        normalized_value=coercion.normalized_value,
        formatted_value=coercion.formatted_value,
        status=next_status,  # type: ignore[arg-type]
        source_type=source_type,
        confidence=confidence,
        provenance=_provenance_with_source_type(provenance, source_type),
        warnings=next_warnings,
        issue_codes=next_issue_codes,
    )


def _manual_review_cell(
    column: InvoiceTemplateColumn,
    *,
    issue_code: str,
    warning: str,
    source_type: ResolvedCellSourceType,
    source_label: str,
    source_detail: str,
) -> ResolvedImportCell:
    return ResolvedImportCell(
        column_id=column.id,
        column_label=column.name,
        value=None,
        normalized_value=None,
        formatted_value=None,
        status="manual_review",
        source_type=source_type,
        confidence=None,
        provenance=CellProvenance(
            column_id=column.id,
            column_label=column.name,
            source_label=source_label,
            source_detail=source_detail,
            source_type=source_type,
        ),
        warnings=[warning],
        issue_codes=[issue_code],
    )


def _missing_cell(
    column: InvoiceTemplateColumn,
    *,
    issue_code: str = "VALUE_NOT_RESOLVED",
    warning: str | None = None,
    source_type: ResolvedCellSourceType = "none",
) -> ResolvedImportCell:
    return ResolvedImportCell(
        column_id=column.id,
        column_label=column.name,
        value=None,
        normalized_value=None,
        formatted_value=None,
        status="missing",
        source_type=source_type,
        confidence=None,
        provenance=CellProvenance(
            column_id=column.id,
            column_label=column.name,
            source_label="Dry-run placeholder",
            source_detail="No resolver value was produced in this skeleton phase.",
            source_type=source_type,
        ),
        warnings=[warning] if warning else [],
        issue_codes=[issue_code],
    )


async def _resolve_catalog_baseline(
    column: InvoiceTemplateColumn,
    *,
    source_type: str,
    catalog_hints: dict[str, CatalogHint],
    db: AsyncSession | None,
) -> ResolvedImportCell:
    kind = CATALOG_KIND_BY_SOURCE[source_type]
    source_ref = column.source_ref
    catalog_id = source_ref.catalog_id if source_ref else None
    field_name = source_ref.field if source_ref else None

    if not catalog_id:
        return _catalog_issue_cell(
            column,
            kind=kind,
            issue_code="CATALOG_NOT_CONFIGURED",
            warning=f"Column has no selected {kind} catalog for baseline resolution.",
            source_detail="Catalog-backed column is missing source_ref.catalog_id.",
        )

    if not field_name:
        return _catalog_issue_cell(
            column,
            kind=kind,
            issue_code="SOURCE_CATALOG_FIELD_MISSING",
            warning=f"Column has no selected {kind} catalog field to emit.",
            source_detail="Catalog-backed column is missing source_ref.field.",
        )

    if not _catalog_field_exists(kind, field_name):
        return _catalog_issue_cell(
            column,
            kind=kind,
            issue_code="CATALOG_FIELD_NOT_FOUND",
            warning=f"Column references unknown {kind} catalog field {field_name}.",
            source_detail=f"Unknown {kind} field: {field_name}",
            catalog_id=catalog_id,
        )

    if db is None:
        return _catalog_issue_cell(
            column,
            kind=kind,
            issue_code="CATALOG_MATCHER_NOT_IMPLEMENTED",
            warning="Catalog lookup requires a database session in this dry run.",
            source_detail="No database session was provided for catalog loading.",
            catalog_id=catalog_id,
        )

    catalog = await load_catalog_entries(db, kind, catalog_id)
    if catalog is None:
        return _catalog_issue_cell(
            column,
            kind=kind,
            issue_code="CATALOG_NOT_FOUND",
            warning=f"Selected {kind} catalog was not found.",
            source_detail=f"{kind.title()} catalog {catalog_id} was not found.",
            catalog_id=catalog_id,
        )

    hint = _catalog_hint_for_kind(catalog_hints, kind)
    if hint is None or not _has_catalog_hint_value(hint):
        return _catalog_issue_cell(
            column,
            kind=kind,
            issue_code="CATALOG_HINT_MISSING",
            warning=f"No {kind} catalog hint was provided for baseline matching.",
            source_detail=f"{catalog.label or kind.title()} requires a catalog hint.",
            catalog_id=catalog_id,
            source_label=_catalog_source_label(kind, catalog),
        )

    match = match_catalog_entries(catalog.entries, kind, hint)
    if match.status == "not_found":
        return _catalog_issue_cell(
            column,
            kind=kind,
            issue_code="CATALOG_ENTRY_NOT_FOUND",
            warning=f"No {kind} catalog entry matched the provided hint.",
            source_detail=match.detail or "No catalog entry matched.",
            catalog_id=catalog_id,
            source_label=_catalog_source_label(kind, catalog),
        )
    if match.status == "ambiguous":
        return _catalog_issue_cell(
            column,
            kind=kind,
            issue_code="CATALOG_ENTRY_AMBIGUOUS",
            warning=f"Multiple {kind} catalog entries matched the provided hint.",
            source_detail=match.detail or "Catalog hint matched multiple entries.",
            catalog_id=catalog_id,
            source_label=_catalog_source_label(kind, catalog),
            status="conflict",
        )
    if match.entry is None:
        return _catalog_issue_cell(
            column,
            kind=kind,
            issue_code="CATALOG_ENTRY_NOT_FOUND",
            warning=f"No {kind} catalog entry matched the provided hint.",
            source_detail="No catalog entry matched.",
            catalog_id=catalog_id,
            source_label=_catalog_source_label(kind, catalog),
        )

    value = get_catalog_field_value(match.entry, kind, field_name)
    entry_id = _entry_id(match.entry)
    if not _has_value(value):
        return _catalog_issue_cell(
            column,
            kind=kind,
            issue_code="CATALOG_VALUE_MISSING",
            warning=f"Matched {kind} entry has no value for {field_name}.",
            source_detail=f"{catalog.label or kind.title()} matched entry lacks {field_name}.",
            catalog_id=catalog_id,
            entry_id=entry_id,
            source_label=_catalog_source_label(kind, catalog),
        )

    return _resolved_cell(
        column,
        value=value,
        source_type="catalog",
        confidence=match.confidence,
        provenance=CellProvenance(
            column_id=column.id,
            column_label=column.name,
            catalog_id=catalog_id,
            entry_id=entry_id,
            source_label=_catalog_source_label(kind, catalog),
            source_detail=(
                f"{kind.title()} Catalog: {catalog.label or catalog_id} "
                f"-> {field_name} ({match.detail or 'matched'})"
            ),
        ),
    )


def _catalog_issue_cell(
    column: InvoiceTemplateColumn,
    *,
    kind: str,
    issue_code: str,
    warning: str,
    source_detail: str,
    catalog_id: str | None = None,
    entry_id: str | None = None,
    source_label: str | None = None,
    status: str = "missing",
) -> ResolvedImportCell:
    return ResolvedImportCell(
        column_id=column.id,
        column_label=column.name,
        value=None,
        normalized_value=None,
        formatted_value=None,
        status=status,  # type: ignore[arg-type]
        source_type="catalog",
        confidence=None,
        provenance=CellProvenance(
            column_id=column.id,
            column_label=column.name,
            catalog_id=catalog_id,
            entry_id=entry_id,
            source_label=source_label or f"{kind.title()} catalog",
            source_detail=source_detail,
            source_type="catalog",
        ),
        warnings=[warning],
        issue_codes=[issue_code],
    )


async def load_catalog_entries(
    db: AsyncSession, catalog_type: str, catalog_id: str
) -> LoadedCatalog | None:
    parsed_id = _parse_uuid(catalog_id)
    if parsed_id is None:
        return None

    if catalog_type == "vendor":
        catalog = await VendorCatalogRepository(db).get(parsed_id)
    elif catalog_type == "property":
        catalog = await PropertyCatalogRepository(db).get(parsed_id)
    elif catalog_type == "gl":
        catalog = await GLCatalogRepository(db).get(parsed_id)
    else:
        return None

    if catalog is None:
        return None

    entries = [
        entry
        for entry in (catalog.entries or [])
        if isinstance(entry, dict)
    ]
    return LoadedCatalog(
        kind=catalog_type,
        catalog_id=catalog_id,
        label=getattr(catalog, "name", None),
        entries=entries,
    )


def get_catalog_entry_by_id(
    entries: list[dict[str, Any]], entry_id: str | None
) -> dict[str, Any] | None:
    if not entry_id:
        return None
    for entry in entries:
        if str(entry.get("id")) == str(entry_id):
            return entry
    return None


def get_catalog_field_value(
    entry: dict[str, Any], catalog_type: str, field_name: str | None
) -> Any | None:
    if not field_name:
        return None
    real_field = CATALOG_FIELD_ALIASES.get(catalog_type, {}).get(
        field_name, field_name
    )
    return entry.get(real_field)


def normalize_catalog_text(value: Any | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip().casefold()
    if not text:
        return None
    return " ".join(text.replace("&", " and ").split())


def match_catalog_entries(
    entries: list[dict[str, Any]], catalog_type: str, hint: CatalogHint
) -> CatalogMatch:
    entry = get_catalog_entry_by_id(entries, hint.entry_id)
    if entry is not None:
        return CatalogMatch(
            status="matched",
            entry=entry,
            confidence=1.0,
            detail=f"entry_id={hint.entry_id}",
        )
    if hint.entry_id:
        return CatalogMatch(
            status="not_found",
            detail=f"entry_id={hint.entry_id} was not found.",
        )

    hint_values = _catalog_hint_values(hint)
    if not hint_values:
        return CatalogMatch(status="not_found", detail="No catalog hint value was provided.")

    exact_matches = _exact_catalog_matches(entries, catalog_type, hint_values)
    if len(exact_matches) == 1:
        matched_entry, matched_field = exact_matches[0]
        return CatalogMatch(
            status="matched",
            entry=matched_entry,
            confidence=0.95,
            detail=f"exact {matched_field}",
        )
    if len(exact_matches) > 1:
        return CatalogMatch(
            status="ambiguous",
            detail=f"Exact match found {len(exact_matches)} entries.",
        )

    alias_matches = _alias_catalog_matches(entries, catalog_type, hint_values)
    if len(alias_matches) == 1:
        matched_entry, matched_field = alias_matches[0]
        return CatalogMatch(
            status="matched",
            entry=matched_entry,
            confidence=0.92,
            detail=f"alias {matched_field}",
        )
    if len(alias_matches) > 1:
        return CatalogMatch(
            status="ambiguous",
            detail=f"Alias match found {len(alias_matches)} entries.",
        )

    contains_matches = _contains_catalog_matches(entries, catalog_type, hint_values)
    if len(contains_matches) == 1:
        matched_entry, matched_field = contains_matches[0]
        return CatalogMatch(
            status="matched",
            entry=matched_entry,
            confidence=0.7,
            detail=f"unique contains {matched_field}",
        )
    if len(contains_matches) > 1:
        return CatalogMatch(
            status="ambiguous",
            detail=f"Contains match found {len(contains_matches)} entries.",
        )
    return CatalogMatch(status="not_found", detail="No deterministic catalog match.")


def _catalog_hint_for_kind(
    catalog_hints: dict[str, CatalogHint], kind: str
) -> CatalogHint | None:
    if kind in catalog_hints:
        return catalog_hints[kind]
    aliases = {
        "vendor": ("vendor_catalog", "vendors"),
        "property": ("property_catalog", "properties"),
        "gl": ("gl_catalog", "gl_codes", "gl_code"),
    }
    for alias in aliases.get(kind, ()):
        if alias in catalog_hints:
            return catalog_hints[alias]
    return None


def _has_catalog_hint_value(hint: CatalogHint) -> bool:
    return bool(hint.entry_id or _has_value(hint.text) or hint.field_values)


def _catalog_hint_values(hint: CatalogHint) -> set[str]:
    values: set[str] = set()
    normalized_text = normalize_catalog_text(hint.text)
    if normalized_text:
        values.add(normalized_text)
    for value in hint.field_values.values():
        if isinstance(value, list):
            iterable = value
        else:
            iterable = [value]
        for item in iterable:
            normalized = normalize_catalog_text(item)
            if normalized:
                values.add(normalized)
    return values


def _exact_catalog_matches(
    entries: list[dict[str, Any]], catalog_type: str, hint_values: set[str]
) -> list[tuple[dict[str, Any], str]]:
    matches: list[tuple[dict[str, Any], str]] = []
    for entry in entries:
        for field in CATALOG_MATCH_FIELDS[catalog_type]:
            normalized = normalize_catalog_text(get_catalog_field_value(entry, catalog_type, field))
            if normalized and normalized in hint_values:
                matches.append((entry, field))
                break
    return _dedupe_entry_matches(matches)


def _alias_catalog_matches(
    entries: list[dict[str, Any]], catalog_type: str, hint_values: set[str]
) -> list[tuple[dict[str, Any], str]]:
    matches: list[tuple[dict[str, Any], str]] = []
    for entry in entries:
        for field in CATALOG_ALIAS_FIELDS[catalog_type]:
            values = entry.get(field)
            if not isinstance(values, list):
                values = [values]
            for value in values:
                normalized = normalize_catalog_text(value)
                if normalized and normalized in hint_values:
                    matches.append((entry, field))
                    break
    return _dedupe_entry_matches(matches)


def _contains_catalog_matches(
    entries: list[dict[str, Any]], catalog_type: str, hint_values: set[str]
) -> list[tuple[dict[str, Any], str]]:
    matches: list[tuple[dict[str, Any], str]] = []
    for entry in entries:
        for field in CATALOG_MATCH_FIELDS[catalog_type]:
            normalized = normalize_catalog_text(get_catalog_field_value(entry, catalog_type, field))
            if not normalized:
                continue
            if any(
                len(hint_value) >= 4
                and (hint_value in normalized or normalized in hint_value)
                for hint_value in hint_values
            ):
                matches.append((entry, field))
                break
    return _dedupe_entry_matches(matches)


def _dedupe_entry_matches(
    matches: list[tuple[dict[str, Any], str]]
) -> list[tuple[dict[str, Any], str]]:
    seen: set[str] = set()
    deduped: list[tuple[dict[str, Any], str]] = []
    for entry, field in matches:
        key = _entry_id(entry) or str(id(entry))
        if key in seen:
            continue
        seen.add(key)
        deduped.append((entry, field))
    return deduped


def _catalog_field_exists(kind: str, field_name: str) -> bool:
    return field_name in CATALOG_FIELDS[kind]


def _entry_id(entry: dict[str, Any] | None) -> str | None:
    if not entry:
        return None
    entry_id = entry.get("id")
    return str(entry_id) if entry_id is not None else None


def _catalog_source_label(kind: str, catalog: LoadedCatalog) -> str:
    return f"{kind.title()} catalog: {catalog.label or catalog.catalog_id}"


def _parse_uuid(value: str | None) -> UUID | None:
    if not value:
        return None
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def coerce_resolved_value(
    value: Any, data_type: str | None, column_format: ColumnFormat | None
) -> ValueCoercion:
    """Coerce a baseline value into the column's declared output shape.

    This intentionally stays small and non-authoritative. It gives the
    dry-run a useful normalized/formatted view while keeping the raw
    value intact when coercion fails.
    """

    output_type = data_type or "text"
    if value is None:
        return ValueCoercion(None, None, [], [])

    try:
        if output_type == "text":
            text = str(value)
            if column_format and column_format.trim:
                text = text.strip()
            if column_format and column_format.uppercase:
                text = text.upper()
            return ValueCoercion(text, text, [], [])

        if output_type == "number":
            number = _decimal_to_json_number(_parse_decimal(value))
            return ValueCoercion(
                number,
                format_resolved_value(number, output_type, column_format),
                [],
                [],
            )

        if output_type == "currency":
            amount = _decimal_to_json_number(_parse_decimal(value))
            return ValueCoercion(
                amount,
                format_resolved_value(amount, output_type, column_format),
                [],
                [],
            )

        if output_type == "date":
            normalized_date = _parse_date(value)
            iso_value = normalized_date.isoformat()
            return ValueCoercion(
                iso_value,
                format_resolved_value(normalized_date, output_type, column_format),
                [],
                [],
            )

        if output_type == "boolean":
            boolean_value = _parse_boolean(value)
            return ValueCoercion(
                boolean_value,
                format_resolved_value(boolean_value, output_type, column_format),
                [],
                [],
            )

        if output_type == "dropdown":
            selected = str(value)
            return ValueCoercion(
                selected,
                format_resolved_value(selected, output_type, column_format),
                [],
                [],
            )

        if output_type == "multi_select":
            selected_values = list(value) if isinstance(value, (list, tuple, set)) else value
            return ValueCoercion(
                selected_values,
                format_resolved_value(selected_values, output_type, column_format),
                [],
                [],
            )
    except (ValueError, TypeError, InvalidOperation):
        return ValueCoercion(
            value,
            str(value),
            [f"Value {value!r} could not be coerced to {output_type}."],
            ["DATA_TYPE_COERCION_FAILED"],
            failed=True,
        )

    return ValueCoercion(
        value,
        str(value),
        [f"Unknown data_type {output_type!r}; value was left unchanged."],
        ["DATA_TYPE_UNKNOWN"],
    )


def format_resolved_value(
    value: Any, data_type: str | None, column_format: ColumnFormat | None
) -> str | None:
    """Return a conservative display/export preview string for a value."""

    if value is None:
        return None
    output_type = data_type or "text"

    if output_type == "number":
        places = column_format.decimal_places if column_format else None
        if places is None:
            return str(value)
        return f"{float(value):.{places}f}"

    if output_type == "currency":
        places = column_format.decimal_places if column_format else 2
        if places is None:
            places = 2
        return f"{float(value):.{places}f}"

    if output_type == "date":
        if isinstance(value, datetime):
            value = value.date()
        if isinstance(value, date):
            date_format = column_format.date_format if column_format else None
            if date_format:
                return value.strftime(_to_strftime_format(date_format))
            return value.isoformat()
        return str(value)

    if output_type == "boolean":
        return "true" if bool(value) else "false"

    if output_type == "multi_select":
        separator = (
            column_format.multi_select_separator
            if column_format and column_format.multi_select_separator
            else ", "
        )
        if isinstance(value, (list, tuple, set)):
            return separator.join(str(item) for item in value)
        return str(value)

    return str(value)


def _parse_decimal(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        raise ValueError("boolean is not numeric")
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    text = str(value).strip()
    if not text:
        raise ValueError("blank numeric value")
    normalized = text.replace(",", "").replace("$", "")
    if normalized.startswith("(") and normalized.endswith(")"):
        normalized = f"-{normalized[1:-1]}"
    return Decimal(normalized)


def _decimal_to_json_number(value: Decimal) -> int | float:
    if value == value.to_integral_value():
        return int(value)
    return float(value)


def _parse_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value

    text = str(value).strip()
    if not text:
        raise ValueError("blank date value")

    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        pass

    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        pass

    for pattern in ("%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d", "%m-%d-%Y", "%m-%d-%y"):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    raise ValueError("unsupported date value")


def _parse_boolean(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in {0, 1}:
        return bool(value)
    text = str(value).strip().lower()
    if text in {"true", "t", "yes", "y", "1", "active"}:
        return True
    if text in {"false", "f", "no", "n", "0", "inactive"}:
        return False
    raise ValueError("unsupported boolean value")


def _to_strftime_format(date_format: str) -> str:
    replacements = (
        ("YYYY", "%Y"),
        ("YY", "%y"),
        ("MM", "%m"),
        ("DD", "%d"),
    )
    translated = date_format
    for token, strftime_token in replacements:
        translated = translated.replace(token, strftime_token)
    return translated


def _has_value(value: Any | None) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def _first_fact_for_key(
    normalized_field_key: str | None,
    fact_index: dict[str, list[ExtractedFact]],
) -> ExtractedFact | None:
    if not normalized_field_key:
        return None
    facts = fact_index.get(normalized_field_key)
    if not facts:
        return None
    return facts[0]


def _source_type_from_fact(fact: ExtractedFact) -> ResolvedCellSourceType:
    if fact.source_type in {"invoice_pattern", "ocr", "heuristic", "ai", "manual"}:
        return fact.source_type
    return "none"


def _fact_confidence(fact: ExtractedFact) -> float | None:
    if fact.confidence is not None:
        return fact.confidence
    return DEFAULT_FACT_CONFIDENCE.get(fact.source_type)


def _fact_value(fact: ExtractedFact) -> Any | None:
    return fact.value if fact.value is not None else fact.text_value


def _fact_source_detail(fact: ExtractedFact) -> str:
    parts = [fact.source_type]
    if fact.pattern_label or fact.pattern_id:
        parts.append(f"pattern={fact.pattern_label or fact.pattern_id}")
    if fact.region_id:
        parts.append(f"region={fact.region_id}")
    if fact.page is not None:
        parts.append(f"page={fact.page}")
    return " | ".join(parts)


def _row_runtime_issues(
    columns: list[InvoiceTemplateColumn], cells: list[ResolvedImportCell]
) -> list[ResolverIssue]:
    by_column_id = {cell.column_id: cell for cell in cells}
    issues: list[ResolverIssue] = []
    required_by_column_id = {column.id: column.required for column in columns}

    for cell in cells:
        if "DATA_TYPE_COERCION_FAILED" not in cell.issue_codes:
            continue
        is_required = required_by_column_id.get(cell.column_id, False)
        issues.append(
            ResolverIssue(
                severity="error" if is_required else "warning",
                code="DATA_TYPE_COERCION_FAILED",
                scope="runtime",
                message=(
                    f"Column {cell.column_label} could not coerce its dry-run "
                    "value to the declared data type."
                ),
                recommendation=(
                    "Adjust the column value, data type, or format before using "
                    "this template operationally."
                ),
                column_id=cell.column_id,
                column_label=cell.column_label,
            )
        )

    for column in columns:
        if not column.required:
            continue
        cell = by_column_id.get(column.id)
        if cell is None or not _has_value(cell.value) or cell.status in {
            "missing",
            "ignored",
        }:
            issues.append(
                ResolverIssue(
                    severity="error",
                    code="REQUIRED_RUNTIME_VALUE_MISSING",
                    scope="runtime",
                    message=(
                        f"Required column {column.name} has no resolved value "
                        "after baseline/default resolution and eligible FILL/action rules."
                    ),
                    recommendation=(
                        "Provide a fixed/default value, extracted fact, catalog "
                        "match, or eligible rule FILL/action before operational export."
                    ),
                    column_id=column.id,
                    column_label=column.name,
                )
            )
            if cell is not None and "REQUIRED_RUNTIME_VALUE_MISSING" not in cell.issue_codes:
                cell.issue_codes.append("REQUIRED_RUNTIME_VALUE_MISSING")
    return issues


def _row_status(
    cells: list[ResolvedImportCell], issues: list[ResolverIssue]
) -> ResolverStatus:
    issue_status = _status_from_issues(issues)
    if issue_status == "blocked":
        return "blocked"
    if any(cell.status == "conflict" for cell in cells):
        return "conflict"
    if issue_status == "needs_review" or any(
        cell.status in {"manual_review", "fallback"} or cell.warnings for cell in cells
    ):
        return "needs_review"
    return "ready"


def _validation_issues_to_resolver(
    issues: list[ImportTemplateValidationIssue],
) -> list[ResolverIssue]:
    return [
        ResolverIssue(
            severity=issue.severity,
            code=issue.code,
            scope="readiness",
            message=issue.message,
            recommendation=issue.recommendation,
            column_id=issue.column_id,
            column_label=issue.column_label,
            rule_id=issue.rule_id,
            rule_label=issue.rule_label,
            field_key=(
                issue.related_id
                if issue.related_type
                in {"extracted_invoice_field", "invoice_pattern_field"}
                else None
            ),
            pattern_id=(
                issue.related_id if issue.related_type == "invoice_pattern" else None
            ),
            path=issue.path,
        )
        for issue in issues
    ]


def _dedupe_issues(issues: list[ResolverIssue]) -> list[ResolverIssue]:
    seen: set[tuple[Any, ...]] = set()
    deduped: list[ResolverIssue] = []
    for issue in issues:
        key = (
            issue.scope,
            issue.severity,
            issue.code,
            issue.column_id,
            issue.rule_id,
            issue.field_key,
            issue.pattern_id,
            issue.path,
            issue.message,
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(issue)
    return deduped


def _status_from_issues(issues: list[ResolverIssue]) -> ResolverStatus:
    severities = {issue.severity for issue in issues}
    if "error" in severities:
        return "blocked"
    if "warning" in severities:
        return "needs_review"
    return "ready"


def _combine_statuses(
    row_statuses: list[ResolverStatus], issues: list[ResolverIssue]
) -> ResolverStatus:
    if any(issue.severity == "error" for issue in issues) or "blocked" in row_statuses:
        return "blocked"
    if "conflict" in row_statuses:
        return "conflict"
    if any(issue.severity == "warning" for issue in issues) or "needs_review" in row_statuses:
        return "needs_review"
    return "ready"


def _average_confidence(cells: list[ResolvedImportCell]) -> float | None:
    values = [cell.confidence for cell in cells if cell.confidence is not None]
    if not values:
        return None
    return sum(values) / len(values)


def _build_summary(
    rows: list[ResolvedImportRow], issues: list[ResolverIssue]
) -> ResolverSummary:
    row_counts = Counter(row.status for row in rows)
    issue_counts = Counter(issue.severity for issue in issues)
    return ResolverSummary(
        row_count=len(rows),
        ready_rows=row_counts["ready"],
        needs_review_rows=row_counts["needs_review"],
        blocked_rows=row_counts["blocked"],
        conflict_rows=row_counts["conflict"],
        error_count=issue_counts["error"],
        warning_count=issue_counts["warning"],
        info_count=issue_counts["info"],
    )
