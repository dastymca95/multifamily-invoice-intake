"""
Phase 3M — Export Readiness Boundary diagnostic API.

Single endpoint that evaluates the canonical Phase 3M boundary
contract from a caller-supplied diagnostic-state snapshot.

  * 200 success — always carries ``diagnostic_only=True`` and
    ``production_export_ready=False``.
  * 422 invalid payload (Pydantic).
  * No mutation, no DB persistence, no export file generation, no
    Review Queue records, no document/batch/template status changes,
    no external posting.

Design notes:
  * Endpoint is optional in the Phase 3M spec; included here because
    Phase 3I added the parallel ``/export-profiles/validate-preview``
    endpoint and the spec calls out "consistency with project
    conventions". Keeps this small + cheap to ship.
  * The boundary contract is a pure function of the input — the
    endpoint exists so future client surfaces can consult the
    canonical backend boundary without duplicating the rules.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.dependencies import CurrentUser
from app.schemas.export_readiness_boundary import (
    ExportReadinessBoundary,
    ExportReadinessBoundaryRequest,
)
from app.services.export_readiness_boundary import (
    build_export_readiness_boundary_from_input,
)


router = APIRouter(
    prefix="/export-readiness-boundary",
    tags=["export-readiness-boundary"],
)


@router.post(
    "/evaluate",
    response_model=ExportReadinessBoundary,
)
async def evaluate_export_readiness_boundary(
    body: ExportReadinessBoundaryRequest,
    user: CurrentUser,
) -> ExportReadinessBoundary:
    """Evaluate the boundary contract from the supplied snapshot.

    Diagnostic only — the response always carries
    ``diagnostic_only=True`` and ``production_export_ready=False``
    regardless of input. No file is generated, no profile is
    persisted, no export record is created, and nothing is mutated.
    Pydantic enforces the literal types so a malformed value can't
    flip the contract.
    """
    return build_export_readiness_boundary_from_input(body.input)
