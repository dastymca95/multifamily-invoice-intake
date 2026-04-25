"""
Invoice Builder API.

Each row of `invoice_patterns` is one operator-edited visual extraction
pattern — uploaded training docs + bbox-on-page region annotations
that pin canonical extracted invoice fields to specific rectangles on
specific pages.

Endpoints:

  * GET    /invoice-patterns                       — list summaries
  * GET    /invoice-patterns/canonical-fields      — canonical
                                                     extracted-field
                                                     descriptors
                                                     (key + label;
                                                     pure read,
                                                     not persisted)
  * POST   /invoice-patterns                       — create new
  * GET    /invoice-patterns/{id}                  — get full pattern
                                                     (carries source
                                                     file data URLs +
                                                     all regions)
  * PATCH  /invoice-patterns/{id}                  — partial update
  * DELETE /invoice-patterns/{id}                  — drop the row

Why a `canonical-fields` endpoint instead of letting the frontend keep
its own copy: the canonical extracted-field universe is derived from
the `Invoice` SQLAlchemy model (single source of truth). Surfacing it
through the API stops the frontend dropdown from drifting against the
runtime extractor. Frontend caches the response on workspace open.

Design note on PATCH cross-field consistency:

  When a PATCH body contains BOTH `source_files` and `regions`, the
  Pydantic validator catches dangling region references at parse time.
  When ONE is sent, the validator can't compare against the persisted
  side; this handler re-runs the consistency check post-merge against
  the in-memory row before saving. Same pattern Import Builder uses
  for column/rule integrity.
"""

import uuid

from fastapi import APIRouter, HTTPException, Response, status

from app.dependencies import DB, CurrentUser
from app.models.invoice_pattern import InvoicePattern
from app.repositories.invoice_pattern_repo import InvoicePatternRepository
from app.repositories.invoice_template_repo import InvoiceTemplateRepository
from app.schemas.invoice_pattern import (
    InvoiceExtractedFieldsResponse,
    InvoicePatternCreate,
    InvoicePatternFieldDefinition,
    InvoicePatternFieldOptionsResponse,
    InvoicePatternList,
    InvoicePatternOut,
    InvoicePatternRegion,
    InvoicePatternSourceFile,
    InvoicePatternSummary,
    InvoicePatternUpdate,
    _check_region_file_consistency,
    build_canonical_field_descriptors,
    build_pattern_field_options,
)
from app.schemas.invoice_pattern_coverage import InvoicePatternImportCoverage
from app.services.invoice_pattern_coverage import (
    compute_pattern_import_coverage,
)

router = APIRouter(prefix="/invoice-patterns", tags=["invoice-patterns"])


def _user_uuid(user: dict) -> uuid.UUID | None:
    """Best-effort extract the user id from the JWT payload.

    Soft FK — same contract as `invoice_templates._user_uuid`.
    """
    sub = user.get("sub") or user.get("user_id") or user.get("id")
    if not sub:
        return None
    try:
        return uuid.UUID(str(sub))
    except (ValueError, TypeError):
        return None


def _to_summary(row: InvoicePattern) -> InvoicePatternSummary:
    return InvoicePatternSummary(
        id=row.id,
        name=row.name,
        description=row.description,
        vendor_hint=row.vendor_hint,
        source_file_count=len(row.source_files or []),
        region_count=len(row.regions or []),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# ---------------------------------------------------------------------------
# Canonical fields — declared BEFORE /{pattern_id} so FastAPI's path
# matcher doesn't try to parse "canonical-fields" as a UUID.
# ---------------------------------------------------------------------------


@router.get("/canonical-fields", response_model=InvoiceExtractedFieldsResponse)
async def get_canonical_extracted_fields(
    user: CurrentUser,
) -> InvoiceExtractedFieldsResponse:
    """Return the canonical extracted-field descriptors.

    Pure read — drives the region inspector dropdown on the frontend
    without the frontend having to maintain a parallel copy of the
    canonical universe.
    """
    return InvoiceExtractedFieldsResponse(
        fields=build_canonical_field_descriptors()
    )


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=InvoicePatternList)
async def list_invoice_patterns(
    db: DB,
    user: CurrentUser,
    limit: int = 50,
    offset: int = 0,
) -> InvoicePatternList:
    """List saved patterns newest-first by `updated_at`.

    Lightweight payload — summary fields only. The detail response (full
    source_files with inline data URLs + regions) is per-pattern on
    selection. Heavy data URLs never travel through the list endpoint.
    """
    repo = InvoicePatternRepository(db)
    rows = await repo.list_recent(limit=limit, offset=offset)
    return InvoicePatternList(items=[_to_summary(r) for r in rows])


@router.post(
    "",
    response_model=InvoicePatternOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_invoice_pattern(
    body: InvoicePatternCreate,
    db: DB,
    user: CurrentUser,
) -> InvoicePatternOut:
    """Create a new saved pattern.

    Both `source_files` and `regions` default to `[]` so the operator
    can name + create an empty pattern shell, then upload + draw
    inside the editor.
    """
    repo = InvoicePatternRepository(db)
    row = InvoicePattern(
        name=body.name,
        description=body.description,
        vendor_hint=body.vendor_hint,
        source_files=[f.model_dump(mode="json") for f in body.source_files],
        regions=[r.model_dump(mode="json") for r in body.regions],
        field_definitions=[
            d.model_dump(mode="json") for d in body.field_definitions
        ],
        created_by=_user_uuid(user),
    )
    row = await repo.save(row)
    return InvoicePatternOut.model_validate(row)


@router.get("/{pattern_id}", response_model=InvoicePatternOut)
async def get_invoice_pattern(
    pattern_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> InvoicePatternOut:
    """Return a saved pattern (full source_files + regions arrays)."""
    repo = InvoicePatternRepository(db)
    row = await repo.get(pattern_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="Invoice pattern not found"
        )
    return InvoicePatternOut.model_validate(row)


@router.get(
    "/{pattern_id}/fields",
    response_model=InvoicePatternFieldOptionsResponse,
)
async def get_invoice_pattern_fields(
    pattern_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> InvoicePatternFieldOptionsResponse:
    """Return the resolved field-option universe for one saved pattern.

    The Import Builder's per-cell extraction-binding picker calls this
    endpoint once per bound pattern to populate its field dropdown.
    The response is the rollup of the canonical built-in fields (as
    defined by `INVOICE_EXTRACTED_FIELDS`, optionally overridden by
    the pattern's `field_definitions`) plus any operator-coined custom
    fields living on the pattern.

    Why NOT just load the full pattern via `GET /{pattern_id}` and
    read `field_definitions`: that detail endpoint carries the pattern's
    uploaded training docs inline as base64 data URLs. For the picker
    (which needs to query fields for up to N bound patterns per rule
    cell) the source-file payload is pure waste. This lightweight
    variant stays under a kilobyte regardless of pattern size and is
    cheap to call per-pattern from the editor.

    Returns 404 if the pattern doesn't exist — same contract as the
    detail endpoint. Deleted patterns leave stale bindings on the
    rule-cell side; the editor handles that gracefully via the cached
    `pattern_label` fallback.
    """
    repo = InvoicePatternRepository(db)
    row = await repo.get(pattern_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="Invoice pattern not found"
        )
    # Parse the stored JSONB through the per-item model so malformed /
    # legacy rows surface as 422s here rather than silently corrupting
    # the picker — same defensive re-parse pattern PATCH uses for
    # regions/source files.
    parsed_defs = [
        InvoicePatternFieldDefinition.model_validate(d)
        for d in (row.field_definitions or [])
    ]
    # Region usage is folded into each option (region_count +
    # region_pages) so the Import Builder picker can show
    # "(no region drawn)" / "5 regions on pages 1, 2, 3" without doing
    # its own join. Same defensive re-parse — a malformed region row
    # surfaces here as a 422 rather than silently dropping coverage.
    parsed_regions_for_options = [
        InvoicePatternRegion.model_validate(r)
        for r in (row.regions or [])
    ]
    return InvoicePatternFieldOptionsResponse(
        pattern_id=str(row.id),
        items=build_pattern_field_options(
            parsed_defs, parsed_regions_for_options
        ),
    )


@router.get(
    "/{pattern_id}/import-coverage",
    response_model=InvoicePatternImportCoverage,
)
async def get_invoice_pattern_import_coverage(
    pattern_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    template_id: uuid.UUID | None = None,
) -> InvoicePatternImportCoverage:
    """Return Import Builder coverage for one Invoice Builder pattern.

    Coverage = which fields on the pattern are referenced by Import
    Builder template rule cells via extraction bindings, plus the
    satisfied/missing breakdown of each template's required columns.

    Query params:

      * `template_id` (optional) — filter to coverage for one specific
        Import Builder template. Omit to receive coverage for every
        saved template; templates that don't reference this pattern
        appear with empty `used_field_keys` (not omitted) so the picker
        can render the "All templates" view consistently.

    Why a single endpoint with optional filter (not two endpoints): the
    derivation cost is dominated by the per-template parse + walk; a
    single-template request and an all-templates request use the same
    `compute_pattern_import_coverage(...)` core, just over a different
    `templates` list. Two endpoints would just duplicate the wiring
    around it.

    Read-only — never mutates Import Builder mappings. The pattern row
    itself doesn't track which templates reference it; this endpoint
    derives the reverse view at read time, which keeps the two modules
    independent and avoids the dual-write integrity problems of a
    bidirectional reference.

    404 only when the pattern itself doesn't exist. A `?template_id`
    that points at a non-existent template returns an empty `templates`
    list rather than 404 — the picker handles "no such template"
    upstream and a "deleted template still referenced somewhere"
    response would be confusing to read.
    """
    pattern_repo = InvoicePatternRepository(db)
    pattern = await pattern_repo.get(pattern_id)
    if pattern is None:
        raise HTTPException(
            status_code=404, detail="Invoice pattern not found"
        )
    template_repo = InvoiceTemplateRepository(db)
    if template_id is not None:
        single = await template_repo.get(template_id)
        templates = [single] if single is not None else []
    else:
        # Generous slice — coverage walks every template's rule cells
        # but the workspace usually carries dozens, not hundreds. A
        # paginated endpoint is overkill for this denormalised read;
        # bumping the cap later is a one-liner if it ever bites.
        templates = await template_repo.list_recent(limit=500, offset=0)
    return compute_pattern_import_coverage(pattern, templates)


@router.patch("/{pattern_id}", response_model=InvoicePatternOut)
async def update_invoice_pattern(
    pattern_id: uuid.UUID,
    body: InvoicePatternUpdate,
    db: DB,
    user: CurrentUser,
) -> InvoicePatternOut:
    """Apply a partial update.

    Sending `source_files` or `regions` REPLACES the array outright
    (replace-not-merge). Omitting a field leaves the persisted value
    untouched. Send an explicit `null` to clear `description` /
    `vendor_hint`.

    When ONE of `source_files` / `regions` is sent without the other,
    we re-run the cross-field consistency check post-merge so a region
    can never reference a deleted source file (and vice versa) on the
    in-memory row.
    """
    repo = InvoicePatternRepository(db)
    row = await repo.get(pattern_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="Invoice pattern not found"
        )

    updates = body.model_dump(exclude_unset=True)
    if "name" in updates and updates["name"] is not None:
        row.name = updates["name"]
    if "description" in updates:
        # Explicit null clears the description; omission leaves it.
        row.description = updates["description"]
    if "vendor_hint" in updates:
        # Same explicit-null-clears contract as description.
        row.vendor_hint = updates["vendor_hint"]
    if "source_files" in updates and updates["source_files"] is not None:
        row.source_files = list(updates["source_files"])
    if "regions" in updates and updates["regions"] is not None:
        row.regions = list(updates["regions"])
    if (
        "field_definitions" in updates
        and updates["field_definitions"] is not None
    ):
        row.field_definitions = list(updates["field_definitions"])

    # Post-merge cross-field consistency. The Pydantic validator on
    # InvoicePatternUpdate already caught the dual-field case; here we
    # cover the asymmetric one (e.g. PATCH that drops a file but leaves
    # a region pointing at it). Re-parse via the per-item models so we
    # get the same validation as the API surface — defensively, any
    # malformed entry on disk would surface here as a 422 rather than
    # silently corrupting.
    parsed_files = [
        InvoicePatternSourceFile.model_validate(f) for f in (row.source_files or [])
    ]
    parsed_regions = [
        InvoicePatternRegion.model_validate(r) for r in (row.regions or [])
    ]
    try:
        _check_region_file_consistency(parsed_files, parsed_regions)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    row = await repo.save(row)
    return InvoicePatternOut.model_validate(row)


@router.delete("/{pattern_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_invoice_pattern(
    pattern_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
) -> Response:
    """Delete a saved pattern. 404 if it doesn't exist.

    NOTE: this does NOT scrub references in Import Builder rule cells
    (`extraction.pattern_id`). Those references become inert at runtime
    (the resolver treats an unresolvable pattern_id as "no narrowing")
    and the rule editor surfaces a "(deleted)" affordance — same
    permissive contract as the rest of the soft-FK system. A future
    cleanup pass could nullify dangling refs in batch; for Phase 1 the
    inert behavior is correct.
    """
    repo = InvoicePatternRepository(db)
    row = await repo.get(pattern_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="Invoice pattern not found"
        )
    await repo.delete(row)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
