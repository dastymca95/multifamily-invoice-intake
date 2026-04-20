"""
Celery tasks for the extraction pipeline.

Tasks are thin wrappers: they set up the sync DB session and dependency
graph, then delegate to ExtractionWorkflow. All business logic lives in
the workflow, not the task.
"""

import uuid

import structlog
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.adapters.extraction.native_pdf import NativePdfAdapter
from app.adapters.extraction.ocr_stub import OcrStubAdapter
from app.adapters.storage.local import LocalStorageAdapter
from app.adapters.storage.s3 import S3StorageAdapter
from app.config import settings
from app.repositories.document_repo import DocumentRepository
from app.repositories.invoice_repo import InvoiceRepository
from app.repositories.vendor_pattern_repo import VendorPatternRepository
from app.workers.celery_app import celery_app

log = structlog.get_logger()

# Celery workers use the synchronous SQLAlchemy engine
_sync_engine = create_engine(settings.DATABASE_SYNC_URL, pool_pre_ping=True)
_SyncSession = sessionmaker(bind=_sync_engine, autoflush=False)


def _get_storage():
    if settings.STORAGE_BACKEND == "s3":
        return S3StorageAdapter()
    return LocalStorageAdapter()


@celery_app.task(
    name="tasks.extract_document",
    bind=True,
    max_retries=3,
    default_retry_delay=30,
)
def extract_document(self, document_id: str) -> dict:
    """Extract structured data from a single document."""
    doc_uuid = uuid.UUID(document_id)
    log.info("task_extract_document_started", document_id=document_id)

    with _SyncSession() as session:
        # Inline sync versions of repositories for Celery context
        from app.models.document import Document
        from app.models.extraction_run import ExtractionRun
        from app.models.invoice import Invoice
        from app.models.invoice_line import InvoiceLine

        adapters = [NativePdfAdapter(), OcrStubAdapter()]
        storage = _get_storage()

        doc = session.get(Document, doc_uuid)
        if doc is None:
            log.error("task_extract_document_not_found", document_id=document_id)
            return {"status": "not_found"}

        # Determine adapter
        adapter = next(
            (a for a in adapters if a.can_handle(doc.mime_type, doc.document_kind)), None
        )
        if adapter is None:
            doc.extraction_status = "failed"
            doc.error_message = "No extraction adapter available"
            session.commit()
            return {"status": "failed", "reason": "no_adapter"}

        try:
            with storage.get(doc.storage_key) as file:
                result = adapter.extract(file, doc.original_filename)
        except Exception as exc:
            log.warning("task_extract_document_failed", document_id=document_id, error=str(exc))
            try:
                raise self.retry(exc=exc)
            except self.MaxRetriesExceededError:
                doc.extraction_status = "failed"
                doc.error_message = str(exc)
                session.commit()
                return {"status": "failed", "reason": str(exc)}

        # Persist run
        run = ExtractionRun(
            document_id=doc_uuid,
            adapter_name=adapter.name,
            status="completed",
            confidence=result.confidence,
            raw_output=result.structured,
        )
        session.add(run)
        session.flush()

        # Upsert invoice
        inv = session.query(Invoice).filter_by(document_id=doc_uuid).first()
        if inv is None:
            inv = Invoice(document_id=doc_uuid)
            session.add(inv)
        inv.extraction_run_id = run.id
        _apply_structured_sync(inv, result.structured)
        session.flush()

        # Replace line items
        session.query(InvoiceLine).filter_by(invoice_id=inv.id).delete()
        for i, li in enumerate(result.structured.get("line_items", [])):
            from decimal import Decimal
            session.add(InvoiceLine(
                invoice_id=inv.id,
                line_number=li.get("line_number", i),
                description=li.get("description", ""),
                quantity=li.get("quantity"),
                unit=li.get("unit"),
                unit_price=li.get("unit_price"),
                amount=Decimal(str(li.get("amount", 0))),
                gl_code=li.get("gl_code"),
            ))

        doc.extraction_status = "extracted"
        session.commit()

        log.info("task_extract_document_done", document_id=document_id, adapter=adapter.name)
        return {"status": "completed", "adapter": adapter.name, "confidence": result.confidence}


def _apply_structured_sync(invoice, data: dict) -> None:
    for field in [
        "vendor_name", "vendor_address", "invoice_number", "invoice_date", "due_date",
        "total_amount", "currency", "invoice_type", "account_number", "extraction_confidence",
        "raw_text_hash",
    ]:
        val = data.get(field)
        if val is not None:
            setattr(invoice, field, val)
