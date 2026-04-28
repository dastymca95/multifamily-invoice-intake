"""
Phase 2A — Invoice Pattern → ResolverInput bridge schemas.

Tiny request-body wrapper for
``POST /invoice-patterns/{pattern_id}/resolver-input-preview``. The
endpoint returns ``ResolverInput`` (already declared in
``app/schemas/import_resolver.py``) so the response type doesn't live
here.

The bridge contract intentionally accepts only OPERATOR-supplied
inputs:

  * ``template_id`` — echoed onto ``ResolverInput.template_id`` so a
    later phase can hand the bridge output straight to the dry-run
    endpoint without an extra round-trip.
  * ``manual_fact_values`` — a dict of ``field_key → value`` the
    operator typed in the "Test with sample invoice" surface (Phase
    2B). Values become ``ExtractedFact`` rows with
    ``source_type="manual"``. Fields are normalized through the
    shared extracted-field registry so legacy aliases (``amount``,
    ``invoice_no``, etc.) flow correctly.
  * ``manual_catalog_hints`` — a dict of ``kind → hint`` where ``kind``
    is one of ``vendor``/``property``/``gl`` and ``hint`` is either a
    free-text string or a ``CatalogHint``-shaped dict.
    ``manual_catalog_hints.vendor`` overrides the pattern's
    ``vendor_hint``.
  * ``include_empty_fields`` — when True, the bridge surfaces fields
    declared on the pattern (regions / custom field_definitions) for
    which there is no value as advisory-only metadata. Default False
    avoids polluting the resolver with empty noise.

This phase NEVER does real OCR or AI extraction. The bridge only
maps OPERATOR INTENT (manual values + catalog hints) and pattern
STRUCTURE (known field keys, vendor hint) into a
resolver-compatible ``ResolverInput``.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ResolverInputPreviewRequest(BaseModel):
    """Request body for the resolver-input preview endpoint.

    All four fields are optional — posting ``{}`` is valid and yields
    a ResolverInput populated only from the pattern's structural
    metadata (known field keys + vendor hint).
    """

    # Echoed onto ResolverInput.template_id so a Phase 2B "test
    # template with this pattern" flow can pipe the response straight
    # into the dry-run endpoint. Bridge does NOT load the template
    # itself — it just carries the id forward.
    template_id: str | None = None
    # Operator-typed canonical-field values. Normalized through the
    # shared registry, so {"amount": "123.45"} maps to
    # ExtractedFact(field_key="amount", normalized_field_key="total_amount").
    manual_fact_values: dict[str, Any] | None = None
    # Operator-supplied catalog hints. Keyed by kind:
    # vendor / property / gl. Values may be strings (treated as
    # CatalogHint(text=...)) or full dicts (entry_id / text /
    # field_values). Vendor hint overrides pattern.vendor_hint.
    manual_catalog_hints: dict[str, Any] | None = None
    # When True, surface known-but-unfilled pattern field keys via
    # document_metadata.unfilled_pattern_fields (informational only —
    # never as fake ExtractedFact rows).
    include_empty_fields: bool = Field(default=False)
