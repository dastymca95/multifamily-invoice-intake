"""
Phase 3A — Operational Resolution Pipeline schemas.

Tightens the operational vocabulary the future production pipeline
will speak:

    Document / batch
            ↓
    Selected or matched invoice pattern
            ↓
    Extracted facts / catalog hints / document metadata
            ↓
    ResolverInput (Phase 2A bridge or direct)
            ↓
    Import Template Resolver (existing dry_run service)
            ↓
    OperationalResolutionResult  ← THIS MODULE

This is intentionally distinct from Phase 2B's "test runner" surface:

  * Phase 2B = test lab. Diagnostic, scenario-driven. Operator UX.
  * Phase 3A = production-shaped pipeline. Same resolver underneath
    but with operational naming, document/batch context, and a
    ``diagnostic_only`` hard-True flag so today's behaviour is
    explicit.

What Phase 3A is NOT:

  * NOT the production export engine.
  * NOT a Review Queue record creator.
  * NOT a document/batch mutator.
  * NOT an OCR / AI extraction surface.

The shape stays close to Phase 2B's ``TemplatePatternTestResult`` so
later phases can promote operational results into Review Queue items
or export-ready rows without re-shaping the contract.
"""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.import_resolver import ExtractedFact, ResolverInput, ResolverResult


# ---------------------------------------------------------------------------
# Request body
# ---------------------------------------------------------------------------


PatternSelectionMode = Literal["manual", "none"]


class OperationalResolutionRequest(BaseModel):
    """Request body for ``POST /operational-resolution/run``.

    Every field except ``template_id`` is optional. Posting a body
    with only the template id yields a baseline run that uses zero
    runtime context (useful for "is this template ready to receive
    operational input" checks before wiring extraction).
    """

    template_id: UUID
    pattern_id: UUID | None = None
    document_id: UUID | None = None
    batch_id: UUID | None = None

    # Accept either:
    #   - mapping shape  : {"invoice_number": "INV-1", "amount": "99.50"}
    #   - list shape     : [{"field_key": "invoice_number", ...}]
    # Both flow through ``ResolverInput.extracted_facts`` validators.
    extracted_facts: (
        list[ExtractedFact] | dict[str, Any] | None
    ) = None
    catalog_hints: dict[str, Any] | None = None
    document_metadata: dict[str, Any] | None = None
    runtime_options: dict[str, Any] | None = None

    # Pattern selection mode — explicit so future phases can add
    # ``"auto"`` / ``"hint_match"`` / etc. without breaking the
    # request shape. Today only ``"manual"`` (operator-supplied id)
    # and ``"none"`` (no pattern, raw context only) are honoured.
    pattern_selection_mode: PatternSelectionMode = "manual"

    # Hard-True for Phase 3A — protects against a future caller
    # accidentally flipping the surface into a side-effecting mode
    # before the resolver / export wiring exists.
    diagnostic_only: bool = True


# ---------------------------------------------------------------------------
# Review diagnostic (lightweight backend mirror of Phase 2G)
# ---------------------------------------------------------------------------


ReviewSeverity = Literal["ready", "info", "warning", "blocked"]
ReviewFixArea = Literal[
    "extracted_fact",
    "catalog_hint",
    "import_template",
    "invoice_pattern",
    "reference_data",
    "unknown",
]


class OperationalReviewDiagnostic(BaseModel):
    """One actionable item the operator should look at.

    Mirrors a SUBSET of the Phase 2G frontend ``PatternTestDiagnostic``
    so a future Phase 3D Review Queue surface can promote these into
    real records without re-classifying. Backend-side classification
    is intentionally narrow — the frontend Phase 2G helper covers the
    full vocabulary and stays the source of truth for nuanced
    presentation.
    """

    severity: ReviewSeverity
    code: str | None = None
    message: str
    recommendation: str | None = None
    column_id: str | None = None
    column_name: str | None = None
    fix_area: ReviewFixArea = "unknown"


# ---------------------------------------------------------------------------
# Operational summary
# ---------------------------------------------------------------------------


class OperationalResolutionSummary(BaseModel):
    """Coarse counts the operational UI / dashboards can read directly.

    Mirrors the resolver's per-row + per-severity counts, plus three
    operational aggregates (extracted fact / catalog hint count from
    the bridge input, missing-required-column count from the
    diagnostics) so a consumer can render "X of Y rows ready, Z
    required columns missing" without walking the resolver result.
    """

    status: str
    row_count: int = 0
    ready_rows: int = 0
    needs_review_rows: int = 0
    blocked_rows: int = 0
    conflict_rows: int = 0
    error_count: int = 0
    warning_count: int = 0
    info_count: int = 0
    extracted_fact_count: int = 0
    catalog_hint_count: int = 0
    missing_required_count: int = 0
    missing_fact_count: int = 0
    missing_catalog_hint_count: int = 0
    diagnostic_only: bool = True


# ---------------------------------------------------------------------------
# Top-level response envelope
# ---------------------------------------------------------------------------


class OperationalResolutionResult(BaseModel):
    """Top-level response from the operational resolution pipeline.

    Carries the resolver input + result side-by-side so a consumer
    can inspect both. ``diagnostic_only`` is hard-True at construction
    time so downstream surfaces can assert the contract at parse
    time before surfacing "this would actually export" copy.
    """

    diagnostic_only: bool = True
    template_id: str
    template_name: str | None = None
    pattern_id: str | None = None
    pattern_name: str | None = None
    document_id: str | None = None
    batch_id: str | None = None

    resolver_input: ResolverInput
    resolver_result: ResolverResult

    operational_summary: OperationalResolutionSummary
    # Empty list (not None) so consumers can iterate unconditionally.
    review_diagnostics: list[OperationalReviewDiagnostic] = Field(
        default_factory=list,
    )
