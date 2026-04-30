"""
Phase 3M — Service tests for the Export Readiness Boundary.

These tests pin the boundary contract:

  * ``production_export_ready`` is always False.
  * ``diagnostic_only`` is always True.
  * ``production_export_status`` cannot be ``ready`` (Pydantic Literal
    enforces this at parse time — covered by an explicit test).
  * Default reasons include all "missing production component" entries.
  * Diagnostic status follows the spec rules (not_available / blocked
    / needs_review / clear), including the local-fallback downgrade
    and the parity-drift downgrade.
  * ``no_export_profile_persistence`` defaults on, drops only when
    the caller explicitly says ``has_persisted_profile=True``.
  * Operator title + disclaimers carry the required boundary copy.

Pure / synchronous — no fixtures, no DB, no client.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.export_readiness_boundary import (
    ExportReadinessBoundary,
    ExportReadinessBoundaryInput,
)
from app.services.export_readiness_boundary import (
    build_export_readiness_boundary,
    build_export_readiness_boundary_from_input,
)


# ---------------------------------------------------------------------------
# Hard contract — production export status + flags
# ---------------------------------------------------------------------------


def test_production_export_ready_is_always_false():
    cases = [
        # No data — not_available.
        dict(),
        # Clear backend-verified — most "ready"-looking case.
        dict(
            has_result=True,
            has_preview_rows=True,
            profile_validation_status="clear",
            operational_status="ready",
            parity_status="aligned",
            validation_source="backend",
        ),
        # Blocked.
        dict(
            has_result=True,
            has_preview_rows=True,
            profile_validation_status="blocked",
        ),
    ]
    for kw in cases:
        b = build_export_readiness_boundary(**kw)
        assert b.production_export_ready is False, kw
        assert b.diagnostic_only is True, kw
        assert b.production_export_status == "unavailable", kw


def test_diagnostic_only_is_always_true():
    b = build_export_readiness_boundary()
    assert b.diagnostic_only is True


def test_production_export_ready_cannot_be_widened_to_true():
    # Pydantic enforces the Literal[False] at construction time —
    # a downstream caller cannot build an ``ExportReadinessBoundary``
    # with production_export_ready=True.
    with pytest.raises(ValidationError):
        ExportReadinessBoundary(
            diagnostic_status="clear",
            production_export_status="unavailable",
            production_export_ready=True,  # type: ignore[arg-type]
            diagnostic_only=True,
            operator_title="x",
            operator_message="x",
            developer_message="x",
        )


def test_production_export_status_ready_is_not_representable():
    # Same Pydantic guard at the type level — ``ready`` is not in
    # the ``ProductionExportStatus`` Literal.
    with pytest.raises(ValidationError):
        ExportReadinessBoundary(
            diagnostic_status="clear",
            production_export_status="ready",  # type: ignore[arg-type]
            production_export_ready=False,
            diagnostic_only=True,
            operator_title="x",
            operator_message="x",
            developer_message="x",
        )


# ---------------------------------------------------------------------------
# Reasons
# ---------------------------------------------------------------------------


def test_default_reasons_include_all_missing_production_components():
    b = build_export_readiness_boundary()
    expected = {
        "diagnostic_only_pipeline",
        "no_export_engine",
        "no_file_generation",
        "no_export_audit_trail",
        "no_export_batch_model",
        "no_final_approval_workflow",
        "no_external_posting",
        "no_export_profile_persistence",
    }
    assert set(b.reasons) == expected


def test_no_export_profile_persistence_included_by_default():
    b = build_export_readiness_boundary(has_persisted_profile=False)
    assert "no_export_profile_persistence" in b.reasons


def test_no_export_profile_persistence_omitted_when_has_persisted_profile():
    b = build_export_readiness_boundary(has_persisted_profile=True)
    assert "no_export_profile_persistence" not in b.reasons
    # Other always-on reasons remain.
    assert "diagnostic_only_pipeline" in b.reasons
    assert "no_export_engine" in b.reasons


# ---------------------------------------------------------------------------
# Diagnostic status — not_available
# ---------------------------------------------------------------------------


def test_no_result_yields_not_available():
    b = build_export_readiness_boundary(
        has_result=False,
        has_preview_rows=True,
    )
    assert b.diagnostic_status == "not_available"


def test_no_preview_rows_yields_not_available():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=False,
    )
    assert b.diagnostic_status == "not_available"


def test_default_inputs_yield_not_available():
    b = build_export_readiness_boundary()
    assert b.diagnostic_status == "not_available"


# ---------------------------------------------------------------------------
# Diagnostic status — blocked
# ---------------------------------------------------------------------------


def test_profile_validation_blocked_yields_blocked():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="blocked",
    )
    assert b.diagnostic_status == "blocked"


def test_profile_validation_conflict_yields_blocked():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="conflict",
    )
    assert b.diagnostic_status == "blocked"


def test_operational_status_blocked_yields_blocked():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        operational_status="blocked",
        profile_validation_status="clear",
        validation_source="backend",
    )
    assert b.diagnostic_status == "blocked"


# ---------------------------------------------------------------------------
# Diagnostic status — needs_review
# ---------------------------------------------------------------------------


def test_profile_validation_needs_review_yields_needs_review():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="needs_review",
        validation_source="backend",
    )
    assert b.diagnostic_status == "needs_review"


def test_parity_major_drift_yields_needs_review():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="clear",
        operational_status="clear",
        parity_status="major_drift",
        validation_source="backend",
    )
    assert b.diagnostic_status == "needs_review"


def test_parity_minor_drift_yields_needs_review():
    # Per spec: minor_drift ALSO downgrades on the backend, even
    # though the frontend is laxer. Backend is the canonical source
    # of truth — we trend conservative.
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="clear",
        operational_status="clear",
        parity_status="minor_drift",
        validation_source="backend",
    )
    assert b.diagnostic_status == "needs_review"


def test_local_validation_source_downgrades_clear_to_needs_review():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="clear",
        operational_status="clear",
        parity_status="aligned",
        validation_source="local",
    )
    assert b.diagnostic_status == "needs_review"


def test_unavailable_validation_source_downgrades_clear_to_needs_review():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="clear",
        validation_source="unavailable",
    )
    assert b.diagnostic_status == "needs_review"


# ---------------------------------------------------------------------------
# Diagnostic status — clear (only with backend + everything aligned)
# ---------------------------------------------------------------------------


def test_clear_requires_backend_validation_source():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="clear",
        operational_status="ready",
        parity_status="aligned",
        validation_source="backend",
    )
    assert b.diagnostic_status == "clear"
    # Even when clear, production export remains hard-pinned.
    assert b.production_export_ready is False
    assert b.production_export_status == "unavailable"


def test_clear_accepted_with_absent_operational_and_parity():
    # Per spec: operational_status absent + parity_status absent are
    # both "absent = OK" — they don't block a clear verdict.
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="clear",
        validation_source="backend",
    )
    assert b.diagnostic_status == "clear"


def test_clear_accepted_with_not_checked_parity():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="clear",
        parity_status="not_checked",
        validation_source="backend",
    )
    assert b.diagnostic_status == "clear"


def test_unknown_status_strings_do_not_force_clear():
    # Forward-compat: an unknown profile validation status doesn't
    # match _CLEAR_STATUSES so the classifier downgrades to
    # needs_review rather than blocking or clearing.
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="future_state",
        validation_source="backend",
    )
    assert b.diagnostic_status == "needs_review"


# ---------------------------------------------------------------------------
# Operator + developer copy + disclaimers
# ---------------------------------------------------------------------------


def test_titles_include_production_export_unavailable():
    # Per spec: every status's ``operator_title`` carries the
    # boundary phrase "Production export unavailable". The MESSAGE
    # body varies (e.g. needs_review focuses on the review items),
    # so we only enforce the title here. The blocked / clear /
    # not_available message bodies independently mention production
    # export — covered by the messages-mention-production-export
    # test below.
    for status in ("blocked", "needs_review", "clear", "not_available"):
        kw = dict(
            has_result=True,
            has_preview_rows=True,
            profile_validation_status=status if status != "not_available" else None,
            validation_source="backend"
            if status not in ("not_available", "blocked")
            else None,
        )
        if status == "not_available":
            kw["has_result"] = False
        b = build_export_readiness_boundary(**kw)
        assert "Production export unavailable" in b.operator_title, b


def test_blocked_clear_and_not_available_messages_mention_production_export():
    # Per spec wording — ``blocked`` / ``clear`` / ``not_available``
    # message bodies all explicitly reference production export.
    # ``needs_review`` intentionally focuses on reviewing items
    # instead (the title carries the production-export reminder).
    cases = [
        # blocked
        dict(
            has_result=True,
            has_preview_rows=True,
            profile_validation_status="blocked",
        ),
        # clear (backend-verified)
        dict(
            has_result=True,
            has_preview_rows=True,
            profile_validation_status="clear",
            validation_source="backend",
        ),
        # not_available
        dict(),
    ]
    for kw in cases:
        b = build_export_readiness_boundary(**kw)
        msg = b.operator_message.lower()
        assert "production export" in msg, b


def test_disclaimers_include_required_boundary_lines():
    b = build_export_readiness_boundary()
    text = " ".join(b.disclaimers)
    assert "Diagnostic clear does not mean production export ready." in b.disclaimers
    assert "No export file was generated." in b.disclaimers
    assert "No external accounting system was updated." in b.disclaimers
    # Concatenated check guards against re-ordering breaking other
    # consumers that join the list.
    assert "Diagnostic clear does not mean production export ready." in text


def test_developer_message_explains_intentional_unavailability():
    b = build_export_readiness_boundary()
    assert "intentionally unavailable" in b.developer_message
    assert "export engine" in b.developer_message


# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------


def test_next_steps_always_include_persistence_audit_approval_file_posting():
    b = build_export_readiness_boundary()
    text = " | ".join(b.next_steps)
    assert "Add persisted export profiles." in b.next_steps
    assert "Add export run and audit models." in b.next_steps
    assert "Add final approval workflow." in b.next_steps
    assert "Add controlled file generation." in b.next_steps
    assert (
        "Add external posting only after file/export audit controls exist."
        in b.next_steps
    )
    # First step is status-specific.
    assert b.next_steps[0] == "Run an operational preview with export-style rows."
    assert "Add persisted export profiles." in text  # ordering guard


def test_blocked_next_steps_lead_with_resolve_blocking():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="blocked",
    )
    assert b.next_steps[0] == "Resolve the blocking diagnostic issues surfaced above."


def test_clear_next_steps_lead_with_diagnostic_only_reminder():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="clear",
        validation_source="backend",
    )
    assert b.next_steps[0] == (
        "Treat this as diagnostic-only until the production export engine "
        "exists."
    )


def test_needs_review_next_steps_lead_with_review_warnings():
    b = build_export_readiness_boundary(
        has_result=True,
        has_preview_rows=True,
        profile_validation_status="needs_review",
        validation_source="backend",
    )
    assert b.next_steps[0] == (
        "Review warnings, source audit notes, and profile validation issues."
    )


# ---------------------------------------------------------------------------
# Convenience input wrapper
# ---------------------------------------------------------------------------


def test_build_from_input_matches_kwargs_form():
    kw = dict(
        operational_status="ready",
        profile_validation_status="clear",
        parity_status="aligned",
        validation_source="backend",
        has_result=True,
        has_preview_rows=True,
        has_persisted_profile=False,
    )
    via_kwargs = build_export_readiness_boundary(**kw)
    via_input = build_export_readiness_boundary_from_input(
        ExportReadinessBoundaryInput(**kw)
    )
    assert via_kwargs.model_dump() == via_input.model_dump()
