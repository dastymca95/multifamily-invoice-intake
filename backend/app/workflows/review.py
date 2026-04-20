"""
Review workflow: record user corrections, update invoice fields, and
update document review status.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

import structlog

from app.models.invoice import Invoice
from app.models.review_event import ReviewEvent
from app.repositories.document_repo import DocumentRepository
from app.repositories.invoice_repo import InvoiceRepository
from app.repositories.review_repo import ReviewRepository

log = structlog.get_logger()

_EDITABLE_HEADER_FIELDS = {
    "vendor_name", "vendor_address", "vendor_tax_id", "bill_to_name", "bill_to_address",
    "property_name", "property_code", "invoice_number", "invoice_date", "due_date",
    "service_period_start", "service_period_end", "payment_terms", "subtotal",
    "tax_amount", "total_amount", "currency", "invoice_type", "utility_type",
    "account_number", "meter_number",
}


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

    async def apply_field_edit(
        self,
        invoice_id: uuid.UUID,
        reviewer_id: uuid.UUID,
        field_name: str,
        new_value: Any,
        note: str | None = None,
    ) -> ReviewEvent:
        if field_name not in _EDITABLE_HEADER_FIELDS:
            raise ValueError(f"Field '{field_name}' is not editable via the review API")

        invoice = await self._invoice_repo.get_or_raise(invoice_id)
        old_value = getattr(invoice, field_name)

        setattr(invoice, field_name, new_value)

        event = ReviewEvent(
            invoice_id=invoice_id,
            reviewer_id=reviewer_id,
            event_type="field_edit",
            field_name=field_name,
            value_before={"value": str(old_value) if old_value is not None else None},
            value_after={"value": str(new_value) if new_value is not None else None},
            note=note,
        )
        self._session.add(event)
        await self._session.flush()

        log.info(
            "review_field_edited",
            invoice_id=str(invoice_id),
            field=field_name,
            reviewer=str(reviewer_id),
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
