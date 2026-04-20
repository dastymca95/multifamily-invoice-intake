"""
Vendor pattern learning workflow.

After a reviewer approves an invoice, this workflow inspects the review_events
for that invoice to derive extraction hints (corrected field values, patterns)
and upserts a VendorPattern record. Future extractions for the same vendor
pass these hints to the extraction adapter.
"""

from __future__ import annotations

import re
import uuid

import structlog

from app.models.vendor_pattern import VendorPattern
from app.repositories.invoice_repo import InvoiceRepository
from app.repositories.review_repo import ReviewRepository
from app.repositories.vendor_pattern_repo import VendorPatternRepository

log = structlog.get_logger()


def _normalize_vendor_name(name: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    name = name.lower().strip()
    name = re.sub(r"[^a-z0-9\s]", "", name)
    name = re.sub(r"\s+", " ", name)
    return name


class VendorLearningWorkflow:
    def __init__(
        self,
        invoice_repo: InvoiceRepository,
        review_repo: ReviewRepository,
        vendor_pattern_repo: VendorPatternRepository,
        session,
    ) -> None:
        self._invoice_repo = invoice_repo
        self._review_repo = review_repo
        self._vendor_pattern_repo = vendor_pattern_repo
        self._session = session

    async def learn_from_approved_invoice(self, invoice_id: uuid.UUID) -> VendorPattern | None:
        invoice = await self._invoice_repo.get_or_raise(invoice_id)
        events = await self._review_repo.get_for_invoice(invoice_id)

        if not events:
            return None

        normalized = _normalize_vendor_name(invoice.vendor_name)
        pattern = await self._vendor_pattern_repo.get_by_vendor_name(normalized)

        field_hints: dict = {}
        for event in events:
            if event.event_type == "field_edit" and event.field_name and event.value_after:
                # Each confirmed correction is recorded as a hint for the adapter
                field_hints[event.field_name] = event.value_after.get("value")

        # Persist known-good values as strong hints
        if invoice.vendor_name:
            field_hints["vendor_name"] = invoice.vendor_name
        if invoice.account_number:
            field_hints["account_number"] = invoice.account_number
        if invoice.invoice_type:
            field_hints["invoice_type"] = invoice.invoice_type
        if invoice.utility_type:
            field_hints["utility_type"] = invoice.utility_type

        if pattern is None:
            pattern = VendorPattern(
                vendor_name_normalized=normalized,
                vendor_name_display=invoice.vendor_name,
                field_hints=field_hints,
                confidence_score=min(len(field_hints) * 0.1, 1.0),
                sample_count=1,
            )
            self._session.add(pattern)
        else:
            # Merge hints — newer confirmed values overwrite older ones
            merged = {**pattern.field_hints, **field_hints}
            pattern.field_hints = merged
            pattern.sample_count += 1
            pattern.confidence_score = min(pattern.sample_count * 0.1, 1.0)

        await self._session.flush()
        log.info(
            "vendor_pattern_updated",
            vendor=normalized,
            sample_count=pattern.sample_count,
            hint_count=len(pattern.field_hints),
        )
        return pattern
