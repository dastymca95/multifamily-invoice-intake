"""
Phase 4A — API smoke tests for the persisted Export Profile CRUD.

Smoke-only — exhaustive validation rules live in the service tests
(``test_export_profile_management.py``). These tests verify the API
plumbing:

  * ``POST /export-profiles`` creates and returns a 201 + read shape.
  * ``GET  /export-profiles`` lists profile summaries.
  * ``GET  /export-profiles/{id}`` returns the full read shape.
  * ``PATCH /export-profiles/{id}`` applies partial updates.
  * ``DELETE /export-profiles/{id}`` soft-deletes (204) and the row
    no longer appears in the default list.
  * ``GET /export-profiles/{id}/contract`` returns the persisted
    profile projected into the existing Phase 3I ``ExportProfile``
    validation contract.
  * ``POST /export-profiles/validate-preview`` (Phase 3I) still
    works end-to-end after the CRUD additions.
  * Malformed create returns 422; missing id returns 404.
  * Forbidden export / file / posting handles do NOT appear in any
    response (re-uses the Phase 3O audit helper).
"""

from __future__ import annotations

import pytest

from tests.test_api.test_operational_preview_contract import (
    assert_no_export_handles,
)


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def _settings(**overrides) -> dict:
    base = {
        "delimiter": ",",
        "include_header": True,
        "quote_strategy": "minimal",
        "newline": "lf",
        "encoding": "utf-8",
        "date_format": "MM/DD/YYYY",
        "amount_format": "decimal_2",
        "empty_value_policy": "blank",
    }
    base.update(overrides)
    return base


def _column(
    key: str,
    label: str | None = None,
    *,
    required: bool = False,
    data_type: str = "text",
) -> dict:
    return {
        "key": key,
        "label": label or key.title(),
        "output_header": label or key.title(),
        "order": 0,
        "required": required,
        "data_type": data_type,
    }


def _create_payload(
    *,
    name: str = "Phase 4A API profile",
    target_system: str = "custom_csv",
    columns: list[dict] | None = None,
    settings: dict | None = None,
    is_active: bool = True,
    is_default: bool = False,
) -> dict:
    return {
        "name": name,
        "target_system": target_system,
        "description": "Phase 4A API smoke profile",
        "settings": settings or _settings(),
        "columns": columns
        or [
            _column("invoice_number", required=True),
            _column("amount", data_type="amount"),
        ],
        "is_active": is_active,
        "is_default": is_default,
        "source": "manual",
    }


# ---------------------------------------------------------------------------
# Create + read + list
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_returns_201_and_read_shape(client, auth_headers):
    response = await client.post(
        "/api/v1/export-profiles",
        json=_create_payload(),
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["name"] == "Phase 4A API profile"
    assert body["target_system"] == "custom_csv"
    assert body["version"] == 1
    assert body["is_active"] is True
    assert body["source"] == "manual"
    # No forbidden export handles surfaced.
    assert_no_export_handles(body)


@pytest.mark.asyncio
async def test_get_returns_persisted_profile(client, auth_headers):
    create_resp = await client.post(
        "/api/v1/export-profiles",
        json=_create_payload(),
        headers=auth_headers,
    )
    profile_id = create_resp.json()["id"]
    response = await client.get(
        f"/api/v1/export-profiles/{profile_id}",
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["id"] == profile_id
    assert_no_export_handles(response.json())


@pytest.mark.asyncio
async def test_list_returns_active_profiles(client, auth_headers):
    a_id = (
        await client.post(
            "/api/v1/export-profiles",
            json=_create_payload(name="Active A"),
            headers=auth_headers,
        )
    ).json()["id"]
    b_id = (
        await client.post(
            "/api/v1/export-profiles",
            json=_create_payload(name="Active B"),
            headers=auth_headers,
        )
    ).json()["id"]

    response = await client.get(
        "/api/v1/export-profiles", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    ids = {item["id"] for item in body["items"]}
    assert a_id in ids
    assert b_id in ids
    assert_no_export_handles(body)


@pytest.mark.asyncio
async def test_list_filters_by_target_system(client, auth_headers):
    custom_id = (
        await client.post(
            "/api/v1/export-profiles",
            json=_create_payload(name="Custom"),
            headers=auth_headers,
        )
    ).json()["id"]
    resman_id = (
        await client.post(
            "/api/v1/export-profiles",
            json=_create_payload(
                name="ResMan",
                target_system="resman",
            ),
            headers=auth_headers,
        )
    ).json()["id"]

    response = await client.get(
        "/api/v1/export-profiles?target_system=resman",
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    ids = {item["id"] for item in response.json()["items"]}
    assert resman_id in ids
    assert custom_id not in ids


# ---------------------------------------------------------------------------
# Update + delete
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_updates_metadata_and_keeps_version(client, auth_headers):
    create_resp = await client.post(
        "/api/v1/export-profiles",
        json=_create_payload(),
        headers=auth_headers,
    )
    profile_id = create_resp.json()["id"]
    initial_version = create_resp.json()["version"]
    response = await client.patch(
        f"/api/v1/export-profiles/{profile_id}",
        json={"description": "patched", "notes": "ops"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["description"] == "patched"
    assert body["notes"] == "ops"
    assert body["version"] == initial_version


@pytest.mark.asyncio
async def test_patch_columns_bumps_version(client, auth_headers):
    create_resp = await client.post(
        "/api/v1/export-profiles",
        json=_create_payload(),
        headers=auth_headers,
    )
    profile_id = create_resp.json()["id"]
    response = await client.patch(
        f"/api/v1/export-profiles/{profile_id}",
        json={
            "columns": [
                _column("invoice_number", required=True),
                _column("memo"),
            ]
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["version"] == 2
    assert any(c["key"] == "memo" for c in body["columns"])


@pytest.mark.asyncio
async def test_delete_soft_deletes(client, auth_headers):
    create_resp = await client.post(
        "/api/v1/export-profiles",
        json=_create_payload(),
        headers=auth_headers,
    )
    profile_id = create_resp.json()["id"]

    delete_resp = await client.delete(
        f"/api/v1/export-profiles/{profile_id}",
        headers=auth_headers,
    )
    assert delete_resp.status_code == 204, delete_resp.text

    # Default list excludes inactive.
    list_resp = await client.get(
        "/api/v1/export-profiles", headers=auth_headers
    )
    ids = {item["id"] for item in list_resp.json()["items"]}
    assert profile_id not in ids

    # Direct GET still surfaces the row (admin can re-activate).
    get_resp = await client.get(
        f"/api/v1/export-profiles/{profile_id}", headers=auth_headers
    )
    assert get_resp.status_code == 200
    assert get_resp.json()["is_active"] is False


# ---------------------------------------------------------------------------
# Contract endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_contract_endpoint_returns_phase_3i_shape(client, auth_headers):
    create_resp = await client.post(
        "/api/v1/export-profiles",
        json=_create_payload(),
        headers=auth_headers,
    )
    profile_id = create_resp.json()["id"]
    response = await client.get(
        f"/api/v1/export-profiles/{profile_id}/contract",
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # Phase 3I ExportProfile shape echoes the persisted profile id
    # AS A STRING (the contract uses ``str``, not UUID).
    assert body["id"] == profile_id
    assert body["target_system"] == "custom_csv"
    assert body["diagnostic_only"] is True
    # Columns survived the conversion.
    assert any(c["key"] == "invoice_number" for c in body["columns"])
    assert_no_export_handles(body)


# ---------------------------------------------------------------------------
# Phase 3I validate-preview still works after CRUD additions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_validate_preview_endpoint_still_works(client, auth_headers):
    response = await client.post(
        "/api/v1/export-profiles/validate-preview",
        json={
            "profile": {
                "id": "inline-profile",
                "name": "Inline",
                "target_system": "custom_csv",
                "settings": _settings(),
                "columns": [_column("invoice_number", required=True)],
            },
            "preview": {
                "columns": [
                    {"key": "invoice_number", "label": "Invoice Number"}
                ],
                "rows": [
                    {
                        "row_index": 0,
                        "status": "clear",
                        "cells": [
                            {
                                "column_key": "invoice_number",
                                "value": "INV-1",
                                "display_value": "INV-1",
                                "status": "clear",
                            }
                        ],
                    }
                ],
            },
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["diagnostic_only"] is True
    # Inline profile id echoes verbatim — confirms no DB lookup
    # was inserted between Phase 3I and Phase 4A.
    assert body["profile_id"] == "inline-profile"


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_returns_422_on_invalid_target_system(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-profiles",
        json=_create_payload(target_system="quickbooks"),
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_create_returns_422_on_duplicate_column_keys(
    client, auth_headers
):
    response = await client.post(
        "/api/v1/export-profiles",
        json=_create_payload(
            columns=[
                _column("invoice_number"),
                _column("invoice_number"),
            ],
        ),
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_create_returns_422_on_empty_name(client, auth_headers):
    response = await client.post(
        "/api/v1/export-profiles",
        json={**_create_payload(), "name": "   "},
        headers=auth_headers,
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_get_returns_404_for_missing_id(client, auth_headers):
    response = await client.get(
        "/api/v1/export-profiles/00000000-0000-0000-0000-000000000000",
        headers=auth_headers,
    )
    assert response.status_code == 404, response.text


@pytest.mark.asyncio
async def test_patch_returns_404_for_missing_id(client, auth_headers):
    response = await client.patch(
        "/api/v1/export-profiles/00000000-0000-0000-0000-000000000000",
        json={"description": "x"},
        headers=auth_headers,
    )
    assert response.status_code == 404, response.text


@pytest.mark.asyncio
async def test_delete_returns_404_for_missing_id(client, auth_headers):
    response = await client.delete(
        "/api/v1/export-profiles/00000000-0000-0000-0000-000000000000",
        headers=auth_headers,
    )
    assert response.status_code == 404, response.text
