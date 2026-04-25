"""
Pydantic shapes for the Import Builder API.

Note on the name: the underlying entity is still called
`InvoiceTemplate` at the storage layer (table `invoice_templates`,
endpoints `/invoice-templates`) — the *product* surface that authors and
edits these rows is now called the **Import Builder**, since each saved
row is no longer just a header list but the column-level contract that
defines the final import/output shape (which columns exist, which are
required, where each value comes from, what its allowed values are,
etc.). Keeping the storage name stable avoids a destructive rename that
would force a DB migration with zero schema-shape change.

Two layers in the model:

  * Layer 1 — column schema. `InvoiceTemplateColumn` carries the
    column's identity, label, required flag, value-source kind and
    source field binding, manual-list values, default value, and a
    loose validation bag.

  * Layer 2 — rule rows (NEW). `InvoiceTemplateRule` rows live
    underneath the schema. Each rule represents a scoped behavior:
    when the rule's *condition* cells match invoice context, its
    *restriction* cells narrow the matching universe and its *action*
    cells provide defaults / suggested values for the final import.
    The runtime that consumes rules to actually narrow OCR/parser
    matching is intentionally deferred — Phase 1 stores the model and
    the editing surface; the resolver lands incrementally.

Response shapes:

  * `InvoiceTemplateColumn`  — one column entry. Output-contract
                               metadata + `rule_role` (whether this
                               column behaves as a condition,
                               restriction, or action when it appears
                               in a rule row).
  * `InvoiceTemplateRuleCell` — one cell value inside a rule row.
                                Stores `values: list[str]`; the
                                column's `source_type` defines how the
                                strings are interpreted (entity codes,
                                literal text, manual-list picks).
  * `InvoiceTemplateRule`    — one rule row. Carries `is_active`,
                               an optional notes string, and a `cells`
                               dict keyed by column id (so reordering
                               columns doesn't desync cells).
  * `InvoiceTemplateOut`     — a full template record (columns + rules).
                               Returned by GET / POST / PATCH detail.
  * `InvoiceTemplateSummary` — list-row payload (no columns or rules).
                               Carries column_count and rule_count for
                               left-rail badges.
  * `InvoiceTemplateDefault` — the canonical built-in template the
                               frontend uses as the starting editable
                               shape when nothing is uploaded and
                               nothing is saved yet. Not persisted.

Source values are validated as Literal so the frontend can safely
trust a string union; new origins added later need a one-line schema
change but no DB migration (the model uses a free-text column and the
columns + rules arrays live in JSONB).

Backward compatibility:

  Existing rows persisted before the column-metadata extension were
  shaped `[{id, name, source_column}]` with no `rules` array. Every
  new column field carries a Pydantic default (`required = False`,
  `source_type = "empty"`, `rule_role = "action"`, the rest `None`),
  and `rules` defaults to `[]`. Legacy rows deserialize cleanly.
"""

import uuid
from datetime import datetime
from typing import Literal

from app.domain.extracted_invoice_fields import (
    get_extracted_field_aliases,
    is_known_extracted_field_key,
    normalize_extracted_field_key,
    resolve_extracted_field_descriptor,
)
from pydantic import BaseModel, Field, field_validator, model_validator

# What an InvoiceTemplate's `source` field can take. Informational
# only — drives the UI's "where did this come from?" hint.
TemplateSourceLiteral = Literal["default", "blank", "from_upload", "custom"]

# Sensible bounds. 1 column minimum (otherwise the template is
# meaningless); 200 column maximum is well above any real ResMan
# template (the canonical ones top out around 25–30 columns) but bounds
# the JSONB payload size for safety.
MIN_COLUMNS = 1
MAX_COLUMNS = 200
MAX_COLUMN_NAME_LENGTH = 200

# Rule rows are uncapped at the low end (a template with zero rules is
# still a valid schema-only template) and bounded at the high end so a
# misuse / paste-storm can't blow out the JSONB payload. 500 rule rows
# is well past any realistic hand-authored ruleset; if/when bulk-import
# of rules lands, this bound moves separately.
MAX_RULES = 500
# Each rule cell carries a list of selected/typed values. 100 entries
# in a single cell is far past any realistic "vendor list" or "property
# list" the user would hand-author; bounds catch paste-of-CSV mistakes.
MAX_RULE_CELL_VALUES = 100
MAX_RULE_CELL_VALUE_LENGTH = 200
MAX_RULE_NOTES_LENGTH = 500
# Phase 2 — multi-binding extraction. One rule cell can pin several
# (pattern, field) extraction bindings so the same column can resolve
# differently per pattern (e.g. "Invoice Number" → field
# `invoice_number` on EPB but `account_number` on HWEA). Bound at the
# high end so paste-storms can't inflate the JSONB payload — 50 is
# well past the realistic vendor count any one column would fan-out to.
MAX_RULE_CELL_EXTRACTION_BINDINGS = 50

# ---------------------------------------------------------------------------
# Column-source metadata (Phase 1)
# ---------------------------------------------------------------------------
#
# Each column declares WHERE its value comes from when an invoice is
# rendered into this template's shape. The execution engine that
# actually applies these bindings is intentionally NOT implemented in
# this phase — the schema is the contract; downstream rendering will
# come online incrementally as each source kind gets a real binding
# implementation. The frontend builder surfaces the contract; the
# renderer respects it later.

ColumnSourceType = Literal[
    # Operator/extracted later. The default for any column without a
    # declared binding — the column exists in the export shape but the
    # value is filled in by hand or by a later extraction step.
    "empty",
    # Always emits a constant (carried in `default_value`).
    "fixed_value",
    # Operator picks from a small enumerated list defined inline on
    # the column (carried in `manual_values`).
    "manual_list",
    # Pulled from the extracted invoice (e.g. invoice number, date).
    # Future: full OCR pipeline binds these.
    "invoice_field",
    # Looked up from a Properties catalog entry, by some matching key
    # (e.g. property abbreviation matched on the invoice).
    "property_field",
    # Looked up from a Vendors catalog entry.
    "vendor_field",
    # Looked up from a GL Codes catalog entry.
    "gl_field",
    # Computed from a rule/expression. Editor surface for the rule
    # itself is deferred to a future phase.
    "derived",
]

# ---------------------------------------------------------------------------
# Column-type / format metadata (Phase 2 of Import Builder evolution)
# ---------------------------------------------------------------------------
#
# Each column declares its expected DATA TYPE and per-type FORMAT hints.
# Independent from `source_type`: a column can pull from
# `invoice_field='total_amount'` (where the value comes from) and ALSO declare
# `data_type='currency'` with `format.decimal_places=2` (how the value
# is shaped on output). Phase 1 stores the contract; the renderer that
# applies type coercion / format formatting at export time is
# intentionally deferred — same pattern as `source_type`.

ColumnDataType = Literal[
    # Free-form string. Default for new columns and the back-compat
    # default for legacy rows persisted before `data_type` existed.
    "text",
    # Numeric. Format hints: `decimal_places`.
    "number",
    # Monetary value. Format hints: `decimal_places`, `currency_code`.
    "currency",
    # Calendar date. Format hints: `date_format` (strftime-like).
    "date",
    # True/false. Surfaced as a toggle in the inspector.
    "boolean",
    # Single pick from a closed set. Format hints: `list_options`.
    "dropdown",
    # Multiple picks from a closed set. Format hints: `list_options`,
    # `multi_select_separator`.
    "multi_select",
]

# Set of source types that may carry a `source_ref.field` pointer — a
# binding to one specific field on the referenced master-data entity
# (or, for invoice_field, on the extracted invoice payload). Used by
# the per-column validator below to enforce cross-field consistency.
_REF_BINDING_SOURCES: frozenset[str] = frozenset(
    {"invoice_field", "property_field", "vendor_field", "gl_field"}
)


def normalize_invoice_field_key(key: str | None) -> str | None:
    """Normalize an extracted invoice field key for read-side comparisons."""

    return normalize_extracted_field_key(key)


def resolve_invoice_field_descriptor(key: str | None):
    """Resolve an extracted invoice field key or legacy alias."""

    return resolve_extracted_field_descriptor(key)


def is_known_invoice_field_key(key: str | None) -> bool:
    """True when `key` is a built-in extracted field or legacy alias."""

    return is_known_extracted_field_key(key)


def get_invoice_field_aliases(key: str | None) -> tuple[str, ...]:
    """Return compatibility aliases for an extracted invoice field."""

    return get_extracted_field_aliases(key)

# ---------------------------------------------------------------------------
# Data-type ↔ Global-behavior compatibility matrix (ADVISORY)
# ---------------------------------------------------------------------------
#
# Mirrors the frontend's `COMPATIBLE_GLOBAL_MODES` matrix in
# `frontend/src/types/invoice-template.ts`. Lives here so the backend
# carries the same advisory contract for documentation purposes and so
# any future server-side hook (e.g. a "validate before publish" pass)
# can opt in by reading this dict.
#
# IMPORTANT — this matrix is INTENTIONALLY NOT enforced by Pydantic.
# Adding a `model_validator` that rejects incompatible combinations
# would break round-trip for any template persisted before the matrix
# existed (e.g. a `date` column saved with `manual_list` source_type
# would fail to deserialize on the next read). The Import Builder UI
# is the enforcement surface; the storage layer remains permissive so
# legacy rows keep working and a future schema rev can tighten without
# a destructive migration.
#
# Keep this list in lockstep with the frontend matrix — divergence will
# show up as the inspector offering combinations that the (eventual)
# server-side validator rejects, or vice versa.
COMPATIBLE_GLOBAL_MODES: dict[str, frozenset[str]] = {
    # Free-form text — the most permissive shape; every source kind is
    # at least conceivable.
    "text": frozenset(
        {
            "empty",
            "fixed_value",
            "manual_list",
            "invoice_field",
            "property_field",
            "vendor_field",
            "gl_field",
            "derived",
        }
    ),
    # Free scalars — value comes from a literal or an extracted invoice
    # payload (both can be coerced to the column's shape at render time);
    # catalog bindings + manual_list don't make UX sense.
    "number": frozenset({"empty", "fixed_value", "invoice_field", "derived"}),
    "currency": frozenset({"empty", "fixed_value", "invoice_field", "derived"}),
    "date": frozenset({"empty", "fixed_value", "invoice_field", "derived"}),
    "boolean": frozenset({"empty", "fixed_value", "invoice_field", "derived"}),
    # Closed-set types — universe comes from an inline enum
    # (`manual_list`) or a catalog (`*_field`). Generic `fixed_value` is
    # excluded on purpose: for dropdowns, "always emit X" is expressed
    # as "default selected option from the allowed list" (mapped onto
    # `default_value` next to the `manual_list` universe), not as a
    # literal that bypasses the universe.
    "dropdown": frozenset(
        {
            "empty",
            "manual_list",
            "property_field",
            "vendor_field",
            "gl_field",
            "invoice_field",
            "derived",
        }
    ),
    "multi_select": frozenset(
        {
            "empty",
            "manual_list",
            "property_field",
            "vendor_field",
            "gl_field",
            "derived",
        }
    ),
}


def is_global_mode_compatible_with(data_type: str, source_type: str) -> bool:
    """
    Advisory check: is `source_type` a recommended Global behavior for a
    column of `data_type`? Reads `COMPATIBLE_GLOBAL_MODES`. Unknown data
    types fall through as `False` rather than raising — callers should
    treat the matrix as advisory, not as a strict enum guard.

    NOT used by the Pydantic models (back-compat); exposed for any
    future server-side hook that wants to opt into matrix enforcement.
    """
    allowed = COMPATIBLE_GLOBAL_MODES.get(data_type)
    if allowed is None:
        return False
    return source_type in allowed


# ---------------------------------------------------------------------------
# Rule-row roles (Phase 1) — evolved in Phase 2 to cell-level overrides
# ---------------------------------------------------------------------------
#
# Every column carries an optional `default_rule_role` that SUGGESTS how
# that column's cells should behave when they appear inside a rule row,
# but the actual interpretation can be overridden per-cell via
# `InvoiceTemplateRuleCell.role`. The three role values:
#
#   * "condition"   — when the rule's cell has values, the rule is
#                     considered for invoices whose context matches one
#                     of those values (e.g. Vendor = EPB scopes the
#                     rule to EPB invoices). Surfaced in UI as "IF".
#   * "restriction" — when the rule applies, this cell narrows the
#                     candidate universe for that column (e.g. Property
#                     = [Admiral Place, Aspen Meadows] tells the
#                     property matcher to consider only those two).
#                     Surfaced in UI as "LIMIT".
#   * "action"      — when the rule applies, this cell provides a
#                     default / suggested value for the final import
#                     (e.g. GL Account = 6915). Surfaced in UI as "FILL".
#
# Two-layer resolution at extraction time:
#
#   effective_role = cell.role ?? column.default_rule_role ?? <none>
#
# When `effective_role` is None the cell is purely informational and
# does not participate in rule resolution. The Phase 1 column-level
# `rule_role` field is preserved as a backward-compat alias — readers
# that only know about `rule_role` keep working; new code prefers
# `default_rule_role` and falls through to `rule_role` if it's the
# only thing set.
#
# Why per-cell overrides: the same column may legitimately be a
# CONDITION in one rule ("only fire for these vendors") and an ACTION
# in another ("always set vendor to ACME for EPB invoices"). Pinning
# the role at the column level forces awkward column duplication; the
# per-cell override removes that constraint while keeping the column
# default as the dominant "suggestion" UX.
RuleRole = Literal["condition", "restriction", "action"]


class ColumnSourceRef(BaseModel):
    """
    Pointer into a master-data field or invoice field.

    Three pieces of binding metadata, all optional on the wire so legacy
    rows persisted before catalog disambiguation deserialize cleanly:

      * `field` — which canonical field on the bound entity. Loose string
        (not enum-per-source) so the frontend can extend the per-source
        field catalogs without a backend deploy.
      * `catalog_id` — which specific saved catalog to bind this column
        against. BillsIQ supports multiple saved catalogs of each kind
        (Vendors, Properties, GL Codes); without this, "From Vendors" is
        ambiguous when more than one vendor catalog exists. Stored as a
        loose string (the catalog routes accept UUID strings) so the
        Pydantic layer doesn't need to know about catalog id formats.
      * `catalog_label` — cached display name of the bound catalog. Used
        as a fallback for diagnostic display when the live catalog list
        is missing the id (e.g. the catalog was deleted after binding).
        Always treat the LIVE catalog list as authoritative; this field
        is for "what was this template last bound to?" forensics.

    The cross-field validator on `InvoiceTemplateColumn` enforces that
    catalog-backed source kinds (`vendor_field`, `property_field`,
    `gl_field`) get a `source_ref` wrapper object on save; whether
    `catalog_id` is populated is a **save-time UX gate enforced by the
    builder UI**, not a Pydantic-level rejection — same permissiveness
    we apply to `field`. The future rendering engine will fail loud when
    a binding can't be resolved at render time.
    """

    field: str | None = Field(default=None, max_length=128)
    catalog_id: str | None = Field(default=None, max_length=64)
    catalog_label: str | None = Field(default=None, max_length=255)


class ColumnFormat(BaseModel):
    """
    Per-column FORMATTING metadata. Type-discriminated bag — each field
    is meaningful only for certain `data_type` values; the renderer
    ignores irrelevant ones at render time, and we don't reject a
    populated field for the wrong type so users can flip data types
    back and forth without losing already-typed format hints.

      * `date_format`            — strftime-like pattern for `date`
                                   (e.g. `MM/DD/YYYY`, `YYYY-MM-DD`).
      * `decimal_places`         — 0–6, for `number` and `currency`.
      * `currency_code`          — ISO 4217-ish (e.g. `USD`). Loose
                                   string so non-ISO codes stay possible.
      * `uppercase` / `trim`     — text normalisation hints. Forward-
                                   looking; not enforced in this phase.
      * `list_options`           — closed set of allowed output values
                                   for `dropdown` and `multi_select`.
                                   Distinct from `manual_values` (the
                                   GLOBAL value's enum when source_type
                                   is `manual_list`); these are the
                                   OUTPUT-shape options the renderer
                                   constrains the result to.
      * `multi_select_separator` — character used to join multi-select
                                   values into one cell at export.
                                   Defaults to `,` if unset.

    All fields optional / nullable so legacy templates round-trip with
    `format == None`.
    """

    date_format: str | None = Field(default=None, max_length=32)
    decimal_places: int | None = Field(default=None, ge=0, le=6)
    currency_code: str | None = Field(default=None, max_length=8)
    uppercase: bool = False
    trim: bool = False
    # 500 entries is well past any realistic dropdown (US states = 50,
    # county lists ~ 100), but bounded so a paste-storm can't blow out
    # the JSONB payload.
    list_options: list[str] | None = Field(default=None, max_length=500)
    multi_select_separator: str | None = Field(default=None, max_length=8)

    @field_validator("list_options")
    @classmethod
    def _strip_list_options(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        cleaned = [s.strip() for s in v]
        if any(len(s) == 0 for s in cleaned):
            raise ValueError("list_options entries cannot be blank")
        if any(len(s) > MAX_COLUMN_NAME_LENGTH for s in cleaned):
            raise ValueError(
                f"list_options entries cannot exceed {MAX_COLUMN_NAME_LENGTH} characters"
            )
        return cleaned


class ColumnValidation(BaseModel):
    """
    Loose, forward-compatible validation bag.

    Phase 1 intent: store user-declared validation hints alongside the
    column. The execution engine that ENFORCES these is deferred. Only
    the obvious, lightweight constraints are surfaced in the inspector
    UI today; the schema accepts the rest so a future deploy can
    introduce new constraints without a Pydantic-level rejection of
    already-saved templates.
    """

    # Value must successfully resolve from its declared source. For
    # `manual_list` columns, also implies the chosen value must be one
    # of the allowed entries.
    required_from_source: bool = False
    # Value (post-resolution) must be one of `manual_values`. Only
    # meaningful when the column itself is `source_type = "manual_list"`,
    # though we don't reject it for other types — the renderer just
    # ignores it.
    must_be_in_list: bool = False
    # Forward-compatible placeholders. None of these are honored by the
    # renderer in Phase 1; they exist so the JSONB shape stays stable
    # as we add real enforcement.
    pattern: str | None = Field(default=None, max_length=512)
    min_length: int | None = Field(default=None, ge=0)
    max_length: int | None = Field(default=None, ge=0)


class InvoiceTemplateColumn(BaseModel):
    """
    One column inside a template's `columns` array.

    Beyond identity (`id`) and presentation (`name`), each column
    carries its **output contract**: whether it's required, where its
    value comes from, optional binding details, and validation hints.
    """

    # UUID-ish stable key. Generated client-side so the frontend can
    # use it as a React key from the moment it adds a row, before any
    # server round-trip. Validated as a non-empty string rather than
    # strict UUID so we don't reject perfectly-good `c-0` style keys.
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=MAX_COLUMN_NAME_LENGTH)
    # Original column name from the uploaded ResMan template, when this
    # column was seeded from one. Null otherwise. Kept around so a future
    # export step can recover "this user-named column maps to that
    # template column" without re-classifying.
    source_column: str | None = Field(default=None, max_length=MAX_COLUMN_NAME_LENGTH)

    # ---- Output-contract metadata (new in Import Builder phase) ----
    # All optional / defaulted so legacy rows persisted with the older
    # `{id, name, source_column}` shape still deserialize cleanly.

    # "Must this column be present and resolved before export?"
    # Surfaces in the column header as an asterisk badge. Independent
    # from `validation.required_from_source` — `required` says "the
    # column slot must exist"; `required_from_source` says "and its
    # value must successfully resolve from its declared source".
    required: bool = False

    # ---- Type / format contract (NEW — Phase 2 of Import Builder) ----
    # Independent from `source_type`: declares WHAT SHAPE the value should
    # take on output, regardless of where it came from. The renderer
    # that applies type coercion / formatting is intentionally deferred
    # — same staged-rollout pattern as `source_type`.
    data_type: ColumnDataType = "text"
    # Type-discriminated formatting hints; null when the user didn't
    # author overrides. See `ColumnFormat` docstring for which fields
    # apply to which `data_type`.
    format: ColumnFormat | None = None

    # ---- Global / default behavior (RENAMED in Phase 2) ----
    # The product surface no longer calls these "Value source" — they
    # are the column's GLOBAL/DEFAULT behavior. Rule rows layer on top,
    # gated by `allow_rule_override` below. Field names kept stable so
    # the JSONB shape is back-compat.

    # The column's GLOBAL behavior mode. Default `empty` so columns
    # that pre-existed the metadata extension don't get an opinion the
    # user never set.
    source_type: ColumnSourceType = "empty"

    # Field pointer for source kinds that bind to a specific field on
    # an external entity. Null for `empty`, `fixed_value`, `manual_list`,
    # `derived`. The cross-field validator below enforces this.
    source_ref: ColumnSourceRef | None = None

    # In-place enumerated list for `source_type = "manual_list"`. Each
    # entry is a free-text label the operator can pick from at render
    # time. Capped at 100 entries to keep the JSONB payload bounded;
    # real-world enums (Bill/Credit, Payment Method, etc.) sit well
    # under this.
    manual_values: list[str] | None = Field(default=None, max_length=100)

    # Constant carried for `source_type = "fixed_value"`. Stored as the
    # exact string the renderer should emit; type coercion (number,
    # date, etc.) is the renderer's problem at execution time.
    default_value: str | None = Field(default=None, max_length=512)

    # Whether row-based rules are allowed to override this column's
    # global behavior at resolve time. Default `True` matches pre-
    # `allow_rule_override` behavior so legacy rules keep firing.
    #
    #   * True  — rule rows whose action cell for this column has
    #             values may REPLACE the global behavior when the rule
    #             fires.
    #   * False — global behavior is LOCKED above all row-based rules.
    #             Rule cells under this column are still recorded (the
    #             user can flip the switch back without re-authoring),
    #             but the resolver ignores them.
    #
    # Independent from `rule_role`: the role tells the resolver HOW to
    # interpret a rule cell's values; this flag tells the resolver
    # WHETHER an action-shaped result is allowed to win against the
    # global default. Condition / restriction rules still apply
    # regardless because they don't write the column's value.
    allow_rule_override: bool = True

    # ---- Validation + rule interaction --------------------------------
    # Bag of validation hints. See `ColumnValidation` docstring for the
    # Phase 1 enforcement story (which is: declared, not enforced yet).
    validation: ColumnValidation | None = None

    # How this column behaves when it appears inside a rule row. See
    # the `RuleRole` doc-comment above for the three values' semantics.
    # Default `"action"` keeps legacy rows (saved before rules existed)
    # behaving like "every column is an action column" — which is the
    # most permissive interpretation and never silently introduces
    # surprise narrowing on already-saved templates.
    #
    # Phase 2 NOTE: this field is preserved as a BACKWARD-COMPAT ALIAS
    # for `default_rule_role` below. New code should read
    # `default_rule_role` first and fall back to `rule_role` only when
    # `default_rule_role is None`. The editor mirrors writes — when the
    # user picks an explicit default, both fields are set; when the user
    # clears the default ("no suggestion"), `default_rule_role` is set
    # to `None` and `rule_role` is left at the legacy `"action"` default
    # so older readers keep functioning.
    rule_role: RuleRole = "action"

    # Phase 2 — column's SUGGESTED default rule role. Optional, distinct
    # from `rule_role` (which always carries a concrete value due to
    # legacy default). `None` means "no column-level suggestion" — every
    # rule cell under this column must specify its own `cell.role` to
    # participate in rule resolution. Non-null: cells without an explicit
    # `role` inherit this value at resolve time.
    default_rule_role: RuleRole | None = None

    # Phase 2 — locking flags. Independent levers; the inspector / header
    # menu surfaces each separately.
    #
    #   * `lock_position` — the column cannot be drag-reordered. The
    #     drag handle renders disabled with a small lock icon; the editor
    #     short-circuits drop attempts onto/over a lock_position column
    #     so the relative order of locked columns stays put. Used for
    #     "the canonical first column should always be the invoice number"
    #     style pinning.
    #
    #   * `lock_editing` — the column's NAME / SOURCE / DATA TYPE /
    #     FORMAT / VALIDATION cannot be edited from the UI. The
    #     inspector renders inputs as read-only; rule cells under this
    #     column REMAIN editable (locking the schema doesn't lock the
    #     authoring of rules that use it). Distinct from
    #     `allow_rule_override`, which is about RUNTIME whether a rule
    #     cell's value wins over the column's global behavior.
    #
    # Both default to `False` so legacy rows keep their existing
    # full-edit affordances.
    lock_position: bool = False
    lock_editing: bool = False

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("column name cannot be blank")
        return v

    @field_validator("manual_values")
    @classmethod
    def _strip_manual_values(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        # Trim each entry; reject blanks. Keeps the rendered enum clean
        # without forcing the frontend to send already-trimmed input.
        cleaned = [s.strip() for s in v]
        if any(len(s) == 0 for s in cleaned):
            raise ValueError("manual_values entries cannot be blank")
        if any(len(s) > MAX_COLUMN_NAME_LENGTH for s in cleaned):
            raise ValueError(
                f"manual_values entries cannot exceed {MAX_COLUMN_NAME_LENGTH} characters"
            )
        return cleaned

    @model_validator(mode="after")
    def _check_source_consistency(self) -> "InvoiceTemplateColumn":
        """
        Cross-field consistency: a column's `source_ref` is only
        meaningful for source kinds that point at an external entity
        field; `manual_values` is only meaningful for `manual_list`.
        We don't *reject* a populated field for the wrong source type
        (so users can flip source_type without losing what they typed
        in the inspector), but we do enforce the inverse: if the
        source type DEMANDS a piece of metadata, it must be present.
        """
        if self.source_type == "manual_list":
            if not self.manual_values or len(self.manual_values) == 0:
                raise ValueError(
                    "source_type='manual_list' requires at least one entry in manual_values"
                )
        if self.source_type in _REF_BINDING_SOURCES:
            # A `source_ref` with a null `field` is fine on save — the
            # user may have selected the source type but not yet picked
            # the specific field. We only require the wrapper object
            # exist so the rendering engine can later distinguish
            # "binding declared, field TBD" from "no binding at all".
            if self.source_ref is None:
                self.source_ref = ColumnSourceRef(field=None)
        return self


# ---------------------------------------------------------------------------
# Rule rows (Phase 1)
# ---------------------------------------------------------------------------


class RuleCellExtraction(BaseModel):
    """
    Per-cell extraction-context narrowing for `invoice_field` columns.

    Lives on `InvoiceTemplateRuleCell.extraction`. When set, this tells
    the runtime extractor:

      * `pattern_id` — which saved Invoice Builder pattern (see
                       `app/models/invoice_pattern.py`) describes the
                       physical layout this cell expects to extract
                       from. Loose string (not strict UUID) for the
                       same reason `ColumnSourceRef.catalog_id` is —
                       the schema layer doesn't need to know id formats.
                       Optional — `None` means "use the broad
                       universe of all saved patterns" for this rule's
                       cell.
      * `field_key`  — which canonical extracted field on that pattern
                       to use as the cell's resolved value (e.g.
                       `account_number`). Loose string for forward-
                       compat — the canonical field universe lives in
                       `app/schemas/invoice_pattern.py` and the API
                       surfaces it for the frontend, but a Pydantic
                       Literal on a sibling schema would force a
                       round-trip rejection on every canonical-field
                       addition. Frontend/UI is the enforcement
                       surface.
      * `pattern_label` — cached display name of the bound pattern,
                          captured at pick time. Used as a fallback for
                          diagnostic display when the live pattern was
                          deleted post-binding. Same forensic-cache
                          contract as `ColumnSourceRef.catalog_label`.

    THIS IS THE INVOICE BUILDER ↔ IMPORT BUILDER INTEGRATION POINT.
    Three intentional invariants:

      1. Optional, not required. A rule cell with no `extraction` (or
         `extraction = None`) leaves the column's GLOBAL extraction
         behavior in place — for `invoice_field` columns that means
         "search across the broad universe of all saved patterns +
         OCR + AI inference". Rules NARROW the search; they don't gate
         it. **Extraction must work even with zero rules.**
      2. Cell-level, not column-level. The column header still binds
         to a generic `invoice_field` source (e.g. "From extracted
         invoice → account_number") for the column's GLOBAL behavior.
         The pattern + field pick lives here on the rule cell so
         different rules can resolve the same column from different
         patterns (e.g. one rule extracts `account_number` from the
         EPB pattern, another rule from the Comcast pattern).
      3. Soft references. Pattern deletion does NOT cascade — a rule
         cell pointing at a deleted pattern becomes inert at resolve
         time (the resolver treats it as "no narrowing" and falls back
         to the broad universe). The editor surfaces a "(deleted)"
         affordance via `pattern_label` so the operator can re-pick.
    """

    pattern_id: str | None = Field(default=None, max_length=64)
    field_key: str | None = Field(default=None, max_length=128)
    pattern_label: str | None = Field(default=None, max_length=255)


class RuleCellExtractionBinding(BaseModel):
    """
    Phase 2 — one (pattern, field) extraction binding inside a rule cell.

    The multi-binding evolution of `RuleCellExtraction`. A single rule
    cell can now carry several of these so the same column (e.g.
    "Invoice Number") can resolve from different patterns differently
    — `EPB 2 → invoice_number`, `HWEA → account_number`,
    `CDE Lightband → invoice_number`. Persisted as
    `InvoiceTemplateRuleCell.extraction_bindings`.

    Why a list of complete bindings rather than `{ field_key,
    pattern_ids: [...] }`: the field key can DIFFER per pattern.
    Vendors label the same conceptual data inconsistently (one bills
    "Invoice Number", another "Account Number" — same column,
    different fields). Pinning the (pattern, field) pair together is
    the only shape that captures that fan-out cleanly.

    Same loose-string posture as `RuleCellExtraction`:

      * `pattern_id` is a free-form id, not a strict UUID — schema
        layer doesn't need to know id formats.
      * `field_key` is a free string, not a Literal, so the validator
        doesn't reject custom fields the operator coined on the bound
        pattern's `field_definitions` (which live outside the canonical
        universe).
      * `pattern_label` and `field_label` are forensic display caches —
        let the picker render "(deleted) ACME Bills" instead of a blank
        chip when the live pattern was deleted post-binding. The live
        pattern remains authoritative when it resolves; these labels
        are the diagnostic fallback.

    Empty `pattern_id` or `field_key` mark an in-progress binding that
    the picker can persist while the operator is mid-flow; the runtime
    treats incomplete bindings as broad-universe at resolve time.
    """

    pattern_id: str | None = Field(default=None, max_length=64)
    pattern_label: str | None = Field(default=None, max_length=255)
    field_key: str | None = Field(default=None, max_length=128)
    field_label: str | None = Field(default=None, max_length=255)


class RuleCellSelection(BaseModel):
    """
    One structured selection inside a catalog-backed rule cell.

    When a column is bound to a saved catalog (Vendors / Properties /
    GL Codes), rule cells under that column no longer behave like
    free-text chip inputs — the editor lets the operator search the
    bound catalog and pick concrete entries. Each pick lands here as a
    structured triple:

      * `entry_id`    — stable id of the catalog entry. Survives
                        catalog renames; the durable handle.
      * `field_value` — value of the column's bound `source_ref.field`
                        on the picked entry. The runtime resolver
                        compares THIS against the extracted invoice
                        payload (e.g. matched vendor_code on the
                        invoice). Stored alongside `entry_id` so the
                        resolver doesn't have to round-trip the catalog
                        on every match.
      * `label`       — display name at pick time. Used as the chip
                        label in the editor and as the diagnostic
                        fallback when the catalog entry has been
                        deleted (so the operator sees `(missing) "ACME
                        Vendors v3"` instead of a blank chip). The live
                        catalog entry remains authoritative for display
                        when the id resolves; this is the cache.

    For non-catalog source kinds (`fixed_value`, `manual_list`,
    `invoice_field`, `empty`, `derived`) selections are NOT used — the
    cell stays on the legacy `values: list[str]` shape and the editor
    surfaces the appropriate input kind. Mixing the two is allowed
    (selections + values both populated) but the editor only writes
    selections for catalog cells.
    """

    entry_id: str = Field(min_length=1, max_length=128)
    field_value: str = Field(default="", max_length=MAX_RULE_CELL_VALUE_LENGTH)
    label: str = Field(default="", max_length=MAX_RULE_CELL_VALUE_LENGTH)


class InvoiceTemplateRuleCell(BaseModel):
    """
    One cell inside a rule row.

    Storage shape — two parallel lists, used differently per source kind:

      * `values: list[str]` — the legacy shape, used as the source of
        truth for non-catalog source kinds:
          - `manual_list`    — picks from the column's `manual_values`.
          - `invoice_field`  — literal values matched against the
                               extracted invoice payload (no catalog).
          - `fixed_value` / `empty` — single literal value (one-element
                                      list) acting as a per-row override
                                      or suggestion.
          - `derived`        — currently ignored by the resolver.
        For catalog-backed cells, `values` is ALSO populated as a
        flattened list of `field_value`s (one per selection) so any
        consumer that reads only `values` (legacy resolver, debug
        dumps) gets correct behavior without having to know about the
        new structured shape.

      * `selections: list[RuleCellSelection]` — present only when the
        column is catalog-backed (`vendor_field`, `property_field`,
        `gl_field`). Carries the structured triples
        `{entry_id, field_value, label}` so the editor can render rich
        chips, the resolver can use stable entry ids for matching, and
        a deleted catalog entry can still be displayed (via cached
        `label`) instead of vanishing.

    Why two lists rather than a polymorphic shape: keeping `values`
    around as the always-present compatibility surface lets the
    backend, the legacy resolver path, and any future export-time
    debug tooling read the same field without branching on cell
    structure. The structured `selections` add expressiveness for the
    Phase 2 picker without breaking anyone who only knew about
    `values`.
    """

    values: list[str] = Field(
        default_factory=list, max_length=MAX_RULE_CELL_VALUES
    )
    # Defaulted so legacy persisted cells (saved before structured
    # selections existed) deserialize cleanly with `selections == []`.
    # The editor writes this in concert with `values` for catalog-bound
    # cells; non-catalog cells leave it empty.
    selections: list[RuleCellSelection] = Field(
        default_factory=list, max_length=MAX_RULE_CELL_VALUES
    )
    # LEGACY single-binding extraction narrowing — superseded by
    # `extraction_bindings` in Phase 2 but still accepted on the wire so
    # templates persisted before the multi-binding refactor deserialize
    # cleanly. Read paths should NOT consult this directly; the
    # `_promote_legacy_extraction` validator below folds a populated
    # `extraction` into a one-item `extraction_bindings` list at parse
    # time. Editors NEVER write this field anymore — they write
    # `extraction_bindings` and leave the legacy field alone (so a
    # future cleanup pass can drop it without re-rewriting saved cells).
    #
    # Deprecated. Use `extraction_bindings`. Kept for read-side
    # backward compatibility.
    extraction: RuleCellExtraction | None = None
    # Phase 2 — multi-binding extraction narrowing. Each entry pins one
    # (pattern, field) pair; the cell resolves to the first matching
    # pattern at runtime (priority = list order). Empty list means
    # "use the column's GLOBAL extraction behavior" (broad-universe +
    # OCR + AI fallback). See `RuleCellExtractionBinding` docstring for
    # the per-entry invariants and the broader Invoice Builder ↔ Import
    # Builder integration contract.
    #
    # Defaulted to `[]` (not None) so the JSONB stays uniform — the
    # migration validator below also normalizes a missing key to `[]`.
    extraction_bindings: list[RuleCellExtractionBinding] = Field(
        default_factory=list,
        max_length=MAX_RULE_CELL_EXTRACTION_BINDINGS,
    )
    # Phase 2 — per-cell rule role override. When `None`, the cell
    # inherits its column's `default_rule_role` at resolve time (which
    # itself falls back to the legacy `rule_role` field — see the
    # RuleRole doc-comment above). When set, this cell's interpretation
    # WINS over the column's suggestion — the same column may behave as
    # a CONDITION in one rule and an ACTION in another.
    #
    # Why nullable rather than defaulting to a concrete value: legacy
    # rule cells have no `role` field on the wire; defaulting to a
    # concrete role here would silently REWRITE every legacy cell to
    # carry an explicit role, masking the column-level fallback that
    # may have intentionally been left implicit.
    role: RuleRole | None = None

    @model_validator(mode="before")
    @classmethod
    def _promote_legacy_extraction(cls, data: object) -> object:
        """Migrate the legacy single-binding `extraction` shape into the
        new `extraction_bindings` list.

        Phase 2 introduced multi-binding extraction. Templates persisted
        before the refactor carry a single `extraction` object (or
        null); newer payloads carry `extraction_bindings: [...]`. To
        keep both wire shapes accepted without forcing a destructive
        migration, this validator runs at parse time and:

          * If `extraction_bindings` is already a non-empty list, leave
            it alone — the new shape wins.
          * Else if the legacy `extraction` object has a populated
            `pattern_id`, fold it into a one-item `extraction_bindings`
            list. Field labels weren't persisted in the legacy shape,
            so `field_label` defaults to None.
          * Otherwise leave both as their defaults (empty list / None)
            so the cell parses as broad-universe.

        We DON'T strip the legacy `extraction` field — leaving it
        present means a downstream consumer that hasn't been updated to
        read `extraction_bindings` keeps its single-binding view until
        the next save round-trip. Editors only write the new shape
        going forward; the legacy field stays untouched for old
        readers' benefit.

        Mode "before" is necessary: we need to manipulate the raw input
        dict (including a key absent from the model) BEFORE Pydantic
        type-coerces individual fields. Mode "after" wouldn't see a
        legacy payload that omits `extraction_bindings` entirely.
        """
        if not isinstance(data, dict):
            return data
        explicit = data.get("extraction_bindings")
        # If the new field is already populated, prefer it verbatim.
        if isinstance(explicit, list) and len(explicit) > 0:
            return data
        legacy = data.get("extraction")
        if not isinstance(legacy, dict):
            return data
        legacy_pattern_id = legacy.get("pattern_id")
        if not isinstance(legacy_pattern_id, str) or not legacy_pattern_id:
            return data
        # Build the migrated single-item list. Leave the legacy field in
        # place so older readers still see something coherent.
        migrated = {
            "pattern_id": legacy_pattern_id,
            "pattern_label": legacy.get("pattern_label"),
            "field_key": legacy.get("field_key"),
            "field_label": None,
        }
        # Copy the dict so we don't mutate the caller's payload.
        next_data = dict(data)
        next_data["extraction_bindings"] = [migrated]
        return next_data

    @field_validator("values")
    @classmethod
    def _strip_values(cls, v: list[str]) -> list[str]:
        # Strip whitespace and drop blanks. The editor often leaves a
        # trailing empty input chip while the user is typing — we
        # don't want those persisted.
        cleaned = [s.strip() for s in v]
        cleaned = [s for s in cleaned if s]
        if any(len(s) > MAX_RULE_CELL_VALUE_LENGTH for s in cleaned):
            raise ValueError(
                f"rule cell values cannot exceed {MAX_RULE_CELL_VALUE_LENGTH} characters"
            )
        return cleaned


class InvoiceTemplateRule(BaseModel):
    """
    One rule row.

    A rule is a horizontal slice across the template's columns. Each
    cell (keyed by column id) carries the values that column should
    contribute to the rule's behavior — interpreted by the column's
    `rule_role` (condition, restriction, or action).

    Why `cells` is a dict keyed by column id (not a list parallel to
    `columns`): columns can be inserted, deleted, and reordered freely
    in the editor. A list-parallel model would silently desync cells
    on every column reorder. With a dict, cells are stable across
    column ops; cells whose column id is no longer present in the
    template's columns array are inert (the editor scrubs them on
    column delete; the resolver ignores them).
    """

    id: str = Field(min_length=1, max_length=64)
    is_active: bool = True
    cells: dict[str, InvoiceTemplateRuleCell] = Field(default_factory=dict)
    notes: str | None = Field(default=None, max_length=MAX_RULE_NOTES_LENGTH)
    # Phase 2 — locking flags, mirror of the column's lock flags but at
    # the rule-row level. Both default to `False` so legacy rules keep
    # full edit affordances.
    #
    #   * `lock_position` — the rule cannot be drag-reordered. Useful
    #     when rules have priority semantics (the editor renders rules
    #     top-to-bottom and the resolver applies them in that order in
    #     a future phase) and the operator wants to pin a "fallback"
    #     rule at the bottom or a "highest-priority override" at the top.
    #
    #   * `lock_editing` — the rule's metadata (notes, is_active toggle)
    #     and its cells cannot be edited. The header menu still surfaces
    #     "Unlock" so the operator can flip back. Used to freeze a
    #     reviewed/approved rule against accidental tweaks during
    #     adjacent editing.
    lock_position: bool = False
    lock_editing: bool = False

    @field_validator("notes")
    @classmethod
    def _strip_notes(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


class InvoiceTemplateCreate(BaseModel):
    """Body for POST /invoice-templates."""

    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    columns: list[InvoiceTemplateColumn] = Field(
        min_length=MIN_COLUMNS, max_length=MAX_COLUMNS
    )
    # Rules are optional on create — a brand-new template can ship with
    # zero rules; the user adds them as the workspace matures. Default
    # to the empty list so the column-only request shape from before
    # the rules feature continues to validate.
    rules: list[InvoiceTemplateRule] = Field(
        default_factory=list, max_length=MAX_RULES
    )
    source: TemplateSourceLiteral = "custom"

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name cannot be blank")
        return v

    @field_validator("columns")
    @classmethod
    def _unique_ids(
        cls, v: list[InvoiceTemplateColumn]
    ) -> list[InvoiceTemplateColumn]:
        ids = [c.id for c in v]
        if len(ids) != len(set(ids)):
            raise ValueError("column ids must be unique within the template")
        return v

    @field_validator("rules")
    @classmethod
    def _unique_rule_ids(
        cls, v: list[InvoiceTemplateRule]
    ) -> list[InvoiceTemplateRule]:
        ids = [r.id for r in v]
        if len(ids) != len(set(ids)):
            raise ValueError("rule ids must be unique within the template")
        return v


class InvoiceTemplateUpdate(BaseModel):
    """
    Body for PATCH /invoice-templates/{id}. Every field optional.

    Sending `columns` REPLACES the array (no per-row patching). Same
    contract for `rules`: the editor sends the full new ordered list,
    which is simpler to reason about than diff-based merges and matches
    how the editor naturally batches edits.
    """

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    columns: list[InvoiceTemplateColumn] | None = Field(
        default=None, min_length=MIN_COLUMNS, max_length=MAX_COLUMNS
    )
    # Same replace-not-merge contract as `columns`. None = leave the
    # persisted rules untouched; `[]` = clear all rules.
    rules: list[InvoiceTemplateRule] | None = Field(
        default=None, max_length=MAX_RULES
    )
    # `source` is set at create time and not editable via PATCH —
    # there's no good UX for "change where this template originated
    # from" after the fact.

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("name cannot be blank")
        return v

    @field_validator("columns")
    @classmethod
    def _unique_ids(
        cls, v: list[InvoiceTemplateColumn] | None
    ) -> list[InvoiceTemplateColumn] | None:
        if v is None:
            return None
        ids = [c.id for c in v]
        if len(ids) != len(set(ids)):
            raise ValueError("column ids must be unique within the template")
        return v

    @field_validator("rules")
    @classmethod
    def _unique_rule_ids(
        cls, v: list[InvoiceTemplateRule] | None
    ) -> list[InvoiceTemplateRule] | None:
        if v is None:
            return None
        ids = [r.id for r in v]
        if len(ids) != len(set(ids)):
            raise ValueError("rule ids must be unique within the template")
        return v


class InvoiceTemplateOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    columns: list[InvoiceTemplateColumn]
    # Defaulted to the empty list so rows persisted before the rules
    # feature still serialize cleanly through `from_attributes`. The
    # JSONB column for `rules` may legitimately be missing on legacy
    # rows; the ORM layer is responsible for materialising it as `[]`.
    rules: list[InvoiceTemplateRule] = Field(default_factory=list)
    source: TemplateSourceLiteral
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class InvoiceTemplateSummary(BaseModel):
    """List-row shape — no columns or rules arrays, just their sizes."""

    id: uuid.UUID
    name: str
    description: str | None
    source: TemplateSourceLiteral
    column_count: int
    # Defaulted so left-rail summaries built from legacy rows that have
    # no `rules` column on disk still serialize. Surfaced in the UI as
    # a small "N rules" badge under the row name.
    rule_count: int = 0
    created_at: datetime
    updated_at: datetime


class InvoiceTemplateList(BaseModel):
    items: list[InvoiceTemplateSummary] = Field(default_factory=list)


class InvoiceTemplateDefault(BaseModel):
    """
    The canonical built-in template the frontend uses as a starting
    editable shape when nothing else is available. Not persisted.
    """

    name: str
    description: str | None
    columns: list[InvoiceTemplateColumn]
    # The default ships with zero rules — rules are an authoring
    # concern, not part of the canonical column shape. The user adds
    # rules as they refine the template after first save.
    rules: list[InvoiceTemplateRule] = Field(default_factory=list)


ValidationSeverity = Literal["error", "warning", "info"]


class ImportTemplateValidationIssue(BaseModel):
    """One readiness diagnostic for an Import Builder template."""

    severity: ValidationSeverity
    code: str = Field(min_length=1, max_length=80)
    message: str = Field(min_length=1, max_length=500)
    recommendation: str | None = Field(default=None, max_length=500)
    column_id: str | None = Field(default=None, max_length=64)
    column_label: str | None = Field(default=None, max_length=MAX_COLUMN_NAME_LENGTH)
    rule_id: str | None = Field(default=None, max_length=64)
    rule_label: str | None = Field(default=None, max_length=255)
    cell_key: str | None = Field(default=None, max_length=128)
    path: str | None = Field(default=None, max_length=255)
    related_id: str | None = Field(default=None, max_length=128)
    related_type: str | None = Field(default=None, max_length=80)


class ImportTemplateValidationSummary(BaseModel):
    errors: int = 0
    warnings: int = 0
    info: int = 0


class ImportTemplateValidationResult(BaseModel):
    """Readiness response returned by GET /invoice-templates/{id}/validate."""

    template_id: str
    template_name: str
    ready: bool
    summary: ImportTemplateValidationSummary
    issues: list[ImportTemplateValidationIssue] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Default template — the canonical ResMan invoice import shape
# ---------------------------------------------------------------------------
#
# This is the column set the frontend renders as a draft when the user
# first lands on the Import Builder with no saved templates AND no
# uploaded ResMan template. Mirrors the canonical fields the
# `_pick_sheet_rows` heuristic in `reference_parse.py` looks for, so
# users who later upload a real ResMan template see column names that
# rhyme with what they already designed.
#
# Adjust this list cautiously — every existing user starts a draft from
# it, so adding/removing columns affects the "fresh start" experience.
# Renaming an entry here does NOT affect any saved template (those
# carry their own copy of the columns once persisted).
#
# Each canonical column also seeds a sensible **default source binding**
# so the user immediately sees how source-type metadata works without
# having to configure every column from scratch. They're free to
# override or clear any of these in the inspector.

# (display name, required, data_type, source_type, source_ref.field | None, rule_role)
#
# `rule_role` mapping rationale:
#   * Vendor / Vendor Code         — typical *condition* discriminators:
#                                    "when this rule sees an EPB
#                                    invoice, do X".
#   * Property Abbreviation /
#     Property Name / Unit          — typical *restrictions*: a rule
#                                    that fires for a vendor often
#                                    narrows the matchable property
#                                    set (e.g. "EPB invoices only
#                                    apply to these properties").
#   * Everything else              — *action* by default: the rule
#                                    contributes / suggests these
#                                    output values when it applies
#                                    (GL Account, Amount, Tax, etc.).
#
# `data_type` mapping rationale:
#   * Date-shaped fields           — `date` (Invoice Date, Accounting
#                                    Date, Due Date). The renderer will
#                                    apply `format.date_format` on
#                                    output once formatting lands.
#   * Money-shaped fields          — `currency` (Amount, Tax, Total).
#                                    Two decimal places is the common
#                                    default; renderer can lift it from
#                                    `format.decimal_places` later.
#   * Everything else              — `text` (the most permissive shape).
#
# `allow_rule_override` is left at the field default (True) for every
# canonical column — none of these are "always X" locked behaviors out
# of the box. The user can toggle it per-column in the inspector for
# cases like Expense Type / Bill-Credit Indicator.
#
# These are seeds — every spec is editable in the column inspector.
_DEFAULT_COLUMN_SPECS: tuple[
    tuple[str, bool, ColumnDataType, ColumnSourceType, str | None, RuleRole], ...
] = (
    ("Invoice Number",         True,  "text",     "invoice_field",  "invoice_number",        "action"),
    ("Invoice Date",           True,  "date",     "invoice_field",  "invoice_date",          "action"),
    ("Accounting Date",        False, "date",     "invoice_field",  "invoice_date",          "action"),
    ("Vendor",                 True,  "text",     "vendor_field",   "vendor_name",           "condition"),
    ("Vendor Code",            True,  "text",     "vendor_field",   "vendor_code",           "condition"),
    ("Property Abbreviation",  True,  "text",     "property_field", "abbreviation",          "restriction"),
    ("Property Name",          False, "text",     "property_field", "name",                  "restriction"),
    ("Unit",                   False, "text",     "empty",          None,                    "restriction"),
    ("GL Account",             True,  "text",     "gl_field",       "gl_code",               "action"),
    ("Line Item Description",  False, "text",     "invoice_field",  "line_item_description", "action"),
    ("Amount",                 True,  "currency", "invoice_field",  "total_amount",          "action"),
    ("Tax",                    False, "currency", "invoice_field",  "tax_amount",            "action"),
    ("Total",                  True,  "currency", "invoice_field",  "total_amount",          "action"),
    ("Currency",               False, "text",     "invoice_field",  "currency",              "action"),
    ("Due Date",               False, "date",     "invoice_field",  "due_date",              "action"),
    ("PO Number",              False, "text",     "invoice_field",  "po_number",             "action"),
    ("Notes",                  False, "text",     "empty",          None,                    "action"),
)

# Default format hints applied per data type when a canonical column
# adopts that type. Kept as a per-type fallback rather than per-column so
# the spec table above stays compact; users can override in the
# inspector. Currency defaults to USD with two decimals; date defaults
# to MM/DD/YYYY (ResMan's canonical render).
_DEFAULT_FORMAT_FOR_TYPE: dict[ColumnDataType, ColumnFormat | None] = {
    "currency": ColumnFormat(decimal_places=2, currency_code="USD"),
    "date": ColumnFormat(date_format="MM/DD/YYYY"),
    # text / number / boolean / dropdown / multi_select — no preset
    # format on the canonical seed; the user picks if they want one.
    "text": None,
    "number": None,
    "boolean": None,
    "dropdown": None,
    "multi_select": None,
}


def build_default_template() -> InvoiceTemplateDefault:
    """Construct the canonical default template. Pure function — no I/O."""
    columns: list[InvoiceTemplateColumn] = []
    for i, (name, required, data_type, source_type, field_ref, rule_role) in enumerate(
        _DEFAULT_COLUMN_SPECS
    ):
        columns.append(
            InvoiceTemplateColumn(
                id=f"d-{i}",
                name=name,
                source_column=None,
                required=required,
                data_type=data_type,
                format=_DEFAULT_FORMAT_FOR_TYPE.get(data_type),
                source_type=source_type,
                source_ref=(
                    ColumnSourceRef(field=field_ref) if field_ref is not None else None
                ),
                # Canonical columns default to allowing rule overrides —
                # the canonical seed is meant to be a permissive starting
                # point, not a locked-down contract. Users opt into
                # locking specific columns in the inspector.
                allow_rule_override=True,
                # Mirror writes — set both the legacy `rule_role` and
                # the new Phase 2 `default_rule_role` so older readers
                # see the canonical role they always saw, AND new
                # readers (which prefer `default_rule_role`) read the
                # same value through the new lens. Per-cell overrides
                # land on rule cells later.
                rule_role=rule_role,
                default_rule_role=rule_role,
                # Canonical seed columns are NEVER position-locked or
                # edit-locked — the seed is a starting draft; the user
                # opts into locks via the column header menu after
                # they've reviewed the structure.
                lock_position=False,
                lock_editing=False,
            )
        )
    return InvoiceTemplateDefault(
        name="Default ResMan Invoice Template",
        description=(
            "Built-in starting template covering the canonical ResMan "
            "invoice import fields. Each column comes pre-bound to a "
            "sensible default source, data type, and rule role — edit "
            "the bindings or clear them in the column inspector. Use "
            "the Global behavior section to set a column-wide default "
            "(e.g. Bill/Credit always = Bill); flip Allow rule override "
            "off to lock that default above row-based rules. Saving "
            "creates an independent copy. Add rule rows underneath to "
            "scope matching by vendor, narrow the candidate property "
            "set, and suggest GL Accounts."
        ),
        columns=columns,
    )
