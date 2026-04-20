"""
Export workflow: collect approved invoices, run the requested export adapter,
persist the output to storage, and update the ExportJob record.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import structlog

from app.adapters.export.base import ExportAdapter
from app.adapters.storage.base import StorageAdapter
from app.domain.invoice import CanonicalInvoice, CanonicalLineItem
from app.models.export_job import ExportJob
from app.models.invoice import Invoice
from app.repositories.export_job_repo import ExportJobRepository
from app.repositories.invoice_repo import InvoiceRepository

log = structlog.get_logger()


def _to_canonical(invoice: Invoice) -> CanonicalInvoice:
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
        currency=invoice.currency,
        invoice_type=invoice.invoice_type,
        utility_type=invoice.utility_type,
        account_number=invoice.account_number,
        meter_number=invoice.meter_number,
        extraction_confidence=invoice.extraction_confidence,
        raw_text_hash=invoice.raw_text_hash,
        line_items=lines,
    )


class ExportWorkflow:
    def __init__(
        self,
        adapters: dict[str, ExportAdapter],
        storage: StorageAdapter,
        invoice_repo: InvoiceRepository,
        export_job_repo: ExportJobRepository,
        session,
    ) -> None:
        self._adapters = adapters
        self._storage = storage
        self._invoice_repo = invoice_repo
        self._export_job_repo = export_job_repo
        self._session = session

    async def run(self, job_id: uuid.UUID) -> ExportJob:
        job = await self._export_job_repo.get_or_raise(job_id)
        job.status = "processing"
        await self._session.flush()

        adapter = self._adapters.get(job.format)
        if adapter is None:
            return await self._fail(job, f"Unknown export format: {job.format}")

        filters = job.filters or {}
        batch_id = uuid.UUID(filters["batch_id"]) if "batch_id" in filters else None

        invoices = await self._invoice_repo.get_approved_for_export(batch_id=batch_id)
        canonicals = [_to_canonical(inv) for inv in invoices]

        try:
            file_obj = adapter.export(canonicals)
        except Exception as exc:
            log.exception("export_render_failed", job_id=str(job_id))
            return await self._fail(job, str(exc))

        ts = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
        key = f"exports/{job_id}/{ts}_export.{adapter.file_extension}"
        self._storage.put(key, file_obj, adapter.content_type)

        job.status = "completed"
        job.storage_key = key
        job.row_count = len(canonicals)
        await self._session.flush()

        log.info("export_completed", job_id=str(job_id), format=job.format, rows=len(canonicals))
        return job

    async def _fail(self, job: ExportJob, message: str) -> ExportJob:
        job.status = "failed"
        job.error_message = message
        await self._session.flush()
        return job
