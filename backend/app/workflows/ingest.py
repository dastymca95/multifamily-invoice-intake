"""
Ingest workflow: accept uploaded files, store them, create Document records,
classify them, and enqueue extraction tasks.
"""

from __future__ import annotations

import hashlib
import uuid
from typing import BinaryIO

import structlog

from app.adapters.storage.base import StorageAdapter
from app.models.batch import Batch
from app.models.document import Document
from app.repositories.batch_repo import BatchRepository
from app.repositories.document_repo import DocumentRepository

log = structlog.get_logger()

_NATIVE_PDF_MIME = "application/pdf"
_IMAGE_MIMES = {"image/jpeg", "image/png", "image/tiff", "image/webp"}


def _classify_document(mime_type: str, raw_bytes: bytes) -> str:
    """
    Route a file to an extraction path.

    Native PDFs: contain a text layer — pdfplumber can extract directly.
    Scanned PDFs / images: require OCR.
    """
    if mime_type == _NATIVE_PDF_MIME:
        # A scanned PDF has very little or no text. We use a simple heuristic:
        # check for the presence of text-layer markers in the first 4 KB.
        snippet = raw_bytes[:4096]
        if b"BT" in snippet and b"ET" in snippet:
            return "native_pdf"
        return "scanned_pdf"
    if mime_type in _IMAGE_MIMES:
        return "image"
    return "unknown"


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

    async def ingest_file(
        self,
        batch_id: uuid.UUID,
        file: BinaryIO,
        original_filename: str,
        mime_type: str,
    ) -> Document:
        raw_bytes = file.read()
        checksum = hashlib.sha256(raw_bytes).hexdigest()
        file_size = len(raw_bytes)

        existing = await self._document_repo.get_by_checksum(checksum)
        if existing is not None:
            log.info("ingest_duplicate_skipped", checksum=checksum, existing_id=str(existing.id))
            return existing

        document_kind = _classify_document(mime_type, raw_bytes)
        storage_key = f"documents/{batch_id}/{checksum[:8]}_{original_filename}"

        import io
        self._storage.put(storage_key, io.BytesIO(raw_bytes), mime_type)

        doc = Document(
            batch_id=batch_id,
            original_filename=original_filename,
            storage_key=storage_key,
            mime_type=mime_type,
            file_size_bytes=file_size,
            checksum_sha256=checksum,
            document_kind=document_kind,
            extraction_status="pending",
            review_status="pending",
        )
        doc = await self._document_repo.save(doc)
        await self._batch_repo.increment_counter(batch_id, "total_documents")

        log.info(
            "ingest_document_created",
            document_id=str(doc.id),
            kind=document_kind,
            filename=original_filename,
        )
        return doc
