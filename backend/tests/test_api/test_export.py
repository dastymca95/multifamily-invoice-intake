"""Per-batch CSV export: invoices in the batch are rendered to CSV via the adapter."""

import csv
import io

import pytest


async def _setup_batch_with_saved_invoice(client, auth_headers, image_bytes) -> str:
    res = await client.post(
        "/api/v1/batches", json={"name": "Export test"}, headers=auth_headers
    )
    batch_id = res.json()["id"]

    res = await client.post(
        "/api/v1/documents/upload",
        data={"batch_id": batch_id},
        files={"file": ("inv.png", image_bytes, "image/png")},
        headers=auth_headers,
    )
    document_id = res.json()["document_id"]

    await client.post(
        f"/api/v1/review/{document_id}/save",
        json={
            "vendor_name": "Acme Water Utility",
            "invoice_number": "AWU-554",
            "invoice_date": "2026-03-31",
            "total_amount": "412.50",
            "currency": "USD",
            "invoice_type": "utility",
            "utility_type": "water",
            "line_items": [
                {
                    "line_number": 1,
                    "description": "Water — March",
                    "amount": "412.50",
                }
            ],
        },
        headers=auth_headers,
    )
    return batch_id


@pytest.mark.asyncio
async def test_batch_export_generates_completed_csv_job(
    client, auth_headers, image_bytes
):
    batch_id = await _setup_batch_with_saved_invoice(client, auth_headers, image_bytes)

    res = await client.post(
        f"/api/v1/exports/batch/{batch_id}",
        params={"format": "csv"},
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    job = res.json()
    assert job["status"] == "completed"
    assert job["row_count"] == 1
    assert job["storage_key"] is not None

    # Stream the file back and verify it parses as CSV with the expected row.
    res = await client.get(f"/api/v1/exports/{job['id']}/download", headers=auth_headers)
    assert res.status_code == 200
    text = res.content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    assert len(rows) >= 2  # header + at least one data row
    header = rows[0]
    data = rows[1]
    assert "vendor_name" in header
    assert data[header.index("vendor_name")] == "Acme Water Utility"
    assert data[header.index("invoice_number")] == "AWU-554"
