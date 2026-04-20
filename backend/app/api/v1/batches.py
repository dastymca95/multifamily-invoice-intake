import uuid

from fastapi import APIRouter, HTTPException, status

from app.dependencies import DB, CurrentUser
from app.models.batch import Batch
from app.repositories.batch_repo import BatchRepository
from app.repositories.document_repo import DocumentRepository
from app.schemas.batch import BatchCreate, BatchOut
from app.schemas.document import DocumentOut

router = APIRouter(prefix="/batches", tags=["batches"])


@router.post("", response_model=BatchOut, status_code=status.HTTP_201_CREATED)
async def create_batch(body: BatchCreate, db: DB, user: CurrentUser) -> BatchOut:
    repo = BatchRepository(db)
    batch = Batch(
        name=body.name,
        description=body.description,
        created_by=uuid.UUID(user["sub"]),
    )
    batch = await repo.save(batch)
    return BatchOut.model_validate(batch)


@router.get("", response_model=list[BatchOut])
async def list_batches(db: DB, user: CurrentUser, limit: int = 50, offset: int = 0) -> list[BatchOut]:
    repo = BatchRepository(db)
    batches = await repo.get_by_user(uuid.UUID(user["sub"]), limit=limit, offset=offset)
    return [BatchOut.model_validate(b) for b in batches]


@router.get("/{batch_id}", response_model=BatchOut)
async def get_batch(batch_id: uuid.UUID, db: DB, user: CurrentUser) -> BatchOut:
    repo = BatchRepository(db)
    batch = await repo.get(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    return BatchOut.model_validate(batch)


@router.get("/{batch_id}/documents", response_model=list[DocumentOut])
async def list_batch_documents(
    batch_id: uuid.UUID, db: DB, user: CurrentUser, limit: int = 100, offset: int = 0
) -> list[DocumentOut]:
    repo = DocumentRepository(db)
    docs = await repo.get_by_batch(batch_id, limit=limit, offset=offset)
    return [DocumentOut.model_validate(d) for d in docs]
