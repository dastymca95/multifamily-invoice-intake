import uuid

from fastapi import APIRouter, HTTPException

from app.dependencies import DB, CurrentUser
from app.domain.invoice import CanonicalInvoice, CanonicalLineItem
from app.repositories.document_repo import DocumentRepository
from app.repositories.invoice_repo import InvoiceRepository
from app.repositories.review_repo import ReviewRepository
from app.schemas.document import CanonicalInvoicePayload
from app.schemas.invoice import InvoiceOut
from app.schemas.review import ApproveRequest, RejectRequest, ReviewEventOut
from app.workflows.review import ReviewWorkflow

router = APIRouter(prefix="/review", tags=["review"])


def _workflow(db) -> ReviewWorkflow:
    return ReviewWorkflow(
        invoice_repo=InvoiceRepository(db),
        document_repo=DocumentRepository(db),
        review_repo=ReviewRepository(db),
        session=db,
    )


@router.get("/queue", response_model=list[InvoiceOut])
async def review_queue(db: DB, user: CurrentUser, limit: int = 50) -> list[InvoiceOut]:
    """Returns invoices awaiting reviewer action, ordered oldest first."""
    from sqlalchemy import select
    from sqlalchemy.orm import selectinload

    from app.models.document import Document
    from app.models.invoice import Invoice

    result = await db.execute(
        select(Invoice)
        .join(Document, Invoice.document_id == Document.id)
        .where(
            Document.extraction_status == "extracted",
            Document.review_status.in_(("pending", "in_review")),
        )
        .options(selectinload(Invoice.lines))
        .order_by(Document.created_at.asc())
        .limit(limit)
    )
    invoices = list(result.scalars().all())
    return [InvoiceOut.model_validate(inv) for inv in invoices]


@router.post("/{document_id}/save", response_model=ReviewEventOut)
async def save_review(
    document_id: uuid.UUID,
    payload: CanonicalInvoicePayload,
    db: DB,
    user: CurrentUser,
) -> ReviewEventOut:
    """
    Bulk-save reviewer corrections for the document's invoice.

    Replaces header fields and the line items wholesale and writes a single
    immutable ReviewEvent capturing before/after JSON snapshots.
    """
    canonical = CanonicalInvoice(
        document_id=document_id,
        vendor_name=payload.vendor_name or "UNKNOWN",
        vendor_address=payload.vendor_address,
        vendor_tax_id=payload.vendor_tax_id,
        bill_to_name=payload.bill_to_name,
        bill_to_address=payload.bill_to_address,
        property_name=payload.property_name,
        property_code=payload.property_code,
        invoice_number=payload.invoice_number or "UNKNOWN",
        invoice_date=payload.invoice_date,
        due_date=payload.due_date,
        service_period_start=payload.service_period_start,
        service_period_end=payload.service_period_end,
        payment_terms=payload.payment_terms,
        subtotal=payload.subtotal,
        tax_amount=payload.tax_amount,
        total_amount=payload.total_amount or 0,
        currency=payload.currency or "USD",
        invoice_type=payload.invoice_type or "unknown",
        utility_type=payload.utility_type,
        account_number=payload.account_number,
        meter_number=payload.meter_number,
        line_items=[
            CanonicalLineItem(
                line_number=li.line_number,
                description=li.description,
                quantity=li.quantity,
                unit=li.unit,
                unit_price=li.unit_price,
                amount=li.amount,
                gl_code=li.gl_code,
            )
            for li in payload.line_items
        ],
    )

    wf = _workflow(db)
    try:
        event = await wf.save_invoice(
            document_id=document_id,
            payload=canonical,
            reviewer_id=uuid.UUID(user["sub"]),
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return ReviewEventOut.model_validate(event)


@router.post("/{document_id}/approve", response_model=ReviewEventOut)
async def approve_invoice(
    document_id: uuid.UUID,
    body: ApproveRequest,
    db: DB,
    user: CurrentUser,
) -> ReviewEventOut:
    invoice = await InvoiceRepository(db).get_by_document(document_id)
    if invoice is None:
        raise HTTPException(status_code=404, detail="Invoice not found for document")

    wf = _workflow(db)
    event = await wf.approve(invoice.id, uuid.UUID(user["sub"]))
    return ReviewEventOut.model_validate(event)


@router.post("/{document_id}/reject", response_model=ReviewEventOut)
async def reject_invoice(
    document_id: uuid.UUID,
    body: RejectRequest,
    db: DB,
    user: CurrentUser,
) -> ReviewEventOut:
    invoice = await InvoiceRepository(db).get_by_document(document_id)
    if invoice is None:
        raise HTTPException(status_code=404, detail="Invoice not found for document")

    wf = _workflow(db)
    event = await wf.reject(invoice.id, uuid.UUID(user["sub"]), body.note)
    return ReviewEventOut.model_validate(event)


@router.get("/{invoice_id}/history", response_model=list[ReviewEventOut])
async def review_history(invoice_id: uuid.UUID, db: DB, user: CurrentUser) -> list[ReviewEventOut]:
    repo = ReviewRepository(db)
    events = await repo.get_for_invoice(invoice_id)
    return [ReviewEventOut.model_validate(e) for e in events]
