"""
Properties API — saved property/unit master catalogs.

Each row of `property_catalogs` is one user-edited definition of the
property master table. Endpoints:

  * GET    /property-catalogs                          — list summaries
  * GET    /property-catalogs/defaults/canonical       — built-in default
                                                        catalog (not
                                                        persisted; the
                                                        frontend uses it
                                                        as a starter draft)
  * POST   /property-catalogs/parse-upload             — parse ONE csv/xlsx
                                                        upload and return
                                                        source columns +
                                                        rows + a suggested
                                                        canonical-field
                                                        mapping. The file
                                                        is NOT stored — the
                                                        catalog the user
                                                        creates from the
                                                        merged + mapped
                                                        rows is the
                                                        authoritative
                                                        artifact.
  * POST   /property-catalogs                          — create new
  * GET    /property-catalogs/{id}                     — get full catalog
  * PATCH  /property-catalogs/{id}                     — partial update
  * DELETE /property-catalogs/{id}                     — drop the row

The shape mirrors `gl_catalogs.py` and `invoice_templates.py` deliberately
so the three builder pages feel like siblings to both the frontend and the
engineers reading the code.

Multi-file uploads are orchestrated by the FRONTEND. The client posts each
file separately to `/parse-upload`, accumulates the parsed responses,
presents a per-file mapping UI, then merges all confirmed mappings into
one canonical entries list before calling `POST /property-catalogs`.
Keeping the endpoint per-file means progress / errors / retries are
per-file, not all-or-nothing — and the backend stays a thin parser, not a
multi-file integration engine.
"""

import uuid

from fastapi import APIRouter, File, HTTPException, Response, UploadFile, status
from fastapi.responses import JSONResponse

from app.config import settings
from app.dependencies import DB, CurrentUser
from app.domain.property_upload_parse import (
    ALLOWED_MIME_TYPES,
    PropertyUploadParseError,
    parse_property_upload,
)
from app.models.property_catalog import PropertyCatalog
from app.repositories.property_catalog_repo import PropertyCatalogRepository
from app.schemas.property_catalog import (
    ParsedPropertyUpload,
    PropertyCatalogCreate,
    PropertyCatalogDefault,
    PropertyCatalogList,
    PropertyCatalogOut,
    PropertyCatalogSummary,
    PropertyCatalogUpdate,
    build_default_catalog,
)
from app.schemas.dependencies import UsedByReport
from app.services.dependency_usage import get_property_catalog_usage

router = APIRouter(prefix="/property-catalogs", tags=["property-catalogs"])


def _user_uuid(user: dict) -> uuid.UUID | None:
    """Best-effort extract the user id from the JWT payload.

    Stored as a "who created this" audit hint with no FK constraint, so
    a missing / malformed claim becomes None rather than rejecting the
    create. Matches `gl_catalogs._user_uuid`.
    """
    sub = user.get("sub") or user.get("user_id") or user.get("id")
    if not sub:
        return None
    try:
        return uuid.UUID(str(sub))
    except (ValueError, TypeError):
        return None


def _to_summary(row: PropertyCatalog) -> PropertyCatalogSummary:
    return PropertyCatalogSummary(
        id=row.id,
        name=row.name,
        description=row.description,
        source=row.source,  # type: ignore[arg-type]
        entry_count=len(row.entries or []),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# ---------------------------------------------------------------------------
# Default catalog — must be declared BEFORE the {catalog_id} catch-all so
# FastAPI's matcher doesn't try to parse "defaults" as a UUID.
# ---------------------------------------------------------------------------


@router.get("/defaults/canonical", response_model=PropertyCatalogDefault)
async def get_default_catalog(user: CurrentUser) -> PropertyCatalogDefault:
    """Return the built-in default property catalog (pure read — not persisted).

    The frontend uses this as the starting editable shape when the user
    has no saved catalogs yet. Saving the draft promotes it to a real
    row whose entries are then independent of this constant.
    """
    return build_default_catalog()


# ---------------------------------------------------------------------------
# Parse-upload — one-shot per-file parse with NO persistence
# ---------------------------------------------------------------------------


@router.post("/parse-upload", response_model=ParsedPropertyUpload)
async def parse_property_upload_endpoint(
    user: CurrentUser,
    file: UploadFile = File(...),
) -> ParsedPropertyUpload:
    """
    Parse ONE property upload and return source columns + rows + a
    suggested canonical-field mapping.

    Workflow:
      1. Validate non-empty + size-within-cap (re-uses MAX_FILE_SIZE_MB).
      2. Reject obvious mime mismatches (allows octet-stream + falls
         back to the filename extension, same as reference_data and
         gl_catalogs).
      3. Run the parser. Hard failures (unsupported format, undecodable
         bytes) raise 422; soft failures (no header found, no usable
         rows) come back as a 200 with empty source columns/rows and
         `parse_warning` explaining what happened.

    Multi-file uploads are orchestrated by the frontend — call this
    endpoint once per file. The file itself is NOT stored. The user is
    expected to confirm a per-file mapping, merge results across files
    in the client, and then save a real catalog with `source="from_upload"`.
    If the user closes the modal without saving, the upload is gone.
    """
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

    # Soft mime check — same logic as reference upload + GL upload.
    # Browsers send inconsistent content-types for spreadsheets, so we
    # also accept anything whose filename ends in a supported extension.
    if mime_type not in ALLOWED_MIME_TYPES and not (
        filename.lower().endswith((".csv", ".xlsx", ".xls"))
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unsupported file type {mime_type!r}. Upload .csv or .xlsx."
            ),
        )

    try:
        return parse_property_upload(raw_bytes, filename, mime_type)
    except PropertyUploadParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=PropertyCatalogList)
async def list_property_catalogs(
    db: DB,
    user: CurrentUser,
    limit: int = 50,
    offset: int = 0,
) -> PropertyCatalogList:
    """List saved catalogs newest-first by `updated_at`.

    Lightweight payload — entry_count instead of the full entries
    array. The detail response (with the full entries) is a per-catalog
    round-trip on selection.
    """
    repo = PropertyCatalogRepository(db)
    rows = await repo.list_recent(limit=limit, offset=offset)
    return PropertyCatalogList(items=[_to_summary(r) for r in rows])


@router.post(
    "",
    response_model=PropertyCatalogOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_property_catalog(
    body: PropertyCatalogCreate,
    db: DB,
    user: CurrentUser,
) -> PropertyCatalogOut:
    """Create a new saved property catalog."""
    repo = PropertyCatalogRepository(db)
    row = PropertyCatalog(
        name=body.name,
        description=body.description,
        # Pydantic entries → list of dicts for JSONB. `mode="json"`
        # keeps us strict about serialisable shapes.
        entries=[e.model_dump(mode="json") for e in body.entries],
        source=body.source,
        created_by=_user_uuid(user),
    )
    row = await repo.save(row)
    return PropertyCatalogOut.model_validate(row)


@router.get("/{catalog_id}", response_model=PropertyCatalogOut)
async def get_property_catalog(
    catalog_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> PropertyCatalogOut:
    """Return a saved catalog (full entries array)."""
    repo = PropertyCatalogRepository(db)
    row = await repo.get(catalog_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="Property catalog not found"
        )
    return PropertyCatalogOut.model_validate(row)


@router.get("/{catalog_id}/used-by", response_model=UsedByReport)
async def get_property_catalog_used_by(
    catalog_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> UsedByReport:
    """Return saved workflow dependencies for this property catalog."""
    repo = PropertyCatalogRepository(db)
    row = await repo.get(catalog_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="Property catalog not found"
        )
    return await get_property_catalog_usage(db, catalog_id)


@router.patch("/{catalog_id}", response_model=PropertyCatalogOut)
async def update_property_catalog(
    catalog_id: uuid.UUID,
    body: PropertyCatalogUpdate,
    db: DB,
    user: CurrentUser,
) -> PropertyCatalogOut:
    """Apply a partial update.

    Only fields the caller actually sent are applied (we use
    `model_dump(exclude_unset=True)`). To clear the description, PATCH
    with `description: null`. Sending `entries` REPLACES the array
    outright — the frontend always sends the full new ordered list.
    """
    repo = PropertyCatalogRepository(db)
    row = await repo.get(catalog_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="Property catalog not found"
        )

    updates = body.model_dump(exclude_unset=True)
    if "name" in updates and updates["name"] is not None:
        row.name = updates["name"]
    if "description" in updates:
        # Explicit null in the body is "clear the description".
        row.description = updates["description"]
    if "entries" in updates and updates["entries"] is not None:
        # Replace outright — see schema docstring.
        row.entries = list(updates["entries"])

    row = await repo.save(row)
    return PropertyCatalogOut.model_validate(row)


@router.delete("/{catalog_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_property_catalog(
    catalog_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> Response:
    """Delete a saved catalog. 404 if it doesn't exist."""
    repo = PropertyCatalogRepository(db)
    row = await repo.get(catalog_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="Property catalog not found"
        )
    used_by = await get_property_catalog_usage(db, catalog_id)
    if used_by.blocking_count > 0:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={
                "detail": "Resource is still in use.",
                "used_by": used_by.model_dump(mode="json"),
            },
        )
    await repo.delete(row)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
