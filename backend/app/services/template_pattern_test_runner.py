"""
Phase 2B — Template + Pattern Test Runner.

Composer service that chains:

    Invoice Pattern
            ↓
    build_resolver_input_from_invoice_pattern(...)   (Phase 2A)
            ↓
    dry_run_resolve_import_template(...)             (Phase 9 / 1A-1B)
            ↓
    TemplatePatternTestResult  (bridge input + resolver result + summary)

The whole pipeline is read-only. The service:

  * Loads the saved Import Builder template by id.
  * Loads the saved Invoice Builder pattern by id.
  * Calls the Phase 2A bridge to construct ``ResolverInput`` from the
    pattern + operator-supplied test inputs.
  * Merges optional ``runtime_options`` + ``document_metadata`` into
    the bridge output without overwriting bridge / runner-managed
    keys.
  * Calls the existing dry-run resolver against the loaded template +
    bridge input.
  * Wraps everything in ``TemplatePatternTestResult`` with a derived
    summary so the consumer can render counts without re-walking the
    response.

What this service WILL NOT do:

  * Mutate the template, the pattern, or any DB row.
  * Persist anything (no ``commit`` / ``flush`` / ``add`` / ``refresh``).
  * Re-implement resolver semantics — it strictly composes existing
    services.
  * Trigger OCR / AI / Review Queue / Export / Upload.

Errors:

  * Template missing → raises ``TemplatePatternTestNotFound`` with
    ``kind="template"``. The API layer translates to 404.
  * Pattern missing → raises ``TemplatePatternTestNotFound`` with
    ``kind="pattern"``. The API layer translates to 404.
  * Anything else propagates — Pydantic validation errors stay as
    422s in the API layer's normal exception handling.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.invoice_pattern import InvoicePattern
from app.models.invoice_template import InvoiceTemplate
from app.repositories.invoice_pattern_repo import InvoicePatternRepository
from app.repositories.invoice_template_repo import InvoiceTemplateRepository
from app.schemas.import_resolver import ResolverInput, ResolverResult
from app.schemas.template_pattern_test_runner import (
    TemplatePatternTestResult,
    TemplatePatternTestSummary,
)
from app.services.import_template_resolver import (
    dry_run_resolve_import_template,
)
from app.services.invoice_pattern_resolver_bridge import (
    build_resolver_input_from_invoice_pattern,
)


TEST_RUNNER_SOURCE = "template_pattern_test_runner"
TEST_RUNNER_VERSION = "phase_2b"


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class TemplatePatternTestNotFound(LookupError):
    """Raised when the template or pattern referenced doesn't exist.

    The API layer maps this to HTTP 404. ``kind`` distinguishes
    template-vs-pattern so downstream UIs can render a specific error
    (e.g. "the saved invoice pattern was deleted while you were
    editing this template").
    """

    def __init__(self, kind: str, identifier: UUID | str) -> None:
        self.kind = kind
        self.identifier = str(identifier)
        super().__init__(
            f"Invoice {kind} {self.identifier} not found"
        )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def run_template_pattern_test(
    db: AsyncSession,
    *,
    template_id: UUID,
    pattern_id: UUID,
    manual_fact_values: dict[str, Any] | None = None,
    manual_catalog_hints: dict[str, Any] | None = None,
    include_empty_fields: bool = False,
    runtime_options: dict[str, Any] | None = None,
    document_metadata: dict[str, Any] | None = None,
) -> TemplatePatternTestResult:
    """Run a diagnostic test of one template against one pattern.

    See module docstring for the full pipeline contract.
    """
    template = await _load_template(db, template_id)
    pattern = await _load_pattern(db, pattern_id)

    bridge_input = build_resolver_input_from_invoice_pattern(
        pattern,
        template_id=template_id,
        manual_fact_values=manual_fact_values,
        manual_catalog_hints=manual_catalog_hints,
        include_empty_fields=include_empty_fields,
    )

    # Layer in caller-supplied document_metadata + runner-managed
    # provenance. The merge order protects bridge + runner keys from
    # caller overrides — see _merge_document_metadata.
    enriched_input = _enrich_bridge_input(
        bridge_input,
        template=template,
        runtime_options=runtime_options,
        caller_document_metadata=document_metadata,
    )

    resolver_result = await dry_run_resolve_import_template(
        template, enriched_input, db
    )

    return TemplatePatternTestResult(
        template_id=str(template.id),
        template_name=_safe_str(getattr(template, "name", None)),
        pattern_id=str(pattern.id),
        pattern_name=_safe_str(getattr(pattern, "name", None)),
        diagnostic_only=True,
        bridge_input=enriched_input,
        resolver_result=resolver_result,
        summary=_build_summary(enriched_input, resolver_result),
    )


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------


async def _load_template(db: AsyncSession, template_id: UUID) -> InvoiceTemplate:
    repo = InvoiceTemplateRepository(db)
    row = await repo.get(template_id)
    if row is None:
        raise TemplatePatternTestNotFound("template", template_id)
    return row


async def _load_pattern(db: AsyncSession, pattern_id: UUID) -> InvoicePattern:
    repo = InvoicePatternRepository(db)
    row = await repo.get(pattern_id)
    if row is None:
        raise TemplatePatternTestNotFound("pattern", pattern_id)
    return row


# ---------------------------------------------------------------------------
# Enrichment + merge
# ---------------------------------------------------------------------------


# Bridge-managed keys — caller cannot override these via
# ``document_metadata`` in the request body. Anything the bridge
# emits about the pattern is the source of truth so downstream UIs
# can trust the provenance of the resolver run.
_BRIDGE_PROTECTED_KEYS: frozenset[str] = frozenset(
    {
        "bridge_source",
        "bridge_version",
        "invoice_pattern_id",
        "invoice_pattern_name",
        "vendor_hint",
        "source_file_count",
        "source_file_names",
        "known_pattern_fields",
        "unfilled_pattern_fields",
    }
)

# Runner-managed keys — the test runner ALWAYS writes these, and
# they take precedence over both caller and bridge metadata to give
# downstream consumers a stable provenance hint. ``template_id`` /
# ``template_name`` here are runner-side identifiers (the bridge
# does NOT carry these — it only knows about the pattern).
_RUNNER_KEYS_ORDER: tuple[str, ...] = (
    "test_runner_source",
    "test_runner_version",
    "template_id",
    "template_name",
    "diagnostic_only",
)


def _enrich_bridge_input(
    bridge_input: ResolverInput,
    *,
    template: InvoiceTemplate,
    runtime_options: dict[str, Any] | None,
    caller_document_metadata: dict[str, Any] | None,
) -> ResolverInput:
    """Layer caller + runner metadata onto the bridge output.

    Returns a NEW ``ResolverInput`` rather than mutating the bridge's
    output. The bridge's own metadata + the runner's provenance keys
    take precedence over caller-supplied ``document_metadata``.

    ``runtime_options`` is forwarded onto
    ``ResolverInput.runtime_options`` verbatim (after a defensive
    copy). Today the resolver treats this as opaque scenario context;
    we keep the pass-through cheap so future scenario inputs flow
    without an extra hop.
    """
    bridge_metadata = dict(bridge_input.document_metadata or {})

    runner_metadata = {
        "test_runner_source": TEST_RUNNER_SOURCE,
        "test_runner_version": TEST_RUNNER_VERSION,
        "template_id": str(template.id),
        "template_name": _safe_str(getattr(template, "name", None)),
        "diagnostic_only": True,
    }

    merged_metadata = _merge_document_metadata(
        caller_document_metadata=caller_document_metadata,
        bridge_metadata=bridge_metadata,
        runner_metadata=runner_metadata,
    )

    merged_runtime_options = dict(bridge_input.runtime_options or {})
    if runtime_options:
        # Caller's runtime_options merge ON TOP — the bridge doesn't
        # currently emit any, so this is effectively just a pass-
        # through, but the merge stays explicit so a future bridge
        # version emitting runtime_options doesn't silently lose its
        # values to a careless caller dict.
        merged_runtime_options.update(runtime_options)

    return bridge_input.model_copy(
        update={
            "document_metadata": merged_metadata,
            "runtime_options": merged_runtime_options,
        }
    )


def _merge_document_metadata(
    *,
    caller_document_metadata: dict[str, Any] | None,
    bridge_metadata: dict[str, Any],
    runner_metadata: dict[str, Any],
) -> dict[str, Any]:
    """Merge document_metadata with strict precedence.

    Order (lowest → highest precedence):

      1. Caller — free-form annotations like ``test_run_label``.
      2. Bridge — pattern provenance + structural metadata.
      3. Runner — test runner identifiers + ``diagnostic_only``.

    Caller cannot overwrite bridge-protected keys (we drop those
    from the caller dict before merging) so a buggy / hostile caller
    can't smuggle a fake ``bridge_source`` through to the response.
    Same defense for runner keys.
    """
    out: dict[str, Any] = {}
    if caller_document_metadata:
        for key, value in caller_document_metadata.items():
            if key in _BRIDGE_PROTECTED_KEYS:
                continue
            if key in _RUNNER_KEYS_ORDER:
                continue
            out[key] = value
    # Bridge wins for its own keys (and adds any extras like
    # source_file_names / known_pattern_fields).
    out.update(bridge_metadata)
    # Runner-managed keys ALWAYS win (test_runner_source / _version /
    # template identifiers / diagnostic_only).
    out.update(runner_metadata)
    return out


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


def _build_summary(
    bridge_input: ResolverInput,
    resolver_result: ResolverResult,
) -> TemplatePatternTestSummary:
    """Derive coarse counts from the resolver result + bridge input.

    Defensively reads each summary field — older / partial
    ResolverResult instances might omit some, in which case
    ``getattr(..., 0)`` keeps the response well-shaped.
    """
    summary = resolver_result.summary
    return TemplatePatternTestSummary(
        status=str(resolver_result.status),
        rows=getattr(summary, "row_count", 0) or 0,
        ready=getattr(summary, "ready_rows", 0) or 0,
        needs_review=getattr(summary, "needs_review_rows", 0) or 0,
        blocked=getattr(summary, "blocked_rows", 0) or 0,
        conflict=getattr(summary, "conflict_rows", 0) or 0,
        errors=getattr(summary, "error_count", 0) or 0,
        warnings=getattr(summary, "warning_count", 0) or 0,
        info=getattr(summary, "info_count", 0) or 0,
        extracted_fact_count=len(bridge_input.extracted_facts or []),
        catalog_hint_count=len(bridge_input.catalog_hints or {}),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
