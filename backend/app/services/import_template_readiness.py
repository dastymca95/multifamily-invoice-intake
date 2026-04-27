"""Backend readiness preview service.

Phase 1C — pure / non-mutating evaluation of an Import Template
payload (saved or in-flight). Mirrors the per-column readiness
contract the wizard currently computes locally in
``ColumnInspector.tsx`` so the UI can swap to the canonical backend
verdict in a future phase without rewriting the rendering layer.

What this service does:
  * Walk every column.
  * Run structural checks (name, data_type, dropdown options, etc.).
  * Dispatch through the :class:`ValueSource` substrate for the
    column's source kind to derive a baseline verdict.
  * Walk rules to detect FILL/Action paths that satisfy required
    columns lacking a global default.
  * Combine into a per-column :class:`ColumnReadinessOut` and a
    template-level rollup.

What this service explicitly does NOT do:
  * Touch the database (catalog existence is NOT validated; that is
    a future-phase enhancement).
  * Run OCR / AI / any extraction pipeline.
  * Call the resolver dry-run.
  * Apply rules with runtime extracted facts. Rule analysis is
    purely structural — "is there a FILL cell with a value?" — not
    "would this rule actually match this invoice?".
  * Mutate the input.

The goal is template readiness ("is this template configured in a
way that *can* resolve?"), not scenario resolution ("what would Dry
Run output for THIS invoice?").
"""

from __future__ import annotations

from typing import Iterable

from app.domain.value_source import (
    BaselineEvaluation,
    ValueSourceKind,
    get_value_source,
)
from app.schemas.import_readiness import (
    ColumnReadinessOut,
    ImportTemplateReadinessPreviewRequest,
    ImportTemplateReadinessPreviewResponse,
    ReadinessCategory,
    ReadinessItemOut,
    ReadinessStatus,
    ReadinessSummary,
    ResolverExpectation,
    ValueSourceVerdictOut,
)
from app.schemas.invoice_template import (
    InvoiceTemplateColumn,
    InvoiceTemplateRule,
    InvoiceTemplateRuleCell,
    effective_rule_cell_role,
)


# ---------------------------------------------------------------------------
# Status promotion helpers
# ---------------------------------------------------------------------------


def _promote(*statuses: ReadinessStatus) -> ReadinessStatus:
    """Take the worst status across the inputs.

    ``blocked > warning > ready``. Used to roll up per-item statuses
    into per-column status, and per-column statuses into the template
    status.
    """
    has_blocked = any(s == "blocked" for s in statuses)
    if has_blocked:
        return "blocked"
    if any(s == "warning" for s in statuses):
        return "warning"
    return "ready"


def _summarize_items(items: Iterable[ReadinessItemOut]) -> ReadinessStatus:
    """Worst status across a sequence of readiness items."""
    return _promote(*(item.status for item in items))


# ---------------------------------------------------------------------------
# Cell-has-value semantics (mirror resolver._has_value for cells)
# ---------------------------------------------------------------------------


def _cell_has_value(cell: InvoiceTemplateRuleCell) -> bool:
    """Mirrors the resolver's "is this cell non-empty?" rules.

    A cell counts as carrying a value if ANY of:
      * literal ``values[i]`` has non-whitespace content
      * ``selections[i]`` has a usable ``field_value`` or ``entry_id``
      * ``extraction_bindings[i]`` exists (resolved at runtime)
      * legacy ``extraction.{pattern_id|field_key}`` is set
    """
    values = getattr(cell, "values", None) or []
    if any(isinstance(v, str) and v.strip() for v in values):
        return True

    selections = getattr(cell, "selections", None) or []
    for selection in selections:
        field_value = getattr(selection, "field_value", None)
        entry_id = getattr(selection, "entry_id", None)
        if (isinstance(field_value, str) and field_value.strip()) or (
            isinstance(entry_id, str) and entry_id.strip()
        ):
            return True

    bindings = getattr(cell, "extraction_bindings", None) or []
    if bindings:
        return True

    legacy = getattr(cell, "extraction", None)
    if legacy is not None:
        if getattr(legacy, "pattern_id", None) or getattr(
            legacy, "field_key", None
        ):
            return True

    return False


# ---------------------------------------------------------------------------
# Rule-fill analysis
# ---------------------------------------------------------------------------


class _RuleFillMatch:
    """Lightweight record for one FILL match against a column.

    Avoids a dataclass to keep this internal — only the readiness
    service consumes it.
    """

    __slots__ = ("rule_id", "rule_index", "conditional", "gating_summary")

    def __init__(
        self,
        rule_id: str,
        rule_index: int,
        conditional: bool,
        gating_summary: str,
    ):
        self.rule_id = rule_id
        self.rule_index = rule_index
        self.conditional = conditional
        self.gating_summary = gating_summary


def _find_rule_fill_paths(
    column: InvoiceTemplateColumn,
    columns: list[InvoiceTemplateColumn],
    rules: list[InvoiceTemplateRule],
) -> list[_RuleFillMatch]:
    """Walk every active rule for FILL/Action cells targeting ``column``.

    Mirrors the frontend wizard's ``findRuleFillPaths`` semantics:
      * Only ``column.allow_rule_override`` columns are eligible
        (defaults to True; if False, rule actions are ignored).
      * The cell at ``column.id`` must have ``effective_rule_cell_role``
        of ``"action"``.
      * The cell must carry a value (literal / selection / binding).

    Each match records whether the surrounding rule is *gated* by
    sibling cells with non-empty content + role ``"condition"`` /
    ``"restriction"``. Gated rules are conditional fills; ungated
    rules are unconditional fills.
    """

    if column.allow_rule_override is False:
        return []
    columns_by_id = {col.id: col for col in columns}
    matches: list[_RuleFillMatch] = []

    for index, rule in enumerate(rules):
        if not getattr(rule, "is_active", True):
            continue
        cells = getattr(rule, "cells", {}) or {}
        cell = cells.get(column.id)
        if cell is None:
            continue
        role = effective_rule_cell_role(cell, column)
        if role != "action":
            continue
        if not _cell_has_value(cell):
            continue

        # Detect gating siblings — non-empty cells with role
        # condition/restriction in the SAME rule.
        gating_labels: list[str] = []
        for sibling_id, sibling_cell in cells.items():
            if sibling_id == column.id:
                continue
            if not _cell_has_value(sibling_cell):
                continue
            sibling_col = columns_by_id.get(sibling_id)
            sibling_role = effective_rule_cell_role(sibling_cell, sibling_col)
            if sibling_role in ("condition", "restriction"):
                col_name = (
                    (sibling_col.name or "(unnamed)")
                    if sibling_col is not None
                    else "(unknown column)"
                )
                role_word = "IF" if sibling_role == "condition" else "LIMIT"
                gating_labels.append(f"{role_word} {col_name}")

        gating_summary = ""
        if gating_labels:
            shown = gating_labels[:3]
            extra = len(gating_labels) - len(shown)
            gating_summary = " · ".join(shown)
            if extra > 0:
                gating_summary += f" · +{extra} more"

        matches.append(
            _RuleFillMatch(
                rule_id=getattr(rule, "id", str(index)),
                rule_index=index,
                conditional=bool(gating_labels),
                gating_summary=gating_summary,
            )
        )

    return matches


# ---------------------------------------------------------------------------
# Item builders
# ---------------------------------------------------------------------------


def _structure_items(
    column: InvoiceTemplateColumn, column_index: int
) -> list[ReadinessItemOut]:
    """Per-column structural readiness items.

    Pure column-shape checks: name present, data_type set, dropdown
    options present when applicable. These mirror the wizard's
    Step-1 / Step-2 readiness items.
    """

    items: list[ReadinessItemOut] = []
    path_root = f"columns[{column_index}]"

    name_clean = (column.name or "").strip()
    items.append(
        ReadinessItemOut(
            category="structure",
            status="ready" if name_clean else "blocked",
            code="READINESS_COLUMN_NAME_MISSING" if not name_clean else None,
            message=(
                "Column has a name."
                if name_clean
                else "Column is missing a name."
            ),
            recommendation=(
                None
                if name_clean
                else "Pick a name for this column in Step 1."
            ),
            fix_step=1,
            column_id=column.id,
            path=f"{path_root}.name",
        )
    )

    data_type = column.data_type or "text"
    items.append(
        ReadinessItemOut(
            category="structure",
            status="ready",
            message=f"Data type: {data_type}",
            fix_step=1,
            column_id=column.id,
            path=f"{path_root}.data_type",
        )
    )

    if data_type in ("dropdown", "multi_select"):
        format_ = column.format
        list_options = (
            getattr(format_, "list_options", None) if format_ else None
        ) or []
        non_blank = [v for v in list_options if isinstance(v, str) and v.strip()]
        if not non_blank:
            label = (
                "Multi-select" if data_type == "multi_select" else "Dropdown"
            )
            items.append(
                ReadinessItemOut(
                    category="structure",
                    status="blocked",
                    code="DROPDOWN_OPTIONS_EMPTY",
                    message=f"{label} options are missing.",
                    detail=(
                        "Add at least one allowed value or change the "
                        "data type."
                    ),
                    recommendation=(
                        "Use the Allowed values editor in Step 2."
                    ),
                    fix_step=2,
                    column_id=column.id,
                    path=f"{path_root}.format.list_options",
                )
            )
        else:
            blanks = len(list_options) - len(non_blank)
            if blanks > 0:
                items.append(
                    ReadinessItemOut(
                        category="structure",
                        status="warning",
                        code="DROPDOWN_OPTIONS_BLANKS",
                        message=(
                            f"{blanks} blank option"
                            f"{'' if blanks == 1 else 's'} in the allowed list."
                        ),
                        detail=(
                            "Blank entries are stripped on save — fill "
                            "them in or remove the row."
                        ),
                        fix_step=2,
                        column_id=column.id,
                        path=f"{path_root}.format.list_options",
                    )
                )
            else:
                items.append(
                    ReadinessItemOut(
                        category="structure",
                        status="ready",
                        message=(
                            f"{len(non_blank)} allowed value"
                            f"{'' if len(non_blank) == 1 else 's'} configured."
                        ),
                        fix_step=2,
                        column_id=column.id,
                        path=f"{path_root}.format.list_options",
                    )
                )

    return items


def _verdict_to_value_source(
    verdict: BaselineEvaluation,
    column: InvoiceTemplateColumn,
    source_kind: ValueSourceKind,
    needs_runtime_input: bool,
) -> ValueSourceVerdictOut:
    """Translate substrate :class:`BaselineEvaluation` into the API
    :class:`ValueSourceVerdictOut` shape.

    The headline status reflects the COLUMN'S OWN CONFIGURATION
    SHAPE — not whether the column is required / will-resolve at
    runtime. Required-column burden (will-be-missing,
    may-be-missing) is carried by dedicated advisory items emitted
    in :func:`_required_column_items`, and rule-rescue rewrites
    happen in :func:`_compute_expectation`.

    Mapping:
      * ``resolves``        → ready (conditional iff the kind itself
                              expects runtime input).
      * ``needs_runtime``   → ready + conditional (config is fine;
                              resolution depends on runtime hint /
                              fact).
      * ``needs_review``    → warning (operator must take action).
      * ``incomplete``      → blocked (config is unfinished —
                              applies regardless of required).
      * ``missing``         → ready (optional+missing is fine; the
                              required gate is carried by the
                              REQUIRED_RUNTIME_VALUE_MISSING advisory
                              when no rule rescue exists).
      * ``not_implemented`` → blocked if required, warning if
                              optional (derived placeholder is
                              never silently OK).
    """
    label = verdict.detail or _default_label_for_outcome(verdict.outcome)
    status: ReadinessStatus
    conditional = False
    if verdict.outcome == "resolves":
        status = "ready"
        conditional = needs_runtime_input
    elif verdict.outcome == "needs_runtime":
        status = "ready"
        conditional = True
    elif verdict.outcome == "needs_review":
        status = "warning"
    elif verdict.outcome == "incomplete":
        status = "blocked"
    elif verdict.outcome == "missing":
        # Headline is ready — the required-column advisory + rule
        # rescue logic decide the actual column status downstream.
        # Optional columns with no source are a valid configuration.
        status = "ready"
    elif verdict.outcome == "not_implemented":
        status = "blocked" if column.required else "warning"
    else:
        status = "warning"
    return ValueSourceVerdictOut(
        kind=source_kind,
        status=status,
        label=label,
        detail=verdict.detail or None,
        conditional=conditional,
    )


def _default_label_for_outcome(outcome: str) -> str:
    return {
        "resolves": "Resolvable baseline",
        "needs_runtime": "Needs runtime input",
        "needs_review": "Needs operator selection",
        "incomplete": "Configuration incomplete",
        "missing": "No source",
        "not_implemented": "Not implemented",
    }.get(outcome, "Unknown")


def _value_source_items(
    column: InvoiceTemplateColumn,
    column_index: int,
    verdict: BaselineEvaluation,
    value_source: ValueSourceVerdictOut,
) -> list[ReadinessItemOut]:
    """Per-column value-source items from the substrate verdict.

    Emits:
      * One headline item carrying the verdict's label/detail.
      * One declared issue code per ``verdict.issue_codes`` entry.
    """

    items: list[ReadinessItemOut] = []
    path = f"columns[{column_index}].source_type"

    headline_status: ReadinessStatus = value_source.status
    items.append(
        ReadinessItemOut(
            category="value_source",
            status=headline_status,
            message=value_source.label,
            detail=value_source.detail,
            fix_step=3,
            column_id=column.id,
            path=path,
        )
    )

    for code in verdict.issue_codes:
        items.append(
            ReadinessItemOut(
                category="value_source",
                # Issue-code items inherit the headline status — the
                # substrate emits codes at the same severity tier the
                # headline already records.
                status=headline_status,
                code=code,
                message=_message_for_code(code),
                fix_step=3,
                column_id=column.id,
                path=path,
            )
        )

    return items


def _message_for_code(code: str) -> str:
    """Stable per-code operator-facing message."""
    return {
        "VALUE_NOT_RESOLVED": (
            "Column has no source; rules must FILL the value."
        ),
        "FIXED_VALUE_EMPTY": (
            "Fixed-value source has no value configured."
        ),
        "MANUAL_VALUE_REQUIRED": (
            "Manual-list source is selected but no values are "
            "configured."
        ),
        "MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION": (
            "Manual-list source has multiple values and no matching "
            "column-level default."
        ),
        "INVOICE_FIELD_FACT_NOT_FOUND": (
            "Resolver expects an extracted fact for this column at "
            "runtime."
        ),
        "EXTRACTED_FACT_SOURCE_UNKNOWN": (
            "Extracted fact carries an unknown source type."
        ),
        "CATALOG_NOT_CONFIGURED": (
            "Catalog-backed column has no catalog selected."
        ),
        "SOURCE_CATALOG_FIELD_MISSING": (
            "Catalog-backed column has no catalog field selected."
        ),
        "CATALOG_FIELD_NOT_FOUND": (
            "Catalog field is not part of the canonical schema."
        ),
        "CATALOG_HINT_MISSING": (
            "Catalog lookup needs a runtime hint to match an entry."
        ),
        "CATALOG_ENTRY_NOT_FOUND": (
            "Catalog hint did not match any entry."
        ),
        "CATALOG_ENTRY_AMBIGUOUS": (
            "Catalog hint matched multiple entries."
        ),
        "CATALOG_VALUE_MISSING": (
            "Matched catalog entry is missing the bound field value."
        ),
        "CATALOG_NOT_FOUND": (
            "Bound catalog no longer exists in the database."
        ),
        "CATALOG_MATCHER_NOT_IMPLEMENTED": (
            "Catalog lookup requires a database session at resolve time."
        ),
        "DERIVED_RESOLVER_NOT_IMPLEMENTED": (
            "Derived sources are not yet implemented in the resolver."
        ),
    }.get(code, code)


def _rule_runtime_items(
    column: InvoiceTemplateColumn,
    column_index: int,
    verdict: BaselineEvaluation,
    value_source: ValueSourceVerdictOut,
    fills: list[_RuleFillMatch],
    rules_count: int,
) -> list[ReadinessItemOut]:
    """Per-column rule-runtime readiness items.

    Mirrors the wizard's "C. Rule runtime" group:
      * Reports whether any FILL/Action rule writes the column.
      * Demotes conditional-fill warnings to informational when an
        unconditional baseline already resolves the column.
      * Surfaces required + IF/LIMIT-only as a warning.
      * Surfaces FILL role + no rule cell carrying a value as a
        warning.

    ``has_resolvable_baseline`` is derived from the underlying
    substrate verdict (``resolves``) rather than ``value_source.status``,
    because the headline status carries the COLUMN'S CONFIG SHAPE
    only — for ``missing`` outcomes the headline is ``ready`` while
    the actual baseline is absent. Using ``verdict.outcome`` here
    keeps "is there a real baseline?" semantically clean.
    """

    items: list[ReadinessItemOut] = []
    has_resolvable_baseline = verdict.outcome == "resolves"
    role = (column.default_rule_role or column.rule_role) or None
    sourceless = (column.source_type or "empty") == "empty"

    unconditional = [m for m in fills if not m.conditional]
    conditional = [m for m in fills if m.conditional]

    if not fills and rules_count > 0:
        items.append(
            ReadinessItemOut(
                category="rule_runtime",
                status="ready",
                message="No rule FILLs this column.",
                detail=(
                    "Optional. Step 3's default already resolves "
                    "the column."
                    if has_resolvable_baseline
                    else "Add a FILL/Action cell in Step 4 if rules "
                    "should write this column."
                ),
                fix_step=4,
                column_id=column.id,
            )
        )
    if unconditional:
        items.append(
            ReadinessItemOut(
                category="rule_runtime",
                status="ready",
                code="READINESS_UNCONDITIONAL_FILL",
                message=(
                    f"{len(unconditional)} rule"
                    f"{'' if len(unconditional) == 1 else 's'} "
                    f"write{'s' if len(unconditional) == 1 else ''} this "
                    "column unconditionally."
                ),
                detail=(
                    "Always fills regardless of which conditions match."
                ),
                fix_step=4,
                column_id=column.id,
                rule_id=unconditional[0].rule_id,
            )
        )
    if conditional:
        sample = conditional[0]
        if has_resolvable_baseline:
            # Default is doing the work — the conditional rules are
            # OPTIONAL overrides, not gaps.
            items.append(
                ReadinessItemOut(
                    category="rule_runtime",
                    status="ready",
                    code="READINESS_CONDITIONAL_FILL_OVERRIDE",
                    message=(
                        f"{len(conditional)} rule"
                        f"{'' if len(conditional) == 1 else 's'} can "
                        "override the default under conditions."
                    ),
                    detail=(
                        f"Sample: Rule {sample.rule_index + 1} fires "
                        f"when {sample.gating_summary} — Step 3's "
                        "default fills the rest."
                        if sample.gating_summary
                        else "Step 3's default fills the column when "
                        "these rules don't match."
                    ),
                    fix_step=4,
                    column_id=column.id,
                    rule_id=sample.rule_id,
                )
            )
        else:
            items.append(
                ReadinessItemOut(
                    category="rule_runtime",
                    status="warning",
                    code="READINESS_CONDITIONAL_FILL_ONLY",
                    message=(
                        f"{len(conditional)} rule"
                        f"{'' if len(conditional) == 1 else 's'} fill"
                        f"{'s' if len(conditional) == 1 else ''} this "
                        "column under conditions."
                    ),
                    detail=(
                        f"Sample: Rule {sample.rule_index + 1} only "
                        f"fires when {sample.gating_summary}."
                        if sample.gating_summary
                        else "These FILLs only fire when their IF/LIMIT "
                        "cells match."
                    ),
                    recommendation=(
                        "Provide matching Dry Run inputs, or add a "
                        "default source in Step 3."
                    ),
                    fix_step=4,
                    column_id=column.id,
                    rule_id=sample.rule_id,
                )
            )

    # IF/LIMIT default role on a sourceless required column without
    # an unconditional fill — mirrors the wizard's role-coherence
    # warning.
    if (
        column.required
        and role in ("condition", "restriction")
        and sourceless
        and not unconditional
        and not has_resolvable_baseline
    ):
        role_label = "IF (Condition)" if role == "condition" else "LIMIT (Restriction)"
        items.append(
            ReadinessItemOut(
                category="rule_runtime",
                status="warning",
                code="READINESS_IF_LIMIT_DOES_NOT_FILL",
                message=f"{role_label} does not fill required columns.",
                detail=(
                    "Condition and Restriction roles never write a "
                    "value. Switch to FILL (Action) or add a default "
                    "source in Step 3."
                ),
                fix_step=4,
                column_id=column.id,
            )
        )

    # FILL role with no rule actually carrying a value.
    if (
        role == "action"
        and sourceless
        and not fills
        and rules_count > 0
        and not has_resolvable_baseline
    ):
        items.append(
            ReadinessItemOut(
                category="rule_runtime",
                status="warning",
                code="READINESS_FILL_ROLE_NO_VALUE",
                message=(
                    "Default role is FILL, but no rule cell carries a "
                    "value."
                ),
                detail=(
                    "Add a value, catalog selection, or extraction "
                    "binding to a rule cell in this column."
                ),
                fix_step=4,
                column_id=column.id,
            )
        )

    return items


# ---------------------------------------------------------------------------
# Required-column advisory items
# ---------------------------------------------------------------------------


def _required_column_items(
    column: InvoiceTemplateColumn,
    expectation: ResolverExpectation,
) -> list[ReadinessItemOut]:
    """Emit per-column required-burden advisory items.

    Mirrors the resolver's ``REQUIRED_RUNTIME_VALUE_MISSING`` gate
    AND adds a softer ``READINESS_REQUIRED_RUNTIME_DEPENDENT``
    advisory for required columns whose configuration is sound but
    whose resolution depends on a runtime input or matching rule.

    The wizard's local helpers historically emitted nothing for the
    "required + may_be_missing + global verdict ok" case (catalog /
    invoice_field columns), which is exactly the drift Phase 1C
    closes — the operator now sees a yellow advisory, the column
    rolls up as warning, and Step 5 reports honestly that the
    column may not resolve at runtime.
    """
    if not column.required:
        return []
    if expectation == "will_be_missing":
        return [
            ReadinessItemOut(
                category="value_source",
                status="blocked",
                code="REQUIRED_RUNTIME_VALUE_MISSING",
                message="Required column has no resolvable value path.",
                detail=(
                    "Add a default source in Step 3, or add a rule "
                    "with a FILL/Action cell that writes this column."
                ),
                fix_step=3,
                column_id=column.id,
            )
        ]
    if expectation == "may_be_missing":
        return [
            ReadinessItemOut(
                category="value_source",
                status="warning",
                code="READINESS_REQUIRED_RUNTIME_DEPENDENT",
                message="Required column depends on a runtime input.",
                detail=(
                    "Configuration is correct, but the column resolves "
                    "only when an extracted fact / catalog hint is "
                    "provided OR a matching rule fires. Dry Run may "
                    "report this column as missing without those "
                    "inputs."
                ),
                fix_step=3,
                column_id=column.id,
            )
        ]
    return []


# ---------------------------------------------------------------------------
# Expectation derivation
# ---------------------------------------------------------------------------


def _compute_expectation(
    column: InvoiceTemplateColumn,
    verdict: BaselineEvaluation,
    value_source: ValueSourceVerdictOut,
    fills: list[_RuleFillMatch],
) -> tuple[ResolverExpectation, str, str]:
    """Map the substrate verdict + rule fills into a single
    ``ResolverExpectation`` triple ``(expectation, label, detail)``.

    Decision ladder (strongest first):
      1. Substrate verdict resolves baseline (no runtime needed) →
         should_resolve.
      2. At least one unconditional rule FILL → should_resolve.
      3. Substrate verdict needs runtime input → may_be_missing.
      4. At least one conditional rule FILL only → may_be_missing.
      5. Required column with nothing usable → will_be_missing.
      6. Optional column with nothing usable → may_be_missing
         (informational only — operator chose this).
    """

    has_unconditional_fill = any(not m.conditional for m in fills)
    has_conditional_fill = any(m.conditional for m in fills)

    if verdict.outcome == "resolves":
        return (
            "should_resolve",
            "Should resolve",
            f"Global source provides {value_source.label} before any rule runs.",
        )
    if has_unconditional_fill:
        return (
            "should_resolve",
            "Should resolve",
            "An unconditional rule FILL writes this column on every row.",
        )
    if verdict.outcome == "needs_runtime":
        return (
            "may_be_missing",
            "May be missing without a runtime input",
            (
                "Global source needs the right runtime input "
                "(extracted fact or catalog hint). Provide one in Dry "
                "Run, or add a rule fallback."
            ),
        )
    if has_conditional_fill:
        sample = next(m for m in fills if m.conditional)
        rule_label = f"Rule {sample.rule_index + 1}"
        if sample.gating_summary:
            detail = (
                f"{rule_label} only fires when its conditions match "
                f"({sample.gating_summary}). Provide matching Dry Run "
                "inputs or add a default source."
            )
        else:
            detail = (
                "FILL rules in this column are gated by IF/LIMIT cells. "
                "Provide matching Dry Run inputs or add a default source."
            )
        return (
            "may_be_missing",
            f"May be missing unless {rule_label} matches",
            detail,
        )
    if column.required:
        return (
            "will_be_missing",
            "Will be missing in Dry Run",
            (
                "Required column with no resolvable global source and "
                "no FILL rule. Add a default in Step 3 or a FILL rule "
                "that writes this column."
            ),
        )
    return (
        "may_be_missing",
        "Has no value source",
        "No source configured. Optional columns are fine without one.",
    )


# ---------------------------------------------------------------------------
# Per-column evaluation
# ---------------------------------------------------------------------------


def _evaluate_column(
    column: InvoiceTemplateColumn,
    column_index: int,
    columns: list[InvoiceTemplateColumn],
    rules: list[InvoiceTemplateRule],
) -> ColumnReadinessOut:
    source_kind = (column.source_type or "empty")
    source_cls = get_value_source(source_kind)
    verdict = source_cls.evaluate_baseline(column)
    value_source = _verdict_to_value_source(
        verdict,
        column,
        source_kind,  # type: ignore[arg-type]
        source_cls.needs_runtime_input,
    )

    items: list[ReadinessItemOut] = []
    items.extend(_structure_items(column, column_index))
    items.extend(_value_source_items(column, column_index, verdict, value_source))

    fills = _find_rule_fill_paths(column, columns, rules)
    items.extend(
        _rule_runtime_items(
            column,
            column_index,
            verdict,
            value_source,
            fills,
            len(rules),
        )
    )

    expectation, expectation_label, expectation_detail = _compute_expectation(
        column, verdict, value_source, fills
    )

    # Required-burden advisory items run AFTER expectation is known —
    # they're the canonical surface for REQUIRED_RUNTIME_VALUE_MISSING
    # and the softer "depends on a runtime input" warning.
    items.extend(_required_column_items(column, expectation))

    column_status = _summarize_items(items)

    return ColumnReadinessOut(
        column_id=column.id,
        column_name=column.name,
        required=bool(column.required),
        data_type=column.data_type or "text",
        source_type=source_kind,
        status=column_status,
        expectation=expectation,
        expectation_label=expectation_label,
        expectation_detail=expectation_detail,
        value_source=value_source,
        items=items,
    )


# ---------------------------------------------------------------------------
# Top-level entry point
# ---------------------------------------------------------------------------


def _summarize_template(
    columns_out: list[ColumnReadinessOut],
) -> tuple[ReadinessSummary, ReadinessStatus]:
    summary = ReadinessSummary(column_count=len(columns_out))
    for column_out in columns_out:
        if column_out.status == "ready":
            summary.ready_columns += 1
        elif column_out.status == "warning":
            summary.warning_columns += 1
        else:
            summary.blocked_columns += 1
        for item in column_out.items:
            if item.status == "blocked":
                summary.error_count += 1
            elif item.status == "warning":
                summary.warning_count += 1
            else:
                summary.info_count += 1
    template_status = _promote(*(c.status for c in columns_out))
    return summary, template_status


def preview_import_template_readiness(
    payload: ImportTemplateReadinessPreviewRequest,
) -> ImportTemplateReadinessPreviewResponse:
    """Run the readiness preview on an in-flight template payload.

    Pure / non-mutating. No DB / OCR / AI / export. Safe to call
    repeatedly from the Column Inspector on every keystroke (though
    the wizard should debounce in practice).
    """

    columns_out: list[ColumnReadinessOut] = [
        _evaluate_column(column, idx, payload.columns, payload.rules)
        for idx, column in enumerate(payload.columns)
    ]
    summary, template_status = _summarize_template(columns_out)

    return ImportTemplateReadinessPreviewResponse(
        template_id=payload.template_id,
        template_name=payload.template_name,
        status=template_status,
        summary=summary,
        columns=columns_out,
        # Template-level (non-column-scoped) issues are out of scope
        # for Phase 1C — duplicate column ids and the like are caught
        # by the existing validator.
        issues=[],
    )


__all__ = [
    "preview_import_template_readiness",
]
