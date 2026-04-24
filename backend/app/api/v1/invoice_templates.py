"""
Invoice Template Builder API.

Each row of `invoice_templates` is one user-edited definition of the
column shape for a future ResMan invoice import. Endpoints:

  * GET    /invoice-templates                        — list summaries
  * GET    /invoice-templates/defaults/canonical     — built-in default
                                                      template (not
                                                      persisted; the
                                                      frontend uses it
                                                      as a starter
                                                      draft)
  * POST   /invoice-templates                        — create new
  * GET    /invoice-templates/{id}                   — get full template
  * PATCH  /invoice-templates/{id}                   — partial update
  * DELETE /invoice-templates/{id}                   — drop the row

Why a separate "defaults/canonical" endpoint instead of seeding a
default row in the DB on first request:

  * Seeding-on-demand creates spooky behaviour ("a row appeared after I
    opened the page once") and forces a backfill migration whenever we
    tweak the canonical column list.
  * A pure read endpoint keeps the canonical default in code — easy to
    review, easy to evolve, never out of sync.

The default endpoint is reachable WITHOUT any saved templates existing
— that's the whole point. New users land on the page, the frontend
asks for the default, and they get an editable draft instantly.
"""

import uuid

from fastapi import APIRouter, HTTPException, Response, status

from app.dependencies import DB, CurrentUser
from app.models.invoice_template import InvoiceTemplate
from app.repositories.invoice_template_repo import InvoiceTemplateRepository
from app.schemas.invoice_template import (
    InvoiceTemplateCreate,
    InvoiceTemplateDefault,
    InvoiceTemplateList,
    InvoiceTemplateOut,
    InvoiceTemplateSummary,
    InvoiceTemplateUpdate,
    build_default_template,
)

router = APIRouter(prefix="/invoice-templates", tags=["invoice-templates"])


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


def _to_summary(row: InvoiceTemplate) -> InvoiceTemplateSummary:
    return InvoiceTemplateSummary(
        id=row.id,
        name=row.name,
        description=row.description,
        source=row.source,  # type: ignore[arg-type]
        column_count=len(row.columns or []),
        # Surfaced as a small "N rules" badge in the left rail. Defaults
        # to 0 for legacy rows whose `rules` column hadn't been added at
        # save time — the migration backfills it to `[]`, so this is
        # really only defensive against an in-flight migration window.
        rule_count=len(row.rules or []),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# ---------------------------------------------------------------------------
# Default template — must be declared BEFORE the {template_id} catch-all
# so FastAPI's path matcher doesn't try to parse "defaults" as a UUID.
# ---------------------------------------------------------------------------


@router.get("/defaults/canonical", response_model=InvoiceTemplateDefault)
async def get_default_template(user: CurrentUser) -> InvoiceTemplateDefault:
    """Return the built-in default template (pure read — not persisted).

    The frontend uses this as the starting editable shape when the user
    has no saved templates yet. Saving the draft promotes it to a real
    row whose columns are then independent of this constant.
    """
    return build_default_template()


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=InvoiceTemplateList)
async def list_invoice_templates(
    db: DB,
    user: CurrentUser,
    limit: int = 50,
    offset: int = 0,
) -> InvoiceTemplateList:
    """List saved templates newest-first by `updated_at`.

    Lightweight payload — just the summary fields. The detail response
    (which carries the full columns array) is a per-template round-trip
    on selection.
    """
    repo = InvoiceTemplateRepository(db)
    rows = await repo.list_recent(limit=limit, offset=offset)
    return InvoiceTemplateList(items=[_to_summary(r) for r in rows])


@router.post(
    "",
    response_model=InvoiceTemplateOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_invoice_template(
    body: InvoiceTemplateCreate,
    db: DB,
    user: CurrentUser,
) -> InvoiceTemplateOut:
    """Create a new saved template."""
    repo = InvoiceTemplateRepository(db)
    row = InvoiceTemplate(
        name=body.name,
        description=body.description,
        # Pydantic columns → list of dicts for JSONB. `mode="json"` keeps
        # us strict about serialisable shapes (no leftover model objects).
        columns=[c.model_dump(mode="json") for c in body.columns],
        # Same shape contract for rules — list of dicts in JSONB. Empty
        # list is fine; `body.rules` defaults to `[]` so existing
        # column-only POST clients continue to work without sending
        # the new field.
        rules=[r.model_dump(mode="json") for r in body.rules],
        source=body.source,
        created_by=_user_uuid(user),
    )
    row = await repo.save(row)
    return InvoiceTemplateOut.model_validate(row)


@router.get("/{template_id}", response_model=InvoiceTemplateOut)
async def get_invoice_template(
    template_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> InvoiceTemplateOut:
    """Return a saved template (full columns array)."""
    repo = InvoiceTemplateRepository(db)
    row = await repo.get(template_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="Invoice template not found"
        )
    return InvoiceTemplateOut.model_validate(row)


@router.patch("/{template_id}", response_model=InvoiceTemplateOut)
async def update_invoice_template(
    template_id: uuid.UUID,
    body: InvoiceTemplateUpdate,
    db: DB,
    user: CurrentUser,
) -> InvoiceTemplateOut:
    """Apply a partial update.

    Only fields the caller actually sent are applied (we use
    `model_dump(exclude_unset=True)`). To clear the description, PATCH
    with `description: null`. Sending `columns` or `rules` REPLACES
    the array outright — the frontend always sends the full new
    ordered list.
    """
    repo = InvoiceTemplateRepository(db)
    row = await repo.get(template_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="Invoice template not found"
        )

    updates = body.model_dump(exclude_unset=True)
    if "name" in updates and updates["name"] is not None:
        row.name = updates["name"]
    if "description" in updates:
        # Explicit null in the body is "clear the description".
        row.description = updates["description"]
    if "columns" in updates and updates["columns"] is not None:
        # Replace outright — see schema docstring.
        row.columns = list(updates["columns"])
    if "rules" in updates and updates["rules"] is not None:
        # Same replace-not-merge contract as columns. To clear all
        # rules the client PATCHes `rules: []` (a real empty list,
        # not omitted/null). Omitting `rules` from the body leaves
        # the persisted rules untouched.
        row.rules = list(updates["rules"])

    row = await repo.save(row)
    return InvoiceTemplateOut.model_validate(row)


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_invoice_template(
    template_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> Response:
    """Delete a saved template. 404 if it doesn't exist."""
    repo = InvoiceTemplateRepository(db)
    row = await repo.get(template_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="Invoice template not found"
        )
    await repo.delete(row)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
