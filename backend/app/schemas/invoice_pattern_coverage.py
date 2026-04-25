"""
Pydantic shapes for the Invoice Builder ↔ Import Builder coverage view.

`GET /invoice-patterns/{pattern_id}/import-coverage` returns coverage —
which Invoice Builder fields on this pattern are referenced by Import
Builder templates' rule cells, and which template required columns are
satisfied or missing. Drives:

  * The Coverage panel in the Invoice Builder right rail.
  * Region overlay badges ("Linked", "REQ mapped").
  * The "is this pattern actually being used?" diagnostic shown the
    moment a pattern is opened.

Source of truth: extraction bindings on Import Builder rule cells
(`InvoiceTemplateRuleCell.extraction_bindings`). The pattern row itself
does NOT track which templates reference it — that's a deliberate
one-way reference so patterns and templates can evolve independently.
This module derives the reverse view at read time, never the other way.

A note on classification literals — the user-facing taxonomy is five
buckets (extraction / default / catalog / manual_or_rule / missing).
Branch order is documented on the resolver in
`app/services/invoice_pattern_coverage.py`; the UI reads `status` and
`extraction_field_key` together to render the breakdown.
"""

import uuid
from typing import Literal

from pydantic import BaseModel, Field

# Resolution status for a required template column. See
# `app/services/invoice_pattern_coverage.py:_classify_column` for the
# branch order. The literals are stable wire values — adding a new one
# requires a frontend mirror update at the same time.
RequiredColumnStatus = Literal[
    # At least one rule cell extraction binding under this column
    # references THIS pattern. The pinned field appears in
    # `extraction_field_key`. This is the strongest "yes, this pattern
    # contributes to this column" signal.
    "satisfied_by_extraction",
    # Column has a non-empty `default_value` (typically `fixed_value`
    # source type). Independent of which pattern is open.
    "satisfied_by_default",
    # Column is bound to a Reference Data catalog
    # (vendor/property/gl_field). Independent of this pattern.
    "satisfied_by_catalog",
    # Column is `manual_list` with values, OR has rule cells with
    # action values supplying the column. Independent of this pattern.
    "satisfied_by_manual_or_rule",
    # Column has no resolution path declared. Reported only for required
    # columns; non-required columns may legally be unresolved.
    "missing",
]


class UsedByImportRuleCell(BaseModel):
    """One reverse pointer: a rule cell that references this pattern.

    Identifies the template, the rule (id + 1-based index for display),
    and the column the cell lives on. The frontend uses this triple to
    deep-link from the Coverage panel into the Import Builder editor.

    `column_required` is cached so the Coverage panel can show a "REQ"
    chip without re-correlating against the source template.
    """

    template_id: uuid.UUID
    template_name: str
    rule_id: str
    # 1-based human-friendly position within the template's rules list
    # at the time of the read. Surfaced as "Rule 3" in the panel.
    rule_index: int
    column_id: str
    column_name: str
    column_required: bool


class UsedFieldCoverage(BaseModel):
    """One field on this pattern referenced by an extraction binding.

    `field_label` is the operator-resolved display name — pattern-level
    override wins, then canonical label, then the slug itself. Lets
    the frontend render the field row without re-running the full
    field-options resolver.

    `used_by` collects every rule cell pointer for this field across
    every template in the response. Multiple templates may reference
    the same field — that's exactly the cross-template visibility
    we're building this for.
    """

    field_key: str
    field_label: str
    used_by: list[UsedByImportRuleCell] = Field(default_factory=list)


class RequiredColumnCoverage(BaseModel):
    """One required column on the template, with satisfaction status.

    Always carries the canonical column metadata (id, name, types) so
    the Coverage panel can render the row standalone without
    re-correlating against the source template detail payload.

    `extraction_field_key` is set ONLY when status is
    `satisfied_by_extraction` AND the contributing binding points at
    THIS pattern. Null when status is `satisfied_by_extraction` but the
    column falls back to broad-universe extraction (no rule binding to
    the current pattern), or when satisfied via any other path.
    """

    column_id: str
    column_name: str
    data_type: str
    source_type: str
    required: bool
    status: RequiredColumnStatus
    extraction_field_key: str | None = None


class CoverageStats(BaseModel):
    """Counters for the Coverage panel header / chips.

    * `total_fields_in_pattern` is the size of the resolved field
      universe (canonical built-ins after operator hide/override + custom
      fields). Surfaces "X of Y fields used" at a glance.
    * `used_fields_count` is the de-duped count of field_keys used by
      at least one rule cell extraction binding in this response.
    * `total_required_columns` / `satisfied_required_columns` /
      `missing_required_columns` are aggregated across the templates in
      this response — let the panel show "12 / 14 required satisfied"
      without reducing the per-template list client-side.
    """

    total_fields_in_pattern: int = 0
    used_fields_count: int = 0
    unused_fields_count: int = 0
    total_required_columns: int = 0
    satisfied_required_columns: int = 0
    missing_required_columns: int = 0


class ImportTemplateCoverageSummary(BaseModel):
    """One template's view of this pattern's coverage.

    Returned even when the template doesn't reference the pattern (in
    which case `used_field_keys` is empty and the picker renders the
    "no fields used" empty state). That keeps the response shape stable
    for the "All templates" drop-down — every template appears, the
    user sees at-a-glance which ones are wired up.
    """

    template_id: uuid.UUID
    template_name: str
    # Set-as-list of field_keys this template references on this pattern
    # via rule cell extraction bindings. Stable ordering = first
    # appearance walking rules → cells. Empty when the template doesn't
    # reference this pattern.
    used_field_keys: list[str] = Field(default_factory=list)
    used_fields: list[UsedFieldCoverage] = Field(default_factory=list)
    # Every required column on the template, with status. Non-required
    # columns are intentionally NOT included — coverage is a "is this
    # column going to have a value at runtime?" view, which is only
    # meaningful for required columns.
    required_columns: list[RequiredColumnCoverage] = Field(default_factory=list)
    # Subset of `required_columns` where status == "missing". Surfaced
    # separately so the panel header can show a count without
    # re-filtering client-side.
    missing_required_columns: list[RequiredColumnCoverage] = Field(
        default_factory=list
    )
    coverage: CoverageStats = Field(default_factory=CoverageStats)


class InvoicePatternImportCoverage(BaseModel):
    """Top-level response for `GET /invoice-patterns/{id}/import-coverage`.

    `templates` carries one entry per template in the response set:
    every workspace template when no `?template_id` filter is in play,
    or just the requested template when filtered. Empty
    `used_field_keys` is allowed — a template that doesn't touch this
    pattern still appears (with zero counts) so the picker can render
    the "All templates" view consistently.

    `aggregate` rolls up across whatever templates are in the response
    so the Coverage panel can show one summary line ("4 of 7 templates
    use this pattern · 12 of 14 required columns satisfied") without
    folding client-side.
    """

    pattern_id: str
    pattern_name: str
    templates: list[ImportTemplateCoverageSummary] = Field(default_factory=list)
    aggregate: CoverageStats = Field(default_factory=CoverageStats)
