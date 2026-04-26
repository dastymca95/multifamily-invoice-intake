"""Dry-run skeleton for the future Import Builder resolver.

This module deliberately does not implement rule execution, catalog
matching, OCR, AI, export writes, or Review Queue integration. It only
normalizes the saved template through existing schemas, folds readiness
diagnostics into resolver-shaped issues, and returns one inspectable
placeholder row using safe baseline/fact matching.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.extracted_invoice_fields import normalize_extracted_field_key
from app.models.invoice_template import InvoiceTemplate
from app.schemas.import_resolver import (
    CellProvenance,
    ExtractedFact,
    ResolvedCellSourceType,
    ResolvedImportCell,
    ResolvedImportRow,
    ResolverInput,
    ResolverIssue,
    ResolverResult,
    ResolverStatus,
    ResolverSummary,
)
from app.schemas.invoice_template import (
    ImportTemplateValidationIssue,
    ColumnFormat,
    InvoiceTemplateColumn,
)
from app.services.import_template_validation import validate_import_template


CATALOG_SOURCE_TYPES = {"vendor_field", "property_field", "gl_field"}
DEFAULT_FACT_CONFIDENCE: dict[str, float] = {
    "manual": 1.0,
    "invoice_pattern": 0.9,
    "ocr": 0.7,
    "heuristic": 0.6,
    "ai": 0.4,
}


@dataclass(frozen=True)
class ValueCoercion:
    normalized_value: Any | None
    formatted_value: str | None
    warnings: list[str]
    issue_codes: list[str]
    failed: bool = False


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
                message=(
                    "Resolver input template_id does not match the path-loaded "
                    "template; the path-loaded template was used."
                ),
                recommendation="Omit template_id from the body or send the same id as the path.",
            )
        )

    columns = _parse_columns(template, issues)

    if db is not None:
        readiness = await validate_import_template(template, db)
        issues.extend(_validation_issues_to_resolver(readiness.issues))
    else:
        issues.append(
            ResolverIssue(
                severity="info",
                code="READINESS_VALIDATION_NOT_RUN",
                message="Readiness validation was not run because no database session was provided.",
                recommendation="Call the API endpoint or pass a database session for full readiness diagnostics.",
            )
        )

    fact_index = _build_fact_index(payload.extracted_facts)
    cells = [_resolve_column_baseline(column, fact_index) for column in columns]
    row_issues = _row_runtime_issues(columns, cells)
    row_status = _row_status(cells, row_issues)
    row = ResolvedImportRow(
        row_index=0,
        status=row_status,
        cells=cells,
        issues=row_issues,
        confidence=_average_confidence(cells),
    )

    result_status = _combine_statuses([row.status], issues)
    all_issues = [*issues, *row_issues]
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
                    message=f"Column at position {idx + 1} cannot be read: {exc}",
                    recommendation="Open the template, review the column, and save it again after correcting malformed data.",
                    path=f"columns[{idx}]",
                )
            )
    return parsed


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


def _resolve_column_baseline(
    column: InvoiceTemplateColumn,
    fact_index: dict[str, list[ExtractedFact]],
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
        return _missing_cell(
            column,
            issue_code="CATALOG_MATCHER_NOT_IMPLEMENTED",
            warning="Catalog matching is not implemented in the dry-run skeleton.",
            source_type="catalog",
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
        provenance=provenance,
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
        ),
        warnings=[warning] if warning else [],
        issue_codes=[issue_code],
    )


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
                message=(
                    f"Column {cell.column_label} could not coerce its baseline "
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
                    message=(
                        f"Required column {column.name} has no resolved value "
                        "from the baseline/global phase of this dry run."
                    ),
                    recommendation=(
                        "Provide a fixed/default value, extracted fact, catalog "
                        "match, or future rule fill before operational export. "
                        "Rule execution is not implemented in this dry run yet."
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
