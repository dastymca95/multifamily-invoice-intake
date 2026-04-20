"""
Ingest workflow.

Validates an uploaded file, routes it, stores the original via the storage
adapter, and creates the Document record. Extraction is kicked off separately
by the API handler (sync in Phase 1, queued later).
"""

from __future__ import annotations

import hashlib
import io
import uuid
from dataclasses import dataclass
from typing import BinaryIO

import structlog

from app.adapters.storage.base import StorageAdapter
from app.config import settings
from app.domain.routing import route_document
from app.models.document import Document
from app.repositories.batch_repo import BatchRepository
from app.repositories.document_repo import DocumentRepository

log = structlog.get_logger()


class FileValidationError(ValueError):
    """Raised when an uploaded file violates size or type rules."""


@dataclass
class IngestedFile:
    document: Document
    duplicate: bool


class IngestWorkflow:
    def __init__(
        self,
        storage: StorageAdapter,
        batch_repo: BatchRepository,
        document_repo: DocumentRepository,
    ) -> None:
        self._storage = storage
        self._batch_repo = batch_repo
        self._document_repo = document_repo

    def _validate(self, raw_bytes: bytes, mime_type: str, filename: str) -> None:
        if len(raw_bytes) == 0:
            raise FileValidationError(f"{filename}: file is empty")

        max_bytes = settings.max_file_size_bytes
        if len(raw_bytes) > max_bytes:
            raise FileValidationError(
                f"{filename}: file size {len(raw_bytes)} bytes exceeds limit of "
                f"{settings.MAX_FILE_SIZE_MB} MB"
            )

        if mime_type not in settings.ALLOWED_MIME_TYPES:
            raise FileValidationError(
                f"{filename}: MIME type {mime_type!r} is not supported. "
                f"Allowed: {', '.join(settings.ALLOWED_MIME_TYPES)}"
            )

    async def ingest_file(
        self,
        batch_id: uuid.UUID,
        file: BinaryIO,
        original_filename: str,
        mime_type: str,
    ) -> IngestedFile:
        raw_bytes = file.read()
        self._validate(raw_bytes, mime_type, original_filename)

        checksum = hashlib.sha256(raw_bytes).hexdigest()

        existing = await self._document_repo.get_by_checksum(checksum)
        if existing is not None:
            log.info(
                "ingest_duplicate_skipped",
                checksum=checksum,
                existing_id=str(existing.id),
                filename=original_filename,
            )
            return IngestedFile(document=existing, duplicate=True)

        route = route_document(mime_type, raw_bytes)
        storage_key = f"documents/{batch_id}/{checksum[:8]}_{original_filename}"
        self._storage.put(storage_key, io.BytesIO(raw_bytes), mime_type)

        doc = Document(
            batch_id=batch_id,
            original_filename=original_filename,
            storage_key=storage_key,
            mime_type=mime_type,
            file_size_bytes=len(raw_bytes),
            checksum_sha256=checksum,
            route_used=route,
            extraction_status="pending",
            review_status="pending",
        )
        doc = await self._document_repo.save(doc)
        await self._batch_repo.increment_counter(batch_id, "total_documents")

        log.info(
            "ingest_document_created",
            document_id=str(doc.id),
            route=route,
            filename=original_filename,
            size_bytes=len(raw_bytes),
        )
        return IngestedFile(document=doc, duplicate=False)
