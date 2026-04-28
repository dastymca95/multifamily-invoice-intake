"""
Phase 2B — Template + Pattern Test Runner service tests.

These exercise ``run_template_pattern_test`` end-to-end against the
real Postgres test database (per the project's ``db_session``
fixture). The test runner is a thin composer over already-tested
pieces:

  * Phase 2A bridge → exhaustively unit-tested in
    ``test_invoice_pattern_resolver_bridge.py``.
  * Existing import-template resolver → covered by
    ``test_import_template_resolver.py``.

So the cases here focus on the COMPOSITION contract:

  * 404-style ``TemplatePatternTestNotFound`` raised when either
    ORM row is missing.
  * Bridge input + resolver result are returned together.
  * Manual fact values + alias normalization flow through the chain
    end-to-end (the bridge unit tests cover the bridge in isolation;
    these tests prove the resolver actually sees the values).
  * Vendor-hint / catalog-hint plumbing reaches the bridge output
    even when the resolver doesn't (or does) actually consume it.
  * Document metadata merge precedence is correct.
  * The runner never mutates inputs.
  * Summary counts mirror the resolver's own counts.
"""

from __future__ import annotations

import uuid

import pytest

from app.models.invoice_pattern import InvoicePattern
from app.models.invoice_template import InvoiceTemplate
from app.services.template_pattern_test_runner import (
    TEST_RUNNER_SOURCE,
    TEST_RUNNER_VERSION,
    TemplatePatternTestNotFound,
    run_template_pattern_test,
)


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------


async def _persist_template(
    db_session, *, columns: list[dict], rules: list[dict] | None = None
) -> InvoiceTemplate:
    """Create + flush an InvoiceTemplate row.

    We avoid commit so the per-test rollback in conftest still works.
    Flush is enough — the runner reads via the same session.
    """
    template = InvoiceTemplate(
        id=uuid.uuid4(),
        name="Test runner template",
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
    field_definitions: list[dict] | None = None,
) -> InvoicePattern:
    pattern = InvoicePattern(
        id=uuid.uuid4(),
        name=name,
        description=None,
        vendor_hint=vendor_hint,
        source_files=source_files or [],
        regions=regions or [],
        field_definitions=field_definitions or [],
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


def _region(field_key: str, source_file_id: str = "f-1", page: int = 1) -> dict:
    return {
        "id": f"r-{field_key}",
        "source_file_id": source_file_id,
        "page": page,
        "bbox": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05},
        "field_key": field_key,
        "shape": "rect",
    }


# ---------------------------------------------------------------------------
# 1 — Missing template raises TemplatePatternTestNotFound (kind=template)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_template_raises_not_found(db_session):
    pattern = await _persist_pattern(db_session)
    with pytest.raises(TemplatePatternTestNotFound) as exc_info:
        await run_template_pattern_test(
            db_session,
            template_id=uuid.uuid4(),  # never persisted
            pattern_id=pattern.id,
        )
    assert exc_info.value.kind == "template"


# ---------------------------------------------------------------------------
# 2 — Missing pattern raises TemplatePatternTestNotFound (kind=pattern)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_pattern_raises_not_found(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    with pytest.raises(TemplatePatternTestNotFound) as exc_info:
        await run_template_pattern_test(
            db_session,
            template_id=template.id,
            pattern_id=uuid.uuid4(),  # never persisted
        )
    assert exc_info.value.kind == "pattern"


# ---------------------------------------------------------------------------
# 3 — Minimal pattern + template runs and returns a diagnostic result
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_minimal_inputs_return_diagnostic_result(db_session):
    """No regions, no manual values — the runner must still return a
    well-shaped result (resolver decides ready/blocked)."""
    template = await _persist_template(
        db_session,
        columns=[
            {
                "id": "expense_type",
                "name": "Expense Type",
                "required": False,
                "data_type": "text",
                "source_type": "fixed_value",
                "default_value": "General",
                "allow_rule_override": True,
                "default_rule_role": None,
            }
        ],
    )
    pattern = await _persist_pattern(db_session, name="Empty pattern")

    result = await run_template_pattern_test(
        db_session, template_id=template.id, pattern_id=pattern.id
    )

    assert result.diagnostic_only is True
    assert result.template_id == str(template.id)
    assert result.pattern_id == str(pattern.id)
    assert result.template_name == "Test runner template"
    assert result.pattern_name == "Empty pattern"
    # Resolver returns a placeholder row even with no input — fixed
    # default resolves ready.
    assert result.resolver_result.rows[0].status == "ready"
    # Bridge ran with zero manual facts.
    assert result.summary.extracted_fact_count == 0
    assert result.summary.catalog_hint_count == 0


# ---------------------------------------------------------------------------
# 4 — Manual fact values flow to resolver and resolve a required column
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manual_fact_values_resolve_required_column(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(
        db_session,
        source_files=[_file()],
        regions=[_region("invoice_number")],
    )

    result = await run_template_pattern_test(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        manual_fact_values={"invoice_number": "INV-12345"},
    )

    assert result.resolver_result.rows[0].status == "ready"
    cell = next(
        c for c in result.resolver_result.rows[0].cells
        if c.column_id == "invoice_number"
    )
    assert cell.value == "INV-12345"
    assert cell.status == "resolved"
    assert result.summary.extracted_fact_count == 1
    # Overall result.status may be ``needs_review`` instead of ``ready``
    # because the resolver appends validation advisories (e.g. runtime
    # dependency warnings for invoice_field columns) that demote the
    # combined status. The row-level + cell-level checks above are the
    # contract that matters for "did the manual fact resolve?".
    assert result.summary.status in ("ready", "needs_review")


# ---------------------------------------------------------------------------
# 5 — Alias flow: manual `amount` resolves a `total_amount`-bound column
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
        db_session, regions=[_region("total_amount")]
    )

    result = await run_template_pattern_test(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        manual_fact_values={"amount": "99.50"},  # legacy alias
    )

    assert result.resolver_result.rows[0].status == "ready"
    cell = next(
        c for c in result.resolver_result.rows[0].cells if c.column_id == "amount"
    )
    assert cell.normalized_value == 99.50
    assert cell.provenance.normalized_field_key == "total_amount"


# ---------------------------------------------------------------------------
# 6 — pattern.vendor_hint reaches bridge_input.catalog_hints["vendor"]
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pattern_vendor_hint_lands_in_bridge_catalog_hints(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(db_session, vendor_hint="EPB")

    result = await run_template_pattern_test(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        manual_fact_values={"invoice_number": "X"},
    )
    assert "vendor" in result.bridge_input.catalog_hints
    assert result.bridge_input.catalog_hints["vendor"].text == "EPB"
    assert result.summary.catalog_hint_count == 1


# ---------------------------------------------------------------------------
# 7 — Manual catalog hint overrides pattern vendor_hint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manual_catalog_hints_override_pattern_vendor_hint(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(db_session, vendor_hint="OLD")

    result = await run_template_pattern_test(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        manual_fact_values={"invoice_number": "X"},
        manual_catalog_hints={"vendor": "EPB"},
    )
    assert result.bridge_input.catalog_hints["vendor"].text == "EPB"


# ---------------------------------------------------------------------------
# 8 — include_empty_fields surfaces unfilled keys in document_metadata
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_include_empty_fields_surfaces_unfilled_pattern_fields(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(
        db_session,
        source_files=[_file()],
        regions=[
            _region("invoice_number"),
            _region("invoice_date"),
        ],
    )

    result = await run_template_pattern_test(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        manual_fact_values={"invoice_number": "X"},
        include_empty_fields=True,
    )

    metadata = result.bridge_input.document_metadata
    unfilled = metadata.get("unfilled_pattern_fields", [])
    assert "invoice_date" in unfilled
    assert "invoice_number" not in unfilled


# ---------------------------------------------------------------------------
# 9 — document_metadata merge precedence
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_document_metadata_merge_precedence(db_session):
    """Caller can add free-form keys; bridge keys + runner keys are
    protected and ALWAYS win."""
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(
        db_session, name="EPB", vendor_hint="EPB"
    )

    result = await run_template_pattern_test(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        manual_fact_values={"invoice_number": "X"},
        document_metadata={
            # Free-form key — must survive.
            "test_run_label": "Q3 review",
            # Hostile attempt to spoof bridge provenance.
            "bridge_source": "spoofed",
            "invoice_pattern_name": "spoofed-name",
            # Hostile attempt to spoof runner identity.
            "test_runner_source": "spoofed",
            "diagnostic_only": False,
        },
    )

    metadata = result.bridge_input.document_metadata
    # Caller's free-form key survives.
    assert metadata["test_run_label"] == "Q3 review"
    # Bridge-protected keys come from the bridge, NOT the caller.
    assert metadata["bridge_source"] == "invoice_pattern_resolver_bridge"
    assert metadata["invoice_pattern_name"] == "EPB"
    # Runner-managed keys come from the runner, NOT the caller.
    assert metadata["test_runner_source"] == TEST_RUNNER_SOURCE
    assert metadata["test_runner_version"] == TEST_RUNNER_VERSION
    assert metadata["template_id"] == str(template.id)
    assert metadata["template_name"] == "Test runner template"
    assert metadata["diagnostic_only"] is True


@pytest.mark.asyncio
async def test_runtime_options_pass_through(db_session):
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(db_session)

    result = await run_template_pattern_test(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        manual_fact_values={"invoice_number": "X"},
        runtime_options={"scenario_label": "edge_case_1"},
    )
    assert result.bridge_input.runtime_options.get("scenario_label") == "edge_case_1"


# ---------------------------------------------------------------------------
# 10 — No mutation of inputs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_runner_does_not_mutate_template_or_pattern(db_session):
    """Critical because the runner reads ORM rows still attached to
    the SQLAlchemy session — any silent mutation could be flushed on
    the next round-trip."""
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(
        db_session,
        vendor_hint="EPB",
        source_files=[_file()],
        regions=[_region("invoice_number")],
    )

    template_columns_snapshot = list(template.columns)
    template_rules_snapshot = list(template.rules)
    pattern_files_snapshot = list(pattern.source_files)
    pattern_regions_snapshot = list(pattern.regions)
    pattern_vendor_snapshot = pattern.vendor_hint
    pattern_field_defs_snapshot = list(pattern.field_definitions)

    await run_template_pattern_test(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        manual_fact_values={"invoice_number": "X"},
        manual_catalog_hints={"vendor": "Override"},
        document_metadata={"test_run_label": "noop check"},
    )

    assert template.columns == template_columns_snapshot
    assert template.rules == template_rules_snapshot
    assert pattern.source_files == pattern_files_snapshot
    assert pattern.regions == pattern_regions_snapshot
    assert pattern.vendor_hint == pattern_vendor_snapshot
    assert pattern.field_definitions == pattern_field_defs_snapshot


# ---------------------------------------------------------------------------
# 11 — Summary counts mirror resolver counts
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_summary_mirrors_resolver_counts(db_session):
    """Required required column without a manual value → resolver
    blocks; summary should reflect that."""
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(
        db_session,
        source_files=[_file()],
        regions=[_region("invoice_number")],
    )

    result = await run_template_pattern_test(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        # No manual_fact_values: required column has no value to
        # resolve → resolver returns blocked status.
    )
    summary = result.summary
    rs = result.resolver_result.summary
    assert summary.status == result.resolver_result.status
    assert summary.rows == rs.row_count
    assert summary.ready == rs.ready_rows
    assert summary.needs_review == rs.needs_review_rows
    assert summary.blocked == rs.blocked_rows
    assert summary.conflict == rs.conflict_rows
    assert summary.errors == rs.error_count
    assert summary.warnings == rs.warning_count
    assert summary.info == rs.info_count
    assert summary.extracted_fact_count == 0
    # Pattern has no vendor hint and no manual catalog hints.
    assert summary.catalog_hint_count == 0


# ---------------------------------------------------------------------------
# 12 — Bonus: bridge_input + resolver_result both reach the response
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_response_includes_both_bridge_input_and_resolver_result(db_session):
    """Defense against a future refactor accidentally dropping one
    side of the envelope."""
    template = await _persist_template(
        db_session, columns=[_required_invoice_field_column()]
    )
    pattern = await _persist_pattern(
        db_session,
        vendor_hint="EPB",
        source_files=[_file()],
        regions=[_region("invoice_number")],
    )

    result = await run_template_pattern_test(
        db_session,
        template_id=template.id,
        pattern_id=pattern.id,
        manual_fact_values={"invoice_number": "INV-1"},
    )
    # Bridge input present + populated.
    assert result.bridge_input.template_id == str(template.id)
    assert len(result.bridge_input.extracted_facts) == 1
    assert result.bridge_input.pattern_matches[0].pattern_id == str(pattern.id)
    # Resolver result present + matches the loaded template id.
    assert result.resolver_result.template_id == str(template.id)
    assert len(result.resolver_result.rows) >= 1
