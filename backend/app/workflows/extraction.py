"""
Extraction workflow.

For a single document:
  1. Pick an adapter that matches the routed document type.
  2. Run the adapter against the stored bytes.
  3. Persist an ExtractionRun with raw_output_json + normalized_output_json.
  4. Upsert the Invoice (and replace its lines) using the normalized payload.
  5. Move the document to extraction_status="extracted" (or "failed").

Validation runs as part of the document detail API, not here. Extraction never
fails because of missing/blank fields — those are surfaced to the reviewer.
"""

from __future__ import annotations

import time
import uuid
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

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


_HEADER_FIELDS = (
    "vendor_name", "vendor_address", "vendor_tax_id", "bill_to_name",
    "bill_to_address", "property_name", "property_code", "invoice_number",
    "invoice_date", "due_date", "service_period_start", "service_period_end",
    "payment_terms", "subtotal", "tax_amount", "total_amount", "currency",
    "invoice_type", "utility_type", "account_number", "meter_number",
    "raw_text_hash",
)


def _select_adapter(
    adapters: list[ExtractionAdapter], mime_type: str, route: str
) -> ExtractionAdapter | None:
    for adapter in adapters:
        if adapter.can_handle(mime_type, route):
            return adapter
    return None


def _parse_date(value: Any) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    s = str(value).strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%m/%d/%y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _parse_decimal(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value).replace(",", "").replace("$", "").strip())
    except (InvalidOperation, ValueError):
        return None


class ExtractionWorkflow:
    def __init__(
        self,
        adapters: list[ExtractionAdapter],
        storage: StorageAdapter,
        document_repo: DocumentRepository,
        invoice_repo: InvoiceRepository,
        vendor_pattern_repo: VendorPatternRepository,
        session,
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

        adapter = _select_adapter(self._adapters, doc.mime_type, doc.route_used)
        if adapter is None:
            return await self._fail(doc, None, f"No adapter available for route '{doc.route_used}'")

        run = ExtractionRun(
            document_id=document_id,
            adapter_name=adapter.name,
            status="processing",
            review_required=True,
        )
        self._session.add(run)
        await self._session.flush()

        start = time.monotonic()
        try:
            with self._storage.get(doc.storage_key) as file:
                result = adapter.extract(file, doc.original_filename, vendor_hints={})
        except ExtractionError as exc:
            return await self._fail(doc, run, str(exc))
        except Exception as exc:
            log.exception("extraction_unexpected_error", document_id=str(document_id))
            return await self._fail(doc, run, f"Unexpected error: {exc}")

        duration_ms = int((time.monotonic() - start) * 1000)

        normalized = self._normalize(doc.id, run.id, result.structured)

        run.status = "completed"
        run.confidence_score = result.confidence
        run.raw_output_json = result.structured
        run.normalized_output_json = normalized.model_dump(mode="json")
        run.duration_ms = duration_ms
        run.review_required = True

        await self._upsert_invoice(doc, run, normalized)

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

    def _normalize(
        self, document_id: uuid.UUID, run_id: uuid.UUID, structured: dict
    ) -> CanonicalInvoice:
        """
        Coerce an adapter's raw dict into a CanonicalInvoice.

        Review-first: every review-fillable field flows through as None if the
        adapter couldn't read it. No "UNKNOWN" placeholders — the reviewer sees
        an empty field and fills it in. Validation warnings guide their attention.
        """
        line_items = []
        for i, li in enumerate(structured.get("line_items") or []):
            # Line-item amount stays required by the canonical shape; if the
            # adapter couldn't read it, default to 0 so the line is still
            # reviewable (reviewer will overwrite).
            amount = _parse_decimal(li.get("amount")) or Decimal("0")
            line_items.append(CanonicalLineItem(
                line_number=int(li.get("line_number", i)),
                description=str(li.get("description") or "").strip() or "—",
                quantity=_parse_decimal(li.get("quantity")),
                unit=li.get("unit"),
                unit_price=_parse_decimal(li.get("unit_price")),
                amount=amount,
                gl_code=li.get("gl_code"),
            ))

        def _clean_str(v: Any) -> str | None:
            if v is None:
                return None
            s = str(v).strip()
            # Treat legacy "UNKNOWN" placeholders from older adapters as None
            # so the reviewer sees an empty field to fill rather than a string
            # they have to delete first.
            if not s or s.upper() == "UNKNOWN":
                return None
            return s

        return CanonicalInvoice(
            document_id=document_id,
            extraction_run_id=run_id,
            vendor_name=_clean_str(structured.get("vendor_name")),
            vendor_address=structured.get("vendor_address"),
            vendor_tax_id=structured.get("vendor_tax_id"),
            bill_to_name=structured.get("bill_to_name"),
            bill_to_address=structured.get("bill_to_address"),
            property_name=structured.get("property_name"),
            property_code=structured.get("property_code"),
            invoice_number=_clean_str(structured.get("invoice_number")),
            invoice_date=_parse_date(structured.get("invoice_date")),
            due_date=_parse_date(structured.get("due_date")),
            service_period_start=_parse_date(structured.get("service_period_start")),
            service_period_end=_parse_date(structured.get("service_period_end")),
            payment_terms=structured.get("payment_terms"),
            subtotal=_parse_decimal(structured.get("subtotal")),
            tax_amount=_parse_decimal(structured.get("tax_amount")),
            total_amount=_parse_decimal(structured.get("total_amount")),
            currency=structured.get("currency") or "USD",
            invoice_type=structured.get("invoice_type") or "unknown",
            utility_type=structured.get("utility_type"),
            account_number=structured.get("account_number"),
            meter_number=structured.get("meter_number"),
            line_items=line_items,
            extraction_confidence=structured.get("extraction_confidence"),
            raw_text_hash=structured.get("raw_text_hash"),
        )

    async def _upsert_invoice(
        self, doc: Document, run: ExtractionRun, normalized: CanonicalInvoice
    ) -> Invoice:
        existing = await self._invoice_repo.get_by_document(doc.id)
        if existing is not None:
            invoice = await self._invoice_repo.get_with_lines(existing.id)
            for line in list(invoice.lines):
                await self._session.delete(line)
        else:
            invoice = Invoice(document_id=doc.id)
            self._session.add(invoice)

        invoice.extraction_run_id = run.id
        payload = normalized.model_dump()
        for field in _HEADER_FIELDS:
            if field in payload:
                setattr(invoice, field, payload[field])
        invoice.extraction_confidence = run.confidence_score
        await self._session.flush()

        for li in normalized.line_items:
            self._session.add(InvoiceLine(
                invoice_id=invoice.id,
                line_number=li.line_number,
                description=li.description,
                quantity=li.quantity,
                unit=li.unit,
                unit_price=li.unit_price,
                amount=li.amount,
                gl_code=li.gl_code,
            ))

        await self._session.flush()
        return invoice

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
                review_required=True,
                error_message=message,
            )
            self._session.add(run)
        await self._session.flush()
        log.warning("extraction_failed", document_id=str(doc.id), reason=message)
        return run
