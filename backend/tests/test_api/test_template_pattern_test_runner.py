"""
Phase 2B — API smoke tests for the template + pattern test runner.

POST /api/v1/invoice-templates/{template_id}/test-with-pattern/{pattern_id}

Smoke-only — exhaustive composition coverage lives in the service
suite at ``test_template_pattern_test_runner.py``. These tests
verify the API plumbing:

  * 404 for missing template / missing pattern.
  * 200 returns the full envelope (bridge_input + resolver_result +
    summary + diagnostic_only=True).
  * The endpoint requires auth (driven by the project conftest
    setup — same as the readiness-preview smoke tests).

Uses the project's ``client`` + ``db_session`` + ``auth_headers``
fixtures from ``backend/tests/conftest.py``. The client and the
db_session share the same AsyncSession, so rows persisted via the
fixture are visible to the route.
"""

from __future__ import annotations

import uuid

import pytest

from app.models.invoice_pattern import InvoicePattern
from app.models.invoice_template import InvoiceTemplate


async def _persist_template(db_session) -> InvoiceTemplate:
    template = InvoiceTemplate(
        id=uuid.uuid4(),
        name="API smoke template",
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


async def _persist_pattern(db_session) -> InvoicePattern:
    pattern = InvoicePattern(
        id=uuid.uuid4(),
        name="API smoke pattern",
        description=None,
        vendor_hint="EPB",
        source_files=[
            {
                "id": "f-1",
                "file_name": "epb-sample.pdf",
                "mime_type": "application/pdf",
                "size_bytes": 1024,
                "page_count": 1,
                "data_url": "",
            }
        ],
        regions=[
            {
                "id": "r-1",
                "source_file_id": "f-1",
                "page": 1,
                "bbox": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05},
                "field_key": "invoice_number",
                "shape": "rect",
            }
        ],
        field_definitions=[],
        created_by=None,
    )
    db_session.add(pattern)
    await db_session.flush()
    return pattern


# ---------------------------------------------------------------------------
# 404 cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_endpoint_returns_404_for_missing_template(
    client, db_session, auth_headers
):
    pattern = await _persist_pattern(db_session)
    response = await client.post(
        f"/api/v1/invoice-templates/{uuid.uuid4()}"
        f"/test-with-pattern/{pattern.id}",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 404, response.text
    assert "template" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_endpoint_returns_404_for_missing_pattern(
    client, db_session, auth_headers
):
    template = await _persist_template(db_session)
    response = await client.post(
        f"/api/v1/invoice-templates/{template.id}"
        f"/test-with-pattern/{uuid.uuid4()}",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 404, response.text
    assert "pattern" in response.json()["detail"].lower()


# ---------------------------------------------------------------------------
# Happy path — bridge_input + resolver_result + summary in response
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_endpoint_returns_full_envelope(
    client, db_session, auth_headers
):
    template = await _persist_template(db_session)
    pattern = await _persist_pattern(db_session)

    response = await client.post(
        f"/api/v1/invoice-templates/{template.id}"
        f"/test-with-pattern/{pattern.id}",
        json={
            "manual_fact_values": {"invoice_number": "INV-API-1"},
            "manual_catalog_hints": {"vendor": "EPB"},
            "include_empty_fields": False,
            "document_metadata": {"test_run_label": "smoke"},
        },
        headers=auth_headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()

    # Top-level envelope.
    assert body["template_id"] == str(template.id)
    assert body["pattern_id"] == str(pattern.id)
    assert body["template_name"] == "API smoke template"
    assert body["pattern_name"] == "API smoke pattern"
    assert body["diagnostic_only"] is True

    # Bridge input — manual fact reached the resolver input.
    bridge_input = body["bridge_input"]
    assert bridge_input["template_id"] == str(template.id)
    facts = bridge_input["extracted_facts"]
    assert len(facts) == 1
    assert facts[0]["field_key"] == "invoice_number"
    assert facts[0]["value"] == "INV-API-1"
    assert facts[0]["source_type"] == "manual"
    # Vendor hint plumbed through.
    assert "vendor" in bridge_input["catalog_hints"]
    assert bridge_input["catalog_hints"]["vendor"]["text"] == "EPB"
    # Caller's free-form metadata survived; runner / bridge keys win.
    metadata = bridge_input["document_metadata"]
    assert metadata["test_run_label"] == "smoke"
    assert metadata["test_runner_source"] == "template_pattern_test_runner"
    assert metadata["test_runner_version"] == "phase_2b"
    assert metadata["bridge_source"] == "invoice_pattern_resolver_bridge"
    assert metadata["template_id"] == str(template.id)
    assert metadata["diagnostic_only"] is True

    # Resolver result — required column resolves with the manual value.
    resolver = body["resolver_result"]
    assert resolver["template_id"] == str(template.id)
    rows = resolver["rows"]
    assert rows[0]["status"] == "ready"
    cell = next(c for c in rows[0]["cells"] if c["column_id"] == "invoice_number")
    assert cell["value"] == "INV-API-1"
    assert cell["status"] == "resolved"

    # Summary mirrors resolver counts. Overall status may be
    # ``needs_review`` if the resolver's validation pass emits
    # advisories — the row + cell checks above are the contract that
    # matters for "did the manual fact resolve?".
    summary = body["summary"]
    assert summary["status"] in ("ready", "needs_review")
    assert summary["extracted_fact_count"] == 1
    assert summary["catalog_hint_count"] == 1


@pytest.mark.asyncio
async def test_endpoint_accepts_empty_body(client, db_session, auth_headers):
    """``{}`` is a valid request — runs with zero manual inputs."""
    template = await _persist_template(db_session)
    pattern = await _persist_pattern(db_session)

    response = await client.post(
        f"/api/v1/invoice-templates/{template.id}"
        f"/test-with-pattern/{pattern.id}",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # Required column has no manual value → resolver blocks.
    assert body["resolver_result"]["rows"][0]["status"] == "blocked"
    assert body["summary"]["extracted_fact_count"] == 0
    assert body["summary"]["catalog_hint_count"] == 1  # vendor hint flowed
