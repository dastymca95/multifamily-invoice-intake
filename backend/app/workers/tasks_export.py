import uuid

import structlog
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.workers.celery_app import celery_app

log = structlog.get_logger()

_sync_engine = create_engine(settings.DATABASE_SYNC_URL, pool_pre_ping=True)
_SyncSession = sessionmaker(bind=_sync_engine, autoflush=False)


@celery_app.task(name="tasks.run_export_job", bind=True, max_retries=2)
def run_export_job(self, job_id: str) -> dict:
    """Render an export file and upload it to storage."""
    from decimal import Decimal

    from app.adapters.export.csv_exporter import CsvExportAdapter
    from app.adapters.export.json_exporter import JsonExportAdapter
    from app.adapters.export.xlsx_exporter import XlsxExportAdapter
    from app.adapters.storage.local import LocalStorageAdapter
    from app.adapters.storage.s3 import S3StorageAdapter
    from app.domain.invoice import CanonicalInvoice, CanonicalLineItem
    from app.models.export_job import ExportJob
    from app.models.invoice import Invoice
    from datetime import UTC, datetime

    log.info("task_export_job_started", job_id=job_id)
    job_uuid = uuid.UUID(job_id)

    adapters = {
        "csv": CsvExportAdapter(),
        "xlsx": XlsxExportAdapter(),
        "json": JsonExportAdapter(),
    }
    storage = LocalStorageAdapter() if settings.STORAGE_BACKEND != "s3" else S3StorageAdapter()

    with _SyncSession() as session:
        job = session.get(ExportJob, job_uuid)
        if job is None:
            return {"status": "not_found"}

        job.status = "processing"
        session.flush()

        adapter = adapters.get(job.format)
        if adapter is None:
            job.status = "failed"
            job.error_message = f"Unknown format: {job.format}"
            session.commit()
            return {"status": "failed"}

        from app.models.document import Document
        query = (
            session.query(Invoice)
            .join(Document, Invoice.document_id == Document.id)
            .filter(Document.review_status == "approved")
        )
        if job.batch_id:
            query = query.filter(Document.batch_id == job.batch_id)

        invoices = query.all()

        canonicals = []
        for inv in invoices:
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
                for li in inv.lines
            ]
            canonicals.append(CanonicalInvoice(
                id=inv.id,
                document_id=inv.document_id,
                vendor_name=inv.vendor_name or "UNKNOWN",
                invoice_number=inv.invoice_number or "",
                invoice_date=inv.invoice_date,
                total_amount=inv.total_amount or Decimal("0"),
                currency=inv.currency or "USD",
                invoice_type=inv.invoice_type or "unknown",
                line_items=lines,
            ))

        try:
            file_obj = adapter.export(canonicals)
        except Exception as exc:
            log.exception("task_export_render_failed", job_id=job_id)
            job.status = "failed"
            job.error_message = str(exc)
            session.commit()
            return {"status": "failed"}

        ts = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
        key = f"exports/{job_id}/{ts}_export.{adapter.file_extension}"
        storage.put(key, file_obj, adapter.content_type)

        job.status = "completed"
        job.storage_key = key
        job.row_count = len(canonicals)
        session.commit()

    log.info("task_export_job_done", job_id=job_id, rows=len(canonicals))
    return {"status": "completed", "key": key, "rows": len(canonicals)}
