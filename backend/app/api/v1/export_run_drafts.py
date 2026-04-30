"""
Phase 4F — Export Run Draft diagnostic API.

Single endpoint that evaluates a caller-supplied diagnostic
snapshot and returns an ``ExportRunDraft`` verdict.

  * 200 success — always carries the hard-pinned literals
    ``draft_only=True``, ``finalized=False``,
    ``file_generated=False``, ``download_available=False``,
    ``production_export_ready=False``.
  * 422 invalid payload (Pydantic).
  * No mutation, no DB persistence, no export file generation,
    no Review Queue records, no document/batch/template status
    changes, no external posting.

Phase 3O regression compatibility:
  Response carries no forbidden export / file / posting handles
  (``export_id`` / ``export_run_id`` / ``export_batch_id`` /
  ``download_url`` / ``file_url`` / ``file_id`` / ``posted_at`` /
  ``external_posting_id``). The Phase 3O ``assert_no_export_handles``
  helper covers this assertion in the API tests.

Endpoint included in Phase 4F (vs. deferred) because the Phase 3M
``/export-readiness-boundary/evaluate`` precedent makes a sibling
diagnostic-evaluator endpoint very small + consistent.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.dependencies import CurrentUser
from app.schemas.export_run_draft import (
    ExportRunDraft,
    ExportRunDraftRequest,
)
from app.services.export_run_draft import (
    build_export_run_draft_from_input,
)


router = APIRouter(
    prefix="/export-run-drafts",
    tags=["export-run-drafts"],
)


@router.post(
    "/evaluate",
    response_model=ExportRunDraft,
)
async def evaluate_export_run_draft(
    body: ExportRunDraftRequest,
    user: CurrentUser,
) -> ExportRunDraft:
    """Evaluate the export run draft from the supplied snapshot.

    Diagnostic only — the response always carries
    ``draft_only=True``, ``finalized=False``,
    ``file_generated=False``, ``download_available=False``, and
    ``production_export_ready=False`` regardless of input.
    Pydantic enforces the literal types so a malformed value can't
    flip the contract.

    No DB lookup, no file generation, no export record creation,
    no document / batch / template mutation, no external posting.
    """
    return build_export_run_draft_from_input(body.input)
