import uuid

import structlog
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.workers.celery_app import celery_app

log = structlog.get_logger()

_sync_engine = create_engine(settings.DATABASE_SYNC_URL, pool_pre_ping=True)
_SyncSession = sessionmaker(bind=_sync_engine, autoflush=False)


@celery_app.task(name="tasks.update_vendor_pattern")
def update_vendor_pattern(invoice_id: str) -> dict:
    """Derive vendor extraction hints from a freshly approved invoice."""
    import re

    from app.models.invoice import Invoice
    from app.models.review_event import ReviewEvent
    from app.models.vendor_pattern import VendorPattern

    log.info("task_update_vendor_pattern_started", invoice_id=invoice_id)
    inv_uuid = uuid.UUID(invoice_id)

    with _SyncSession() as session:
        invoice = session.get(Invoice, inv_uuid)
        if invoice is None:
            return {"status": "not_found"}

        events = (
            session.query(ReviewEvent)
            .filter_by(invoice_id=inv_uuid)
            .order_by(ReviewEvent.created_at)
            .all()
        )

        normalized = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", "", invoice.vendor_name.lower().strip()))
        pattern = session.query(VendorPattern).filter_by(vendor_name_normalized=normalized).first()

        field_hints: dict = {}
        for event in events:
            if event.event_type == "field_edit" and event.field_name and event.value_after:
                field_hints[event.field_name] = event.value_after.get("value")

        for attr in ("vendor_name", "account_number", "invoice_type", "utility_type"):
            val = getattr(invoice, attr, None)
            if val:
                field_hints[attr] = val

        if pattern is None:
            pattern = VendorPattern(
                vendor_name_normalized=normalized,
                vendor_name_display=invoice.vendor_name,
                field_hints=field_hints,
                confidence_score=min(len(field_hints) * 0.1, 1.0),
                sample_count=1,
            )
            session.add(pattern)
        else:
            pattern.field_hints = {**pattern.field_hints, **field_hints}
            pattern.sample_count += 1
            pattern.confidence_score = min(pattern.sample_count * 0.1, 1.0)

        session.commit()

    log.info("task_update_vendor_pattern_done", invoice_id=invoice_id, vendor=normalized)
    return {"status": "updated", "vendor": normalized}
