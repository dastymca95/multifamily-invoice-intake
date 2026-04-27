"use client";

import {
  AlertTriangle,
  Asterisk,
  Building2,
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CircleAlert,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { getApiErrorMessage, invoiceTemplatesApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  ColumnReadinessOut as BackendColumnReadiness,
  ImportTemplateReadinessPreviewResponse,
  ReadinessItemOut as BackendReadinessItem,
  ReadinessStatus as BackendReadinessStatus,
  ResolverExpectation as BackendResolverExpectation,
} from "@/types/import-readiness";
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
  type InvoiceTemplateRule,
  type InvoiceTemplateRuleCell,
  REF_BINDING_SOURCES,
  RULE_ROLE_DESCRIPTION,
  RULE_ROLE_LABEL,
  type RuleRole,
  catalogKindLabel,
  coerceColumnForDataType,
  columnAllowsRuleOverride,
  columnDataType,
  effectiveCellRole,
  effectiveColumnDefaultRole,
  columnGlobalMode,
  columnLockEditing,
  columnLockPosition,
  fieldOptionsFor,
  setColumnDefaultRolePatch,
} from "@/types/invoice-template";

import {
  type CatalogIndex,
  catalogSliceFor,
} from "../hooks/useCatalogIndex";

/**
 * Floating, draggable inspector panel for the currently-selected column.
 *
 * Originally lived as a fixed right-side `<aside>`, but on wide
 * templates the field the operator wanted to inspect was often
 * scrolled off-screen by the time the inspector docked open — they
 * couldn't see both at once. The inspector is now a movable utility
 * surface: it opens as a floating window (top-right by default) and
 * the operator parks it wherever it doesn't obstruct the cell they're
 * inspecting. The header acts as the drag handle.
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
   * Sibling columns. Used by the readiness checks to resolve the
   * effective rule cell role for OTHER columns inside a rule (the
   * "is this rule conditional?" detection). Not used for editing —
   * the inspector still mutates only `column`.
   */
  columns: InvoiceTemplateColumn[];
  /**
   * The template's current rule rows. The wizard reads them to
   * detect whether any FILL/Action rule writes a value into THIS
   * column — that's the difference between an honest "Looks good"
   * and a misleading green tick that the resolver still rejects.
   */
  rules: InvoiceTemplateRule[];
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
  /**
   * Optional persist-to-server hook. When provided AND `canSave` is
   * true, the wizard footer renders a "Save & close" button so the
   * operator can commit changes from inside the inspector instead of
   * having to dismiss + click the editor's main Save button. Mirrors
   * `handleSave` in `TemplateEditor.tsx`.
   *
   * The handler may return ``Promise<void>`` (rejecting on save
   * failure — Phase 1E) or be void-returning. The inspector's
   * "Save & close" wrapper swallows rejections because the editor's
   * `mutationError` already surfaces the error to the user.
   */
  onSave?: () => Promise<void> | void;
  /** Whether the editor's Save button would currently be enabled. */
  canSave?: boolean;
  /** Whether a save is in flight (drives the Save & close spinner). */
  saving?: boolean;
  /** True iff the editor has local edits not yet persisted. */
  dirty?: boolean;
  /**
   * True iff the editor is showing the in-memory canonical-default
   * draft (no persisted id yet). When set, "Save & close" still
   * works (editor will create a new template) but the wizard surfaces
   * a clear hint that nothing is persisted yet.
   */
  isDraft?: boolean;
  /**
   * Persisted template id (echoed in the readiness preview request
   * payload). ``null`` for unsaved drafts — backend doesn't require
   * it, the columns/rules in the body are the real input.
   */
  templateId?: string | null;
  /**
   * Current template name (echoed in the readiness preview response
   * for client correlation). Reflects the in-flight local edit, not
   * the saved name.
   */
  templateName?: string | null;
  /**
   * Phase 1F — when the inspector is opened from the Validate
   * panel's "Fix" link, the parent specifies which wizard step the
   * operator should land on. The inspector applies this step on
   * mount AND every time ``initialStepNonce`` changes (so re-clicking
   * Fix on a different issue for the SAME column re-navigates).
   *
   * When omitted, the inspector falls back to Step 1 on column
   * switch (the original behavior).
   */
  initialStep?: WizardStepKey;
  /**
   * Bump-counter that signals "the parent wants to (re-)apply
   * ``initialStep`` even if the value didn't change". Without this
   * the inspector can't distinguish "operator manually clicked a
   * different step" from "Validate asked us to jump again".
   */
  initialStepNonce?: number;
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
  columns,
  rules,
  catalogIndex,
  onChange,
  onClose,
  onSave,
  canSave = false,
  saving = false,
  dirty = false,
  isDraft = false,
  templateId = null,
  templateName = null,
  initialStep,
  initialStepNonce,
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
      // Dropdown ↔ manual_values sync at source-type FLIP time.
      //
      // The wider `handleColumnChange` wrapper below mirrors
      // format.list_options → manual_values on every write, BUT
      // GlobalBehaviorSection wires straight to this callback (not
      // the wrapper). Without the inline sync, switching a dropdown
      // column to "Pick from a fixed list at render" left
      // manual_values at the seeded `[""]` while format.list_options
      // already had Bill / Credit — so the DefaultSelectedOption
      // picker rendered an empty universe and the operator had no way
      // to nominate a default. Mirror here too to give the picker
      // values to show immediately.
      const dt = columnDataType(column);
      if (
        (dt === "dropdown" || dt === "multi_select") &&
        next === "manual_list"
      ) {
        const listOpts = (column.format?.list_options ?? []).filter(
          (v) => v.trim().length > 0,
        );
        if (listOpts.length > 0) {
          patch.manual_values = listOpts;
        } else {
          // Empty allowed-values list — clear the seeded blank so the
          // picker correctly reports "no values yet" instead of
          // pretending one exists.
          patch.manual_values = null;
        }
      }
      onChange(patch);
    },
    [
      column.format,
      column.manual_values,
      column.source_ref,
      column.source_type,
      column.data_type,
      onChange,
    ],
  );

  // ---- Floating-window drag state -----------------------------------------
  //
  // The inspector renders as a `position: fixed` floating panel with a
  // dimmed backdrop, mirroring the visual treatment of the New invoice
  // template Modal so the surface reads as a real "dialog moment"
  // rather than a stray side panel. It opens centered, but the header
  // is a drag handle — the operator can move it aside if a part of
  // the table needs to stay visible while editing.
  //
  // We track its top-left in pixel coordinates and update it
  // imperatively from a document-level mousemove listener so the drag
  // stays smooth even if the parent re-renders. The SSR guard returns a
  // deterministic fallback so the first server render has stable markup;
  // the client immediately recomputes against the real `window.innerWidth`
  // / `innerHeight` to land centered.
  // Wizard-era width: 860px desktop max, clamped to the viewport so
  // narrow screens still get a usable surface (24px gutter on each
  // side). The inline style below mirrors `w-[min(860px,calc(100vw-48px))]`
  // so the JS centering math stays in sync with whatever Tailwind
  // actually renders. Bumped from the legacy 320px right rail because
  // the new step-by-step layout (cards + inline alerts + readiness
  // checklist) needs breathing room.
  const FLOATING_MARGIN = 16;
  const FLOATING_WIDTH = (() => {
    if (typeof window === "undefined") return 760;
    return Math.min(860, Math.max(320, window.innerWidth - 48));
  })();
  // Used to estimate vertical centering before the window has measured
  // itself. The wizard is taller than the legacy flat panel — guess a
  // bit higher so the open dialog lands centered for common viewport
  // heights without forcing a re-measure pass.
  const ESTIMATED_HEIGHT = 720;
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    if (typeof window === "undefined") return { x: 0, y: FLOATING_MARGIN * 2 };
    return {
      x: Math.max(
        FLOATING_MARGIN,
        Math.round((window.innerWidth - FLOATING_WIDTH) / 2),
      ),
      y: Math.max(
        FLOATING_MARGIN * 2,
        Math.round((window.innerHeight - ESTIMATED_HEIGHT) / 2),
      ),
    };
  });

  // Live drag offsets kept on a ref so the document-level mousemove
  // handler reads the *latest* origin without stale-closure surprises.
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  // Re-clamp the position whenever the viewport shrinks so the user
  // can't lose the inspector by resizing the window with the panel
  // dragged near an edge.
  useEffect(() => {
    const onResize = () => {
      setPos((p) => ({
        x: Math.min(Math.max(p.x, -260), Math.max(0, window.innerWidth - 60)),
        y: Math.min(Math.max(p.y, 0), Math.max(0, window.innerHeight - 40)),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Esc closes — matches the `Modal` component's behavior so the
  // dimmed-backdrop affordance feels coherent across both surfaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Drag handle — fires on the header surface only. Buttons / inputs
  // inside the header keep their own click semantics: when the
  // mousedown originated on (or inside) an interactive element we bail
  // so the close button still closes and any future header inputs
  // remain typeable.
  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest("button, input, textarea, select, a")) return;
      e.preventDefault();

      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: pos.x,
        origY: pos.y,
      };

      const handleMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;
        // Clamp: keep at least 60px of header on-screen at all times so
        // the user can always grab the window back, even if they
        // overshoot a viewport edge.
        const minX = -260;
        const maxX = Math.max(0, window.innerWidth - 60);
        const minY = 0;
        const maxY = Math.max(0, window.innerHeight - 40);
        setPos({
          x: Math.min(Math.max(drag.origX + dx, minX), maxX),
          y: Math.min(Math.max(drag.origY + dy, minY), maxY),
        });
      };
      const handleUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
      };
      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
    },
    [pos.x, pos.y],
  );

  // ---- Wizard scaffolding ------------------------------------------------
  //
  // The inspector renders as a true page-by-page journey: only the
  // active step's content is mounted at any time. The header + stepper
  // + footer stay sticky around the page area so the operator always
  // knows where they are and what to do next, even on tall content
  // pages.
  //
  // `activeStep` is a discriminated union so the Advanced page (the
  // power-user controls — locks / validation / allow_rule_override)
  // can live alongside the numbered steps without polluting the type.
  //
  // Phase 1F — initial step honours ``initialStep`` from the parent
  // (set when the inspector is opened from the Validate panel's
  // "Fix" link). Falls back to Step 1.
  const [activeStep, setActiveStep] = useState<WizardStepKey>(
    initialStep ?? 1,
  );

  // Reset whenever the inspector switches to a DIFFERENT column. We
  // key off `column.id` rather than the full `column` so in-flight
  // edits to the same column don't kick the operator back to the
  // start of the wizard.
  //
  // Phase 1F — when ``initialStep`` is set, jump there instead of
  // Step 1 so a "Fix" click opens directly on the offending step.
  const columnIdRef = useRef(column.id);
  useEffect(() => {
    if (columnIdRef.current !== column.id) {
      columnIdRef.current = column.id;
      setActiveStep(initialStep ?? 1);
    }
  }, [column.id, initialStep]);

  // Phase 1F — re-apply ``initialStep`` whenever the parent bumps
  // ``initialStepNonce``. This handles the "Fix on issue A then Fix
  // on issue B for the SAME column" case — column.id doesn't change
  // so the column-switch effect doesn't fire, but we still need to
  // navigate to the new step. The nonce is the parent's signal that
  // a NEW fix request just landed.
  const lastConsumedNonceRef = useRef<number | undefined>(initialStepNonce);
  useEffect(() => {
    if (
      initialStepNonce !== undefined &&
      initialStepNonce !== lastConsumedNonceRef.current
    ) {
      lastConsumedNonceRef.current = initialStepNonce;
      if (initialStep) {
        setActiveStep(initialStep);
      }
    }
  }, [initialStep, initialStepNonce]);

  // The readiness checklist's "Fix in step N" links route through
  // setActiveStep — the legacy scrollIntoView approach doesn't apply
  // anymore because non-active pages aren't mounted.
  const onJumpToStep = useCallback((step: 1 | 2 | 3 | 4) => {
    setActiveStep(step);
  }, []);

  // Wrap the parent's onChange to enforce the dropdown ↔ manual_list
  // synchronisation. THE PROBLEM this solves:
  //
  //   The validator reports `DROPDOWN_OPTIONS_EMPTY` against either
  //   `format.list_options` (output-shape constraint) OR
  //   `manual_values` (manual_list source default candidates) —
  //   they're orthogonal fields with overlapping validation. A
  //   beginner editing a Dropdown column with the "Pick from list"
  //   global source ends up having to type Bill / Credit twice (once
  //   in Step 2's Allowed values, once in the legacy ManualListEditor)
  //   or the validator complains about the path they didn't fill.
  //
  // The fix:
  //
  //   For dropdown / multi-select columns whose global source is
  //   `manual_list`, mirror `format.list_options` into `manual_values`
  //   on every write. The wizard hides the legacy ManualListEditor
  //   in this case (Step 3's source subform branches on this) so the
  //   user only ever sees one list. The mirror is one-way
  //   (list_options → manual_values) so dropdown editing in Step 2
  //   stays the single source of truth.
  const handleColumnChange = useCallback(
    (patch: Partial<InvoiceTemplateColumn>) => {
      const next: InvoiceTemplateColumn = { ...column, ...patch };
      const dt = columnDataType(next);
      const mode = columnGlobalMode(next);
      if (
        (dt === "dropdown" || dt === "multi_select") &&
        mode === "manual_list"
      ) {
        const list = (next.format?.list_options ?? []).filter((v) =>
          v.trim().length > 0,
        );
        // Always overwrite manual_values, including clearing it to
        // null when the canonical list goes empty. Without the null
        // branch, removing every option would leave stale values
        // behind in manual_values — the validator would pass on the
        // manual_values path while failing on list_options, which is
        // exactly the inconsistency this sync exists to prevent.
        patch = { ...patch, manual_values: list.length > 0 ? list : null };
      }
      onChange(patch);
    },
    [column, onChange],
  );

  // Recommendation lookup against the canonical column name. Beginners
  // get a one-click recipe for the columns they're most likely to
  // configure (Bill or Credit, Invoice Number, Vendor, GL Account…).
  const recommendation = getColumnRecommendation(column.name);
  const handleApplyRecommendation = useCallback(() => {
    if (!recommendation) return;
    handleColumnChange(recommendation.patch);
  }, [handleColumnChange, recommendation]);

  // Local readiness checklist (Step 5 contents + per-step status chip
  // colours). Pure derivation from the live column shape.
  const readiness = computeReadiness(column, rules, columns);
  const valuePicture = computeValueSourcePicture(column, rules, columns);
  const dropdownLike = dataType === "dropdown" || dataType === "multi_select";
  const dropdownOptions = (column.format?.list_options ?? []).filter(
    (v) => v.trim().length > 0,
  );
  const dropdownNeedsOptions = dropdownLike && dropdownOptions.length === 0;

  // Step 3's manual-list editor is hidden for dropdown/multi-select
  // because the wizard mirrors format.list_options into manual_values
  // (see `handleColumnChange` above). For non-dropdown manual_list
  // columns we still fall through to the existing ManualListEditor.
  const hideManualListEditor = dropdownLike && sourceType === "manual_list";

  // ---- Phase 1D — backend readiness preview --------------------------
  //
  // Calls POST /invoice-templates/readiness-preview with the current
  // local template state (unsaved edits included). The backend's
  // verdict is the canonical source of truth — when available, the
  // wizard renders BACKEND items / status / expectation, falling back
  // to the local heuristic helpers only for the loading / error /
  // offline windows. Drift between wizard and resolver collapses by
  // construction.
  //
  // Debounce + race protection:
  //   * 400ms timer between input change and request fire — typing
  //     a value into a Step 2 list box doesn't fire 12 requests.
  //   * AbortController cancels stale in-flight requests when newer
  //     inputs arrive.
  //   * A request-id ref discards out-of-order responses (cheap
  //     defense in depth in case AbortController cancellation lags).
  const backendReadiness = useBackendReadiness({
    templateId,
    templateName,
    columns,
    rules,
    columnId: column.id,
  });
  const backendColumnReadiness = backendReadiness.columnReadiness;

  // Decide which readiness data feeds the wizard this render. When
  // the backend has responded for the current column, its items /
  // value-source / expectation are authoritative. Loading / error
  // states fall through to the local helpers so the operator never
  // sees a blank wizard.
  const useBackend = backendColumnReadiness !== null;
  const effectiveItems: ReadinessItem[] = useBackend
    ? backendItemsToLocal(backendColumnReadiness.items)
    : readiness;
  const effectivePicture: ValueSourcePicture = useBackend
    ? backendToValueSourcePicture(backendColumnReadiness)
    : valuePicture;

  // Per-step status badges drive the stepper chips + footer status
  // text. Steps 1–4 each filter the (effective) readiness items by
  // `fixStep`; Step 5 summarises ALL items; Advanced has no inherent
  // status so it's always neutral.
  //
  // When backend data is in play, the Step 5 summary uses the
  // BACKEND's own column-status field directly — that's the
  // authoritative roll-up the backend computed across structure /
  // value_source / rule_runtime / required-burden advisories.
  const stepStatuses: Record<WizardStepKey, ReadinessStatus | null> = {
    1: statusForStep(effectiveItems, 1),
    2: statusForStep(effectiveItems, 2),
    3: statusForStep(effectiveItems, 3),
    4: statusForStep(effectiveItems, 4),
    5: useBackend
      ? backendStatusToLocal(backendColumnReadiness.status)
      : summariseReadiness(effectiveItems),
    advanced: null,
  };

  // The only HARD gate on Next is missing fundamental identity data:
  // a column with no name or no data type isn't safe to evaluate
  // through later steps. All other warnings are surfaced via the
  // stepper badges + readiness page but never block progression
  // (per spec: "Do not trap user aggressively").
  const identityComplete =
    column.name.trim().length > 0 && Boolean(dataType);
  const canAdvanceFromStep1 = identityComplete;

  const STEP_ORDER: WizardStepKey[] = [1, 2, 3, 4, 5, "advanced"];
  const currentIdx = STEP_ORDER.indexOf(activeStep);
  const isFirst = currentIdx === 0;
  const isLast = currentIdx === STEP_ORDER.length - 1;
  const goBack = useCallback(() => {
    setActiveStep((curr) => {
      const idx = STEP_ORDER.indexOf(curr);
      return idx > 0 ? STEP_ORDER[idx - 1] : curr;
    });
    // STEP_ORDER is a stable literal array — exhaustive deps would
    // require it as a dep but it never changes between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const goNext = useCallback(() => {
    setActiveStep((curr) => {
      const idx = STEP_ORDER.indexOf(curr);
      return idx < STEP_ORDER.length - 1 ? STEP_ORDER[idx + 1] : curr;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const nextDisabled = activeStep === 1 && !canAdvanceFromStep1;

  return (
    <>
      {/* ---- Dimmed backdrop ------------------------------------------- */}
      {/* Same scrim treatment as the `Modal` component (40% black light /
          60% dark) so the inspector reads as a real "dialog moment"
          rather than an inert side surface. Click anywhere on the scrim
          to dismiss — mirrors the New template modal behavior the user
          referenced. The inspector itself sits one layer above. */}
      <div
        className="fixed inset-0 z-40 bg-black/40 dark:bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        role="dialog"
        aria-label="Column inspector"
        aria-modal="true"
        className={cn(
          // Modal-style floating window: fixed-position so the editor
          // table flows full-width underneath. `z-50` matches the
          // `Modal` component's layer; real Modals (which portal to
          // <body>) still win via DOM order if both happen to be open.
          //
          // Width: responsive 860px desktop max, clamped against the
          // viewport on narrow screens (24px gutter each side). The
          // wizard's step cards + inline warnings + readiness checklist
          // need significantly more horizontal room than the legacy
          // 320px right-rail panel.
          "fixed z-50 flex flex-col w-[min(860px,calc(100vw-48px))]",
          // `rounded-xl` + `shadow-xl` mirror the New template Modal
          // so the two dialog moments feel like the same surface.
          "bg-white border border-gray-200 rounded-xl shadow-xl",
          "dark:bg-surface-subtle dark:border-line",
        )}
        // Inline style drives both the live position AND a dynamic
        // max-height so the window always fits between its top edge and
        // the viewport bottom — wherever the user has dragged it.
        style={{
          left: pos.x,
          top: pos.y,
          maxHeight: `calc(100vh - ${pos.y}px - ${FLOATING_MARGIN}px)`,
        }}
      >
        {/* ---- Header (drag handle) -------------------------------------- */}
        {/* `cursor-move` + `select-none` advertise the draggable affordance.
            The mousedown handler bails for nested interactive elements so
            the close button below keeps its click semantics. */}
        <div
          onMouseDown={handleHeaderMouseDown}
          className="px-4 py-3 border-b border-gray-200 flex items-start gap-2 dark:border-line cursor-move select-none rounded-t-xl"
        >
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

      {/* ---- Sticky stepper navigation -------------------------------- */}
      {/* The stepper is the operator's compass: at a glance they see
          where they are in the journey, which steps still need
          attention (status chip per step), and they can jump to any
          step by clicking it. Sits BELOW the draggable header (so the
          drag-handle area doesn't shrink) and ABOVE the page area. */}
      <Stepper
        active={activeStep}
        statuses={stepStatuses}
        onSelect={setActiveStep}
      />

      {/* ---- Page area — only the active step is mounted ------------ */}
      {/* The whole point of the journey UX: the operator sees ONE
          page at a time. No long vertical scroll across all steps.
          The page itself can scroll internally if its content is
          tall (rare in practice). The recommendation banner sits
          above the active page so it's visible from any step. */}
      <div className="flex-1 min-h-0 overflow-auto px-5 py-5 space-y-4 bg-gray-50/50 dark:bg-surface/40">
        {recommendation && activeStep === 1 && (
          <RecommendationBanner
            recommendation={recommendation}
            onApply={handleApplyRecommendation}
          />
        )}

        {/* ============ Page 1 — Identity ============================ */}
        {activeStep === 1 && (
          <WizardPage
            title="What is this column?"
            hint="The column's identity. Defines the shape of the final exported column."
            status={stepStatuses[1]}
          >
            <ColumnNameField
              value={column.name}
              onChange={(next) => handleColumnChange({ name: next })}
            />

            <RequiredSection
              required={required}
              onToggle={() =>
                handleColumnChange({ required: !required })
              }
            />

            <DataTypeSection
              dataType={dataType}
              onChange={(next) =>
                // `coerceColumnForDataType` returns a patch that may
                // CLEAR global-mode fields (source_type / source_ref /
                // manual_values / default_value) when the previous
                // source kind is no longer recommended for the new
                // type. The picker re-renders immediately into a clean
                // state instead of leaving stale bindings.
                handleColumnChange(coerceColumnForDataType(column, next))
              }
            />

            {!identityComplete && (
              <StepWarning tone="warning" title="Finish the basics first">
                A column needs a name and a data type before later steps
                make sense. Next stays disabled until both are set.
              </StepWarning>
            )}
          </WizardPage>
        )}

        {/* ============ Page 2 — Allowed values / format ============= */}
        {/* FormatSection adapts to data type: dropdown / multi-select
            render the canonical Allowed values editor that writes to
            `format.list_options`; date gets a date-format picker;
            number/currency get decimal places + currency code; text/
            boolean show nothing here. */}
        {activeStep === 2 && (
          <WizardPage
            title="What values are allowed?"
            hint="Define how this column is rendered on export — the allowed-value list for dropdowns, the format mask for dates / currency."
            status={stepStatuses[2]}
          >
            {dropdownLike && (
              <StepWarning tone="info" title="How allowed values work">
                These are the only values that can appear in this column
                on export. Step 3's "Pick from fixed list" default
                source reuses the same list — you never type the values
                twice.
              </StepWarning>
            )}

            <FormatSection
              dataType={dataType}
              format={column.format ?? null}
              onChange={(nextFormat) =>
                handleColumnChange({ format: nextFormat })
              }
            />

            {dropdownNeedsOptions && (
              <StepWarning tone="error" title="Add at least one allowed value">
                {dataType === "multi_select" ? "Multi-select" : "Dropdown"}{" "}
                columns can't be saved with an empty options list. Use
                the "+ Add option" button above.
              </StepWarning>
            )}

            {!dropdownLike &&
              dataType !== "date" &&
              dataType !== "number" &&
              dataType !== "currency" && (
                <p className="rounded-md border border-dashed border-gray-200 bg-white px-3 py-3 text-[12px] text-gray-500 dark:border-line dark:bg-surface-subtle dark:text-ink-muted">
                  No extra allowed-value setup needed for{" "}
                  <span className="font-medium text-gray-700 dark:text-ink">
                    {dataType}
                  </span>{" "}
                  columns. Continue to the next step.
                </p>
              )}
          </WizardPage>
        )}

        {/* ============ Page 3 — Default source (global behavior) === */}
        {activeStep === 3 && (
          <WizardPage
            title="Where should Rivera get this value by default?"
            hint="The column's default value strategy when no rule row applies. Rule cells layer on top of this in Step 4."
            status={stepStatuses[3]}
          >
            <GlobalBehaviorSection
              dataType={dataType}
              sourceType={sourceType}
              onChange={handleSourceTypeChange}
            />

            {/* Manual-list editor is HIDDEN when the column is a
                dropdown/multi-select with manual_list source — the
                wizard mirrors format.list_options into manual_values
                automatically (see handleColumnChange). What we DO
                still need to show is the `DefaultSelectedOption`
                picker — that's the control the operator uses to
                nominate which allowed value the resolver should
                emit as the column's baseline. Hiding the entire
                SourceSubform (legacy bug) made this picker invisible
                and produced the "Looks good but Dry Run says missing"
                trap; the fix is to render the DefaultSelectedOption
                explicitly here, alongside an info banner that
                explains where the values come from + a jump button
                back to Step 2 when the universe is still empty. */}
            {hideManualListEditor ? (
              <>
                {dropdownOptions.length > 0 ? (
                  <StepWarning tone="info">
                    Using your{" "}
                    <strong>
                      {dropdownOptions.length} allowed value
                      {dropdownOptions.length === 1 ? "" : "s"}
                    </strong>{" "}
                    from Step 2. Choose which one Rivera should output
                    as the column's default below.
                  </StepWarning>
                ) : (
                  <StepWarning tone="warning" title="No allowed values yet">
                    Add allowed values in Step 2 before choosing a
                    default for this column.
                    <button
                      type="button"
                      onClick={() => setActiveStep(2)}
                      className="ml-2 inline-flex items-center text-[11px] font-semibold text-brand-700 hover:underline dark:text-brand-50"
                    >
                      Go to Step 2 →
                    </button>
                  </StepWarning>
                )}
                {/* The default-value picker. Reads from
                    `column.manual_values` (kept in sync with
                    `format.list_options` by handleColumnChange) and
                    writes `column.default_value`. Persisted on the
                    template so the resolver picks it up as the
                    column's baseline. */}
                <DefaultSelectedOption
                  column={column}
                  onChange={handleColumnChange}
                />
                {required &&
                  dropdownOptions.length > 0 &&
                  !column.default_value && (
                    <StepWarning
                      tone="error"
                      title="Pick a default value to make this column ready"
                    >
                      This required column has allowed values, but
                      Rivera still needs to know which value to output.
                      Choose a default value above, or add a rule
                      Action/FILL in Step 4 that writes one of the
                      allowed values.
                    </StepWarning>
                  )}
                {!required &&
                  dropdownOptions.length > 0 &&
                  !column.default_value && (
                    <StepWarning tone="info">
                      No default selected — operators will pick a value
                      at runtime. Set a default above if you want
                      Rivera to fill the column automatically.
                    </StepWarning>
                  )}
              </>
            ) : (
              <SourceSubform
                column={column}
                sourceType={sourceType}
                catalogIndex={catalogIndex}
                onChange={handleColumnChange}
              />
            )}

            {/* ---- Source-specific contextual warnings ---- */}
            {sourceType === "invoice_field" &&
              !column.source_ref?.field && (
                <StepWarning>
                  Choose which invoice field should populate this column.
                </StepWarning>
              )}
            {(sourceType === "vendor_field" ||
              sourceType === "property_field" ||
              sourceType === "gl_field") &&
              !column.source_ref?.catalog_id && (
                <StepWarning>
                  Choose a catalog before Rivera can resolve this value.
                </StepWarning>
              )}
            {required && sourceType === "empty" && (
              <StepWarning title="No default source for a required column">
                This is okay only if a rule FILL action will provide the
                value. Otherwise pick a default source above.
              </StepWarning>
            )}
          </WizardPage>
        )}

        {/* ============ Page 4 — Rule behavior ======================= */}
        {activeStep === 4 && (
          <WizardPage
            title="How should rules interact with this column?"
            hint="Rule rows underneath this column behave according to the role you pick here. Rule cells can still override on a per-row basis under Advanced."
            status={stepStatuses[4]}
          >
            {/* "Rule role is optional here" affordance — when Step 3's
                default already resolves the column unconditionally,
                the role picker is just an override knob. Tell the
                operator so they don't think they're missing
                something by leaving it as "No default role". */}
            {valuePicture.globalVerdict.status === "ok" &&
              !valuePicture.globalVerdict.conditional && (
                <StepWarning tone="info" title="Rule role is optional here">
                  Step 3 already resolves this column with{" "}
                  <strong>{valuePicture.globalVerdict.label}</strong>.
                  Pick a role only if you want rules to override the
                  default on specific rows.
                </StepWarning>
              )}

            <RuleRoleSection
              role={effectiveColumnDefaultRole(column)}
              onChange={(next) =>
                handleColumnChange(setColumnDefaultRolePatch(column, next))
              }
            />

            <RuleInteractionBanner
              allow={allowRuleOverride}
              globalMode={sourceType}
            />

            {/* ---- Role-vs-data warnings ----
                Skipped when an unconditional global baseline exists
                (e.g. Bill or Credit with default Bill): the column is
                already resolvable, so the role pinned here can't
                "fail to write" anything. */}
            {required &&
              effectiveColumnDefaultRole(column) === "restriction" &&
              sourceType === "empty" &&
              !(valuePicture.globalVerdict.status === "ok" &&
                !valuePicture.globalVerdict.conditional) && (
                <StepWarning title="LIMIT does not write a value">
                  LIMIT (Restriction) only narrows where a rule applies
                  — it never fills the column. Switch to FILL (Action)
                  or add a default source in Step 3 if this column must
                  end up filled.
                </StepWarning>
              )}
            {required &&
              effectiveColumnDefaultRole(column) === "condition" &&
              sourceType === "empty" &&
              !(valuePicture.globalVerdict.status === "ok" &&
                !valuePicture.globalVerdict.conditional) && (
                <StepWarning title="IF only decides whether the rule runs">
                  IF (Condition) doesn't fill this column. Switch to
                  FILL (Action) or add a default source in Step 3 if
                  this column must end up filled.
                </StepWarning>
              )}
          </WizardPage>
        )}

        {/* ============ Page 5 — Readiness checklist ================= */}
        {activeStep === 5 && (
          <WizardPage
            title="Column readiness"
            hint="What the resolver actually sees. Mirrors the same value-source logic the backend uses for Validate + Dry Run, so green checks here mean Dry Run will agree."
            status={stepStatuses[5]}
          >
            {/* Backend-readiness provenance banner — tells the
                operator whether the verdicts they're looking at came
                from the canonical backend or the local heuristic
                fallback. Phase 1D contract: green checks must
                correspond to backend agreement. */}
            <BackendReadinessBanner
              loading={backendReadiness.loading}
              error={backendReadiness.error}
              hasResponse={useBackend}
              dirty={Boolean(dirty)}
              isDraft={Boolean(isDraft)}
            />

            {/* Resolver expectation card — uses BACKEND verdict when
                available; falls through to the local heuristic
                picture during loading / error / offline windows. */}
            <ResolverExpectationCard picture={effectivePicture} />

            {/* Saved-changes hint — even when readiness is green,
                Dry Run uses the LAST SAVED template. Readiness
                preview, however, evaluates the local in-flight
                payload; keep both signals visible so the operator
                doesn't conflate them. */}
            {dirty && !isDraft && (
              <StepWarning tone="warning" title="Unsaved changes for Dry Run">
                Readiness preview above already reflects your local
                edits. Validate and Dry Run still read the LAST SAVED
                version — use Save & close in the footer before
                running diagnostics.
              </StepWarning>
            )}

            <ReadinessChecklist
              items={effectiveItems}
              onJumpToStep={onJumpToStep}
            />
          </WizardPage>
        )}

        {/* ============ Advanced page ================================ */}
        {/* Power-user controls live on their own page so beginners
            don't trip over them, but the spec explicitly requires
            they remain reachable. The Advanced tab in the stepper
            (rendered with a distinct neutral chip) is always
            accessible. */}
        {activeStep === "advanced" && (
          <WizardPage
            title="Advanced"
            hint="Rule override · validation · locks. Power-user controls — most operators never need to touch these."
            status={null}
          >
            <AllowRuleOverrideSection
              allow={allowRuleOverride}
              globalMode={sourceType}
              onToggle={() =>
                handleColumnChange({
                  allow_rule_override: !allowRuleOverride,
                })
              }
            />
            <ValidationSection
              column={column}
              onChange={handleColumnChange}
            />
            <LockPositionSection
              value={lockPosition}
              onToggle={() =>
                handleColumnChange({ lock_position: !lockPosition })
              }
            />
            <LockEditingSection
              value={lockEditing}
              onToggle={() =>
                handleColumnChange({ lock_editing: !lockEditing })
              }
            />
          </WizardPage>
        )}
      </div>

      {/* ---- Sticky footer — Back / Next / Done ---------------------- */}
      <WizardFooter
        active={activeStep}
        currentIdx={currentIdx}
        total={STEP_ORDER.length}
        isFirst={isFirst}
        isLast={isLast}
        nextDisabled={nextDisabled}
        statusLabel={statusLabelForStep(activeStep, stepStatuses[activeStep])}
        onBack={goBack}
        onNext={goNext}
        onDone={onClose}
        onSaveAndClose={
          onSave
            ? () => {
                // Phase 1E — `onSave` (TemplateEditor.handleSave)
                // returns a Promise that REJECTS on save failure.
                // The editor toolbar surfaces the error via
                // `mutationError`, so swallow here to avoid an
                // "unhandled promise rejection" in the console; the
                // inspector closes either way (matching the original
                // fire-and-forget behavior — the user re-opens after
                // fixing the error in the toolbar).
                Promise.resolve(onSave()).catch(() => {
                  /* mutationError handles UX */
                });
                onClose();
              }
            : undefined
        }
        canSave={canSave}
        saving={saving}
        dirty={dirty}
        isDraft={isDraft}
      />
      </aside>
    </>
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
  role: RuleRole | null;
  onChange: (next: RuleRole | null) => void;
}) {
  return (
    <Section
      title="Rule role"
      hint="Determines how this column's cells are interpreted inside rule rows below."
    >
      <div className="rounded-md border border-gray-200 overflow-hidden dark:border-line">
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-pressed={role === null}
          className={cn(
            "w-full text-left px-3 py-2 flex items-start gap-2.5 border-b border-gray-100 transition-colors dark:border-line/60",
            role === null
              ? "bg-gray-100/80 dark:bg-surface-muted"
              : "bg-white hover:bg-gray-50 dark:bg-surface-subtle dark:hover:bg-surface-muted",
          )}
        >
          <div
            className={cn(
              "h-6 w-6 shrink-0 rounded flex items-center justify-center mt-0.5",
              role === null
                ? "bg-gray-200 text-gray-700 dark:bg-surface-muted dark:text-ink"
                : "bg-gray-100 text-gray-500 dark:bg-surface-muted dark:text-ink-subtle",
            )}
          >
            <Square className="h-3 w-3" />
          </div>
          <div className="flex-1 min-w-0">
            <p
              className={cn(
                "text-[12px] font-semibold",
                role === null
                  ? "text-gray-900 dark:text-ink"
                  : "text-gray-700 dark:text-ink",
              )}
            >
              No default role
            </p>
            <p className="text-[10.5px] text-gray-500 mt-0.5 leading-snug dark:text-ink-muted">
              Cells without their own role stay informational and do not inherit the legacy role.
            </p>
          </div>
          {role === null && (
            <ChevronRight className="h-3.5 w-3.5 text-gray-600 mt-1" />
          )}
        </button>
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

// ===========================================================================
// Wizard helpers — recommendations + readiness
// ===========================================================================

/**
 * Suggested-setup recipes keyed by canonicalised column name. The
 * wizard surfaces these as a one-click "Apply suggested setup" banner
 * at the top of Step 1 so beginners don't have to think through every
 * knob from scratch.
 *
 * Each recipe is a partial column patch — the wizard merges it into
 * the existing column rather than replacing wholesale, so values the
 * user already typed (description, lock state, etc.) survive.
 */
interface ColumnRecommendation {
  /** Friendly explanation rendered above the apply button. */
  explanation: string;
  /** Patch handed to `onChange` when the operator clicks Apply. */
  patch: Partial<InvoiceTemplateColumn>;
}

const COLUMN_RECOMMENDATIONS: Record<string, ColumnRecommendation> = {
  "bill or credit": {
    explanation:
      "Most invoices are Bills. Lock the dropdown to Bill / Credit, set Bill as the default, and let rules flip to Credit on credit memos.",
    patch: {
      data_type: "dropdown",
      format: { list_options: ["Bill", "Credit"] },
      source_type: "fixed_value",
      default_value: "Bill",
      default_rule_role: "action",
      rule_role: "action",
    },
  },
  "invoice number": {
    explanation:
      "Pulled from the extracted invoice payload. Required text column with the invoice's number as its FILL action source.",
    patch: {
      data_type: "text",
      required: true,
      source_type: "invoice_field",
      source_ref: { field: "invoice_number" },
      default_rule_role: "action",
      rule_role: "action",
    },
  },
  "invoice date": {
    explanation:
      "Date pulled from the extracted invoice. The Date format under Step 2 controls how it's rendered on export.",
    patch: {
      data_type: "date",
      required: true,
      source_type: "invoice_field",
      source_ref: { field: "invoice_date" },
      default_rule_role: "action",
      rule_role: "action",
    },
  },
  vendor: {
    explanation:
      "Match against your Vendors catalog. Use as a Condition (IF) to scope rules per vendor, or as an Action (FILL) to write the vendor on export.",
    patch: {
      source_type: "vendor_field",
      source_ref: { field: "vendor_name" },
      default_rule_role: "condition",
      rule_role: "condition",
    },
  },
  "vendor name": {
    explanation:
      "Match against your Vendors catalog. Use as a Condition (IF) to scope rules per vendor.",
    patch: {
      source_type: "vendor_field",
      source_ref: { field: "vendor_name" },
      default_rule_role: "condition",
      rule_role: "condition",
    },
  },
  property: {
    explanation:
      "Match against your Properties catalog. Often used as a LIMIT to narrow which properties a rule applies to.",
    patch: {
      source_type: "property_field",
      source_ref: { field: "property_name" },
      default_rule_role: "restriction",
      rule_role: "restriction",
    },
  },
  "gl account": {
    explanation:
      "Looked up from your GL Codes catalog. Almost always written by a FILL action so the right GL ends up on the export row.",
    patch: {
      source_type: "gl_field",
      source_ref: { field: "gl_code" },
      default_rule_role: "action",
      rule_role: "action",
    },
  },
  "gl code": {
    explanation:
      "Looked up from your GL Codes catalog. Almost always written by a FILL action.",
    patch: {
      source_type: "gl_field",
      source_ref: { field: "gl_code" },
      default_rule_role: "action",
      rule_role: "action",
    },
  },
  amount: {
    explanation:
      "Currency value pulled from the invoice. Set decimal places + currency code under Step 2 to control export rendering.",
    patch: {
      data_type: "currency",
      required: true,
      source_type: "invoice_field",
      source_ref: { field: "amount" },
      default_rule_role: "action",
      rule_role: "action",
    },
  },
  total: {
    explanation:
      "Currency total pulled from the invoice. Set decimal places + currency code under Step 2.",
    patch: {
      data_type: "currency",
      required: true,
      source_type: "invoice_field",
      source_ref: { field: "amount" },
      default_rule_role: "action",
      rule_role: "action",
    },
  },
};

function getColumnRecommendation(
  name: string,
): ColumnRecommendation | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return COLUMN_RECOMMENDATIONS[key] ?? null;
}

/**
 * One row in the Step 5 readiness checklist.
 *
 * `status`:
 *   * `ok`      — green check, no action needed.
 *   * `warning` — yellow, the operator should consider fixing.
 *   * `error`   — red, the column will be rejected by the validator
 *                 or fall through with a missing value at runtime.
 *
 * `category` groups items in the Step 5 UI under one of three headers
 * that mirror the backend's mental model:
 *   * `structure`    — does the column have a coherent declared shape?
 *   * `value_source` — is there a real path to a value at resolve time?
 *   * `rule_runtime` — when does that path actually fire?
 *
 * `fixStep` lets the row render a "Fix in step N" link that jumps
 * the wizard to the relevant step.
 */
type ReadinessStatus = "ok" | "warning" | "error";

type ReadinessCategory = "structure" | "value_source" | "rule_runtime";

interface ReadinessItem {
  status: ReadinessStatus;
  category: ReadinessCategory;
  label: string;
  detail?: string;
  fixStep?: 1 | 2 | 3 | 4;
}

// ---------------------------------------------------------------------------
// Cell + value-source helpers (mirror backend resolver semantics)
// ---------------------------------------------------------------------------

/**
 * Mirrors the backend's `_has_value()` check on a rule cell. A cell
 * is non-empty when it carries at least one of:
 *   * a literal value (`values[i].trim().length > 0`)
 *   * a structured catalog selection (`selections[i]` with usable
 *     `field_value` or `entry_id`)
 *   * a Phase-2 extraction binding (`extraction_bindings[i]` — the
 *     resolver evaluates these at runtime against extracted facts)
 *
 * The legacy `extraction` single-binding is folded in as a one-item
 * binding by the resolver; we count it here too so legacy templates
 * don't false-negative.
 */
function isCellNonEmpty(cell: InvoiceTemplateRuleCell): boolean {
  if (cell.values?.some((v) => typeof v === "string" && v.trim().length > 0)) {
    return true;
  }
  if (
    cell.selections?.some(
      (s) =>
        (typeof s.field_value === "string" && s.field_value.trim().length > 0) ||
        (typeof s.entry_id === "string" && s.entry_id.trim().length > 0),
    )
  ) {
    return true;
  }
  if (cell.extraction_bindings && cell.extraction_bindings.length > 0) {
    return true;
  }
  if (
    cell.extraction &&
    (cell.extraction.pattern_id || cell.extraction.field_key)
  ) {
    return true;
  }
  return false;
}

/**
 * Honest verdict on whether the column's GLOBAL source has a path
 * the resolver can actually use to produce a value (without rules).
 *
 * IMPORTANT: this mirrors what the backend resolver actually does,
 * not what the UI used to imply. In particular:
 *   * A `manual_list` source with `default_value` set is treated as
 *     a SOFT default (resolver may still wait for a runtime pick) —
 *     status "warning" rather than "ok", because the operator can be
 *     surprised by the resolver still reporting the column missing.
 *   * `derived` is not yet evaluated by the resolver — surface as a
 *     warning.
 *
 * `conditional` flags sources whose resolution depends on runtime
 * inputs (extracted facts, catalog hints) — they're "ok" for
 * structural readiness but the operator needs to know dry-run will
 * still need facts/hints to actually produce a value.
 */
interface ValueSourceVerdict {
  status: ReadinessStatus;
  label: string;
  detail?: string;
  /** True when the source needs a runtime input to produce a value. */
  conditional?: boolean;
}

function evaluateGlobalSource(
  column: InvoiceTemplateColumn,
): ValueSourceVerdict {
  const sourceType = columnGlobalMode(column);
  const defaultValue =
    typeof column.default_value === "string"
      ? column.default_value.trim()
      : "";
  switch (sourceType) {
    case "empty":
      return {
        status: "warning",
        label: "No global source",
        detail: "Column has no default source. A rule must FILL this column.",
      };
    case "fixed_value":
      if (defaultValue.length > 0) {
        return {
          status: "ok",
          label: `Always emits "${defaultValue}"`,
          detail: "Resolver baseline — same value on every export row.",
        };
      }
      return {
        status: "error",
        label: "Fixed-value source has no value",
        detail: "Pick a constant in Step 3 or change the source kind.",
      };
    case "manual_list": {
      // Phase A — mirror backend resolver semantics. The wizard can
      // only promise "Should resolve" when the column has either:
      //   * a single manual_value (resolver auto-selects it), OR
      //   * a default_value that exactly matches one of manual_values
      //     (resolver honors operator-selected default).
      //
      // Comparison is whitespace-trimmed + case-sensitive — same as
      // the backend's `_resolve_column_baseline` manual_list branch
      // and the validator's MANUAL_LIST_DEFAULT_NOT_IN_LIST check.
      const manualUniverse = (column.manual_values ?? []).filter(
        (v): v is string =>
          typeof v === "string" && v.trim().length > 0,
      );
      const trimmedDefault = defaultValue;
      const defaultMatches =
        trimmedDefault.length > 0 &&
        manualUniverse.some((v) => v.trim() === trimmedDefault);

      if (defaultMatches) {
        return {
          status: "ok",
          label: `Default selected: "${trimmedDefault}"`,
          detail:
            "The resolver picks this default whenever no rule overrides the column.",
        };
      }
      if (
        trimmedDefault.length > 0 &&
        manualUniverse.length > 0 &&
        !defaultMatches
      ) {
        // Default selected but NOT in the manual values — backend
        // validator will emit MANUAL_LIST_DEFAULT_NOT_IN_LIST and the
        // resolver will fall through to manual_review. Be honest in
        // the wizard so the operator fixes it before Save.
        return {
          status: "warning",
          label: `Default "${trimmedDefault}" is not in the allowed list`,
          detail:
            "Pick one of the allowed values as the default, or clear the default selection.",
        };
      }
      if (manualUniverse.length === 1) {
        return {
          status: "ok",
          label: `Only allowed value: "${manualUniverse[0]}"`,
          detail:
            "Single-option lists auto-resolve to that value at runtime.",
        };
      }
      return {
        status: "warning",
        label: "Pick-from-list with no default",
        detail:
          "Operators must pick at runtime — required columns will report missing in Dry Run unless a default is selected or a rule fills the value.",
      };
    }
    case "invoice_field":
      if (column.source_ref?.field) {
        return {
          status: "ok",
          label: `Pulls extracted field "${column.source_ref.field}"`,
          detail:
            "Depends on extracted facts at runtime — Dry Run needs a matching fact (or a rule fallback).",
          conditional: true,
        };
      }
      return {
        status: "error",
        label: "No invoice field selected",
        detail: "Choose the extracted field in Step 3.",
      };
    case "vendor_field":
    case "property_field":
    case "gl_field": {
      const hasCatalog = Boolean(column.source_ref?.catalog_id);
      const hasField = Boolean(column.source_ref?.field);
      if (hasCatalog && hasField) {
        return {
          status: "ok",
          label: `Reads "${column.source_ref?.field}" from selected catalog`,
          detail:
            "Depends on the runtime catalog hint — Dry Run needs a matching hint (or a rule fallback).",
          conditional: true,
        };
      }
      if (hasCatalog) {
        return {
          status: "warning",
          label: "Catalog selected but no field",
          detail: "Pick which catalog field to read in Step 3.",
        };
      }
      return {
        status: "error",
        label: "Catalog source incomplete",
        detail: "Choose a catalog before Rivera can resolve this value.",
      };
    }
    case "derived":
      return {
        status: "warning",
        label: "Derived sources not evaluated yet",
        detail: "Placeholder — the resolver doesn't compute derived columns.",
      };
  }
  return { status: "warning", label: "Unknown source kind" };
}

/**
 * Walk every rule and find FILL/Action cells that would write THIS
 * column. Mirrors backend rule-eligibility logic:
 *   * `rule.is_active` must be true
 *   * The cell at this column must have an effective role of `"action"`
 *   * The cell must be non-empty (literal value, catalog selection, or
 *     extraction binding)
 *   * The column must allow rule overrides (otherwise the resolver
 *     ignores rule-level FILLs entirely)
 *
 * Each match is bucketed by whether the surrounding rule is GATED:
 * a rule is gated when one of its OTHER cells has a non-empty
 * `condition` or `restriction` role — those have to match runtime
 * inputs before the FILL fires. We fall back to a heuristic when a
 * sibling cell's role is null (column-default-role): if the cell is
 * non-empty and the cell's column has a non-action default, we assume
 * it's a gating cell.
 */
interface RuleFillMatch {
  ruleId: string;
  ruleIndex: number;
  conditional: boolean;
  /** Human-readable hint about what gates the rule (for UI display). */
  gatingHint?: string;
}

function findRuleFillPaths(
  column: InvoiceTemplateColumn,
  rules: InvoiceTemplateRule[],
  columns: InvoiceTemplateColumn[],
): RuleFillMatch[] {
  if (!columnAllowsRuleOverride(column)) {
    return [];
  }
  const columnsById = new Map(columns.map((c) => [c.id, c]));
  const matches: RuleFillMatch[] = [];

  rules.forEach((rule, ruleIndex) => {
    if (!rule.is_active) return;
    const cell = rule.cells[column.id];
    if (!cell) return;
    const role = effectiveCellRole(cell, column);
    if (role !== "action") return;
    if (!isCellNonEmpty(cell)) return;

    // Look for sibling cells in the same rule that would gate the
    // rule's eligibility (condition / restriction with content).
    const gatingLabels: string[] = [];
    for (const [siblingId, siblingCell] of Object.entries(rule.cells)) {
      if (siblingId === column.id) continue;
      if (!isCellNonEmpty(siblingCell)) continue;
      const siblingCol = columnsById.get(siblingId);
      const siblingRole = effectiveCellRole(siblingCell, siblingCol);
      if (siblingRole === "condition" || siblingRole === "restriction") {
        const colName = siblingCol?.name?.trim() || "(unnamed)";
        const roleWord =
          siblingRole === "condition" ? "IF" : "LIMIT";
        gatingLabels.push(`${roleWord} ${colName}`);
      }
    }
    matches.push({
      ruleId: rule.id,
      ruleIndex,
      conditional: gatingLabels.length > 0,
      gatingHint:
        gatingLabels.length > 0
          ? gatingLabels.slice(0, 3).join(" · ") +
            (gatingLabels.length > 3 ? ` · +${gatingLabels.length - 3} more` : "")
          : undefined,
    });
  });

  return matches;
}

/**
 * Combine global-source + rule-fill verdicts into a single per-column
 * value-source picture. Used for Step 5 readiness items + the Step 5
 * "Resolver expectation" card at the top of the page.
 */
interface ValueSourcePicture {
  globalVerdict: ValueSourceVerdict;
  ruleFills: RuleFillMatch[];
  /** True when at least one rule writes the column unconditionally. */
  hasUnconditionalFill: boolean;
  /** True when at least one rule writes the column under conditions. */
  hasConditionalFill: boolean;
  /** Resolver expectation for Dry Run. */
  expectation: "should_resolve" | "may_be_missing" | "will_be_missing";
  expectationLabel: string;
  expectationDetail: string;
}

function computeValueSourcePicture(
  column: InvoiceTemplateColumn,
  rules: InvoiceTemplateRule[],
  columns: InvoiceTemplateColumn[],
): ValueSourcePicture {
  const globalVerdict = evaluateGlobalSource(column);
  const ruleFills = findRuleFillPaths(column, rules, columns);
  const hasUnconditionalFill = ruleFills.some((m) => !m.conditional);
  const hasConditionalFill = ruleFills.some((m) => m.conditional);
  const required = column.required ?? false;

  // Verdict ladder — strongest first:
  //   1. unconditional global baseline (fixed_value with default,
  //      manual_list with default selected) → should resolve.
  //   2. unconditional rule FILL → should resolve.
  //   3. conditional global source (invoice/catalog) without rule
  //      backup → may be missing if runtime input doesn't match.
  //   4. conditional rule FILL only → may be missing unless rule
  //      conditions match.
  //   5. nothing usable → will be missing for required columns.
  let expectation: "should_resolve" | "may_be_missing" | "will_be_missing";
  let expectationLabel: string;
  let expectationDetail: string;

  if (globalVerdict.status === "ok" && !globalVerdict.conditional) {
    expectation = "should_resolve";
    expectationLabel = "Should resolve";
    expectationDetail = `Global source provides "${globalVerdict.label}" before any rule runs.`;
  } else if (hasUnconditionalFill) {
    expectation = "should_resolve";
    expectationLabel = "Should resolve";
    expectationDetail = "An unconditional rule FILL writes this column on every row.";
  } else if (globalVerdict.status === "ok" && globalVerdict.conditional) {
    expectation = "may_be_missing";
    expectationLabel = "May be missing without a runtime input";
    expectationDetail =
      "Global source needs the right runtime input (extracted fact or catalog hint). Provide one in Dry Run, or add a rule fallback.";
  } else if (hasConditionalFill) {
    const sample = ruleFills.find((m) => m.conditional);
    const ruleLabel = sample
      ? `Rule ${sample.ruleIndex + 1}`
      : "a rule";
    expectation = "may_be_missing";
    expectationLabel = `May be missing unless ${ruleLabel} matches`;
    expectationDetail = sample?.gatingHint
      ? `${ruleLabel} only fires when its conditions match (${sample.gatingHint}). Provide matching Dry Run inputs or add a default source.`
      : "FILL rules in this column are gated by IF/LIMIT cells. Provide matching Dry Run inputs or add a default source.";
  } else {
    expectation = required ? "will_be_missing" : "may_be_missing";
    expectationLabel = required
      ? "Will be missing in Dry Run"
      : "Has no value source";
    expectationDetail = required
      ? "Required column with no resolvable global source and no FILL rule. Add a default in Step 3 or a FILL rule that writes this column."
      : "No source configured. Optional columns are fine without one.";
  }

  return {
    globalVerdict,
    ruleFills,
    hasUnconditionalFill,
    hasConditionalFill,
    expectation,
    expectationLabel,
    expectationDetail,
  };
}

/**
 * Compute the Step 5 readiness checklist from the live column shape +
 * the surrounding template's rules. Pure function (no side effects)
 * so the wizard can call it on every render and the rendered list
 * always reflects the live state.
 *
 * IMPORTANT: this is a LOCAL HEURISTIC mirror of what the backend
 * validator + resolver check. The backend remains the source of
 * truth — but the wizard MUST NOT show "Looks good" on a column the
 * resolver would reject. Items are bucketed into Structure /
 * Value source / Rule runtime so the operator's mental model maps to
 * how the backend reasons.
 */
function computeReadiness(
  column: InvoiceTemplateColumn,
  rules: InvoiceTemplateRule[],
  columns: InvoiceTemplateColumn[],
): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const dataType = columnDataType(column);
  const sourceType = columnGlobalMode(column);
  const required = column.required ?? false;
  const role = effectiveColumnDefaultRole(column);
  const picture = computeValueSourcePicture(column, rules, columns);

  // ============ A. Structure ==========================================
  items.push({
    category: "structure",
    status: column.name?.trim() ? "ok" : "error",
    label: column.name?.trim() ? "Column has a name" : "Add a column name",
    fixStep: 1,
  });
  items.push({
    category: "structure",
    status: dataType ? "ok" : "warning",
    label: `Data type: ${dataType}`,
    fixStep: 1,
  });
  items.push({
    category: "structure",
    status: "ok",
    label: required ? "Marked required" : "Optional column",
    detail: required
      ? "The validator refuses exports that omit this column's value."
      : "Missing values won't block export.",
    fixStep: 1,
  });

  // Allowed values (dropdown / multi-select)
  if (dataType === "dropdown" || dataType === "multi_select") {
    const opts = column.format?.list_options ?? [];
    const blanks = opts.filter((v) => !v.trim()).length;
    if (opts.length === 0) {
      items.push({
        category: "structure",
        status: "error",
        label: `${dataType === "multi_select" ? "Multi-select" : "Dropdown"} options missing`,
        detail:
          "Add at least one allowed value or change the data type — exports will fail validation otherwise.",
        fixStep: 2,
      });
    } else if (blanks > 0) {
      items.push({
        category: "structure",
        status: "warning",
        label: `${blanks} blank option${blanks === 1 ? "" : "s"} in the allowed list`,
        detail:
          "Blank entries are stripped on save — fill them in or remove the row.",
        fixStep: 2,
      });
    } else {
      items.push({
        category: "structure",
        status: "ok",
        label: `${opts.length} allowed value${opts.length === 1 ? "" : "s"} configured`,
        detail:
          "These are the values that can appear in this column on export. They do NOT by themselves provide a default — see Value source below.",
        fixStep: 2,
      });
    }
  }

  // ============ B. Value source =======================================
  // Global source verdict — honest about whether the resolver can
  // produce a value WITHOUT runtime input.
  items.push({
    category: "value_source",
    status: picture.globalVerdict.status,
    label: picture.globalVerdict.label,
    detail: picture.globalVerdict.detail,
    fixStep: 3,
  });

  // For required columns, surface the resolver's hard rule: a value
  // path must exist (global default OR an eligible FILL rule). If
  // neither exists, this is a HARD readiness error — the resolver
  // will emit `REQUIRED_RUNTIME_VALUE_MISSING`.
  if (required) {
    if (picture.expectation === "will_be_missing") {
      items.push({
        category: "value_source",
        status: "error",
        label: "Required column has no resolvable value path",
        detail:
          "The resolver will emit REQUIRED_RUNTIME_VALUE_MISSING. Add a default source in Step 3, OR add a rule with a FILL/Action cell for this column.",
        fixStep: 3,
      });
    } else if (
      picture.expectation === "may_be_missing" &&
      picture.globalVerdict.status !== "ok"
    ) {
      items.push({
        category: "value_source",
        status: "warning",
        label: "Required column relies on rule FILL",
        detail:
          "No global default exists. The column is filled only when a rule's conditions match — Dry Run may report it missing without matching inputs.",
        fixStep: 3,
      });
    }
  }

  // Dropdown/multi-select with options but no selected default and
  // no FILL rule — the most common Bill-or-Credit confusion.
  if (
    (dataType === "dropdown" || dataType === "multi_select") &&
    (column.format?.list_options ?? []).length > 0 &&
    !column.default_value &&
    !picture.hasUnconditionalFill &&
    !picture.hasConditionalFill
  ) {
    items.push({
      category: "value_source",
      status: required ? "error" : "warning",
      label: `${column.name?.trim() || "This column"} has allowed values, but no selected value source`,
      detail:
        "Choose a default in Step 3 (Pick from fixed list → Default selected), or configure a rule Action/FILL with one of the allowed values.",
      fixStep: 3,
    });
  }

  // ============ C. Rule runtime =======================================
  //
  // KEY INSIGHT for required-column readiness: rules are an OPTIONAL
  // OVERRIDE LAYER, not a mandatory completion step. If the global
  // source already resolves the column unconditionally (e.g. Bill or
  // Credit's "Default selected: Bill"), the column is fully ready
  // without any rule role at all — Step 4 should not nag about it.
  //
  // We compute the "do we already have a baseline that resolves?"
  // signal once and use it to:
  //   * Downgrade the conditional-fill warning to an informational
  //     note (rules become a useful override, not a missing piece).
  //   * Skip the IF/LIMIT-without-FILL warning entirely (only fires
  //     when no source AND no unconditional fill exist).
  //   * Skip the FILL-with-no-cell-value warning entirely (the
  //     baseline carries the column on its own).
  //   * Emit a celebratory "Rule role optional" item so Step 4 reads
  //     as completed rather than empty.
  const hasResolvableBaseline =
    picture.globalVerdict.status === "ok" &&
    !picture.globalVerdict.conditional;

  if (picture.ruleFills.length === 0) {
    if (rules.length > 0) {
      items.push({
        category: "rule_runtime",
        status: "ok",
        label: "No rule FILLs this column",
        detail: hasResolvableBaseline
          ? "Optional. Step 3's default already resolves the column — add a FILL only if you want per-row overrides."
          : "If you want a rule to write this column, add a FILL/Action cell in Step 4 of the matrix view.",
        fixStep: 4,
      });
    }
  } else {
    if (picture.hasUnconditionalFill) {
      const count = picture.ruleFills.filter((m) => !m.conditional).length;
      items.push({
        category: "rule_runtime",
        status: "ok",
        label: `${count} rule${count === 1 ? "" : "s"} write${count === 1 ? "s" : ""} this column unconditionally`,
        detail: "Always fills regardless of which conditions match.",
        fixStep: 4,
      });
    }
    if (picture.hasConditionalFill) {
      const conditional = picture.ruleFills.filter((m) => m.conditional);
      const sample = conditional[0];
      const condCount = conditional.length;
      // Conditional fills are a WARNING when nothing else resolves
      // the column, but only an INFO when the global default already
      // does the job — they're a fine-grained override, not a hole.
      items.push({
        category: "rule_runtime",
        status: hasResolvableBaseline ? "ok" : "warning",
        label: hasResolvableBaseline
          ? `${condCount} rule${condCount === 1 ? "" : "s"} can override the default under conditions`
          : `${condCount} rule${condCount === 1 ? "" : "s"} fill${condCount === 1 ? "s" : ""} this column under conditions`,
        detail: hasResolvableBaseline
          ? sample?.gatingHint
            ? `Sample: Rule ${sample.ruleIndex + 1} fires when ${sample.gatingHint} — Step 3's default fills the rest.`
            : "Step 3's default fills the column when these rules don't match."
          : sample?.gatingHint
            ? `Sample: Rule ${sample.ruleIndex + 1} only fires when ${sample.gatingHint}.`
            : "These FILLs only fire when their IF/LIMIT cells match.",
        fixStep: 4,
      });
    }
  }

  // "Rule role optional" — explicit celebratory item so Step 4 reads
  // as a positive "you're done" rather than a silent "nothing to see
  // here" when the operator has correctly relied on a global default.
  // Only fires when the column is truly safe AND the user didn't pin
  // a concrete role (no point adding noise when they HAVE a role).
  if (hasResolvableBaseline && role === null) {
    items.push({
      category: "rule_runtime",
      status: "ok",
      label: "Rule role optional — default value resolves the column",
      detail:
        "Step 3's default already provides a value. Pick a role here only if you want rules to override the default.",
      fixStep: 4,
    });
  }

  // Rule role coherence — if column says IF/LIMIT as default and is
  // required, surface the classic warning. SKIPPED when an
  // unconditional baseline exists: the column is already resolved
  // regardless of the role pinned here.
  if (
    required &&
    (role === "condition" || role === "restriction") &&
    sourceType === "empty" &&
    !picture.hasUnconditionalFill &&
    !hasResolvableBaseline
  ) {
    const roleLabel =
      role === "condition" ? "IF (Condition)" : "LIMIT (Restriction)";
    items.push({
      category: "rule_runtime",
      status: "warning",
      label: `${roleLabel} does not fill required columns`,
      detail:
        "Condition and Restriction roles never write a value. Switch to FILL (Action) or add a default source in Step 3.",
      fixStep: 4,
    });
  }

  // FILL role with no rule actually carrying a value — beginner trap.
  // SKIPPED when an unconditional baseline exists: the column already
  // has a value path that doesn't need rule cooperation.
  if (
    role === "action" &&
    sourceType === "empty" &&
    picture.ruleFills.length === 0 &&
    rules.length > 0 &&
    !hasResolvableBaseline
  ) {
    items.push({
      category: "rule_runtime",
      status: "warning",
      label: "Default role is FILL, but no rule cell carries a value",
      detail:
        "Add a value, catalog selection, or extraction binding to a rule cell in this column under Step 4 of the table/matrix view.",
      fixStep: 4,
    });
  }

  return items;
}

function summariseReadiness(items: ReadinessItem[]): ReadinessStatus {
  if (items.some((i) => i.status === "error")) return "error";
  if (items.some((i) => i.status === "warning")) return "warning";
  return "ok";
}

/**
 * Per-step heuristic status used by the WizardStep header chip.
 * Local view of `computeReadiness` filtered to one step's concerns.
 */
function statusForStep(
  items: ReadinessItem[],
  step: 1 | 2 | 3 | 4,
): ReadinessStatus | null {
  const relevant = items.filter((i) => i.fixStep === step);
  if (relevant.length === 0) return null;
  return summariseReadiness(relevant);
}

// ===========================================================================
// Wizard sub-components
// ===========================================================================

/**
 * Small inline alert card used inside a step to call out a missing
 * piece of configuration. Visually louder than the existing inline
 * hints but smaller than a full Modal alert — sized to sit between
 * fields without dominating the step.
 */
function StepWarning({
  tone = "warning",
  title,
  children,
}: {
  tone?: "warning" | "error" | "info";
  title?: string;
  children: React.ReactNode;
}) {
  const Icon =
    tone === "error" ? CircleAlert : tone === "info" ? Info : AlertTriangle;
  const cls =
    tone === "error"
      ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
      : tone === "info"
        ? "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
        : "border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-200";
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]",
        cls,
      )}
    >
      <Icon className="h-4 w-4 shrink-0 mt-0.5" />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        <p className={cn(title ? "mt-0.5" : "", "leading-snug")}>{children}</p>
      </div>
    </div>
  );
}

/**
 * Top-of-wizard "Suggested setup" card. Surfaces a one-click recipe
 * matched against the canonical column name (e.g. "Bill or Credit"
 * → dropdown with Bill/Credit + Bill default + FILL role).
 *
 * The card is dismissible — once dismissed it stays hidden for the
 * lifetime of this inspector mount so the operator isn't nagged.
 */
function RecommendationBanner({
  recommendation,
  onApply,
}: {
  recommendation: ColumnRecommendation;
  onApply: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 dark:border-brand-900 dark:bg-brand-900/30">
      <div className="flex items-start gap-3">
        <span className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-900/60 dark:text-brand-50">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[12.5px] font-semibold text-brand-800 dark:text-brand-50">
            Suggested setup for this column
          </p>
          <p className="mt-1 text-[11.5px] leading-snug text-brand-900/80 dark:text-brand-50/80">
            {recommendation.explanation}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={onApply}
            >
              Apply suggested setup
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setDismissed(true)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Step 5 content. Mirrors the existing Validate modal's checklist
 * idiom but lives inline inside the inspector so the operator can
 * scan readiness without round-tripping through the validator.
 *
 * Each item has a status icon and an optional "Fix in step N" link
 * that scrolls the relevant step into view.
 */
function ReadinessChecklist({
  items,
  onJumpToStep,
}: {
  items: ReadinessItem[];
  onJumpToStep: (step: 1 | 2 | 3 | 4) => void;
}) {
  if (items.length === 0) {
    return (
      <p className="text-[12px] text-gray-500 dark:text-ink-muted">
        Nothing to check yet. Configure the steps above.
      </p>
    );
  }
  // Group by category in the canonical Validate / Resolver order:
  //   A. Structure  → does the column have a coherent declared shape?
  //   B. Value source → is there a real path the resolver can use?
  //   C. Rule runtime → when does that path actually fire?
  const groups: Array<{
    key: ReadinessCategory;
    title: string;
    hint: string;
  }> = [
    {
      key: "structure",
      title: "A. Structure",
      hint: "What this column declares about itself.",
    },
    {
      key: "value_source",
      title: "B. Value source",
      hint: "How the resolver gets a value at runtime.",
    },
    {
      key: "rule_runtime",
      title: "C. Rule runtime",
      hint: "Which rules write into this column, and when.",
    },
  ];
  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const groupItems = items.filter((i) => i.category === group.key);
        if (groupItems.length === 0) return null;
        return (
          <div key={group.key}>
            <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
              {group.title}
            </p>
            <p className="text-[10.5px] text-gray-500 dark:text-ink-muted leading-snug">
              {group.hint}
            </p>
            <ul className="mt-1 space-y-1.5">
              {groupItems.map((item, idx) => (
                <ReadinessRow
                  key={`${group.key}-${idx}`}
                  item={item}
                  onJumpToStep={onJumpToStep}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function ReadinessRow({
  item,
  onJumpToStep,
}: {
  item: ReadinessItem;
  onJumpToStep: (step: 1 | 2 | 3 | 4) => void;
}) {
  const Icon =
    item.status === "ok"
      ? CheckCircle2
      : item.status === "warning"
        ? AlertTriangle
        : CircleAlert;
  const tone =
    item.status === "ok"
      ? "text-green-600 dark:text-green-400"
      : item.status === "warning"
        ? "text-yellow-600 dark:text-yellow-400"
        : "text-red-600 dark:text-red-400";
  return (
    <li className="flex items-start gap-2.5 rounded-md border border-gray-100 bg-white px-3 py-2 text-[12px] dark:border-line/60 dark:bg-surface-subtle">
      <Icon className={cn("h-4 w-4 shrink-0 mt-0.5", tone)} />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-800 dark:text-ink">{item.label}</p>
        {item.detail && (
          <p className="mt-0.5 text-[11px] leading-snug text-gray-500 dark:text-ink-muted">
            {item.detail}
          </p>
        )}
      </div>
      {item.fixStep && item.status !== "ok" && (
        <button
          type="button"
          onClick={() => onJumpToStep(item.fixStep!)}
          className="shrink-0 text-[11px] font-semibold text-brand-700 hover:underline dark:text-brand-50"
        >
          Fix in step {item.fixStep} →
        </button>
      )}
    </li>
  );
}

/**
 * "Resolver expectation" card at the top of Step 5. Translates the
 * value-source picture into a one-glance verdict the operator can
 * trust:
 *
 *   * "Should resolve" — green. Either an unconditional global
 *     source or an unconditional rule FILL writes the column.
 *   * "May be missing unless …" — yellow. Source exists but depends
 *     on a runtime input (extracted fact, catalog hint, or a rule
 *     condition matching). Dry Run will probably need help.
 *   * "Will be missing in Dry Run" — red. Required column with no
 *     resolvable path. The resolver will emit
 *     REQUIRED_RUNTIME_VALUE_MISSING.
 */
function ResolverExpectationCard({
  picture,
}: {
  picture: ValueSourcePicture;
}) {
  const Icon =
    picture.expectation === "should_resolve"
      ? CheckCircle2
      : picture.expectation === "may_be_missing"
        ? AlertTriangle
        : CircleAlert;
  const tone =
    picture.expectation === "should_resolve"
      ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
      : picture.expectation === "may_be_missing"
        ? "border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-200"
        : "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200";
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2.5 flex items-start gap-2",
        tone,
      )}
    >
      <Icon className="h-4 w-4 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-wide font-semibold opacity-80">
          Resolver expectation
        </p>
        <p className="text-[13px] font-semibold mt-0.5">
          {picture.expectationLabel}
        </p>
        <p className="text-[11.5px] mt-1 leading-snug">
          {picture.expectationDetail}
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2 text-[10.5px]">
          <ExpectationStat
            label="Default source"
            ok={
              picture.globalVerdict.status === "ok" &&
              !picture.globalVerdict.conditional
            }
            partial={
              picture.globalVerdict.status === "ok" &&
              !!picture.globalVerdict.conditional
            }
          />
          <ExpectationStat
            label="Rule FILL path"
            ok={picture.hasUnconditionalFill}
            partial={
              picture.hasConditionalFill && !picture.hasUnconditionalFill
            }
          />
          <ExpectationStat
            label="Needs runtime input"
            ok={
              picture.expectation === "should_resolve" ||
              (!picture.hasConditionalFill &&
                picture.globalVerdict.status === "ok" &&
                !picture.globalVerdict.conditional)
            }
            partial={false}
            invertOk
          />
        </div>
      </div>
    </div>
  );
}

function ExpectationStat({
  label,
  ok,
  partial,
  invertOk = false,
}: {
  label: string;
  ok: boolean;
  partial: boolean;
  /** When true, the "yes" label means the row is GOOD (e.g. "needs
   *  runtime input" is good when the answer is no). */
  invertOk?: boolean;
}) {
  const display =
    ok && !partial
      ? invertOk
        ? "No"
        : "Yes"
      : partial
        ? "Maybe"
        : invertOk
          ? "Yes"
          : "No";
  return (
    <div className="rounded-md bg-white/60 px-2 py-1.5 dark:bg-surface/40">
      <p className="opacity-80 truncate">{label}</p>
      <p className="font-semibold mt-0.5">{display}</p>
    </div>
  );
}

/**
 * Inline column-name editor for Step 1. Mirrors the rename input on
 * the table-mode HeaderCell / matrix-mode FieldLabelCell so renaming
 * from inside the inspector feels identical.
 */
function ColumnNameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const empty = value.trim().length === 0;
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
        Column name
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Invoice Number"
        maxLength={120}
        className={cn(
          "mt-1 w-full rounded-md border bg-white px-2.5 py-1.5 text-[13px] text-gray-800 outline-none",
          "focus:ring-2 focus:ring-brand-500",
          "dark:bg-surface dark:text-ink",
          empty
            ? "border-red-300 dark:border-red-900"
            : "border-gray-300 dark:border-line",
        )}
      />
      {empty && (
        <p className="mt-1 text-[10.5px] text-red-600 dark:text-red-300">
          Give this column a name so the export header makes sense.
        </p>
      )}
    </div>
  );
}

// ===========================================================================
// Step-by-step journey: types + chrome (stepper + page wrapper + footer)
// ===========================================================================

/**
 * Stepper key set. The numbered steps (1–5) carry beginner-friendly
 * configuration; "advanced" hosts power-user toggles (locks /
 * validation / allow_rule_override) that the spec requires we keep
 * reachable but out of the default journey.
 */
/**
 * Stepper key used by the ColumnInspector wizard.
 *
 * Phase 1F — exported so external surfaces (the Validate panel's
 * "Fix" navigation) can ask the inspector to open at a specific
 * step. The validator's per-issue ``fix_step`` is mapped onto this
 * shape via ``fixStepToWizardStep`` below.
 */
export type WizardStepKey = 1 | 2 | 3 | 4 | 5 | "advanced";

/**
 * Map a backend readiness ``fix_step`` (number 1–5, the literal
 * ``"advanced"``, or unknown/missing) onto a concrete inspector
 * step. Unknown values land on Step 5 (Readiness) so the operator
 * sees the full backend readiness picture without us guessing.
 */
export function fixStepToWizardStep(
  fix: number | string | null | undefined,
): WizardStepKey {
  if (typeof fix === "number" && fix >= 1 && fix <= 5) {
    return fix as WizardStepKey;
  }
  if (fix === "advanced") return "advanced";
  return 5;
}

/**
 * Display labels for each stepper chip. Order is the canonical step
 * order — see `STEP_ORDER` in the component for the array form used
 * by Back / Next navigation.
 */
const STEP_LABEL: Record<WizardStepKey, string> = {
  1: "Identity",
  2: "Values",
  3: "Default",
  4: "Rules",
  5: "Readiness",
  advanced: "Advanced",
};

/**
 * Friendly status label rendered in the footer status chip. Echoes
 * the stepper badge wording so the operator sees the same verdict
 * twice when scanning the dialog.
 */
function statusLabelForStep(
  step: WizardStepKey,
  status: ReadinessStatus | null,
): string {
  const base =
    step === "advanced" ? "Advanced controls" : STEP_LABEL[step];
  if (status === "error") return `${base} · Needs fixing`;
  if (status === "warning") return `${base} · Check this`;
  if (status === "ok") return `${base} · Looks good`;
  return base;
}

/**
 * Page wrapper for the active step. Renders a step title + hint and
 * a status badge — same idiom as the legacy `WizardStep` card but
 * without the numbered chip (the stepper above already supplies the
 * step number).
 */
function WizardPage({
  title,
  hint,
  status,
  children,
}: {
  title: string;
  hint: string;
  status?: ReadinessStatus | null;
  children: React.ReactNode;
}) {
  const statusLabel =
    status === "error"
      ? "Needs fixing"
      : status === "warning"
        ? "Check this"
        : status === "ok"
          ? "Looks good"
          : null;
  const statusTone =
    status === "error"
      ? "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900"
      : status === "warning"
        ? "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900"
        : "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900";
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-line dark:bg-surface-subtle">
      <header className="px-5 pt-4 pb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-ink">
            {title}
          </h3>
          {statusLabel && (
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                statusTone,
              )}
            >
              {statusLabel}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11.5px] leading-snug text-gray-600 dark:text-ink-muted">
          {hint}
        </p>
      </header>
      <div className="px-5 pb-5 pt-2 space-y-3">{children}</div>
    </section>
  );
}

/**
 * Sticky horizontal stepper. Each step is a clickable chip showing
 * the step number, label, and a tiny status indicator (✓ ok / ⚠
 * warning / ! error). The active step is highlighted in brand blue.
 * The Advanced chip is rendered with a neutral tone so it visually
 * sits apart from the numbered journey.
 *
 * Per the spec: every step is clickable. We never trap the operator
 * — Next is the only control that can be disabled (see WizardFooter).
 */
function Stepper({
  active,
  statuses,
  onSelect,
}: {
  active: WizardStepKey;
  statuses: Record<WizardStepKey, ReadinessStatus | null>;
  onSelect: (step: WizardStepKey) => void;
}) {
  const steps: WizardStepKey[] = [1, 2, 3, 4, 5, "advanced"];
  return (
    <nav
      aria-label="Inspector journey"
      className="border-b border-gray-200 px-2 py-2 bg-white dark:border-line dark:bg-surface-subtle"
    >
      {/* Horizontal scroll on tight viewports keeps every step
          reachable without crowding the chips. */}
      <div className="flex items-center gap-1 overflow-x-auto">
        {steps.map((step, idx) => (
          <StepperItem
            key={String(step)}
            step={step}
            index={idx + 1}
            active={active === step}
            status={statuses[step]}
            onSelect={() => onSelect(step)}
          />
        ))}
      </div>
    </nav>
  );
}

function StepperItem({
  step,
  index,
  active,
  status,
  onSelect,
}: {
  step: WizardStepKey;
  index: number;
  active: boolean;
  status: ReadinessStatus | null;
  onSelect: () => void;
}) {
  const isAdvanced = step === "advanced";
  const StatusIcon =
    status === "ok"
      ? CheckCircle2
      : status === "warning"
        ? AlertTriangle
        : status === "error"
          ? CircleAlert
          : null;
  const statusIconClass =
    status === "ok"
      ? "text-green-600 dark:text-green-400"
      : status === "warning"
        ? "text-yellow-600 dark:text-yellow-400"
        : status === "error"
          ? "text-red-600 dark:text-red-400"
          : "";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "step" : undefined}
      className={cn(
        "shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors",
        active
          ? "bg-brand-600 text-white dark:bg-brand-700"
          : isAdvanced
            ? "text-gray-500 hover:bg-gray-100 dark:text-ink-muted dark:hover:bg-surface-muted"
            : "text-gray-700 hover:bg-gray-100 dark:text-ink dark:hover:bg-surface-muted",
      )}
    >
      {!isAdvanced && (
        <span
          className={cn(
            "inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold",
            active
              ? "bg-white/20 text-white"
              : "bg-gray-200 text-gray-600 dark:bg-surface-muted dark:text-ink-muted",
          )}
          aria-hidden="true"
        >
          {index}
        </span>
      )}
      <span>{STEP_LABEL[step]}</span>
      {StatusIcon && (
        <StatusIcon
          className={cn("h-3 w-3", active ? "text-white" : statusIconClass)}
          aria-hidden="true"
        />
      )}
    </button>
  );
}

/**
 * Sticky footer. Pinned to the bottom of the floating window so Back
 * / Next / Done are always one click away — the spec's core "user
 * always knows what to do next" requirement.
 *
 * Button gating:
 *   * Back: disabled on the first page.
 *   * Next: disabled on the LAST page (Done shows instead) AND
 *     disabled on Page 1 when fundamental identity data (name +
 *     data type) is missing.
 *   * Done: rendered on the LAST page only; closes the inspector.
 *
 * Status text on the left mirrors the active step's badge so the
 * operator sees the same verdict twice — once on the stepper, once
 * down here.
 */
function WizardFooter({
  active,
  currentIdx,
  total,
  isFirst,
  isLast,
  nextDisabled,
  statusLabel,
  onBack,
  onNext,
  onDone,
  onSaveAndClose,
  canSave = false,
  saving = false,
  dirty = false,
  isDraft = false,
}: {
  active: WizardStepKey;
  currentIdx: number;
  total: number;
  isFirst: boolean;
  isLast: boolean;
  nextDisabled: boolean;
  statusLabel: string;
  onBack: () => void;
  onNext: () => void;
  onDone: () => void;
  /** When provided, the footer renders a "Save & close" button that
   *  triggers the editor's main save handler then closes the
   *  inspector. Mirrors `handleSave` in TemplateEditor. */
  onSaveAndClose?: () => void;
  canSave?: boolean;
  saving?: boolean;
  dirty?: boolean;
  isDraft?: boolean;
}) {
  const positionLabel =
    active === "advanced"
      ? "Advanced"
      : `Step ${currentIdx + 1} of ${total - 1}`;
  // Status line below the position now ALSO surfaces unsaved-changes
  // awareness so the operator never closes thinking changes are
  // already in the saved template (which is what Validate / Dry Run
  // read).
  const unsavedHint = dirty
    ? isDraft
      ? "Draft — Save & close persists to the server"
      : "Unsaved changes — Save & close persists them"
    : null;
  return (
    <footer className="border-t border-gray-200 px-5 py-3 flex items-center gap-3 bg-white rounded-b-xl dark:border-line dark:bg-surface-subtle">
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-semibold text-gray-700 dark:text-ink truncate">
          {positionLabel}
        </p>
        <p className="text-[10.5px] text-gray-500 truncate dark:text-ink-muted">
          {unsavedHint ?? statusLabel}
        </p>
      </div>
      {/* Save & close — only when the editor handed us a save handler
          AND there's something to save. Disabled while a save is in
          flight; shows spinner via Button.loading. */}
      {onSaveAndClose && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onSaveAndClose}
          disabled={!canSave || saving}
          loading={saving}
          title={
            !canSave
              ? "Nothing to save — fix any blocking issues first."
              : "Save the template and close the inspector."
          }
        >
          Save & close
        </Button>
      )}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onBack}
        disabled={isFirst}
      >
        Back
      </Button>
      {isLast ? (
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={onDone}
          title={
            dirty
              ? "Closes only — your changes are still unsaved. Use Save & close to persist."
              : undefined
          }
        >
          Done
        </Button>
      ) : (
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={onNext}
          disabled={nextDisabled}
          title={
            nextDisabled
              ? "Set a column name and pick a data type before continuing."
              : undefined
          }
        >
          Next
        </Button>
      )}
    </footer>
  );
}

// ===========================================================================
// Phase 1D — backend readiness preview hook + adapters + banner
// ===========================================================================
//
// The ColumnInspector renders the BACKEND'S verdict whenever it has
// one for the current column; the local heuristic helpers
// (`computeReadiness`, `evaluateGlobalSource`, etc.) become the
// fallback for the loading / error / offline windows. The hook below
// is the integration point — it fetches with debounce, cancels stale
// requests, and surfaces the per-column slice the inspector needs.

interface UseBackendReadinessParams {
  templateId: string | null;
  templateName: string | null;
  columns: InvoiceTemplateColumn[];
  rules: InvoiceTemplateRule[];
  /** Which column to surface from the response. */
  columnId: string;
  /** Debounce window in milliseconds. Default 400ms. */
  debounceMs?: number;
}

interface BackendReadinessSnapshot {
  /** True while a fetch is in flight. */
  loading: boolean;
  /** Last error message, or null. Cleared on next successful fetch. */
  error: string | null;
  /**
   * The backend column readiness matching ``columnId``. ``null``
   * when no response yet, when the columnId isn't in the response,
   * or when the most recent fetch errored.
   */
  columnReadiness: BackendColumnReadiness | null;
  /** The full last-good response (useful for whole-template UI). */
  response: ImportTemplateReadinessPreviewResponse | null;
}

function useBackendReadiness({
  templateId,
  templateName,
  columns,
  rules,
  columnId,
  debounceMs = 400,
}: UseBackendReadinessParams): BackendReadinessSnapshot {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<
    ImportTemplateReadinessPreviewResponse | null
  >(null);

  // Stable hash of the inputs that drive the request body. JSON
  // serialisation is sufficient — the inspector's columns/rules
  // arrays are JSONB-shaped state already, so stringify is cheap
  // (linear in template size, no cycles, no functions).
  const payloadKey = useMemo(() => {
    try {
      return JSON.stringify({
        tid: templateId,
        tname: templateName,
        columns,
        rules,
      });
    } catch {
      // Defensive — if a future column shape introduces a circular
      // ref, fall back to a non-stable key so the effect doesn't
      // wedge silently. The next render produces a different random
      // key and re-fires.
      return `unhashable-${Math.random()}`;
    }
  }, [templateId, templateName, columns, rules]);

  // Race protection: every fetch increments this counter and writes
  // the value at request-start; on response, we only commit state
  // when our counter still matches the current request id. This is
  // belt-and-suspenders alongside AbortController — covers the
  // narrow race where a response slips through after cancel.
  const requestIdRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const myRequestId = ++requestIdRef.current;
    let timer: ReturnType<typeof setTimeout> | null = null;

    timer = setTimeout(async () => {
      setLoading(true);
      try {
        const result = await invoiceTemplatesApi.previewReadiness(
          {
            template_id: templateId,
            template_name: templateName,
            columns: columns as unknown[],
            rules: rules as unknown[],
          },
          { signal: controller.signal },
        );
        if (myRequestId !== requestIdRef.current) return;
        setResponse(result);
        setError(null);
      } catch (err) {
        // Aborts are expected on rapid input — don't surface them
        // as user-facing errors.
        if (controller.signal.aborted) return;
        if (myRequestId !== requestIdRef.current) return;
        setError(getApiErrorMessage(err, "Backend readiness check failed."));
      } finally {
        if (myRequestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    }, debounceMs);

    return () => {
      if (timer != null) clearTimeout(timer);
      controller.abort();
    };
  }, [payloadKey, debounceMs, templateId, templateName, columns, rules]);

  const columnReadiness = useMemo<BackendColumnReadiness | null>(() => {
    if (!response) return null;
    return (
      response.columns.find((col) => col.column_id === columnId) ?? null
    );
  }, [response, columnId]);

  return { loading, error, columnReadiness, response };
}

/**
 * Map a backend ReadinessStatus ("ready"|"warning"|"blocked") to
 * the wizard's local 3-tier vocabulary ("ok"|"warning"|"error").
 * Unknown future literals default to "warning" — visible enough that
 * the operator notices, conservative enough that we don't promote
 * mystery values to a green pass.
 */
function backendStatusToLocal(status: BackendReadinessStatus): ReadinessStatus {
  if (status === "ready") return "ok";
  if (status === "blocked") return "error";
  return "warning";
}

/**
 * Map a backend item's ``fix_step`` (number | "advanced" | null) to
 * the wizard's per-step jump indices (1..4 only — Step 5 is the
 * readiness page itself, "advanced" doesn't carry a numeric jump).
 */
function backendFixStep(
  fixStep: number | string | null | undefined,
): 1 | 2 | 3 | 4 | undefined {
  if (typeof fixStep !== "number") return undefined;
  if (fixStep === 1 || fixStep === 2 || fixStep === 3 || fixStep === 4) {
    return fixStep;
  }
  return undefined;
}

/**
 * Map backend categories to the wizard's three local categories.
 * "advanced" and "validation" fall back to "structure" so the
 * wizard's Step-5 grouping stays readable; the backend item still
 * carries its own ``code`` + ``message`` so no information is lost.
 */
function backendCategoryToLocal(category: string): ReadinessCategory {
  if (
    category === "structure"
    || category === "value_source"
    || category === "rule_runtime"
  ) {
    return category;
  }
  // "advanced" / "validation" / future literals → bucket as
  // "structure" so the readiness checklist still groups them under a
  // known section header.
  return "structure";
}

/**
 * Adapter — backend ReadinessItem[] → wizard-local ReadinessItem[].
 *
 * The wizard's existing ReadinessChecklist + statusForStep helpers
 * iterate the local shape; instead of forking those for backend
 * data, we adapt the backend items into local shape and reuse the
 * existing rendering machinery untouched. Information loss is
 * minimal: ``recommendation`` and ``code`` collapse into the
 * ``detail`` field; per-cell pointers (rule_id / cell_key / path)
 * are dropped because the wizard doesn't render them today.
 */
function backendItemsToLocal(
  items: BackendReadinessItem[],
): ReadinessItem[] {
  return items.map((item) => {
    const localStatus = backendStatusToLocal(item.status);
    // Compose detail from backend detail + recommendation + code so
    // the operator sees the full backend context without us adding
    // new render branches to the existing ReadinessChecklist.
    const detailParts: string[] = [];
    if (item.detail) detailParts.push(item.detail);
    if (item.recommendation && item.recommendation !== item.detail) {
      detailParts.push(item.recommendation);
    }
    return {
      status: localStatus,
      category: backendCategoryToLocal(item.category),
      label: item.message,
      detail: detailParts.length > 0 ? detailParts.join(" — ") : undefined,
      fixStep: backendFixStep(item.fix_step),
    };
  });
}

/**
 * Adapter — backend ColumnReadiness → wizard-local
 * ValueSourcePicture. Lets the existing ResolverExpectationCard
 * render backend verdicts without an alternative code path.
 *
 * Stat-card derivation: the card shows three tiles (Default source /
 * Rule FILL path / Needs runtime input). The backend's response
 * doesn't return per-rule fill records, so we infer the
 * unconditional / conditional flags from the backend item codes the
 * Phase 1C service emits (READINESS_UNCONDITIONAL_FILL,
 * READINESS_CONDITIONAL_FILL_ONLY, READINESS_CONDITIONAL_FILL_OVERRIDE).
 * Approximate but truthful — the operator never sees a green tile
 * when the backend says the column lacks the corresponding path.
 */
function backendToValueSourcePicture(
  column: BackendColumnReadiness,
): ValueSourcePicture {
  const hasUnconditionalFill = column.items.some(
    (item) => item.code === "READINESS_UNCONDITIONAL_FILL",
  );
  const hasConditionalFill = column.items.some(
    (item) =>
      item.code === "READINESS_CONDITIONAL_FILL_ONLY"
      || item.code === "READINESS_CONDITIONAL_FILL_OVERRIDE",
  );
  // Narrow the backend's widened ResolverExpectation (which carries a
  // `string & {}` arm for forward-compat) into the wizard's strict
  // union. Unknown future literals fall back to "may_be_missing" so
  // the operator gets a yellow card rather than a crash.
  const KNOWN_EXPECTATIONS = new Set([
    "should_resolve",
    "may_be_missing",
    "will_be_missing",
  ]);
  const expectation: ValueSourcePicture["expectation"] =
    KNOWN_EXPECTATIONS.has(column.expectation as string)
      ? (column.expectation as ValueSourcePicture["expectation"])
      : "may_be_missing";
  return {
    globalVerdict: {
      status: backendStatusToLocal(column.value_source.status),
      label: column.value_source.label,
      detail: column.value_source.detail ?? undefined,
      conditional: Boolean(column.value_source.conditional),
    },
    // Backend doesn't expose per-rule fill records. Empty list is
    // safe — the existing card logic only consults this for the
    // gating-hint string in non-backend mode.
    ruleFills: [],
    hasUnconditionalFill,
    hasConditionalFill,
    expectation,
    expectationLabel: column.expectation_label,
    expectationDetail: column.expectation_detail,
  };
}

/**
 * Provenance banner rendered above the ResolverExpectationCard on
 * Step 5. Tells the operator whether the verdicts they're looking at
 * came from the canonical backend readiness preview or the local
 * heuristic fallback, plus an explicit reminder that the readiness
 * preview honors local edits while Dry Run still uses the saved
 * template.
 */
function BackendReadinessBanner({
  loading,
  error,
  hasResponse,
  dirty,
  isDraft,
}: {
  loading: boolean;
  error: string | null;
  hasResponse: boolean;
  dirty: boolean;
  isDraft: boolean;
}) {
  if (loading) {
    return (
      <StepWarning tone="info" title="Checking backend readiness…">
        Asking the backend to evaluate your local edits. The local
        estimate below stays visible while we wait.
      </StepWarning>
    );
  }
  if (error) {
    return (
      <StepWarning
        tone="warning"
        title="Backend readiness check failed"
      >
        {error} Showing local estimate instead.
      </StepWarning>
    );
  }
  if (hasResponse) {
    const localEditsHint = isDraft
      ? "Includes your draft edits — Dry Run only sees the saved template once you save."
      : dirty
        ? "Includes your unsaved edits — Dry Run still uses the LAST SAVED template until you save."
        : "Reflects the saved template.";
    return (
      <StepWarning tone="info" title="Backend verified">
        Readiness above was computed by the canonical backend readiness
        engine. {localEditsHint}
      </StepWarning>
    );
  }
  // Initial render before debounce fires — render nothing; the local
  // estimate carries the wizard until the first response arrives.
  return null;
}
