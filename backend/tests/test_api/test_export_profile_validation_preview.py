"""
Phase 3I — API smoke tests for the diagnostic export profile validator.

POST /api/v1/export-profiles/validate-preview

Smoke-only — exhaustive validation rules live in
``test_export_profile_validation.py``. These tests verify the API plumbing:

  * ``diagnostic_only=True`` is hard-coded in the response.
  * The endpoint requires NO persisted profile — caller supplies it.
  * 422 is returned for malformed payloads (missing required fields).
  * Required column missing flips overall status to ``blocked``.
  * Echoes optional ``context`` block back so the report stays
    paste-friendly without re-querying.
"""

from __future__ import annotations

import pytest


def _minimal_profile_payload(*, required_amount: bool = False) -> dict:
    return {
        "id": "prof-api-test",
        "name": "API Test Profile",
        "target_system": "custom_csv",
        "description": "API smoke profile",
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
            {
                "key": "amount",
                "label": "Amount",
                "output_header": "Amount",
                "order": 1,
                "required": required_amount,
                "data_type": "amount",
            },
        ],
    }


def _minimal_preview_payload() -> dict:
    return {
        "columns": [
            {"key": "invoice_number", "label": "Invoice Number"},
            {"key": "amount", "label": "Amount"},
        ],
        "rows": [
            {
                "row_index": 0,
                "status": "clear",
                "cells": [
                    {
                        "column_key": "invoice_number",
                        "value": "INV-API-1",
                        "display_value": "INV-API-1",
                        "status": "clear",
                    },
                    {
                        "column_key": "amount",
                        "value": "100.00",
                        "display_value": "100.00",
                        "status": "clear",
                    },
                ],
            }
        ],
    }


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_validate_preview_happy_path_returns_diagnostic_only_true(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-profiles/validate-preview",
        json={
            "profile": _minimal_profile_payload(),
            "preview": _minimal_preview_payload(),
            "diagnostic_only": True,
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["diagnostic_only"] is True
    assert body["profile_id"] == "prof-api-test"
    assert body["profile_name"] == "API Test Profile"
    assert body["target_system"] == "custom_csv"
    # Both profile columns matched → no blocking issues.
    assert body["status"] == "clear"
    assert body["summary"]["matched_column_count"] == 2
    assert body["summary"]["row_count"] == 1
    assert body["summary"]["column_count"] == 2
    assert body["summary"]["blocked_count"] == 0


@pytest.mark.asyncio
async def test_validate_preview_response_is_diagnostic_even_if_request_says_false(
    client, auth_headers
):
    """Defence-in-depth: response is hard-True regardless of caller."""
    response = await client.post(
        "/api/v1/export-profiles/validate-preview",
        json={
            "profile": _minimal_profile_payload(),
            "preview": _minimal_preview_payload(),
            "diagnostic_only": False,
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["diagnostic_only"] is True


# ---------------------------------------------------------------------------
# Required column missing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_validate_preview_missing_required_column_is_blocked(
    client, auth_headers
):
    profile = _minimal_profile_payload(required_amount=True)
    preview = {
        "columns": [{"key": "invoice_number", "label": "Invoice Number"}],
        "rows": [
            {
                "row_index": 0,
                "status": "clear",
                "cells": [
                    {
                        "column_key": "invoice_number",
                        "value": "INV-API-1",
                        "status": "clear",
                    }
                ],
            }
        ],
    }
    response = await client.post(
        "/api/v1/export-profiles/validate-preview",
        json={"profile": profile, "preview": preview},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "blocked"
    codes = [i["code"] for i in body["issues"]]
    assert "PROFILE_REQUIRED_COLUMN_MISSING" in codes
    assert body["summary"]["blocked_count"] >= 1


# ---------------------------------------------------------------------------
# Caller-supplied profile, no DB dependency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_validate_preview_does_not_require_persisted_profile(
    client, auth_headers
):
    """Endpoint must accept the profile in-line; never hit a DB row."""
    body_in = {
        "profile": _minimal_profile_payload(),
        "preview": _minimal_preview_payload(),
    }
    response = await client.post(
        "/api/v1/export-profiles/validate-preview",
        json=body_in,
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # Profile id echoes the caller-supplied value verbatim — proof
    # there's no DB resolve / id remap happening server-side.
    assert body["profile_id"] == "prof-api-test"


# ---------------------------------------------------------------------------
# Context echo
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_validate_preview_echoes_context(client, auth_headers):
    response = await client.post(
        "/api/v1/export-profiles/validate-preview",
        json={
            "profile": _minimal_profile_payload(),
            "preview": _minimal_preview_payload(),
            "context": {
                "template_id": "tmpl-123",
                "template_name": "API Template",
                "document_id": "doc-abc",
            },
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["context"] == {
        "template_id": "tmpl-123",
        "template_name": "API Template",
        "pattern_id": None,
        "pattern_name": None,
        "document_id": "doc-abc",
        "batch_id": None,
    }


# ---------------------------------------------------------------------------
# 422 — malformed payload
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_validate_preview_422_when_profile_missing(client, auth_headers):
    response = await client.post(
        "/api/v1/export-profiles/validate-preview",
        json={"preview": _minimal_preview_payload()},
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_validate_preview_422_when_profile_id_missing(client, auth_headers):
    bad_profile = _minimal_profile_payload()
    del bad_profile["id"]
    response = await client.post(
        "/api/v1/export-profiles/validate-preview",
        json={"profile": bad_profile, "preview": _minimal_preview_payload()},
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text
