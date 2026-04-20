import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.adapters.export.csv_exporter import CsvExportAdapter
from app.adapters.export.json_exporter import JsonExportAdapter
from app.adapters.export.xlsx_exporter import XlsxExportAdapter
from app.adapters.storage.local import LocalStorageAdapter
from app.adapters.storage.s3 import S3StorageAdapter
from app.config import settings
from app.dependencies import DB, CurrentUser
from app.repositories.export_job_repo import ExportJobRepository
from app.repositories.invoice_repo import InvoiceRepository
from app.schemas.export import ExportDownloadUrl, ExportJobOut
from app.workflows.export import ExportWorkflow

router = APIRouter(prefix="/exports", tags=["exports"])


def _get_storage():
    return S3StorageAdapter() if settings.STORAGE_BACKEND == "s3" else LocalStorageAdapter()


def _build_workflow(db) -> ExportWorkflow:
    return ExportWorkflow(
        adapters={
            "csv": CsvExportAdapter(),
            "xlsx": XlsxExportAdapter(),
            "json": JsonExportAdapter(),
        },
        storage=_get_storage(),
        invoice_repo=InvoiceRepository(db),
        export_job_repo=ExportJobRepository(db),
        session=db,
    )


@router.post("/batch/{batch_id}", response_model=ExportJobOut, status_code=201)
async def create_batch_export(
    batch_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    format: Literal["csv", "xlsx", "json"] = "csv",
) -> ExportJobOut:
    """
    Generate an export for all extracted invoices in a batch and return the job
    record. Phase 1: synchronous. Use GET /exports/{id}/download-url to fetch.
    """
    wf = _build_workflow(db)
    try:
        job = await wf.run_for_batch_sync(
            batch_id=batch_id,
            format=format,
            requested_by=uuid.UUID(user["sub"]),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
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


@router.get("/{job_id}/download")
async def download_export(job_id: uuid.UUID, db: DB, user: CurrentUser) -> StreamingResponse:
    """Stream the export file directly. Works for local + S3 storage backends."""
    repo = ExportJobRepository(db)
    job = await repo.get(job_id)
    if job is None or job.storage_key is None:
        raise HTTPException(status_code=404, detail="Export not ready or not found")
    if job.status != "completed":
        raise HTTPException(status_code=409, detail=f"Export status: {job.status}")

    storage = _get_storage()
    file_obj = storage.get(job.storage_key)
    media_type = {
        "csv": "text/csv",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "json": "application/json",
    }.get(job.format, "application/octet-stream")
    filename = f"export_{job.id}.{job.format}"
    return StreamingResponse(
        file_obj,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{job_id}/download-url", response_model=ExportDownloadUrl)
async def get_download_url(job_id: uuid.UUID, db: DB, user: CurrentUser) -> ExportDownloadUrl:
    repo = ExportJobRepository(db)
    job = await repo.get(job_id)
    if job is None or job.storage_key is None:
        raise HTTPException(status_code=404, detail="Export not ready or not found")
    if job.status != "completed":
        raise HTTPException(status_code=409, detail=f"Export status: {job.status}")

    # Phase 1: prefer the streaming download endpoint over presigned URLs so the
    # local storage backend Just Works in dev. S3 callers can still hit
    # /download-url to get a presigned URL.
    if settings.STORAGE_BACKEND == "s3":
        storage = _get_storage()
        url = storage.presigned_url(job.storage_key, expires_in=3600)
    else:
        url = f"/api/v1/exports/{job.id}/download"
    return ExportDownloadUrl(url=url, expires_in=3600)
