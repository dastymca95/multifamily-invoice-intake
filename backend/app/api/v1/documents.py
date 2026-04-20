import io
import uuid
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status

from app.adapters.extraction.native_pdf import NativePdfAdapter
from app.adapters.extraction.ocr_stub import OcrStubAdapter
from app.adapters.storage.base import StorageAdapter
from app.adapters.storage.local import LocalStorageAdapter
from app.adapters.storage.s3 import S3StorageAdapter
from app.config import settings
from app.dependencies import DB, CurrentUser
from app.domain.invoice import CanonicalInvoice, CanonicalLineItem
from app.domain.validation import validate_invoice
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
