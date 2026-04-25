"""
Coverage derivation: walks every Import Builder template's rule cells
to compute, per template, which fields on a given Invoice Builder
pattern are referenced and which required columns are satisfied vs
missing.

This is the SINGLE derivation point — both the read endpoint
(`GET /invoice-patterns/{id}/import-coverage`) and any future server-
side hook (e.g. cleanup pass for stale bindings) read from here.

Design notes:

  * Pure function. Takes a pattern + a templates list and returns the
    coverage summary; no DB I/O. Lets us unit-test without spinning a
    session and lets the caller batch-load templates as it sees fit.
  * Read-only. Invoice Builder is NEVER allowed to write back into
    Import Builder mappings — this module derives, never mutates.
  * Loose-string `pattern_id` matching. The Invoice Pattern's id is a
    UUID at the model layer, but `extraction_bindings[*].pattern_id`
    is a free-form string for forward-compat. Comparison is by string
    equality after `str()`-ifying the pattern UUID — same posture the
    runtime resolver uses.
  * Stable ordering. Used-field rows appear in the order they're first
    seen walking templates → rules → cells. Lets the frontend cache
    snapshots without re-sorting.
  * Defensive parsing. Templates' `columns` and `rules` come out of
    JSONB — we re-parse through the schema (so the legacy-extraction
    migration validator runs and modern `extraction_bindings` is
    populated even from old single-extraction rows). A malformed row
    is skipped silently rather than failing the whole coverage
    response — coverage is a diagnostic, not a guard.
"""

from __future__ import annotations

from typing import Iterable

from app.domain.extracted_invoice_fields import (
    normalize_extracted_field_key,
    resolve_extracted_field_descriptor,
)
from app.models.invoice_pattern import InvoicePattern
from app.models.invoice_template import InvoiceTemplate
from app.schemas.invoice_pattern import (
    InvoicePatternFieldDefinition,
    build_pattern_field_options,
)
from app.schemas.invoice_pattern_coverage import (
    CoverageStats,
    ImportTemplateCoverageSummary,
    InvoicePatternImportCoverage,
    RequiredColumnCoverage,
    UsedByImportRuleCell,
    UsedFieldCoverage,
)
from app.schemas.invoice_template import (
    InvoiceTemplateColumn,
    InvoiceTemplateRule,
    RuleCellExtractionBinding,
)

# Source types that count as "satisfied by a Reference Data catalog
# binding". Mirrors the schema's `_REF_BINDING_SOURCES` minus
# `invoice_field` (which goes through the extraction branch instead).
_CATALOG_SOURCES: frozenset[str] = frozenset(
    {"vendor_field", "property_field", "gl_field"}
)


def _custom_field_keys(
    field_definitions: list[InvoicePatternFieldDefinition],
) -> set[str]:
    """Pattern-custom keys must not be rewritten through built-in aliases."""

    return {d.key for d in field_definitions if d.type == "custom"}


def _normalize_pattern_field_key(
    field_key: str,
    field_definitions: list[InvoicePatternFieldDefinition],
) -> str:
    """Normalize built-in aliases while preserving pattern custom fields."""

    if field_key in _custom_field_keys(field_definitions):
        return field_key
    return normalize_extracted_field_key(field_key) or field_key


def _resolve_field_label(
    field_key: str,
    field_definitions: list[InvoicePatternFieldDefinition],
) -> str:
    """Pick a friendly display label for a `field_key`.

    Resolution order — pattern-level override (label or custom field's
    label) → canonical built-in label → the slug itself. Mirrors what
    `resolveFieldList` does on the frontend so the Coverage panel and
    the region inspector agree on names without an extra round-trip.
    """
    for d in field_definitions:
        if d.key == field_key:
            return d.label
    normalized = _normalize_pattern_field_key(field_key, field_definitions)
    for d in field_definitions:
        if d.key == normalized:
            return d.label
    descriptor = resolve_extracted_field_descriptor(normalized)
    if descriptor is not None:
        return descriptor.label
    return field_key


def _column_has_action_rule_value(
    column_id: str, rules: Iterable[InvoiceTemplateRule]
) -> bool:
    """True iff any rule cell under this column carries values OR selections.

    Used as a fallback signal for the `satisfied_by_manual_or_rule`
    branch — a column whose source_type isn't an obvious provider but
    whose rule cells carry literal values or catalog selections has at
    least one author-declared path to a value.

    Independent of `allow_rule_override` on purpose — the override flag
    governs RESOLVER behavior at runtime; the coverage view reflects
    AUTHOR intent (what they typed), so cells are counted regardless
    of whether the resolver would honor them.
    """
    for rule in rules:
        cell = rule.cells.get(column_id)
        if cell is None:
            continue
        if cell.values or cell.selections:
            return True
    return False


def _classify_column(
    column: InvoiceTemplateColumn,
    rules: list[InvoiceTemplateRule],
    *,
    pattern_extraction_field_key: str | None,
) -> tuple[str, str | None]:
    """Pick the satisfaction status for a column.

    Resolution order (each branch wins over those below):

      1. Extraction via THIS pattern. Caller passes the resolved
         `field_key` (or None if no rule cell binding under this
         column points at the current pattern). Wins because it's the
         most specific binding to the pattern in scope.
      2. Column has a non-empty `default_value` (typically
         `fixed_value` source_type). Strongest non-pattern signal — a
         hard-coded value always wins at runtime.
      3. Column source_type is `fixed_value` even with empty default
         value — the empty string is still author-declared "always
         emit nothing here", which is a satisfied state, not missing.
      4. Column is catalog-bound (vendor / property / gl_field). The
         binding is declared even if the operator hasn't picked a
         specific catalog yet (`source_ref.catalog_id` is a save-time
         UX gate, not a Pydantic constraint).
      5. Column is `manual_list` with values, OR a rule cell under
         this column has values / selections. Both are author-declared
         paths to a value at runtime.
      6. Column source_type is `invoice_field` (broad-universe
         extraction; not bound to this specific pattern but still has
         a path to a value at runtime). Reported as
         `satisfied_by_extraction` with `extraction_field_key=None` so
         the UI can render "via broad-universe extraction".
      7. Otherwise `missing`.

    Returns `(status_literal, extraction_field_key | None)`.
    """
    if pattern_extraction_field_key is not None:
        return ("satisfied_by_extraction", pattern_extraction_field_key)
    if column.default_value:
        return ("satisfied_by_default", None)
    if column.source_type == "fixed_value":
        # Empty default for fixed_value is still author-declared —
        # treat as default-satisfied rather than missing.
        return ("satisfied_by_default", None)
    if column.source_type in _CATALOG_SOURCES:
        return ("satisfied_by_catalog", None)
    if column.source_type == "manual_list" and column.manual_values:
        return ("satisfied_by_manual_or_rule", None)
    if _column_has_action_rule_value(column.id, rules):
        return ("satisfied_by_manual_or_rule", None)
    if column.source_type == "invoice_field":
        return ("satisfied_by_extraction", None)
    return ("missing", None)


def _parse_template_rules(
    raw_rules: list | None,
) -> list[InvoiceTemplateRule]:
    """Re-parse rules out of JSONB through the Pydantic schema.

    Going through the model fires the `_promote_legacy_extraction`
    validator — so coverage sees modern `extraction_bindings` even on
    rows persisted before the multi-binding refactor. A malformed rule
    is skipped (the editor will surface it on next open); coverage is a
    read-side diagnostic that shouldn't crash on a single bad row.
    """
    parsed: list[InvoiceTemplateRule] = []
    for raw in raw_rules or []:
        try:
            parsed.append(InvoiceTemplateRule.model_validate(raw))
        except Exception:
            continue
    return parsed


def _parse_template_columns(
    raw_columns: list | None,
) -> list[InvoiceTemplateColumn]:
    """Defensive re-parse for columns. See `_parse_template_rules`."""
    parsed: list[InvoiceTemplateColumn] = []
    for raw in raw_columns or []:
        try:
            parsed.append(InvoiceTemplateColumn.model_validate(raw))
        except Exception:
            continue
    return parsed


def _bindings_match_pattern(
    bindings: list[RuleCellExtractionBinding], pattern_id_str: str
) -> list[RuleCellExtractionBinding]:
    """Filter to bindings whose `pattern_id` equals the given string.

    Bindings with a missing pattern_id (in-progress picker state) are
    excluded — they're not yet pinned to anything. Field_key being
    empty is filtered separately at the consumer site since "binding
    pinned to pattern but field not yet picked" is still meaningful
    for the "linked to this pattern" overlay badge.
    """
    out: list[RuleCellExtractionBinding] = []
    for b in bindings:
        if b.pattern_id and b.pattern_id == pattern_id_str:
            out.append(b)
    return out


def _build_template_summary(
    pattern: InvoicePattern,
    template: InvoiceTemplate,
    field_definitions: list[InvoicePatternFieldDefinition],
) -> ImportTemplateCoverageSummary:
    """Compute one template's coverage view of this pattern."""
    pattern_id_str = str(pattern.id)
    columns = _parse_template_columns(template.columns)
    rules = _parse_template_rules(template.rules)

    column_by_id: dict[str, InvoiceTemplateColumn] = {c.id: c for c in columns}

    # First-seen field_key per column — pinned as the column's
    # `extraction_field_key` for the required-column row. If a column
    # has multiple bindings to this pattern across different rules,
    # the FIRST one wins for the pin (deterministic; rule order in the
    # template UI is the priority order at runtime).
    column_first_field: dict[str, str] = {}
    # Used-by rows grouped by field_key, in stable first-seen order.
    used_by_per_field: dict[str, list[UsedByImportRuleCell]] = {}
    used_field_order: list[str] = []

    for rule_idx, rule in enumerate(rules, start=1):
        for column_id, cell in rule.cells.items():
            if not cell.extraction_bindings:
                continue
            matches = _bindings_match_pattern(
                cell.extraction_bindings, pattern_id_str
            )
            if not matches:
                continue
            column = column_by_id.get(column_id)
            if column is None:
                # Cell references a column that no longer exists on
                # the template (the editor scrubs these on column
                # delete; this path catches a stale parsed-orphan).
                continue
            for binding in matches:
                raw_fk = binding.field_key
                if not raw_fk:
                    # In-progress binding with pattern picked but field
                    # not yet picked — counts toward "this pattern is
                    # linked to this column" but not toward a specific
                    # field's used_by list.
                    continue
                fk = _normalize_pattern_field_key(raw_fk, field_definitions)
                column_first_field.setdefault(column_id, fk)
                pointer = UsedByImportRuleCell(
                    template_id=template.id,
                    template_name=template.name,
                    rule_id=rule.id,
                    rule_index=rule_idx,
                    column_id=column.id,
                    column_name=column.name,
                    column_required=column.required,
                )
                if fk not in used_by_per_field:
                    used_by_per_field[fk] = []
                    used_field_order.append(fk)
                used_by_per_field[fk].append(pointer)

    used_fields: list[UsedFieldCoverage] = [
        UsedFieldCoverage(
            field_key=fk,
            field_label=_resolve_field_label(fk, field_definitions),
            used_by=used_by_per_field[fk],
        )
        for fk in used_field_order
    ]

    # Required-column classification.
    required_columns: list[RequiredColumnCoverage] = []
    missing_required: list[RequiredColumnCoverage] = []
    for column in columns:
        if not column.required:
            continue
        pinned_field = column_first_field.get(column.id)
        status, ext_field = _classify_column(
            column, rules, pattern_extraction_field_key=pinned_field
        )
        row = RequiredColumnCoverage(
            column_id=column.id,
            column_name=column.name,
            data_type=column.data_type,
            source_type=column.source_type,
            required=column.required,
            status=status,  # type: ignore[arg-type]
            extraction_field_key=ext_field,
        )
        required_columns.append(row)
        if status == "missing":
            missing_required.append(row)

    # Per-template stats. `total_fields_in_pattern` is the size of the
    # pattern's resolved field universe — same denominator the panel
    # header uses for "X of Y fields used".
    field_options = build_pattern_field_options(field_definitions)
    total_fields_in_pattern = len(field_options)
    used_count = len(used_field_order)
    unused_count = max(0, total_fields_in_pattern - used_count)
    coverage = CoverageStats(
        total_fields_in_pattern=total_fields_in_pattern,
        used_fields_count=used_count,
        unused_fields_count=unused_count,
        total_required_columns=len(required_columns),
        satisfied_required_columns=(
            len(required_columns) - len(missing_required)
        ),
        missing_required_columns=len(missing_required),
    )

    return ImportTemplateCoverageSummary(
        template_id=template.id,
        template_name=template.name,
        used_field_keys=list(used_field_order),
        used_fields=used_fields,
        required_columns=required_columns,
        missing_required_columns=missing_required,
        coverage=coverage,
    )


def compute_pattern_import_coverage(
    pattern: InvoicePattern,
    templates: list[InvoiceTemplate],
) -> InvoicePatternImportCoverage:
    """Top-level entry: build the full coverage response.

    Caller filters `templates` to one row when the request carries
    `?template_id=`. This function never filters — it computes for
    whatever it's given, in the order given. That keeps the rendering
    contract clear: response order = caller's order.
    """
    field_definitions = [
        InvoicePatternFieldDefinition.model_validate(d)
        for d in (pattern.field_definitions or [])
    ]

    summaries: list[ImportTemplateCoverageSummary] = [
        _build_template_summary(pattern, template, field_definitions)
        for template in templates
    ]

    # Aggregate stats across the templates returned. `used_fields_count`
    # is the de-duped count of field_keys touched by ANY template in
    # the response — gives a clean "this pattern's reach" number for
    # the panel summary.
    field_options = build_pattern_field_options(field_definitions)
    total_fields_in_pattern = len(field_options)
    used_keys_global: set[str] = set()
    total_required = 0
    satisfied_required = 0
    missing_required = 0
    for s in summaries:
        used_keys_global.update(s.used_field_keys)
        total_required += s.coverage.total_required_columns
        satisfied_required += s.coverage.satisfied_required_columns
        missing_required += s.coverage.missing_required_columns
    aggregate = CoverageStats(
        total_fields_in_pattern=total_fields_in_pattern,
        used_fields_count=len(used_keys_global),
        unused_fields_count=max(
            0, total_fields_in_pattern - len(used_keys_global)
        ),
        total_required_columns=total_required,
        satisfied_required_columns=satisfied_required,
        missing_required_columns=missing_required,
    )

    return InvoicePatternImportCoverage(
        pattern_id=str(pattern.id),
        pattern_name=pattern.name,
        templates=summaries,
        aggregate=aggregate,
    )
