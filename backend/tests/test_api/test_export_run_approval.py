"""
Phase 6A — API tests for the persisted export run approval
workflow endpoints.

Endpoints under test:
  * ``POST /api/v1/export-runs/{id}/request-approval``
  * ``POST /api/v1/export-runs/{id}/approve-for-file-generation``
  * ``POST /api/v1/export-runs/{id}/reject-approval``

Tests pin:

  * Request returns 200 with ``approval_status="pending_review"``
    and the new approval-requested metadata.
  * Approve from pending + draft_clear returns 200 with
    ``approval_status="approved_for_file_generation"`` AND the
    embedded ``draft_snapshot.file_generated`` / ``finalized`` /
    ``download_available`` / ``production_export_ready`` remain
    ``false`` (Phase 4F hard pins hold).
  * No forbidden export / file / posting / finalisation handle
    keys appear at any nesting depth in any approval endpoint
    response (re-uses the Phase 5E walker).
  * Approving a blocked / needs_review record returns 409.
  * Approving from not_requested returns 409.
  * Rejecting from any non-pending state returns 409.
  * Rejecting without a ``rejection_reason`` returns 422
    (Pydantic-level rejection BEFORE the service is reached).
  * Re-requesting from rejected returns 200 with the rejected
    metadata cleared.
  * Phase 5A PATCH endpoint REMAINS notes-only — sending
    ``approval_status`` / ``approval_notes`` / etc. via PATCH
    returns 422.
  * Approval transitions do NOT add any of the forbidden
    finalisation / file / posting handle endpoints (404 on
    ``/finalize`` / ``/generate-file`` / ``/download``).
"""

from __future__ import annotations

import uuid

import pytest

from tests.test_api.test_export_run_persistence_contract import (
    assert_no_persistence_forbidden_keys,
)


_DRAFTS_ENDPOINT = "/api/v1/export-runs/drafts"
_RUNS_ENDPOINT = "/api/v1/export-runs"


def _clear_input() -> dict:
    return {
        "selected_profile_id": "prof-saved-6a-api",
        "selected_profile_source": "saved",
        "profile_validation_status": "clear",
        "readiness_diagnostic_status": "clear",
        "export_preview_row_count": 5,
        "export_preview_issue_count": 0,
        "blocked_row_count": 0,
        "warning_row_count": 0,
    }


def _blocked_input() -> dict:
    return {
        **_clear_input(),
        "profile_validation_status": "blocked",
        "blocked_row_count": 2,
    }


def _needs_review_input() -> dict:
    return {
        **_clear_input(),
        "warning_row_count": 1,
        "export_preview_issue_count": 1,
    }


async def _create_run(client, auth_headers, draft_input: dict) -> str:
    resp = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": draft_input},
        headers=auth_headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# ---------------------------------------------------------------------------
# 1. New record default + request-approval transition
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_new_record_response_includes_approval_status_not_requested(
    client, auth_headers
):
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 201
    body = response.json()
    assert body["approval_status"] == "not_requested"
    assert body["approval_requested_at"] is None
    assert body["approved_at"] is None
    assert body["rejected_at"] is None
    assert body["approval_notes"] is None
    assert body["rejection_reason"] is None


@pytest.mark.asyncio
async def test_request_approval_endpoint_works(client, auth_headers):
    run_id = await _create_run(client, auth_headers, _clear_input())
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/request-approval",
        json={"approval_notes": "please review"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["approval_status"] == "pending_review"
    assert body["approval_requested_at"] is not None
    assert body["approval_notes"] == "please review"
    # Phase 5A hard pins still hold.
    assert body["phase"] == "draft"
    snap = body["draft_snapshot"]
    assert snap["finalized"] is False
    assert snap["file_generated"] is False
    assert snap["download_available"] is False
    assert snap["production_export_ready"] is False
    # Phase 5E forbidden-handle audit.
    assert_no_persistence_forbidden_keys(body)


# ---------------------------------------------------------------------------
# 2. Approve endpoint — pending + draft_clear path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approve_for_file_generation_endpoint_works(
    client, auth_headers
):
    run_id = await _create_run(client, auth_headers, _clear_input())
    req = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/request-approval",
        json={},
        headers=auth_headers,
    )
    assert req.status_code == 200
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/approve-for-file-generation",
        json={"approval_notes": "LGTM"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["approval_status"] == "approved_for_file_generation"
    assert body["approved_at"] is not None
    assert body["approval_notes"] == "LGTM"
    # Hard contract — even when approved, file/finalisation flags
    # on the embedded snapshot stay false.
    snap = body["draft_snapshot"]
    assert snap["draft_only"] is True
    assert snap["finalized"] is False
    assert snap["file_generated"] is False
    assert snap["download_available"] is False
    assert snap["production_export_ready"] is False
    # Phase / status unchanged.
    assert body["phase"] == "draft"
    assert body["status"] == "draft_clear"
    # Phase 5E forbidden-handle audit.
    assert_no_persistence_forbidden_keys(body)


@pytest.mark.asyncio
async def test_approve_response_has_no_forbidden_handles(
    client, auth_headers
):
    run_id = await _create_run(client, auth_headers, _clear_input())
    await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/request-approval",
        json={},
        headers=auth_headers,
    )
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/approve-for-file-generation",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert_no_persistence_forbidden_keys(body)
    # No approval-flavoured forbidden keys either.
    for key in ("finalized_at", "exported_at", "file_id", "download_url"):
        assert key not in body


# ---------------------------------------------------------------------------
# 3. Approve blocked / needs_review records → 409
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approve_blocked_record_returns_409(client, auth_headers):
    run_id = await _create_run(client, auth_headers, _blocked_input())
    await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/request-approval",
        json={},
        headers=auth_headers,
    )
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/approve-for-file-generation",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 409, response.text
    assert "draft_clear" in response.text


@pytest.mark.asyncio
async def test_approve_needs_review_record_returns_409(
    client, auth_headers
):
    run_id = await _create_run(
        client, auth_headers, _needs_review_input()
    )
    await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/request-approval",
        json={},
        headers=auth_headers,
    )
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/approve-for-file-generation",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 409, response.text


@pytest.mark.asyncio
async def test_approve_from_not_requested_returns_409(client, auth_headers):
    run_id = await _create_run(client, auth_headers, _clear_input())
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/approve-for-file-generation",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 409, response.text
    assert "pending_review" in response.text


# ---------------------------------------------------------------------------
# 4. Reject endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reject_endpoint_works(client, auth_headers):
    run_id = await _create_run(client, auth_headers, _clear_input())
    await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/request-approval",
        json={},
        headers=auth_headers,
    )
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/reject-approval",
        json={
            "rejection_reason": "missing PO number",
            "approval_notes": "see ticket #42",
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["approval_status"] == "rejected"
    assert body["rejected_at"] is not None
    assert body["rejection_reason"] == "missing PO number"
    assert body["approval_notes"] == "see ticket #42"
    # Hard pins still hold.
    snap = body["draft_snapshot"]
    assert snap["finalized"] is False
    assert snap["file_generated"] is False
    assert snap["download_available"] is False
    assert snap["production_export_ready"] is False
    assert_no_persistence_forbidden_keys(body)


@pytest.mark.asyncio
async def test_reject_missing_reason_returns_422(client, auth_headers):
    run_id = await _create_run(client, auth_headers, _clear_input())
    await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/request-approval",
        json={},
        headers=auth_headers,
    )
    # Missing key entirely.
    no_key = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/reject-approval",
        json={},
        headers=auth_headers,
    )
    assert no_key.status_code == 422, no_key.text
    # Whitespace-only reason.
    whitespace = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/reject-approval",
        json={"rejection_reason": "   "},
        headers=auth_headers,
    )
    assert whitespace.status_code == 422, whitespace.text
    # Empty string.
    empty = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/reject-approval",
        json={"rejection_reason": ""},
        headers=auth_headers,
    )
    assert empty.status_code == 422, empty.text


@pytest.mark.asyncio
async def test_reject_from_not_requested_returns_409(client, auth_headers):
    run_id = await _create_run(client, auth_headers, _clear_input())
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/reject-approval",
        json={"rejection_reason": "too early"},
        headers=auth_headers,
    )
    assert response.status_code == 409, response.text


@pytest.mark.asyncio
async def test_reject_from_approved_returns_409(client, auth_headers):
    run_id = await _create_run(client, auth_headers, _clear_input())
    await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/request-approval",
        json={},
        headers=auth_headers,
    )
    await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/approve-for-file-generation",
        json={},
        headers=auth_headers,
    )
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/reject-approval",
        json={"rejection_reason": "changed mind"},
        headers=auth_headers,
    )
    assert response.status_code == 409, response.text


# ---------------------------------------------------------------------------
# 5. Re-request from rejected clears rejection metadata
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_re_request_from_rejected_clears_reject_metadata(
    client, auth_headers
):
    run_id = await _create_run(client, auth_headers, _clear_input())
    await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/request-approval",
        json={},
        headers=auth_headers,
    )
    rej = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/reject-approval",
        json={"rejection_reason": "not yet"},
        headers=auth_headers,
    )
    assert rej.status_code == 200
    # Re-request.
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/request-approval",
        json={"approval_notes": "re-requesting"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["approval_status"] == "pending_review"
    assert body["rejected_at"] is None
    assert body["rejected_by_user_id"] is None
    assert body["rejection_reason"] is None
    assert body["approval_notes"] == "re-requesting"


# ---------------------------------------------------------------------------
# 6. PATCH /export-runs/{id} REMAINS notes-only
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "field, value",
    [
        ("approval_status", "pending_review"),
        ("approval_status", "approved_for_file_generation"),
        ("approval_notes", "smuggled approval"),
        ("rejection_reason", "smuggled reject"),
        ("approval_requested_at", "2099-01-01T00:00:00Z"),
        ("approved_at", "2099-01-01T00:00:00Z"),
        ("rejected_at", "2099-01-01T00:00:00Z"),
        ("approved_by_user_id", "11111111-1111-1111-1111-111111111111"),
        ("rejected_by_user_id", "22222222-2222-2222-2222-222222222222"),
    ],
)
@pytest.mark.asyncio
async def test_patch_rejects_approval_fields(
    client, auth_headers, field, value
):
    """Phase 5A's PATCH endpoint uses ``ExportRunUpdate`` with
    ``extra="forbid"``. Phase 6A confirms the approval columns
    cannot be smuggled through the generic PATCH; transitions
    MUST go through the explicit POST endpoints."""
    run_id = await _create_run(client, auth_headers, _clear_input())
    response = await client.patch(
        f"{_RUNS_ENDPOINT}/{run_id}",
        json={field: value},
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_patch_notes_still_works_after_phase_6a(client, auth_headers):
    """Defence-in-depth — Phase 5A's notes-only PATCH must still
    work end-to-end after Phase 6A's additive changes."""
    run_id = await _create_run(client, auth_headers, _clear_input())
    response = await client.patch(
        f"{_RUNS_ENDPOINT}/{run_id}",
        json={"notes": "post-eval audit comment"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["notes"] == "post-eval audit comment"
    # PATCH did not touch approval state.
    assert body["approval_status"] == "not_requested"


# ---------------------------------------------------------------------------
# 7. No finalize / generate-file / download endpoints exist
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_finalize_endpoint_does_not_exist(client, auth_headers):
    run_id = await _create_run(client, auth_headers, _clear_input())
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/finalize",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_generate_file_endpoint_does_not_exist(client, auth_headers):
    run_id = await _create_run(client, auth_headers, _clear_input())
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/generate-file",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_download_endpoint_does_not_exist(client, auth_headers):
    run_id = await _create_run(client, auth_headers, _clear_input())
    response = await client.get(
        f"{_RUNS_ENDPOINT}/{run_id}/download",
        headers=auth_headers,
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_post_endpoint_does_not_exist(client, auth_headers):
    """No external posting endpoint."""
    run_id = await _create_run(client, auth_headers, _clear_input())
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/post",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_mark_exported_endpoint_does_not_exist(client, auth_headers):
    run_id = await _create_run(client, auth_headers, _clear_input())
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/mark-exported",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# 8. Missing run id → 404 on every transition endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_approval_missing_id_returns_404(
    client, auth_headers
):
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{uuid.uuid4()}/request-approval",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_approve_missing_id_returns_404(client, auth_headers):
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{uuid.uuid4()}/approve-for-file-generation",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_reject_missing_id_returns_404(client, auth_headers):
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{uuid.uuid4()}/reject-approval",
        json={"rejection_reason": "x"},
        headers=auth_headers,
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# 9. Transition request schemas reject extras
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "endpoint_path, body",
    [
        (
            "request-approval",
            {"approval_notes": "ok", "approval_status": "pending_review"},
        ),
        (
            "approve-for-file-generation",
            {"approval_notes": "ok", "phase": "finalized"},
        ),
        (
            "reject-approval",
            {
                "rejection_reason": "x",
                "approval_status": "approved_for_file_generation",
            },
        ),
        (
            "reject-approval",
            {"rejection_reason": "x", "draft_snapshot": {"finalized": True}},
        ),
        (
            "reject-approval",
            {"rejection_reason": "x", "download_url": "https://x"},
        ),
    ],
)
@pytest.mark.asyncio
async def test_transition_endpoints_reject_extra_fields(
    client, auth_headers, endpoint_path, body
):
    """All three transition request schemas use
    ``extra="forbid"`` so a forged body cannot smuggle a status /
    phase / snapshot field — even if the row is in the right
    source state for the transition."""
    run_id = await _create_run(client, auth_headers, _clear_input())
    # Make sure the row is pending_review for the approve / reject
    # tests so the 422 we get is from extras, not from a 409.
    if endpoint_path != "request-approval":
        await client.post(
            f"{_RUNS_ENDPOINT}/{run_id}/request-approval",
            json={},
            headers=auth_headers,
        )
    response = await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/{endpoint_path}",
        json=body,
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


# ---------------------------------------------------------------------------
# 10. List endpoint surfaces approval_status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_summary_includes_approval_status(client, auth_headers):
    """``ExportRunSummary`` (Phase 6A) carries ``approval_status``
    so a future audit-list filter can branch on it without
    round-tripping to GET-by-id."""
    run_id = await _create_run(client, auth_headers, _clear_input())
    await client.post(
        f"{_RUNS_ENDPOINT}/{run_id}/request-approval",
        json={},
        headers=auth_headers,
    )
    response = await client.get(_RUNS_ENDPOINT, headers=auth_headers)
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    target = next(item for item in items if item["id"] == run_id)
    assert target["approval_status"] == "pending_review"
