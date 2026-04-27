"""API smoke tests for the readiness preview endpoint.

POST /api/v1/invoice-templates/readiness-preview is a stateless
diagnostic — no DB writes, no document state, no extraction. The
fixture stack from conftest.py (``client`` + ``auth_headers``)
gives us a TestClient with the auth dependency overridden but the
endpoint itself doesn't touch the DB at this phase.

Smoke coverage only — exhaustive scenario coverage lives in the
service-level suite at ``test_import_template_readiness.py``.
"""

from __future__ import annotations

import pytest


def _bill_or_credit_ready_payload() -> dict:
    """Phase-1C canonical happy-path payload — Bill or Credit
    configured per the Phase A acceptance criteria."""
    return {
        "template_id": None,
        "template_name": "Smoke template",
        "columns": [
            {
                "id": "boc",
                "name": "Bill or Credit",
                "required": True,
                "data_type": "dropdown",
                "source_type": "manual_list",
                "manual_values": ["Bill", "Credit"],
                "default_value": "Bill",
                "format": {"list_options": ["Bill", "Credit"]},
                "default_rule_role": None,
                "allow_rule_override": True,
            }
        ],
        "rules": [],
    }


@pytest.mark.asyncio
async def test_readiness_preview_returns_ready_for_bill_or_credit(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/invoice-templates/readiness-preview",
        json=_bill_or_credit_ready_payload(),
        headers=auth_headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ready"
    assert body["template_name"] == "Smoke template"
    assert len(body["columns"]) == 1

    column = body["columns"][0]
    assert column["column_id"] == "boc"
    assert column["status"] == "ready"
    assert column["expectation"] == "should_resolve"
    assert column["value_source"]["status"] == "ready"
    assert column["value_source"]["conditional"] is False

    summary = body["summary"]
    assert summary["column_count"] == 1
    assert summary["ready_columns"] == 1
    assert summary["blocked_columns"] == 0


@pytest.mark.asyncio
async def test_readiness_preview_required_invoice_field_warns(
    client, auth_headers
):
    """Required invoice_field with field bound but no runtime input
    should land as warning + may_be_missing — the canonical drift
    case that motivated Phase 1C."""
    payload = {
        "template_id": None,
        "template_name": "Invoice Number smoke",
        "columns": [
            {
                "id": "inv",
                "name": "Invoice Number",
                "required": True,
                "data_type": "text",
                "source_type": "invoice_field",
                "source_ref": {"field": "invoice_number"},
                "default_rule_role": None,
                "allow_rule_override": True,
            }
        ],
        "rules": [],
    }

    response = await client.post(
        "/api/v1/invoice-templates/readiness-preview",
        json=payload,
        headers=auth_headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    column = body["columns"][0]
    assert column["expectation"] == "may_be_missing"
    assert column["status"] == "warning"
    assert column["value_source"]["conditional"] is True
    codes = [item["code"] for item in column["items"]]
    assert "READINESS_REQUIRED_RUNTIME_DEPENDENT" in codes


@pytest.mark.asyncio
async def test_readiness_preview_invalid_payload_returns_422(
    client, auth_headers
):
    """Garbage payload should be rejected at validation time."""
    response = await client.post(
        "/api/v1/invoice-templates/readiness-preview",
        json={"columns": "not-a-list"},
        headers=auth_headers,
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_readiness_preview_empty_columns_returns_ready(
    client, auth_headers
):
    """Empty payload (no columns) is valid — returns a ready
    template with zero columns."""
    response = await client.post(
        "/api/v1/invoice-templates/readiness-preview",
        json={"columns": [], "rules": []},
        headers=auth_headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ready"
    assert body["columns"] == []
    assert body["summary"]["column_count"] == 0


@pytest.mark.asyncio
async def test_readiness_preview_requires_auth(client):
    """No auth header → 401 (or whatever the auth dependency
    returns; smoke-check the endpoint isn't accidentally public)."""
    response = await client.post(
        "/api/v1/invoice-templates/readiness-preview",
        json={"columns": [], "rules": []},
    )

    assert response.status_code in (401, 403)
