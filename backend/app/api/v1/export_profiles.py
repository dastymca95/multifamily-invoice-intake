"""
Export Profile API.

Combines:

  * **Phase 3I — diagnostic validation endpoint.**
    ``POST /api/v1/export-profiles/validate-preview`` — accepts a
    caller-supplied profile + preview, returns
    ``ExportProfileValidationResult`` with ``diagnostic_only=true``.
    No persistence, no DB lookup.

  * **Phase 4A — persisted profile catalog (CRUD).**
    ``POST   /api/v1/export-profiles``                — create
    ``GET    /api/v1/export-profiles``                — list
    ``GET    /api/v1/export-profiles/{profile_id}``   — read one
    ``PATCH  /api/v1/export-profiles/{profile_id}``   — update
    ``DELETE /api/v1/export-profiles/{profile_id}``   — soft-delete
    ``GET    /api/v1/export-profiles/{profile_id}/contract``
        — return the persisted profile projected into the existing
          Phase 3I ``ExportProfile`` validation contract so a future
          caller can validate a preview against a saved profile id
          without inlining the full payload.

Both layers are read-only with respect to documents / batches /
templates / Review Queue / export records / external systems.
Phase 3O's regression test suite asserts that none of these
endpoints expose forbidden export / file / posting handles.

Hard contract:
  * No file generation (CSV / XLSX / PDF / anything).
  * No download.
  * No export records, no export run, no export batch, no audit row.
  * No document / batch / template status mutation.
  * No external posting.
  * No OCR / AI.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Response, status

from app.dependencies import DB, CurrentUser
from app.schemas.export_profile import (
    ExportProfile,
    ExportProfileValidationRequest,
    ExportProfileValidationResult,
)
from app.schemas.export_profile_persistence import (
    ExportProfileCreate,
    ExportProfileListResponse,
    ExportProfileRead,
    ExportProfileSummary,
    ExportProfileUpdate,
)
from app.services.export_profile_management import (
    ExportProfileNotFoundError,
    ExportProfileValidationError,
    create_export_profile,
    delete_export_profile,
    get_export_profile,
    get_export_profile_contract,
    list_export_profiles,
    update_export_profile,
)
from app.services.export_profile_validation import (
    validate_export_preview_against_profile,
)


router = APIRouter(
    prefix="/export-profiles",
    tags=["export-profiles"],
)


# ---------------------------------------------------------------------------
# Phase 3I — Diagnostic validate-preview (preserved verbatim)
# ---------------------------------------------------------------------------
#
# Declared FIRST so FastAPI's path matcher doesn't accidentally try
# to parse "validate-preview" as a UUID for the
# ``GET /export-profiles/{profile_id}`` route added below.


@router.post(
    "/validate-preview",
    response_model=ExportProfileValidationResult,
)
async def validate_export_profile_preview(
    body: ExportProfileValidationRequest,
    user: CurrentUser,
) -> ExportProfileValidationResult:
    """Validate the supplied preview rows against the supplied profile.

    Diagnostic only — the response always carries
    ``diagnostic_only=True`` regardless of what the caller sets on
    the request. No file is generated, no profile is persisted, no
    export record is created, and nothing is mutated. The caller
    supplies the profile in-line; there is no DB lookup.
    """
    result = validate_export_preview_against_profile(
        profile=body.profile,
        preview=body.preview,
    )
    if body.context is not None:
        result.context = body.context
    result.diagnostic_only = True
    return result


# ---------------------------------------------------------------------------
# Phase 4A — Persisted profile CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=ExportProfileListResponse)
async def list_export_profile_records(
    db: DB,
    user: CurrentUser,
    target_system: str | None = None,
    is_active: bool | None = True,
    limit: int = 50,
    offset: int = 0,
) -> ExportProfileListResponse:
    """List persisted profiles newest-first by ``updated_at``.

    Filters:
      * ``target_system`` — narrow to one of the closed Phase 3I
        target systems. Invalid values yield 422 (raised by the
        management service so a typo doesn't silently return zero
        rows).
      * ``is_active`` — defaults to ``True``. Pass ``false`` to
        list soft-deleted rows; pass an empty value via the URL
        (``is_active=`` is normalized to ``None`` by FastAPI) to
        include both. Phase 4A keeps the default biased toward
        active rows so the catalog UI doesn't have to remember to
        filter.
    """
    try:
        rows = await list_export_profiles(
            db,
            target_system=target_system,
            is_active=is_active,
            limit=limit,
            offset=offset,
        )
    except ExportProfileValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    items = [ExportProfileSummary.model_validate(r) for r in rows]
    return ExportProfileListResponse(items=items)


@router.post(
    "",
    response_model=ExportProfileRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_export_profile_record(
    body: ExportProfileCreate,
    db: DB,
    user: CurrentUser,
) -> ExportProfileRead:
    """Create a new persisted profile.

    The ``settings`` and ``columns`` payloads are re-validated
    through the existing Phase 3I ``ExportProfileSettings`` /
    ``ExportProfileColumn`` types BEFORE persistence — anything
    that doesn't match the contract surfaces as 422. Column keys
    must be unique within a profile.

    No DB persistence beyond the row itself, no export records,
    no file generation. ``profile_id`` returned in the response is
    a CRUD identifier, NOT an export id (see Phase 3O contract
    test for the forbidden-key audit).
    """
    user_id = _user_id_from_token(user)
    try:
        record = await create_export_profile(db, body, user_id=user_id)
    except ExportProfileValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ExportProfileRead.model_validate(record)


@router.get(
    "/{profile_id}",
    response_model=ExportProfileRead,
)
async def get_export_profile_record(
    profile_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> ExportProfileRead:
    """Return one persisted profile, including soft-deleted rows so
    an admin can re-activate via PATCH."""
    try:
        record = await get_export_profile(db, profile_id)
    except ExportProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return ExportProfileRead.model_validate(record)


@router.get(
    "/{profile_id}/contract",
    response_model=ExportProfile,
)
async def get_export_profile_record_contract(
    profile_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> ExportProfile:
    """Return the persisted profile projected into the existing
    Phase 3I ``ExportProfile`` validation contract.

    Useful for a future caller that wants to validate a preview
    against a saved profile id by routing through the existing
    ``validate-preview`` endpoint without copying the persisted
    payload into the request body. The conversion is pure — it
    does not mutate the row, log anything, or trigger any export
    side effect.
    """
    try:
        return await get_export_profile_contract(db, profile_id)
    except ExportProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ExportProfileValidationError as exc:
        # Persisted payload no longer matches the Phase 3I contract
        # (e.g. the contract was tightened after the row was saved).
        # 422 surfaces the mismatch verbatim so an operator can
        # PATCH the row to bring it back into compliance.
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch(
    "/{profile_id}",
    response_model=ExportProfileRead,
)
async def update_export_profile_record(
    profile_id: uuid.UUID,
    body: ExportProfileUpdate,
    db: DB,
    user: CurrentUser,
) -> ExportProfileRead:
    """Apply a partial update.

    Sending ``settings`` or ``columns`` REPLACES the JSONB value
    outright AND increments the row's ``version``. Pure metadata
    edits (name, description, notes, is_active flip, is_default
    flip) leave ``version`` unchanged. Sending
    ``description: null`` explicitly clears the description.

    When ``is_default=True`` is flipped on, every OTHER active row
    on the same target system has its ``is_default`` cleared in
    the same transaction.
    """
    user_id = _user_id_from_token(user)
    try:
        record = await update_export_profile(
            db, profile_id, body, user_id=user_id
        )
    except ExportProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ExportProfileValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ExportProfileRead.model_validate(record)


@router.delete(
    "/{profile_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_export_profile_record(
    profile_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> Response:
    """Soft-delete by flipping ``is_active=False`` and clearing
    ``is_default``. Idempotent — re-deleting an already-inactive
    row is a no-op. Phase 4A does NOT expose hard delete; the row
    remains in the table so a future export run audit can refer
    to it.
    """
    user_id = _user_id_from_token(user)
    try:
        await delete_export_profile(db, profile_id, user_id=user_id)
    except ExportProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _user_id_from_token(user: dict) -> uuid.UUID | None:
    """Project the JWT ``sub`` claim into a UUID for the
    created_by_user_id / updated_by_user_id audit columns. Returns
    ``None`` when the claim is absent or not a parseable UUID — the
    soft FK accepts NULL and the row is still saved.
    """
    sub = user.get("sub") if isinstance(user, dict) else None
    if not sub:
        return None
    try:
        return uuid.UUID(str(sub))
    except (ValueError, AttributeError):
        return None
