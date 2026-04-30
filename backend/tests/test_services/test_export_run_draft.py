"""
Phase 4F — Service tests for the Export Run Draft contract.

These tests pin the diagnostic-only behaviour:

  * ``draft_only`` / ``finalized`` / ``file_generated`` /
    ``download_available`` / ``production_export_ready`` are
    hard-pinned to the right literals (Pydantic enforces them at
    parse time — explicit construction tests confirm).
  * Status classifier honours blocked / needs_review / draft_clear
    / not_available rules + every reason axis the spec defines.
  * Reasons always include the architectural always-on entries.
  * Built-in starter selection never reaches ``draft_clear``
    (saved persistence is required).
  * Even ``draft_clear`` keeps ``production_export_ready=False``.
  * Forbidden export / file / posting handles do NOT appear in
    the serialised response.

Pure / synchronous — no DB, no fixtures.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.export_run_draft import (
    ExportRunDraft,
    ExportRunDraftInput,
)
from app.services.export_run_draft import (
    build_export_run_draft,
    build_export_run_draft_from_input,
)
from tests.test_api.test_operational_preview_contract import (
    assert_no_export_handles,
)


# ---------------------------------------------------------------------------
# Hard-pinned literals
# ---------------------------------------------------------------------------


def test_draft_only_always_true_across_inputs():
    cases = [
        # No data — not_available.
        dict(),
        # Saved + clear — most "ready"-looking.
        dict(
            selected_profile_id="prof-saved-1",
            selected_profile_source="saved",
            profile_validation_status="clear",
            readiness_diagnostic_status="clear",
            export_preview_row_count=3,
        ),
        # Blocked.
        dict(
            selected_profile_id="prof-saved-2",
            selected_profile_source="saved",
            profile_validation_status="blocked",
            export_preview_row_count=3,
        ),
        # Caller claims production-ready — IGNORED.
        dict(
            selected_profile_id="prof-saved-3",
            selected_profile_source="saved",
            profile_validation_status="clear",
            readiness_diagnostic_status="clear",
            export_preview_row_count=3,
            production_export_ready=True,
        ),
    ]
    for kw in cases:
        d = build_export_run_draft(**kw)
        assert d.draft_only is True, kw
        assert d.finalized is False, kw
        assert d.file_generated is False, kw
        assert d.download_available is False, kw
        assert d.production_export_ready is False, kw


def test_pydantic_blocks_widening_draft_only_to_false():
    with pytest.raises(ValidationError):
        ExportRunDraft(
            draft_only=False,  # type: ignore[arg-type]
            finalized=False,
            file_generated=False,
            download_available=False,
            production_export_ready=False,
            status="draft_clear",
            operator_title="x",
            operator_message="x",
            developer_message="x",
        )


def test_pydantic_blocks_widening_finalized_to_true():
    with pytest.raises(ValidationError):
        ExportRunDraft(
            draft_only=True,
            finalized=True,  # type: ignore[arg-type]
            file_generated=False,
            download_available=False,
            production_export_ready=False,
            status="draft_clear",
            operator_title="x",
            operator_message="x",
            developer_message="x",
        )


def test_pydantic_blocks_widening_production_export_ready_to_true():
    with pytest.raises(ValidationError):
        ExportRunDraft(
            draft_only=True,
            finalized=False,
            file_generated=False,
            download_available=False,
            production_export_ready=True,  # type: ignore[arg-type]
            status="draft_clear",
            operator_title="x",
            operator_message="x",
            developer_message="x",
        )


def test_pydantic_blocks_widening_file_generated_to_true():
    with pytest.raises(ValidationError):
        ExportRunDraft(
            draft_only=True,
            finalized=False,
            file_generated=True,  # type: ignore[arg-type]
            download_available=False,
            production_export_ready=False,
            status="draft_clear",
            operator_title="x",
            operator_message="x",
            developer_message="x",
        )


def test_pydantic_blocks_widening_download_available_to_true():
    with pytest.raises(ValidationError):
        ExportRunDraft(
            draft_only=True,
            finalized=False,
            file_generated=False,
            download_available=True,  # type: ignore[arg-type]
            production_export_ready=False,
            status="draft_clear",
            operator_title="x",
            operator_message="x",
            developer_message="x",
        )


# ---------------------------------------------------------------------------
# Default reasons
# ---------------------------------------------------------------------------


def test_reasons_always_include_architectural_blockers():
    d = build_export_run_draft()
    expected_subset = {
        "diagnostic_only_pipeline",
        "no_export_engine",
        "no_file_generation",
        "no_export_run_persistence",
        "no_final_approval",
        "no_export_audit_trail",
        "no_external_posting",
    }
    assert expected_subset.issubset(set(d.reasons))


# ---------------------------------------------------------------------------
# not_available
# ---------------------------------------------------------------------------


def test_no_rows_yields_not_available():
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        export_preview_row_count=0,
    )
    assert d.status == "not_available"
    assert "no_rows_to_export" in d.reasons


def test_no_profile_yields_not_available():
    d = build_export_run_draft(
        export_preview_row_count=5,
    )
    assert d.status == "not_available"


def test_default_inputs_yield_not_available():
    d = build_export_run_draft()
    assert d.status == "not_available"


# ---------------------------------------------------------------------------
# Built-in profile source → not persisted
# ---------------------------------------------------------------------------


def test_built_in_profile_source_adds_profile_not_persisted():
    d = build_export_run_draft(
        selected_profile_id="builtin:custom-csv-mirror",
        selected_profile_source="built_in",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=3,
    )
    assert "profile_not_persisted" in d.reasons


def test_built_in_profile_source_never_reaches_draft_clear():
    d = build_export_run_draft(
        selected_profile_id="builtin:custom-csv-mirror",
        selected_profile_source="built_in",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=3,
    )
    assert d.status == "needs_review"


def test_inline_profile_source_also_not_persisted():
    d = build_export_run_draft(
        selected_profile_id="inline-1",
        selected_profile_source="inline",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=3,
    )
    assert "profile_not_persisted" in d.reasons
    assert d.status == "needs_review"


def test_unknown_profile_source_treated_as_not_persisted():
    d = build_export_run_draft(
        selected_profile_id="prof-x",
        selected_profile_source="unknown",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=3,
    )
    assert "profile_not_persisted" in d.reasons


# ---------------------------------------------------------------------------
# Blocked classifications
# ---------------------------------------------------------------------------


def test_profile_validation_blocked_yields_blocked():
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="blocked",
        export_preview_row_count=3,
    )
    assert d.status == "blocked"
    assert "profile_validation_blocked" in d.reasons


def test_profile_validation_conflict_yields_blocked():
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="conflict",
        export_preview_row_count=3,
    )
    assert d.status == "blocked"
    assert "profile_validation_blocked" in d.reasons


def test_readiness_blocked_yields_blocked():
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="blocked",
        export_preview_row_count=3,
    )
    assert d.status == "blocked"
    assert "readiness_boundary_not_clear" in d.reasons


def test_blocked_rows_yield_blocked():
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=3,
        blocked_row_count=1,
    )
    assert d.status == "blocked"
    assert "row_issues_present" in d.reasons


# ---------------------------------------------------------------------------
# Needs-review classifications
# ---------------------------------------------------------------------------


def test_profile_validation_needs_review_yields_needs_review():
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="needs_review",
        readiness_diagnostic_status="clear",
        export_preview_row_count=3,
    )
    assert d.status == "needs_review"
    assert "profile_validation_needs_review" in d.reasons


def test_readiness_needs_review_yields_needs_review():
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="needs_review",
        export_preview_row_count=3,
    )
    assert d.status == "needs_review"
    assert "readiness_boundary_not_clear" in d.reasons


def test_warning_rows_yield_needs_review():
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=3,
        warning_row_count=2,
    )
    assert d.status == "needs_review"
    assert "row_issues_present" in d.reasons


def test_issue_count_yields_needs_review():
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=3,
        export_preview_issue_count=4,
    )
    assert d.status == "needs_review"
    assert "row_issues_present" in d.reasons


# ---------------------------------------------------------------------------
# draft_clear
# ---------------------------------------------------------------------------


def test_saved_clear_yields_draft_clear():
    d = build_export_run_draft(
        selected_profile_id="prof-saved-default",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=10,
        export_preview_issue_count=0,
        blocked_row_count=0,
        warning_row_count=0,
    )
    assert d.status == "draft_clear"


def test_draft_clear_still_blocks_production():
    d = build_export_run_draft(
        selected_profile_id="prof-saved-default",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=10,
    )
    # Even on the cleanest input, every hard pin holds.
    assert d.status == "draft_clear"
    assert d.draft_only is True
    assert d.finalized is False
    assert d.file_generated is False
    assert d.download_available is False
    assert d.production_export_ready is False
    # Operator title carries the boundary phrase.
    assert "Production export unavailable" in d.operator_title


def test_caller_production_ready_claim_is_ignored():
    """The caller's ``production_export_ready=True`` flag does NOT
    flip the response field — Pydantic Literal[False] enforces it.
    The claim DOES surface inside the context echo so a downstream
    audit can spot the mismatch."""
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=3,
        production_export_ready=True,
    )
    assert d.production_export_ready is False
    assert d.status == "draft_clear"
    assert d.context is not None
    assert (
        d.context.get("input_production_export_ready_claim") is True
    )


# ---------------------------------------------------------------------------
# Forbidden export handles
# ---------------------------------------------------------------------------


def test_serialised_response_has_no_forbidden_export_handles():
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=3,
        operational_result_id="op-result-1",
        template_id="tmpl-1",
        document_id="doc-1",
        batch_id="batch-1",
    )
    # ``model_dump(mode="json")`` matches what FastAPI puts on the
    # wire — re-uses the Phase 3O audit helper.
    assert_no_export_handles(d.model_dump(mode="json"))


# ---------------------------------------------------------------------------
# Operator copy / disclaimers / next steps
# ---------------------------------------------------------------------------


def test_operator_titles_include_production_export_unavailable():
    for status_kw in [
        # blocked
        dict(
            selected_profile_id="p",
            selected_profile_source="saved",
            profile_validation_status="blocked",
            export_preview_row_count=3,
        ),
        # needs_review
        dict(
            selected_profile_id="p",
            selected_profile_source="saved",
            profile_validation_status="needs_review",
            readiness_diagnostic_status="clear",
            export_preview_row_count=3,
        ),
        # draft_clear
        dict(
            selected_profile_id="p",
            selected_profile_source="saved",
            profile_validation_status="clear",
            readiness_diagnostic_status="clear",
            export_preview_row_count=3,
        ),
        # not_available
        dict(),
    ]:
        d = build_export_run_draft(**status_kw)
        assert "Production export unavailable" in d.operator_title, status_kw


def test_disclaimers_include_required_boundary_lines():
    d = build_export_run_draft()
    expected = {
        "Export draft clear does not mean production export ready.",
        "No export file was generated.",
        "No finalized export run was created.",
        "No document, batch, or template was marked exported.",
        "No external accounting system was updated.",
    }
    assert expected.issubset(set(d.disclaimers))


def test_developer_message_mentions_required_safeguards():
    d = build_export_run_draft()
    msg = d.developer_message.lower()
    assert "diagnostic-only" in msg
    assert "approval workflow" in msg
    assert "audit trail" in msg
    assert "file generation" in msg
    assert "external" in msg


def test_next_steps_always_include_persistence_and_audit():
    d = build_export_run_draft()
    text = " | ".join(d.next_steps)
    assert "Add export run persistence and audit trail." in d.next_steps
    assert "Add final approval workflow." in d.next_steps
    assert "Add controlled file generation." in d.next_steps
    assert (
        "Add external posting only after export audit controls exist."
        in d.next_steps
    )
    # First step is status-specific; the not_available default leads
    # with the Operational Preview prompt.
    assert d.next_steps[0] == (
        "Run Operational Preview and select a saved export profile."
    )
    # Concatenated check — guard against re-ordering breaking
    # downstream callers that join the list.
    assert "Add controlled file generation." in text


def test_blocked_first_step_mentions_resolve():
    d = build_export_run_draft(
        selected_profile_id="p",
        selected_profile_source="saved",
        profile_validation_status="blocked",
        export_preview_row_count=3,
    )
    assert d.next_steps[0] == (
        "Resolve blocking profile, boundary, or row issues."
    )


def test_draft_clear_first_step_carries_diagnostic_reminder():
    d = build_export_run_draft(
        selected_profile_id="p",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=3,
    )
    assert d.next_steps[0] == (
        "Treat this as a draft-only preview until the export engine exists."
    )


# ---------------------------------------------------------------------------
# Context echo
# ---------------------------------------------------------------------------


def test_context_echo_carries_caller_ids_when_provided():
    d = build_export_run_draft(
        operational_result_id="op-1",
        template_id="tmpl-1",
        document_id="doc-1",
        batch_id="batch-1",
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        export_preview_row_count=1,
    )
    assert d.context is not None
    assert d.context["operational_result_id"] == "op-1"
    assert d.context["template_id"] == "tmpl-1"
    assert d.context["document_id"] == "doc-1"
    assert d.context["batch_id"] == "batch-1"


def test_context_echo_is_none_when_no_caller_context():
    d = build_export_run_draft()
    assert d.context is None


def test_caller_supplied_context_dict_round_trips():
    d = build_export_run_draft(
        context={"launch_label": "Document: epb-march.pdf"},
    )
    assert d.context is not None
    assert d.context["launch_label"] == "Document: epb-march.pdf"


# ---------------------------------------------------------------------------
# Convenience input wrapper
# ---------------------------------------------------------------------------


def test_build_from_input_matches_kwargs_form():
    kw = dict(
        operational_result_id="op-1",
        template_id="tmpl-1",
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="clear",
        export_preview_row_count=2,
    )
    via_kwargs = build_export_run_draft(**kw)
    via_input = build_export_run_draft_from_input(
        ExportRunDraftInput(**kw)
    )
    assert via_kwargs.model_dump() == via_input.model_dump()


# ---------------------------------------------------------------------------
# Forward-compat — unknown status strings
# ---------------------------------------------------------------------------


def test_unknown_profile_status_does_not_force_clear():
    """Forward-compat: an unknown profile status doesn't fall into
    any classifier bucket, so the draft stays at the conservative
    needs_review verdict instead of accidentally clearing."""
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="future_value",
        readiness_diagnostic_status="clear",
        export_preview_row_count=3,
    )
    assert d.status == "needs_review"


def test_unknown_readiness_status_does_not_force_clear():
    d = build_export_run_draft(
        selected_profile_id="prof-saved",
        selected_profile_source="saved",
        profile_validation_status="clear",
        readiness_diagnostic_status="future_value",
        export_preview_row_count=3,
    )
    assert d.status == "needs_review"
