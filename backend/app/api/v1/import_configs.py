"""
Import Builder API.

Saved presets describing how the future ResMan-ready import should be
shaped (per-template-column role overrides + how many preview rows to
render). Each preset can be created, listed, opened (with a freshly-
computed preview against the CURRENT reference uploads), edited, and
deleted.

Detail responses bundle `config + preview` together — opening a saved
config in the workspace is a single round-trip and the rendered preview
always reflects the live state of the world (current uploads + current
approved invoices), not a stale snapshot.
"""

import uuid
from typing import cast

from fastapi import APIRouter, HTTPException, Response, status

from app.dependencies import DB, CurrentUser
from app.models.import_config import ImportConfig
from app.repositories.import_config_repo import ImportConfigRepository
from app.schemas.import_config import (
    ImportConfigCreate,
    ImportConfigDetail,
    ImportConfigList,
    ImportConfigOut,
    ImportConfigSummary,
    ImportConfigUpdate,
)
from app.services.import_preview import render_preview

router = APIRouter(prefix="/import-configs", tags=["import-configs"])


def _user_uuid(user: dict) -> uuid.UUID | None:
    """Best-effort extract the user id from the JWT payload.

    Stored as a "who created this" audit hint with no FK constraint, so
    a missing/malformed claim just becomes None rather than rejecting
    the create.
    """
    sub = user.get("sub") or user.get("user_id") or user.get("id")
    if not sub:
        return None
    try:
        return uuid.UUID(str(sub))
    except (ValueError, TypeError):
        return None


def _to_summary(row: ImportConfig) -> ImportConfigSummary:
    return ImportConfigSummary(
        id=row.id,
        name=row.name,
        description=row.description,
        row_limit=row.row_limit,
        override_count=len(row.column_role_overrides or {}),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _detail_response(db, row: ImportConfig) -> ImportConfigDetail:
    """Bundle the config row with a freshly-computed preview.

    The preview always renders against the CURRENT reference uploads
    and approved invoices — so opening a saved config never surfaces a
    stale view of the world.
    """
    preview = await render_preview(
        db,
        row_limit=row.row_limit,
        column_role_overrides=cast(dict[str, str], row.column_role_overrides or {}),
    )
    return ImportConfigDetail(
        config=ImportConfigOut.model_validate(row),
        preview=preview,
    )


@router.get("", response_model=ImportConfigList)
async def list_import_configs(
    db: DB,
    user: CurrentUser,
    limit: int = 50,
    offset: int = 0,
) -> ImportConfigList:
    """List saved configs newest-first by `updated_at`.

    Lightweight payload — just the summary fields. The detail response
    (which computes a preview) is a per-config round-trip on selection.
    """
    repo = ImportConfigRepository(db)
    rows = await repo.list_recent(limit=limit, offset=offset)
    return ImportConfigList(items=[_to_summary(r) for r in rows])


@router.post(
    "",
    response_model=ImportConfigDetail,
    status_code=status.HTTP_201_CREATED,
)
async def create_import_config(
    body: ImportConfigCreate,
    db: DB,
    user: CurrentUser,
) -> ImportConfigDetail:
    """Create a new saved config and return it bundled with a preview.

    The preview is rendered immediately so the client opens the new
    config in the workspace without a follow-up GET.
    """
    repo = ImportConfigRepository(db)
    row = ImportConfig(
        name=body.name,
        description=body.description,
        column_role_overrides=dict(body.column_role_overrides),
        row_limit=body.row_limit,
        created_by=_user_uuid(user),
    )
    row = await repo.save(row)
    return await _detail_response(db, row)


@router.get("/{config_id}", response_model=ImportConfigDetail)
async def get_import_config(
    config_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> ImportConfigDetail:
    """Return a saved config + a freshly-computed preview for it."""
    repo = ImportConfigRepository(db)
    row = await repo.get(config_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Import config not found")
    return await _detail_response(db, row)


@router.patch("/{config_id}", response_model=ImportConfigDetail)
async def update_import_config(
    config_id: uuid.UUID,
    body: ImportConfigUpdate,
    db: DB,
    user: CurrentUser,
) -> ImportConfigDetail:
    """Apply a partial update and return the new detail (config + preview).

    Only fields the caller actually sent are applied (we use
    `model_dump(exclude_unset=True)`). To clear all role overrides,
    PATCH with `column_role_overrides: {}` explicitly. To clear the
    description, PATCH with `description: null`.
    """
    repo = ImportConfigRepository(db)
    row = await repo.get(config_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Import config not found")

    updates = body.model_dump(exclude_unset=True)
    if "name" in updates and updates["name"] is not None:
        row.name = updates["name"]
    if "description" in updates:
        # Explicit null in the body is "clear the description".
        row.description = updates["description"]
    if "column_role_overrides" in updates and updates["column_role_overrides"] is not None:
        # Replace the dict outright — this is the documented PATCH
        # semantic. Sending {} clears all overrides.
        row.column_role_overrides = dict(updates["column_role_overrides"])
    if "row_limit" in updates and updates["row_limit"] is not None:
        row.row_limit = updates["row_limit"]

    row = await repo.save(row)
    return await _detail_response(db, row)


@router.delete("/{config_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_import_config(
    config_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> Response:
    """Delete a saved config. 404 if it doesn't exist."""
    repo = ImportConfigRepository(db)
    row = await repo.get(config_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Import config not found")
    await repo.delete(row)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
