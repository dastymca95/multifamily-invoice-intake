"""
Phase 4F — Backend Export Run Draft schemas.

Diagnostic-only contract that wraps the operator's current export
intent (operational result + selected profile + readiness boundary
+ row preview state) into a single "draft preview" response shape.

What this contract IS:
  * A typed Pydantic snapshot of "what would an export run look
    like if Rivera could create one today".
  * Hard-pinned to draft / un-finalized / no-file / no-download /
    not-production-ready at the type layer (Pydantic ``Literal``).
  * Forward-compatible with a future export-engine phase: the
    fields here are intentionally a SUBSET of what a real
    ``ExportRun`` row will eventually carry.

What this contract is NOT:
  * NOT an export run.
  * NOT a finalised export.
  * NOT a file generator.
  * NOT a download authoriser.
  * NOT a state machine that mutates documents / batches / templates.

Phase 3O regression compliance — this module deliberately omits
every forbidden export / file / posting handle:

  * ``download_url`` / ``file_url`` / ``file_id``
  * ``export_id`` / ``export_run_id`` / ``export_batch_id``
  * ``posted_at`` / ``external_posting_id``

A future phase that introduces persistence will add SEPARATE
schemas for those — this draft contract stays stateless on the
wire so the diagnostic vs. production boundary stays sharp.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------


ExportRunDraftStatus = Literal[
    "blocked",
    "needs_review",
    "draft_clear",
    "not_available",
]


ExportRunDraftReason = Literal[
    "diagnostic_only_pipeline",
    "no_export_engine",
    "no_file_generation",
    "no_export_run_persistence",
    "no_final_approval",
    "no_export_audit_trail",
    "no_external_posting",
    "readiness_boundary_not_clear",
    "profile_not_persisted",
    "profile_validation_blocked",
    "profile_validation_needs_review",
    "no_rows_to_export",
    "row_issues_present",
]


# ---------------------------------------------------------------------------
# Caller-supplied snapshot
# ---------------------------------------------------------------------------


class ExportRunDraftInput(BaseModel):
    """Caller-supplied snapshot of the diagnostic state the draft
    contract reasons over.

    Every field is optional so callers can evaluate the draft from
    partial state (e.g. a Settings page that hasn't picked a
    profile yet). All string fields are forward-compat — unknown
    values fall through the service's classifier the same way the
    Phase 3M readiness boundary does.

    NOTE: the IDs here are purely informational. The service does
    NOT load anything from them. They are echoed back inside
    ``ExportRunDraft.context`` so a paste-into-Slack workflow keeps
    provenance without re-querying the backend.
    """

    operational_result_id: str | None = None
    template_id: str | None = None
    document_id: str | None = None
    batch_id: str | None = None
    selected_profile_id: str | None = None
    selected_profile_source: str | None = None
    profile_validation_status: str | None = None
    readiness_diagnostic_status: str | None = None
    # Caller's own claim about production-export readiness. The
    # backend draft service IGNORES the value when computing the
    # response: ``ExportRunDraft.production_export_ready`` is
    # hard-pinned to ``False`` regardless. Kept here so callers
    # built against a future tightened export engine can pass a
    # real signal without a contract churn.
    production_export_ready: bool = False
    export_preview_row_count: int = 0
    export_preview_issue_count: int = 0
    blocked_row_count: int = 0
    warning_row_count: int = 0
    context: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Draft response
# ---------------------------------------------------------------------------


class ExportRunDraft(BaseModel):
    """The draft preview verdict.

    Carries hard-pinned ``draft_only=True`` / ``finalized=False`` /
    ``file_generated=False`` / ``download_available=False`` /
    ``production_export_ready=False`` literals. These cannot be
    widened by accident — Pydantic enforces them at parse time,
    and a downstream consumer would fail to construct an
    ``ExportRunDraft`` with any other value for those fields.
    """

    # Hard-pinned literals — Phase 3O regression-compatible.
    draft_only: Literal[True] = True
    finalized: Literal[False] = False
    file_generated: Literal[False] = False
    download_available: Literal[False] = False
    production_export_ready: Literal[False] = False

    status: ExportRunDraftStatus
    reasons: list[ExportRunDraftReason] = Field(default_factory=list)

    # Echoes of the caller-supplied IDs — useful for the operator
    # banner. Phase 3O regression: ``selected_profile_id`` is a
    # PROFILE id, not an export id. Profile ids are explicitly
    # allowed by the audit (``test_operational_preview_contract.py``
    # only forbids ``export_id`` / ``export_run_id`` / etc.).
    selected_profile_id: str | None = None
    selected_profile_source: str | None = None

    row_count: int = 0
    blocked_row_count: int = 0
    warning_row_count: int = 0

    operator_title: str
    operator_message: str
    developer_message: str
    next_steps: list[str] = Field(default_factory=list)
    disclaimers: list[str] = Field(default_factory=list)

    # Context echo — caller-supplied IDs / labels round-trip so a
    # paste-into-Slack workflow has provenance without re-querying.
    context: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# API request envelope
# ---------------------------------------------------------------------------


class ExportRunDraftRequest(BaseModel):
    """Request body for ``POST /export-run-drafts/evaluate``.

    Wraps ``ExportRunDraftInput`` so a future revision can grow
    the request without flattening every field at the body root
    (matches the Phase 3M ``ExportReadinessBoundaryRequest`` shape).
    """

    input: ExportRunDraftInput = Field(default_factory=ExportRunDraftInput)
