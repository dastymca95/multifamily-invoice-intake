import uuid

from fastapi import APIRouter, HTTPException, UploadFile, status

from app.adapters.storage.local import LocalStorageAdapter
from app.adapters.storage.s3 import S3StorageAdapter
from app.config import settings
from app.dependencies import DB, CurrentUser
from app.repositories.batch_repo import BatchRepository
from app.repositories.document_repo import DocumentRepository
from app.schemas.document import DocumentOut, DocumentUploadResult
from app.workers.tasks_extraction import extract_document

router = APIRouter(prefix="/documents", tags=["documents"])


def _get_storage():
    if settings.STORAGE_BACKEND == "s3":
        return S3StorageAdapter()
    return LocalStorageAdapter()


@router.post(
    "/upload/{batch_id}",
    response_model=list[DocumentUploadResult],
    status_code=status.HTTP_202_ACCEPTED,
)
async def upload_documents(
    batch_id: uuid.UUID,
    files: list[UploadFile],
    db: DB,
    user: CurrentUser,
) -> list[DocumentUploadResult]:
    batch_repo = BatchRepository(db)
    batch = await batch_repo.get(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch not found")

    from app.workflows.ingest import IngestWorkflow

    doc_repo = DocumentRepository(db)
    storage = _get_storage()
    workflow = IngestWorkflow(storage, batch_repo, doc_repo)

    results: list[DocumentUploadResult] = []
    for upload in files:
        file_bytes = await upload.read()
        import io

        prev_checksum = None
        import hashlib

        checksum = hashlib.sha256(file_bytes).hexdigest()
        existing = await doc_repo.get_by_checksum(checksum)
        duplicate = existing is not None

        if not duplicate:
            doc = await workflow.ingest_file(
                batch_id=batch_id,
                file=io.BytesIO(file_bytes),
                original_filename=upload.filename or "unnamed",
                mime_type=upload.content_type or "application/octet-stream",
            )
            extract_document.delay(str(doc.id))
            doc_id = doc.id
            kind = doc.document_kind
        else:
            doc_id = existing.id
            kind = existing.document_kind

        results.append(
            DocumentUploadResult(
                document_id=doc_id,
                original_filename=upload.filename or "unnamed",
                document_kind=kind,
                duplicate=duplicate,
            )
        )

    return results


@router.get("/{document_id}", response_model=DocumentOut)
async def get_document(document_id: uuid.UUID, db: DB, user: CurrentUser) -> DocumentOut:
    repo = DocumentRepository(db)
    doc = await repo.get(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return DocumentOut.model_validate(doc)


@router.get("/pending-review", response_model=list[DocumentOut])
async def list_pending_review(db: DB, user: CurrentUser, limit: int = 50) -> list[DocumentOut]:
    repo = DocumentRepository(db)
    docs = await repo.get_pending_review(limit=limit)
    return [DocumentOut.model_validate(d) for d in docs]
