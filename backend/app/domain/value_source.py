"""ValueSource strategy substrate for the Import Template Resolver.

Phase 1 — substrate only. This module formalizes the value-source
contract that today is implemented as a switch statement inside
``import_template_resolver._resolve_column_baseline``. The resolver
itself is NOT rewired through this registry yet — that will land in
a later phase once the substrate is exercised by tests + a future
``/readiness`` endpoint. For now, the registry is a parallel
documentation surface that future code (a new readiness endpoint, a
frontend mirror, generated docs, parity snapshot tests) can read
without touching the resolver's hot path.

What each :class:`ValueSource` declares:

* ``kind``                  — the column ``source_type`` literal
* ``label``                 — short human label (matches wizard chip)
* ``explanation``           — one-line beginner-friendly description
* ``needs_runtime_input``   — does production resolution require an
                              extracted fact / catalog hint at run time?
* ``possible_issue_codes``  — the resolver issue codes this kind can
                              currently emit (for documentation +
                              parity tests)
* ``required_inputs(col)``  — the runtime inputs (descriptors) the
                              resolver expects when this kind runs
* ``evaluate_baseline(col)``— a STRUCTURAL mirror of the resolver
                              branch's outcome: does this column
                              configuration *would* resolve, *would*
                              wait for runtime, *would* need operator
                              review, or is the configuration itself
                              incomplete? See :class:`BaselineOutcome`
                              for the exhaustive categorisation.

The ``evaluate_baseline`` outputs are deliberately STRUCTURAL — they
don't reproduce the full :class:`ResolvedImportCell` shape. They
expose enough information to:

  1. Drive a future ``/readiness`` endpoint that the wizard can
     trust as the single source of truth.
  2. Power parity tests that assert each strategy's declared
     outcome matches what the production resolver actually returns
     for the same column shape.
  3. Document the contract for new contributors without forcing a
     read of the 100KB resolver file.

Behaviour stability promise (Phase 1):
    Each strategy mirrors the resolver branch for its kind exactly
    as the resolver behaves *today* (post-Phase-A). If the resolver
    changes in a future phase, the matching strategy + tests must
    be updated in lockstep.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar, Iterable, Literal, Protocol, runtime_checkable

from app.schemas.invoice_template import InvoiceTemplateColumn


# ---------------------------------------------------------------------------
# Type vocabulary
# ---------------------------------------------------------------------------


#: All ``column.source_type`` literals recognised today. Mirrors the
#: schema's ``ColumnSourceType`` Literal but kept local so this domain
#: module doesn't import the schema's full-fat union (and so the
#: substrate can extend with new kinds without a schema bump).
ValueSourceKind = Literal[
    "empty",
    "fixed_value",
    "manual_list",
    "invoice_field",
    "vendor_field",
    "property_field",
    "gl_field",
    "derived",
]


#: Categorisation of the per-column baseline outcome. Mirrors what the
#: resolver actually does today; future composers / readiness rendering
#: layer on top of this enum.
#:
#: * ``resolves``        — configuration is sufficient AND no runtime
#:                         input needed. The resolver returns a
#:                         resolved cell with a value (e.g. fixed_value
#:                         with default, manual_list with default
#:                         selected, manual_list with one option, empty
#:                         with legacy default fallback).
#: * ``needs_runtime``   — configuration is sufficient BUT an extracted
#:                         fact / catalog hint is required at resolve
#:                         time (invoice_field with field selected;
#:                         catalog source with catalog + field set).
#: * ``needs_review``    — configuration is sufficient BUT an operator
#:                         action is required before resolution can
#:                         pick a value (manual_list with multiple
#:                         options and no default selected).
#: * ``incomplete``      — configuration is missing a required piece
#:                         (fixed_value with empty default; invoice
#:                         field with no field selected; catalog source
#:                         missing catalog or field).
#: * ``missing``         — no source configured at all (empty source
#:                         without a legacy default fallback).
#: * ``not_implemented`` — derived sources today; placeholder branch.
BaselineOutcome = Literal[
    "resolves",
    "needs_runtime",
    "needs_review",
    "incomplete",
    "missing",
    "not_implemented",
]


@dataclass(frozen=True)
class RequiredInputDescriptor:
    """One runtime input the source needs to produce a value.

    Used by the future readiness endpoint to tell the wizard things
    like "Provide a vendor catalog hint" or "Provide an invoice_number
    extracted fact" before Dry Run can resolve this column.
    """

    #: What kind of runtime input is needed.
    kind: Literal["extracted_fact", "catalog_hint"]
    #: For ``extracted_fact``: the canonical field key the resolver
    #: looks up (already alias-normalised). ``None`` for catalog hints.
    field_key: str | None = None
    #: For ``catalog_hint``: which catalog kind the hint targets.
    #: ``None`` for extracted facts.
    catalog_kind: Literal["vendor", "property", "gl"] | None = None
    #: Human-readable description for UI / docs.
    description: str = ""


@dataclass(frozen=True)
class BaselineEvaluation:
    """Structural verdict for a column's baseline path.

    NOT a :class:`ResolvedImportCell` — this is a documentation /
    contract object, deliberately decoupled from the resolver's
    runtime cell shape so callers (readiness endpoint, parity tests,
    frontend mirror) can use it without dragging the full resolver
    state machine along.
    """

    #: Categorical outcome (see :data:`BaselineOutcome`).
    outcome: BaselineOutcome
    #: Issue codes the resolver would emit for this exact column shape.
    #: Mirrors the resolver's per-branch issue_codes list — used by
    #: tests to assert parity and by docs to enumerate possibilities.
    issue_codes: tuple[str, ...] = ()
    #: One-line operator-facing explanation.
    detail: str = ""


# ---------------------------------------------------------------------------
# Strategy protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class ValueSource(Protocol):
    """Strategy interface for one ``column.source_type``.

    All members are class-level (no instance state) — the substrate
    is purely functional. This keeps the registry and call sites
    side-effect-free and makes parity tests trivial.
    """

    #: The ``column.source_type`` literal this strategy handles.
    kind: ClassVar[ValueSourceKind]
    #: Short label suitable for wizard chips / docs.
    label: ClassVar[str]
    #: One-line explanation in plain English.
    explanation: ClassVar[str]
    #: True iff production resolution requires an extracted fact /
    #: catalog hint at run time. Lets the readiness layer say
    #: "depends on runtime input" vs. "self-contained baseline".
    needs_runtime_input: ClassVar[bool]
    #: Issue codes the resolver may emit for columns of this kind.
    #: Used by docs + parity tests; not consulted at runtime.
    possible_issue_codes: ClassVar[frozenset[str]]

    @classmethod
    def required_inputs(
        cls, column: InvoiceTemplateColumn
    ) -> tuple[RequiredInputDescriptor, ...]:
        """Runtime inputs the resolver expects for ``column``."""
        ...

    @classmethod
    def evaluate_baseline(
        cls, column: InvoiceTemplateColumn
    ) -> BaselineEvaluation:
        """Mirror the resolver's per-source baseline outcome."""
        ...


# ---------------------------------------------------------------------------
# Helpers shared by strategies
# ---------------------------------------------------------------------------


def _trim(value: str | None) -> str:
    """Defensive whitespace trim that tolerates ``None``."""
    if not isinstance(value, str):
        return ""
    return value.strip()


def _has_value(value: object) -> bool:
    """Mirror of ``import_template_resolver._has_value``.

    Non-empty trimmed string OR any non-None non-string truthy value.
    Kept inline (rather than imported from the resolver) so this
    domain module has no service-layer dependency.
    """
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


# ---------------------------------------------------------------------------
# Concrete strategies
# ---------------------------------------------------------------------------


class EmptySource:
    """``source_type='empty'`` — no source declared.

    Two execution paths in the resolver:
      * If ``column.default_value`` is non-empty: legacy fallback
        returns a resolved cell with ``source_type='global_default'``.
      * Otherwise: falls through to ``_missing_cell`` with code
        ``VALUE_NOT_RESOLVED``.

    The legacy fallback exists so old templates authored before the
    Phase-2 source-type taxonomy still resolve.
    """

    kind: ClassVar[ValueSourceKind] = "empty"
    label: ClassVar[str] = "No source"
    explanation: ClassVar[str] = (
        "No source declared. Operator must rely on rule FILL "
        "actions or accept that the column may be missing."
    )
    needs_runtime_input: ClassVar[bool] = False
    possible_issue_codes: ClassVar[frozenset[str]] = frozenset(
        {"VALUE_NOT_RESOLVED"}
    )

    @classmethod
    def required_inputs(
        cls, column: InvoiceTemplateColumn
    ) -> tuple[RequiredInputDescriptor, ...]:
        return ()

    @classmethod
    def evaluate_baseline(
        cls, column: InvoiceTemplateColumn
    ) -> BaselineEvaluation:
        if _has_value(column.default_value):
            return BaselineEvaluation(
                outcome="resolves",
                detail=(
                    "Legacy default_value is honored as a baseline "
                    "for empty-source columns."
                ),
            )
        return BaselineEvaluation(
            outcome="missing",
            issue_codes=("VALUE_NOT_RESOLVED",),
            detail="Column has no source; rules must fill the value.",
        )


class FixedValueSource:
    """``source_type='fixed_value'`` — always emits ``default_value``."""

    kind: ClassVar[ValueSourceKind] = "fixed_value"
    label: ClassVar[str] = "Fixed value"
    explanation: ClassVar[str] = (
        "Always emits the configured constant value on every export "
        "row."
    )
    needs_runtime_input: ClassVar[bool] = False
    possible_issue_codes: ClassVar[frozenset[str]] = frozenset(
        {"FIXED_VALUE_EMPTY"}
    )

    @classmethod
    def required_inputs(
        cls, column: InvoiceTemplateColumn
    ) -> tuple[RequiredInputDescriptor, ...]:
        return ()

    @classmethod
    def evaluate_baseline(
        cls, column: InvoiceTemplateColumn
    ) -> BaselineEvaluation:
        if _has_value(column.default_value):
            return BaselineEvaluation(
                outcome="resolves",
                detail=f'Always emits "{_trim(column.default_value)}".',
            )
        return BaselineEvaluation(
            outcome="incomplete",
            issue_codes=("FIXED_VALUE_EMPTY",),
            detail=(
                "Fixed-value source has no value configured. Pick a "
                "constant or change the source kind."
            ),
        )


class ManualListSource:
    """``source_type='manual_list'`` — pick from a fixed allowed list.

    Resolver branches (post Phase A):
      * ``default_value`` set AND it matches one of ``manual_values``
        (whitespace-trimmed, case-sensitive)
            → resolved cell using the canonical match.
      * ``len(manual_values) == 1`` (no default needed)
            → resolved cell with that single value.
      * ``len(manual_values) > 1`` and no usable default
            → ``_manual_review_cell`` with
            ``MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION``.
      * ``manual_values`` empty
            → ``_missing_cell`` with ``MANUAL_VALUE_REQUIRED``.

    Note that ``default_value`` set but NOT in ``manual_values``
    falls THROUGH to the manual_review branch (resolver behaviour);
    the validator emits ``MANUAL_LIST_DEFAULT_NOT_IN_LIST`` to
    surface the mismatch.
    """

    kind: ClassVar[ValueSourceKind] = "manual_list"
    label: ClassVar[str] = "Pick from list"
    explanation: ClassVar[str] = (
        "Operator picks from a fixed allowed list at runtime. A "
        "column-level default selection auto-resolves the column "
        "when no rule overrides."
    )
    needs_runtime_input: ClassVar[bool] = False
    possible_issue_codes: ClassVar[frozenset[str]] = frozenset(
        {"MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION", "MANUAL_VALUE_REQUIRED"}
    )

    @classmethod
    def required_inputs(
        cls, column: InvoiceTemplateColumn
    ) -> tuple[RequiredInputDescriptor, ...]:
        return ()

    @classmethod
    def evaluate_baseline(
        cls, column: InvoiceTemplateColumn
    ) -> BaselineEvaluation:
        manual_values = column.manual_values or []
        non_blank = [
            value for value in manual_values
            if isinstance(value, str) and value.strip()
        ]

        # No values at all → resolver returns missing.
        if not non_blank:
            return BaselineEvaluation(
                outcome="missing",
                issue_codes=("MANUAL_VALUE_REQUIRED",),
                detail=(
                    "Manual-list source is selected but no values "
                    "are configured."
                ),
            )

        default_clean = _trim(column.default_value)

        # Phase A: explicit default that matches one of the allowed
        # values resolves immediately.
        if default_clean and any(
            v.strip() == default_clean for v in non_blank
        ):
            return BaselineEvaluation(
                outcome="resolves",
                detail=f'Default selected: "{default_clean}".',
            )

        # Single-value list resolves automatically without a default.
        if len(non_blank) == 1:
            return BaselineEvaluation(
                outcome="resolves",
                detail=(
                    f'Single allowed value: "{non_blank[0].strip()}".'
                ),
            )

        # Multiple values, no usable default → manual review branch.
        return BaselineEvaluation(
            outcome="needs_review",
            issue_codes=("MULTIPLE_DEFAULT_OPTIONS_NO_SELECTION",),
            detail=(
                "Manual-list source has multiple values and no "
                "matching column-level default. Operator must pick "
                "at runtime, OR a rule FILL must write a value."
            ),
        )


class InvoiceFieldSource:
    """``source_type='invoice_field'`` — pull from extracted facts."""

    kind: ClassVar[ValueSourceKind] = "invoice_field"
    label: ClassVar[str] = "From extracted invoice"
    explanation: ClassVar[str] = (
        "Resolved from the extracted invoice payload at runtime."
    )
    needs_runtime_input: ClassVar[bool] = True
    possible_issue_codes: ClassVar[frozenset[str]] = frozenset(
        {"INVOICE_FIELD_FACT_NOT_FOUND", "EXTRACTED_FACT_SOURCE_UNKNOWN"}
    )

    @classmethod
    def required_inputs(
        cls, column: InvoiceTemplateColumn
    ) -> tuple[RequiredInputDescriptor, ...]:
        # Local import to avoid a hard dependency cycle with the
        # extracted-fields registry from within the type annotations.
        from app.domain.extracted_invoice_fields import (
            normalize_extracted_field_key,
        )

        field_key = (
            column.source_ref.field if column.source_ref else None
        )
        if not field_key:
            return ()
        normalized = normalize_extracted_field_key(field_key) or field_key
        return (
            RequiredInputDescriptor(
                kind="extracted_fact",
                field_key=normalized,
                description=(
                    f'Extracted invoice fact for field "{normalized}".'
                ),
            ),
        )

    @classmethod
    def evaluate_baseline(
        cls, column: InvoiceTemplateColumn
    ) -> BaselineEvaluation:
        field_key = (
            column.source_ref.field if column.source_ref else None
        )
        if not field_key:
            return BaselineEvaluation(
                outcome="incomplete",
                detail=(
                    "Invoice-field source is selected but no field "
                    "is bound. Pick the extracted field this column "
                    "should resolve from."
                ),
            )
        return BaselineEvaluation(
            outcome="needs_runtime",
            detail=(
                f'Resolves from extracted fact "{field_key}" at '
                "runtime."
            ),
        )


class _CatalogSourceBase:
    """Shared behaviour for the three catalog-backed sources.

    Subclasses set ``kind``, ``label``, and ``catalog_kind``; the
    rest is derived. The resolver delegates to
    ``_resolve_catalog_baseline`` for all three kinds with the same
    catalog-hint matching machinery — so the substrate mirrors that
    by sharing the evaluate path here.
    """

    label: ClassVar[str] = "Catalog"
    explanation: ClassVar[str] = (
        "Resolved from a saved reference catalog using a runtime "
        "catalog hint."
    )
    needs_runtime_input: ClassVar[bool] = True
    possible_issue_codes: ClassVar[frozenset[str]] = frozenset(
        {
            "CATALOG_HINT_MISSING",
            "CATALOG_ENTRY_NOT_FOUND",
            "CATALOG_ENTRY_AMBIGUOUS",
            "CATALOG_VALUE_MISSING",
            "CATALOG_NOT_CONFIGURED",
            "SOURCE_CATALOG_FIELD_MISSING",
            "CATALOG_FIELD_NOT_FOUND",
            # Phase 1B parity-test discovery — added once the
            # parity suite caught these two resolver codes that
            # weren't declared in Phase 1A. Both come from defensive
            # branches in ``_resolve_catalog_baseline``:
            #   * CATALOG_MATCHER_NOT_IMPLEMENTED — db=None at
            #     resolve time (no SQLAlchemy session available).
            #   * CATALOG_NOT_FOUND — catalog_id references a
            #     catalog that no longer exists in the database
            #     (deleted post-binding).
            # Both are kind-specific contract surface, not generic
            # resolver-level codes, so they belong here on the
            # catalog source classes.
            "CATALOG_MATCHER_NOT_IMPLEMENTED",
            "CATALOG_NOT_FOUND",
        }
    )
    #: Concrete subclasses set this to "vendor" / "property" / "gl".
    catalog_kind: ClassVar[Literal["vendor", "property", "gl"]]

    @classmethod
    def required_inputs(
        cls, column: InvoiceTemplateColumn
    ) -> tuple[RequiredInputDescriptor, ...]:
        return (
            RequiredInputDescriptor(
                kind="catalog_hint",
                catalog_kind=cls.catalog_kind,
                description=(
                    f'Runtime hint to look up the {cls.catalog_kind} '
                    "catalog entry for this column."
                ),
            ),
        )

    @classmethod
    def evaluate_baseline(
        cls, column: InvoiceTemplateColumn
    ) -> BaselineEvaluation:
        ref = column.source_ref
        catalog_id = getattr(ref, "catalog_id", None) if ref else None
        field_key = getattr(ref, "field", None) if ref else None
        if not catalog_id:
            return BaselineEvaluation(
                outcome="incomplete",
                issue_codes=("CATALOG_NOT_CONFIGURED",),
                detail=(
                    f'{cls.catalog_kind.title()} catalog source has '
                    "no catalog selected."
                ),
            )
        if not field_key:
            return BaselineEvaluation(
                outcome="incomplete",
                issue_codes=("SOURCE_CATALOG_FIELD_MISSING",),
                detail=(
                    f'{cls.catalog_kind.title()} catalog selected '
                    "but no field is bound."
                ),
            )
        return BaselineEvaluation(
            outcome="needs_runtime",
            detail=(
                f'Reads "{field_key}" from the bound '
                f'{cls.catalog_kind} catalog using a runtime hint.'
            ),
        )


class VendorFieldSource(_CatalogSourceBase):
    kind: ClassVar[ValueSourceKind] = "vendor_field"
    label: ClassVar[str] = "From Vendors catalog"
    catalog_kind: ClassVar[Literal["vendor", "property", "gl"]] = "vendor"


class PropertyFieldSource(_CatalogSourceBase):
    kind: ClassVar[ValueSourceKind] = "property_field"
    label: ClassVar[str] = "From Properties catalog"
    catalog_kind: ClassVar[Literal["vendor", "property", "gl"]] = "property"


class GLFieldSource(_CatalogSourceBase):
    kind: ClassVar[ValueSourceKind] = "gl_field"
    label: ClassVar[str] = "From GL Codes catalog"
    catalog_kind: ClassVar[Literal["vendor", "property", "gl"]] = "gl"


class DerivedSource:
    """``source_type='derived'`` — placeholder, not implemented yet.

    Resolver returns an ``ignored`` cell with a single warning +
    issue code so the column is visibly unsupported in dry-run.
    """

    kind: ClassVar[ValueSourceKind] = "derived"
    label: ClassVar[str] = "Derived"
    explanation: ClassVar[str] = (
        "Computed by a rule/expression. Not yet implemented in the "
        "resolver — placeholder."
    )
    needs_runtime_input: ClassVar[bool] = False
    possible_issue_codes: ClassVar[frozenset[str]] = frozenset(
        {"DERIVED_RESOLVER_NOT_IMPLEMENTED"}
    )

    @classmethod
    def required_inputs(
        cls, column: InvoiceTemplateColumn
    ) -> tuple[RequiredInputDescriptor, ...]:
        return ()

    @classmethod
    def evaluate_baseline(
        cls, column: InvoiceTemplateColumn
    ) -> BaselineEvaluation:
        return BaselineEvaluation(
            outcome="not_implemented",
            issue_codes=("DERIVED_RESOLVER_NOT_IMPLEMENTED",),
            detail=(
                "Derived resolution is not implemented in this "
                "resolver phase."
            ),
        )


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


_REGISTRY: dict[ValueSourceKind, type[ValueSource]] = {
    "empty": EmptySource,
    "fixed_value": FixedValueSource,
    "manual_list": ManualListSource,
    "invoice_field": InvoiceFieldSource,
    "vendor_field": VendorFieldSource,
    "property_field": PropertyFieldSource,
    "gl_field": GLFieldSource,
    "derived": DerivedSource,
}


def get_value_source(kind: str | None) -> type[ValueSource]:
    """Look up the strategy class for a column ``source_type``.

    Unknown / ``None`` values fall back to :class:`EmptySource` so
    the substrate matches the resolver's defensive default.
    """

    if kind is None:
        return EmptySource
    return _REGISTRY.get(kind, EmptySource)  # type: ignore[arg-type]


def all_value_sources() -> tuple[type[ValueSource], ...]:
    """Every registered strategy class — for docs + parity tests."""

    return tuple(_REGISTRY.values())


def all_value_source_kinds() -> tuple[ValueSourceKind, ...]:
    """Every registered ``source_type`` literal."""

    return tuple(_REGISTRY.keys())


def all_possible_issue_codes() -> frozenset[str]:
    """Union of every issue code declared by any strategy.

    Useful for parity tests that assert frontend code-table mirrors
    cover everything the backend can emit on the baseline path.
    """

    accumulator: set[str] = set()
    for source_cls in _REGISTRY.values():
        accumulator.update(source_cls.possible_issue_codes)
    return frozenset(accumulator)


# Public API
__all__ = [
    "BaselineEvaluation",
    "BaselineOutcome",
    "DerivedSource",
    "EmptySource",
    "FixedValueSource",
    "GLFieldSource",
    "InvoiceFieldSource",
    "ManualListSource",
    "PropertyFieldSource",
    "RequiredInputDescriptor",
    "ValueSource",
    "ValueSourceKind",
    "VendorFieldSource",
    "_CatalogSourceBase",
    "all_possible_issue_codes",
    "all_value_source_kinds",
    "all_value_sources",
    "get_value_source",
]
