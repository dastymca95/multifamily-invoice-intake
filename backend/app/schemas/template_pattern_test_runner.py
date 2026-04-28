"""
Phase 2B — Template + Pattern Test Runner schemas.

The test runner endpoint chains the Phase 2A bridge with the existing
import-template dry-run resolver into a single read-only diagnostic
surface. This module owns the request body the endpoint accepts and
the response envelope that wraps the bridge input + resolver result
+ a derived summary.

Reuses ``ResolverInput`` / ``ResolverResult`` from
``app/schemas/import_resolver.py`` rather than re-declaring those
shapes — the test runner is purely a composer, never re-defines
the contracts it composes.

Diagnostic-only contract:

  * Never persists.
  * Never exports.
  * Never enqueues review work.
  * Never calls OCR / AI.
  * Never reads PDF bytes.

The ``diagnostic_only`` field on the response is a hard-True
constant so downstream UI surfaces (and a future read-back caller)
can assert the contract at parse time.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.schemas.import_resolver import ResolverInput, ResolverResult


class TemplatePatternTestRequest(BaseModel):
    """Request body for the test-runner endpoint.

    Every field is optional — posting ``{}`` is valid and yields a
    test run that uses only the pattern's structural metadata + the
    template's saved configuration. The fields mirror the Phase 2A
    bridge inputs plus two pass-through bags for runtime context the
    operator wants the resolver to see.
    """

    # Operator-typed canonical-field values. Bridge converts each into
    # an ExtractedFact with source_type=manual, confidence=1.0.
    manual_fact_values: dict[str, Any] | None = None
    # Operator-typed catalog hints (vendor / property / gl). Override
    # the pattern's own vendor_hint per kind.
    manual_catalog_hints: dict[str, Any] | None = None
    # When True, surfaces pattern field keys without a manual value as
    # ``document_metadata.unfilled_pattern_fields`` (advisory — never
    # as fake ExtractedFact rows).
    include_empty_fields: bool = Field(default=False)
    # Forwarded onto ``ResolverInput.runtime_options``. The resolver
    # currently treats this as opaque scenario context; reserved for
    # phase-2+ scenario inputs.
    runtime_options: dict[str, Any] | None = None
    # Optional caller-supplied document metadata to merge into the
    # bridge's metadata bag. Useful for free-form annotations like
    # ``{"test_run_label": "Q3 review"}``. Keys colliding with bridge
    # metadata (bridge_source, bridge_version, invoice_pattern_id /
    # _name, vendor_hint, source_file_count / _names,
    # known_pattern_fields) and runner-managed metadata
    # (test_runner_source / _version, template_id / _name,
    # diagnostic_only) are OVERRIDDEN by the bridge / runner so the
    # caller can never confuse provenance downstream.
    document_metadata: dict[str, Any] | None = None


class TemplatePatternTestSummary(BaseModel):
    """Coarse aggregate counts for the test run.

    Always populated. Mirrors the resolver's own per-row /
    per-severity counts plus two bridge-side counts (extracted facts
    + catalog hints actually emitted) so a UI summary card can show
    "ran with N facts and M catalog hints" without re-walking the
    response body.
    """

    status: str
    rows: int = 0
    ready: int = 0
    needs_review: int = 0
    blocked: int = 0
    conflict: int = 0
    errors: int = 0
    warnings: int = 0
    info: int = 0
    extracted_fact_count: int = 0
    catalog_hint_count: int = 0


class TemplatePatternTestResult(BaseModel):
    """Top-level response envelope.

    Carries the bridge input + resolver result side-by-side so a
    consumer can inspect both. ``bridge_input`` is the EXACT payload
    that was fed to the resolver — useful for debugging the "why
    didn't this resolve?" question without a separate bridge-preview
    round-trip.

    ``diagnostic_only`` is hard-True at construction time. The field
    is here (not in a comment) so Pydantic includes it in the JSON
    payload — operators / future surfaces can always inspect it
    directly off the response.
    """

    template_id: str
    template_name: str | None = None
    pattern_id: str
    pattern_name: str | None = None
    diagnostic_only: bool = True
    bridge_input: ResolverInput
    resolver_result: ResolverResult
    summary: TemplatePatternTestSummary
