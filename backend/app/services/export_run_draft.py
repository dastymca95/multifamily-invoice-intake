"""
Phase 4F — Export Run Draft service.

Pure deterministic builder that turns the operator's current
diagnostic snapshot into an ``ExportRunDraft`` verdict.

Hard contract:

  * ``draft_only`` is **always True**.
  * ``finalized`` is **always False**.
  * ``file_generated`` is **always False**.
  * ``download_available`` is **always False**.
  * ``production_export_ready`` is **always False**, even when the
    caller's input claims production-ready. The Pydantic
    ``Literal[False]`` on the response model makes this physically
    impossible to widen.
  * Pure / synchronous — no DB, no I/O, no side effects.
  * Never throws on unknown / forward-compat status strings;
    classifies conservatively.

Status verdict:

  * ``not_available`` — no preview rows OR no profile selected
    OR no result context at all.
  * ``blocked`` — profile validation blocked / conflict OR
    readiness diagnostic blocked OR ``blocked_row_count > 0``.
  * ``needs_review`` — profile validation needs_review / warning
    OR readiness diagnostic needs_review OR
    ``warning_row_count > 0`` OR ``export_preview_issue_count > 0``.
  * ``draft_clear`` — ONLY when every signal is positive AND the
    selected profile came from the persisted catalog (built-in
    starters never reach ``draft_clear`` because they don't satisfy
    ``profile_not_persisted``).

Even in ``draft_clear``, the disclaimer + reasons + flags make it
explicit that production export remains unavailable.
"""

from __future__ import annotations

from app.schemas.export_run_draft import (
    ExportRunDraft,
    ExportRunDraftInput,
    ExportRunDraftReason,
    ExportRunDraftStatus,
)


__all__ = [
    "build_export_run_draft",
    "build_export_run_draft_from_input",
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_export_run_draft(
    *,
    operational_result_id: str | None = None,
    template_id: str | None = None,
    document_id: str | None = None,
    batch_id: str | None = None,
    selected_profile_id: str | None = None,
    selected_profile_source: str | None = None,
    profile_validation_status: str | None = None,
    readiness_diagnostic_status: str | None = None,
    production_export_ready: bool = False,
    export_preview_row_count: int = 0,
    export_preview_issue_count: int = 0,
    blocked_row_count: int = 0,
    warning_row_count: int = 0,
    context: dict | None = None,
) -> ExportRunDraft:
    """Build the draft from explicit kwargs.

    All arguments are keyword-only so callers don't accidentally
    transpose two strings; defaults match the "no draft data yet"
    baseline (``not_available``). Always returns a valid draft —
    never throws.

    The caller-supplied ``production_export_ready`` is intentionally
    accepted but IGNORED for the response field (Pydantic Literal
    keeps the response field hard-pinned to ``False``). It feeds the
    classifier so a future export-engine integration can pass a
    real signal without churning the request schema.
    """
    status = _classify_status(
        selected_profile_id=selected_profile_id,
        profile_validation_status=profile_validation_status,
        readiness_diagnostic_status=readiness_diagnostic_status,
        export_preview_row_count=export_preview_row_count,
        export_preview_issue_count=export_preview_issue_count,
        blocked_row_count=blocked_row_count,
        warning_row_count=warning_row_count,
        selected_profile_source=selected_profile_source,
    )

    reasons = _build_reasons(
        status=status,
        selected_profile_source=selected_profile_source,
        profile_validation_status=profile_validation_status,
        readiness_diagnostic_status=readiness_diagnostic_status,
        export_preview_row_count=export_preview_row_count,
        export_preview_issue_count=export_preview_issue_count,
        blocked_row_count=blocked_row_count,
        warning_row_count=warning_row_count,
    )

    operator_title, operator_message = _operator_messages(status)
    next_steps = _next_steps(status)

    # Build a quiet context echo. We never fabricate fields; only
    # surface what the caller sent. The IDs are carried verbatim so
    # the operator's banner / paste-into-Slack stays meaningful.
    # Phase 3O regression — none of these keys are forbidden.
    echoed_context: dict | None
    fields_to_echo = {
        "operational_result_id": operational_result_id,
        "template_id": template_id,
        "document_id": document_id,
        "batch_id": batch_id,
    }
    has_caller_context = (
        context is not None
        or any(v is not None for v in fields_to_echo.values())
    )
    if has_caller_context:
        echoed_context = {}
        if context is not None:
            echoed_context.update(context)
        for k, v in fields_to_echo.items():
            if v is not None:
                echoed_context.setdefault(k, v)
    else:
        echoed_context = None

    # ``production_export_ready`` from input is intentionally IGNORED
    # in the response. We capture it on the audit-style "input
    # echoed" path inside the context so a future Slack paste makes
    # the discrepancy visible — but the response field stays False.
    if production_export_ready and echoed_context is not None:
        echoed_context.setdefault(
            "input_production_export_ready_claim",
            production_export_ready,
        )
    elif production_export_ready:
        echoed_context = {
            "input_production_export_ready_claim": production_export_ready,
        }

    return ExportRunDraft(
        draft_only=True,
        finalized=False,
        file_generated=False,
        download_available=False,
        production_export_ready=False,
        status=status,
        reasons=reasons,
        selected_profile_id=selected_profile_id,
        selected_profile_source=selected_profile_source,
        row_count=max(export_preview_row_count, 0),
        blocked_row_count=max(blocked_row_count, 0),
        warning_row_count=max(warning_row_count, 0),
        operator_title=operator_title,
        operator_message=operator_message,
        developer_message=_DEVELOPER_MESSAGE,
        next_steps=next_steps,
        disclaimers=list(_DISCLAIMERS),
        context=echoed_context,
    )


def build_export_run_draft_from_input(
    input_: ExportRunDraftInput,
) -> ExportRunDraft:
    """Convenience wrapper for the Pydantic-input form (used by the
    optional ``/export-run-drafts/evaluate`` endpoint)."""
    return build_export_run_draft(
        operational_result_id=input_.operational_result_id,
        template_id=input_.template_id,
        document_id=input_.document_id,
        batch_id=input_.batch_id,
        selected_profile_id=input_.selected_profile_id,
        selected_profile_source=input_.selected_profile_source,
        profile_validation_status=input_.profile_validation_status,
        readiness_diagnostic_status=input_.readiness_diagnostic_status,
        production_export_ready=input_.production_export_ready,
        export_preview_row_count=input_.export_preview_row_count,
        export_preview_issue_count=input_.export_preview_issue_count,
        blocked_row_count=input_.blocked_row_count,
        warning_row_count=input_.warning_row_count,
        context=input_.context,
    )


# ---------------------------------------------------------------------------
# Status classifier
# ---------------------------------------------------------------------------


_BLOCKING_STATUSES: frozenset[str] = frozenset({"blocked", "conflict"})
_REVIEW_STATUSES: frozenset[str] = frozenset(
    {"needs_review", "warning", "warnings"}
)
_CLEAR_STATUSES: frozenset[str] = frozenset({"clear", "ready"})
_SAVED_PROFILE_SOURCES: frozenset[str] = frozenset({"saved"})


def _classify_status(
    *,
    selected_profile_id: str | None,
    profile_validation_status: str | None,
    readiness_diagnostic_status: str | None,
    export_preview_row_count: int,
    export_preview_issue_count: int,
    blocked_row_count: int,
    warning_row_count: int,
    selected_profile_source: str | None,
) -> ExportRunDraftStatus:
    # ---- Not-available short-circuit -------------------------------------
    # No rows, no selected profile, or zero context — there's
    # nothing to draft against.
    if export_preview_row_count <= 0:
        return "not_available"
    if not selected_profile_id:
        return "not_available"

    # ---- Blocked --------------------------------------------------------
    if (
        profile_validation_status in _BLOCKING_STATUSES
        or readiness_diagnostic_status in _BLOCKING_STATUSES
    ):
        return "blocked"
    if blocked_row_count > 0:
        return "blocked"

    # ---- Needs review ---------------------------------------------------
    if (
        profile_validation_status in _REVIEW_STATUSES
        or readiness_diagnostic_status in _REVIEW_STATUSES
    ):
        return "needs_review"
    if warning_row_count > 0 or export_preview_issue_count > 0:
        return "needs_review"

    # ---- Draft clear ----------------------------------------------------
    # All signals positive AND the selected profile came from the
    # persisted catalog (built-in starters never reach draft_clear).
    profile_clear = profile_validation_status in _CLEAR_STATUSES
    readiness_clear = readiness_diagnostic_status in _CLEAR_STATUSES
    profile_persisted = selected_profile_source in _SAVED_PROFILE_SOURCES
    if profile_clear and readiness_clear and profile_persisted:
        return "draft_clear"

    # Anything else (missing positive signal, or a forward-compat
    # status the classifier doesn't recognise) trends conservative
    # — keep the operator from misreading "I picked a built-in
    # starter and it looks fine" as "draft_clear".
    return "needs_review"


# ---------------------------------------------------------------------------
# Reason list
# ---------------------------------------------------------------------------


_ALWAYS_REASONS: tuple[ExportRunDraftReason, ...] = (
    "diagnostic_only_pipeline",
    "no_export_engine",
    "no_file_generation",
    "no_export_run_persistence",
    "no_final_approval",
    "no_export_audit_trail",
    "no_external_posting",
)


def _build_reasons(
    *,
    status: ExportRunDraftStatus,
    selected_profile_source: str | None,
    profile_validation_status: str | None,
    readiness_diagnostic_status: str | None,
    export_preview_row_count: int,
    export_preview_issue_count: int,
    blocked_row_count: int,
    warning_row_count: int,
) -> list[ExportRunDraftReason]:
    reasons: list[ExportRunDraftReason] = list(_ALWAYS_REASONS)

    # Profile persistence — the draft contract treats anything
    # other than a saved-catalog selection as "not persisted",
    # including built-in / inline / unknown / null.
    if selected_profile_source not in _SAVED_PROFILE_SOURCES:
        reasons.append("profile_not_persisted")

    # Row coverage.
    if export_preview_row_count <= 0:
        reasons.append("no_rows_to_export")

    # Profile validation status.
    if profile_validation_status in _BLOCKING_STATUSES:
        reasons.append("profile_validation_blocked")
    elif profile_validation_status in _REVIEW_STATUSES:
        reasons.append("profile_validation_needs_review")

    # Readiness boundary.
    if (
        readiness_diagnostic_status in _BLOCKING_STATUSES
        or readiness_diagnostic_status in _REVIEW_STATUSES
        or readiness_diagnostic_status == "not_available"
    ):
        reasons.append("readiness_boundary_not_clear")

    # Row issues.
    if (
        blocked_row_count > 0
        or warning_row_count > 0
        or export_preview_issue_count > 0
    ):
        reasons.append("row_issues_present")

    # Status-specific signal — kept silent when status reasons
    # already cover the situation. ``not_available`` is implied by
    # ``no_rows_to_export``; ``blocked`` / ``needs_review`` / ``draft_clear``
    # are implied by the per-axis reasons above.
    void = status  # noqa: F841 — referenced only for documentation.
    return reasons


# ---------------------------------------------------------------------------
# Operator + developer copy
# ---------------------------------------------------------------------------


_OPERATOR_COPY: dict[ExportRunDraftStatus, tuple[str, str]] = {
    "blocked": (
        "Export draft blocked · Production export unavailable",
        (
            "This draft has blocking issues. No export file has been "
            "generated and no export run has been finalized."
        ),
    ),
    "needs_review": (
        "Export draft needs review · Production export unavailable",
        (
            "This draft has review items that should be resolved before "
            "a future export workflow proceeds."
        ),
    ),
    "draft_clear": (
        "Export draft clear · Production export unavailable",
        (
            "This draft does not show blocking export-profile or row "
            "issues, but Rivera has not generated an export file or "
            "created a finalized export run."
        ),
    ),
    "not_available": (
        "Export draft not available · Production export unavailable",
        (
            "Run an operational preview with export-style rows and "
            "select a saved profile before creating an export draft."
        ),
    ),
}


def _operator_messages(
    status: ExportRunDraftStatus,
) -> tuple[str, str]:
    return _OPERATOR_COPY[status]


_DEVELOPER_MESSAGE: str = (
    "Export draft evaluation is diagnostic-only. Production export "
    "requires export run persistence, approval workflow, audit trail, "
    "controlled file generation, and external-posting safeguards."
)


_DISCLAIMERS: tuple[str, ...] = (
    "Export draft clear does not mean production export ready.",
    "No export file was generated.",
    "No finalized export run was created.",
    "No document, batch, or template was marked exported.",
    "No external accounting system was updated.",
)


# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------


_ALWAYS_NEXT_STEPS: tuple[str, ...] = (
    "Add export run persistence and audit trail.",
    "Add final approval workflow.",
    "Add controlled file generation.",
    "Add external posting only after export audit controls exist.",
)


_STATUS_FIRST_STEP: dict[ExportRunDraftStatus, str] = {
    "not_available": (
        "Run Operational Preview and select a saved export profile."
    ),
    "blocked": "Resolve blocking profile, boundary, or row issues.",
    "needs_review": (
        "Review warning rows, profile validation warnings, and boundary notes."
    ),
    "draft_clear": (
        "Treat this as a draft-only preview until the export engine exists."
    ),
}


def _next_steps(status: ExportRunDraftStatus) -> list[str]:
    return [_STATUS_FIRST_STEP[status], *_ALWAYS_NEXT_STEPS]
