import uuid

from fastapi import APIRouter, HTTPException, Response

from app.adapters.storage.local import LocalStorageAdapter
from app.adapters.storage.s3 import S3StorageAdapter
from app.config import settings
from app.dependencies import DB, CurrentUser
from app.models.export_job import ExportJob
from app.repositories.export_job_repo import ExportJobRepository
from app.schemas.export import ExportDownloadUrl, ExportJobCreate, ExportJobOut
from app.workers.tasks_export import run_export_job

router = APIRouter(prefix="/exports", tags=["exports"])


def _get_storage():
    return S3StorageAdapter() if settings.STORAGE_BACKEND == "s3" else LocalStorageAdapter()


@router.post("", response_model=ExportJobOut, status_code=202)
async def create_export(body: ExportJobCreate, db: DB, user: CurrentUser) -> ExportJobOut:
    repo = ExportJobRepository(db)
    filters = body.filters or {}
    if body.batch_id:
        filters["batch_id"] = str(body.batch_id)

    job = ExportJob(
        batch_id=body.batch_id,
        requested_by=uuid.UUID(user["sub"]),
        format=body.format,
        filters=filters,
    )
    job = await repo.save(job)

    run_export_job.delay(str(job.id))

    return ExportJobOut.model_validate(job)


@router.get("", response_model=list[ExportJobOut])
async def list_exports(db: DB, user: CurrentUser) -> list[ExportJobOut]:
    repo = ExportJobRepository(db)
    jobs = await repo.get_by_user(uuid.UUID(user["sub"]))
    return [ExportJobOut.model_validate(j) for j in jobs]


@router.get("/{job_id}", response_model=ExportJobOut)
async def get_export(job_id: uuid.UUID, db: DB, user: CurrentUser) -> ExportJobOut:
    repo = ExportJobRepository(db)
    job = await repo.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Export job not found")
    return ExportJobOut.model_validate(job)


@router.get("/{job_id}/download-url", response_model=ExportDownloadUrl)
async def get_download_url(job_id: uuid.UUID, db: DB, user: CurrentUser) -> ExportDownloadUrl:
    repo = ExportJobRepository(db)
    job = await repo.get(job_id)
    if job is None or job.storage_key is None:
        raise HTTPException(status_code=404, detail="Export not ready or not found")
    if job.status != "completed":
        raise HTTPException(status_code=409, detail=f"Export status: {job.status}")

    storage = _get_storage()
    url = storage.presigned_url(job.storage_key, expires_in=3600)
    return ExportDownloadUrl(url=url, expires_in=3600)
