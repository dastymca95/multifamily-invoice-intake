"""
Phase 2A — Invoice Pattern → ResolverInput bridge tests.

These tests exercise the bridge in isolation (no DB session needed —
the bridge only READS attributes off the pattern object) and add one
end-to-end smoke test that pipes bridge output through the import
template resolver to prove the contract is wire-compatible.

Test inputs use the ``InvoicePattern`` ORM model directly (per the
existing resolver test convention of constructing ORM rows in
memory). The bridge tolerates either ORM rows or duck-typed objects;
``SimpleNamespace`` is used in a couple of places to stress the
duck-typed path explicitly.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from app.models.invoice_pattern import InvoicePattern
from app.models.invoice_template import InvoiceTemplate
from app.schemas.import_resolver import CatalogHint, ResolverInput
from app.services.import_template_resolver import (
    dry_run_resolve_import_template,
)
from app.services.invoice_pattern_resolver_bridge import (
    BRIDGE_SOURCE,
    BRIDGE_VERSION,
    build_resolver_input_from_invoice_pattern,
)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _pattern(
    *,
    name: str = "EPB Utility Bill",
    vendor_hint: str | None = None,
    source_files: list[dict] | None = None,
    regions: list[dict] | None = None,
    field_definitions: list[dict] | None = None,
    pattern_id: uuid.UUID | None = None,
) -> InvoicePattern:
    """Build an in-memory ``InvoicePattern`` row.

    No DB session required — the bridge never persists or reads from
    SQLAlchemy state, only attribute access.
    """
    return InvoicePattern(
        id=pattern_id or uuid.uuid4(),
        name=name,
        description=None,
        vendor_hint=vendor_hint,
        source_files=source_files or [],
        regions=regions or [],
        field_definitions=field_definitions or [],
        created_by=None,
    )


def _region(field_key: str, *, source_file_id: str = "f-1", page: int = 1) -> dict:
    return {
        "id": f"r-{field_key}",
        "source_file_id": source_file_id,
        "page": page,
        "bbox": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05},
        "field_key": field_key,
        "shape": "rect",
    }


def _file(file_id: str = "f-1", file_name: str = "epb-sample.pdf") -> dict:
    return {
        "id": file_id,
        "file_name": file_name,
        "mime_type": "application/pdf",
        "size_bytes": 1024,
        "page_count": 1,
        "data_url": "",
    }


# ---------------------------------------------------------------------------
# Test 1 — empty / minimal pattern
# ---------------------------------------------------------------------------


def test_minimal_pattern_returns_resolver_input_with_metadata_only() -> None:
    """No regions, no manual values → safe ResolverInput with metadata.

    The bridge MUST produce a ResolverInput even from a degenerate
    pattern. No fake extracted facts. document_metadata still carries
    pattern id/name + bridge provenance.
    """
    pattern = _pattern(name="Empty pattern")
    out = build_resolver_input_from_invoice_pattern(pattern)

    assert isinstance(out, ResolverInput)
    assert out.extracted_facts == []
    assert out.catalog_hints == {}
    # Metadata always populated.
    assert out.document_metadata["bridge_source"] == BRIDGE_SOURCE
    assert out.document_metadata["bridge_version"] == BRIDGE_VERSION
    assert out.document_metadata["invoice_pattern_id"] == str(pattern.id)
    assert out.document_metadata["invoice_pattern_name"] == "Empty pattern"
    assert out.document_metadata["vendor_hint"] is None
    assert out.document_metadata["source_file_count"] == 0
    assert out.document_metadata["source_file_names"] == []
    assert out.document_metadata["known_pattern_fields"] == []
    # PatternMatch entry for the explicit selection.
    assert len(out.pattern_matches) == 1
    pm = out.pattern_matches[0]
    assert pm.pattern_id == str(pattern.id)
    assert pm.pattern_label == "Empty pattern"
    assert pm.confidence == 1.0
    assert pm.reason == "manual_selection"


# ---------------------------------------------------------------------------
# Test 2 — pattern.vendor_hint maps onto catalog_hints.vendor.text
# ---------------------------------------------------------------------------


def test_pattern_vendor_hint_maps_to_vendor_catalog_hint() -> None:
    pattern = _pattern(vendor_hint="EPB")
    out = build_resolver_input_from_invoice_pattern(pattern)

    assert "vendor" in out.catalog_hints
    assert out.catalog_hints["vendor"].text == "EPB"
    assert out.catalog_hints["vendor"].entry_id is None
    assert out.document_metadata["vendor_hint"] == "EPB"


# ---------------------------------------------------------------------------
# Test 3 — manual fact values become ExtractedFact rows
# ---------------------------------------------------------------------------


def test_manual_fact_values_become_extracted_facts() -> None:
    """Operator-supplied values land as ExtractedFact rows with
    source_type=manual, confidence=1.0, normalized field key, and a
    pattern_id back-reference."""
    pattern_id = uuid.uuid4()
    pattern = _pattern(pattern_id=pattern_id, name="Test")
    out = build_resolver_input_from_invoice_pattern(
        pattern,
        manual_fact_values={
            "invoice_number": "12345",
            "invoice_date": "2026-04-10",
            "total_amount": "155.25",
        },
    )

    assert len(out.extracted_facts) == 3
    by_key = {f.field_key: f for f in out.extracted_facts}
    assert by_key["invoice_number"].value == "12345"
    assert by_key["invoice_number"].source_type == "manual"
    assert by_key["invoice_number"].confidence == 1.0
    assert by_key["invoice_number"].pattern_id == str(pattern_id)
    # ExtractedFact's own validator computes normalized_field_key from
    # the registry — we don't pre-fill it in the bridge.
    assert by_key["invoice_number"].normalized_field_key == "invoice_number"
    assert by_key["total_amount"].normalized_field_key == "total_amount"


def test_blank_and_none_manual_fact_values_are_skipped() -> None:
    """Empty strings / None must NOT produce empty facts — the
    resolver treats blank values as "missing" and we don't want to
    spam dry-run with synthetic missing diagnostics for fields the
    operator clearly didn't fill in.
    """
    pattern = _pattern()
    out = build_resolver_input_from_invoice_pattern(
        pattern,
        manual_fact_values={
            "invoice_number": "12345",
            "blank_value": "",
            "whitespace_only": "   ",
            "none_value": None,
        },
    )
    keys = {f.field_key for f in out.extracted_facts}
    assert keys == {"invoice_number"}


# ---------------------------------------------------------------------------
# Test 4 — alias normalization through the shared registry
# ---------------------------------------------------------------------------


def test_legacy_alias_amount_normalizes_to_total_amount() -> None:
    """``amount`` is a registered legacy alias for ``total_amount``;
    the resolver's own normalization handles it. The bridge MUST
    preserve the raw key so the registry lookup runs unchanged."""
    pattern = _pattern()
    out = build_resolver_input_from_invoice_pattern(
        pattern,
        manual_fact_values={"amount": "99.50", "invoice_no": "ABC"},
    )
    by_raw = {f.field_key: f for f in out.extracted_facts}
    # Raw keys preserved so trace / Dry Run still display what the
    # operator typed.
    assert by_raw["amount"].field_key == "amount"
    # ExtractedFact's validator normalizes via the registry.
    assert by_raw["amount"].normalized_field_key == "total_amount"
    assert by_raw["invoice_no"].normalized_field_key == "invoice_number"


# ---------------------------------------------------------------------------
# Test 5 — manual catalog hints accept strings AND dicts
# ---------------------------------------------------------------------------


def test_manual_catalog_hints_string_form_becomes_text_hint() -> None:
    pattern = _pattern()
    out = build_resolver_input_from_invoice_pattern(
        pattern,
        manual_catalog_hints={
            "vendor": "EPB",
            "property": "ADM",
            "gl": "6915",
        },
    )
    assert out.catalog_hints["vendor"].text == "EPB"
    assert out.catalog_hints["property"].text == "ADM"
    assert out.catalog_hints["gl"].text == "6915"


def test_manual_catalog_hints_dict_form_passes_entry_id_and_text() -> None:
    pattern = _pattern()
    out = build_resolver_input_from_invoice_pattern(
        pattern,
        manual_catalog_hints={
            "vendor": {"text": "EPB", "entry_id": "vendor-1"},
            "property": {"text": "ADM"},
            "gl": {"entry_id": "gl-7", "field_values": {"code": "6915"}},
        },
    )
    assert out.catalog_hints["vendor"].text == "EPB"
    assert out.catalog_hints["vendor"].entry_id == "vendor-1"
    assert out.catalog_hints["property"].text == "ADM"
    assert out.catalog_hints["gl"].entry_id == "gl-7"
    assert out.catalog_hints["gl"].field_values == {"code": "6915"}


def test_manual_catalog_hints_unknown_kinds_are_dropped() -> None:
    """Unknown kinds must be silently dropped to keep the wire payload
    well-shaped — we don't smuggle through arbitrary keys."""
    pattern = _pattern()
    out = build_resolver_input_from_invoice_pattern(
        pattern,
        manual_catalog_hints={"nonsense_kind": "value", "vendor": "EPB"},
    )
    assert set(out.catalog_hints.keys()) == {"vendor"}


def test_manual_catalog_hints_empty_value_dropped() -> None:
    pattern = _pattern()
    out = build_resolver_input_from_invoice_pattern(
        pattern,
        manual_catalog_hints={"vendor": "  ", "property": {}, "gl": None},
    )
    assert out.catalog_hints == {}


# ---------------------------------------------------------------------------
# Test 6 — manual vendor hint overrides pattern.vendor_hint
# ---------------------------------------------------------------------------


def test_manual_vendor_hint_overrides_pattern_vendor_hint() -> None:
    pattern = _pattern(vendor_hint="Old Vendor")
    out = build_resolver_input_from_invoice_pattern(
        pattern,
        manual_catalog_hints={"vendor": "EPB"},
    )
    assert out.catalog_hints["vendor"].text == "EPB"


def test_pattern_vendor_hint_kept_when_manual_vendor_absent() -> None:
    """If only property is provided manually, pattern's vendor hint
    must still flow through. Override is per-kind, not all-or-nothing."""
    pattern = _pattern(vendor_hint="EPB")
    out = build_resolver_input_from_invoice_pattern(
        pattern,
        manual_catalog_hints={"property": "ADM"},
    )
    assert out.catalog_hints["vendor"].text == "EPB"
    assert out.catalog_hints["property"].text == "ADM"


# ---------------------------------------------------------------------------
# Test 7 — known_pattern_fields metadata
# ---------------------------------------------------------------------------


def test_document_metadata_known_pattern_fields_lists_region_keys() -> None:
    """Region field keys + custom field_definitions feed into
    document_metadata.known_pattern_fields. Built-in field_definitions
    (overrides only) do NOT — they're not new fields, just visual
    overrides of canonical ones."""
    pattern = _pattern(
        source_files=[_file()],
        regions=[
            _region("invoice_number"),
            _region("invoice_date"),
            _region("total_amount"),
            # A region keyed to an operator-coined custom field —
            # surfaces even without a field_definitions row (some
            # legacy patterns may have orphan region keys).
            _region("custom_meter_serial"),
        ],
        field_definitions=[
            # Built-in override: NOT a new field, must not appear as
            # a known field.
            {
                "key": "invoice_number",
                "label": "Invoice #",
                "type": "built_in",
                "color": "#ff0000",
                "hidden": False,
            },
            # Custom field WITHOUT a matching region — should still
            # surface so downstream UI can show "this pattern can
            # produce <X> if you draw a region".
            {
                "key": "service_address",
                "label": "Service Address",
                "type": "custom",
                "color": None,
                "hidden": False,
            },
        ],
    )
    out = build_resolver_input_from_invoice_pattern(pattern)
    known = out.document_metadata["known_pattern_fields"]
    # Canonical region keys come first, in registry order.
    assert known[:3] == ["invoice_number", "invoice_date", "total_amount"]
    # Then non-canonical region keys + customs (alphabetical within
    # each bucket).
    assert "custom_meter_serial" in known
    assert "service_address" in known
    # Built-in overrides do NOT add new entries.
    assert known.count("invoice_number") == 1


def test_known_pattern_fields_dedupes_repeated_region_keys() -> None:
    """A pattern may pin the SAME canonical field on multiple training
    docs. The bridge MUST dedupe so downstream UI doesn't show the
    same key twice."""
    pattern = _pattern(
        source_files=[_file("f-1"), _file("f-2", file_name="alt.pdf")],
        regions=[
            _region("account_number", source_file_id="f-1"),
            _region("account_number", source_file_id="f-2"),
        ],
    )
    out = build_resolver_input_from_invoice_pattern(pattern)
    assert out.document_metadata["known_pattern_fields"] == ["account_number"]


def test_source_file_names_extracted_from_pattern() -> None:
    pattern = _pattern(
        source_files=[
            _file("f-1", file_name="epb-2024-q1.pdf"),
            _file("f-2", file_name="epb-2024-q2.pdf"),
        ]
    )
    out = build_resolver_input_from_invoice_pattern(pattern)
    assert out.document_metadata["source_file_count"] == 2
    assert out.document_metadata["source_file_names"] == [
        "epb-2024-q1.pdf",
        "epb-2024-q2.pdf",
    ]


# ---------------------------------------------------------------------------
# Test 8 — PatternMatch is included
# ---------------------------------------------------------------------------


def test_pattern_match_entry_is_emitted_for_explicit_selection() -> None:
    pattern_id = uuid.uuid4()
    pattern = _pattern(pattern_id=pattern_id, name="EPB")
    out = build_resolver_input_from_invoice_pattern(pattern)
    assert len(out.pattern_matches) == 1
    pm = out.pattern_matches[0]
    assert pm.pattern_id == str(pattern_id)
    assert pm.pattern_label == "EPB"
    assert pm.confidence == 1.0
    assert pm.matched is True
    assert pm.reason == "manual_selection"


# ---------------------------------------------------------------------------
# include_empty_fields advisory metadata
# ---------------------------------------------------------------------------


def test_include_empty_fields_surfaces_unfilled_pattern_fields() -> None:
    """Pattern declares regions for invoice_number + invoice_date.
    Operator only fills invoice_number. With include_empty_fields=True
    the bridge surfaces invoice_date in unfilled_pattern_fields —
    NEVER as a fake ExtractedFact."""
    pattern = _pattern(
        source_files=[_file()],
        regions=[
            _region("invoice_number"),
            _region("invoice_date"),
            _region("total_amount"),
        ],
    )
    out = build_resolver_input_from_invoice_pattern(
        pattern,
        manual_fact_values={"invoice_number": "ABC"},
        include_empty_fields=True,
    )
    # invoice_number is filled in by the operator; the other two should
    # surface as unfilled.
    unfilled = out.document_metadata["unfilled_pattern_fields"]
    assert "invoice_date" in unfilled
    assert "total_amount" in unfilled
    assert "invoice_number" not in unfilled
    # Unfilled fields MUST NOT become fake ExtractedFact rows.
    assert {f.field_key for f in out.extracted_facts} == {"invoice_number"}


def test_include_empty_fields_default_false_omits_unfilled_metadata() -> None:
    pattern = _pattern(
        source_files=[_file()],
        regions=[_region("invoice_number")],
    )
    out = build_resolver_input_from_invoice_pattern(pattern)
    assert "unfilled_pattern_fields" not in out.document_metadata


# ---------------------------------------------------------------------------
# template_id forwarding
# ---------------------------------------------------------------------------


def test_template_id_uuid_normalizes_to_string() -> None:
    pattern = _pattern()
    template_uuid = uuid.uuid4()
    out = build_resolver_input_from_invoice_pattern(
        pattern, template_id=template_uuid
    )
    assert out.template_id == str(template_uuid)


def test_template_id_string_passes_through_unchanged() -> None:
    pattern = _pattern()
    out = build_resolver_input_from_invoice_pattern(
        pattern, template_id="abc-123"
    )
    assert out.template_id == "abc-123"


def test_template_id_omitted_stays_none() -> None:
    pattern = _pattern()
    out = build_resolver_input_from_invoice_pattern(pattern)
    assert out.template_id is None


# ---------------------------------------------------------------------------
# Duck-typed pattern object (covers the SimpleNamespace branch)
# ---------------------------------------------------------------------------


def test_bridge_accepts_duck_typed_pattern_object() -> None:
    """The bridge contract says it tolerates any object exposing the
    expected attributes — covers future use cases like an unsaved
    pattern carried via Pydantic."""
    pattern = SimpleNamespace(
        id=uuid.uuid4(),
        name="Duck-typed pattern",
        vendor_hint="EPB",
        source_files=[_file(file_name="duck.pdf")],
        regions=[_region("invoice_number")],
        field_definitions=[],
    )
    out = build_resolver_input_from_invoice_pattern(pattern)
    assert out.catalog_hints["vendor"].text == "EPB"
    assert out.document_metadata["source_file_names"] == ["duck.pdf"]
    assert out.document_metadata["known_pattern_fields"] == [
        "invoice_number"
    ]
    assert out.pattern_matches[0].pattern_label == "Duck-typed pattern"


# ---------------------------------------------------------------------------
# Integration smoke test — bridge output is resolver-compatible
# ---------------------------------------------------------------------------


def _import_template_with_invoice_number_required() -> InvoiceTemplate:
    return InvoiceTemplate(
        id=uuid.uuid4(),
        name="Bridge integration test template",
        description=None,
        columns=[
            {
                "id": "invoice_number",
                "name": "Invoice Number",
                "required": True,
                "data_type": "text",
                "source_type": "invoice_field",
                "source_ref": {"field": "invoice_number"},
                "allow_rule_override": True,
                "default_rule_role": None,
            }
        ],
        rules=[],
        source="custom",
    )


@pytest.mark.asyncio
async def test_bridge_output_resolves_required_invoice_field_via_dry_run() -> None:
    """End-to-end: bridge ingests a manual invoice_number value and
    the resolver dry-run resolves a required Invoice Number column to
    "ready". Proves the wire shape (extracted_facts, source_type,
    normalization) actually flows through the resolver, not just the
    Pydantic models."""
    pattern = _pattern(
        source_files=[_file()],
        regions=[_region("invoice_number")],
        vendor_hint="EPB",
    )
    resolver_input = build_resolver_input_from_invoice_pattern(
        pattern,
        manual_fact_values={"invoice_number": "INV-12345"},
    )
    template = _import_template_with_invoice_number_required()

    result = await dry_run_resolve_import_template(template, resolver_input)

    # The required Invoice Number column resolves to ready because the
    # bridge surfaced the manual value as an ExtractedFact.
    assert result.rows[0].status == "ready"
    cell = next(c for c in result.rows[0].cells if c.column_id == "invoice_number")
    assert cell.value == "INV-12345"
    assert cell.status == "resolved"


@pytest.mark.asyncio
async def test_bridge_legacy_alias_resolves_through_dry_run() -> None:
    """``amount`` (legacy alias) flows through the bridge → resolver
    → resolves a required Amount column bound to ``total_amount``.
    Mirrors the existing
    ``test_extracted_fact_alias_satisfies_invoice_field_baseline`` test
    in the resolver suite, but driven through the bridge instead of a
    hand-built ResolverInput."""
    pattern = _pattern(regions=[_region("total_amount")])
    resolver_input = build_resolver_input_from_invoice_pattern(
        pattern, manual_fact_values={"amount": "99.50"}
    )
    template = InvoiceTemplate(
        id=uuid.uuid4(),
        name="Alias-bridge",
        description=None,
        columns=[
            {
                "id": "amount",
                "name": "Amount",
                "required": True,
                "data_type": "currency",
                "source_type": "invoice_field",
                "source_ref": {"field": "total_amount"},
                "allow_rule_override": True,
                "default_rule_role": None,
            }
        ],
        rules=[],
        source="custom",
    )
    result = await dry_run_resolve_import_template(template, resolver_input)
    assert result.rows[0].status == "ready"
    cell = next(c for c in result.rows[0].cells if c.column_id == "amount")
    assert cell.normalized_value == 99.50
    assert cell.provenance.normalized_field_key == "total_amount"


# ---------------------------------------------------------------------------
# Additional defensive cases
# ---------------------------------------------------------------------------


def test_bridge_returns_catalog_hint_instances_not_dicts() -> None:
    """The resolver expects ``CatalogHint`` instances inside
    ``catalog_hints``. Make sure the bridge actually constructs them
    (vs. leaving raw dicts on the wire path)."""
    pattern = _pattern(vendor_hint="EPB")
    out = build_resolver_input_from_invoice_pattern(pattern)
    assert isinstance(out.catalog_hints["vendor"], CatalogHint)


def test_bridge_does_not_mutate_pattern_inputs() -> None:
    """The bridge must be side-effect free — no mutation of the
    pattern's lists / dicts. Critical because the API endpoint passes
    the live ORM row, which is held in the SQLAlchemy session."""
    region_payload = _region("invoice_number")
    file_payload = _file()
    field_def = {
        "key": "service_address",
        "label": "Service Address",
        "type": "custom",
        "color": None,
        "hidden": False,
    }
    pattern = _pattern(
        source_files=[file_payload],
        regions=[region_payload],
        field_definitions=[field_def],
        vendor_hint="EPB",
    )
    snapshot_files = list(pattern.source_files)
    snapshot_regions = list(pattern.regions)
    snapshot_defs = list(pattern.field_definitions)
    build_resolver_input_from_invoice_pattern(
        pattern,
        manual_fact_values={"invoice_number": "X"},
        manual_catalog_hints={"vendor": "EPB"},
    )
    assert pattern.source_files == snapshot_files
    assert pattern.regions == snapshot_regions
    assert pattern.field_definitions == snapshot_defs
    # And the items themselves weren't mutated.
    assert region_payload["field_key"] == "invoice_number"
    assert file_payload["file_name"] == "epb-sample.pdf"
    assert field_def["key"] == "service_address"
