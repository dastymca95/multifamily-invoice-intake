/**
 * Import Builder — types mirror `app/schemas/invoice_template.py`.
 *
 * Naming note: the underlying entity is still `InvoiceTemplate` at the
 * storage layer (table `invoice_templates`, endpoints
 * `/invoice-templates`, this file's type names). The product surface
 * that authors and edits these rows is the **Import Builder** — each
 * saved row carries TWO layers:
 *
 *   * Layer 1 — column schema. Identity + label + source binding +
 *     validation hints + the per-column `rule_role`.
 *   * Layer 2 — rule rows. Each rule is a horizontal slice across the
 *     columns; cells are interpreted through the parent column's
 *     `rule_role` (condition / restriction / action) and `source_type`
 *     (catalog ids vs. literal text vs. enum picks).
 *
 * Related but distinct from `ImportConfig` (the legacy "Import Preview"
 * feature, now relocated to /import-preview): that model owns ROLE
 * OVERRIDES on top of an inferred column structure. InvoiceTemplate
 * owns the COLUMN STRUCTURE itself plus the per-column source
 * contract AND the rule-row layer that scopes runtime behavior.
 *
 * Phase 1 stores the rule layer; the resolver that consumes it lives
 * in a follow-up phase. The editor is the source of truth for the
 * shape; downstream resolution is intentionally deferred.
 */

/**
 * Where this template was originally seeded from. Informational —
 * drives a small "origin" hint in the UI but has no functional effect.
 */
export type InvoiceTemplateSource =
  | "default"
  | "blank"
  | "from_upload"
  | "custom";

/**
 * The column's GLOBAL / DEFAULT BEHAVIOR mode.
 *
 * A column ALWAYS has one of these — it's the column-level contract
 * that says "where does my value come from when nothing else is in
 * play?". Rule rows layer on top (and may override, gated by
 * `allow_rule_override`). The runtime resolution hierarchy is:
 *
 *   1. The column's GLOBAL behavior (this enum + the matching
 *      `default_value` / `manual_values` / `source_ref`) is the base.
 *   2. If `allow_rule_override === true` and a row-based rule applies
 *      AND its action cell for this column has values, the rule's
 *      values may replace / contribute to the resolved value.
 *   3. If `allow_rule_override === false`, the global behavior is
 *      enforced and rule cells are recorded but ignored at resolve time.
 *   4. Format metadata (`data_type` + `format`) shapes the OUTPUT —
 *      it's applied AFTER value resolution, never affects what value
 *      is chosen.
 *
 * The legacy field name on the column is `source_type` (not
 * `global_mode`) — kept for backward compatibility with already-
 * persisted templates and the existing JSONB shape. The product
 * surface refers to it as the column's "Global behavior" / "Default
 * behavior"; the UI no longer says "Value source" at the top level.
 *
 *   * `empty`           — no global value defined. Cell stays blank
 *                         globally; any value comes from rule rows
 *                         (when allow_rule_override is true) or a
 *                         downstream extraction step.
 *   * `fixed_value`     — emit a constant (carried in `default_value`).
 *   * `manual_list`     — operator picks from an inline enumerated
 *                         list (carried in `manual_values`).
 *   * `invoice_field`   — pulled from the extracted invoice payload
 *                         (e.g. invoice number).
 *   * `property_field`  — looked up from the Properties catalog.
 *   * `vendor_field`    — looked up from the Vendors catalog.
 *   * `gl_field`        — looked up from the GL Codes catalog.
 *   * `derived`         — rule/expression-based; rule editor deferred.
 */
export type ColumnSourceType =
  | "empty"
  | "fixed_value"
  | "manual_list"
  | "invoice_field"
  | "property_field"
  | "vendor_field"
  | "gl_field"
  | "derived";

/** Source kinds whose UI surfaces a "field" picker for the binding. */
// Explicit `<ColumnSourceType>` element type — without it, `new Set([...])`
// widens the literal strings to `string` and the assignment to
// `ReadonlySet<ColumnSourceType>` no longer typechecks.
export const REF_BINDING_SOURCES: ReadonlySet<ColumnSourceType> =
  new Set<ColumnSourceType>([
    "invoice_field",
    "property_field",
    "vendor_field",
    "gl_field",
  ]);

/**
 * Source kinds that bind to a master-data catalog (multi-select chip
 * input is appropriate). Excludes `invoice_field`, which references
 * extracted fields rather than catalog rows — its rule cell uses a
 * literal-text input. The runtime resolver respects the catalog kind
 * to dispatch the right lookup.
 */
export const CATALOG_BINDING_SOURCES: ReadonlySet<ColumnSourceType> =
  new Set<ColumnSourceType>(["property_field", "vendor_field", "gl_field"]);

/**
 * The column's expected DATA TYPE. Independent from where the value
 * comes from (`source_type`) — a column might pull from an invoice
 * field but still expect to be formatted as `currency` with two
 * decimals on output, or pull from a fixed value but expect a
 * `boolean` shape.
 *
 *   * `text`         — free-form string. The default; matches legacy
 *                      columns persisted before data_type existed.
 *   * `number`       — numeric, no currency symbol. Format hints:
 *                      `decimal_places`.
 *   * `currency`     — numeric with a currency symbol/locale. Format
 *                      hints: `decimal_places`, `currency_code`.
 *   * `date`         — calendar date. Format hints: `date_format` (a
 *                      strftime-like pattern, e.g. `MM/DD/YYYY`).
 *   * `boolean`      — true/false. The cell editor renders a toggle
 *                      where appropriate; serialised as a string
 *                      ("true"/"false" / "Yes"/"No") via format.
 *   * `dropdown`     — single pick from a closed set. Format hint:
 *                      `list_options`.
 *   * `multi_select` — many picks from a closed set. Format hints:
 *                      `list_options`, `multi_select_separator`.
 *
 * Phase 1 stores the type + format as the column's contract. The
 * rendering engine that actually applies type coercion / format
 * formatting at export time is intentionally deferred — the model is
 * the contract; the resolver lands incrementally.
 */
export type ColumnDataType =
  | "text"
  | "number"
  | "currency"
  | "date"
  | "boolean"
  | "dropdown"
  | "multi_select";

/**
 * Type-discriminated format metadata. Stored as a single bag (rather
 * than a discriminated union) so the JSONB shape stays append-only —
 * adding a new format hint later doesn't risk reshaping already-
 * persisted templates. Each field is meaningful only for certain
 * `data_type` values; the renderer ignores irrelevant ones.
 *
 *   * `date_format`            — strftime-like pattern for `date`.
 *                                Common picks: `MM/DD/YYYY`,
 *                                `YYYY-MM-DD`, `DD/MM/YYYY`.
 *   * `decimal_places`         — 0–6, for `number` and `currency`.
 *   * `currency_code`          — ISO 4217 (e.g. `USD`, `EUR`), for
 *                                `currency`.
 *   * `uppercase`              — normalise text to upper case at
 *                                render. Forward-looking; not enforced
 *                                in this phase.
 *   * `trim`                   — collapse leading/trailing whitespace.
 *                                Forward-looking; not enforced yet.
 *   * `list_options`           — closed set of allowed values for
 *                                `dropdown` and `multi_select`.
 *                                Distinct from `manual_values` (which
 *                                is the GLOBAL value's enum when
 *                                source_type is `manual_list`); these
 *                                are the OUTPUT-shape options the
 *                                renderer constrains the result to.
 *   * `multi_select_separator` — character used to join multi-select
 *                                output values into a single cell
 *                                string at export. Defaults to `,` if
 *                                unset.
 *
 * All fields optional / nullable so legacy templates round-trip cleanly
 * with `format == null`.
 */
export interface ColumnFormat {
  date_format?: string | null;
  decimal_places?: number | null;
  currency_code?: string | null;
  uppercase?: boolean;
  trim?: boolean;
  list_options?: string[] | null;
  multi_select_separator?: string | null;
}

/**
 * How a column's cells behave when they appear inside a rule row:
 *
 *   * `condition`   — the rule fires for invoices whose context matches
 *                     one of the cell's values (e.g. Vendor = EPB).
 *                     Surfaced in UI as **IF**.
 *   * `restriction` — when the rule applies, this cell narrows the
 *                     candidate universe for that column (e.g. Property
 *                     scoped to a short list). Surfaced in UI as **LIMIT**.
 *   * `action`      — when the rule applies, this cell suggests / sets
 *                     the column's output value (e.g. GL Account = 6915).
 *                     Surfaced in UI as **FILL**.
 *
 * Phase 2 evolution: the role can live at TWO levels — the column
 * surfaces a `default_rule_role` *suggestion* and each rule cell can
 * override it with its own `role`. Resolution order at extraction
 * time:
 *
 *     effective_role = cell.role ?? column.default_rule_role ?? null
 *
 * `null` means "this cell is purely informational" (it carries values
 * but doesn't participate in rule resolution). Use the
 * `effectiveCellRole(cell, column)` helper from this module rather
 * than re-implementing the fallthrough.
 *
 * Independent from `allow_rule_override` — the role tells you HOW a
 * rule cell is interpreted IF it gets to run; `allow_rule_override`
 * decides whether action-shaped row results are even allowed to
 * REPLACE the column's global behavior. Condition / restriction rules
 * still apply regardless of `allow_rule_override` because they don't
 * write the column's value, they only scope which rule fires.
 */
export type RuleRole = "condition" | "restriction" | "action";

/**
 * Compact "operator-friendly" label for a role. Distinct from
 * `RULE_ROLE_LABEL`: that is the noun ("Condition" / "Restriction" /
 * "Action") and shows up in inspector / picker copy. The OPERATOR
 * label is the imperative verb pattern that surfaces on rule-cell
 * badges where the screen real estate is tight and the goal is "what
 * does this cell DO" not "what is this cell CALLED".
 *
 *   * condition   → "IF"   (this cell decides if the rule fires)
 *   * restriction → "LIMIT" (this cell narrows the candidate set)
 *   * action      → "FILL"  (this cell sets / suggests the output)
 */
export const RULE_ROLE_OPERATOR_LABEL: Record<RuleRole, string> = {
  condition: "IF",
  restriction: "LIMIT",
  action: "FILL",
};

/**
 * Tone tokens used by every UI surface that paints a role-colored
 * affordance (cell badge, header chip, inspector pick). Centralised so
 * the three roles read consistently across the app — IF is amber
 * (decision), LIMIT is violet (narrowing), FILL is emerald (writing).
 *
 * Each entry is a pair of Tailwind classnames: `chip` is for compact
 * pill surfaces (lighter background + matched text), `ring` is for
 * full borders / outlines.
 */
export const RULE_ROLE_TONE: Record<
  RuleRole,
  { chip: string; ring: string; dot: string }
> = {
  condition: {
    chip: "bg-amber-50 text-amber-700 border-amber-200",
    ring: "border-amber-300",
    dot: "bg-amber-500",
  },
  restriction: {
    chip: "bg-violet-50 text-violet-700 border-violet-200",
    ring: "border-violet-300",
    dot: "bg-violet-500",
  },
  action: {
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
    ring: "border-emerald-300",
    dot: "bg-emerald-500",
  },
};

/**
 * Pointer into a master-data field or extracted-invoice field.
 *
 * For catalog-backed source types (`vendor_field`, `property_field`,
 * `gl_field`) the binding is ambiguous without naming WHICH saved
 * catalog of that kind to use — BillsIQ supports multiple saved
 * catalogs per kind. The two extra fields below resolve that
 * ambiguity and persist with the template:
 *
 *   * `catalog_id` — the stable id of the bound catalog. Source of
 *     truth for the runtime resolver.
 *   * `catalog_label` — cached display name at bind time. Used as a
 *     fallback when the live catalog list no longer contains the id
 *     (deleted catalog) so the inspector can still render a
 *     "(missing) ACME Vendors v3" affordance instead of a blank cell.
 *     Always prefer the live catalog list for display when the id
 *     resolves.
 *
 * Both extras are optional on the wire so legacy templates persisted
 * before catalog disambiguation deserialize cleanly. The builder UI
 * surfaces a "binding incomplete" warning when `catalog_id` is null
 * for a catalog-backed source — the save still goes through (mirrors
 * the same permissiveness we apply to `field`), but the warning makes
 * the gap obvious.
 *
 * `field` stays a loose string so the per-source field catalogs can
 * extend without a backend deploy. The future rendering engine will
 * fail loud when a `field` value can't be resolved against the bound
 * catalog's schema.
 */
export interface ColumnSourceRef {
  field: string | null;
  catalog_id?: string | null;
  catalog_label?: string | null;
}

/**
 * Loose validation hints. Phase 1 stores these on save; the
 * enforcement pass happens at render time in a future phase. Keeping
 * the bag deliberately open so adding new constraints later doesn't
 * break already-saved templates.
 */
export interface ColumnValidation {
  required_from_source?: boolean;
  must_be_in_list?: boolean;
  pattern?: string | null;
  min_length?: number | null;
  max_length?: number | null;
}

/**
 * One column inside a template's `columns` array.
 *
 * Beyond identity (`id`) and presentation (`name`), each column carries
 * its OUTPUT CONTRACT: whether it's required, where its value comes
 * from, optional binding details, and validation hints.
 *
 * `id` is a stable string key (not a numeric index) so reordering
 * preserves React-list identity. Generated client-side when adding a
 * row; the backend doesn't care about the value beyond uniqueness.
 *
 * `source_column` carries the original ResMan template column name when
 * this column was seeded from an upload. Null otherwise.
 *
 * Every metadata field beyond `{id, name, source_column}` is optional /
 * defaulted on the backend, so legacy rows persisted before the
 * Import Builder phase still deserialize without surgery.
 */
export interface InvoiceTemplateColumn {
  id: string;
  name: string;
  source_column: string | null;
  /** Defaults to `false`. */
  required?: boolean;

  // ---- Type / format contract (NEW — orthogonal to source) ----------------
  /**
   * Expected data type. Defaults to `"text"` — matches legacy columns
   * persisted before this field existed. Independent from `source_type`:
   * a column can pull from an invoice field but still expect to be
   * rendered as `currency` with two decimals.
   */
  data_type?: ColumnDataType;
  /**
   * Type-discriminated formatting hints. Null when no overrides were
   * authored — the renderer falls back to per-type defaults (e.g.
   * `MM/DD/YYYY` for date, 2 decimal places for currency). See
   * `ColumnFormat` for which fields apply to which `data_type`.
   */
  format?: ColumnFormat | null;

  // ---- Global / default behavior ------------------------------------------
  // The "Global behavior" section in the inspector. The legacy field name
  // is kept (`source_type` etc.) for backward compatibility; the product
  // surface no longer calls this "Value source" — it's the column's
  // GLOBAL/DEFAULT value strategy. Rule rows layer on top, gated by
  // `allow_rule_override`.
  /** Defaults to `"empty"`. The column's GLOBAL behavior mode. */
  source_type?: ColumnSourceType;
  /** Required (object) when `source_type` is one of REF_BINDING_SOURCES. */
  source_ref?: ColumnSourceRef | null;
  /** Required (>= 1 entry) when `source_type === "manual_list"`. */
  manual_values?: string[] | null;
  /** Used when `source_type === "fixed_value"`. */
  default_value?: string | null;
  /**
   * Whether row-based rules are allowed to override / contribute to
   * this column's global behavior at resolve time.
   *
   *   * `true`  (default) — rule rows whose action cell for this column
   *                         has values may REPLACE the global behavior
   *                         when the rule fires. Pre-rules behavior;
   *                         legacy templates default here so existing
   *                         rules keep working.
   *   * `false`           — the global behavior is LOCKED. Rule cells
   *                         under this column are still recorded (so
   *                         the user can flip the switch back without
   *                         re-authoring) but the resolver ignores
   *                         them. Use for "always X" columns like
   *                         Expense Type = "General" or hard-pinned
   *                         tax codes.
   *
   * The locked state is surfaced on the column header as a small lock
   * indicator and on each rule cell as a subdued "global wins" badge —
   * the operator should never be confused about why their rule isn't
   * applying.
   */
  allow_rule_override?: boolean;

  // ---- Validation + rule interaction --------------------------------------
  /** Loose bag of validation hints; ignored by the renderer in Phase 1. */
  validation?: ColumnValidation | null;
  /**
   * How this column behaves when it appears inside a rule row.
   * Defaults to `"action"` — the most permissive interpretation, so
   * legacy rows saved before rules existed don't silently introduce
   * surprise narrowing on already-saved templates.
   *
   * Phase 2 NOTE: this field is preserved as a BACKWARD-COMPAT ALIAS
   * for `default_rule_role` below. Always read via
   * `effectiveColumnDefaultRole(column)` so the fallback chain stays
   * consistent across call sites; never read `rule_role` directly in
   * new code.
   *
   * Independent from `allow_rule_override`: role decides HOW the rule
   * cell is interpreted; `allow_rule_override` decides WHETHER an
   * action-shaped result is allowed to replace the global behavior.
   */
  rule_role?: RuleRole;
  /**
   * Phase 2 — column's SUGGESTED default rule role. Optional; null
   * means "no column-level suggestion" (rule cells under this column
   * must specify their own `cell.role` to participate in resolution).
   * The editor mirrors writes — when the user picks an explicit
   * default, both `default_rule_role` and the legacy `rule_role` are
   * set; when the user clears the default, `default_rule_role` is set
   * to null and `rule_role` is left at the legacy default so older
   * readers keep functioning.
   *
   * Resolve via `effectiveColumnDefaultRole(column)` — never read raw.
   */
  default_rule_role?: RuleRole | null;
  /**
   * Phase 2 — the column cannot be drag-reordered. The drag handle
   * renders disabled with a small lock icon; the editor short-circuits
   * drop attempts onto/over a lock_position column so the relative
   * order of locked columns stays put. Defaults to `false`. Surface
   * via `columnLockPosition(column)` for the defaulted read.
   */
  lock_position?: boolean;
  /**
   * Phase 2 — the column's NAME / SOURCE / DATA TYPE / FORMAT /
   * VALIDATION cannot be edited from the UI. The inspector renders
   * inputs as read-only; rule cells UNDER this column REMAIN editable
   * (locking the schema doesn't lock authoring of rules that use it).
   * Distinct from `allow_rule_override`, which is about RUNTIME whether
   * a rule cell's value wins over the column's global behavior.
   * Defaults to `false`. Surface via `columnLockEditing(column)`.
   */
  lock_editing?: boolean;
}

/**
 * One structured selection inside a catalog-backed rule cell.
 *
 * Mirrors `app.schemas.invoice_template.RuleCellSelection`. Only
 * populated when the parent column binds to a catalog (vendor /
 * property / GL); non-catalog cells leave `selections` empty and
 * persist through `values` alone.
 *
 *   * `entry_id`    — stable id of the chosen catalog entry. The
 *                     resolver's authoritative key. Lives independent
 *                     of any field rename / display change in the
 *                     catalog row.
 *   * `field_value` — the value of the catalog row's BOUND FIELD
 *                     (whichever field the column's `source_ref.field`
 *                     names — e.g. `vendor_code` or `vendor_name`).
 *                     Cached at selection time so the legacy `values`
 *                     mirror keeps the same string the user picked.
 *   * `label`       — display string the picker showed at selection
 *                     time. For vendors this is `vendor_name` (richer
 *                     than the bound field, which might be a code),
 *                     for properties it's `property_name`, for GL it's
 *                     `code · description`. Cached so a deleted entry
 *                     can still be rendered as a "(missing) ACME Corp"
 *                     diagnostic chip rather than silently disappearing.
 */
export interface RuleCellSelection {
  entry_id: string;
  field_value: string;
  label: string;
}

/**
 * Per-cell extraction-context narrowing for `invoice_field` columns.
 *
 * Mirrors `app.schemas.invoice_template.RuleCellExtraction`. THIS IS
 * THE INVOICE BUILDER ↔ IMPORT BUILDER INTEGRATION POINT — see the
 * backend docstring for the full contract.
 *
 * Three intentional invariants:
 *
 *   1. **Optional, not required.** A rule cell with no `extraction`
 *      (or `extraction = null/undefined`) leaves the column's GLOBAL
 *      extraction behavior in place. For `invoice_field` columns
 *      that means "search across the broad universe of all saved
 *      patterns + OCR + AI inference". Rules NARROW the search; they
 *      don't gate it.
 *   2. **Cell-level, not column-level.** The column header still
 *      binds to a generic `invoice_field` source (e.g. "From extracted
 *      invoice → account_number") for the column's GLOBAL behavior.
 *      The pattern + field pick lives here on the rule cell so
 *      different rules can resolve the same column from different
 *      patterns.
 *   3. **Soft references.** Pattern deletion does NOT cascade — a
 *      rule cell pointing at a deleted pattern becomes inert at
 *      resolve time and the editor surfaces a "(deleted)" affordance
 *      via `pattern_label`.
 *
 * Fields:
 *   * `pattern_id`    — id of the chosen `InvoicePattern`. Null
 *                       means "use the broad universe" for this cell.
 *   * `field_key`     — canonical extracted-field key (e.g.
 *                       `"account_number"`) to resolve from the
 *                       chosen pattern. Loose string for forward-
 *                       compat with new canonical fields added to the
 *                       Invoice model without a frontend redeploy.
 *   * `pattern_label` — cached display name at pick time. Used as a
 *                       diagnostic fallback when the live pattern
 *                       summary list is missing the id (deleted
 *                       post-binding).
 */
export interface RuleCellExtraction {
  pattern_id: string | null;
  field_key: string | null;
  pattern_label?: string | null;
}

/**
 * One pattern→field extraction binding inside a rule cell.
 *
 * The Phase 2 evolution of {@link RuleCellExtraction}: a single rule
 * cell can now carry MULTIPLE bindings so one column (e.g. "Invoice
 * Number") can resolve from different patterns differently — e.g.
 * `EPB 2 → invoice_number`, `HWEA → account_number`,
 * `CDE Lightband → invoice_number`. Persisted as
 * `InvoiceTemplateRuleCell.extraction_bindings`.
 *
 * Why an array of complete bindings rather than `{ field_key,
 * pattern_ids: [...] }`: the field key can DIFFER per pattern. Vendors
 * label the same conceptual data inconsistently (one bills "Invoice
 * Number", another "Account Number" — same column, different fields).
 * Pinning the (pattern, field) pair together is the only shape that
 * captures that fan-out cleanly.
 *
 * Fields:
 *   * `pattern_id`   — id of the chosen `InvoicePattern`. Required for
 *                      a binding to be meaningful at runtime.
 *   * `pattern_label`— cached display name at pick time. Diagnostic
 *                      fallback when the live pattern was deleted
 *                      post-binding (renders as "(deleted) ACME
 *                      Bills"). Same forensic-cache contract as
 *                      `ColumnSourceRef.catalog_label`.
 *   * `field_key`    — canonical or pattern-custom field key to extract
 *                      from the chosen pattern. Loose string — the
 *                      pattern itself decides which field keys are
 *                      valid (built-in canonical OR operator-coined
 *                      custom fields living on
 *                      `InvoicePattern.field_definitions`).
 *   * `field_label`  — cached display name of the chosen field at pick
 *                      time. Lets the picker render a meaningful chip
 *                      even when the pattern changed its label or the
 *                      field was hidden post-binding. Same diagnostic
 *                      fallback strategy as `pattern_label`.
 *
 * Empty `pattern_id` or empty `field_key` mark an in-progress binding
 * (the picker can persist it while the operator is mid-flow); the
 * runtime treats incomplete bindings as broad-universe at resolve
 * time. {@link ruleCellHasExtraction} returns true only when at least
 * one fully-populated binding exists.
 */
export interface RuleCellExtractionBinding {
  pattern_id: string | null;
  pattern_label?: string | null;
  field_key: string | null;
  field_label?: string | null;
}

/**
 * One cell inside a rule row.
 *
 * Two parallel persistence surfaces, kept in lockstep by the editor:
 *
 *   * `values` — flat list of strings. The original / legacy shape;
 *     the runtime resolver and any debug surface can read this without
 *     knowing about catalog structure. For catalog cells it mirrors
 *     `selections[i].field_value` 1:1 (the value the resolver matches
 *     against the catalog's bound field). For non-catalog cells it's
 *     the literal authored strings.
 *
 *   * `selections` — structured catalog picks. Only populated for
 *     catalog-backed source kinds (vendor / property / gl). Carries
 *     entry id, field value, and a display label so the editor can
 *     render polished chips, surface missing-entry diagnostics, and
 *     resolve to the catalog row by id (not by string match).
 *
 * Both arrays are optional on the wire — legacy templates persisted
 * before structured selections existed deserialize cleanly with
 * `selections` defaulted to []. The editor materialises `selections`
 * on first edit of a catalog cell; it never strips it from a cell
 * that already carries structured data.
 */
export interface InvoiceTemplateRuleCell {
  values: string[];
  /**
   * Structured catalog selections. Optional in the wire shape but
   * always present after the editor first writes a catalog cell.
   * Non-catalog cells leave this as `[]` (or omit it entirely on the
   * wire — the backend defaults to `[]` either way).
   */
  selections?: RuleCellSelection[];
  /**
   * LEGACY single-binding extraction narrowing — superseded by
   * `extraction_bindings` in Phase 2 but still accepted on the wire so
   * templates persisted before the multi-binding refactor deserialize
   * cleanly. Read paths should NOT consult this directly; route through
   * {@link readRuleCellExtractionBindings} which folds a populated
   * `extraction` into a one-item bindings list. Editors NEVER write
   * this field anymore — they write `extraction_bindings` and leave
   * the legacy field alone (so a future cleanup pass can drop it
   * without re-rewriting saved cells).
   *
   * @deprecated Use `extraction_bindings`. Kept for read-side back-compat.
   */
  extraction?: RuleCellExtraction | null;
  /**
   * Per-cell extraction-context narrowing — meaningful only when the
   * parent column's `source_type` is `invoice_field`. Each entry pins
   * one (pattern, field) pair; the cell resolves to the FIRST matching
   * pattern at runtime (priority = list order). Empty / undefined
   * means "use the column's global extraction behavior" — the broad-
   * universe + OCR + AI fallback.
   *
   * Replaces the legacy single `extraction` field; readers should
   * prefer this list (see {@link readRuleCellExtractionBindings} for
   * the legacy fallback). Editors always write the new field; the
   * legacy field is left untouched on round-trip.
   *
   * See {@link RuleCellExtractionBinding} for the per-entry shape and
   * the broader Invoice Builder ↔ Import Builder integration contract.
   */
  extraction_bindings?: RuleCellExtractionBinding[];
  /**
   * Phase 2 — per-cell rule role override. When `null` / undefined, the
   * cell inherits its column's `default_rule_role` at resolve time
   * (which itself falls back to the legacy `rule_role` field — see
   * `effectiveCellRole(cell, column)`). When set, this cell's
   * interpretation WINS over the column's suggestion: the same column
   * may behave as a CONDITION in one rule and an ACTION in another.
   *
   * Why nullable rather than defaulting to a concrete role: legacy
   * cells have no `role` on the wire; defaulting to a concrete value
   * here would silently rewrite every legacy cell to carry an explicit
   * role and mask the column-level fallback that may have been
   * intentionally left implicit.
   */
  role?: RuleRole | null;
}

/**
 * One rule row. A rule is a horizontal slice across the template's
 * columns whose behavior is interpreted through each column's
 * `rule_role`:
 *
 *   * Cells in `condition` columns scope the rule's applicability.
 *   * Cells in `restriction` columns narrow the candidate universe.
 *   * Cells in `action` columns suggest / set output values.
 *
 * `cells` is a dict keyed by COLUMN ID (not a list parallel to
 * `columns`) so column reorders/deletes don't desync cells. Cells
 * whose column id is no longer present in the template are inert —
 * the editor scrubs them on column delete; the resolver ignores them.
 *
 * `is_active` is a per-row toggle that's persisted alongside the rule.
 * Inactive rules are kept in the template so the user can flip them
 * on/off without re-authoring; the runtime resolver skips them.
 *
 * `notes` is an optional free-text annotation for the operator's
 * benefit (e.g. "EPB-specific override agreed with accounting").
 */
export interface InvoiceTemplateRule {
  id: string;
  is_active: boolean;
  cells: Record<string, InvoiceTemplateRuleCell>;
  notes?: string | null;
  /**
   * Phase 2 — the rule cannot be drag-reordered. Useful when rules
   * have priority semantics (the editor renders rules top-to-bottom
   * and a future-phase resolver applies them in that order) and the
   * operator wants to pin a "fallback" rule at the bottom or a
   * "highest-priority override" at the top. Defaults to `false`. Read
   * via `ruleLockPosition(rule)` for the defaulted accessor.
   */
  lock_position?: boolean;
  /**
   * Phase 2 — the rule's metadata (notes, is_active toggle) AND its
   * cells cannot be edited. The header menu still surfaces "Unlock"
   * so the operator can flip back. Used to freeze a reviewed/approved
   * rule against accidental tweaks during adjacent editing. Defaults
   * to `false`. Read via `ruleLockEditing(rule)`.
   */
  lock_editing?: boolean;
}

export interface InvoiceTemplateOut {
  id: string;
  name: string;
  description: string | null;
  columns: InvoiceTemplateColumn[];
  /**
   * Defaulted to `[]` server-side for legacy rows so the editor
   * always sees an array. Order is the persisted authoring order.
   */
  rules: InvoiceTemplateRule[];
  source: InvoiceTemplateSource;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceTemplateSummary {
  id: string;
  name: string;
  description: string | null;
  source: InvoiceTemplateSource;
  column_count: number;
  /** Number of rule rows attached. Surfaced as a small left-rail badge. */
  rule_count: number;
  created_at: string;
  updated_at: string;
}

export interface InvoiceTemplateList {
  items: InvoiceTemplateSummary[];
}

/**
 * Built-in canonical template returned by GET /defaults/canonical.
 * Not persisted — the frontend uses it as an editable starter draft.
 * Each canonical column comes pre-bound to a sensible source AND a
 * sensible rule role so the draft demonstrates both layers in action.
 * Rules ship empty — rules are an authoring concern, not a canonical
 * shape concern.
 */
export interface InvoiceTemplateDefault {
  name: string;
  description: string | null;
  columns: InvoiceTemplateColumn[];
  rules: InvoiceTemplateRule[];
}

/** POST body — all top-level fields required (rules optional / defaults to []). */
export interface InvoiceTemplateCreate {
  name: string;
  description?: string | null;
  columns: InvoiceTemplateColumn[];
  /**
   * Optional on the wire — backend defaults to `[]` if omitted, so
   * pre-rules clients keep working. The editor always sends the full
   * current rule list (replace-not-merge semantics).
   */
  rules?: InvoiceTemplateRule[];
  source?: InvoiceTemplateSource;
}

/**
 * PATCH body. Every field optional; omitting a field leaves the
 * persisted value unchanged. Sending `columns` or `rules` REPLACES
 * the array outright — the editor always sends the full new ordered
 * list. Sending `null` for `description` clears it. To clear all
 * rules, send `rules: []` (empty array, not undefined).
 */
export interface InvoiceTemplateUpdate {
  name?: string;
  description?: string | null;
  columns?: InvoiceTemplateColumn[];
  rules?: InvoiceTemplateRule[];
}

/** Bounds enforced by the backend Pydantic schema. */
export const MIN_COLUMNS = 1;
export const MAX_COLUMNS = 200;
export const MAX_COLUMN_NAME_LENGTH = 200;
/**
 * Rule-row bounds — surfaced here so the editor can disable the
 * "Add rule" button at the cap rather than waiting for the server
 * to reject the save. Mirrors the backend constants exactly.
 */
export const MAX_RULES = 500;
export const MAX_RULE_CELL_VALUES = 100;
export const MAX_RULE_CELL_VALUE_LENGTH = 200;
export const MAX_RULE_NOTES_LENGTH = 500;

/**
 * Generate a stable client-side id for a freshly-added column. Uses
 * `crypto.randomUUID` where available, falls back to a Math.random
 * hex so the column-id contract still holds in environments without
 * a crypto API (very old browsers, SSR test runners). The backend
 * validates uniqueness within the template, not the format.
 */
export function newColumnId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Math.random().toString(16).slice(2, 10)}-${Date.now().toString(
    16,
  )}`;
}

// ---------------------------------------------------------------------------
// Field catalogs for ref-binding source kinds
// ---------------------------------------------------------------------------
//
// These define the dropdown options the inspector shows when the user
// picks a source kind that points at a master-data field. They mirror
// the canonical field shapes of GL Codes / Properties / Vendors and
// the invoice-extraction surface respectively. Hardcoded for Phase 1;
// future work will fetch them from the actual catalog schemas so
// adding a field there propagates automatically.
//
// Each entry:
//   * `value` — the string stored in `source_ref.field`
//   * `label` — what the inspector dropdown shows the user
//
// Adding new entries here is safe — the schema accepts arbitrary
// strings on the wire.

export interface ColumnFieldOption {
  value: string;
  label: string;
}

export const PROPERTY_FIELD_OPTIONS: readonly ColumnFieldOption[] = [
  { value: "abbreviation", label: "Abbreviation" },
  { value: "name", label: "Property name" },
  { value: "external_id", label: "External ID" },
  { value: "address", label: "Address" },
  { value: "city", label: "City" },
  { value: "state", label: "State" },
  { value: "zip", label: "ZIP" },
] as const;

export const VENDOR_FIELD_OPTIONS: readonly ColumnFieldOption[] = [
  { value: "vendor_code", label: "Vendor code" },
  { value: "vendor_name", label: "Vendor name" },
  { value: "external_id", label: "External ID" },
  { value: "address", label: "Address" },
  { value: "city", label: "City" },
  { value: "state", label: "State" },
  { value: "zip", label: "ZIP" },
  { value: "contact_name", label: "Contact name" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
] as const;

export const GL_FIELD_OPTIONS: readonly ColumnFieldOption[] = [
  { value: "gl_code", label: "GL code" },
  { value: "description", label: "Description" },
] as const;

export const INVOICE_FIELD_OPTIONS: readonly ColumnFieldOption[] = [
  { value: "invoice_number", label: "Invoice number" },
  { value: "invoice_date", label: "Invoice date" },
  { value: "accounting_date", label: "Accounting date" },
  { value: "due_date", label: "Due date" },
  { value: "amount", label: "Amount" },
  { value: "tax", label: "Tax" },
  { value: "total", label: "Total" },
  { value: "currency", label: "Currency" },
  { value: "po_number", label: "PO number" },
  { value: "line_item_description", label: "Line item description" },
  { value: "vendor_name", label: "Vendor name (extracted)" },
  { value: "notes", label: "Notes" },
] as const;

/**
 * Look up the option list for a given ref-binding source type. Returns
 * an empty array for non-ref-binding kinds; the inspector hides the
 * field picker in that case.
 */
export function fieldOptionsFor(
  source: ColumnSourceType,
): readonly ColumnFieldOption[] {
  switch (source) {
    case "property_field":
      return PROPERTY_FIELD_OPTIONS;
    case "vendor_field":
      return VENDOR_FIELD_OPTIONS;
    case "gl_field":
      return GL_FIELD_OPTIONS;
    case "invoice_field":
      return INVOICE_FIELD_OPTIONS;
    default:
      return [];
  }
}

/**
 * Compact human label for a column source kind. Used by the column
 * header chip + the inspector's source dropdown. Centralised so the
 * label stays consistent everywhere a source kind shows up.
 */
export const SOURCE_TYPE_LABEL: Record<ColumnSourceType, string> = {
  empty: "Empty (fill later)",
  fixed_value: "Fixed value",
  manual_list: "Manual list",
  invoice_field: "From invoice",
  property_field: "From Properties",
  vendor_field: "From Vendors",
  gl_field: "From GL Codes",
  derived: "Derived (rule)",
};

/**
 * Human-readable label for the *kind* of catalog a catalog-backed
 * source type binds against. Used by the inspector's catalog selector
 * heading + by the empty-state copy when no catalogs of that kind
 * exist. Returns null for non-catalog source kinds so callers can
 * branch off "is this a catalog binding?" with one lookup.
 */
export function catalogKindLabel(
  source: ColumnSourceType,
): { singular: string; plural: string; routePath: string } | null {
  switch (source) {
    case "vendor_field":
      return {
        singular: "vendor catalog",
        plural: "Vendor catalogs",
        routePath: "/reference-data/vendors",
      };
    case "property_field":
      return {
        singular: "property catalog",
        plural: "Property catalogs",
        routePath: "/reference-data/properties",
      };
    case "gl_field":
      return {
        singular: "GL catalog",
        plural: "GL catalogs",
        routePath: "/reference-data/gl-codes",
      };
    default:
      return null;
  }
}

/**
 * Default (`empty`) column metadata. Useful for fresh inserts so the
 * column has explicit defaults rather than relying on undefined
 * cascading through the editor.
 *
 * `rule_role` defaults to `"action"` to match the backend default —
 * a freshly-added column behaves as an action-only contributor in
 * any existing rules until the user reassigns it.
 *
 * `data_type` defaults to `"text"` (the most permissive shape — any
 * string is a valid text value).
 *
 * `allow_rule_override` defaults to `true` — same behavior as before
 * `allow_rule_override` existed, so toggling the field on for the
 * first time on a legacy template doesn't silently lock down rules.
 */
export function defaultColumnMetadata(): Pick<
  InvoiceTemplateColumn,
  | "required"
  | "data_type"
  | "format"
  | "source_type"
  | "source_ref"
  | "manual_values"
  | "default_value"
  | "allow_rule_override"
  | "validation"
  | "rule_role"
  | "default_rule_role"
  | "lock_position"
  | "lock_editing"
> {
  return {
    required: false,
    data_type: "text",
    format: null,
    source_type: "empty",
    source_ref: null,
    manual_values: null,
    default_value: null,
    allow_rule_override: true,
    validation: null,
    // Mirror writes — keep the legacy `rule_role` set to its prior
    // default so older readers keep working, AND set the new
    // `default_rule_role` to match. New columns ship with "action" as
    // the default suggestion (most permissive interpretation).
    rule_role: "action",
    default_rule_role: "action",
    lock_position: false,
    lock_editing: false,
  };
}

/**
 * Compact human label for a rule role. Used by the column header chip,
 * the inspector dropdown, and the rule-row visual differentiation.
 * Centralised so the wording stays consistent everywhere a role shows up.
 */
export const RULE_ROLE_LABEL: Record<RuleRole, string> = {
  condition: "Condition",
  restriction: "Restriction",
  action: "Action",
};

/**
 * One-line description of each rule role. Used in the inspector's
 * Rule Role section as helper copy under the role picker.
 */
export const RULE_ROLE_DESCRIPTION: Record<RuleRole, string> = {
  condition:
    "When this cell has values, the rule fires for invoices matching one of them.",
  restriction:
    "When the rule fires, this cell narrows the candidate set for that column.",
  action:
    "When the rule fires, this cell suggests / sets the column's output value.",
};

/**
 * Generate a stable client-side id for a freshly-added rule row.
 * Same generation strategy as `newColumnId` — UUID where available,
 * fallback otherwise. The backend validates uniqueness within the
 * template, not the format.
 */
export function newRuleId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `r-${Math.random().toString(16).slice(2, 10)}-${Date.now().toString(
    16,
  )}`;
}

/**
 * Empty cell for a freshly-added rule. The cell exists with empty
 * `values` AND `selections` lists so the editor can index into
 * `rule.cells[columnId]` without conditional spread; serialization
 * keeps the dual shape round-trip stable. Both arrays travel; the
 * backend strips down equivalent shapes on save.
 *
 * Both extraction-binding shapes default to empty:
 *   * `extraction`         — legacy single-binding, kept null so
 *                            readers that still consult it explicitly
 *                            see "no narrowing".
 *   * `extraction_bindings`— Phase 2 multi-binding list, defaulted to
 *                            `[]` (broad-universe = no entries) so the
 *                            picker can `.push` without a null-guard.
 */
export function emptyRuleCell(): InvoiceTemplateRuleCell {
  return {
    values: [],
    selections: [],
    extraction: null,
    extraction_bindings: [],
    role: null,
  };
}

/**
 * Read the catalog-style selections of a cell with a non-undefined
 * fallback. Wire-format cells from older saves may omit `selections`
 * entirely; this helper centralises the `?? []` so call sites don't
 * sprinkle the fallback. The returned array is the cell's array (no
 * copy) so callers are expected to treat it read-only.
 */
export function ruleCellSelections(
  cell: InvoiceTemplateRuleCell,
): readonly RuleCellSelection[] {
  return cell.selections ?? [];
}

/**
 * Whether a cell carries at least one MEANINGFUL extraction-narrowing
 * binding. "Meaningful" = both `pattern_id` AND `field_key` are
 * populated (partial bindings stay around in-flight while the operator
 * is mid-flow but don't count as narrowed for the UI's badge logic).
 * Folds the legacy single `extraction` field into the bindings list
 * via {@link readRuleCellExtractionBindings} so old templates keep
 * lighting up the "Narrowed" affordance until they're re-saved into
 * the new shape.
 */
export function ruleCellHasExtraction(
  cell: InvoiceTemplateRuleCell,
): boolean {
  const bindings = readRuleCellExtractionBindings(cell);
  return bindings.some(extractionBindingIsComplete);
}

/**
 * Whether one binding entry is fully populated (both `pattern_id` and
 * `field_key` are non-empty strings). Centralised so picker / badge
 * call sites don't re-derive the predicate.
 */
export function extractionBindingIsComplete(
  binding: RuleCellExtractionBinding,
): boolean {
  return (
    typeof binding.pattern_id === "string" &&
    binding.pattern_id.length > 0 &&
    typeof binding.field_key === "string" &&
    binding.field_key.length > 0
  );
}

/**
 * Read the cell's extraction bindings with legacy migration applied.
 *
 * Migration rules (read-only — never mutates the cell):
 *   1. If `extraction_bindings` is a non-empty array, return it as-is.
 *   2. Else if the legacy `extraction` field has a populated
 *      `pattern_id`, fold it into a one-item bindings array. Carries
 *      the cached `pattern_label` through; `field_label` defaults to
 *      undefined (we never persisted one in the legacy shape).
 *   3. Otherwise return `[]` (broad-universe fallback).
 *
 * Editors never write the legacy `extraction` field — they write
 * `extraction_bindings` and leave `extraction` alone so a future
 * cleanup pass can drop the legacy field without rewriting saved
 * cells. On the next save round-trip the cell gets the migrated
 * bindings persisted, but the legacy field stays present for any
 * older reader that hasn't yet been updated.
 */
export function readRuleCellExtractionBindings(
  cell: InvoiceTemplateRuleCell,
): RuleCellExtractionBinding[] {
  const explicit = cell.extraction_bindings;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit;
  }
  const legacy = cell.extraction;
  if (
    legacy != null &&
    typeof legacy.pattern_id === "string" &&
    legacy.pattern_id.length > 0
  ) {
    return [
      {
        pattern_id: legacy.pattern_id,
        pattern_label: legacy.pattern_label ?? null,
        field_key: legacy.field_key ?? null,
        field_label: null,
      },
    ];
  }
  return [];
}

/**
 * Build a fresh empty binding row for the picker's "+ Add binding"
 * affordance. Keeps the shape canonical (both ids null, both labels
 * null) so persistence doesn't get a half-undefined object that's hard
 * to reason about downstream.
 */
export function emptyExtractionBinding(): RuleCellExtractionBinding {
  return {
    pattern_id: null,
    pattern_label: null,
    field_key: null,
    field_label: null,
  };
}

/**
 * Construct a fresh rule row with the given column ids pre-keyed to
 * empty cells. Order of column-id iteration determines column order
 * the editor sees, but the dict shape itself is order-insensitive.
 */
export function newRule(columnIds: readonly string[]): InvoiceTemplateRule {
  const cells: Record<string, InvoiceTemplateRuleCell> = {};
  for (const id of columnIds) {
    cells[id] = emptyRuleCell();
  }
  return {
    id: newRuleId(),
    is_active: true,
    cells,
    notes: null,
    lock_position: false,
    lock_editing: false,
  };
}

// ---------------------------------------------------------------------------
// Data type / format — labels, options, helpers
// ---------------------------------------------------------------------------

/** Compact label for a data type. Used by the inspector + column header. */
export const COLUMN_DATA_TYPE_LABEL: Record<ColumnDataType, string> = {
  text: "Text",
  number: "Number",
  currency: "Currency",
  date: "Date",
  boolean: "Yes / no",
  dropdown: "Dropdown",
  multi_select: "Multi-select",
};

/** One-line description shown under each option in the data-type picker. */
export const COLUMN_DATA_TYPE_DESCRIPTION: Record<ColumnDataType, string> = {
  text: "Free-form string. Default for new columns.",
  number: "Numeric. Configure decimal places under Format.",
  currency:
    "Monetary value. Configure decimal places + currency code under Format.",
  date: "Calendar date. Configure the output format pattern under Format.",
  boolean: "True / false. Renders as a toggle in the inspector.",
  dropdown: "Single pick from a closed set. Configure options under Format.",
  multi_select:
    "Multiple picks from a closed set. Configure options + separator under Format.",
};

/** Order in which the data-type picker lists options. */
export const COLUMN_DATA_TYPE_ORDER: readonly ColumnDataType[] = [
  "text",
  "number",
  "currency",
  "date",
  "boolean",
  "dropdown",
  "multi_select",
];

/** Common date format presets surfaced in the inspector. */
export const DATE_FORMAT_OPTIONS: readonly ColumnFieldOption[] = [
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY (US)" },
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY (EU)" },
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD (ISO 8601)" },
  { value: "MMM D, YYYY", label: "MMM D, YYYY (Jan 5, 2026)" },
  { value: "M/D/YY", label: "M/D/YY (compact)" },
] as const;

/** Decimal-place options for the format subform (number / currency). */
export const DECIMAL_PLACES_OPTIONS: readonly number[] = [0, 1, 2, 3, 4, 6];

/** Common ISO currency codes surfaced in the format picker. */
export const COMMON_CURRENCY_CODES: readonly ColumnFieldOption[] = [
  { value: "USD", label: "USD — US dollar" },
  { value: "EUR", label: "EUR — Euro" },
  { value: "GBP", label: "GBP — British pound" },
  { value: "CAD", label: "CAD — Canadian dollar" },
  { value: "AUD", label: "AUD — Australian dollar" },
  { value: "MXN", label: "MXN — Mexican peso" },
  { value: "JPY", label: "JPY — Japanese yen" },
] as const;

/**
 * Resolve the column's effective `allow_rule_override` value, applying
 * the field's default when the column was persisted before the field
 * existed. Centralised so call sites don't sprinkle `?? true`.
 */
export function columnAllowsRuleOverride(
  column: InvoiceTemplateColumn,
): boolean {
  return column.allow_rule_override ?? true;
}

/**
 * Resolve the column's effective `data_type`, applying the default for
 * legacy columns persisted before this field existed.
 */
export function columnDataType(column: InvoiceTemplateColumn): ColumnDataType {
  return column.data_type ?? "text";
}

/**
 * Synonym for "the column's GLOBAL behavior mode" — returns the same
 * value as reading `source_type` (with default), but the named accessor
 * keeps call sites consistent with the product surface where the
 * concept is called Global behavior, not Source. Use this in any code
 * that surfaces the concept to the user.
 */
export function columnGlobalMode(
  column: InvoiceTemplateColumn,
): ColumnSourceType {
  return column.source_type ?? "empty";
}

/**
 * Centralised pretty label for the GLOBAL behavior dropdown. Same
 * underlying values as `SOURCE_TYPE_LABEL` — kept as a separate const
 * so future divergence (e.g. wording tweaks for the global section
 * specifically) doesn't ripple back into the rule-cell editor copy
 * that uses SOURCE_TYPE_LABEL.
 */
export const GLOBAL_MODE_LABEL: Record<ColumnSourceType, string> = {
  empty: "No global behavior (blank)",
  fixed_value: "Always the same fixed value",
  manual_list: "Pick from a fixed list at render",
  invoice_field: "From the extracted invoice",
  property_field: "From the Properties catalog",
  vendor_field: "From the Vendors catalog",
  gl_field: "From the GL Codes catalog",
  derived: "Derived (rule editor coming soon)",
};

// ---------------------------------------------------------------------------
// Data-type ↔ Global-behavior compatibility matrix
// ---------------------------------------------------------------------------
//
// Not every (data_type, source_type) pairing makes sense — e.g. a `date`
// column with global mode `manual_list` would let the user enumerate
// arbitrary strings as if they were dates, and `dropdown` plus a generic
// `fixed_value` fights the dropdown's "pick from an allowed set" model
// (a dropdown's "default" should be a SELECTION FROM ITS UNIVERSE, not
// an unrelated literal). The matrix below codifies which Global behavior
// modes the Import Builder offers for each Data type.
//
// Design principles:
//
//   * EVERY data type allows `empty` and `derived` — the most permissive
//     ("no global; rule rows are the writer") and the future-rule
//     ("computed by an expression") modes are universally meaningful.
//
//   * Free-shape types (text/number/currency/date/boolean) allow
//     `fixed_value` and `invoice_field` — the value comes from a literal
//     or an extracted invoice payload, both of which can be coerced to
//     the column's shape at render time.
//
//   * Catalog-backed bindings (`property_field`/`vendor_field`/`gl_field`)
//     are restricted to types where it makes UX sense to bind a column
//     to a catalog row's field: `text` (the most common — vendor name,
//     property abbreviation, GL code) and the closed-set types
//     (`dropdown`/`multi_select`, where the catalog IS the universe).
//     Non-text scalars (number/currency/date/boolean) typically don't
//     come from a catalog field; we keep the matrix tight to avoid
//     suggesting nonsensical bindings.
//
//   * `manual_list` is restricted to `text` plus the closed-set types
//     (`dropdown`/`multi_select`) — it's the natural "this column's
//     universe is an inline enum" mode and maps directly onto the
//     dropdown's "allowed values" concept.
//
//   * `dropdown` and `multi_select` deliberately EXCLUDE the generic
//     `fixed_value` — for those types, "always emit X" is expressed as
//     "default selected option from the allowed list" (mapped onto
//     `default_value` next to the `manual_list` universe), not as an
//     unrelated literal that bypasses the universe entirely.
//
// This matrix is the FRONTEND advisory shape — it drives the UI's
// available choices but is intentionally NOT enforced at the Pydantic
// layer (back-compat: legacy templates persisted before the matrix may
// carry combinations that the matrix would now reject; we won't break
// their save path). The backend mirrors the same matrix as documentation
// + a public helper for any future server-side hooks that opt in.
export const COMPATIBLE_GLOBAL_MODES: Record<
  ColumnDataType,
  readonly ColumnSourceType[]
> = {
  text: [
    "empty",
    "fixed_value",
    "manual_list",
    "invoice_field",
    "property_field",
    "vendor_field",
    "gl_field",
    "derived",
  ],
  number: ["empty", "fixed_value", "invoice_field", "derived"],
  currency: ["empty", "fixed_value", "invoice_field", "derived"],
  date: ["empty", "fixed_value", "invoice_field", "derived"],
  boolean: ["empty", "fixed_value", "invoice_field", "derived"],
  dropdown: [
    "empty",
    "manual_list",
    "property_field",
    "vendor_field",
    "gl_field",
    "invoice_field",
    "derived",
  ],
  multi_select: [
    "empty",
    "manual_list",
    "property_field",
    "vendor_field",
    "gl_field",
    "derived",
  ],
};

/**
 * Is `source` a recommended Global behavior for `dataType`? Reads the
 * `COMPATIBLE_GLOBAL_MODES` matrix. `false` doesn't mean the combination
 * is REJECTED (the persisted shape tolerates anything for back-compat) —
 * it means the Import Builder won't surface that combination as a
 * default option in the picker. Legacy columns whose persisted source
 * type isn't in their type's recommended list still render in the
 * inspector with a "not recommended" affordance so the user can keep
 * or migrate.
 */
export function isGlobalModeCompatibleWith(
  dataType: ColumnDataType,
  source: ColumnSourceType,
): boolean {
  return COMPATIBLE_GLOBAL_MODES[dataType].includes(source);
}

/**
 * Build a normalisation patch when the user changes a column's
 * `data_type` and the previously-chosen `source_type` is no longer
 * recommended for the new type. Returns the data_type change PLUS, when
 * needed, a reset of the global-mode fields to a clean `empty` slate so
 * we don't ship surprising combinations like a `date` column with a
 * `manual_list` of strings.
 *
 * Behavior:
 *   * If the current source_type is still compatible with the new data
 *     type, returns just `{ data_type: nextDataType }` — preserve every
 *     other field exactly. The user's existing global binding is kept
 *     intact, including the format bag (the renderer ignores irrelevant
 *     fields, so e.g. `decimal_places=2` left over from a flip away
 *     from currency does no harm).
 *   * If the current source_type is INCOMPATIBLE with the new data
 *     type, returns the data_type change AND clears the now-orphaned
 *     global-mode metadata: source_type back to `empty`, source_ref /
 *     manual_values / default_value all to null. The user is then
 *     prompted (via the filtered Global behavior picker) to pick a
 *     compatible mode for the new type.
 *
 * Why we don't preserve the old source_type "in case the user flips
 * back": flipping types is an authoring decision, not a typo. Keeping a
 * dropped binding silently around encourages inconsistent state ("the
 * column says it's a date but it has a manual_values list of color
 * names from when it was a dropdown"). The cost of re-binding is one
 * picker click; the cost of silent inconsistency is hours of debugging.
 *
 * Why we DON'T touch `format` here: `format` is type-discriminated at
 * render time (decimal_places only matters for number/currency, etc.),
 * so an irrelevant field is a no-op. Stripping it would punish users
 * who flip away and back; the renderer gracefully ignores the unused
 * fields. We DO clear it indirectly elsewhere (the FormatSection's
 * `patch` collapses to null when every field becomes empty), so a
 * normal authoring flow keeps the JSONB clean.
 */
export function coerceColumnForDataType(
  column: InvoiceTemplateColumn,
  nextDataType: ColumnDataType,
): Partial<InvoiceTemplateColumn> {
  const currentSource = columnGlobalMode(column);
  if (isGlobalModeCompatibleWith(nextDataType, currentSource)) {
    return { data_type: nextDataType };
  }
  return {
    data_type: nextDataType,
    source_type: "empty",
    source_ref: null,
    manual_values: null,
    default_value: null,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — rule-role resolution + locking accessors
// ---------------------------------------------------------------------------

/**
 * Resolve the column's effective default rule role — the role that
 * cells under this column inherit when they don't carry their own
 * `role` override. Resolution order:
 *
 *   1. `column.default_rule_role` (Phase 2 field) when defined and
 *      non-undefined. May be `null` — that explicitly means "no
 *      default suggestion at the column level".
 *   2. `column.rule_role` (legacy field) when `default_rule_role`
 *      hasn't been written yet. The legacy default of `"action"`
 *      keeps pre-Phase-2 templates behaving the same way.
 *   3. `null` if neither is set (only happens for malformed payloads
 *      that strip both fields; defensively returns null).
 *
 * Returns `null` when the column declares "no suggestion" — caller
 * UI can render a neutral / unspecified affordance.
 */
export function effectiveColumnDefaultRole(
  column: InvoiceTemplateColumn,
): RuleRole | null {
  // `default_rule_role` is intentionally nullable: an explicit `null`
  // is a meaningful answer ("no column-level suggestion"), distinct
  // from `undefined` ("legacy column, fall back to rule_role").
  if (column.default_rule_role !== undefined) {
    return column.default_rule_role;
  }
  return column.rule_role ?? null;
}

/**
 * Resolve the EFFECTIVE rule role for a single cell — the value the
 * runtime resolver would use to interpret the cell. Matches the
 * documented order:
 *
 *     cell.role ?? column.default_rule_role ?? null
 *
 * `column` is optional so call sites that have only the cell handy
 * (e.g. a debug dump) can still ask "did the operator pin a role on
 * this cell explicitly?". Returns `null` for cells where no role is
 * resolvable — those cells are purely informational at extract time.
 */
export function effectiveCellRole(
  cell: InvoiceTemplateRuleCell,
  column?: InvoiceTemplateColumn | null,
): RuleRole | null {
  if (cell.role !== undefined && cell.role !== null) {
    return cell.role;
  }
  if (column == null) return null;
  return effectiveColumnDefaultRole(column);
}

/**
 * Construct the column-side patch the editor should apply when the
 * user picks a new default role from the inspector / header menu.
 * Mirrors the pick onto BOTH the new `default_rule_role` field and
 * the legacy `rule_role` field so older readers keep working:
 *
 *   * Picking a concrete role  → both fields set to that role.
 *   * Picking "no suggestion"  → `default_rule_role: null`, legacy
 *                                `rule_role` left at its prior value
 *                                (so consumers that only know about
 *                                `rule_role` keep their last-known
 *                                interpretation rather than getting
 *                                an undefined / blank state).
 *
 * Centralised so editor code doesn't have to re-derive the mirroring
 * rules at every call site.
 */
export function setColumnDefaultRolePatch(
  column: InvoiceTemplateColumn,
  next: RuleRole | null,
): Partial<InvoiceTemplateColumn> {
  if (next == null) {
    return { default_rule_role: null };
  }
  return { default_rule_role: next, rule_role: next };
}

/**
 * Defaulted accessor for `column.lock_position`. Centralised so call
 * sites don't sprinkle `?? false`. A locked column cannot be drag-
 * reordered; the editor renders its drag handle disabled.
 */
export function columnLockPosition(column: InvoiceTemplateColumn): boolean {
  return column.lock_position ?? false;
}

/**
 * Defaulted accessor for `column.lock_editing`. A column that's
 * locked-for-editing renders its inspector inputs read-only; rule
 * cells under it remain authorable.
 */
export function columnLockEditing(column: InvoiceTemplateColumn): boolean {
  return column.lock_editing ?? false;
}

/**
 * Defaulted accessor for `rule.lock_position`. A locked rule cannot
 * be drag-reordered; the editor renders its drag handle disabled.
 */
export function ruleLockPosition(rule: InvoiceTemplateRule): boolean {
  return rule.lock_position ?? false;
}

/**
 * Defaulted accessor for `rule.lock_editing`. A rule that's
 * locked-for-editing has its notes / is_active toggle / cells frozen;
 * the header menu still surfaces "Unlock" so the operator can flip
 * back.
 */
export function ruleLockEditing(rule: InvoiceTemplateRule): boolean {
  return rule.lock_editing ?? false;
}
