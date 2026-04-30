"""
Phase 3O — Operational Preview contract freeze regression tests.

These tests pin the diagnostic-only contract that the Operational
Preview surfaces (Phases 3A–3N) collectively guarantee. They are
NOT a re-litigation of the per-phase rule coverage — those live in
``test_operational_resolution.py``,
``test_export_profile_validation_preview.py``, and
``test_export_readiness_boundary.py``.

What this file does:

  * Asserts ``diagnostic_only=true`` flows through every diagnostic
    endpoint.
  * Asserts ``production_export_ready=false`` and
    ``production_export_status != "ready"`` on the boundary
    endpoint, even on the cleanest possible "ready"-looking input.
  * Asserts none of the diagnostic endpoints expose export /
    download / posting handles in their responses (forbidden-key
    audit walks the response body recursively).

What this file deliberately does NOT do:

  * Does NOT re-test per-rule classifier coverage.
  * Does NOT depend on internal payload field ordering.
  * Does NOT add brittle full-shape snapshots.

Future phases that wire a real export engine MUST add new endpoints
(or new optional fields gated behind explicit flags) — the
diagnostic endpoints exercised here must keep returning
``production_export_ready=false`` regardless.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from app.models.invoice_template import InvoiceTemplate


# ---------------------------------------------------------------------------
# Forbidden-key audit
# ---------------------------------------------------------------------------


# Keys that would imply this response triggered, recorded, or refers
# to a real export / file artefact / external posting. Diagnostic
# surfaces must NEVER expose any of these. If a future phase needs
# any of these on a NEW endpoint, it should not be backported into
# the diagnostic ones tested here.
FORBIDDEN_EXPORT_KEYS: frozenset[str] = frozenset(
    {
        "download_url",
        "file_url",
        "file_id",
        "export_id",
        "export_batch_id",
        "export_run_id",
        "posted_at",
        "external_posting_id",
    }
)


def assert_no_export_handles(payload: Any, *, path: str = "$") -> None:
    """Recursively walk a JSON-shaped value and fail loudly if any
    ``FORBIDDEN_EXPORT_KEYS`` appears as a dict key.

    Lists are walked element-wise. Scalars short-circuit. Path is
    threaded so a failure points to the offending location.
    """
    if isinstance(payload, dict):
        for key, value in payload.items():
            assert key not in FORBIDDEN_EXPORT_KEYS, (
                f"Forbidden export handle key found at {path}.{key} — "
                "diagnostic surfaces must not expose this. See "
                "docs/operational-preview-contract.md §8."
            )
            assert_no_export_handles(value, path=f"{path}.{key}")
    elif isinstance(payload, list):
        for idx, item in enumerate(payload):
            assert_no_export_handles(item, path=f"{path}[{idx}]")
    # Scalars (str / int / bool / None) need no walk.


# ---------------------------------------------------------------------------
# Test fixtures (small + local — mirrors the per-phase test files)
# ---------------------------------------------------------------------------


async def _persist_minimal_template(db_session) -> InvoiceTemplate:
    """Minimal saved template — single required text column. Re-uses
    the same shape as the Phase 3A operational-resolution API tests
    so the contract test exercises the same code path the operator
    sees from the panel.
    """
    template = InvoiceTemplate(
        id=uuid.uuid4(),
        name="Phase 3O contract template",
        description=None,
        columns=[
            {
                "id": "invoice_number",
                "name": "Invoice Number",
                "required": True,
                "data_type": "text",
                "source_type": "invoice_field",
                "source_ref": {"field": "invoice_number"},
                "allow_rule_override": True,
                "default_rule_role": None,
            }
        ],
        rules=[],
        source="custom",
    )
    db_session.add(template)
    await db_session.flush()
    return template


def _minimal_profile_payload() -> dict:
    return {
        "id": "phase-3o-profile",
        "name": "Phase 3O contract profile",
        "target_system": "custom_csv",
        "description": "Phase 3O contract test profile",
        "settings": {
            "delimiter": ",",
            "include_header": True,
            "quote_strategy": "minimal",
            "newline": "lf",
            "encoding": "utf-8",
            "date_format": "MM/DD/YYYY",
            "amount_format": "decimal_2",
            "empty_value_policy": "blank",
        },
        "columns": [
            {
                "key": "invoice_number",
                "label": "Invoice Number",
                "output_header": "Invoice Number",
                "order": 0,
                "required": True,
                "data_type": "text",
            },
        ],
    }


def _minimal_preview_payload() -> dict:
    return {
        "columns": [{"key": "invoice_number", "label": "Invoice Number"}],
        "rows": [
            {
                "row_index": 0,
                "status": "clear",
                "cells": [
                    {
                        "column_key": "invoice_number",
                        "value": "INV-3O-1",
                        "display_value": "INV-3O-1",
                        "status": "clear",
                    }
                ],
            }
        ],
    }


# ---------------------------------------------------------------------------
# 1. Operational resolution endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_operational_resolution_returns_diagnostic_only_true(
    client, db_session, auth_headers
):
    template = await _persist_minimal_template(db_session)
    response = await client.post(
        "/api/v1/operational-resolution/run",
        json={
            "template_id": str(template.id),
            "extracted_facts": {"invoice_number": "INV-3O-A"},
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # Hard contract — diagnostic_only is hard-True at construction
    # time on the response model.
    assert body["diagnostic_only"] is True
    # Operational summary mirrors the same flag for downstream
    # consumers that read the summary directly.
    assert body["operational_summary"]["diagnostic_only"] is True


@pytest.mark.asyncio
async def test_operational_resolution_response_has_no_export_handles(
    client, db_session, auth_headers
):
    template = await _persist_minimal_template(db_session)
    response = await client.post(
        "/api/v1/operational-resolution/run",
        json={
            "template_id": str(template.id),
            "extracted_facts": {"invoice_number": "INV-3O-B"},
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert_no_export_handles(response.json())


# ---------------------------------------------------------------------------
# 2. Export profile validate-preview endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_export_profile_validate_preview_returns_diagnostic_only_true(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-profiles/validate-preview",
        json={
            "profile": _minimal_profile_payload(),
            "preview": _minimal_preview_payload(),
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["diagnostic_only"] is True
    # The endpoint never persists a profile — `profile_id` echoes
    # the caller-supplied id verbatim. Confirms there is no DB
    # round-trip / export-record creation hidden behind the call.
    assert body["profile_id"] == "phase-3o-profile"


@pytest.mark.asyncio
async def test_export_profile_validate_preview_has_no_export_handles(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-profiles/validate-preview",
        json={
            "profile": _minimal_profile_payload(),
            "preview": _minimal_preview_payload(),
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert_no_export_handles(response.json())


# ---------------------------------------------------------------------------
# 3. Export readiness boundary endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_export_readiness_boundary_returns_diagnostic_only_true(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-readiness-boundary/evaluate",
        json={"input": {}},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["diagnostic_only"] is True


@pytest.mark.asyncio
async def test_export_readiness_boundary_keeps_production_pin_on_empty_input(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-readiness-boundary/evaluate",
        json={"input": {}},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # Hard contract — these three claims hold in EVERY response.
    assert body["production_export_ready"] is False
    assert body["production_export_status"] == "unavailable"
    # Defence in depth — Pydantic Literal would already block
    # "ready" on the wire, but assert here so a future regression
    # catches a contract breach immediately.
    assert body["production_export_status"] != "ready"


# ---------------------------------------------------------------------------
# 4. Boundary clear path STILL is not production ready
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_boundary_clear_path_still_not_production_ready(
    client, auth_headers
):
    """Cleanest possible ``ready``-looking input: backend-verified
    clear validation against a non-empty preview. Diagnostic status
    becomes ``clear`` BUT production_export_ready stays False and
    production_export_status stays ``unavailable``. This is the
    contract that guards every future production-export work
    against accidental "if clear, allow export" wiring."""
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
    # Diagnostic verdict reaches "clear" on this path — confirms
    # the input was the cleanest case the classifier accepts.
    assert body["diagnostic_status"] == "clear"
    # But production export remains hard-pinned away.
    assert body["production_export_ready"] is False
    assert body["production_export_status"] == "unavailable"
    assert body["production_export_status"] != "ready"
    # Operator title still carries the contract reminder.
    assert "Production export unavailable" in body["operator_title"]


# ---------------------------------------------------------------------------
# 5. Forbidden-key audit on boundary endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_export_readiness_boundary_response_has_no_export_handles(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-readiness-boundary/evaluate",
        json={
            "input": {
                "has_result": True,
                "has_preview_rows": True,
                "profile_validation_status": "clear",
                "validation_source": "backend",
            }
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert_no_export_handles(response.json())


# ---------------------------------------------------------------------------
# Self-test: the audit helper actually fires on a malicious payload
# ---------------------------------------------------------------------------


def test_assert_no_export_handles_self_test():
    """Sanity check — the audit walker actually catches a forbidden
    key. Guards against the audit silently no-oping on every test
    above (which would defeat the entire regression suite)."""
    good = {
        "diagnostic_only": True,
        "rows": [
            {"row_index": 0, "value": "INV-1"},
            {"row_index": 1, "value": "INV-2"},
        ],
        "summary": {"total_issues": 0},
    }
    # Should not raise.
    assert_no_export_handles(good)

    # Forbidden top-level key.
    with pytest.raises(AssertionError, match="Forbidden export handle"):
        assert_no_export_handles({**good, "download_url": "https://x"})

    # Forbidden nested key.
    bad_nested = {
        **good,
        "rows": [
            {"row_index": 0, "value": "INV-1", "export_id": "exp-1"},
        ],
    }
    with pytest.raises(AssertionError, match="Forbidden export handle"):
        assert_no_export_handles(bad_nested)
