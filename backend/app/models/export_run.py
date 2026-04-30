"""
ExportRunRecord — Phase 5A persisted export run draft / audit row.

Persistent foundation for the Phase 4F–4I diagnostic Export Run
Draft contract. Until Phase 5A the draft was 100% stateless: each
``POST /api/v1/export-run-drafts/evaluate`` call computed a verdict
and returned it without touching the DB. Phase 5A introduces an
explicit "I want to keep this verdict for the audit trail" path:

  * NEW endpoint: ``POST /api/v1/export-runs/drafts`` (Phase 5A) —
    persists a draft / audit row.
  * EXISTING endpoint: ``POST /api/v1/export-run-drafts/evaluate``
    (Phase 4F) — STILL stateless. Phase 3O / 4I forbid that
    endpoint from returning ``export_run_id`` of any flavour.

What this model IS:
  * A persisted draft / audit row capturing one Export Run Draft
    verdict + the diagnostic context that produced it.
  * Always ``phase="draft"`` in this phase. Future phases may
    introduce additional phases (e.g. ``approved``, ``finalized``)
    behind explicit export-engine work.

What this model is NOT:
  * NOT a finalized export. ``id`` is a draft / audit record id,
    NOT an export id.
  * NOT a file artefact. No file is generated; no
    ``file_id`` / ``download_url`` / etc. fields are persisted.
  * NOT an export batch. Batches land in their own table behind
    an explicit future phase.
  * NOT a state machine that mutates documents / batches /
    templates. Soft FKs only — never enforced at the DB layer,
    never updated as a side effect of writing this row.
  * NOT an external posting record (no ResMan / Yardi / AppFolio
    handles).

Phase 3O / 4I regression compliance — this model deliberately
omits every forbidden export / file / posting / finalisation
handle:

  * ``file_id`` / ``file_url`` / ``download_url``
  * ``export_id`` / ``export_run_id`` (the column is named ``id``)
  * ``export_batch_id``
  * ``posted_at`` / ``external_posting_id``
  * ``finalized_at`` / ``exported_at``

A future phase that introduces an actual export run lifecycle
will add a SEPARATE ``export_runs_finalized`` table (or extend
this one behind a phase column flip + a new migration), so the
draft / production boundary stays sharp on the wire AND in the
schema.

Why ``ExportRunRecord`` (not ``ExportRunDraft``):
  * The Pydantic ``ExportRunDraft`` already exists in
    ``app.schemas.export_run_draft`` for the diagnostic verdict
    shape. Reusing the name for the SQLAlchemy model would force
    readers to disambiguate every time. The DB row is the
    persisted RECORD; the Pydantic class is the wire CONTRACT.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class ExportRunRecord(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "export_runs"

    # Diagnostic verdict status. Free-text in the column so a
    # future status (``archived``?) lands without a migration; the
    # service layer enforces the closed Phase 5A set
    # (``draft_clear`` / ``needs_review`` / ``blocked``) on create
    # via the ``ExportRunRecordStatus`` Literal in the persistence
    # schema.
    status: Mapped[str] = mapped_column(String(32), nullable=False)

    # Lifecycle phase. Phase 5A pins this to ``"draft"`` for every
    # row. Future phases may introduce ``"approved"`` /
    # ``"finalized"`` BEHIND explicit export-engine work — until
    # then the service rejects any other value.
    phase: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="draft",
        server_default="draft",
    )

    # How the draft was created. Free-text for the same forward-
    # compat reason as ``target_system`` on the export profile
    # table; service layer narrows to the Phase 5A closed set.
    source: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="operational_preview",
        server_default="operational_preview",
    )

    # Soft FKs — capture the catalog references without constraining
    # to any other table. Mirrors the Phase 4A export profile
    # convention so a future profile delete doesn't leave an
    # orphaned constraint failure on this row.
    export_profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    # Snapshot copies of the profile metadata so the audit row
    # remains readable even if the profile is later renamed /
    # deactivated. Both are nullable because built-in / inline /
    # absent profile selections are valid.
    export_profile_name: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    export_profile_version: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )

    template_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    batch_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )

    # Free-text target system snapshot. Same forward-compat pattern
    # as the export profile table — service layer narrows on create.
    target_system: Mapped[str | None] = mapped_column(
        String(32), nullable=True
    )

    # Row counts captured from the draft verdict. Stored
    # independently of ``draft_snapshot`` so the list endpoint can
    # filter / aggregate without reading the JSONB blob.
    row_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    blocked_row_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    warning_row_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    issue_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    # The full ``ExportRunDraft`` verdict serialised as JSONB. The
    # persistence service re-validates this through the Pydantic
    # ``ExportRunDraft`` model BEFORE write, so the hard-pinned
    # literals (``draft_only=True``, ``finalized=False``,
    # ``file_generated=False``, ``download_available=False``,
    # ``production_export_ready=False``) are guaranteed to be
    # present + correct on every persisted row.
    draft_snapshot: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )

    # The caller-supplied diagnostic context that produced the
    # verdict. Sanitised by the persistence service (no forbidden
    # export / file / posting / finalisation handles) before write.
    request_snapshot: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True
    )

    # Operator-only notes (paste-into-Slack-friendly).
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # ---- Phase 6A — Approval workflow metadata ------------------
    # Approval is a SEPARATE workflow gate from ``status`` /
    # ``phase``. It is NOT export readiness, NOT file generation,
    # NOT finalisation, NOT external posting. The closed Phase 6A
    # vocabulary lives on ``ExportRunApprovalStatus`` in the
    # persistence schema; this column stays free-text so a future
    # state can extend without a migration.
    #
    # Hard contract — even when ``approval_status ==
    # "approved_for_file_generation"``:
    #   * ``phase`` remains ``"draft"``.
    #   * ``draft_snapshot.finalized`` / ``file_generated`` /
    #     ``download_available`` / ``production_export_ready``
    #     remain false.
    #   * No file is generated, no download URL is issued, no
    #     document / batch / template is mutated, no external
    #     system is contacted, no export batch is created.
    approval_status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="not_requested",
        server_default="not_requested",
    )
    # Audit timestamps + soft-FK actors for each transition. All
    # nullable because not_requested rows carry none of them.
    approval_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    approval_requested_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    approved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    rejected_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    rejected_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    # Operator-supplied approval notes — paste-into-Slack-friendly,
    # separate from ``notes`` so an audit trail keeps the original
    # save-time notes alongside the approval-time notes.
    approval_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Required on reject; the API layer surfaces the empty case as
    # HTTP 422 BEFORE the service writes anything.
    rejection_reason: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )

    # Soft FKs — capture the actor without constraining to the auth
    # user table. Same pattern as ``ExportProfileRecord``.
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )

    def __repr__(self) -> str:
        return (
            f"<ExportRunRecord id={self.id} phase={self.phase!r} "
            f"status={self.status!r} approval={self.approval_status!r} "
            f"rows={self.row_count}>"
        )
