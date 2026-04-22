"""
Reference Data API.

Stores and inspects the four ResMan reference files (Property report,
Unit report, Vendor report, default invoice import template). Single
row per kind — re-uploading a kind replaces the stored file and the
parsed summary in place.

Endpoints:
  * GET    /reference-data                — list all four kinds (always
                                            returns 4 slots, `current`
                                            is null for empty ones)
  * POST   /reference-data/{kind}/upload  — upload / replace
  * DELETE /reference-data/{kind}         — drop a kind's stored file

Storage layout: `reference/{kind}/{checksum[:8]}_{original_filename}`,
served by the same StorageAdapter as documents.

Why this lives separately from `documents.py`: documents are user-uploaded
*invoices* that flow through extraction + review. Reference files are
*lookups* the export pipeline will consult later — different lifecycle,
different surface, different access patterns. Mixing them in one router
would force every endpoint to multiplex on a `kind` discriminator.
"""

import hashlib
import io
import uuid
from typing import cast

from fastapi import APIRouter, File, HTTPException, Response, UploadFile, status

from app.adapters.storage.base import StorageAdapter
from app.adapters.storage.local import LocalStorageAdapter
from app.adapters.storage.s3 import S3StorageAdapter
from app.config import settings
from app.dependencies import DB, CurrentUser
from app.domain.reference_parse import (
    ALLOWED_MIME_TYPES,
    REFERENCE_KINDS,
    ReferenceParseError,
    parse_reference_file,
)
from app.domain.resman_preview import DEFAULT_PREVIEW_ROW_LIMIT
from app.models.reference_file import ReferenceFile
from app.repositories.reference_file_repo import ReferenceFileRepository
from app.schemas.reference import (
    REFERENCE_LABELS,
    ReferenceFileOut,
    ReferenceKindLiteral,
    ReferenceListResponse,
    ReferenceSlot,
)
from app.schemas.resman_preview import ResmanPreviewResponse
from app.services.import_preview import render_preview

router = APIRouter(prefix="/reference-data", tags=["reference-data"])


def _get_storage() -> StorageAdapter:
    if settings.STORAGE_BACKEND == "s3":
        return S3StorageAdapter()
    return LocalStorageAdapter()


def _validate_kind(kind: str) -> ReferenceKindLiteral:
    if kind not in REFERENCE_KINDS:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Unknown reference kind {kind!r}. "
                f"Valid kinds: {', '.join(REFERENCE_KINDS)}."
            ),
        )
    return cast(ReferenceKindLiteral, kind)


def _user_uuid(user: dict) -> uuid.UUID | None:
    """Best-effort extract the user id from the JWT payload.

    Stored on the row purely as a "who replaced this last" audit hint —
    no FK constraint, so a missing/malformed claim just becomes None
    rather than rejecting the upload.
    """
    sub = user.get("sub") or user.get("user_id") or user.get("id")
    if not sub:
        return None
    try:
        return uuid.UUID(str(sub))
    except (ValueError, TypeError):
        return None


@router.get("", response_model=ReferenceListResponse)
async def list_reference_data(db: DB, user: CurrentUser) -> ReferenceListResponse:
    """
    Return one slot per known kind, populated with the current file (if any).

    Always returns exactly len(REFERENCE_KINDS) slots in the canonical
    order so the UI can render placeholders for kinds that haven't been
    uploaded yet without a separate lookup.
    """
    repo = ReferenceFileRepository(db)
    rows = await repo.list_all()
    by_kind: dict[str, ReferenceFile] = {r.kind: r for r in rows}

    slots: list[ReferenceSlot] = []
    for kind in REFERENCE_KINDS:
        label, description = REFERENCE_LABELS[kind]
        row = by_kind.get(kind)
        slots.append(
            ReferenceSlot(
                kind=cast(ReferenceKindLiteral, kind),
                label=label,
                description=description,
                current=ReferenceFileOut.model_validate(row) if row else None,
            )
        )
    return ReferenceListResponse(slots=slots)


@router.post(
    "/{kind}/upload",
    response_model=ReferenceFileOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_reference_file(
    kind: str,
    db: DB,
    user: CurrentUser,
    file: UploadFile = File(...),
) -> ReferenceFileOut:
    """
    Upload (or replace) the reference file for a kind.

    Workflow:
        1. Validate the kind is one we know about.
        2. Read bytes; reject empties and oversize files (re-uses the
           same MAX_FILE_SIZE_MB ceiling as document ingest so the
           storage backend never sees anything bigger).
        3. Parse the bytes (.csv / .xlsx) — header + row count + sample.
           Parse failures DON'T abort: we still store the bytes with
           parse_status="parse_failed" so the user can see what they
           uploaded and why it didn't parse.
        4. Compute checksum and write to a kind-namespaced storage key.
        5. If a previous row for this kind exists, update it in place
           (and best-effort delete the old storage key). Otherwise
           insert a fresh row.
    """
    valid_kind = _validate_kind(kind)

    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=422, detail="File is empty")

    if len(raw_bytes) > settings.max_file_size_bytes:
        raise HTTPException(
            status_code=422,
            detail=(
                f"File size {len(raw_bytes)} bytes exceeds the "
                f"{settings.MAX_FILE_SIZE_MB} MB limit."
            ),
        )

    mime_type = file.content_type or "application/octet-stream"
    filename = file.filename or "unnamed"

    # Soft mime-type check — reject obvious mismatches early. We allow
    # application/octet-stream because some browsers send that for
    # spreadsheets dragged from a finder window; the parser then
    # disambiguates by extension.
    if mime_type not in ALLOWED_MIME_TYPES and not (
        filename.lower().endswith((".csv", ".xlsx", ".xls"))
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unsupported file type {mime_type!r}. Upload .csv or .xlsx."
            ),
        )

    # Parse — failures don't abort, they get stored as parse_failed.
    parse_status = "parsed"
    parse_error: str | None = None
    columns: list[str] | None = None
    row_count: int | None = None
    sample_rows: list[dict[str, str]] | None = None
    try:
        # Pass the kind so the parser can apply ResMan-aware cleaning
        # (skip metadata rows, find the real header, synthesize the
        # "Property" column for unit reports, pick the right sheet for
        # the import template). See `reference_parse._normalize_rows`.
        parsed = parse_reference_file(
            raw_bytes, filename, mime_type, kind=valid_kind
        )
        columns = parsed.columns
        row_count = parsed.row_count
        sample_rows = parsed.sample_rows
    except ReferenceParseError as exc:
        parse_status = "parse_failed"
        parse_error = str(exc)
    except Exception as exc:  # noqa: BLE001 — protect the request
        # Anything truly unexpected: still persist the bytes (the user
        # uploaded them; preserving them is the kindest behaviour) and
        # surface the error in parse_error.
        parse_status = "parse_failed"
        parse_error = f"Unexpected parser error: {exc}"

    # Compute checksum and storage key.
    checksum = hashlib.sha256(raw_bytes).hexdigest()
    storage_key = f"reference/{valid_kind}/{checksum[:8]}_{filename}"

    repo = ReferenceFileRepository(db)
    storage = _get_storage()

    existing = await repo.get_by_kind(valid_kind)
    old_storage_key: str | None = None
    # Edge case: the new file hashes identically to the existing one —
    # the storage key would collide. Append a uuid suffix so we don't
    # write-then-delete the active object.
    if existing is not None and storage_key == existing.storage_key:
        storage_key = (
            f"reference/{valid_kind}/{checksum[:8]}_"
            f"r-{uuid.uuid4().hex[:8]}_{filename}"
        )

    storage.put(storage_key, io.BytesIO(raw_bytes), mime_type)

    if existing is None:
        row = ReferenceFile(
            kind=valid_kind,
            original_filename=filename,
            storage_key=storage_key,
            mime_type=mime_type,
            file_size_bytes=len(raw_bytes),
            checksum_sha256=checksum,
            parse_status=parse_status,
            parse_error=parse_error,
            parsed_columns=columns,
            parsed_row_count=row_count,
            sample_rows=sample_rows,
            uploaded_by=_user_uuid(user),
        )
        db.add(row)
        await db.flush()
    else:
        old_storage_key = existing.storage_key
        existing.original_filename = filename
        existing.storage_key = storage_key
        existing.mime_type = mime_type
        existing.file_size_bytes = len(raw_bytes)
        existing.checksum_sha256 = checksum
        existing.parse_status = parse_status
        existing.parse_error = parse_error
        existing.parsed_columns = columns
        existing.parsed_row_count = row_count
        existing.sample_rows = sample_rows
        existing.uploaded_by = _user_uuid(user)
        await db.flush()
        row = existing

    # Best-effort cleanup of the previous object. Failure leaves an orphan
    # in storage but the DB is consistent.
    if old_storage_key and old_storage_key != row.storage_key:
        try:
            storage.delete(old_storage_key)
        except Exception:
            pass

    return ReferenceFileOut.model_validate(row)


# ---------------------------------------------------------------------------
# Preview — spreadsheet-shaped view built from template + reports + invoices
# ---------------------------------------------------------------------------
#
# Mounted at GET /reference-data/preview. Read-only. Delegates the
# orchestration (load all four reference files + recent approved
# invoices + run build_preview() + map dataclasses → Pydantic) to
# `app.services.import_preview.render_preview` so the same logic powers
# the Import Builder detail responses without divergence.
#
# This endpoint stays for callers that want the unmodified preview
# (no per-config role overrides). The Import Builder uses the same
# helper but with the saved overrides applied.


@router.get("/preview", response_model=ResmanPreviewResponse)
async def get_resman_preview(
    db: DB,
    user: CurrentUser,
    limit: int = DEFAULT_PREVIEW_ROW_LIMIT,
) -> ResmanPreviewResponse:
    """
    Return a spreadsheet-shaped preview of the future ResMan-ready
    import file (no per-config overrides applied).

    Behaviour summary:
      * If the import template isn't uploaded → empty `columns` / `rows`
        and a notes-array entry telling the user what to upload first.
      * If the template IS uploaded but no approved invoices exist →
        synthetic rows built from the reference reports' sample rows so
        the user can still see the table shape.
      * If approved invoices exist → up to `limit` of them populate the
        rows, with each cell carrying its match status + source.
    """
    return await render_preview(db, row_limit=limit)


@router.delete("/{kind}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_reference_file(
    kind: str, db: DB, user: CurrentUser
) -> Response:
    """
    Drop the reference file for a kind. 404 if nothing is stored.

    Storage is deleted best-effort first (so a storage failure leaves the
    DB row intact and the user can retry), then the row.
    """
    valid_kind = _validate_kind(kind)

    repo = ReferenceFileRepository(db)
    row = await repo.get_by_kind(valid_kind)
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"No {valid_kind} file is stored"
        )

    storage = _get_storage()
    try:
        storage.delete(row.storage_key)
    except Exception:
        # Same rationale as documents.delete: better to leave an orphan
        # in storage than to leave a row pointing at missing bytes.
        pass

    await repo.delete(row)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
