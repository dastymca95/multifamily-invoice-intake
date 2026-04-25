"use client";

import {
  AlertTriangle,
  Asterisk,
  Building2,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  Coins,
  CornerDownRight,
  Database,
  ExternalLink,
  FileSpreadsheet,
  Hash,
  Info,
  Library,
  ListChecks,
  Loader2,
  Lock,
  LockKeyhole,
  LockOpen,
  Pin,
  Plus,
  Scale,
  Sigma,
  Square,
  Sparkles,
  Target,
  ToggleLeft,
  Type,
  Users,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useCallback } from "react";

import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/utils";
import {
  CATALOG_BINDING_SOURCES,
  COLUMN_DATA_TYPE_DESCRIPTION,
  COLUMN_DATA_TYPE_LABEL,
  COLUMN_DATA_TYPE_ORDER,
  COMMON_CURRENCY_CODES,
  COMPATIBLE_GLOBAL_MODES,
  type ColumnDataType,
  type ColumnFormat,
  type ColumnSourceType,
  DATE_FORMAT_OPTIONS,
  DECIMAL_PLACES_OPTIONS,
  GLOBAL_MODE_LABEL,
  type InvoiceTemplateColumn,
  REF_BINDING_SOURCES,
  RULE_ROLE_DESCRIPTION,
  RULE_ROLE_LABEL,
  type RuleRole,
  catalogKindLabel,
  coerceColumnForDataType,
  columnAllowsRuleOverride,
  columnDataType,
  columnGlobalMode,
  columnLockEditing,
  columnLockPosition,
  fieldOptionsFor,
} from "@/types/invoice-template";

import {
  type CatalogIndex,
  catalogSliceFor,
} from "../hooks/useCatalogIndex";

/**
 * Right-side inspector panel for the currently-selected column.
 *
 * The Import Builder keeps the spreadsheet-shaped table as its main
 * operating surface; the inspector is for the column-level *contract*
 * — the things that don't fit naturally inside a header cell.
 * Everything in here is a controlled view of one
 * `InvoiceTemplateColumn`, with a single `onChange(patch)` callback
 * that the editor folds into its local columns array.
 *
 * The body is organised into THREE explicit groups, in this order:
 *
 *   A. Basic — what the column IS.
 *      Label (header), Required toggle, Data type, Format hints.
 *
 *   B. Global behavior — what the column DOES by default, independent
 *      of any rule row. This is the column-level contract that says
 *      "where does my value come from when nothing else is in play?".
 *      The mode (fixed value / manual list / catalog binding /
 *      invoice field / etc) + per-mode subform live here, plus the
 *      Allow rule override switch.
 *
 *   C. Rule interaction — how this column behaves when a rule row's
 *      cell sits underneath it. Carries the Rule role picker plus a
 *      banner that surfaces whether rule cells will actually win
 *      against the global behavior (driven by allow_rule_override).
 *
 *   D. Validation — column-level enforcement hints (existing surface).
 *
 * The grouping is the key UX investment: the user must be able to
 * tell at a glance which knob is the GLOBAL/DEFAULT contract and
 * which is the per-rule layer. Section B is the answer to "what
 * value does this column carry when no rule applies?" — section C
 * is the answer to "and how do rules layer on top?".
 *
 * Future phases will:
 *   * Add live preview of "what would this column emit for a sample
 *     invoice given the current global behavior + rules?"
 *   * Replace the per-source field dropdowns with dynamically-fetched
 *     catalog field shapes
 *   * Build out the derived/rule editor
 *   * Surface the rest of the validation bag (pattern, length bounds)
 *   * Apply data_type / format at render time (currently the model
 *     records them; the renderer doesn't yet enforce them)
 */

interface ColumnInspectorProps {
  /** The selected column. Caller hides the panel entirely when null. */
  column: InvoiceTemplateColumn;
  /**
   * Saved-catalog summaries used to disambiguate catalog-backed
   * source bindings. The inspector reads the slice that matches the
   * column's current `source_type`. Passed in (not internally hooked)
   * so column-switching doesn't refetch on every inspector mount.
   */
  catalogIndex: CatalogIndex;
  /** Patch the column with the given fields; replaces, not merges. */
  onChange: (patch: Partial<InvoiceTemplateColumn>) => void;
  /** Close the inspector without losing the underlying column edits. */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Source-type dropdown options
// ---------------------------------------------------------------------------
//
// Ordered so the most-frequently-used kinds sit at the top: empty
// (the default), then the "pick a known canonical reference" sources,
// then the inline value kinds, then derived (which is still a
// placeholder).

const SOURCE_TYPE_ORDER: readonly ColumnSourceType[] = [
  "empty",
  "invoice_field",
  "property_field",
  "vendor_field",
  "gl_field",
  "manual_list",
  "fixed_value",
  "derived",
];

const SOURCE_TYPE_ICONS: Record<ColumnSourceType, LucideIcon> = {
  empty: Square,
  fixed_value: Type,
  manual_list: ListChecks,
  invoice_field: FileSpreadsheet,
  property_field: Building2,
  vendor_field: Users,
  gl_field: Hash,
  derived: Sparkles,
};

const SOURCE_TYPE_HINT: Record<ColumnSourceType, string> = {
  empty:
    "No source — operator fills the cell in later (or a future extraction step does).",
  fixed_value:
    "Always emit the same constant value for this column on every row.",
  manual_list:
    "Operator picks from an inline enumerated list defined right here.",
  invoice_field:
    "Pulled from the extracted invoice payload (e.g. invoice number, date).",
  property_field:
    "Looked up from the matched Properties catalog entry.",
  vendor_field:
    "Looked up from the matched Vendors catalog entry.",
  gl_field:
    "Looked up from the matched GL Codes catalog entry.",
  derived:
    "Computed by a rule/expression. Rule editor coming in a future phase.",
};

export function ColumnInspector({
  column,
  catalogIndex,
  onChange,
  onClose,
}: ColumnInspectorProps) {
  const sourceType: ColumnSourceType = columnGlobalMode(column);
  const required = column.required ?? false;
  const dataType = columnDataType(column);
  const allowRuleOverride = columnAllowsRuleOverride(column);
  // Phase 2 / Part 7 — three independent lock concepts. Read via the
  // helpers so the legacy + new persisted shapes stay compatible.
  const lockPosition = columnLockPosition(column);
  const lockEditing = columnLockEditing(column);

  // ---- Source-type change handling ---------------------------------------
  // When the user flips source kinds we DON'T silently clear adjacent
  // metadata — the user might be flipping back and forth comparing
  // shapes, and losing typed-in fixed_value / manual_values text on
  // every flip would be punishing. The Pydantic model on save will
  // ignore irrelevant fields for the chosen kind, so leaving them in
  // the patch is safe. We DO ensure required-by-kind fields exist:
  // `manual_list` needs at least one entry to even submit, so we seed
  // an empty entry on first switch into that kind so the user has
  // something to type into.

  const handleSourceTypeChange = useCallback(
    (next: ColumnSourceType) => {
      const patch: Partial<InvoiceTemplateColumn> = { source_type: next };
      if (next === "manual_list" && (column.manual_values ?? []).length === 0) {
        patch.manual_values = [""];
      }
      if (REF_BINDING_SOURCES.has(next)) {
        if (!column.source_ref) {
          // Seed the wrapper object with a null field so the per-kind
          // sub-form has a stable target to write into.
          patch.source_ref = { field: null };
        } else if (
          // Flipping between two different catalog-backed kinds (e.g.
          // Vendor -> Property): the persisted catalog_id is keyed off
          // the previous catalog kind and won't resolve in the new
          // kind's catalog list. Clear both id + label so the user is
          // forced to re-pick rather than carrying a stale binding
          // that fails silently at render time. We deliberately PRESERVE
          // `field` — the old field name might still be valid (e.g.
          // "address" is on both Vendor and Property catalogs) and
          // losing it on every flip would be hostile.
          column.source_type !== next &&
          CATALOG_BINDING_SOURCES.has(next) &&
          (column.source_ref.catalog_id != null ||
            column.source_ref.catalog_label != null)
        ) {
          patch.source_ref = {
            ...column.source_ref,
            catalog_id: null,
            catalog_label: null,
          };
        }
      }
      onChange(patch);
    },
    [column.manual_values, column.source_ref, column.source_type, onChange],
  );

  return (
    <aside
      className="w-[20rem] shrink-0 border-l border-gray-200 bg-white flex flex-col h-full min-h-0 dark:border-line dark:bg-surface-subtle"
      aria-label="Column inspector"
    >
      {/* ---- Header ---------------------------------------------------- */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-start gap-2 dark:border-line">
        <div className="flex-1 min-w-0">
          <p className="text-[9.5px] uppercase tracking-wide text-gray-400 font-semibold dark:text-ink-subtle">
            Column inspector
          </p>
          <p
            className="text-sm font-semibold text-gray-800 truncate mt-0.5 dark:text-ink"
            title={column.name}
          >
            {column.name || "Untitled column"}
          </p>
          <p className="text-[10.5px] text-gray-500 mt-0.5 leading-snug dark:text-ink-muted">
            Three layers: what the column <em>is</em>, what it does by
            default, and how rule rows are allowed to interact with it.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close column inspector"
          className="shrink-0 p-1 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-ink-subtle dark:hover:bg-surface-muted dark:hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ---- Body ------------------------------------------------------ */}
      {/* Three explicit groups (Basic, Global behavior, Rule
          interaction) + a tail Validation group. The grouping is the
          key UX investment — the user must always be able to tell
          which knob is the global default and which is the per-rule
          layer. See module doc-comment for the full rationale. */}
      <div className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-5">
        {/* ============ A. Basic ====================================== */}
        <SectionGroup
          label="A. Basic"
          hint="What this column is — its identity, type, and shape on output."
        >
          <RequiredSection
            required={required}
            onToggle={() => onChange({ required: !required })}
          />

          <DataTypeSection
            dataType={dataType}
            onChange={(next) =>
              // `coerceColumnForDataType` returns a patch that may CLEAR
              // global-mode fields (source_type / source_ref / manual_values
              // / default_value) when the previous source kind is no longer
              // recommended for the new type. The picker below re-renders
              // immediately into a clean state instead of leaving stale
              // bindings (e.g. a `manual_values` list of color names left
              // over from when this was a Dropdown column).
              onChange(coerceColumnForDataType(column, next))
            }
          />

          <FormatSection
            dataType={dataType}
            format={column.format ?? null}
            onChange={(nextFormat) => onChange({ format: nextFormat })}
          />
        </SectionGroup>

        {/* ============ B. Global / default behavior ================== */}
        {/* This is the column's default value strategy — what the
            column resolves to when nothing else is in play. Distinct
            from rule rows: rule rows are scoped per-row; this is
            global to the column. */}
        <SectionGroup
          label="B. Global behavior"
          hint="What this column resolves to by default, independent of any rule row. Allow rule override decides whether row rules may replace it."
        >
          <GlobalBehaviorSection
            dataType={dataType}
            sourceType={sourceType}
            onChange={handleSourceTypeChange}
          />

          <SourceSubform
            column={column}
            sourceType={sourceType}
            catalogIndex={catalogIndex}
            onChange={onChange}
          />

          <AllowRuleOverrideSection
            allow={allowRuleOverride}
            globalMode={sourceType}
            onToggle={() =>
              onChange({ allow_rule_override: !allowRuleOverride })
            }
          />
        </SectionGroup>

        {/* ============ C. Rule interaction =========================== */}
        <SectionGroup
          label="C. Rule interaction"
          hint="How this column behaves when it appears inside a rule row underneath."
        >
          <RuleRoleSection
            role={column.rule_role ?? "action"}
            onChange={(next) => onChange({ rule_role: next })}
          />

          <RuleInteractionBanner
            allow={allowRuleOverride}
            globalMode={sourceType}
          />
        </SectionGroup>

        {/* ============ D. Validation (existing) ====================== */}
        <SectionGroup
          label="D. Validation"
          hint="Column-level enforcement hints. Recorded today; the renderer will start enforcing them as the export pipeline lands."
        >
          <ValidationSection column={column} onChange={onChange} />
        </SectionGroup>

        {/* ============ E. Locks (Part 7) ============================= */}
        {/* Three independent locks — keeping them in their own section
            (rather than scattering checkboxes under Basic / Rule
            interaction) makes the "permission model" of this column
            scannable: position, schema, and rule override are
            orthogonal axes the operator can tighten case-by-case. */}
        <SectionGroup
          label="E. Locks"
          hint="Restrict what other operators can do with this column. Locks are advisory in the editor today; the resolver and export pipeline will enforce them as those layers land."
        >
          <LockPositionSection
            value={lockPosition}
            onToggle={() =>
              onChange({ lock_position: !lockPosition })
            }
          />
          <LockEditingSection
            value={lockEditing}
            onToggle={() =>
              onChange({ lock_editing: !lockEditing })
            }
          />
        </SectionGroup>
      </div>
    </aside>
  );
}

// ===========================================================================
// Section group — visual divider between Basic / Global / Rule / Validation
// ===========================================================================
//
// The lettered group labels (A / B / C / D) plus the inline hint copy
// are the primary affordance for the new product structure. Without
// them the inspector reads as a flat list of fields and the user has
// to infer which knob means "global default" vs "per-rule layer".
// Visually subtle (a thin top border + small uppercase label) so the
// individual section headings inside still carry the eye.

function SectionGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="-mx-4 px-4 pt-3 first:pt-0 first:border-t-0 border-t border-gray-200 dark:border-line/60">
      <div className="mb-2.5">
        <p className="text-[10px] uppercase tracking-wider text-brand-700 font-bold dark:text-brand-50">
          {label}
        </p>
        <p className="mt-0.5 text-[10.5px] text-gray-500 leading-snug dark:text-ink-muted">
          {hint}
        </p>
      </div>
      <div className="space-y-3.5">{children}</div>
    </div>
  );
}

// ===========================================================================
// Required section
// ===========================================================================
//
// Same Switch component as the rule-row "active" toggle so the two
// surfaces share an identical visual + interaction language. The
// surrounding card carries the explanatory copy that the bare switch
// can't.

function RequiredSection({
  required,
  onToggle,
}: {
  required: boolean;
  onToggle: () => void;
}) {
  return (
    <Section
      title="Required"
      hint="Required columns must be present in the final exported file."
    >
      <div
        className={cn(
          "rounded-md border px-3 py-2.5 transition-colors",
          required
            ? "border-brand-500 bg-brand-50/60 dark:bg-brand-900/30"
            : "border-gray-200 dark:border-line",
        )}
      >
        <Switch
          checked={required}
          onChange={onToggle}
          label={required ? "Marked required" : "Optional"}
          description={
            required
              ? "An asterisk appears on the column header. Future export validation refuses to ship with missing values."
              : "The column can be empty. Toggle on to mark it as required."
          }
          aria-label="Required column toggle"
        />
      </div>
    </Section>
  );
}

// ===========================================================================
// Rule role section
// ===========================================================================
//
// Picks how this column behaves when it appears inside a rule row —
// condition, restriction, or action. See `RuleRole` doc on the
// schema for the full semantics. The picker is a three-row segmented
// list (rather than a dropdown) so all three roles + their copy are
// visible without a second click; rule role is a key authoring concept,
// not an obscure setting.

const ROLE_ICONS: Record<RuleRole, LucideIcon> = {
  condition: Scale,
  restriction: CornerDownRight,
  action: Target,
};

const ROLE_ORDER: readonly RuleRole[] = [
  "condition",
  "restriction",
  "action",
];

function RuleRoleSection({
  role,
  onChange,
}: {
  role: RuleRole;
  onChange: (next: RuleRole) => void;
}) {
  return (
    <Section
      title="Rule role"
      hint="Determines how this column's cells are interpreted inside rule rows below."
    >
      <div className="rounded-md border border-gray-200 overflow-hidden dark:border-line">
        {ROLE_ORDER.map((kind) => {
          const Icon = ROLE_ICONS[kind];
          const selected = role === kind;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onChange(kind)}
              aria-pressed={selected}
              className={cn(
                "w-full text-left px-3 py-2 flex items-start gap-2.5 border-b border-gray-100 last:border-b-0 transition-colors dark:border-line/60",
                selected
                  ? "bg-brand-50/60 dark:bg-brand-900/30"
                  : "bg-white hover:bg-gray-50 dark:bg-surface-subtle dark:hover:bg-surface-muted",
              )}
            >
              <div
                className={cn(
                  "h-6 w-6 shrink-0 rounded flex items-center justify-center mt-0.5",
                  selected
                    ? "bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-50"
                    : "bg-gray-100 text-gray-500 dark:bg-surface-muted dark:text-ink-subtle",
                )}
              >
                <Icon className="h-3 w-3" />
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className={cn(
                    "text-[12px] font-semibold",
                    selected
                      ? "text-brand-800 dark:text-brand-50"
                      : "text-gray-700 dark:text-ink",
                  )}
                >
                  {RULE_ROLE_LABEL[kind]}
                </p>
                <p className="text-[10.5px] text-gray-500 mt-0.5 leading-snug dark:text-ink-muted">
                  {RULE_ROLE_DESCRIPTION[kind]}
                </p>
              </div>
              {selected && (
                <ChevronRight className="h-3.5 w-3.5 text-brand-600 mt-1" />
              )}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ===========================================================================
// Data type — A. Basic
// ===========================================================================
//
// The column's expected output SHAPE — independent from `source_type`
// (which is "where the value comes from"). The picker lists every
// `ColumnDataType` with a one-liner so the user can scan + commit
// without opening a docs page. Choosing a type doesn't auto-rewrite
// `format` — the per-type Format subform appears below and the user
// fills only what they care about. The renderer's per-type defaults
// kick in for anything left unset.
//
// Visual: same segmented-list pattern as the role / source pickers, so
// the inspector reads as a coherent stack of "pick one" affordances.

const DATA_TYPE_ICONS: Record<ColumnDataType, LucideIcon> = {
  text: Type,
  number: Sigma,
  currency: Coins,
  date: CalendarDays,
  boolean: ToggleLeft,
  dropdown: ListChecks,
  multi_select: ListChecks,
};

function DataTypeSection({
  dataType,
  onChange,
}: {
  dataType: ColumnDataType;
  onChange: (next: ColumnDataType) => void;
}) {
  return (
    <Section
      title="Data type"
      hint="The expected output shape. Independent from where the value comes from — a column pulled from an invoice field can still be formatted as currency or a date."
    >
      <div className="rounded-md border border-gray-200 overflow-hidden dark:border-line">
        {COLUMN_DATA_TYPE_ORDER.map((kind) => {
          const Icon = DATA_TYPE_ICONS[kind];
          const selected = dataType === kind;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onChange(kind)}
              aria-pressed={selected}
              className={cn(
                "w-full text-left px-3 py-2 flex items-start gap-2.5 border-b border-gray-100 last:border-b-0 transition-colors dark:border-line/60",
                selected
                  ? "bg-brand-50/60 dark:bg-brand-900/30"
                  : "bg-white hover:bg-gray-50 dark:bg-surface-subtle dark:hover:bg-surface-muted",
              )}
            >
              <div
                className={cn(
                  "h-6 w-6 shrink-0 rounded flex items-center justify-center mt-0.5",
                  selected
                    ? "bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-50"
                    : "bg-gray-100 text-gray-500 dark:bg-surface-muted dark:text-ink-subtle",
                )}
              >
                <Icon className="h-3 w-3" />
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className={cn(
                    "text-[12px] font-semibold",
                    selected
                      ? "text-brand-800 dark:text-brand-50"
                      : "text-gray-700 dark:text-ink",
                  )}
                >
                  {COLUMN_DATA_TYPE_LABEL[kind]}
                </p>
                <p className="text-[10.5px] text-gray-500 mt-0.5 leading-snug dark:text-ink-muted">
                  {COLUMN_DATA_TYPE_DESCRIPTION[kind]}
                </p>
              </div>
              {selected && (
                <ChevronRight className="h-3.5 w-3.5 text-brand-600 mt-1" />
              )}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ===========================================================================
// Format — A. Basic (data-type-discriminated subform)
// ===========================================================================
//
// Per-type controls. Discriminated on `dataType` so only the relevant
// knobs are surfaced; the Pydantic shape is a single bag, so flipping
// types doesn't lose what the user already typed (the renderer ignores
// fields that don't apply). For text / boolean we render a "no
// per-type format" placeholder rather than hide the section — the
// blank state IS the contract, and the user shouldn't wonder whether
// they're missing a control.

function FormatSection({
  dataType,
  format,
  onChange,
}: {
  dataType: ColumnDataType;
  format: ColumnFormat | null;
  onChange: (nextFormat: ColumnFormat | null) => void;
}) {
  // Helper: patch the format bag in place (preserving sibling fields)
  // and collapse to null when every field is unset, so the JSONB shape
  // stays clean for the common "no overrides" case.
  const patch = (delta: Partial<ColumnFormat>): void => {
    const merged: ColumnFormat = { ...(format ?? {}), ...delta };
    const isEmpty =
      (merged.date_format ?? null) === null &&
      (merged.decimal_places ?? null) === null &&
      (merged.currency_code ?? null) === null &&
      !merged.uppercase &&
      !merged.trim &&
      (merged.list_options ?? null) === null &&
      (merged.multi_select_separator ?? null) === null;
    onChange(isEmpty ? null : merged);
  };

  if (dataType === "text" || dataType === "boolean") {
    return (
      <Section title="Format">
        <div className="rounded-md border border-dashed border-gray-300 bg-gray-50/50 p-3 text-[11px] text-gray-600 flex items-start gap-2 dark:border-line dark:bg-surface-muted/50 dark:text-ink-muted">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-gray-400 dark:text-ink-subtle" />
          <span>
            {dataType === "text"
              ? "Text columns have no format options today. Future phases will add casing / trim hints here."
              : "Boolean columns will render as Yes / No on output. No format options today."}
          </span>
        </div>
      </Section>
    );
  }

  if (dataType === "date") {
    return (
      <Section
        title="Format"
        hint={`Date pattern. Falls back to ${DATE_FORMAT_OPTIONS[0].value} when unset.`}
      >
        <div className="flex items-center gap-2">
          <CalendarDays className="h-3.5 w-3.5 text-gray-400 shrink-0 dark:text-ink-subtle" />
          <select
            value={format?.date_format ?? ""}
            onChange={(e) => patch({ date_format: e.target.value || null })}
            className="flex-1 min-w-0 rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white dark:border-line dark:bg-surface dark:text-ink"
            aria-label="Date format"
          >
            <option value="">— Use default ({DATE_FORMAT_OPTIONS[0].value}) —</option>
            {DATE_FORMAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </Section>
    );
  }

  if (dataType === "number" || dataType === "currency") {
    const isCurrency = dataType === "currency";
    return (
      <Section
        title="Format"
        hint={
          isCurrency
            ? "Currency code + decimal places. Defaults to USD with 2 decimals when unset."
            : "Decimal places to render. Defaults to no rounding when unset."
        }
      >
        <div className="space-y-2">
          {isCurrency && (
            <div className="flex items-center gap-2">
              <Coins className="h-3.5 w-3.5 text-gray-400 shrink-0 dark:text-ink-subtle" />
              <select
                value={format?.currency_code ?? ""}
                onChange={(e) =>
                  patch({ currency_code: e.target.value || null })
                }
                className="flex-1 min-w-0 rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white dark:border-line dark:bg-surface dark:text-ink"
                aria-label="Currency code"
              >
                <option value="">— Use default (USD) —</option>
                {COMMON_CURRENCY_CODES.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Sigma className="h-3.5 w-3.5 text-gray-400 shrink-0 dark:text-ink-subtle" />
            <select
              value={
                format?.decimal_places === null ||
                format?.decimal_places === undefined
                  ? ""
                  : String(format.decimal_places)
              }
              onChange={(e) =>
                patch({
                  decimal_places:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
              className="flex-1 min-w-0 rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white dark:border-line dark:bg-surface dark:text-ink"
              aria-label="Decimal places"
            >
              <option value="">
                — Decimal places: {isCurrency ? "default 2" : "unset"} —
              </option>
              {DECIMAL_PLACES_OPTIONS.map((n) => (
                <option key={n} value={String(n)}>
                  {n} {n === 1 ? "decimal place" : "decimal places"}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Section>
    );
  }

  // dropdown / multi_select — shared list editor + (multi-select only)
  // a separator picker.
  const options = format?.list_options ?? [];
  const updateAt = (idx: number, value: string) => {
    const next = options.slice();
    next[idx] = value;
    patch({ list_options: next });
  };
  const removeAt = (idx: number) => {
    const next = options.slice();
    next.splice(idx, 1);
    patch({ list_options: next.length === 0 ? null : next });
  };
  const append = () => {
    patch({ list_options: [...options, ""] });
  };
  const blanks = options.filter((v) => v.trim().length === 0).length;

  return (
    <Section
      title="Format"
      hint={
        dataType === "multi_select"
          ? "Allowed output values + separator used to join picks at export."
          : "Allowed output values for this column at export time."
      }
    >
      <div className="space-y-1.5">
        {options.map((value, idx) => (
          <div key={idx} className="flex items-center gap-1.5">
            <span className="w-5 shrink-0 text-[10px] font-mono text-gray-400 text-right dark:text-ink-subtle">
              {idx + 1}
            </span>
            <input
              type="text"
              value={value}
              onChange={(e) => updateAt(idx, e.target.value)}
              placeholder={idx === 0 ? "e.g. Bill" : "Add an option"}
              className={cn(
                "flex-1 min-w-0 rounded-md border px-2 py-1 text-[12px] focus:outline-none focus:ring-2 focus:ring-brand-500",
                value.trim().length === 0
                  ? "border-red-300 bg-red-50/30"
                  : "border-gray-300 dark:border-line",
              )}
            />
            <button
              type="button"
              onClick={() => removeAt(idx)}
              aria-label={`Remove option ${idx + 1}`}
              className="shrink-0 p-1 rounded text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:text-ink-subtle dark:hover:bg-surface-muted dark:hover:text-red-400"
              title="Remove this option"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={append}
          className="w-full"
        >
          <Plus className="h-3.5 w-3.5" />
          Add option
        </Button>
        {blanks > 0 && (
          <p className="text-[10.5px] text-orange-600 inline-flex items-start gap-1 dark:text-orange-400">
            <Asterisk className="h-3 w-3 mt-0.5 shrink-0" />
            {blanks === 1
              ? "One option is blank — fill or remove it before saving."
              : `${blanks} options are blank — fill or remove them before saving.`}
          </p>
        )}

        {dataType === "multi_select" && (
          <div className="pt-2 mt-2 border-t border-gray-100 dark:border-line/60">
            <label className="block text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold mb-1 dark:text-ink-subtle">
              Separator
            </label>
            <input
              type="text"
              value={format?.multi_select_separator ?? ""}
              onChange={(e) =>
                patch({
                  multi_select_separator: e.target.value || null,
                })
              }
              placeholder="Defaults to ,"
              maxLength={8}
              className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink"
            />
            <p className="text-[10px] text-gray-400 mt-1 dark:text-ink-subtle">
              Used to join picks into one cell at export. Defaults to a comma.
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}

// ===========================================================================
// Global behavior picker — B. Global behavior (renamed from SourceSection)
// ===========================================================================
//
// The column's GLOBAL / DEFAULT value strategy. Same underlying field
// (`source_type`) as before — kept stable for back-compat with already-
// persisted templates — but the product surface no longer calls this
// "Value source". It's the column-wide contract that says "what does
// this column resolve to when no rule applies?". Rule rows layer on
// top of this; the `AllowRuleOverrideSection` below decides whether
// rule rows are even allowed to win.
//
// Wording lives in `GLOBAL_MODE_LABEL` (centralised in the types module
// so the rule-cell editor's `SOURCE_TYPE_LABEL` can drift independently
// without re-touching this surface).
//
// Filtering: the picker shows only modes that are RECOMMENDED for the
// column's current `data_type` (per `COMPATIBLE_GLOBAL_MODES`). This is
// the product-level contract — a `date` column shouldn't see the
// `manual_list` mode in its picker, because picking strings from a list
// fights the column's data shape. Two edge cases get explicit handling:
//
//   * The currently-selected mode is INCOMPATIBLE with the data type
//     (legacy column persisted before the matrix existed). We still
//     render that mode at the top of the picker, prefixed with a
//     "(not recommended)" badge, so the user can SEE their current
//     binding and decide to migrate. We never silently strip it — the
//     `coerceColumnForDataType` helper handles forced normalisation
//     when the user CHANGES data_type, but doesn't second-guess what's
//     already saved.
//
//   * No modes are recommended for the data type at all (shouldn't
//     happen with the current matrix — every type allows at least
//     `empty` + `derived` — but the loop is defensive). The picker
//     would render an empty list; the caller is expected to keep the
//     section visible because at minimum the user can flip data type
//     to recover.

function GlobalBehaviorSection({
  dataType,
  sourceType,
  onChange,
}: {
  dataType: ColumnDataType;
  sourceType: ColumnSourceType;
  onChange: (next: ColumnSourceType) => void;
}) {
  // Compatible modes for this data type, preserving the canonical
  // SOURCE_TYPE_ORDER so the picker UX stays predictable across types.
  const compatibleSet = new Set<ColumnSourceType>(
    COMPATIBLE_GLOBAL_MODES[dataType],
  );
  const compatibleOrdered = SOURCE_TYPE_ORDER.filter((k) =>
    compatibleSet.has(k),
  );
  // Legacy / pre-matrix selection: the persisted source_type isn't in
  // the type's recommended list. We surface it FIRST so the user
  // doesn't have to scroll to find their current selection, but flag it
  // visually so the migration path is obvious.
  const showsIncompatible = !compatibleSet.has(sourceType);
  const renderOrder: ColumnSourceType[] = showsIncompatible
    ? [sourceType, ...compatibleOrdered]
    : compatibleOrdered;

  return (
    <Section
      title="Global behavior mode"
      hint={`What this column resolves to by default — independent of any rule row. Options below are filtered to the modes recommended for ${COLUMN_DATA_TYPE_LABEL[dataType]} columns.`}
    >
      <div className="rounded-md border border-gray-200 overflow-hidden dark:border-line">
        {renderOrder.map((kind) => {
          const Icon = SOURCE_TYPE_ICONS[kind];
          const selected = sourceType === kind;
          const incompatible = !compatibleSet.has(kind);
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onChange(kind)}
              aria-pressed={selected}
              className={cn(
                "w-full text-left px-3 py-2 flex items-center gap-2.5 border-b border-gray-100 last:border-b-0 transition-colors dark:border-line/60",
                selected
                  ? "bg-brand-50/60"
                  : "bg-white hover:bg-gray-50 dark:bg-surface-subtle dark:hover:bg-surface-muted",
              )}
            >
              <div
                className={cn(
                  "h-6 w-6 shrink-0 rounded flex items-center justify-center",
                  selected
                    ? "bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-50"
                    : "bg-gray-100 text-gray-500 dark:bg-surface-muted dark:text-ink-subtle",
                )}
              >
                <Icon className="h-3 w-3" />
              </div>
              <span
                className={cn(
                  "flex-1 text-[12px] font-medium",
                  selected ? "text-brand-800" : "text-gray-700",
                )}
              >
                {GLOBAL_MODE_LABEL[kind]}
              </span>
              {incompatible && (
                <span
                  className="text-[9.5px] font-bold uppercase tracking-wide rounded bg-amber-100 text-amber-800 ring-1 ring-amber-300 px-1 py-0.5 dark:bg-yellow-950/40 dark:text-yellow-200 dark:ring-yellow-900"
                  title={`Not recommended for ${COLUMN_DATA_TYPE_LABEL[dataType]} columns. Pick a different mode or change the data type.`}
                >
                  Not recommended
                </span>
              )}
              {selected && (
                <ChevronRight className="h-3.5 w-3.5 text-brand-600" />
              )}
            </button>
          );
        })}
      </div>
      <p className="text-[10.5px] text-gray-500 mt-1.5 leading-snug dark:text-ink-muted">
        {SOURCE_TYPE_HINT[sourceType]}
      </p>
      {showsIncompatible && (
        <div className="mt-2 rounded-md border border-amber-300 bg-amber-50/70 p-2.5 text-[11px] text-amber-900 flex items-start gap-2 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-200">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-600 dark:text-yellow-400" />
          <span className="leading-snug">
            Current mode <strong>{GLOBAL_MODE_LABEL[sourceType]}</strong>{" "}
            isn&rsquo;t a recommended pairing for{" "}
            <strong>{COLUMN_DATA_TYPE_LABEL[dataType]}</strong> columns.
            The combination is preserved as you saved it; pick a recommended
            mode above (or change Data type) to migrate.
          </span>
        </div>
      )}
    </Section>
  );
}

// ===========================================================================
// Allow rule override — B. Global behavior
// ===========================================================================
//
// First-class column field that decides whether row-based rules may
// REPLACE the column's global behavior at resolve time. Default `true`
// matches pre-`allow_rule_override` semantics so legacy rules keep
// firing untouched; flipping `false` is the "this column always emits
// the global value" lock (Expense Type = General; Default Tax Code =
// 6915; etc.).
//
// We render the OFF state with a Lock icon (and a brand-tinted
// background) because the locked semantics are the stronger / more
// surprising state — the operator should immediately recognise that
// rule rows are being overridden by the column-level contract.
// Independent from `rule_role` — rule role tells the resolver HOW to
// interpret a rule cell; this flag tells the resolver WHETHER its
// action result is allowed to win.

function AllowRuleOverrideSection({
  allow,
  globalMode,
  onToggle,
}: {
  allow: boolean;
  globalMode: ColumnSourceType;
  onToggle: () => void;
}) {
  // The toggle is meaningful only when there's a global value to
  // protect. With `empty` global mode there's nothing to override
  // (rule rows are the only writer either way), so we still render
  // the toggle but caveat the copy.
  const isEmpty = globalMode === "empty";
  const Icon = allow ? LockOpen : Lock;
  return (
    <Section
      title="Allow rule override"
      hint={
        isEmpty
          ? "With no global behavior set, this toggle has no effect — rule rows are always the writer."
          : allow
            ? "Rule rows whose action cell has values may REPLACE the global behavior when the rule fires."
            : "The global behavior is LOCKED — rule cells are still recorded but the resolver ignores them."
      }
    >
      <div
        className={cn(
          "rounded-md border px-3 py-2.5 transition-colors",
          allow
            ? "border-gray-200 dark:border-line"
            : "border-amber-300 bg-amber-50/60",
        )}
      >
        <div className="flex items-start gap-2.5">
          <div
            className={cn(
              "h-6 w-6 shrink-0 rounded flex items-center justify-center mt-0.5",
              allow
                ? "bg-gray-100 text-gray-500 dark:bg-surface-muted dark:text-ink-subtle"
                : "bg-amber-100 text-amber-700 dark:bg-yellow-950/40 dark:text-yellow-200",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="flex-1 min-w-0">
            <Switch
              checked={allow}
              onChange={onToggle}
              label={
                allow
                  ? "Rule rows may override this column"
                  : "Locked — global behavior wins"
              }
              description={
                allow
                  ? "Default. When a rule's action cell for this column has values, the rule wins over the global behavior."
                  : "Use for columns whose value should never change from a row-based rule (e.g. Expense Type always = General)."
              }
              aria-label="Allow rule override toggle"
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

// ===========================================================================
// Rule interaction banner — C. Rule interaction
// ===========================================================================
//
// Plain-English summary of what the column's CURRENT global +
// allow_rule_override settings imply for any rule row that touches
// this column. The banner is read-only — its job is to surface the
// resolver's behavior so the operator never wonders "why isn't my rule
// applying?" or "wait, this rule is going to be overridden by the
// global default?".
//
// Three states:
//   * Locked (allow=false, non-empty global) — strongest signal, amber.
//   * Permissive (allow=true, non-empty global) — info tone.
//   * Vacuous (global=empty) — neutral, since rules are the only writer.

function RuleInteractionBanner({
  allow,
  globalMode,
}: {
  allow: boolean;
  globalMode: ColumnSourceType;
}) {
  if (globalMode === "empty") {
    return (
      <div className="rounded-md border border-gray-200 bg-gray-50/60 p-2.5 text-[11px] text-gray-700 flex items-start gap-2 dark:border-line dark:bg-surface-muted/60 dark:text-ink-muted">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-gray-400 dark:text-ink-subtle" />
        <span className="leading-snug">
          No global behavior is set, so rule rows are the only writer.
          Allow-rule-override has no effect here.
        </span>
      </div>
    );
  }
  if (allow) {
    return (
      <div className="rounded-md border border-blue-200 bg-blue-50/60 p-2.5 text-[11px] text-blue-900 flex items-start gap-2">
        <LockOpen className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-500" />
        <span className="leading-snug">
          When a rule fires and its cell for this column has values, the
          rule&rsquo;s value REPLACES the global behavior. Toggle{" "}
          <em>Allow rule override</em> off above to lock the global default.
        </span>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50/70 p-2.5 text-[11px] text-amber-900 flex items-start gap-2">
      <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-600" />
      <span className="leading-snug">
        Global behavior is LOCKED — rule cells under this column are
        recorded for editing convenience but won&rsquo;t apply at resolve
        time. Toggle <em>Allow rule override</em> on to give rules a chance.
      </span>
    </div>
  );
}

// ===========================================================================
// Source-specific sub-form
// ===========================================================================

function SourceSubform({
  column,
  sourceType,
  catalogIndex,
  onChange,
}: {
  column: InvoiceTemplateColumn;
  sourceType: ColumnSourceType;
  catalogIndex: CatalogIndex;
  onChange: (patch: Partial<InvoiceTemplateColumn>) => void;
}) {
  if (sourceType === "empty") {
    // No sub-form — the source kind itself fully describes the
    // contract ("there is no source").
    return null;
  }

  if (sourceType === "fixed_value") {
    return <FixedValueEditor column={column} onChange={onChange} />;
  }

  if (sourceType === "manual_list") {
    return (
      <>
        <ManualListEditor column={column} onChange={onChange} />
        <DefaultSelectedOption column={column} onChange={onChange} />
      </>
    );
  }

  if (sourceType === "derived") {
    return (
      <Section title="Derived rule">
        <div className="rounded-md border border-dashed border-gray-300 bg-gray-50/50 p-3 text-[11px] text-gray-600 flex items-start gap-2 dark:border-line dark:bg-surface-muted/50 dark:text-ink-muted">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-gray-400 dark:text-ink-subtle" />
          <span>
            The rule editor for derived columns is coming in a future phase.
            For now, this column will resolve to empty at export time.
          </span>
        </div>
      </Section>
    );
  }

  // Ref-binding sources (invoice / property / vendor / gl).
  // For catalog-backed kinds (vendor / property / gl) we render TWO
  // selectors stacked: catalog first, then field. The field selector
  // is intentionally enabled regardless of whether a catalog is picked
  // — the field list is fixed per kind in Phase 1, so the user can
  // pre-pick the field before resolving the catalog ambiguity. The
  // future renderer needs both to fire.
  const isCatalogBound = CATALOG_BINDING_SOURCES.has(sourceType);

  return (
    <>
      {isCatalogBound && (
        <CatalogPickerSection
          column={column}
          sourceType={sourceType}
          catalogIndex={catalogIndex}
          onChange={onChange}
        />
      )}
      <FieldPickerSection
        column={column}
        sourceType={sourceType}
        onChange={onChange}
      />
    </>
  );
}

// ===========================================================================
// Catalog picker — only rendered for catalog-backed source kinds
// ===========================================================================
//
// BillsIQ supports multiple saved catalogs of each kind (e.g. "ACME
// Vendors v3" and "Sublease Vendors"); declaring `source_type =
// vendor_field` alone is ambiguous when more than one exists. This
// section forces the operator to nominate the SPECIFIC catalog the
// column should bind against, persists the choice on
// `source_ref.catalog_id`, and caches the chosen catalog's display
// name on `source_ref.catalog_label` so a "(missing)" fallback is
// possible if the catalog is later deleted.
//
// Empty state: when the user picks a catalog-backed source type but
// no catalogs of that kind exist, we show a clear "create one first"
// prompt that links to the relevant `/reference-data/*` builder. The
// save still goes through (the binding is just incomplete) — the
// column header chip already turns orange to flag incompleteness.

function CatalogPickerSection({
  column,
  sourceType,
  catalogIndex,
  onChange,
}: {
  column: InvoiceTemplateColumn;
  sourceType: ColumnSourceType;
  catalogIndex: CatalogIndex;
  onChange: (patch: Partial<InvoiceTemplateColumn>) => void;
}) {
  const slice = catalogSliceFor(sourceType, catalogIndex);
  const labelKind = catalogKindLabel(sourceType);
  // Both should be non-null in concert by the CATALOG_BINDING_SOURCES
  // gate; the early return is belt-and-suspenders.
  if (!slice || !labelKind) return null;

  const currentRef = column.source_ref ?? { field: null };
  const currentCatalogId = currentRef.catalog_id ?? null;
  const currentCatalogLabel = currentRef.catalog_label ?? null;

  // Did the persisted catalog_id resolve in the live list? If not, the
  // catalog was likely deleted; we show a "(missing)" affordance using
  // the cached label so the user can still see what the column WAS
  // bound to — rather than silently dropping the binding.
  const liveMatch = slice.items.find((c) => c.id === currentCatalogId);
  const missingBoundCatalog =
    currentCatalogId !== null && liveMatch === undefined;

  const handlePick = (nextId: string) => {
    if (nextId === "") {
      onChange({
        source_ref: {
          ...currentRef,
          catalog_id: null,
          catalog_label: null,
        },
      });
      return;
    }
    const picked = slice.items.find((c) => c.id === nextId);
    onChange({
      source_ref: {
        ...currentRef,
        catalog_id: nextId,
        // Cache the display name at bind time. Authoritative source on
        // render is still the live list; this is the diagnostic
        // fallback for the deleted-catalog case.
        catalog_label: picked?.name ?? null,
      },
    });
  };

  // Loading: show a small inline placeholder so the section doesn't
  // disappear-and-reappear when the index lands.
  if (slice.loading && slice.items.length === 0) {
    return (
      <Section
        title={`${capitalize(labelKind.singular)}`}
        hint="Pick which saved catalog this column should bind against."
      >
        <div className="rounded-md border border-gray-200 bg-gray-50/60 px-3 py-2.5 text-[11.5px] text-gray-500 inline-flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading {labelKind.plural.toLowerCase()}…
        </div>
      </Section>
    );
  }

  // Empty state: no catalogs of this kind exist yet → tell the user
  // and link them to the relevant builder. Don't silently fail.
  if (slice.items.length === 0) {
    return (
      <Section title={capitalize(labelKind.singular)}>
        <div className="rounded-md border border-orange-200 bg-orange-50/60 p-3 text-[11.5px] text-orange-800 flex items-start gap-2">
          <Database className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-medium">
              No {labelKind.plural.toLowerCase()} saved yet.
            </p>
            <p className="mt-0.5 text-orange-700 leading-snug">
              You need at least one saved {labelKind.singular} before this
              column can resolve at export time.
            </p>
            <Link
              href={labelKind.routePath}
              className="mt-1.5 inline-flex items-center gap-1 text-orange-900 underline underline-offset-2 hover:text-orange-700"
            >
              Open the {labelKind.singular} builder
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </Section>
    );
  }

  return (
    <Section
      title={capitalize(labelKind.singular)}
      hint="Pick which saved catalog this column should bind against. The runtime resolver looks up values in the catalog you choose here."
    >
      <div className="flex items-center gap-2">
        <Library className="h-3.5 w-3.5 text-gray-400 shrink-0" />
        <select
          value={currentCatalogId ?? ""}
          onChange={(e) => handlePick(e.target.value)}
          className="flex-1 min-w-0 rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white dark:border-line dark:bg-surface dark:text-ink"
          aria-label={`${capitalize(labelKind.singular)} selector`}
        >
          <option value="">— Pick a {labelKind.singular} —</option>
          {slice.items.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}
            </option>
          ))}
        </select>
      </div>

      {/* Live confirmation chip — shows the resolved catalog name even
          when the saved label drifted from the live one. */}
      {liveMatch && (
        <p className="mt-1.5 text-[10.5px] text-gray-500 inline-flex items-center gap-1">
          <CheckSquare className="h-3 w-3 text-brand-600" />
          Bound to <span className="font-medium text-gray-700">{liveMatch.name}</span>
          {liveMatch.entry_count > 0 && (
            <span className="text-gray-400">
              · {liveMatch.entry_count} entries
            </span>
          )}
        </p>
      )}

      {/* Missing catalog: persisted id no longer in the live list. */}
      {missingBoundCatalog && (
        <div className="mt-1.5 rounded-md border border-amber-200 bg-amber-50/70 p-2 text-[10.5px] text-amber-800 flex items-start gap-1.5">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span className="leading-snug">
            The previously-bound {labelKind.singular}
            {currentCatalogLabel ? (
              <>
                {" "}
                <span className="font-medium">
                  &ldquo;{currentCatalogLabel}&rdquo;
                </span>
              </>
            ) : null}{" "}
            is no longer available — pick another above, or recreate it
            from the {labelKind.singular} builder.
          </span>
        </div>
      )}

      {/* Not picked yet — gentle prompt that the binding is incomplete. */}
      {currentCatalogId === null && (
        <p className="text-[10.5px] text-orange-600 mt-1.5 inline-flex items-start gap-1">
          <Asterisk className="h-3 w-3 mt-0.5 shrink-0" />
          {capitalize(labelKind.singular)} not set — the column won&rsquo;t
          resolve until you choose one.
        </p>
      )}
    </Section>
  );
}

// ===========================================================================
// Field picker — runs for every ref-binding source kind
// ===========================================================================

function FieldPickerSection({
  column,
  sourceType,
  onChange,
}: {
  column: InvoiceTemplateColumn;
  sourceType: ColumnSourceType;
  onChange: (patch: Partial<InvoiceTemplateColumn>) => void;
}) {
  const currentRef = column.source_ref ?? { field: null };
  const currentField = currentRef.field ?? null;
  const options = fieldOptionsFor(sourceType, currentField);
  return (
    <Section
      title="Source field"
      hint={`Pick which canonical field on the ${sourceLabel(sourceType)} to bind this column to.`}
    >
      <select
        value={currentField ?? ""}
        onChange={(e) => {
          const value = e.target.value || null;
          // Preserve catalog_id / catalog_label — replacing source_ref
          // wholesale would silently drop the catalog binding the user
          // already picked.
          onChange({ source_ref: { ...currentRef, field: value } });
        }}
        className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white dark:border-line dark:bg-surface dark:text-ink"
      >
        <option value="">— Pick a field —</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {currentField === null && (
        <p className="text-[10.5px] text-orange-600 mt-1.5 inline-flex items-start gap-1">
          <Asterisk className="h-3 w-3 mt-0.5 shrink-0" />
          Field not set — the column will resolve empty at export until you pick one.
        </p>
      )}
    </Section>
  );
}

// Tiny helper — used by the catalog picker headings to capitalise
// "vendor catalog" -> "Vendor catalog" without pulling in a util.
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// Pretty label for the parent entity behind a ref-binding source
// (used in the field-picker hint text).
function sourceLabel(kind: ColumnSourceType): string {
  switch (kind) {
    case "property_field":
      return "Properties catalog";
    case "vendor_field":
      return "Vendors catalog";
    case "gl_field":
      return "GL Codes catalog";
    case "invoice_field":
      return "extracted invoice";
    default:
      return "source";
  }
}

// ===========================================================================
// Manual-list editor
// ===========================================================================

function ManualListEditor({
  column,
  onChange,
}: {
  column: InvoiceTemplateColumn;
  onChange: (patch: Partial<InvoiceTemplateColumn>) => void;
}) {
  // Always work off a concrete array so the input change handlers can
  // splice cleanly. Backend default is null/[], but the source-type
  // change handler above seeds [""] when first flipping into manual_list.
  const values = column.manual_values ?? [];

  const updateAt = (idx: number, value: string) => {
    const next = values.slice();
    next[idx] = value;
    onChange({ manual_values: next });
  };

  const removeAt = (idx: number) => {
    const next = values.slice();
    next.splice(idx, 1);
    // Don't drop below one entry — the backend rejects empty
    // manual_values for a manual_list column. A trailing empty row is
    // friendlier than forcing the user back to a different source kind.
    if (next.length === 0) next.push("");
    onChange({ manual_values: next });
  };

  const append = () => {
    onChange({ manual_values: [...values, ""] });
  };

  const blanks = values.filter((v) => v.trim().length === 0).length;

  return (
    <Section
      title="Allowed values"
      hint="Operator picks one of these at render time. Each entry must be non-blank to save."
    >
      <div className="space-y-1.5">
        {values.map((value, idx) => (
          <div key={idx} className="flex items-center gap-1.5">
            <span className="w-5 shrink-0 text-[10px] font-mono text-gray-400 text-right dark:text-ink-subtle">
              {idx + 1}
            </span>
            <input
              type="text"
              value={value}
              onChange={(e) => updateAt(idx, e.target.value)}
              placeholder={idx === 0 ? "e.g. Bill" : "Add a value"}
              className={cn(
                "flex-1 min-w-0 rounded-md border px-2 py-1 text-[12px] focus:outline-none focus:ring-2 focus:ring-brand-500",
                value.trim().length === 0
                  ? "border-red-300 bg-red-50/30"
                  : "border-gray-300 dark:border-line",
              )}
            />
            <button
              type="button"
              onClick={() => removeAt(idx)}
              aria-label={`Remove value ${idx + 1}`}
              className="shrink-0 p-1 rounded text-gray-400 hover:bg-gray-100 hover:text-red-600 disabled:opacity-30"
              disabled={values.length === 1 && value.trim().length === 0}
              title="Remove this value"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={append}
          className="w-full"
        >
          <Plus className="h-3.5 w-3.5" />
          Add value
        </Button>
        {blanks > 0 && (
          <p className="text-[10.5px] text-orange-600 inline-flex items-start gap-1 dark:text-orange-400">
            <Asterisk className="h-3 w-3 mt-0.5 shrink-0" />
            {blanks === 1
              ? "One entry is blank — fill or remove it before saving."
              : `${blanks} entries are blank — fill or remove them before saving.`}
          </p>
        )}
      </div>
    </Section>
  );
}

// ===========================================================================
// Fixed-value editor — type-discriminated input shape
// ===========================================================================
//
// When a column's Global behavior is `fixed_value`, the input shape
// should match the column's `data_type`:
//
//   * text     — single-line text input (the legacy default).
//   * number   — `<input type="number">` with a free step (the
//                renderer applies `format.decimal_places`).
//   * currency — `<input type="number" step="0.01">` paired with a
//                small ISO-code chip so the operator sees what the
//                value will be rendered as.
//   * date     — native `<input type="date">` (ISO 8601 yyyy-mm-dd in
//                the storage value; the renderer applies
//                `format.date_format` on output).
//   * boolean  — segmented Yes / No picker.
//   * dropdown / multi_select — these data types EXCLUDE `fixed_value`
//                in `COMPATIBLE_GLOBAL_MODES`, so this branch is
//                unreachable through the new UI; legacy columns that
//                somehow landed here fall through to the text input
//                (safe default — string field, free text).
//
// Storage shape stays the legacy single string in `default_value`. The
// renderer is responsible for type-coercion at export time; we don't
// pre-coerce here so the user can flip data types without losing what
// they already typed (the field re-renders into the right input shape
// and the string is re-interpreted under the new type).
//
// `default_value` is capped at 512 chars by the Pydantic schema — the
// per-type editors enforce this at the input layer too so we never
// fail save on a length boundary the user couldn't see coming.

const DEFAULT_VALUE_MAX_LENGTH = 512;

function FixedValueEditor({
  column,
  onChange,
}: {
  column: InvoiceTemplateColumn;
  onChange: (patch: Partial<InvoiceTemplateColumn>) => void;
}) {
  const dataType = columnDataType(column);
  const value = column.default_value ?? "";
  const set = (next: string) => onChange({ default_value: next });
  const clear = () => onChange({ default_value: null });

  // Boolean — segmented Yes / No / unset picker. We persist the literal
  // string ("true" / "false") rather than a JSON boolean so the storage
  // shape matches every other data type's `default_value: string`. The
  // renderer turns "true" → "Yes" (or whatever the boolean output token
  // becomes) at export time.
  if (dataType === "boolean") {
    const current = value === "true" ? true : value === "false" ? false : null;
    return (
      <Section
        title="Fixed value"
        hint="Always emit this Yes/No value for every row."
      >
        <div className="inline-flex rounded-md border border-gray-300 overflow-hidden">
          <button
            type="button"
            onClick={() => set("true")}
            aria-pressed={current === true}
            className={cn(
              "px-3 py-1 text-[12.5px] font-medium border-r border-gray-300",
              current === true
                ? "bg-brand-600 text-white"
                : "bg-white text-gray-700 hover:bg-gray-50",
            )}
          >
            Yes
          </button>
          <button
            type="button"
            onClick={() => set("false")}
            aria-pressed={current === false}
            className={cn(
              "px-3 py-1 text-[12.5px] font-medium border-r border-gray-300",
              current === false
                ? "bg-brand-600 text-white"
                : "bg-white text-gray-700 hover:bg-gray-50",
            )}
          >
            No
          </button>
          <button
            type="button"
            onClick={clear}
            aria-pressed={current === null}
            className={cn(
              "px-3 py-1 text-[12.5px] font-medium",
              current === null
                ? "bg-gray-100 text-gray-700"
                : "bg-white text-gray-400 hover:bg-gray-50",
            )}
          >
            Unset
          </button>
        </div>
      </Section>
    );
  }

  // Date — native date input. The browser surfaces a calendar picker.
  // We persist the ISO yyyy-mm-dd string the input emits; the renderer
  // re-formats on export per `format.date_format`.
  if (dataType === "date") {
    return (
      <Section
        title="Fixed value"
        hint="Always emit this date for every row. Stored as ISO (yyyy-mm-dd); the column's date format is applied at export time."
      >
        <div className="flex items-center gap-2">
          <CalendarDays className="h-3.5 w-3.5 text-gray-400 shrink-0 dark:text-ink-subtle" />
          <input
            type="date"
            value={value}
            onChange={(e) => set(e.target.value)}
            maxLength={DEFAULT_VALUE_MAX_LENGTH}
            className="flex-1 min-w-0 rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white dark:border-line dark:bg-surface dark:text-ink"
            aria-label="Fixed date value"
          />
        </div>
      </Section>
    );
  }

  // Number / currency — numeric input. Currency picks up a small chip
  // showing the currency_code (or the USD default) so the operator
  // sees how the literal will read at render time. Decimal_places isn't
  // enforced at the input layer (the renderer handles rounding); we
  // expose a free numeric input so the user isn't fighting the step.
  if (dataType === "number" || dataType === "currency") {
    const isCurrency = dataType === "currency";
    const currencyCode = column.format?.currency_code ?? "USD";
    return (
      <Section
        title="Fixed value"
        hint={
          isCurrency
            ? `Always emit this ${currencyCode} amount for every row. Decimal places are applied per the column's Format.`
            : "Always emit this number for every row. Decimal places are applied per the column's Format."
        }
      >
        <div className="flex items-center gap-2">
          {isCurrency ? (
            <Coins className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          ) : (
            <Sigma className="h-3.5 w-3.5 text-gray-400 shrink-0 dark:text-ink-subtle" />
          )}
          <input
            type="number"
            value={value}
            onChange={(e) => set(e.target.value)}
            // Currency: cents-grain step. Number: free step (the renderer
            // is the canonical formatter, not the input).
            step={isCurrency ? "0.01" : "any"}
            inputMode="decimal"
            placeholder={isCurrency ? "0.00" : "0"}
            maxLength={DEFAULT_VALUE_MAX_LENGTH}
            className="flex-1 min-w-0 rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white dark:border-line dark:bg-surface dark:text-ink"
            aria-label={isCurrency ? "Fixed currency value" : "Fixed number value"}
          />
          {isCurrency && (
            <span
              className="shrink-0 text-[10px] font-mono uppercase tracking-wide text-gray-500 bg-gray-100 rounded px-1.5 py-0.5"
              title="Currency code from this column's Format. Edit it under Format above."
            >
              {currencyCode}
            </span>
          )}
        </div>
      </Section>
    );
  }

  // Text (and the unreachable dropdown / multi_select fallback) — the
  // legacy free-text input.
  return (
    <Section
      title="Fixed value"
      hint="Always emit this value for every row."
    >
      <input
        type="text"
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder="e.g. USD"
        maxLength={DEFAULT_VALUE_MAX_LENGTH}
        className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink"
      />
    </Section>
  );
}

// ===========================================================================
// Default selected option — pairs with `manual_list` global mode
// ===========================================================================
//
// When a column's universe is an inline enumerated list (`manual_list`),
// the operator may want a SPECIFIC entry to be the "default selected"
// value at render time. Same storage as `fixed_value`'s default — we
// reuse the `default_value` field — but the input shape is a dropdown
// constrained to the `manual_values` universe. This is the answer to:
//
//   "I have a Dropdown column whose allowed values are [Bill, Credit].
//    I want it to default to 'Bill' unless a rule says otherwise."
//
// Without this section the user would have to flip Global behavior to
// `fixed_value`, lose the universe, and re-enter the literal — fighting
// the dropdown's data shape. The picker keeps the universe intact and
// just nominates one entry as the default.
//
// Behavior:
//   * Empty universe → render an inline hint nudging the user to add
//     allowed values above.
//   * default_value matches one of manual_values → it's the selected
//     option in the picker.
//   * default_value is set but doesn't match any current manual_values
//     entry (the user likely deleted that entry after picking) → we
//     surface a "(currently {value} — no longer in list)" warning, and
//     clearing the selection drops the orphan.
//
// Future: when dropdown columns bind to a CATALOG (vendor/property/gl)
// rather than an inline manual_list, the same UX should pick a default
// catalog entry. That's deferred — catalog default-pick is a richer
// surface (search, ID stability) and not in this phase's scope.

function DefaultSelectedOption({
  column,
  onChange,
}: {
  column: InvoiceTemplateColumn;
  onChange: (patch: Partial<InvoiceTemplateColumn>) => void;
}) {
  const allowed = (column.manual_values ?? []).filter(
    (v) => v.trim().length > 0,
  );
  const current = column.default_value ?? null;
  const orphaned = current !== null && current !== "" && !allowed.includes(current);

  // No universe to pick from yet — keep the section visible (so the
  // user knows the picker exists) but show an inline nudge instead of
  // a useless empty dropdown.
  if (allowed.length === 0) {
    return (
      <Section
        title="Default selected"
        hint="Pre-select one of the allowed values as this column's default. Picks up an entry from the Allowed values above."
      >
        <div className="rounded-md border border-dashed border-gray-300 bg-gray-50/50 p-3 text-[11px] text-gray-600 flex items-start gap-2 dark:border-line dark:bg-surface-muted/50 dark:text-ink-muted">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-gray-400 dark:text-ink-subtle" />
          <span>
            Add at least one allowed value above to nominate a default
            selection.
          </span>
        </div>
      </Section>
    );
  }

  return (
    <Section
      title="Default selected"
      hint="Pre-select one of the allowed values as this column's default. Rule rows can still override (subject to Allow rule override)."
    >
      <div className="flex items-center gap-2">
        <CheckSquare className="h-3.5 w-3.5 text-gray-400 shrink-0" />
        <select
          value={current ?? ""}
          onChange={(e) =>
            onChange({ default_value: e.target.value === "" ? null : e.target.value })
          }
          className="flex-1 min-w-0 rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white dark:border-line dark:bg-surface dark:text-ink"
          aria-label="Default selected value"
        >
          <option value="">— No default (operator picks at render) —</option>
          {allowed.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {orphaned && (
        <div className="mt-1.5 rounded-md border border-amber-200 bg-amber-50/70 p-2 text-[10.5px] text-amber-800 flex items-start gap-1.5">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span className="leading-snug">
            Current default <strong>&ldquo;{current}&rdquo;</strong> is no
            longer in the allowed list — pick a new one above or clear the
            default to remove the orphan.
          </span>
        </div>
      )}
    </Section>
  );
}

// ===========================================================================
// Validation section (placeholder bag — schema accepts more than this)
// ===========================================================================

function ValidationSection({
  column,
  onChange,
}: {
  column: InvoiceTemplateColumn;
  onChange: (patch: Partial<InvoiceTemplateColumn>) => void;
}) {
  const v = column.validation ?? {};
  const requiredFromSource = v.required_from_source ?? false;
  const mustBeInList = v.must_be_in_list ?? false;

  const setField = (patch: Partial<typeof v>) => {
    onChange({ validation: { ...v, ...patch } });
  };

  return (
    <Section
      title="Validation"
      hint="Phase 1 records these as the column's contract; the renderer will start enforcing them as the export pipeline lands."
    >
      <div className="space-y-1">
        <CheckboxRow
          label="Value must resolve from its declared source"
          checked={requiredFromSource}
          onToggle={() =>
            setField({ required_from_source: !requiredFromSource })
          }
        />
        <CheckboxRow
          label="Value must be one of the allowed list"
          checked={mustBeInList}
          onToggle={() => setField({ must_be_in_list: !mustBeInList })}
          disabled={column.source_type !== "manual_list"}
          disabledHint="Only meaningful for Manual list source kind."
        />
      </div>
    </Section>
  );
}

function CheckboxRow({
  label,
  checked,
  onToggle,
  disabled,
  disabledHint,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  disabledHint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        "w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-md transition-colors",
        disabled
          ? "opacity-50 cursor-not-allowed"
          : "hover:bg-gray-50",
      )}
      title={disabled ? disabledHint : undefined}
    >
      <div
        className={cn(
          "h-4 w-4 shrink-0 mt-0.5 rounded border flex items-center justify-center",
          checked
            ? "bg-brand-600 border-brand-600 text-white"
            : "bg-white border-gray-300",
        )}
      >
        {checked && <CheckSquare className="h-2.5 w-2.5" />}
      </div>
      <span className="text-[11.5px] text-gray-700 flex-1">
        {label}
        {disabled && disabledHint && (
          <span className="block text-[10px] text-gray-400 italic mt-0.5">
            {disabledHint}
          </span>
        )}
      </span>
    </button>
  );
}

// ===========================================================================
// Section wrapper
// ===========================================================================

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5">
        {title}
      </h3>
      {children}
      {hint && (
        <p className="text-[10px] text-gray-400 mt-1 leading-snug">{hint}</p>
      )}
    </section>
  );
}

// ===========================================================================
// Lock sections (Part 7)
// ===========================================================================
//
// Two siblings of `RequiredSection` — same Switch + tinted-card visual
// language so the locks read as toggles in the same family. The third
// lock concept (`allow_rule_override`) keeps its own dedicated section
// inside group C because it's tightly coupled to the rule-interaction
// story (the rule cell's "Global wins" badge surfaces it directly).

function LockPositionSection({
  value,
  onToggle,
}: {
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <Section
      title="Lock position"
      hint="When on, this column is pinned to its current spot. Other columns can still be reordered around it."
    >
      <div
        className={cn(
          "rounded-md border px-3 py-2.5 transition-colors flex items-start gap-2",
          value ? "border-gray-400 bg-gray-50/80" : "border-gray-200",
        )}
      >
        <Pin
          className={cn(
            "h-3.5 w-3.5 mt-0.5 shrink-0",
            value ? "text-gray-700" : "text-gray-300",
          )}
          aria-hidden
        />
        <div className="flex-1 min-w-0">
          <Switch
            checked={value}
            onChange={onToggle}
            label={value ? "Position pinned" : "Free to reorder"}
            description={
              value
                ? "The column header can't be picked up. The drag handle shows a not-allowed cursor."
                : "Operators can drag the column header to reorder it."
            }
            aria-label="Lock column position toggle"
          />
        </div>
      </div>
    </Section>
  );
}

function LockEditingSection({
  value,
  onToggle,
}: {
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <Section
      title="Lock editing"
      hint="When on, this column's schema (name, source, data type, format, validation) is frozen. Rule cells across the column stay editable."
    >
      <div
        className={cn(
          "rounded-md border px-3 py-2.5 transition-colors flex items-start gap-2",
          value ? "border-slate-400 bg-slate-50/80" : "border-gray-200",
        )}
      >
        <LockKeyhole
          className={cn(
            "h-3.5 w-3.5 mt-0.5 shrink-0",
            value ? "text-slate-700" : "text-gray-300",
          )}
          aria-hidden
        />
        <div className="flex-1 min-w-0">
          <Switch
            checked={value}
            onChange={onToggle}
            label={value ? "Schema frozen" : "Schema editable"}
            description={
              value
                ? "Name, data type, source binding, format, and validation are read-only in the inspector."
                : "Operators can edit every column-level field freely."
            }
            aria-label="Lock column schema toggle"
          />
        </div>
      </div>
    </Section>
  );
}
