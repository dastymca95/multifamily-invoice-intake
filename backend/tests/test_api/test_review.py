"""Review save flow: bulk-save canonical payload + immutable ReviewEvent."""

from decimal import Decimal

import pytest


async def _setup_extracted_document(client, auth_headers, image_bytes) -> str:
    res = await client.post(
        "/api/v1/batches", json={"name": "Review test"}, headers=auth_headers
    )
    batch_id = res.json()["id"]

    res = await client.post(
        "/api/v1/documents/upload",
        data={"batch_id": batch_id},
        files={"file": ("inv.png", image_bytes, "image/png")},
        headers=auth_headers,
    )
    return res.json()["document_id"]


@pytest.mark.asyncio
async def test_review_save_persists_corrections_and_records_event(
    client, auth_headers, image_bytes
):
    document_id = await _setup_extracted_document(client, auth_headers, image_bytes)

    payload = {
        "vendor_name": "Pacific Power & Light",
        "invoice_number": "PPL-2026-04-9981",
        "invoice_date": "2026-04-15",
        "due_date": "2026-05-15",
        "property_name": "Oakwood Apartments",
        "property_code": "OAK-01",
        "subtotal": "1200.00",
        "tax_amount": "84.00",
        "total_amount": "1284.00",
        "currency": "USD",
        "invoice_type": "utility",
        "utility_type": "electric",
        "account_number": "AC-99887766",
        "line_items": [
            {
                "line_number": 1,
                "description": "Electricity usage — April",
                "quantity": "850.5",
                "unit": "kWh",
                "unit_price": "0.14",
                "amount": "1200.00",
                "gl_code": "5410",
            }
        ],
    }

    res = await client.post(
        f"/api/v1/review/{document_id}/save", json=payload, headers=auth_headers
    )
    assert res.status_code == 200, res.text
    event = res.json()
    assert event["event_type"] == "save"
    assert event["value_before"] is not None
    assert event["value_after"]["vendor_name"] == "Pacific Power & Light"
    assert len(event["value_after"]["line_items"]) == 1

    # Detail should now reflect the saved values, no missing-field warnings.
    res = await client.get(f"/api/v1/documents/{document_id}", headers=auth_headers)
    detail = res.json()
    assert detail["document"]["review_status"] == "in_review"
    assert detail["invoice"]["vendor_name"] == "Pacific Power & Light"
    # Postgres NUMERIC(14,4) round-trips with the column's scale (e.g. "1284.0000"),
    # so compare decimal-equivalent rather than string-exact.
    assert Decimal(detail["invoice"]["total_amount"]) == Decimal("1284.00")
    codes = {w["code"] for w in detail["warnings"]}
    assert "missing_vendor_name" not in codes
    assert "missing_invoice_number" not in codes
    assert "missing_total_amount" not in codes
