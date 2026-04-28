"""
Phase 3A — Operational Resolution Pipeline API.

Single endpoint that runs the operational pipeline and returns the
resolver input + result + lightweight review diagnostics in one
round-trip.

  * 200 success.
  * 404 if template missing.
  * 404 if pattern_id provided and pattern missing.
  * 422 invalid payload (Pydantic).
  * No mutation, no export, no Review Queue records, no OCR / AI.

This is the foundation for future phases:
  * Phase 3B — frontend Operational Preview UI.
  * Phase 3C — connect uploaded documents/batches.
  * Phase 3D — Review Queue draft items.
  * Phase 3E — export-ready rows.
"""

from fastapi import APIRouter, HTTPException

from app.dependencies import DB, CurrentUser
from app.schemas.operational_resolution import (
    OperationalResolutionRequest,
    OperationalResolutionResult,
)
from app.services.operational_resolution import (
    OperationalResolutionNotFound,
    run_operational_resolution,
)

router = APIRouter(
    prefix="/operational-resolution",
    tags=["operational-resolution"],
)


@router.post(
    "/run",
    response_model=OperationalResolutionResult,
)
async def run_operational_resolution_endpoint(
    body: OperationalResolutionRequest,
    db: DB,
    user: CurrentUser,
) -> OperationalResolutionResult:
    """Run the operational resolution pipeline.

    Diagnostic only — no mutation of template / pattern / document /
    batch. The response carries ``diagnostic_only=True`` so a
    consumer can assert the contract at parse time before surfacing
    "this would actually export" copy.
    """
    try:
        return await run_operational_resolution(
            db,
            template_id=body.template_id,
            pattern_id=body.pattern_id,
            document_id=body.document_id,
            batch_id=body.batch_id,
            extracted_facts=body.extracted_facts,
            catalog_hints=body.catalog_hints,
            document_metadata=body.document_metadata,
            runtime_options=body.runtime_options,
            pattern_selection_mode=body.pattern_selection_mode,
            diagnostic_only=body.diagnostic_only,
        )
    except OperationalResolutionNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
