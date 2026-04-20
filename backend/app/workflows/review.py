"""
Review workflow.

The reviewer is the source of truth. `save_invoice` accepts the full canonical
payload from the UI, replaces the Invoice's header fields and line items
atomically, and writes a single immutable ReviewEvent capturing before/after
JSON snapshots so the audit trail can reconstruct any prior state.

`approve` / `reject` are kept for the explicit decision step that follows save.
"""

from __future__ import annotations

import uuid
from typing import Any

import structlog

from app.domain.invoice import CanonicalInvoice
from app.models.invoice import Invoice
from app.models.invoice_line import InvoiceLine
from app.models.review_event import ReviewEvent
from app.repositories.document_repo import DocumentRepository
from app.repositories.invoice_repo import InvoiceRepository
from app.repositories.review_repo import ReviewRepository

log = structlog.get_logger()


_HEADER_FIELDS = (
    "vendor_name", "vendor_address", "vendor_tax_id", "bill_to_name",
    "bill_to_address", "property_name", "property_code", "invoice_number",
    "invoice_date", "due_date", "service_period_start", "service_period_end",
    "payment_terms", "subtotal", "tax_amount", "total_amount", "currency",
    "invoice_type", "utility_type", "account_number", "meter_number",
)


def _invoice_snapshot(invoice: Invoice) -> dict[str, Any]:
    """Serialize an Invoice (with lines) for ReviewEvent before/after capture."""
    return {
        **{f: _json_safe(getattr(invoice, f)) for f in _HEADER_FIELDS},
        "line_items": [
            {
                "line_number": li.line_number,
                "description": li.description,
                "quantity": _json_safe(li.quantity),
                "unit": li.unit,
                "unit_price": _json_safe(li.unit_price),
                "amount": _json_safe(li.amount),
                "gl_code": li.gl_code,
            }
            for li in (invoice.lines or [])
        ],
    }


def _json_safe(v: Any) -> Any:
    if v is None:
        return None
    # Decimal / date / datetime / Enum → string for JSONB storage
    return str(v) if not isinstance(v, (int, float, bool, str, list, dict)) else v


class ReviewWorkflow:
    def __init__(
        self,
        invoice_repo: InvoiceRepository,
        document_repo: DocumentRepository,
        review_repo: ReviewRepository,
        session,
    ) -> None:
        self._invoice_repo = invoice_repo
        self._document_repo = document_repo
        self._review_repo = review_repo
        self._session = session

    async def save_invoice(
        self,
        document_id: uuid.UUID,
        payload: CanonicalInvoice,
        reviewer_id: uuid.UUID,
        note: str | None = None,
    ) -> ReviewEvent:
        """Bulk-save reviewer edits. Replaces header fields and line items."""
        invoice = await self._invoice_repo.get_by_document(document_id)
        if invoice is None:
            raise ValueError(f"No invoice found for document {document_id}")
        # Re-load with lines to capture before-state.
        invoice = await self._invoice_repo.get_with_lines(invoice.id)
        before = _invoice_snapshot(invoice)

        data = payload.model_dump()
        for field in _HEADER_FIELDS:
            if field in data:
                setattr(invoice, field, data[field])

        for line in list(invoice.lines):
            await self._session.delete(line)
        await self._session.flush()

        for li in payload.line_items:
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

        # Refresh `lines` for the snapshot. The Invoice instance is already in
        # the session's identity map, so a fresh `get_with_lines` returns the
        # cached object whose `lines` collection still reflects the pre-edit
        # state. Expire that one relationship to force a reload.
        self._session.expire(invoice, ["lines"])
        invoice = await self._invoice_repo.get_with_lines(invoice.id)
        after = _invoice_snapshot(invoice)

        doc = await self._document_repo.get_or_raise(document_id)
        doc.review_status = "in_review"

        event = ReviewEvent(
            invoice_id=invoice.id,
            reviewer_id=reviewer_id,
            event_type="save",
            value_before=before,
            value_after=after,
            note=note,
        )
        self._session.add(event)
        await self._session.flush()

        log.info(
            "review_saved",
            document_id=str(document_id),
            invoice_id=str(invoice.id),
            reviewer=str(reviewer_id),
            line_count=len(payload.line_items),
        )
        return event

    async def approve(self, invoice_id: uuid.UUID, reviewer_id: uuid.UUID) -> ReviewEvent:
        invoice = await self._invoice_repo.get_or_raise(invoice_id)
        doc = await self._document_repo.get_or_raise(invoice.document_id)
        doc.review_status = "approved"

        event = ReviewEvent(
            invoice_id=invoice_id,
            reviewer_id=reviewer_id,
            event_type="approve",
        )
        self._session.add(event)
        await self._session.flush()

        log.info("review_approved", invoice_id=str(invoice_id), reviewer=str(reviewer_id))
        return event

    async def reject(
        self, invoice_id: uuid.UUID, reviewer_id: uuid.UUID, note: str | None = None
    ) -> ReviewEvent:
        invoice = await self._invoice_repo.get_or_raise(invoice_id)
        doc = await self._document_repo.get_or_raise(invoice.document_id)
        doc.review_status = "rejected"

        event = ReviewEvent(
            invoice_id=invoice_id,
            reviewer_id=reviewer_id,
            event_type="reject",
            note=note,
        )
        self._session.add(event)
        await self._session.flush()

        log.info("review_rejected", invoice_id=str(invoice_id), reviewer=str(reviewer_id))
        return event
