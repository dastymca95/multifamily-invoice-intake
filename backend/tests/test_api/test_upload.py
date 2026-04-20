"""End-to-end upload + sync extraction test."""

import pytest


@pytest.mark.asyncio
async def test_upload_creates_document_and_runs_extraction(
    client, auth_headers, image_bytes
):
    # 1. Create a batch.
    res = await client.post(
        "/api/v1/batches",
        json={"name": "Test batch — April 2026"},
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    batch_id = res.json()["id"]

    # 2. Upload a single document. The image MIME routes to scanned_or_image
    #    and the OCR stub returns deterministic empty data so extraction
    #    completes without depending on a real PDF parser.
    res = await client.post(
        "/api/v1/documents/upload",
        data={"batch_id": batch_id},
        files={"file": ("invoice.png", image_bytes, "image/png")},
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["duplicate"] is False
    assert body["route_used"] == "scanned_or_image"
    assert body["extraction_status"] == "extracted"
    document_id = body["document_id"]

    # 3. The document detail endpoint returns the run, the canonical invoice,
    #    and validation warnings (we expect warnings since OCR stub leaves
    #    everything blank).
    res = await client.get(f"/api/v1/documents/{document_id}", headers=auth_headers)
    assert res.status_code == 200, res.text
    detail = res.json()

    assert detail["document"]["route_used"] == "scanned_or_image"
    assert detail["extraction_run"]["adapter_name"] == "ocr_stub"
    assert detail["extraction_run"]["status"] == "completed"
    assert detail["invoice"] is not None
    # Stub leaves vendor/invoice number blank → warnings should fire.
    codes = {w["code"] for w in detail["warnings"]}
    assert "missing_vendor_name" in codes
    assert "missing_invoice_number" in codes


@pytest.mark.asyncio
async def test_upload_rejects_unsupported_mime(client, auth_headers):
    res = await client.post(
        "/api/v1/batches",
        json={"name": "Test rejection"},
        headers=auth_headers,
    )
    batch_id = res.json()["id"]

    res = await client.post(
        "/api/v1/documents/upload",
        data={"batch_id": batch_id},
        files={"file": ("evil.exe", b"MZ\x90", "application/x-msdownload")},
        headers=auth_headers,
    )
    assert res.status_code == 422
    assert "not supported" in res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_upload_detects_duplicate_by_checksum(client, auth_headers, image_bytes):
    res = await client.post(
        "/api/v1/batches", json={"name": "Dup test"}, headers=auth_headers
    )
    batch_id = res.json()["id"]

    files = {"file": ("a.png", image_bytes, "image/png")}
    first = await client.post(
        "/api/v1/documents/upload",
        data={"batch_id": batch_id},
        files=files,
        headers=auth_headers,
    )
    assert first.status_code == 201
    assert first.json()["duplicate"] is False

    second = await client.post(
        "/api/v1/documents/upload",
        data={"batch_id": batch_id},
        files={"file": ("a-renamed.png", image_bytes, "image/png")},
        headers=auth_headers,
    )
    assert second.status_code == 201
    assert second.json()["duplicate"] is True
    assert second.json()["document_id"] == first.json()["document_id"]
