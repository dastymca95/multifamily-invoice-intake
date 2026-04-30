"""
Phase 3M — API smoke tests for the export readiness boundary endpoint.

POST /api/v1/export-readiness-boundary/evaluate

Smoke-only — exhaustive rule coverage lives in
``test_export_readiness_boundary.py`` (service tests). These tests
verify the API plumbing:

  * ``diagnostic_only=True`` is hard-coded in the response.
  * ``production_export_ready=False`` is hard-coded in the response.
  * Empty input returns ``not_available`` without requiring any
    persisted record.
  * Backend-verified clear input returns ``clear`` AND keeps the
    hard-pinned production flags.
  * Malformed payload returns 422 (Pydantic literal enforcement).
"""

from __future__ import annotations

import pytest


# ---------------------------------------------------------------------------
# Empty / minimal input
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_endpoint_returns_diagnostic_only_true(client, auth_headers):
    response = await client.post(
        "/api/v1/export-readiness-boundary/evaluate",
        json={"input": {}},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["diagnostic_only"] is True
    assert body["production_export_ready"] is False
    assert body["production_export_status"] == "unavailable"


@pytest.mark.asyncio
async def test_endpoint_returns_not_available_for_empty_input(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-readiness-boundary/evaluate",
        json={"input": {}},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["diagnostic_status"] == "not_available"
    # Default reasons include all "no production component" entries.
    assert "diagnostic_only_pipeline" in body["reasons"]
    assert "no_export_engine" in body["reasons"]
    assert "no_export_profile_persistence" in body["reasons"]


@pytest.mark.asyncio
async def test_endpoint_accepts_omitted_input_field(client, auth_headers):
    """``input`` defaults to an empty model — body can be ``{}``."""
    response = await client.post(
        "/api/v1/export-readiness-boundary/evaluate",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["diagnostic_only"] is True
    assert body["production_export_ready"] is False


# ---------------------------------------------------------------------------
# Boundary stays hard-pinned even on the most "ready"-looking case
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_clear_path_keeps_production_export_ready_false(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-readiness-boundary/evaluate",
        json={
            "input": {
                "operational_status": "ready",
                "profile_validation_status": "clear",
                "parity_status": "aligned",
                "validation_source": "backend",
                "has_result": True,
                "has_preview_rows": True,
                "has_persisted_profile": False,
            }
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["diagnostic_status"] == "clear"
    # Hard pins remain even on the cleanest path.
    assert body["production_export_ready"] is False
    assert body["production_export_status"] == "unavailable"
    assert body["diagnostic_only"] is True
    # Operator messaging carries the boundary language.
    assert "Production export unavailable" in body["operator_title"]


@pytest.mark.asyncio
async def test_endpoint_does_not_require_persisted_objects(
    client, auth_headers
):
    """No DB lookup, no persisted profile / template / batch."""
    response = await client.post(
        "/api/v1/export-readiness-boundary/evaluate",
        json={
            "input": {
                "operational_status": "ready",
                "profile_validation_status": "clear",
                "validation_source": "backend",
                "has_result": True,
                "has_preview_rows": True,
            }
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    # Reasons confirm the response was computed from input alone.
    assert "no_export_engine" in response.json()["reasons"]


# ---------------------------------------------------------------------------
# Pydantic literal enforcement → 422 on malformed payload
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_endpoint_422_on_non_object_input(client, auth_headers):
    response = await client.post(
        "/api/v1/export-readiness-boundary/evaluate",
        json={"input": "not-an-object"},
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_endpoint_422_on_wrong_field_type(client, auth_headers):
    response = await client.post(
        "/api/v1/export-readiness-boundary/evaluate",
        json={"input": {"has_result": "yes-please"}},
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
        "/api/v1/export-readiness-boundary/evaluate",
        json={"input": {}},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    disclaimers = response.json()["disclaimers"]
    assert "Diagnostic clear does not mean production export ready." in disclaimers
    assert "No export file was generated." in disclaimers
    assert "No external accounting system was updated." in disclaimers


@pytest.mark.asyncio
async def test_endpoint_response_next_steps_include_persistence_and_audit(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-readiness-boundary/evaluate",
        json={"input": {}},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    next_steps = response.json()["next_steps"]
    assert "Add persisted export profiles." in next_steps
    assert "Add export run and audit models." in next_steps
    assert "Add final approval workflow." in next_steps
    assert "Add controlled file generation." in next_steps
