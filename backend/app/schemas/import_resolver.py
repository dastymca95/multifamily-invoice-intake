"""Typed dry-run contract for the future Import Builder resolver.

These Pydantic models intentionally describe the runtime package and
result shape without implementing the full resolver. They are used by
the dry-run endpoint to prove the wire contract and to give later phases
a stable place to add real matching, catalog resolution, provenance,
and export gating.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.domain.extracted_invoice_fields import normalize_extracted_field_key


ExtractedFactSourceType = Literal[
    "invoice_pattern", "ocr", "heuristic", "ai", "manual", "unknown"
]
ResolverSeverity = Literal["error", "warning", "info"]
ResolverStatus = Literal["ready", "needs_review", "blocked", "conflict"]
ResolvedCellStatus = Literal[
    "resolved", "missing", "conflict", "fallback", "manual_review", "ignored"
]
ResolvedCellSourceType = Literal[
    "fixed_value",
    "catalog",
    "invoice_pattern",
    "ocr",
    "heuristic",
    "ai",
    "manual",
    "global_default",
    "rule_fill",
    "derived",
    "none",
]


class ExtractedFact(BaseModel):
    """One candidate value produced by extraction or later fallbacks."""

    field_key: str
    normalized_field_key: str | None = None
    value: Any | None = None
    text_value: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    source_type: ExtractedFactSourceType = "unknown"
    pattern_id: str | None = None
    pattern_label: str | None = None
    region_id: str | None = None
    page: int | None = Field(default=None, ge=1)
    provenance_label: str | None = None

    @model_validator(mode="after")
    def _normalize_field_key(self) -> "ExtractedFact":
        if self.normalized_field_key is None:
            self.normalized_field_key = normalize_extracted_field_key(self.field_key)
        return self


class PatternMatch(BaseModel):
    """A candidate Invoice Builder pattern match for the current document."""

    pattern_id: str
    pattern_label: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    matched: bool = True
    reason: str | None = None


class ResolverInput(BaseModel):
    """Runtime context supplied to a resolver dry run.

    `template_id` is optional on request bodies because the dry-run
    endpoint already carries it in the path. The service treats the
    path-loaded template as authoritative and never mutates the stored
    template from this input.
    """

    template_id: str | None = None
    document_id: str | None = None
    batch_id: str | None = None
    extracted_facts: list[ExtractedFact] = Field(default_factory=list)
    pattern_matches: list[PatternMatch] = Field(default_factory=list)
    catalog_context: dict[str, Any] | None = None
    document_metadata: dict[str, Any] = Field(default_factory=dict)
    runtime_options: dict[str, Any] = Field(default_factory=dict)

    @field_validator("extracted_facts", mode="before")
    @classmethod
    def _coerce_extracted_fact_mapping(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        rows: list[dict[str, Any]] = []
        for field_key, fact_value in value.items():
            if isinstance(fact_value, dict):
                row = dict(fact_value)
                row.setdefault("field_key", str(field_key))
                rows.append(row)
            else:
                rows.append({"field_key": str(field_key), "value": fact_value})
        return rows


class ResolverIssue(BaseModel):
    """One runtime/dry-run diagnostic."""

    severity: ResolverSeverity
    code: str
    message: str
    recommendation: str | None = None
    column_id: str | None = None
    column_label: str | None = None
    rule_id: str | None = None
    rule_label: str | None = None
    field_key: str | None = None
    pattern_id: str | None = None
    path: str | None = None


class CellProvenance(BaseModel):
    """How a resolved output cell was produced."""

    rule_id: str | None = None
    rule_label: str | None = None
    column_id: str
    column_label: str
    pattern_id: str | None = None
    field_key: str | None = None
    normalized_field_key: str | None = None
    catalog_id: str | None = None
    entry_id: str | None = None
    source_label: str | None = None
    source_detail: str | None = None


class ResolvedImportCell(BaseModel):
    """One output cell in a dry-run row."""

    column_id: str
    column_label: str
    value: Any | None = None
    normalized_value: Any | None = None
    formatted_value: str | None = None
    status: ResolvedCellStatus
    source_type: ResolvedCellSourceType
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    provenance: CellProvenance | None = None
    warnings: list[str] = Field(default_factory=list)
    issue_codes: list[str] = Field(default_factory=list)


class ResolvedImportRow(BaseModel):
    """One placeholder import row returned by the dry-run skeleton."""

    row_index: int = Field(ge=0)
    status: ResolverStatus
    cells: list[ResolvedImportCell] = Field(default_factory=list)
    issues: list[ResolverIssue] = Field(default_factory=list)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class ResolverSummary(BaseModel):
    """Aggregate counts for the resolver result."""

    row_count: int = 0
    ready_rows: int = 0
    needs_review_rows: int = 0
    blocked_rows: int = 0
    conflict_rows: int = 0
    error_count: int = 0
    warning_count: int = 0
    info_count: int = 0


class ResolverResult(BaseModel):
    """Top-level dry-run response."""

    template_id: str
    template_name: str | None = None
    status: ResolverStatus
    rows: list[ResolvedImportRow] = Field(default_factory=list)
    issues: list[ResolverIssue] = Field(default_factory=list)
    summary: ResolverSummary = Field(default_factory=ResolverSummary)
