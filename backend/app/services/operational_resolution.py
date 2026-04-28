"""
Phase 3A — Operational Resolution Pipeline service.

Composer that wires the existing pieces into a "production-shaped
dry run":

    template (loaded by id)
        ↓
    optional pattern (loaded by id)
        ↓
    Phase 2A bridge OR direct ResolverInput from caller-supplied
        extracted_facts / catalog_hints / document_metadata
        ↓
    operational metadata layered into document_metadata + runtime_options
        ↓
    dry_run_resolve_import_template
        ↓
    OperationalResolutionResult (resolver input + result + summary +
        lightweight review diagnostics)

Hard contract:

  * Read-only — no mutation of template / pattern / document /
    batch / DB.
  * No commit / flush / refresh.
  * No OCR, AI, PDF parsing, export, Review Queue records.
  * ``diagnostic_only`` is hard-True today; future phases will
    promote operational results into Review Queue items / export
    rows behind explicit flags.

Errors:

  * Template missing → ``OperationalResolutionNotFound(kind="template")``
  * Pattern missing (when ``pattern_id`` provided) →
    ``OperationalResolutionNotFound(kind="pattern")``

The API layer translates both to HTTP 404; the ``kind`` lets the
caller distinguish which side was missing.

Distinction from Phase 2B (``template_pattern_test_runner``):

  * Phase 2B is the operator's diagnostic surface — accepts
    ``manual_fact_values`` / ``manual_catalog_hints`` / scenario
    inputs.
  * Phase 3A is the operational shape — accepts
    ``extracted_facts`` / ``catalog_hints`` / ``document_id`` /
    ``batch_id`` directly, mirroring the future production path.

Phase 2B is NOT removed; Phase 3A reuses the same underlying
resolver and the Phase 2A bridge.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.invoice_pattern import InvoicePattern
from app.models.invoice_template import InvoiceTemplate
from app.repositories.invoice_pattern_repo import InvoicePatternRepository
from app.repositories.invoice_template_repo import InvoiceTemplateRepository
from app.schemas.import_resolver import (
    CatalogHint,
    ExtractedFact,
    ResolverInput,
    ResolverIssue,
    ResolverResult,
)
from app.schemas.operational_resolution import (
    OperationalResolutionResult,
    OperationalResolutionSummary,
    OperationalReviewDiagnostic,
    PatternSelectionMode,
    ReviewFixArea,
    ReviewSeverity,
)
from app.services.import_template_resolver import (
    dry_run_resolve_import_template,
)
from app.services.invoice_pattern_resolver_bridge import (
    build_resolver_input_from_invoice_pattern,
)


OPERATIONAL_SOURCE = "operational_resolution_pipeline"
OPERATIONAL_VERSION = "phase_3a"


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class OperationalResolutionNotFound(LookupError):
    """Raised when the template or pattern referenced doesn't exist.

    The API layer maps this to HTTP 404. ``kind`` distinguishes
    template-vs-pattern so a downstream UI can render a specific
    error.
    """

    def __init__(self, kind: str, identifier: UUID | str) -> None:
        self.kind = kind
        self.identifier = str(identifier)
        super().__init__(f"Invoice {kind} {self.identifier} not found")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def run_operational_resolution(
    db: AsyncSession,
    *,
    template_id: UUID,
    pattern_id: UUID | None = None,
    document_id: UUID | None = None,
    batch_id: UUID | None = None,
    extracted_facts: (
        list[ExtractedFact] | dict[str, Any] | None
    ) = None,
    catalog_hints: dict[str, Any] | None = None,
    document_metadata: dict[str, Any] | None = None,
    runtime_options: dict[str, Any] | None = None,
    pattern_selection_mode: PatternSelectionMode | str = "manual",
    diagnostic_only: bool = True,
) -> OperationalResolutionResult:
    """Run the operational resolution pipeline.

    See module docstring for the full pipeline contract.

    ``diagnostic_only`` is currently forced to True in the response
    regardless of the caller's value — Phase 3A intentionally locks
    the surface to read-only behaviour. The argument is kept on the
    signature so callers can express intent, but the response
    contract is the source of truth.
    """
    template = await _load_template(db, template_id)
    pattern: InvoicePattern | None = None
    if pattern_id is not None and pattern_selection_mode == "manual":
        pattern = await _load_pattern(db, pattern_id)

    # Build the ResolverInput. Two paths:
    #
    #   A. Pattern + caller facts/hints: lean on the Phase 2A bridge
    #      so pattern structural metadata (vendor_hint,
    #      known_pattern_fields, etc.) flows through. Caller-supplied
    #      facts override bridge facts on the same normalized key.
    #   B. No pattern: build a bare ResolverInput from caller inputs
    #      only. document_metadata still carries operational keys.
    if pattern is not None:
        resolver_input = _build_resolver_input_with_pattern(
            template=template,
            pattern=pattern,
            extracted_facts=extracted_facts,
            catalog_hints=catalog_hints,
        )
    else:
        resolver_input = _build_resolver_input_without_pattern(
            template=template,
            extracted_facts=extracted_facts,
            catalog_hints=catalog_hints,
        )

    # Layer in operational metadata + caller's runtime_options +
    # caller's document_metadata. Bridge / runner / operational keys
    # are protected against caller spoofing.
    enriched_input = _enrich_with_operational_context(
        resolver_input,
        template=template,
        pattern=pattern,
        document_id=document_id,
        batch_id=batch_id,
        caller_document_metadata=document_metadata,
        caller_runtime_options=runtime_options,
    )

    resolver_result = await dry_run_resolve_import_template(
        template, enriched_input, db
    )

    review_diagnostics = _build_review_diagnostics(resolver_result)

    summary = _build_summary(
        bridge_input=enriched_input,
        resolver_result=resolver_result,
        review_diagnostics=review_diagnostics,
    )

    return OperationalResolutionResult(
        diagnostic_only=True,
        template_id=str(template.id),
        template_name=_safe_str(getattr(template, "name", None)),
        pattern_id=str(pattern.id) if pattern is not None else None,
        pattern_name=(
            _safe_str(getattr(pattern, "name", None)) if pattern is not None else None
        ),
        document_id=str(document_id) if document_id is not None else None,
        batch_id=str(batch_id) if batch_id is not None else None,
        resolver_input=enriched_input,
        resolver_result=resolver_result,
        operational_summary=summary,
        review_diagnostics=review_diagnostics,
    )


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------


async def _load_template(db: AsyncSession, template_id: UUID) -> InvoiceTemplate:
    repo = InvoiceTemplateRepository(db)
    row = await repo.get(template_id)
    if row is None:
        raise OperationalResolutionNotFound("template", template_id)
    return row


async def _load_pattern(db: AsyncSession, pattern_id: UUID) -> InvoicePattern:
    repo = InvoicePatternRepository(db)
    row = await repo.get(pattern_id)
    if row is None:
        raise OperationalResolutionNotFound("pattern", pattern_id)
    return row


# ---------------------------------------------------------------------------
# ResolverInput construction
# ---------------------------------------------------------------------------


def _build_resolver_input_with_pattern(
    *,
    template: InvoiceTemplate,
    pattern: InvoicePattern,
    extracted_facts: list[ExtractedFact] | dict[str, Any] | None,
    catalog_hints: dict[str, Any] | None,
) -> ResolverInput:
    """Bridge-backed path.

    The Phase 2A bridge handles vendor_hint → catalog_hints,
    pattern field key collection, and ExtractedFact construction
    from a mapping. Caller-supplied facts in LIST form merge AFTER
    the bridge so they take precedence on the same normalized key.
    """
    # Mapping facts → bridge.manual_fact_values.
    manual_fact_values: dict[str, Any] | None = None
    list_facts: list[ExtractedFact] = []
    if isinstance(extracted_facts, dict):
        manual_fact_values = extracted_facts
    elif isinstance(extracted_facts, list):
        # ExtractedFact instances OR dicts shaped like one. Normalize
        # via the schema validator (idempotent for existing instances).
        for raw in extracted_facts:
            if isinstance(raw, ExtractedFact):
                list_facts.append(raw)
            elif isinstance(raw, dict):
                list_facts.append(ExtractedFact.model_validate(raw))
            # Anything else is silently skipped — the resolver
            # tolerates an empty extracted_facts list and the
            # validator would have raised by now.

    bridge_input = build_resolver_input_from_invoice_pattern(
        pattern,
        template_id=template.id,
        manual_fact_values=manual_fact_values,
        manual_catalog_hints=catalog_hints,
        include_empty_fields=False,
    )

    if list_facts:
        # Merge: caller list-shape facts WIN over bridge facts on
        # the same normalized key. Preserves insertion order so the
        # resolver's first-fact-wins-per-key behavior keeps the
        # caller's intent.
        merged = _merge_extracted_facts(list_facts, bridge_input.extracted_facts)
        bridge_input = bridge_input.model_copy(update={"extracted_facts": merged})

    return bridge_input


def _build_resolver_input_without_pattern(
    *,
    template: InvoiceTemplate,
    extracted_facts: list[ExtractedFact] | dict[str, Any] | None,
    catalog_hints: dict[str, Any] | None,
) -> ResolverInput:
    """Pattern-less path — build a bare ResolverInput.

    The resolver tolerates a bare input; we still:
      * coerce mapping facts to ``ExtractedFact`` rows
      * coerce string/dict catalog hints to ``CatalogHint`` shapes

    so the wire payload matches what the bridge would have produced.
    """
    facts: list[ExtractedFact] = []
    if isinstance(extracted_facts, dict):
        for raw_key, raw_value in extracted_facts.items():
            if not isinstance(raw_key, str):
                continue
            key = raw_key.strip()
            if not key:
                continue
            if raw_value is None:
                continue
            if isinstance(raw_value, str) and not raw_value.strip():
                continue
            facts.append(
                ExtractedFact(
                    field_key=key,
                    value=raw_value,
                    source_type="manual",
                    confidence=1.0,
                    provenance_label="operational override (no pattern)",
                )
            )
    elif isinstance(extracted_facts, list):
        for raw in extracted_facts:
            if isinstance(raw, ExtractedFact):
                facts.append(raw)
            elif isinstance(raw, dict):
                facts.append(ExtractedFact.model_validate(raw))

    hints = _build_catalog_hints(catalog_hints)
    return ResolverInput(
        template_id=str(template.id),
        extracted_facts=facts,
        catalog_hints=hints,
    )


def _merge_extracted_facts(
    primary: list[ExtractedFact],
    fallback: list[ExtractedFact],
) -> list[ExtractedFact]:
    """Merge two ExtractedFact lists, primary wins by normalized key.

    Order:
      1. Every fact from ``primary``, in order.
      2. Then every fact from ``fallback`` whose normalized key
         doesn't already appear in ``primary``.

    This keeps caller intent stable while still letting bridge facts
    flow through for fields the caller didn't override.
    """
    seen: set[str] = set()
    out: list[ExtractedFact] = []
    for fact in primary:
        out.append(fact)
        key = fact.normalized_field_key or fact.field_key
        if key:
            seen.add(key)
    for fact in fallback:
        key = fact.normalized_field_key or fact.field_key
        if key and key in seen:
            continue
        out.append(fact)
        if key:
            seen.add(key)
    return out


def _build_catalog_hints(
    raw: dict[str, Any] | None,
) -> dict[str, CatalogHint]:
    """Coerce a kind→hint mapping into ``{kind: CatalogHint}``.

    Mirrors the Phase 2A bridge helper's intent without depending
    on its internals (the bridge keeps its helpers private). Same
    rules: string → ``CatalogHint(text=...)``; dict whitelisted to
    entry_id / text / field_values; everything else dropped.
    """
    out: dict[str, CatalogHint] = {}
    if not raw:
        return out
    for raw_kind, raw_value in raw.items():
        kind = _normalize_hint_kind(raw_kind)
        if kind is None:
            continue
        hint = _normalize_catalog_hint(raw_value)
        if hint is None:
            continue
        out[kind] = hint
    return out


def _normalize_hint_kind(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    kind = raw.strip().lower()
    if not kind:
        return None
    aliases = {
        "vendor": "vendor",
        "vendors": "vendor",
        "vendor_catalog": "vendor",
        "property": "property",
        "properties": "property",
        "property_catalog": "property",
        "gl": "gl",
        "gl_code": "gl",
        "gl_codes": "gl",
        "gl_catalog": "gl",
    }
    return aliases.get(kind)


def _normalize_catalog_hint(raw: Any) -> CatalogHint | None:
    if isinstance(raw, CatalogHint):
        return raw
    if isinstance(raw, str):
        text = raw.strip()
        return CatalogHint(text=text) if text else None
    if isinstance(raw, dict):
        entry_id = raw.get("entry_id")
        text = raw.get("text")
        field_values = raw.get("field_values") or {}
        cleaned_entry = entry_id.strip() if isinstance(entry_id, str) else entry_id
        cleaned_text = text.strip() if isinstance(text, str) else text
        if not cleaned_entry and not cleaned_text and not field_values:
            return None
        return CatalogHint(
            entry_id=cleaned_entry or None,
            text=cleaned_text or None,
            field_values=dict(field_values) if field_values else {},
        )
    return None


# ---------------------------------------------------------------------------
# Enrichment + protected-key merge
# ---------------------------------------------------------------------------


# Keys the caller's ``document_metadata`` cannot overwrite. The
# bridge / runner own provenance for these — letting a hostile
# caller spoof them would break downstream Review Queue / export
# tracing.
_PROTECTED_METADATA_KEYS: frozenset[str] = frozenset(
    {
        # Phase 2A bridge keys
        "bridge_source",
        "bridge_version",
        "invoice_pattern_id",
        "invoice_pattern_name",
        "vendor_hint",
        "source_file_count",
        "source_file_names",
        "known_pattern_fields",
        "unfilled_pattern_fields",
        # Phase 3A operational keys
        "operational_source",
        "operational_version",
        "template_id",
        "template_name",
        "pattern_id",
        "pattern_name",
        "document_id",
        "batch_id",
        "diagnostic_only",
    }
)


def _enrich_with_operational_context(
    resolver_input: ResolverInput,
    *,
    template: InvoiceTemplate,
    pattern: InvoicePattern | None,
    document_id: UUID | None,
    batch_id: UUID | None,
    caller_document_metadata: dict[str, Any] | None,
    caller_runtime_options: dict[str, Any] | None,
) -> ResolverInput:
    """Layer caller + operational metadata onto the resolver input.

    Returns a NEW ``ResolverInput`` (model_copy) — never mutates the
    bridge / direct-build output. Caller-supplied keys colliding
    with bridge or operational protected keys are dropped before the
    merge so provenance tracing stays trustworthy.
    """
    bridge_metadata = dict(resolver_input.document_metadata or {})

    operational_metadata: dict[str, Any] = {
        "operational_source": OPERATIONAL_SOURCE,
        "operational_version": OPERATIONAL_VERSION,
        "template_id": str(template.id),
        "template_name": _safe_str(getattr(template, "name", None)),
        "diagnostic_only": True,
    }
    if pattern is not None:
        operational_metadata["pattern_id"] = str(pattern.id)
        operational_metadata["pattern_name"] = _safe_str(
            getattr(pattern, "name", None)
        )
    if document_id is not None:
        operational_metadata["document_id"] = str(document_id)
    if batch_id is not None:
        operational_metadata["batch_id"] = str(batch_id)

    merged_metadata = _merge_document_metadata(
        caller=caller_document_metadata,
        bridge=bridge_metadata,
        operational=operational_metadata,
    )

    merged_runtime_options = dict(resolver_input.runtime_options or {})
    if caller_runtime_options:
        merged_runtime_options.update(caller_runtime_options)

    return resolver_input.model_copy(
        update={
            "document_metadata": merged_metadata,
            "runtime_options": merged_runtime_options,
            # Forward document/batch ids on the dedicated fields too
            # — the resolver doesn't read them today, but a future
            # phase can branch on them without re-walking metadata.
            "document_id": str(document_id) if document_id is not None else None,
            "batch_id": str(batch_id) if batch_id is not None else None,
        }
    )


def _merge_document_metadata(
    *,
    caller: dict[str, Any] | None,
    bridge: dict[str, Any],
    operational: dict[str, Any],
) -> dict[str, Any]:
    """Merge document_metadata with strict precedence.

    Order (lowest → highest):
      1. Caller's free-form keys (after stripping protected keys).
      2. Bridge metadata (pattern provenance + structural keys).
      3. Operational metadata (operational + document / batch keys).

    Caller-supplied protected keys are dropped before the merge —
    a hostile caller can never spoof bridge or operational
    provenance.
    """
    out: dict[str, Any] = {}
    if caller:
        for key, value in caller.items():
            if key in _PROTECTED_METADATA_KEYS:
                continue
            out[key] = value
    out.update(bridge)
    out.update(operational)
    return out


# ---------------------------------------------------------------------------
# Review diagnostics — minimal backend mapping
# ---------------------------------------------------------------------------


# Code → fix area mapping. Narrow on purpose — Phase 2G's frontend
# helper covers the full vocabulary; this backend mirror only needs
# enough coverage to drive the operational summary counts and a
# basic review surface.
_CODE_FIX_AREA: dict[str, ReviewFixArea] = {
    "REQUIRED_RUNTIME_VALUE_MISSING": "import_template",
    "INVOICE_FIELD_FACT_NOT_FOUND": "extracted_fact",
    "CATALOG_HINT_MISSING": "catalog_hint",
    "CATALOG_NOT_CONFIGURED": "import_template",
    "CATALOG_ENTRY_NOT_FOUND": "reference_data",
    "CATALOG_NOT_FOUND": "reference_data",
    "NO_RULES_MATCHED": "import_template",
    "CONDITION_NO_ACTUAL_VALUE": "extracted_fact",
}


def _build_review_diagnostics(
    result: ResolverResult,
) -> list[OperationalReviewDiagnostic]:
    """Map the resolver's known issues onto the lightweight review
    diagnostic shape.

    Walks both top-level result issues and per-row issues. Cells'
    raw ``issue_codes`` are NOT walked — those usually have a
    matching top-level issue with a richer message attached, and
    duplicating them here would produce noise without new signal.
    """
    out: list[OperationalReviewDiagnostic] = []
    seen: set[tuple[str, str]] = set()
    for issue in _collect_issues(result):
        code = issue.code
        if code is None:
            continue
        if code not in _CODE_FIX_AREA:
            # Stay narrow — unknown codes flow through the resolver
            # result envelope; the operator can still inspect them
            # via the raw issues list.
            continue
        column_id = issue.column_id
        key = (code, column_id or "")
        if key in seen:
            continue
        seen.add(key)
        out.append(
            OperationalReviewDiagnostic(
                severity=_severity_from_resolver_severity(issue.severity),
                code=code,
                message=issue.message,
                recommendation=issue.recommendation,
                column_id=column_id,
                column_name=issue.column_label,
                fix_area=_CODE_FIX_AREA[code],
            )
        )
    return out


def _collect_issues(result: ResolverResult) -> list[ResolverIssue]:
    """Flat list of every issue surfaced by the resolver."""
    out: list[ResolverIssue] = []
    for issue in result.issues or []:
        out.append(issue)
    for row in result.rows or []:
        for issue in row.issues or []:
            out.append(issue)
        for matched in row.matched_rules or []:
            for issue in matched.issues or []:
                out.append(issue)
            for issue in matched.action_issues or []:
                out.append(issue)
    return out


def _severity_from_resolver_severity(value: Any) -> ReviewSeverity:
    if value == "error":
        return "blocked"
    if value == "warning":
        return "warning"
    if value == "info":
        return "info"
    return "warning"


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


def _build_summary(
    *,
    bridge_input: ResolverInput,
    resolver_result: ResolverResult,
    review_diagnostics: list[OperationalReviewDiagnostic],
) -> OperationalResolutionSummary:
    """Coarse counts mirroring the resolver's own summary."""
    rs = resolver_result.summary
    missing_required = sum(
        1
        for d in review_diagnostics
        if d.code == "REQUIRED_RUNTIME_VALUE_MISSING"
    )
    missing_facts = sum(
        1
        for d in review_diagnostics
        if d.code == "INVOICE_FIELD_FACT_NOT_FOUND"
    )
    missing_hints = sum(
        1
        for d in review_diagnostics
        if d.code
        in {
            "CATALOG_HINT_MISSING",
            "CATALOG_NOT_CONFIGURED",
            "CATALOG_ENTRY_NOT_FOUND",
            "CATALOG_NOT_FOUND",
        }
    )
    return OperationalResolutionSummary(
        status=str(resolver_result.status),
        row_count=getattr(rs, "row_count", 0) or 0,
        ready_rows=getattr(rs, "ready_rows", 0) or 0,
        needs_review_rows=getattr(rs, "needs_review_rows", 0) or 0,
        blocked_rows=getattr(rs, "blocked_rows", 0) or 0,
        conflict_rows=getattr(rs, "conflict_rows", 0) or 0,
        error_count=getattr(rs, "error_count", 0) or 0,
        warning_count=getattr(rs, "warning_count", 0) or 0,
        info_count=getattr(rs, "info_count", 0) or 0,
        extracted_fact_count=len(bridge_input.extracted_facts or []),
        catalog_hint_count=len(bridge_input.catalog_hints or {}),
        missing_required_count=missing_required,
        missing_fact_count=missing_facts,
        missing_catalog_hint_count=missing_hints,
        diagnostic_only=True,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
