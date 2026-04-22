"""
GL Codes API — saved chart-of-accounts catalogs.

Each row of `gl_catalogs` is one user-edited definition of a chart of
accounts. Endpoints:

  * GET    /gl-catalogs                          — list summaries
  * GET    /gl-catalogs/defaults/canonical       — built-in default
                                                  catalog (not
                                                  persisted; the
                                                  frontend uses it
                                                  as a starter draft)
  * POST   /gl-catalogs/parse-upload             — parse a csv/xlsx
                                                  upload and return
                                                  inferred entries.
                                                  The file is NOT
                                                  stored — the catalog
                                                  the user creates from
                                                  the entries is the
                                                  authoritative artifact.
  * POST   /gl-catalogs                          — create new
  * GET    /gl-catalogs/{id}                     — get full catalog
  * PATCH  /gl-catalogs/{id}                     — partial update
  * DELETE /gl-catalogs/{id}                     — drop the row

The shape mirrors `invoice_templates.py` deliberately so the two
builder pages (templates + GL catalogs) feel like siblings to both
the frontend and the engineers reading the code. The only structural
addition here is `parse-upload`, which doesn't have an analogue on the
template side because invoice templates seed their columns from a
persistent reference file (the import_template slot) rather than from
a one-shot upload.

Why parse-upload instead of a new ReferenceKind:
  * GL chart files act as STARTING POINTS for the user's editable
    catalog — the catalog is the artifact, not the file. Persisting the
    file separately would create a confusing two-source-of-truth
    situation where editing the catalog drifts from the original.
  * It also avoids polluting the reference_data table, which is sized
    for small inspectable lookups (sample_rows etc.), with potentially
    huge full chart-of-accounts payloads.
"""

import uuid

from fastapi import APIRouter, File, HTTPException, Response, UploadFile, status

from app.config import settings
from app.dependencies import DB, CurrentUser
from app.domain.gl_upload_parse import (
    ALLOWED_MIME_TYPES,
    GLUploadParseError,
    parse_gl_upload,
)
from app.models.gl_catalog import GLCatalog
from app.repositories.gl_catalog_repo import GLCatalogRepository
from app.schemas.gl_catalog import (
    GLCatalogCreate,
    GLCatalogDefault,
    GLCatalogList,
    GLCatalogOut,
    GLCatalogSummary,
    GLCatalogUpdate,
    ParsedGLUpload,
    build_default_catalog,
)

router = APIRouter(prefix="/gl-catalogs", tags=["gl-catalogs"])


def _user_uuid(user: dict) -> uuid.UUID | None:
    """Best-effort extract the user id from the JWT payload.

    Stored as a "who created this" audit hint with no FK constraint, so
    a missing / malformed claim becomes None rather than rejecting the
    create. Matches `invoice_templates._user_uuid`.
    """
    sub = user.get("sub") or user.get("user_id") or user.get("id")
    if not sub:
        return None
    try:
        return uuid.UUID(str(sub))
    except (ValueError, TypeError):
        return None


def _to_summary(row: GLCatalog) -> GLCatalogSummary:
    return GLCatalogSummary(
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


@router.get("/defaults/canonical", response_model=GLCatalogDefault)
async def get_default_catalog(user: CurrentUser) -> GLCatalogDefault:
    """Return the built-in default catalog (pure read — not persisted).

    The frontend uses this as the starting editable shape when the user
    has no saved catalogs yet. Saving the draft promotes it to a real
    row whose entries are then independent of this constant.
    """
    return build_default_catalog()


# ---------------------------------------------------------------------------
# Parse-upload — one-shot parse with NO persistence
# ---------------------------------------------------------------------------


@router.post("/parse-upload", response_model=ParsedGLUpload)
async def parse_gl_upload_endpoint(
    user: CurrentUser,
    file: UploadFile = File(...),
) -> ParsedGLUpload:
    """
    Parse a GL chart upload and return the inferred entries.

    Workflow:
      1. Validate non-empty + size-within-cap (re-uses MAX_FILE_SIZE_MB).
      2. Reject obvious mime mismatches (allows octet-stream + falls
         back to the filename extension, same as reference_data).
      3. Run the parser. Hard failures (unsupported format, undecodable
         bytes) raise 422; soft failures (no header found, no usable
         rows) come back as a 200 with an empty entries list and
         `parse_warning` explaining what happened.

    The file itself is NOT stored — the user is expected to review the
    returned entries, edit them, and save a real catalog with
    `source="from_upload"`. If the user closes the modal without
    saving, the upload is gone.
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

    # Soft mime check — same logic as reference upload. Browsers send
    # inconsistent content-types for spreadsheets, so we also accept
    # anything whose filename ends in a supported extension.
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
        return parse_gl_upload(raw_bytes, filename, mime_type)
    except GLUploadParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=GLCatalogList)
async def list_gl_catalogs(
    db: DB,
    user: CurrentUser,
    limit: int = 50,
    offset: int = 0,
) -> GLCatalogList:
    """List saved catalogs newest-first by `updated_at`.

    Lightweight payload — entry_count instead of the full entries
    array. The detail response (with the full entries) is a per-catalog
    round-trip on selection.
    """
    repo = GLCatalogRepository(db)
    rows = await repo.list_recent(limit=limit, offset=offset)
    return GLCatalogList(items=[_to_summary(r) for r in rows])


@router.post(
    "",
    response_model=GLCatalogOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_gl_catalog(
    body: GLCatalogCreate,
    db: DB,
    user: CurrentUser,
) -> GLCatalogOut:
    """Create a new saved catalog."""
    repo = GLCatalogRepository(db)
    row = GLCatalog(
        name=body.name,
        description=body.description,
        # Pydantic entries → list of dicts for JSONB. `mode="json"`
        # keeps us strict about serialisable shapes.
        entries=[e.model_dump(mode="json") for e in body.entries],
        source=body.source,
        created_by=_user_uuid(user),
    )
    row = await repo.save(row)
    return GLCatalogOut.model_validate(row)


@router.get("/{catalog_id}", response_model=GLCatalogOut)
async def get_gl_catalog(
    catalog_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> GLCatalogOut:
    """Return a saved catalog (full entries array)."""
    repo = GLCatalogRepository(db)
    row = await repo.get(catalog_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="GL catalog not found"
        )
    return GLCatalogOut.model_validate(row)


@router.patch("/{catalog_id}", response_model=GLCatalogOut)
async def update_gl_catalog(
    catalog_id: uuid.UUID,
    body: GLCatalogUpdate,
    db: DB,
    user: CurrentUser,
) -> GLCatalogOut:
    """Apply a partial update.

    Only fields the caller actually sent are applied (we use
    `model_dump(exclude_unset=True)`). To clear the description, PATCH
    with `description: null`. Sending `entries` REPLACES the array
    outright — the frontend always sends the full new ordered list.
    """
    repo = GLCatalogRepository(db)
    row = await repo.get(catalog_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="GL catalog not found"
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
    return GLCatalogOut.model_validate(row)


@router.delete("/{catalog_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_gl_catalog(
    catalog_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> Response:
    """Delete a saved catalog. 404 if it doesn't exist."""
    repo = GLCatalogRepository(db)
    row = await repo.get(catalog_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="GL catalog not found"
        )
    await repo.delete(row)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
