"""
Export workflow.

Phase 1: exports run synchronously inside the API request. The job record still
exists so the UI can show history and so we can flip to async (Celery) later
without changing the request/response shape.

The collection rule is intentionally permissive in Phase 1: any invoice in the
batch whose document has finished extraction is included. This lets users
export-then-correct rather than forcing approval-before-export.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal

import structlog
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.adapters.export.base import ExportAdapter
from app.adapters.storage.base import StorageAdapter
from app.domain.invoice import CanonicalInvoice, CanonicalLineItem
from app.models.document import Document
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
        vendor_name=invoice.vendor_name or "UNKNOWN",
        vendor_address=invoice.vendor_address,
        vendor_tax_id=invoice.vendor_tax_id,
        bill_to_name=invoice.bill_to_name,
        bill_to_address=invoice.bill_to_address,
        property_name=invoice.property_name,
        property_code=invoice.property_code,
        invoice_number=invoice.invoice_number or "UNKNOWN",
        invoice_date=invoice.invoice_date,
        due_date=invoice.due_date,
        service_period_start=invoice.service_period_start,
        service_period_end=invoice.service_period_end,
        payment_terms=invoice.payment_terms,
        subtotal=invoice.subtotal,
        tax_amount=invoice.tax_amount,
        total_amount=invoice.total_amount or Decimal("0"),
        currency=invoice.currency or "USD",
        invoice_type=invoice.invoice_type or "unknown",
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

    async def run_for_batch_sync(
        self,
        batch_id: uuid.UUID,
        format: str,
        requested_by: uuid.UUID,
    ) -> ExportJob:
        """Generate an export inline and return the completed (or failed) job."""
        adapter = self._adapters.get(format)
        if adapter is None:
            raise ValueError(f"Unknown export format: {format}")

        job = ExportJob(
            batch_id=batch_id,
            requested_by=requested_by,
            format=format,
            status="processing",
            filters={"batch_id": str(batch_id)},
        )
        self._session.add(job)
        await self._session.flush()

        invoices = await self._fetch_extracted_for_batch(batch_id)
        canonicals = [_to_canonical(inv) for inv in invoices]

        try:
            file_obj = adapter.export(canonicals)
        except Exception as exc:
            log.exception("export_render_failed", job_id=str(job.id))
            job.status = "failed"
            job.error_message = str(exc)
            await self._session.flush()
            return job

        ts = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
        key = f"exports/{job.id}/{ts}_export.{adapter.file_extension}"
        self._storage.put(key, file_obj, adapter.content_type)

        job.status = "completed"
        job.storage_key = key
        job.row_count = len(canonicals)
        await self._session.flush()

        log.info(
            "export_completed",
            job_id=str(job.id),
            batch_id=str(batch_id),
            format=format,
            rows=len(canonicals),
        )
        return job

    async def _fetch_extracted_for_batch(self, batch_id: uuid.UUID) -> list[Invoice]:
        stmt = (
            select(Invoice)
            .join(Document, Invoice.document_id == Document.id)
            .where(
                Document.batch_id == batch_id,
                Document.extraction_status == "extracted",
            )
            .options(selectinload(Invoice.lines))
            .order_by(Document.created_at.asc())
        )
        result = await self._session.execute(stmt)
        return list(result.scalars().all())
