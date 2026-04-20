"""
Extraction workflow: route a document to the right adapter, run extraction,
persist the ExtractionRun, and upsert the Invoice record.
"""

from __future__ import annotations

import time
import uuid
from decimal import Decimal

import structlog

from app.adapters.extraction.base import ExtractionAdapter, ExtractionError
from app.adapters.storage.base import StorageAdapter
from app.domain.invoice import CanonicalInvoice, CanonicalLineItem
from app.models.document import Document
from app.models.extraction_run import ExtractionRun
from app.models.invoice import Invoice
from app.models.invoice_line import InvoiceLine
from app.repositories.document_repo import DocumentRepository
from app.repositories.invoice_repo import InvoiceRepository
from app.repositories.vendor_pattern_repo import VendorPatternRepository

log = structlog.get_logger()


def _select_adapter(
    adapters: list[ExtractionAdapter], mime_type: str, document_kind: str
) -> ExtractionAdapter | None:
    for adapter in adapters:
        if adapter.can_handle(mime_type, document_kind):
            return adapter
    return None


class ExtractionWorkflow:
    def __init__(
        self,
        adapters: list[ExtractionAdapter],
        storage: StorageAdapter,
        document_repo: DocumentRepository,
        invoice_repo: InvoiceRepository,
        vendor_pattern_repo: VendorPatternRepository,
        session,  # AsyncSession — passed for direct ORM flushes
    ) -> None:
        self._adapters = adapters
        self._storage = storage
        self._document_repo = document_repo
        self._invoice_repo = invoice_repo
        self._vendor_pattern_repo = vendor_pattern_repo
        self._session = session

    async def run(self, document_id: uuid.UUID) -> ExtractionRun:
        doc = await self._document_repo.get_or_raise(document_id)
        doc.extraction_status = "processing"
        await self._session.flush()

        adapter = _select_adapter(self._adapters, doc.mime_type, doc.document_kind)
        if adapter is None:
            return await self._fail(doc, None, "No adapter available for this document type")

        vendor_hints = await self._load_vendor_hints(doc)

        run = ExtractionRun(
            document_id=document_id,
            adapter_name=adapter.name,
            status="processing",
        )
        self._session.add(run)
        await self._session.flush()

        start = time.monotonic()
        try:
            with self._storage.get(doc.storage_key) as file:
                result = adapter.extract(file, doc.original_filename, vendor_hints)
        except ExtractionError as exc:
            return await self._fail(doc, run, str(exc))
        except Exception as exc:
            log.exception("extraction_unexpected_error", document_id=str(document_id))
            return await self._fail(doc, run, f"Unexpected error: {exc}")

        duration_ms = int((time.monotonic() - start) * 1000)

        run.status = "completed"
        run.confidence = result.confidence
        run.raw_output = result.structured
        run.duration_ms = duration_ms

        await self._upsert_invoice(doc, run, result.structured)

        doc.extraction_status = "extracted"
        await self._session.flush()

        log.info(
            "extraction_completed",
            document_id=str(document_id),
            adapter=adapter.name,
            confidence=result.confidence,
            duration_ms=duration_ms,
        )
        return run

    async def _load_vendor_hints(self, doc: Document) -> dict:
        # Attempt to pre-load vendor hints if vendor name is inferrable.
        # For first-time vendors this will be None.
        return {}

    async def _upsert_invoice(
        self, doc: Document, run: ExtractionRun, structured: dict
    ) -> Invoice:
        existing = await self._invoice_repo.get_by_document(doc.id)
        if existing is not None:
            # Re-extraction: remove old lines, refresh header fields
            for line in existing.lines:
                await self._session.delete(line)
            invoice = existing
        else:
            invoice = Invoice(document_id=doc.id)
            self._session.add(invoice)

        invoice.extraction_run_id = run.id
        self._apply_structured(invoice, structured)
        await self._session.flush()

        for i, li_data in enumerate(structured.get("line_items", [])):
            line = InvoiceLine(
                invoice_id=invoice.id,
                line_number=li_data.get("line_number", i),
                description=li_data.get("description", ""),
                quantity=li_data.get("quantity"),
                unit=li_data.get("unit"),
                unit_price=li_data.get("unit_price"),
                amount=Decimal(str(li_data.get("amount", 0))),
                gl_code=li_data.get("gl_code"),
            )
            self._session.add(line)

        await self._session.flush()
        return invoice

    def _apply_structured(self, invoice: Invoice, data: dict) -> None:
        for field in [
            "vendor_name", "vendor_address", "vendor_tax_id", "bill_to_name",
            "bill_to_address", "property_name", "property_code", "invoice_number",
            "invoice_date", "due_date", "service_period_start", "service_period_end",
            "payment_terms", "subtotal", "tax_amount", "total_amount", "currency",
            "invoice_type", "utility_type", "account_number", "meter_number",
            "extraction_confidence", "raw_text_hash",
        ]:
            val = data.get(field)
            if val is not None:
                setattr(invoice, field, val)

    async def _fail(
        self, doc: Document, run: ExtractionRun | None, message: str
    ) -> ExtractionRun:
        doc.extraction_status = "failed"
        doc.error_message = message
        if run is not None:
            run.status = "failed"
            run.error_message = message
        else:
            run = ExtractionRun(
                document_id=doc.id,
                adapter_name="none",
                status="failed",
                error_message=message,
            )
            self._session.add(run)
        await self._session.flush()
        log.warning("extraction_failed", document_id=str(doc.id), reason=message)
        return run
