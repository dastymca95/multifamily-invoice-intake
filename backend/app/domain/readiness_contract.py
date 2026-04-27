"""Backend-side readiness contract types.

Phase 1 — substrate only. No API endpoint exposes these structures
yet; they are pure data classes + enums that future phases will use
to build a ``GET /invoice-templates/{id}/readiness`` endpoint. Once
that endpoint exists, the frontend wizard's local
``evaluateGlobalSource`` / ``computeReadiness`` helpers (in
``ColumnInspector.tsx``) become thin renderers over the response,
eliminating the local heuristic mirrors that today drift from
resolver reality.

The types defined here intentionally mirror the frontend wizard's
existing readiness shape so the future endpoint is a drop-in
replacement for the local helpers — no UI redesign required.

This module is deliberately lightweight:

  * No service-layer dependencies.
  * No database or HTTP calls.
  * No mutation of any input.
  * No coupling to the resolver implementation (importable in
    isolation for future docs / tests).

Coupling to :mod:`app.domain.value_source` is one-way: the readiness
contract may *describe* value-source verdicts (``ValueSourceVerdict``
references :data:`ValueSourceKind`) but the value-source substrate
does not know about readiness. This keeps the dependency graph
acyclic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Literal

from app.domain.value_source import ValueSourceKind


# ---------------------------------------------------------------------------
# Status + outcome enums
# ---------------------------------------------------------------------------


#: Per-item / per-step / per-column status. Lifted from the wizard's
#: existing 3-tier readiness vocabulary so a future endpoint can swap
#: in without UI rework. ``ready`` includes the Step-2 / Step-5
#: "Looks good" verdict; ``warning`` covers anything the operator
#: should consider; ``blocked`` is a hard-error gate.
ReadinessStatus = Literal["ready", "warning", "blocked"]


#: High-level grouping that today's wizard renders under three
#: collapsible sections. Mirrors the frontend's
#: ``ReadinessCategory`` literal so the same grouping survives the
#: backend handoff.
ReadinessCategory = Literal["structure", "value_source", "rule_runtime"]


#: Coarse forecast of what Dry Run will say for this column.
#: Mirrors the wizard's ``ResolverExpectation`` so the
#: Resolver Expectation Card can render a backend response unchanged.
#:
#: * ``should_resolve``    — column has a baseline that produces a
#:                           value with no runtime input; OR an
#:                           unconditional rule FILL writes it.
#: * ``may_be_missing``    — column has a path that depends on
#:                           runtime input (catalog hint / extracted
#:                           fact / rule conditions matching).
#: * ``will_be_missing``   — required column with no resolvable path.
#:                           Resolver will fire
#:                           ``REQUIRED_RUNTIME_VALUE_MISSING``.
ResolverExpectation = Literal[
    "should_resolve",
    "may_be_missing",
    "will_be_missing",
]


#: Severity ladder used by issue code descriptors. Aligned with the
#: validator + resolver issue shapes so descriptors can be matched
#: 1:1 against emitted issues for parity tests.
IssueSeverity = Literal["error", "warning", "info"]


#: Where in the lifecycle the issue is observed. Aligned with the
#: backend's ``ResolverIssueScope`` literal.
IssueScope = Literal["readiness", "runtime", "row", "cell"]


#: Which service can emit a given issue code. Used by the future
#: docs / parity tests — both can list a code if both surfaces
#: validate it.
IssueEmitter = Literal["validator", "resolver"]


# ---------------------------------------------------------------------------
# Documentation / description objects
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IssueCodeDescriptor:
    """Documentation entry for one issue code.

    Used by future generated docs, parity tests asserting the
    frontend code table covers the backend universe, and the
    readiness endpoint that may attach descriptor metadata to
    individual ``ReadinessItem`` entries (so the wizard can show
    canonical "what does this mean?" copy without hand-curated
    strings).
    """

    code: str
    severity: IssueSeverity
    scope: IssueScope
    #: Which services can emit this code. Most codes are emitted by
    #: exactly one service; a small set (e.g. ``CATALOG_ENTRY_NOT_FOUND``)
    #: are emitted by both.
    emitted_by: tuple[IssueEmitter, ...]
    #: Beginner-friendly explanation rendered in the readiness UI.
    explanation: str
    #: Suggested remediation; rendered in the "Fix this" affordance.
    recommendation: str = ""


# ---------------------------------------------------------------------------
# Per-column readiness
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReadinessItem:
    """One row in a Step-5-style readiness checklist.

    Mirrors the frontend ``ReadinessItem`` so the future endpoint
    response is a drop-in replacement for the wizard's locally
    computed list.
    """

    status: ReadinessStatus
    category: ReadinessCategory
    label: str
    detail: str = ""
    #: When set, the wizard renders a "Fix in step N" link. The
    #: value matches the wizard's step indices (1=Identity,
    #: 2=Values, 3=Default, 4=Rules); 5=Readiness items don't
    #: typically link back to themselves.
    fix_step: int | None = None
    #: Optional pointer to an :class:`IssueCodeDescriptor` so the
    #: UI can show canonical copy / docs.
    code: str | None = None


@dataclass(frozen=True)
class ValueSourceVerdict:
    """Per-column verdict the wizard renders in the Resolver
    Expectation Card.

    Mirrors the frontend's existing ``ValueSourceVerdict`` shape
    (``status``, ``label``, ``detail``, ``conditional``) so the
    backend-driven version is a drop-in replacement for the local
    ``evaluateGlobalSource`` helper output.
    """

    kind: ValueSourceKind
    status: ReadinessStatus
    label: str
    detail: str = ""
    #: True when the source needs a runtime input (extracted fact /
    #: catalog hint) to actually produce a value. Drives the wizard's
    #: "May be missing without a runtime input" framing.
    conditional: bool = False


@dataclass(frozen=True)
class ColumnReadiness:
    """Aggregate per-column readiness picture.

    The future endpoint returns one of these per column. The wizard
    pulls the same fields it currently computes locally:

      * Resolver Expectation Card → ``expectation`` + ``expectation_detail``
      * Step 5 readiness checklist → ``structure`` + ``value_source`` + ``rule_runtime``
      * Stepper chip status (per step) → derived via :func:`summarize`
    """

    column_id: str
    column_label: str
    structure: tuple[ReadinessItem, ...]
    value_source: ValueSourceVerdict
    rule_runtime: tuple[ReadinessItem, ...]
    expectation: ResolverExpectation
    #: One-line operator-facing summary the Expectation Card renders
    #: under the headline.
    expectation_detail: str = ""


@dataclass(frozen=True)
class TemplateReadiness:
    """Aggregate template-wide readiness shape returned by the
    future ``GET /invoice-templates/{id}/readiness`` endpoint."""

    template_id: str
    template_name: str | None
    columns: tuple[ColumnReadiness, ...]
    template_status: ReadinessStatus


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def summarize(items: Iterable[ReadinessItem]) -> ReadinessStatus:
    """Reduce a collection of :class:`ReadinessItem` to the worst
    status across them.

    Used by per-step status chips ("Looks good" vs "Check this" vs
    "Needs fixing") in the wizard. Mirrors the frontend
    ``summariseReadiness`` helper so the wizard can swap to the
    backend-computed value identically.
    """

    has_blocked = False
    has_warning = False
    for item in items:
        if item.status == "blocked":
            has_blocked = True
        elif item.status == "warning":
            has_warning = True
    if has_blocked:
        return "blocked"
    if has_warning:
        return "warning"
    return "ready"


def status_for_category(
    items: Iterable[ReadinessItem],
    category: ReadinessCategory,
) -> ReadinessStatus | None:
    """Worst status across items in one category.

    Returns ``None`` when no items belong to the category — lets
    callers render "no checks for this group" affordances rather
    than a misleading green tick.
    """

    relevant = [item for item in items if item.category == category]
    if not relevant:
        return None
    return summarize(relevant)


# Public API
__all__ = [
    "ColumnReadiness",
    "IssueCodeDescriptor",
    "IssueEmitter",
    "IssueScope",
    "IssueSeverity",
    "ReadinessCategory",
    "ReadinessItem",
    "ReadinessStatus",
    "ResolverExpectation",
    "TemplateReadiness",
    "ValueSourceVerdict",
    "status_for_category",
    "summarize",
]
