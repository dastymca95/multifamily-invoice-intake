"""
Phase 3A — API smoke tests for the operational resolution pipeline.

POST /api/v1/operational-resolution/run

Smoke-only — exhaustive composition coverage lives in the service
suite at ``test_operational_resolution.py``. These tests verify the
API plumbing:

  * 404 for missing template / missing pattern.
  * 200 returns the full envelope (resolver_input + resolver_result
    + operational_summary + review_diagnostics + diagnostic_only).
"""

from __future__ import annotations

import uuid

import pytest

from app.models.invoice_pattern import InvoicePattern
from app.models.invoice_template import InvoiceTemplate


async def _persist_template(db_session) -> InvoiceTemplate:
    template = InvoiceTemplate(
        id=uuid.uuid4(),
        name="API operational template",
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
        name="API operational pattern",
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
async def test_endpoint_404_for_missing_template(
    client, db_session, auth_headers
):
    pattern = await _persist_pattern(db_session)
    response = await client.post(
        "/api/v1/operational-resolution/run",
        json={
            "template_id": str(uuid.uuid4()),
            "pattern_id": str(pattern.id),
        },
        headers=auth_headers,
    )
    assert response.status_code == 404, response.text
    assert "template" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_endpoint_404_for_missing_pattern(
    client, db_session, auth_headers
):
    template = await _persist_template(db_session)
    response = await client.post(
        "/api/v1/operational-resolution/run",
        json={
            "template_id": str(template.id),
            "pattern_id": str(uuid.uuid4()),
        },
        headers=auth_headers,
    )
    assert response.status_code == 404, response.text
    assert "pattern" in response.json()["detail"].lower()


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_endpoint_returns_full_envelope(
    client, db_session, auth_headers
):
    template = await _persist_template(db_session)
    pattern = await _persist_pattern(db_session)
    response = await client.post(
        "/api/v1/operational-resolution/run",
        json={
            "template_id": str(template.id),
            "pattern_id": str(pattern.id),
            "extracted_facts": {"invoice_number": "INV-API-OPS"},
            "catalog_hints": {"vendor": "EPB"},
            "document_metadata": {"test_run_label": "smoke"},
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["diagnostic_only"] is True
    assert body["template_id"] == str(template.id)
    assert body["pattern_id"] == str(pattern.id)
    assert body["template_name"] == "API operational template"
    assert body["pattern_name"] == "API operational pattern"

    resolver_input = body["resolver_input"]
    facts = resolver_input["extracted_facts"]
    assert any(
        f["field_key"] == "invoice_number" and f["value"] == "INV-API-OPS"
        for f in facts
    )
    md = resolver_input["document_metadata"]
    assert md["operational_source"] == "operational_resolution_pipeline"
    assert md["operational_version"] == "phase_3a"
    assert md["bridge_source"] == "invoice_pattern_resolver_bridge"
    assert md["test_run_label"] == "smoke"

    resolver = body["resolver_result"]
    cell = next(
        c for c in resolver["rows"][0]["cells"] if c["column_id"] == "invoice_number"
    )
    assert cell["value"] == "INV-API-OPS"
    assert cell["status"] == "resolved"

    summary = body["operational_summary"]
    assert summary["extracted_fact_count"] == 1
    assert summary["catalog_hint_count"] == 1
    assert summary["diagnostic_only"] is True

    # Review diagnostics: empty when everything resolved.
    diagnostics = body["review_diagnostics"]
    blocked_codes = [
        d["code"] for d in diagnostics if d.get("severity") == "blocked"
    ]
    assert "REQUIRED_RUNTIME_VALUE_MISSING" not in blocked_codes


@pytest.mark.asyncio
async def test_endpoint_accepts_template_only_body(
    client, db_session, auth_headers
):
    """Pattern-less request — template id only is a valid body."""
    template = await _persist_template(db_session)
    response = await client.post(
        "/api/v1/operational-resolution/run",
        json={
            "template_id": str(template.id),
            "extracted_facts": {"invoice_number": "INV-NOPAT"},
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["pattern_id"] is None
    assert body["resolver_result"]["rows"][0]["status"] == "ready"
