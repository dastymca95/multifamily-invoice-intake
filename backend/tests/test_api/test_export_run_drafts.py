"""
Phase 4F — API smoke tests for the Export Run Draft endpoint.

POST /api/v1/export-run-drafts/evaluate

Smoke-only — exhaustive rule coverage lives in the service tests
(``test_export_run_draft.py``). These tests verify the API plumbing:

  * Hard-pinned literals (``draft_only`` / ``finalized`` /
    ``file_generated`` / ``download_available`` /
    ``production_export_ready``) hold on the wire.
  * Empty input returns ``not_available`` without requiring any
    persisted record.
  * Cleanest-possible "ready"-looking input returns ``draft_clear``
    AND keeps every hard pin.
  * Malformed payload returns 422.
  * Forbidden export / file / posting handles do NOT appear in
    the response (re-uses the Phase 3O audit helper).
"""

from __future__ import annotations

import pytest

from tests.test_api.test_operational_preview_contract import (
    assert_no_export_handles,
)


# ---------------------------------------------------------------------------
# Empty / minimal input
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_endpoint_returns_draft_only_true(client, auth_headers):
    response = await client.post(
        "/api/v1/export-run-drafts/evaluate",
        json={"input": {}},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["draft_only"] is True
    assert body["finalized"] is False
    assert body["file_generated"] is False
    assert body["download_available"] is False
    assert body["production_export_ready"] is False


@pytest.mark.asyncio
async def test_endpoint_accepts_omitted_input_field(client, auth_headers):
    """``input`` defaults to an empty model — body can be ``{}``."""
    response = await client.post(
        "/api/v1/export-run-drafts/evaluate",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["draft_only"] is True
    assert body["status"] == "not_available"


@pytest.mark.asyncio
async def test_endpoint_returns_not_available_for_empty_input(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-run-drafts/evaluate",
        json={"input": {}},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "not_available"
    # Default reasons include all "no production component" entries.
    expected_subset = {
        "diagnostic_only_pipeline",
        "no_export_engine",
        "no_file_generation",
        "no_export_run_persistence",
        "no_final_approval",
        "no_export_audit_trail",
        "no_external_posting",
        "no_rows_to_export",
        "profile_not_persisted",
    }
    assert expected_subset.issubset(set(body["reasons"]))


# ---------------------------------------------------------------------------
# Cleanest-possible "draft_clear" path keeps every hard pin
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_clear_path_returns_draft_clear_with_hard_pins(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-run-drafts/evaluate",
        json={
            "input": {
                "selected_profile_id": "prof-saved-1",
                "selected_profile_source": "saved",
                "profile_validation_status": "clear",
                "readiness_diagnostic_status": "clear",
                "export_preview_row_count": 5,
                "export_preview_issue_count": 0,
                "blocked_row_count": 0,
                "warning_row_count": 0,
            }
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "draft_clear"
    # Hard pins remain even on the cleanest path.
    assert body["draft_only"] is True
    assert body["finalized"] is False
    assert body["file_generated"] is False
    assert body["download_available"] is False
    assert body["production_export_ready"] is False
    # Operator title still carries the boundary phrase.
    assert "Production export unavailable" in body["operator_title"]


@pytest.mark.asyncio
async def test_caller_production_ready_claim_is_ignored(client, auth_headers):
    """Defence in depth — even if the caller flips
    ``production_export_ready=true``, the response stays pinned."""
    response = await client.post(
        "/api/v1/export-run-drafts/evaluate",
        json={
            "input": {
                "selected_profile_id": "prof-saved-1",
                "selected_profile_source": "saved",
                "profile_validation_status": "clear",
                "readiness_diagnostic_status": "clear",
                "export_preview_row_count": 5,
                "production_export_ready": True,
            }
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["production_export_ready"] is False
    # Caller's claim is captured inside the context echo for audit.
    assert (
        body["context"]["input_production_export_ready_claim"] is True
    )


# ---------------------------------------------------------------------------
# Built-in profile source never reaches draft_clear
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_built_in_source_does_not_reach_draft_clear(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-run-drafts/evaluate",
        json={
            "input": {
                "selected_profile_id": "builtin:custom-csv-mirror",
                "selected_profile_source": "built_in",
                "profile_validation_status": "clear",
                "readiness_diagnostic_status": "clear",
                "export_preview_row_count": 5,
            }
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "needs_review"
    assert "profile_not_persisted" in body["reasons"]


# ---------------------------------------------------------------------------
# Forbidden export handles
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_response_has_no_forbidden_export_handles(client, auth_headers):
    response = await client.post(
        "/api/v1/export-run-drafts/evaluate",
        json={
            "input": {
                "selected_profile_id": "prof-saved-1",
                "selected_profile_source": "saved",
                "profile_validation_status": "clear",
                "readiness_diagnostic_status": "clear",
                "export_preview_row_count": 5,
                "operational_result_id": "op-1",
                "template_id": "tmpl-1",
                "document_id": "doc-1",
                "batch_id": "batch-1",
            }
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert_no_export_handles(response.json())


# ---------------------------------------------------------------------------
# Pydantic enforcement → 422 on malformed payload
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_endpoint_422_on_non_object_input(client, auth_headers):
    response = await client.post(
        "/api/v1/export-run-drafts/evaluate",
        json={"input": "not-an-object"},
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_endpoint_422_on_wrong_field_type(client, auth_headers):
    response = await client.post(
        "/api/v1/export-run-drafts/evaluate",
        json={
            "input": {"export_preview_row_count": "many"},
        },
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


# ---------------------------------------------------------------------------
# Disclaimers + next steps round-trip cleanly
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_endpoint_response_includes_required_disclaimers(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-run-drafts/evaluate",
        json={"input": {}},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    disclaimers = response.json()["disclaimers"]
    assert (
        "Export draft clear does not mean production export ready."
        in disclaimers
    )
    assert "No export file was generated." in disclaimers
    assert "No finalized export run was created." in disclaimers
    assert "No external accounting system was updated." in disclaimers


@pytest.mark.asyncio
async def test_endpoint_response_next_steps_include_engine_safeguards(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-run-drafts/evaluate",
        json={"input": {}},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    next_steps = response.json()["next_steps"]
    assert "Add export run persistence and audit trail." in next_steps
    assert "Add final approval workflow." in next_steps
    assert "Add controlled file generation." in next_steps
    assert (
        "Add external posting only after export audit controls exist."
        in next_steps
    )
