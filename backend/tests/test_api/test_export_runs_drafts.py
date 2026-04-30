"""
Phase 5A — API tests for the persisted Export Run Draft / audit
endpoints.

Endpoints under test:
  * ``POST /api/v1/export-runs/drafts``
  * ``GET  /api/v1/export-runs``
  * ``GET  /api/v1/export-runs/{id}``
  * ``PATCH /api/v1/export-runs/{id}``

Tests pin:

  * Create returns 201 with the persisted record id under
    ``id`` (NOT ``export_run_id``).
  * Hard pins on the embedded ``draft_snapshot`` (Phase 4F
    contract) round-trip across the wire.
  * Persisted record carries ``phase="draft"``.
  * No forbidden export / file / posting / finalisation handle
    keys appear at any nesting depth in any response.
  * List + read + notes-PATCH plumbing works end-to-end.
  * Built-in profile drafts persist successfully but with status
    ``needs_review`` (the evaluator can never reach
    ``draft_clear`` without a saved profile).
  * draft_clear records still carry the Phase 4F hard pins.
  * Stateless evaluator endpoint (Phase 4F) STILL does NOT
    return any ``id`` / ``export_run_id`` flavour — Phase 5A
    persistence is opt-in through the new endpoint family only.
  * Malformed payload → 422.
  * Missing id → 404.
"""

from __future__ import annotations

import uuid

import pytest

from tests.test_api.test_operational_preview_contract import (
    FORBIDDEN_EXPORT_KEYS,
    assert_no_export_handles,
)


_DRAFTS_ENDPOINT = "/api/v1/export-runs/drafts"
_RUNS_ENDPOINT = "/api/v1/export-runs"
_EVALUATE_ENDPOINT = "/api/v1/export-run-drafts/evaluate"


# Phase 5A also forbids these on the persistence endpoint
# (additions on top of the Phase 3O forbidden set).
_PHASE_5A_FORBIDDEN_TOP_LEVEL: frozenset[str] = FORBIDDEN_EXPORT_KEYS | {
    "finalized_at",
    "exported_at",
    "external_system_id",
}


def _clear_input() -> dict:
    return {
        "selected_profile_id": "prof-saved-5a-api",
        "selected_profile_source": "saved",
        "profile_validation_status": "clear",
        "readiness_diagnostic_status": "clear",
        "export_preview_row_count": 5,
        "export_preview_issue_count": 0,
        "blocked_row_count": 0,
        "warning_row_count": 0,
    }


# ---------------------------------------------------------------------------
# 1. POST creates a record + returns id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_draft_record_201(client, auth_headers):
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    # Phase 5A intentionally uses ``id`` NOT ``export_run_id`` so
    # the Phase 3O / 4I forbidden-handle audit stays sharp.
    assert "id" in body
    # The id parses as a UUID.
    uuid.UUID(body["id"])
    assert "export_run_id" not in body


@pytest.mark.asyncio
async def test_create_draft_record_phase_is_draft(client, auth_headers):
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    assert response.json()["phase"] == "draft"


@pytest.mark.asyncio
async def test_create_draft_record_status_is_draft_clear(
    client, auth_headers
):
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    assert response.json()["status"] == "draft_clear"


# ---------------------------------------------------------------------------
# 2. Hard pins on the embedded draft_snapshot round-trip
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_persisted_draft_snapshot_carries_hard_pins(
    client, auth_headers
):
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    snap = response.json()["draft_snapshot"]
    assert snap["draft_only"] is True
    assert snap["finalized"] is False
    assert snap["file_generated"] is False
    assert snap["download_available"] is False
    assert snap["production_export_ready"] is False


@pytest.mark.asyncio
async def test_draft_clear_record_still_not_finalized(client, auth_headers):
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "draft_clear"
    assert body["phase"] == "draft"
    snap = body["draft_snapshot"]
    assert snap["finalized"] is False
    assert snap["file_generated"] is False
    assert snap["download_available"] is False
    assert snap["production_export_ready"] is False


# ---------------------------------------------------------------------------
# 3. No forbidden export / file / posting / finalisation handles in response
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_response_has_no_export_handles(client, auth_headers):
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={
            "draft_input": _clear_input(),
            "template_id": str(uuid.uuid4()),
            "document_id": str(uuid.uuid4()),
            "batch_id": str(uuid.uuid4()),
            "export_profile_id": str(uuid.uuid4()),
            "export_profile_name": "ResMan CSV v1",
            "export_profile_version": 3,
            "target_system": "custom_csv",
        },
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    assert_no_export_handles(response.json())


@pytest.mark.asyncio
async def test_create_response_has_no_phase_5a_extra_forbidden_keys(
    client, auth_headers
):
    """Phase 5A explicitly adds ``finalized_at`` / ``exported_at`` /
    ``external_system_id`` to the forbidden set. Confirm none of
    them appear at any nesting depth."""
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text

    def _walk(payload, path="$"):
        if isinstance(payload, dict):
            for k, v in payload.items():
                assert k not in _PHASE_5A_FORBIDDEN_TOP_LEVEL, (
                    f"Forbidden key {k!r} at {path}.{k}"
                )
                _walk(v, f"{path}.{k}")
        elif isinstance(payload, list):
            for i, item in enumerate(payload):
                _walk(item, f"{path}[{i}]")

    _walk(response.json())


# ---------------------------------------------------------------------------
# 4. Built-in profile drafts persist but cannot reach draft_clear
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_built_in_profile_persists_with_needs_review(
    client, auth_headers
):
    payload = _clear_input()
    payload["selected_profile_source"] = "built_in"
    payload["selected_profile_id"] = "builtin:custom-csv-mirror"
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": payload},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    # The Phase 4F evaluator cannot reach draft_clear without a
    # saved profile — the persisted status mirrors that verdict.
    assert body["status"] == "needs_review"
    # The hard pins still hold.
    snap = body["draft_snapshot"]
    assert snap["draft_only"] is True
    assert snap["production_export_ready"] is False


# ---------------------------------------------------------------------------
# 5. Empty draft_input persists with status="blocked" (not_available -> blocked)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_empty_draft_input_persists_as_blocked(client, auth_headers):
    """The Phase 4F evaluator returns ``not_available`` for an
    empty input. Phase 5A maps that to ``"blocked"`` on the
    persisted side so the closed status set is honoured."""
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": {}},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "blocked"
    assert body["phase"] == "draft"


# ---------------------------------------------------------------------------
# 6. List endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_returns_records(client, auth_headers):
    a = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    b = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert a.status_code == 201
    assert b.status_code == 201
    a_id = a.json()["id"]
    b_id = b.json()["id"]
    response = await client.get(_RUNS_ENDPOINT, headers=auth_headers)
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    ids = {item["id"] for item in items}
    assert {a_id, b_id} <= ids


@pytest.mark.asyncio
async def test_list_filters_by_status(client, auth_headers):
    clear_resp = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    blocked_resp = await client.post(
        _DRAFTS_ENDPOINT,
        json={
            "draft_input": {
                **_clear_input(),
                "profile_validation_status": "blocked",
                "blocked_row_count": 1,
            }
        },
        headers=auth_headers,
    )
    assert clear_resp.status_code == 201
    assert blocked_resp.status_code == 201
    clear_id = clear_resp.json()["id"]
    blocked_id = blocked_resp.json()["id"]

    response = await client.get(
        f"{_RUNS_ENDPOINT}?status_=draft_clear",
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    ids = {item["id"] for item in response.json()["items"]}
    assert clear_id in ids
    assert blocked_id not in ids


@pytest.mark.asyncio
async def test_list_invalid_status_filter_returns_422(
    client, auth_headers
):
    response = await client.get(
        f"{_RUNS_ENDPOINT}?status_=nonsense",
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_list_response_has_no_export_handles(client, auth_headers):
    await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    response = await client.get(_RUNS_ENDPOINT, headers=auth_headers)
    assert response.status_code == 200, response.text
    assert_no_export_handles(response.json())


# ---------------------------------------------------------------------------
# 7. Read endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_returns_record(client, auth_headers):
    create_resp = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert create_resp.status_code == 201
    run_id = create_resp.json()["id"]

    read_resp = await client.get(
        f"{_RUNS_ENDPOINT}/{run_id}", headers=auth_headers
    )
    assert read_resp.status_code == 200, read_resp.text
    assert read_resp.json()["id"] == run_id


@pytest.mark.asyncio
async def test_read_missing_id_returns_404(client, auth_headers):
    response = await client.get(
        f"{_RUNS_ENDPOINT}/{uuid.uuid4()}", headers=auth_headers
    )
    assert response.status_code == 404, response.text


@pytest.mark.asyncio
async def test_read_response_has_no_export_handles(client, auth_headers):
    create_resp = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    run_id = create_resp.json()["id"]
    read_resp = await client.get(
        f"{_RUNS_ENDPOINT}/{run_id}", headers=auth_headers
    )
    assert read_resp.status_code == 200, read_resp.text
    assert_no_export_handles(read_resp.json())


# ---------------------------------------------------------------------------
# 8. Notes-only PATCH
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_notes_works(client, auth_headers):
    create_resp = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    run_id = create_resp.json()["id"]

    patch_resp = await client.patch(
        f"{_RUNS_ENDPOINT}/{run_id}",
        json={"notes": "post-eval note"},
        headers=auth_headers,
    )
    assert patch_resp.status_code == 200, patch_resp.text
    assert patch_resp.json()["notes"] == "post-eval note"


@pytest.mark.asyncio
async def test_patch_missing_id_returns_404(client, auth_headers):
    response = await client.patch(
        f"{_RUNS_ENDPOINT}/{uuid.uuid4()}",
        json={"notes": "x"},
        headers=auth_headers,
    )
    assert response.status_code == 404, response.text


@pytest.mark.asyncio
async def test_patch_extra_fields_rejected(client, auth_headers):
    """``ExportRunUpdate`` uses ``extra="forbid"`` so a caller
    trying to PATCH ``status`` / ``phase`` / ``draft_snapshot``
    via this endpoint is rejected at the schema layer (no silent
    no-op)."""
    create_resp = await client.post(
        _DRAFTS_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    run_id = create_resp.json()["id"]
    patch_resp = await client.patch(
        f"{_RUNS_ENDPOINT}/{run_id}",
        json={"status": "draft_clear"},
        headers=auth_headers,
    )
    assert patch_resp.status_code == 422, patch_resp.text


# ---------------------------------------------------------------------------
# 9. Malformed payloads → 422
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_invalid_source_returns_422(client, auth_headers):
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={
            "draft_input": _clear_input(),
            "source": "future_source",
        },
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_create_forbidden_request_snapshot_key_returns_422(
    client, auth_headers
):
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={
            "draft_input": _clear_input(),
            "request_snapshot": {
                "download_url": "https://example.com/x.csv",
            },
        },
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text
    assert "download_url" in response.text


@pytest.mark.asyncio
async def test_create_caller_finalized_true_returns_422(
    client, auth_headers
):
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={
            "draft_input": _clear_input(),
            "draft_result": {"finalized": True},
        },
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_create_invalid_target_system_returns_422(
    client, auth_headers
):
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={
            "draft_input": _clear_input(),
            "target_system": "not_a_real_system",
        },
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


# ---------------------------------------------------------------------------
# 10. Stateless evaluator endpoint STILL returns no record id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_evaluator_endpoint_still_has_no_id_or_export_run_id(
    client, auth_headers
):
    """Phase 3O / 4I freeze: the diagnostic evaluator endpoint
    MUST NOT return a record id. Phase 5A persistence is opt-in
    through the NEW endpoint family above; the evaluator stays
    stateless on the wire."""
    response = await client.post(
        _EVALUATE_ENDPOINT,
        json={"input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # Walker covers the existing forbidden set (export_run_id,
    # export_id, file_id, ...).
    assert_no_export_handles(body)
    # And explicit top-level checks for the two id-flavoured names
    # that Phase 5A uses on the sibling persistence endpoint
    # (``id``) — they MUST NOT appear here.
    assert "id" not in body
    assert "export_run_id" not in body


# ---------------------------------------------------------------------------
# 11. JSONB snapshots survive a write/read round-trip
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_snapshot_round_trips_extension_keys(
    client, auth_headers
):
    response = await client.post(
        _DRAFTS_ENDPOINT,
        json={
            "draft_input": _clear_input(),
            "request_snapshot": {"validation_source": "backend"},
        },
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    # request_snapshot was sanitised + persisted; on read-back the
    # extension key + the draft_input round-trip.
    rs = body["request_snapshot"]
    assert rs["validation_source"] == "backend"
    assert rs["draft_input"]["selected_profile_id"] == "prof-saved-5a-api"
