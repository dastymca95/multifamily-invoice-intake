"""
Phase 3M — Backend Export Readiness Boundary schemas.

Mirrors the Phase 3L frontend boundary contract
(``frontend/src/features/invoice-templates/lib/export-readiness-boundary.ts``).

What this module IS:
  * The canonical backend Pydantic mirror of the explicit gap
    between Rivera's current diagnostic surfaces and a future
    production export pipeline.
  * Hard-pinned: ``production_export_ready`` is the literal ``False``,
    ``diagnostic_only`` is the literal ``True``. Neither can be
    widened by accident at the type layer.
  * ``ProductionExportStatus`` deliberately does NOT include
    ``ready`` — there is no production export engine for the
    contract to authorise.

What this module is NOT:
  * NOT an export engine.
  * NOT a profile / export run / batch persistence layer.
  * NOT a side-effecting API.

Naming convention: every public type starts with
``ExportReadiness*`` / ``ProductionExport*`` so a future production
export schema can mirror without renames.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------


ExportDiagnosticStatus = Literal[
    "blocked",
    "needs_review",
    "clear",
    "not_available",
]


# Phase 3M: ``ready`` is intentionally NOT a member of this Literal
# so the boundary contract cannot return "ready" by mistake. A
# future production engine that wants to graduate to ``ready`` will
# need to widen the Literal explicitly.
ProductionExportStatus = Literal[
    "unavailable",
    "not_configured",
    "not_authorized",
]


ExportReadinessBoundaryReason = Literal[
    "diagnostic_only_pipeline",
    "no_export_engine",
    "no_export_profile_persistence",
    "no_export_batch_model",
    "no_file_generation",
    "no_final_approval_workflow",
    "no_export_audit_trail",
    "no_external_posting",
]


# ---------------------------------------------------------------------------
# Optional input model — accepts the same shape the frontend computes
# ---------------------------------------------------------------------------


class ExportReadinessBoundaryInput(BaseModel):
    """Caller-supplied snapshot of the current diagnostic state.

    Every field is optional so callers can evaluate the boundary
    without persisted records (and without OCR / AI / export). All
    string fields are forward-compat — unknown values fall through
    the service's classifier the same way the frontend does.
    """

    operational_status: str | None = None
    profile_validation_status: str | None = None
    parity_status: str | None = None
    validation_source: str | None = None
    has_result: bool = False
    has_preview_rows: bool = False
    has_persisted_profile: bool = False


# ---------------------------------------------------------------------------
# Boundary result
# ---------------------------------------------------------------------------


class ExportReadinessBoundary(BaseModel):
    """The boundary contract.

    Carries hard-pinned ``production_export_ready=False`` and
    ``diagnostic_only=True``. Operator + developer messaging keep
    the contract speakable in operator UIs and engineer reports
    alike.
    """

    diagnostic_status: ExportDiagnosticStatus
    production_export_status: ProductionExportStatus
    # Hard-pinned literal. Pydantic v2 enforces this at parse time
    # so a downstream caller cannot construct a boundary with
    # ``production_export_ready=True``.
    production_export_ready: Literal[False] = False
    diagnostic_only: Literal[True] = True
    reasons: list[ExportReadinessBoundaryReason] = Field(default_factory=list)
    operator_title: str
    operator_message: str
    developer_message: str
    next_steps: list[str] = Field(default_factory=list)
    disclaimers: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Optional API request envelope (Phase 3M endpoint)
# ---------------------------------------------------------------------------


class ExportReadinessBoundaryRequest(BaseModel):
    """Request body for ``POST /export-readiness-boundary/evaluate``.

    Wraps ``ExportReadinessBoundaryInput`` so a future revision can
    grow the request without flattening every field at the body
    root.
    """

    input: ExportReadinessBoundaryInput = Field(
        default_factory=ExportReadinessBoundaryInput
    )
