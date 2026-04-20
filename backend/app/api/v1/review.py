import uuid

from fastapi import APIRouter, HTTPException

from app.dependencies import DB, CurrentUser
from app.repositories.document_repo import DocumentRepository
from app.repositories.invoice_repo import InvoiceRepository
from app.repositories.review_repo import ReviewRepository
from app.schemas.invoice import InvoiceFieldEdit, InvoiceOut
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
            Document.review_status == "pending",
        )
        .options(selectinload(Invoice.lines))
        .order_by(Document.created_at.asc())
        .limit(limit)
    )
    invoices = list(result.scalars().all())
    return [InvoiceOut.model_validate(inv) for inv in invoices]


@router.get("/{invoice_id}", response_model=InvoiceOut)
async def get_invoice_for_review(invoice_id: uuid.UUID, db: DB, user: CurrentUser) -> InvoiceOut:
    repo = InvoiceRepository(db)
    invoice = await repo.get_with_lines(invoice_id)
    if invoice is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return InvoiceOut.model_validate(invoice)


@router.patch("/{invoice_id}/fields", response_model=ReviewEventOut)
async def edit_field(
    invoice_id: uuid.UUID,
    body: InvoiceFieldEdit,
    db: DB,
    user: CurrentUser,
) -> ReviewEventOut:
    wf = _workflow(db)
    event = await wf.apply_field_edit(
        invoice_id=invoice_id,
        reviewer_id=uuid.UUID(user["sub"]),
        field_name=body.field_name,
        new_value=body.new_value,
        note=body.note,
    )
    return ReviewEventOut.model_validate(event)


@router.post("/{invoice_id}/approve", response_model=ReviewEventOut)
async def approve_invoice(
    invoice_id: uuid.UUID,
    body: ApproveRequest,
    db: DB,
    user: CurrentUser,
) -> ReviewEventOut:
    wf = _workflow(db)
    event = await wf.approve(invoice_id, uuid.UUID(user["sub"]))

    # Trigger async vendor pattern learning
    from app.workers.tasks_vendor import update_vendor_pattern
    update_vendor_pattern.delay(str(invoice_id))

    return ReviewEventOut.model_validate(event)


@router.post("/{invoice_id}/reject", response_model=ReviewEventOut)
async def reject_invoice(
    invoice_id: uuid.UUID,
    body: RejectRequest,
    db: DB,
    user: CurrentUser,
) -> ReviewEventOut:
    wf = _workflow(db)
    event = await wf.reject(invoice_id, uuid.UUID(user["sub"]), body.note)
    return ReviewEventOut.model_validate(event)


@router.get("/{invoice_id}/history", response_model=list[ReviewEventOut])
async def review_history(invoice_id: uuid.UUID, db: DB, user: CurrentUser) -> list[ReviewEventOut]:
    repo = ReviewRepository(db)
    events = await repo.get_for_invoice(invoice_id)
    return [ReviewEventOut.model_validate(e) for e in events]
