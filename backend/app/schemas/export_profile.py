"""
Phase 3I — Backend Export Profile validation schemas.

Canonical diagnostic contract for validating an export-style preview
payload against an export profile (target system + columns +
settings). Mirrors the Phase 3F frontend contract so the future
production export phase can use ONE shape on both sides.

What this module IS:
  * A typed Pydantic contract describing an export profile.
  * A typed Pydantic contract describing the diagnostic preview
    payload the validator consumes (columns + rows + cells).
  * The shape of the validator's response (status + summary +
    issues + per-column + per-row results).

What this module is NOT:
  * NOT an export file generator.
  * NOT a profile persistence layer (no DB models).
  * NOT a side-effecting export pipeline.
  * NOT a claim of production export readiness — every response
    carries ``diagnostic_only=True``.

Naming convention: every public type starts with ``ExportProfile*``
or ``ExportPreview*`` so future surfaces (a real persisted profile
table, a real export run record) can mirror without renames.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Profile vocabulary
# ---------------------------------------------------------------------------


ExportTargetSystem = Literal["resman", "yardi", "appfolio", "custom_csv"]


ExportProfileColumnDataType = Literal[
    "text",
    "date",
    "amount",
    "integer",
    "decimal",
    "boolean",
]


class ExportProfileSettings(BaseModel):
    """Lightweight wire-shape describing the file-level export
    settings the future export engine will honour.

    The validator only reads ``date_format`` (used as a hint for the
    best-effort date-format check). Every other field is informative
    today — we keep them in the schema so the contract is stable.
    """

    delimiter: str = ","
    include_header: bool = True
    quote_strategy: str = "minimal"
    newline: str = "lf"
    encoding: str = "utf-8"
    date_format: str = "MM/DD/YYYY"
    amount_format: str = "decimal_2"
    boolean_format: str | None = None
    empty_value_policy: str = "blank"
    file_naming_preview: str | None = None


class ExportProfileColumn(BaseModel):
    """One profile column — what the operator wants in the export.

    The validator matches this to a preview column via:
      1. exact ``source_column_key`` against ``preview.columns[].key``
      2. normalised label match against ``preview.columns[].label``
      3. alias match via ``match_aliases``
    """

    key: str
    label: str
    output_header: str
    order: int = 0
    required: bool = False
    source_column_key: str | None = None
    source_column_label: str | None = None
    data_type: ExportProfileColumnDataType = "text"
    max_length: int | None = None
    allowed_values: list[str] | None = None
    default_value: str | int | float | bool | None = None
    trim: bool = True
    match_aliases: list[str] = Field(default_factory=list)
    # Optional column-specific date format override; falls back to
    # the profile-level ``settings.date_format`` when absent.
    format: str | None = None


class ExportProfile(BaseModel):
    """Full export profile contract."""

    id: str
    name: str
    target_system: ExportTargetSystem
    description: str | None = None
    settings: ExportProfileSettings = Field(default_factory=ExportProfileSettings)
    columns: list[ExportProfileColumn] = Field(default_factory=list)
    # Hard-True today — protects against a future caller flipping
    # the surface into a side-effecting mode before the export
    # engine exists.
    diagnostic_only: bool = True


# ---------------------------------------------------------------------------
# Preview payload (what the validator inspects)
# ---------------------------------------------------------------------------
#
# Intentionally decoupled from the resolver / frontend types: this
# module defines its OWN ``ExportPreviewInput`` shape so the validator
# stays small and the wire format doesn't accidentally couple to
# unrelated resolver internals. Callers project resolver_result into
# this shape before calling the endpoint.


# Coarse cell verdict echoed from upstream (resolver / frontend
# preview). The validator never weakens these — a ``blocked`` /
# ``conflict`` cell on a required column always emits a blocking
# issue. Unknown values (forward-compat) degrade to ``warning``.
ExportPreviewCellStatus = Literal[
    "clear",
    "ready",
    "missing",
    "warning",
    "needs_review",
    "blocked",
    "conflict",
    "ignored",
]


# Coarse row verdict echoed from upstream — used to fill ``rows_blocked``
# / ``rows_with_issues`` summary counts. Unknown values degrade to
# ``needs_review``.
ExportPreviewRowStatus = Literal[
    "clear",
    "ready",
    "needs_review",
    "warning",
    "blocked",
    "conflict",
]


class ExportPreviewCellInput(BaseModel):
    column_key: str
    column_label: str | None = None
    value: Any | None = None
    display_value: str | None = None
    status: ExportPreviewCellStatus | str = "clear"
    source: str | None = None
    issues: list[Any] = Field(default_factory=list)
    issue_count: int = 0


class ExportPreviewRowInput(BaseModel):
    row_index: int
    status: ExportPreviewRowStatus | str = "clear"
    cells: list[ExportPreviewCellInput] = Field(default_factory=list)
    issue_count: int = 0


class ExportPreviewColumnInput(BaseModel):
    key: str
    label: str
    required: bool = False
    has_issues: bool = False
    issue_count: int = 0


class ExportPreviewInput(BaseModel):
    """Diagnostic-only preview shape consumed by the validator.

    The frontend's ``OperationalExportPreview`` is a superset; this
    schema accepts the minimum needed to reach a verdict.
    """

    columns: list[ExportPreviewColumnInput] = Field(default_factory=list)
    rows: list[ExportPreviewRowInput] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Validation result vocabulary
# ---------------------------------------------------------------------------


ExportProfileIssueSeverity = Literal["blocked", "warning", "info", "clear"]


ExportProfileIssueCode = Literal[
    "PROFILE_REQUIRED_COLUMN_MISSING",
    "PROFILE_REQUIRED_VALUE_MISSING",
    "PROFILE_CELL_BLOCKED",
    "PROFILE_CELL_CONFLICT",
    "PROFILE_CELL_NEEDS_REVIEW",
    "PROFILE_DATE_FORMAT_CHECK_FAILED",
    "PROFILE_AMOUNT_FORMAT_CHECK_FAILED",
    "PROFILE_ALLOWED_VALUE_FAILED",
    "PROFILE_MAX_LENGTH_EXCEEDED",
    "PROFILE_COLUMN_UNMAPPED",
    "PROFILE_PREVIEW_HAS_NO_ROWS",
]


class ExportProfileIssue(BaseModel):
    severity: ExportProfileIssueSeverity
    code: ExportProfileIssueCode
    message: str
    recommendation: str
    row_index: int | None = None
    column_key: str | None = None
    profile_column_key: str | None = None
    source_column_key: str | None = None


class ExportProfileColumnResult(BaseModel):
    profile_column_key: str
    profile_column_label: str
    matched: bool
    matched_preview_column_key: str | None = None
    matched_preview_column_label: str | None = None
    required: bool = False
    issue_count: int = 0
    worst_severity: ExportProfileIssueSeverity = "clear"


class ExportProfileRowResult(BaseModel):
    row_index: int
    issue_count: int = 0
    worst_severity: ExportProfileIssueSeverity = "clear"


ExportProfileValidationStatus = Literal[
    "clear",
    "needs_review",
    "blocked",
    "conflict",
]


class ExportProfileValidationSummary(BaseModel):
    total_issues: int = 0
    blocked_count: int = 0
    warning_count: int = 0
    info_count: int = 0
    row_count: int = 0
    column_count: int = 0
    matched_column_count: int = 0
    unmatched_column_count: int = 0
    rows_with_issues: int = 0
    blocked_rows: int = 0


class ExportProfileValidationContext(BaseModel):
    """Optional context the operator / launcher can attach.

    Pure metadata — none of these fields trigger DB lookups in this
    phase. Echoed back in the response so a paste-into-Slack /
    support workflow includes the context without re-querying.
    """

    template_id: str | None = None
    template_name: str | None = None
    pattern_id: str | None = None
    pattern_name: str | None = None
    document_id: str | None = None
    batch_id: str | None = None


class ExportProfileValidationRequest(BaseModel):
    """Request body for ``POST /export-profiles/validate-preview``.

    The endpoint is diagnostic only — ``diagnostic_only`` is hard-True
    in the response regardless of what the caller sends here, but we
    accept the field on the request so a future production export
    surface can flip it explicitly.
    """

    profile: ExportProfile
    preview: ExportPreviewInput
    context: ExportProfileValidationContext | None = None
    diagnostic_only: bool = True


class ExportProfileValidationResult(BaseModel):
    """Top-level response from the validator.

    ``diagnostic_only`` is hard-True — Phase 3I never persists
    profiles, never creates export records, never generates files.
    """

    diagnostic_only: bool = True
    profile_id: str
    profile_name: str
    target_system: ExportTargetSystem
    status: ExportProfileValidationStatus
    summary: ExportProfileValidationSummary
    issues: list[ExportProfileIssue] = Field(default_factory=list)
    column_results: list[ExportProfileColumnResult] = Field(default_factory=list)
    row_results: list[ExportProfileRowResult] = Field(default_factory=list)
    context: ExportProfileValidationContext | None = None
