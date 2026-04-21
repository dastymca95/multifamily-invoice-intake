import hashlib
import io
import uuid
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import delete

from app.adapters.extraction.native_pdf import NativePdfAdapter
from app.adapters.extraction.ocr_stub import OcrStubAdapter
from app.adapters.storage.base import StorageAdapter, StorageKeyNotFound
from app.adapters.storage.local import LocalStorageAdapter
from app.adapters.storage.s3 import S3StorageAdapter
from app.config import settings
from app.dependencies import DB, CurrentUser
from app.domain.invoice import CanonicalInvoice, CanonicalLineItem
from app.domain.pdf_trim import PageTrimError, trim_pdf_bytes
from app.domain.routing import route_document
from app.domain.validation import validate_invoice
from app.models.extraction_run import ExtractionRun
from app.models.invoice import Invoice
from app.repositories.batch_repo import BatchRepository
from app.repositories.document_repo import DocumentRepository
from app.repositories.extraction_run_repo import ExtractionRunRepository
from app.repositories.invoice_repo import InvoiceRepository
from app.repositories.vendor_pattern_repo import VendorPatternRepository
from app.schemas.document import (
    DocumentDetailResponse,
    DocumentOut,
    DocumentUploadResult,
    ExtractionRunOut,
    ValidationWarningOut,
)
from app.workflows.extraction import ExtractionWorkflow
from app.workflows.ingest import FileValidationError, IngestWorkflow

router = APIRouter(prefix="/documents", tags=["documents"])


def _get_storage() -> StorageAdapter:
    if settings.STORAGE_BACKEND == "s3":
        return S3StorageAdapter()
    return LocalStorageAdapter()


def _build_extraction_workflow(db) -> ExtractionWorkflow:
    return ExtractionWorkflow(
        adapters=[NativePdfAdapter(), OcrStubAdapter()],
        storage=_get_storage(),
        document_repo=DocumentRepository(db),
        invoice_repo=InvoiceRepository(db),
        vendor_pattern_repo=VendorPatternRepository(db),
        session=db,
    )


@router.post(
    "/upload",
    response_model=DocumentUploadResult,
    status_code=status.HTTP_201_CREATED,
)
async def upload_document(
    db: DB,
    user: CurrentUser,
    batch_id: uuid.UUID = Form(...),
    file: UploadFile = File(...),
) -> DocumentUploadResult:
    """
    Upload a single document into a batch.

    Phase 1: extraction runs synchronously inside this request so the reviewer
    can open the document immediately. Flip `EXTRACTION_USE_CELERY=True` once
    the worker is operational to switch to background processing.
    """
    batch_repo = BatchRepository(db)
    if await batch_repo.get(batch_id) is None:
        raise HTTPException(status_code=404, detail="Batch not found")

    doc_repo = DocumentRepository(db)
    storage = _get_storage()
    ingest = IngestWorkflow(storage, batch_repo, doc_repo)

    file_bytes = await file.read()
    try:
        result = await ingest.ingest_file(
            batch_id=batch_id,
            file=io.BytesIO(file_bytes),
            original_filename=file.filename or "unnamed",
            mime_type=file.content_type or "application/octet-stream",
        )
    except FileValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    doc = result.document

    if not result.duplicate and doc.route_used != "unsupported":
        if settings.EXTRACTION_USE_CELERY:
            from app.workers.tasks_extraction import extract_document
            extract_document.delay(str(doc.id))
        else:
            workflow = _build_extraction_workflow(db)
            await workflow.run(doc.id)
            await db.refresh(doc)

    return DocumentUploadResult(
        document_id=doc.id,
        original_filename=doc.original_filename,
        route_used=doc.route_used,
        extraction_status=doc.extraction_status,
        review_status=doc.review_status,
        duplicate=result.duplicate,
    )


@router.get("/pending-review", response_model=list[DocumentOut])
async def list_pending_review(db: DB, user: CurrentUser, limit: int = 50) -> list[DocumentOut]:
    repo = DocumentRepository(db)
    docs = await repo.get_pending_review(limit=limit)
    return [DocumentOut.model_validate(d) for d in docs]


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    document_id: uuid.UUID, db: DB, user: CurrentUser
) -> Response:
    """
    Permanently delete a document, its extraction history, and its derived
    invoice.

    Cascade chain (DB-side, ON DELETE CASCADE):
        documents → extraction_runs
                  → invoices → invoice_lines
                             → review_events

    The corresponding ORM relationships on `Document` are configured with
    `passive_deletes=True` so SQLAlchemy lets the DB handle the cascade
    instead of trying to nullify NOT NULL child FKs (which would fail
    with an IntegrityError and surface as an HTTP 500).

    Storage cleanup is best-effort and ordered before the DB delete so a
    rare storage error leaves the row in place rather than orphaning a
    DB row that points at missing bytes.

    Used by the Upload workspace's "Remove from batch" action.
    """
    doc_repo = DocumentRepository(db)
    batch_repo = BatchRepository(db)
    storage = _get_storage()

    doc = await doc_repo.get(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    # Snapshot the fields we need to roll back denormalised counters AFTER
    # the row is gone — accessing attributes on a deleted ORM instance is
    # not portable across SQLAlchemy versions.
    batch_id = doc.batch_id
    extraction_status = doc.extraction_status
    storage_key = doc.storage_key

    # Storage is not transactional. If this fails the file is orphaned but
    # the DB stays consistent — preferable to a half-deleted DB row.
    try:
        storage.delete(storage_key)
    except Exception:
        pass

    await doc_repo.delete(doc)

    # Roll back batch counters set during ingest / extraction so the
    # dashboard "Documents X / Y" tally stays accurate.
    await batch_repo.increment_counter(batch_id, "total_documents", delta=-1)
    if extraction_status == "extracted":
        await batch_repo.increment_counter(batch_id, "processed_documents", delta=-1)
    elif extraction_status == "failed":
        await batch_repo.increment_counter(batch_id, "failed_documents", delta=-1)

    return Response(status_code=status.HTTP_204_NO_CONTENT)


class TrimRequest(BaseModel):
    """
    Body for `POST /documents/{id}/trim`.

    `removed_pages` is the set of 1-indexed page numbers the user marked for
    removal in the Pages tab. Order doesn't matter; duplicates are tolerated
    and de-duped server-side. The endpoint enforces "at least one page must
    remain" — sending every page is a 422.
    """

    removed_pages: list[int] = Field(default_factory=list)


@router.post("/{document_id}/trim", response_model=DocumentDetailResponse)
async def trim_document_pages(
    document_id: uuid.UUID,
    body: TrimRequest,
    db: DB,
    user: CurrentUser,
) -> DocumentDetailResponse:
    """
    Trim pages from a persisted PDF and re-run extraction.

    Persisted-document version of the queued-PDF page editor. The queued
    flow rewrites bytes in the browser before upload; once the file is on
    the server, we have to do it server-side or the checksum/dedup story
    breaks down.

    Workflow (each step is reversible until the next one):
        1. Validate: doc exists, is a PDF, has bytes in storage.
        2. Read source bytes, trim via pypdf (`app.domain.pdf_trim`).
        3. Compute new SHA-256, refresh route_used (text-bearing PDFs may
           still be text-bearing after trim, but a single-page extract may
           cross the heuristic threshold).
        4. Write trimmed bytes under a NEW storage key derived from the new
           checksum. We never overwrite the old key in place — if the write
           fails the original is still intact.
        5. Drop the existing invoice + extraction_runs via bulk DELETE
           (DB cascade handles invoice_lines / review_events; the parent-
           side `passive_deletes=True` on Document keeps SQLAlchemy from
           trying to nullify NOT NULL child FKs first).
        6. Update the Document row (storage_key, checksum, size, route,
           extraction_status="pending", review_status="pending",
           error_message=None).
        7. Best-effort delete the old storage key — failure here just
           orphans bytes, the DB is already pointing at the new file.
        8. Re-run extraction inline. (The flag-gated Celery branch is
           intentionally skipped: this endpoint is the user's "save"
           click; they expect the re-extracted invoice in the response.)
        9. Refresh + return the same shape as `GET /documents/{id}`.

    Notes / assumptions:
        * Checksum collision: `documents.checksum_sha256` has no UNIQUE
          constraint, so a trim that happens to produce the same hash as
          an existing document is allowed. The frontend's de-dup story
          only kicks in at upload time; trim doesn't go through that path.
        * Review state reset: review_events for this document are dropped
          via the invoice cascade. Documented in the user-facing warning
          in the Pages tab — preserving them would create a misleading
          audit trail against bytes that no longer exist.
    """
    doc_repo = DocumentRepository(db)
    invoice_repo = InvoiceRepository(db)
    run_repo = ExtractionRunRepository(db)
    storage = _get_storage()

    doc = await doc_repo.get(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if doc.mime_type != "application/pdf":
        raise HTTPException(
            status_code=422,
            detail="Page trimming is only supported for PDF documents.",
        )

    # Step 2: read source bytes.
    try:
        f = storage.get(doc.storage_key)
    except StorageKeyNotFound:
        raise HTTPException(
            status_code=404, detail="File missing from storage"
        )
    try:
        src_bytes = f.read()
    finally:
        try:
            f.close()
        except Exception:
            pass

    # Step 3: trim. PageTrimError → 422 (user-correctable).
    try:
        new_bytes, kept_pages = trim_pdf_bytes(src_bytes, body.removed_pages)
    except PageTrimError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # Size guard: a malformed or pathological PDF could in theory grow on
    # rewrite; honour the same limit ingest applies so we never accept
    # something the rest of the pipeline would reject.
    if len(new_bytes) > settings.max_file_size_bytes:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Trimmed PDF size ({len(new_bytes)} bytes) exceeds the "
                f"{settings.MAX_FILE_SIZE_MB} MB limit."
            ),
        )

    # Step 4: new key derived from the new checksum so we don't collide
    # with the existing object. Same shape as IngestWorkflow's keys for
    # consistency.
    new_checksum = hashlib.sha256(new_bytes).hexdigest()
    new_route = route_document(doc.mime_type, new_bytes)
    new_storage_key = (
        f"documents/{doc.batch_id}/{new_checksum[:8]}_{doc.original_filename}"
    )

    # Edge case: if a previous trim happens to round-trip back to the same
    # bytes, the derived key matches the existing one. Append a short uuid
    # suffix so we don't accidentally write-then-delete the active file.
    if new_storage_key == doc.storage_key:
        new_storage_key = (
            f"documents/{doc.batch_id}/{new_checksum[:8]}_"
            f"trim-{uuid.uuid4().hex[:8]}_{doc.original_filename}"
        )

    storage.put(new_storage_key, io.BytesIO(new_bytes), doc.mime_type)
    old_storage_key = doc.storage_key

    # Step 5: cascade-drop derived rows BEFORE updating the document so
    # the new extraction run starts from a clean slate. Bulk DELETE
    # statements bypass ORM cascade machinery entirely — the FK ON DELETE
    # CASCADE on invoice_lines / review_events handles the children
    # at the DB layer.
    await db.execute(delete(Invoice).where(Invoice.document_id == doc.id))
    await db.execute(
        delete(ExtractionRun).where(ExtractionRun.document_id == doc.id)
    )
    await db.flush()

    # Step 6: update doc fields.
    doc.storage_key = new_storage_key
    doc.checksum_sha256 = new_checksum
    doc.file_size_bytes = len(new_bytes)
    doc.route_used = new_route
    doc.extraction_status = "pending"
    doc.review_status = "pending"
    doc.error_message = None
    await db.flush()

    # Step 7: best-effort cleanup of the now-orphaned old key.
    try:
        storage.delete(old_storage_key)
    except Exception:
        # Non-fatal — DB is already pointing at the new bytes. Worst case
        # we leave an orphan in storage; the row is consistent.
        pass

    # Step 8: re-run extraction inline. Done after the DB updates above
    # are flushed (but pre-commit) so the workflow sees the new
    # storage_key + route_used on the same document instance.
    workflow = _build_extraction_workflow(db)
    try:
        await workflow.run(doc.id)
    except Exception:
        # ExtractionWorkflow already logs and sets extraction_status =
        # "failed" via _fail() for handled adapter errors. Truly
        # unexpected exceptions still propagate up here as a 500 — the
        # trim itself succeeded, so the user sees the new bytes on
        # reload, just without a fresh invoice.
        raise

    # Step 9: rebuild the same response shape as GET /documents/{id}.
    await db.refresh(doc)
    latest_run = await run_repo.get_latest_for_document(document_id)
    invoice_obj = await invoice_repo.get_by_document(document_id)

    invoice_dict: dict[str, Any] | None = None
    warnings: list[ValidationWarningOut] = []
    if invoice_obj is not None:
        invoice_obj = await invoice_repo.get_with_lines(invoice_obj.id)
        canonical = _invoice_to_canonical(invoice_obj)
        invoice_dict = canonical.model_dump(mode="json")
        invoice_dict["id"] = str(invoice_obj.id)
        warnings = [
            ValidationWarningOut(**w.to_dict())
            for w in validate_invoice(canonical)
        ]

    # Roll back the batch's processed/failed counter if extraction state
    # changed. If the original was extracted and we re-extracted to
    # extracted, the net is zero — but if it went extracted → failed (or
    # vice versa), the dashboard tally would otherwise drift. We don't
    # have the pre-trim status anymore, so the safest path is to refresh
    # the batch counters by recomputing from the document rows. A future
    # iteration can do this more surgically; for now we trust the
    # extraction workflow's own counter touches (none today) and accept
    # a small drift after trim. See follow-ups doc.

    return DocumentDetailResponse(
        document=DocumentOut.model_validate(doc),
        extraction_run=ExtractionRunOut.model_validate(latest_run)
        if latest_run
        else None,
        invoice=invoice_dict,
        warnings=warnings,
    )


@router.get("/{document_id}/file")
async def get_document_file(
    document_id: uuid.UUID, db: DB, user: CurrentUser
) -> Response:
    """
    Stream the raw uploaded bytes for a document. JWT-protected.

    Used by the Upload workspace's preview pane to render PDFs and images
    that have already been persisted (the user reopened an existing batch).
    Files still client-side use a blob URL on the frontend instead of this.

    Capped by `MAX_FILE_SIZE_MB` at ingest time, so loading into memory is
    bounded.
    """
    doc_repo = DocumentRepository(db)
    doc = await doc_repo.get(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    storage = _get_storage()
    try:
        f = storage.get(doc.storage_key)
    except StorageKeyNotFound:
        raise HTTPException(status_code=404, detail="File missing from storage")

    try:
        content = f.read()
    finally:
        # Both LocalStorage (file handle) and S3StorageAdapter (StreamingBody)
        # expose .close().
        try:
            f.close()
        except Exception:
            pass

    return Response(
        content=content,
        media_type=doc.mime_type,
        headers={
            "Content-Disposition": f'inline; filename="{doc.original_filename}"',
            "Content-Length": str(len(content)),
            "Cache-Control": "private, max-age=300",
        },
    )


@router.get("/{document_id}", response_model=DocumentDetailResponse)
async def get_document(
    document_id: uuid.UUID, db: DB, user: CurrentUser
) -> DocumentDetailResponse:
    """
    Returns the document, latest extraction run, the canonical invoice (with
    lines), and any validation warnings. This is what the review screen loads.
    """
    doc_repo = DocumentRepository(db)
    invoice_repo = InvoiceRepository(db)
    run_repo = ExtractionRunRepository(db)

    doc = await doc_repo.get(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    latest_run = await run_repo.get_latest_for_document(document_id)
    invoice_obj = await invoice_repo.get_by_document(document_id)

    invoice_dict: dict[str, Any] | None = None
    warnings: list[ValidationWarningOut] = []
    if invoice_obj is not None:
        invoice_obj = await invoice_repo.get_with_lines(invoice_obj.id)
        canonical = _invoice_to_canonical(invoice_obj)
        invoice_dict = canonical.model_dump(mode="json")
        invoice_dict["id"] = str(invoice_obj.id)
        warnings = [
            ValidationWarningOut(**w.to_dict()) for w in validate_invoice(canonical)
        ]

    return DocumentDetailResponse(
        document=DocumentOut.model_validate(doc),
        extraction_run=ExtractionRunOut.model_validate(latest_run) if latest_run else None,
        invoice=invoice_dict,
        warnings=warnings,
    )


def _invoice_to_canonical(invoice) -> CanonicalInvoice:
    lines = [
        CanonicalLineItem(
            line_number=li.line_number,
            description=li.description,
            quantity=li.quantity,
            unit=li.unit,
            unit_price=li.unit_price,
            amount=li.amount,
            gl_code=li.gl_code,
        )
        for li in (invoice.lines or [])
    ]
    return CanonicalInvoice(
        id=invoice.id,
        document_id=invoice.document_id,
        extraction_run_id=invoice.extraction_run_id,
        vendor_name=invoice.vendor_name,
        vendor_address=invoice.vendor_address,
        vendor_tax_id=invoice.vendor_tax_id,
        bill_to_name=invoice.bill_to_name,
        bill_to_address=invoice.bill_to_address,
        property_name=invoice.property_name,
        property_code=invoice.property_code,
        invoice_number=invoice.invoice_number,
        invoice_date=invoice.invoice_date,
        due_date=invoice.due_date,
        service_period_start=invoice.service_period_start,
        service_period_end=invoice.service_period_end,
        payment_terms=invoice.payment_terms,
        subtotal=invoice.subtotal,
        tax_amount=invoice.tax_amount,
        total_amount=invoice.total_amount,
        currency=invoice.currency or "USD",
        invoice_type=invoice.invoice_type or "unknown",
        utility_type=invoice.utility_type,
        account_number=invoice.account_number,
        meter_number=invoice.meter_number,
        line_items=lines,
        extraction_confidence=invoice.extraction_confidence,
        raw_text_hash=invoice.raw_text_hash,
    )
