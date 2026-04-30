"""
Phase 3M — Backend Export Readiness Boundary service.

Pure deterministic builder that produces the canonical backend
``ExportReadinessBoundary`` from a small diagnostic-state snapshot.

Mirrors the Phase 3L frontend helper
(``frontend/src/features/invoice-templates/lib/export-readiness-boundary.ts``)
so any future operational endpoint can return the SAME boundary
contract on the wire as the panel computes locally.

Hard contract:
  * ``production_export_ready`` is **always False**.
  * ``diagnostic_only`` is **always True**.
  * ``production_export_status`` is **always "unavailable"** in
    Phase 3M. The Pydantic Literal type doesn't include ``"ready"``
    so it cannot be returned by mistake.
  * Pure / synchronous — no DB, no I/O, no side effects.
  * Never throws on unknown / forward-compat values; classifies
    conservatively (toward ``needs_review`` rather than ``clear``).

Diagnostic status rules (per spec):
  * ``not_available`` — ``has_result=False`` OR ``has_preview_rows=False``.
  * ``blocked`` — operational OR profile-validation status is
    ``blocked`` / ``conflict``.
  * ``needs_review`` — operational OR profile-validation status is
    ``needs_review`` / ``warning`` / ``warnings``, OR parity status
    is ``major_drift`` / ``minor_drift``.
  * ``clear`` — only when:
      - ``has_result=True``
      - ``has_preview_rows=True``
      - profile-validation status is ``clear``
      - operational status is ``clear`` / ``ready`` / absent
      - parity status is ``aligned`` / ``not_checked`` / absent
      - ``validation_source`` is ``backend``
    Anything else downgrades to ``needs_review``. A local /
    loading / unavailable validation source ALSO downgrades a
    would-be ``clear`` to ``needs_review`` — the backend hasn't
    verified.

Status classification is forward-compat: unknown status strings
behave like "absent" (they neither block nor clear), and parity
strings outside the known set are ignored for status decisions.
The boundary contract itself stays stable.
"""

from __future__ import annotations

from app.schemas.export_readiness_boundary import (
    ExportDiagnosticStatus,
    ExportReadinessBoundary,
    ExportReadinessBoundaryInput,
    ExportReadinessBoundaryReason,
    ProductionExportStatus,
)


__all__ = [
    "build_export_readiness_boundary",
    "build_export_readiness_boundary_from_input",
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_export_readiness_boundary(
    *,
    operational_status: str | None = None,
    profile_validation_status: str | None = None,
    parity_status: str | None = None,
    validation_source: str | None = None,
    has_result: bool = False,
    has_preview_rows: bool = False,
    has_persisted_profile: bool = False,
) -> ExportReadinessBoundary:
    """Build the boundary from explicit kwargs.

    All arguments are keyword-only so callers don't accidentally
    transpose two strings; defaults match the "no diagnostic data
    yet" baseline. Always returns a valid boundary — never throws.
    """
    diagnostic_status = _classify_diagnostic_status(
        operational_status=operational_status,
        profile_validation_status=profile_validation_status,
        parity_status=parity_status,
        validation_source=validation_source,
        has_result=has_result,
        has_preview_rows=has_preview_rows,
    )
    reasons = _build_reasons(has_persisted_profile=has_persisted_profile)
    operator_title, operator_message = _operator_messages(diagnostic_status)
    developer_message = _DEVELOPER_MESSAGE
    next_steps = _next_steps(diagnostic_status)
    disclaimers = list(_DISCLAIMERS)

    # Phase 3M hard pin — every code path lands here. Future phases
    # that introduce a real engine will branch this BEFORE returning,
    # not after.
    production_export_status: ProductionExportStatus = "unavailable"

    return ExportReadinessBoundary(
        diagnostic_status=diagnostic_status,
        production_export_status=production_export_status,
        production_export_ready=False,
        diagnostic_only=True,
        reasons=reasons,
        operator_title=operator_title,
        operator_message=operator_message,
        developer_message=developer_message,
        next_steps=next_steps,
        disclaimers=disclaimers,
    )


def build_export_readiness_boundary_from_input(
    input_: ExportReadinessBoundaryInput,
) -> ExportReadinessBoundary:
    """Convenience wrapper for the Pydantic-input form (used by the
    optional ``/export-readiness-boundary/evaluate`` endpoint and by
    callers that already have the input model on hand).
    """
    return build_export_readiness_boundary(
        operational_status=input_.operational_status,
        profile_validation_status=input_.profile_validation_status,
        parity_status=input_.parity_status,
        validation_source=input_.validation_source,
        has_result=input_.has_result,
        has_preview_rows=input_.has_preview_rows,
        has_persisted_profile=input_.has_persisted_profile,
    )


# ---------------------------------------------------------------------------
# Diagnostic status classifier
# ---------------------------------------------------------------------------


# Token sets — kept loose / forward-compat. Unknown strings simply
# don't match any bucket, which is how the spec says the classifier
# should degrade.
_BLOCKING_STATUSES: frozenset[str] = frozenset(
    {"blocked", "conflict"}
)
_REVIEW_STATUSES: frozenset[str] = frozenset(
    {"needs_review", "warning", "warnings"}
)
_CLEAR_STATUSES: frozenset[str] = frozenset(
    {"clear", "ready"}
)
_DRIFT_PARITY_STATUSES: frozenset[str] = frozenset(
    {"major_drift", "minor_drift"}
)
_ALIGNED_PARITY_STATUSES: frozenset[str] = frozenset(
    {"aligned", "not_checked"}
)
_BACKEND_VALIDATION_SOURCES: frozenset[str] = frozenset(
    {"backend"}
)


def _classify_diagnostic_status(
    *,
    operational_status: str | None,
    profile_validation_status: str | None,
    parity_status: str | None,
    validation_source: str | None,
    has_result: bool,
    has_preview_rows: bool,
) -> ExportDiagnosticStatus:
    # 1. Not-available short-circuit — no result OR no preview rows.
    if not has_result or not has_preview_rows:
        return "not_available"

    # 2. Blocked — operational OR profile-validation flagged blocking.
    if (
        operational_status in _BLOCKING_STATUSES
        or profile_validation_status in _BLOCKING_STATUSES
    ):
        return "blocked"

    # 3. Needs-review — explicit warnings on either validator.
    if (
        operational_status in _REVIEW_STATUSES
        or profile_validation_status in _REVIEW_STATUSES
    ):
        return "needs_review"

    # 4. Needs-review — parity drift. Per spec both major AND minor
    #    drift land here (frontend only downgrades on major; backend
    #    is intentionally stricter so the canonical contract trends
    #    conservative).
    if parity_status in _DRIFT_PARITY_STATUSES:
        return "needs_review"

    # 5. Clear — only with backend-verified validation AND no other
    #    signals to the contrary. ``operational_status`` may be
    #    absent (None) — that's fine, we don't treat absence as a
    #    block. Same for parity_status.
    profile_clear = (
        profile_validation_status in _CLEAR_STATUSES
        or profile_validation_status is None
    )
    operational_clear = (
        operational_status in _CLEAR_STATUSES or operational_status is None
    )
    parity_aligned = (
        parity_status in _ALIGNED_PARITY_STATUSES or parity_status is None
    )
    backend_verified = validation_source in _BACKEND_VALIDATION_SOURCES

    if (
        profile_validation_status in _CLEAR_STATUSES
        and profile_clear
        and operational_clear
        and parity_aligned
        and backend_verified
    ):
        return "clear"

    # Anything else — including ``validation_source`` being local /
    # loading / unavailable, or unknown forward-compat values — is
    # downgraded to ``needs_review`` so the boundary never overpromises.
    return "needs_review"


# ---------------------------------------------------------------------------
# Reason list
# ---------------------------------------------------------------------------


# Phase 3M-stable always-on reasons. None of these reflect runtime
# state — they reflect the architectural reality that no production
# export engine, file generation, or audit trail exists yet.
_ALWAYS_REASONS: tuple[ExportReadinessBoundaryReason, ...] = (
    "diagnostic_only_pipeline",
    "no_export_engine",
    "no_file_generation",
    "no_export_audit_trail",
    "no_export_batch_model",
    "no_final_approval_workflow",
    "no_external_posting",
)


def _build_reasons(
    *, has_persisted_profile: bool
) -> list[ExportReadinessBoundaryReason]:
    reasons: list[ExportReadinessBoundaryReason] = list(_ALWAYS_REASONS)
    # Phase 3M default: no profile catalog model exists, so persisted
    # profiles are unavailable. Callers that genuinely have a
    # persisted profile (none today) can suppress this reason via
    # ``has_persisted_profile=True``.
    if not has_persisted_profile:
        reasons.append("no_export_profile_persistence")
    return reasons


# ---------------------------------------------------------------------------
# Operator + developer copy
# ---------------------------------------------------------------------------


_OPERATOR_COPY: dict[ExportDiagnosticStatus, tuple[str, str]] = {
    "blocked": (
        "Diagnostic blocked · Production export unavailable",
        (
            "This preview has blocking diagnostic issues. Production export "
            "is unavailable and no export file has been generated."
        ),
    ),
    "needs_review": (
        "Diagnostic needs review · Production export unavailable",
        (
            "This preview still has items to review before a future export "
            "workflow could proceed."
        ),
    ),
    "clear": (
        "Diagnostic clear · Production export unavailable",
        (
            "This preview did not surface blocking diagnostic issues, but "
            "Rivera has not generated an export file or created a "
            "production export run."
        ),
    ),
    "not_available": (
        "Diagnostic not available · Production export unavailable",
        (
            "Run a diagnostic preview before evaluating export-style "
            "readiness. Production export is still unavailable."
        ),
    ),
}


def _operator_messages(
    diagnostic_status: ExportDiagnosticStatus,
) -> tuple[str, str]:
    return _OPERATOR_COPY[diagnostic_status]


_DEVELOPER_MESSAGE: str = (
    "Production export readiness is intentionally unavailable until the "
    "export engine, persisted profiles, export runs, audit trail, and "
    "final approval workflow exist."
)


_DISCLAIMERS: tuple[str, ...] = (
    "Diagnostic clear does not mean production export ready.",
    "No export file was generated.",
    "No export run or export audit record was created.",
    "No external accounting system was updated.",
)


# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------


_ALWAYS_NEXT_STEPS: tuple[str, ...] = (
    "Add persisted export profiles.",
    "Add export run and audit models.",
    "Add final approval workflow.",
    "Add controlled file generation.",
    "Add external posting only after file/export audit controls exist.",
)


_STATUS_FIRST_STEP: dict[ExportDiagnosticStatus, str] = {
    "blocked": "Resolve the blocking diagnostic issues surfaced above.",
    "needs_review": (
        "Review warnings, source audit notes, and profile validation issues."
    ),
    "not_available": "Run an operational preview with export-style rows.",
    "clear": (
        "Treat this as diagnostic-only until the production export engine "
        "exists."
    ),
}


def _next_steps(diagnostic_status: ExportDiagnosticStatus) -> list[str]:
    return [_STATUS_FIRST_STEP[diagnostic_status], *_ALWAYS_NEXT_STEPS]
