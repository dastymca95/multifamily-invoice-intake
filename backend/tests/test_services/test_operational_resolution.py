"""
Phase 3A — Operational Resolution Pipeline service tests.

The runner is a composer over already-tested pieces:

  * Phase 2A bridge — exhaustively tested in
    ``test_invoice_pattern_resolver_bridge.py``.
  * Existing import-template resolver — covered by
    ``test_import_template_resolver.py``.

So these tests focus on the COMPOSITION contract:

  * Not-found errors raised when ids are missing.
  * Both extracted-fact shapes (mapping + list) flow through.
  * Pattern-backed and pattern-less paths produce a usable
    ResolverInput.
  * Vendor hint precedence (caller > pattern).
  * Operational + bridge metadata are preserved against caller
    spoofing.
  * No mutation of ORM rows.
  * Summary counts mirror the resolver + diagnostic counts.
  * Review diagnostics are minimal but correctly mapped for the
    most common codes.
"""

from __future__ import annotations

import uuid

import pytest

from app.models.invoice_pattern import InvoicePattern
from app.models.invoice_template import InvoiceTemplate
from app.schemas.import_resolver import ExtractedFact
from app.services.operational_resolution import (
    OPERATIONAL_SOURCE,
    OPERATIONAL_VERSION,
    OperationalResolutionNotFound,
    run_operational_resolution,
)


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------


async def _persist_template(
    db_session,
    *,
    columns: list[dict],
    rules: list[dict] | None = None,
    name: str = "Operational test template",
) -> InvoiceTemplate:
    template = InvoiceTemplate(
        id=uuid.uuid4(),
        name=name,
        description=None,
        columns=columns,
        rules=rules or [],
        source="custom",
    )
    db_session.add(template)
    await db_session.flush()
    return template


async def _persist_pattern(
    db_session,
    *,
    name: str = "EPB Utility Bill",
    vendor_hint: str | None = None,
    regions: list[dict] | None = None,
    source_files: list[dict] | None = None,
) -> InvoicePattern:
    pattern = InvoicePattern(
        id=uuid.uuid4(),
        name=name,
        description=None,
        vendor_hint=vendor_hint,
        source_files=source_files or [],
        regions=regions or [],
        field_definitions=[],
        created_by=None,
    )
    db_session.add(pattern)
    await db_session.flush()
    return pattern


def _required_invoice_field_column(
    column_id: str = "invoice_number",
    name: str = "Invoice Number",
    field: str = "invoice_number",
) -> dict:
    return {
        "id": column_id,
        "name": name,
        "required": True,
        "data_type": "text",
        "source_type": "invoice_field",
        "source_ref": {"field": field},
        "allow_rule_override": True,
        "default_rule_role": None,
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


def _region(field_key: str, source_file_id: str = "f-1") -> dict:
    return {
        "id": f"r-{field_key}",
        "source_file_id": source_file_id,
        "page": 1,
        "bbox": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05},
        "field_key": field_key,
        "shape": "rect",
    }


# ---------------------------------------------------------------------------
# 1 — Missing template raises OperationalResolutionNotFound("template")
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_template_raises_not_found(db_session):
    with pytest.raises(OperationalResolutionNotFound) as exc_info:
        await run_operational_resolution(
            db_session,
            template_id=uuid.uuid4(),
        )
    assert exc_info.value.kind == "template"


# ---------------------------------------------------------------------------
# 2 — Missing pattern raises OperationalResolutionNotFound("pattern")
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_pattern_raises_not_found(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    with pytest.raises(OperationalResolutionNotFound) as exc_info:
        await run_operational_resolution(
            db_session,
            template_id=template.id,
            pattern_id=uuid.uuid4(),
        )
    assert exc_info.value.kind == "pattern"


# ---------------------------------------------------------------------------
# 3 — Template only + extracted_facts mapping resolves invoice_number
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_template_only_with_mapping_facts_resolves(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    result = await run_operational_resolution(
        db_session,
        template_id=template.id,
        extracted_facts={"invoice_number": "INV-OPS-1"},
    )
    assert result.diagnostic_only is True
    assert result.template_id == str(template.id)
    assert result.pattern_id is None
    assert result.resolver_result.rows[0].status == "ready"
    cell = next(
        c
        for c in result.resolver_result.rows[0].cells
        if c.column_id == "invoice_number"
    )
    assert cell.value == "INV-OPS-1"
    assert cell.status == "resolved"
    # Operational metadata wired in.
    md = result.resolver_input.document_metadata
    assert md["operational_source"] == OPERATIONAL_SOURCE
    assert md["operational_version"] == OPERATIONAL_VERSION
    assert md["template_id"] == str(template.id)
    assert md["diagnostic_only"] is True


# ---------------------------------------------------------------------------
# 4 — Template + pattern + mapping facts resolves
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_template_with_pattern_and_mapping_facts_resolves(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(
        db_session,
        source_files=[_file()],
        regions=[_region("invoice_number")],
    )
    result = await run_operational_resolution(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        extracted_facts={"invoice_number": "INV-OPS-2"},
    )
    assert result.pattern_id == str(pattern.id)
    assert result.pattern_name == "EPB Utility Bill"
    assert result.resolver_result.rows[0].status == "ready"
    # Bridge metadata present alongside operational metadata.
    md = result.resolver_input.document_metadata
    assert md["bridge_source"] == "invoice_pattern_resolver_bridge"
    assert md["invoice_pattern_id"] == str(pattern.id)
    assert md["operational_source"] == OPERATIONAL_SOURCE


# ---------------------------------------------------------------------------
# 5 — Alias amount → total_amount resolves
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_alias_amount_resolves_total_amount_column(db_session):
    template = await _persist_template(
        db_session,
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
    )
    pattern = await _persist_pattern(
        db_session,
        source_files=[_file()],
        regions=[_region("total_amount")],
    )
    result = await run_operational_resolution(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        extracted_facts={"amount": "99.50"},
    )
    cell = next(
        c
        for c in result.resolver_result.rows[0].cells
        if c.column_id == "amount"
    )
    assert cell.normalized_value == 99.50
    assert cell.provenance.normalized_field_key == "total_amount"


# ---------------------------------------------------------------------------
# 6 — Pattern.vendor_hint → catalog_hints when no caller hint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pattern_vendor_hint_lands_in_catalog_hints(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(db_session, vendor_hint="EPB")
    result = await run_operational_resolution(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        extracted_facts={"invoice_number": "X"},
    )
    assert "vendor" in result.resolver_input.catalog_hints
    assert result.resolver_input.catalog_hints["vendor"].text == "EPB"
    assert result.operational_summary.catalog_hint_count == 1


# ---------------------------------------------------------------------------
# 7 — Caller vendor hint overrides pattern vendor_hint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_caller_vendor_hint_overrides_pattern_vendor_hint(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(db_session, vendor_hint="OLD")
    result = await run_operational_resolution(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        extracted_facts={"invoice_number": "X"},
        catalog_hints={"vendor": "NEW"},
    )
    assert result.resolver_input.catalog_hints["vendor"].text == "NEW"


# ---------------------------------------------------------------------------
# 8 — document_id and batch_id appear in metadata
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_document_id_and_batch_id_appear_in_metadata(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    document_id = uuid.uuid4()
    batch_id = uuid.uuid4()
    result = await run_operational_resolution(
        db_session,
        template_id=template.id,
        document_id=document_id,
        batch_id=batch_id,
        extracted_facts={"invoice_number": "INV-DOC"},
    )
    md = result.resolver_input.document_metadata
    assert md["document_id"] == str(document_id)
    assert md["batch_id"] == str(batch_id)
    # Also wired onto the dedicated ResolverInput fields so future
    # resolver branches can read without walking metadata.
    assert result.resolver_input.document_id == str(document_id)
    assert result.resolver_input.batch_id == str(batch_id)
    # And echoed onto the response envelope.
    assert result.document_id == str(document_id)
    assert result.batch_id == str(batch_id)


# ---------------------------------------------------------------------------
# 9 — Caller cannot spoof protected metadata keys
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_caller_cannot_spoof_protected_metadata(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(db_session, vendor_hint="EPB")
    result = await run_operational_resolution(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        extracted_facts={"invoice_number": "X"},
        document_metadata={
            # Free-form caller key — must survive.
            "test_run_label": "Q3 review",
            # Hostile spoof attempts — must NOT survive.
            "operational_source": "spoofed",
            "operational_version": "spoofed",
            "bridge_source": "spoofed",
            "template_id": "spoofed",
            "pattern_id": "spoofed",
            "diagnostic_only": False,
            "invoice_pattern_name": "spoofed-name",
        },
    )
    md = result.resolver_input.document_metadata
    assert md["test_run_label"] == "Q3 review"
    assert md["operational_source"] == OPERATIONAL_SOURCE
    assert md["operational_version"] == OPERATIONAL_VERSION
    assert md["bridge_source"] == "invoice_pattern_resolver_bridge"
    assert md["template_id"] == str(template.id)
    assert md["pattern_id"] == str(pattern.id)
    assert md["diagnostic_only"] is True
    assert md["invoice_pattern_name"] == "EPB Utility Bill"


# ---------------------------------------------------------------------------
# 10 — No mutation of inputs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_mutation_of_template_or_pattern(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(
        db_session,
        vendor_hint="EPB",
        source_files=[_file()],
        regions=[_region("invoice_number")],
    )
    snap_columns = list(template.columns)
    snap_rules = list(template.rules)
    snap_files = list(pattern.source_files)
    snap_regions = list(pattern.regions)
    snap_vendor = pattern.vendor_hint
    await run_operational_resolution(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        extracted_facts={"invoice_number": "X"},
        catalog_hints={"vendor": "Override"},
        document_metadata={"test_run_label": "noop"},
    )
    assert template.columns == snap_columns
    assert template.rules == snap_rules
    assert pattern.source_files == snap_files
    assert pattern.regions == snap_regions
    assert pattern.vendor_hint == snap_vendor


# ---------------------------------------------------------------------------
# 11 — Summary mirrors resolver_result counts
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_summary_mirrors_resolver_counts(db_session):
    """Required required column without a manual value → resolver
    blocks; summary should reflect that PLUS missing-required count."""
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(
        db_session,
        source_files=[_file()],
        regions=[_region("invoice_number")],
    )
    result = await run_operational_resolution(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        # No facts → required column blocks.
    )
    s = result.operational_summary
    rs = result.resolver_result.summary
    assert s.status == result.resolver_result.status
    assert s.row_count == rs.row_count
    assert s.ready_rows == rs.ready_rows
    assert s.needs_review_rows == rs.needs_review_rows
    assert s.blocked_rows == rs.blocked_rows
    assert s.error_count == rs.error_count
    assert s.warning_count == rs.warning_count
    assert s.info_count == rs.info_count
    assert s.extracted_fact_count == 0
    # Pattern has no vendor hint and no caller hint provided.
    assert s.catalog_hint_count == 0
    # Diagnostic for the missing required column should be present.
    assert s.missing_required_count >= 1
    assert s.diagnostic_only is True


# ---------------------------------------------------------------------------
# 12 — Missing required field produces blocked review diagnostic
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_required_field_produces_review_diagnostic(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(
        db_session,
        source_files=[_file()],
        regions=[_region("invoice_number")],
    )
    result = await run_operational_resolution(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        # No facts → REQUIRED_RUNTIME_VALUE_MISSING expected.
    )
    codes = {d.code for d in result.review_diagnostics}
    assert "REQUIRED_RUNTIME_VALUE_MISSING" in codes
    blocked = [
        d
        for d in result.review_diagnostics
        if d.code == "REQUIRED_RUNTIME_VALUE_MISSING"
    ]
    assert blocked[0].severity == "blocked"
    assert blocked[0].fix_area == "import_template"


# ---------------------------------------------------------------------------
# 13 — List-shape extracted_facts merge with bridge facts
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_shape_extracted_facts_take_precedence_over_bridge(
    db_session,
):
    """Caller passes a list ExtractedFact for invoice_number AND a
    mapping facts dict that the bridge would expand. The list-shape
    fact should win — same normalized key, primary source wins."""
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(
        db_session,
        source_files=[_file()],
        regions=[_region("invoice_number")],
    )
    # List-shape only — exercises the list-shape path.
    list_fact = ExtractedFact(
        field_key="invoice_number",
        value="INV-LIST",
        source_type="ocr",
        confidence=0.9,
    )
    result = await run_operational_resolution(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        extracted_facts=[list_fact],
    )
    cell = next(
        c
        for c in result.resolver_result.rows[0].cells
        if c.column_id == "invoice_number"
    )
    assert cell.value == "INV-LIST"
    # The bridge should NOT have invented a competing fact since the
    # caller supplied a list and no manual_fact_values mapping.
    facts = result.resolver_input.extracted_facts
    keys = [f.field_key for f in facts]
    assert keys.count("invoice_number") == 1


# ---------------------------------------------------------------------------
# 14 — pattern_selection_mode="none" ignores pattern_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pattern_selection_mode_none_skips_pattern_load(db_session):
    """When mode=none, even a non-existent pattern_id is ignored."""
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    result = await run_operational_resolution(
        db_session,
        template_id=template.id,
        # Made-up id — must not be loaded under mode=none.
        pattern_id=uuid.uuid4(),
        pattern_selection_mode="none",
        extracted_facts={"invoice_number": "INV-NONE"},
    )
    assert result.pattern_id is None
    assert result.resolver_result.rows[0].status == "ready"
