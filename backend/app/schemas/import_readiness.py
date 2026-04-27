"""Pydantic wire schemas for the readiness preview endpoint.

Phase 1C — schemas for ``POST /invoice-templates/readiness-preview``.
The frontend Column Inspector currently runs its OWN local heuristic
readiness logic; this endpoint exposes the canonical backend
readiness contract so the wizard (in a future phase) can stop
disagreeing with Validate / Dry Run.

The endpoint is **non-mutating** and works on UNSAVED template
payloads — the frontend sends its in-flight state, the backend
returns per-column readiness without touching the saved template
or running OCR / AI / export.

Wire shapes here are kept Pydantic (FastAPI-friendly) and mirror
the dataclass-based domain types in
:mod:`app.domain.readiness_contract` while adding fields the API
needs (``column_id`` / ``rule_id`` / ``cell_key`` plumbing on every
item, ``source`` provenance, etc.). The dataclass types stay
service-internal so the domain layer remains pure.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.invoice_template import (
    InvoiceTemplateColumn,
    InvoiceTemplateRule,
)


# ---------------------------------------------------------------------------
# Status / category / expectation enums (mirror domain types)
# ---------------------------------------------------------------------------


#: Per-item / per-column / per-template status. Aligned with the
#: wizard's existing 3-tier vocabulary so the future drop-in
#: replacement of the local helpers requires no UI rework.
ReadinessStatus = Literal["ready", "warning", "blocked"]


#: Grouping the wizard already renders under three collapsible
#: sections. Mirrors :data:`app.domain.readiness_contract.ReadinessCategory`
#: and adds ``advanced`` for power-user toggles
#: (``allow_rule_override`` / locks / validation bag) that don't fit
#: the canonical triplet.
ReadinessCategory = Literal[
    "structure",
    "value_source",
    "rule_runtime",
    "advanced",
]


#: Coarse forecast of what Dry Run will say. Mirrors
#: :data:`app.domain.readiness_contract.ResolverExpectation`.
ResolverExpectation = Literal[
    "should_resolve",
    "may_be_missing",
    "will_be_missing",
]


#: Provenance tag on every emitted item. Lets the wizard distinguish
#: backend-readiness items from local heuristic items during the
#: transitional period when both surfaces coexist.
ReadinessSource = Literal["backend_readiness"]


# ---------------------------------------------------------------------------
# Request body
# ---------------------------------------------------------------------------


class ImportTemplateReadinessPreviewRequest(BaseModel):
    """Full or in-flight import template payload to evaluate.

    Re-uses the canonical ``InvoiceTemplateColumn`` and
    ``InvoiceTemplateRule`` Pydantic models so the request body has
    the same shape the frontend already sends to ``POST /invoice-templates``
    (create) and ``PATCH /invoice-templates/{id}`` (update). This means
    the wizard can post its current local state directly without any
    additional shape transformation.

    All fields are optional except ``columns`` — a payload without
    columns is structurally valid but will roll up as an empty
    template and report nothing.
    """

    template_id: str | None = Field(
        default=None,
        description=(
            "Optional id of the saved template the payload corresponds to. "
            "Echoed back in the response for client correlation; the "
            "endpoint does not load the saved template."
        ),
    )
    template_name: str | None = Field(
        default=None,
        description="Optional name of the template (echoed in the response).",
    )
    columns: list[InvoiceTemplateColumn] = Field(
        default_factory=list,
        description="Columns to evaluate.",
    )
    rules: list[InvoiceTemplateRule] = Field(
        default_factory=list,
        description=(
            "Rule rows. Used to detect FILL/Action paths that satisfy "
            "required columns lacking a global default."
        ),
    )
    options: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Forward-compatible options bag for future phases "
            "(scenario inputs, catalog hints, etc.). Currently ignored."
        ),
    )


# ---------------------------------------------------------------------------
# Response items
# ---------------------------------------------------------------------------


class ReadinessItemOut(BaseModel):
    """One row in a Step-5-style readiness checklist.

    Mirrors :class:`app.domain.readiness_contract.ReadinessItem` and
    adds API-only plumbing (``column_id``, ``rule_id``, ``cell_key``,
    ``path``, ``source``) so a single flat list can carry items from
    different scopes without losing the link to the offending element.
    """

    category: ReadinessCategory
    status: ReadinessStatus
    code: str | None = Field(
        default=None,
        description=(
            "Stable issue code. Aligned with backend resolver / "
            "validator codes when applicable; new readiness-only codes "
            "start with ``READINESS_*``."
        ),
    )
    message: str
    detail: str | None = Field(
        default=None,
        description="Operator-facing explanation of the item.",
    )
    recommendation: str | None = Field(
        default=None,
        description="One-line suggested remediation.",
    )
    fix_step: int | str | None = Field(
        default=None,
        description=(
            "Wizard step indicator (1-5 or 'advanced') the operator "
            "should jump to in order to fix the item."
        ),
    )
    column_id: str | None = None
    rule_id: str | None = None
    cell_key: str | None = Field(
        default=None,
        description=(
            "Column id of the cell inside ``rule_id`` the item refers "
            "to (rule cells are keyed by column id)."
        ),
    )
    path: str | None = Field(
        default=None,
        description=(
            "Optional dotted JSON path into the template body for the "
            "offending element (e.g. ``columns[3].format.list_options``)."
        ),
    )
    source: ReadinessSource = Field(
        default="backend_readiness",
        description=(
            "Provenance tag. Always ``backend_readiness`` for items "
            "this endpoint emits."
        ),
    )


class ValueSourceVerdictOut(BaseModel):
    """Per-column value-source verdict.

    Mirrors :class:`app.domain.readiness_contract.ValueSourceVerdict`
    plus a ``conditional`` flag that lets the UI distinguish
    "self-contained baseline" from "baseline that needs runtime input"
    when both render with green status.
    """

    kind: str = Field(description="The column ``source_type`` literal.")
    status: ReadinessStatus
    label: str
    detail: str | None = None
    conditional: bool = Field(
        default=False,
        description=(
            "True iff the resolver needs an extracted fact / catalog "
            "hint at runtime to actually produce a value."
        ),
    )


class ColumnReadinessOut(BaseModel):
    """Per-column readiness picture.

    Aggregates the structure / value source / rule runtime checks the
    wizard renders today. ``items`` carries the flat per-row checklist;
    ``value_source`` carries the headline verdict the Resolver
    Expectation Card renders.
    """

    column_id: str
    column_name: str
    required: bool
    data_type: str | None = None
    source_type: str | None = None
    status: ReadinessStatus
    expectation: ResolverExpectation
    expectation_label: str
    expectation_detail: str
    value_source: ValueSourceVerdictOut
    items: list[ReadinessItemOut] = Field(default_factory=list)


class ReadinessSummary(BaseModel):
    """Template-level rollup counts."""

    column_count: int = 0
    ready_columns: int = 0
    warning_columns: int = 0
    blocked_columns: int = 0
    error_count: int = 0
    warning_count: int = 0
    info_count: int = 0


class ImportTemplateReadinessPreviewResponse(BaseModel):
    """Top-level readiness preview body returned by the endpoint."""

    template_id: str | None = None
    template_name: str | None = None
    status: ReadinessStatus
    summary: ReadinessSummary
    columns: list[ColumnReadinessOut] = Field(default_factory=list)
    issues: list[ReadinessItemOut] = Field(
        default_factory=list,
        description=(
            "Template-level items that are not column-scoped (e.g. "
            "duplicate column ids). Empty when every issue belongs to "
            "a single column."
        ),
    )


__all__ = [
    "ColumnReadinessOut",
    "ImportTemplateReadinessPreviewRequest",
    "ImportTemplateReadinessPreviewResponse",
    "ReadinessCategory",
    "ReadinessItemOut",
    "ReadinessSource",
    "ReadinessStatus",
    "ReadinessSummary",
    "ResolverExpectation",
    "ValueSourceVerdictOut",
]
