"use client";

import {
  AlertTriangle,
  EyeOff,
  Loader2,
  MapPin,
  Plus,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";

import { cn } from "@/lib/utils";
import {
  type PatternFieldsCacheEntry,
  useInvoicePatternFieldOptionsCache,
  useInvoicePatternSummaries,
} from "@/features/invoice-builder/hooks/useInvoicePatterns";
import {
  emptyExtractionBinding,
  extractionBindingIsComplete,
  type RuleCellExtractionBinding,
} from "@/types/invoice-template";
import {
  INVOICE_EXTRACTED_FIELDS,
  INVOICE_EXTRACTED_FIELD_LABEL,
  type InvoicePatternFieldOption,
  isKnownExtractedFieldKey,
  normalizeExtractedFieldKey,
  resolveExtractedFieldDescriptor,
} from "@/types/invoice-pattern";

/**
 * Per-rule-cell extraction-context narrowing for `invoice_field`
 * columns — the Phase 2 multi-binding evolution of the original
 * single-binding picker.
 *
 * THIS IS THE INVOICE BUILDER ↔ IMPORT BUILDER INTEGRATION POINT.
 *
 * What changed vs. Phase 1:
 *
 *   * One rule cell can now carry MULTIPLE (pattern, field) bindings
 *     instead of one. Same column ("Invoice Number") can resolve from
 *     EPB 2 → invoice_number, HWEA → account_number, CDE Lightband
 *     → invoice_number — one cell, three bindings.
 *   * The field dropdown is PATTERN-SPECIFIC: each binding's field
 *     options come from the bound pattern's `field_definitions`
 *     (canonical built-ins minus the operator's hide overrides, plus
 *     custom fields), fetched via the lightweight per-pattern field
 *     endpoint. Falls back to the canonical 21-field list while the
 *     fields fetch is in flight or when the pattern itself isn't
 *     resolvable (deleted post-binding).
 *   * No literal-text chip input — invoice_field cells are entirely
 *     about pattern→field bindings now. The previous chip input
 *     (`MultiTagInput`) on top of the picker has been removed in
 *     `RuleCellEditor.tsx`.
 *   * Empty bindings list = "broad universe" — fully valid, no warning.
 *     The column's global extraction behavior wins (broad-universe +
 *     OCR + AI inference). Rules NARROW; they don't gate.
 *
 * UX invariants — kept tight so the picker still fits inside one rule
 * cell at narrow widths:
 *
 *   * Compact rows expand vertically as bindings are added; horizontal
 *     selects truncate-with-tooltip rather than overflow.
 *   * State badge at top (Broad universe / Narrowed / Partial / Issue)
 *     so the cell's status is legible at a glance even when the
 *     pickers themselves are too narrow to read.
 *   * Pattern-deleted bindings render with an amber "(deleted)"
 *     affordance via the cached `pattern_label` so the operator can
 *     clear them without losing what was there.
 *   * Hidden-field bindings (the operator hid the field from the
 *     pattern post-binding) render with an EyeOff icon and a warning
 *     tooltip — kept editable so the operator can re-pick or clear.
 *
 * Why not react-query for the field cache: the rest of the codebase
 * uses plain useState/useEffect lazy caches for similar lookup flows
 * (see `useCatalogIndex`); the cache lives in
 * `useInvoicePatternFieldOptionsCache` and dedupes by pattern_id so
 * many bindings to the same pattern pay one HTTP round-trip.
 */
interface InvoiceExtractionPickerProps {
  bindings: RuleCellExtractionBinding[];
  onChange: (next: RuleCellExtractionBinding[]) => void;
  /**
   * The default canonical field for the column (read from the column's
   * `source_ref.field` when set). Used as the field dropdown's
   * placeholder copy on a fresh binding row so the operator sees what
   * the column would extract by default. Optional / nullable; renders
   * generic "(default for column)" copy when missing.
   */
  defaultFieldKey?: string | null;
  disabled?: boolean;
}

const BROAD_UNIVERSE_VALUE = "__broad_universe__";

export function InvoiceExtractionPicker({
  bindings,
  onChange,
  defaultFieldKey,
  disabled,
}: InvoiceExtractionPickerProps) {
  const {
    items: patterns,
    loading: loadingPatterns,
    error: patternsError,
  } = useInvoicePatternSummaries();
  const fieldsCache = useInvoicePatternFieldOptionsCache();

  // Eagerly fetch field options for every bound pattern. The cache
  // dedupes by id, so this stays cheap when many bindings point at
  // the same pattern.
  const ensureFields = fieldsCache.ensure;
  useEffect(() => {
    for (const b of bindings) {
      if (b.pattern_id) {
        void ensureFields(b.pattern_id);
      }
    }
  }, [bindings, ensureFields]);

  // ---- Derived state for the header badge ------------------------------

  // "Has at least one fully-pinned binding" → narrowed.
  // "Has any in-progress binding (pattern but no field, or vice
  // versa)" → partial.
  // "Empty list" → broad universe.
  const completeCount = bindings.filter(extractionBindingIsComplete).length;
  const partialCount = bindings.length - completeCount;
  const isEmpty = bindings.length === 0;
  const isNarrowed = completeCount > 0 && partialCount === 0;
  const isPartial = partialCount > 0;

  // ---- Mutators --------------------------------------------------------

  const handleAddBinding = useCallback(() => {
    if (disabled) return;
    onChange([...bindings, emptyExtractionBinding()]);
  }, [bindings, disabled, onChange]);

  const handleRemoveBinding = useCallback(
    (idx: number) => {
      if (disabled) return;
      const next = bindings.slice();
      next.splice(idx, 1);
      onChange(next);
    },
    [bindings, disabled, onChange],
  );

  const handleUpdateBinding = useCallback(
    (idx: number, updates: Partial<RuleCellExtractionBinding>) => {
      if (disabled) return;
      const next = bindings.slice();
      const current = next[idx];
      if (!current) return;
      next[idx] = { ...current, ...updates };
      onChange(next);
    },
    [bindings, disabled, onChange],
  );

  // ---- Render ----------------------------------------------------------

  return (
    <div
      className={cn(
        "rounded-md border px-1.5 py-1 transition-colors",
        isNarrowed
          ? "border-brand-200 bg-brand-50/40 dark:border-brand-500/40 dark:bg-brand-900/20"
          : isPartial
            ? "border-amber-200 bg-amber-50/40 dark:border-yellow-900 dark:bg-yellow-950/30"
            : "border-gray-200 bg-gray-50/60 dark:border-line dark:bg-surface-muted/60",
      )}
    >
      {/* Header bar — state badge + spinner. Compact so narrow cells
          don't push the binding rows out of view. */}
      <div className="flex items-center gap-1.5 mb-1 min-w-0">
        {isNarrowed ? (
          <Wand2 className="h-3 w-3 text-brand-600 dark:text-brand-50 shrink-0" />
        ) : isPartial ? (
          <AlertTriangle className="h-3 w-3 text-amber-600 dark:text-yellow-400 shrink-0" />
        ) : (
          <Sparkles className="h-3 w-3 text-gray-400 dark:text-ink-subtle shrink-0" />
        )}
        <span
          className={cn(
            "text-[10px] font-semibold uppercase tracking-wide truncate",
            isNarrowed
              ? "text-brand-700 dark:text-brand-50"
              : isPartial
                ? "text-amber-700 dark:text-yellow-200"
                : "text-gray-500 dark:text-ink-muted",
          )}
        >
          {isEmpty
            ? "Broad universe"
            : isNarrowed
              ? `Narrowed · ${completeCount} ${
                  completeCount === 1 ? "binding" : "bindings"
                }`
              : `Pick fields to finish · ${partialCount} pending`}
        </span>
        {loadingPatterns && (
          <Loader2
            className="h-3 w-3 animate-spin text-gray-400 dark:text-ink-subtle shrink-0"
            aria-label="Loading patterns"
          />
        )}
      </div>

      {/* Binding rows — empty list shows the broad-universe explainer
          instead so the cell isn't a confusing blank. */}
      {isEmpty ? (
        <p className="text-[10.5px] italic text-gray-500 dark:text-ink-muted leading-snug px-0.5">
          No bindings — this cell uses the column&apos;s global extraction
          behavior across all saved patterns.
        </p>
      ) : (
        <div className="space-y-1">
          {bindings.map((binding, idx) => (
            <BindingRow
              key={idx}
              binding={binding}
              patterns={patterns}
              loadingPatterns={loadingPatterns}
              fieldsEntry={
                binding.pattern_id
                  ? fieldsCache.get(binding.pattern_id)
                  : null
              }
              defaultFieldKey={defaultFieldKey}
              disabled={disabled}
              onUpdate={(updates) => handleUpdateBinding(idx, updates)}
              onRemove={() => handleRemoveBinding(idx)}
            />
          ))}
        </div>
      )}

      {/* "+ Add binding" button. Always available (even when disabled,
          we render it greyed for visual continuity). */}
      <div className="mt-1 flex items-center justify-between gap-1">
        <button
          type="button"
          onClick={handleAddBinding}
          disabled={disabled}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium",
            "border border-dashed border-gray-300 bg-white text-gray-600",
            "dark:border-line dark:bg-surface-subtle dark:text-ink-muted",
            "hover:bg-gray-50 hover:text-gray-800 hover:border-gray-400",
            "dark:hover:bg-surface-muted dark:hover:text-ink dark:hover:border-line-strong",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-500",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title="Add another pattern → field binding for this cell"
        >
          <Plus className="h-2.5 w-2.5" />
          Add template binding
        </button>
        {patternsError && (
          <span
            className="text-[10px] text-red-600 dark:text-red-400 truncate"
            title={patternsError}
          >
            Patterns unavailable
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One binding row — pattern + field selects + remove button
// ---------------------------------------------------------------------------

interface BindingRowProps {
  binding: RuleCellExtractionBinding;
  patterns: ReturnType<typeof useInvoicePatternSummaries>["items"];
  loadingPatterns: boolean;
  fieldsEntry: PatternFieldsCacheEntry | null;
  defaultFieldKey?: string | null;
  disabled?: boolean;
  onUpdate: (updates: Partial<RuleCellExtractionBinding>) => void;
  onRemove: () => void;
}

function BindingRow({
  binding,
  patterns,
  loadingPatterns,
  fieldsEntry,
  defaultFieldKey,
  disabled,
  onUpdate,
  onRemove,
}: BindingRowProps) {
  const currentPatternId = binding.pattern_id ?? null;
  const currentFieldKey = binding.field_key ?? null;
  const normalizedCurrentFieldKey = useMemo(
    () => (currentFieldKey ? normalizeExtractedFieldKey(currentFieldKey) : null),
    [currentFieldKey],
  );

  // Resolve the live label for the bound pattern; fall back to the
  // cached label when the pattern was deleted post-binding so the
  // operator gets a "(deleted)" diagnostic instead of a blank.
  const livePattern = useMemo(() => {
    if (!currentPatternId) return null;
    return patterns.find((p) => p.id === currentPatternId) ?? null;
  }, [currentPatternId, patterns]);
  const isMissingPattern =
    currentPatternId != null && !loadingPatterns && livePattern == null;

  // ---- Field-options derivation --------------------------------------
  // Prefer the per-pattern fetch (which folds the operator's overrides
  // and adds custom fields); fall back to the canonical 21-field list
  // for the loading state and for missing patterns (the cache will
  // never deliver a "ready" entry for a deleted pattern).
  //
  // We also track whether the currently-bound field still exists in
  // the pattern's option list. If not (operator hid it OR custom field
  // was removed), surface a warning chip but keep the binding editable
  // so the operator can clear / re-pick.
  const fieldsLoading = fieldsEntry?.status === "loading";
  const fieldsError =
    fieldsEntry?.status === "error" ? fieldsEntry.error : null;
  const fieldOptions: InvoicePatternFieldOption[] = useMemo(() => {
    if (fieldsEntry?.status === "ready") {
      return fieldsEntry.items;
    }
    // Fallback: the canonical built-ins as ad-hoc options. Lets the
    // operator finish a pick even if the per-pattern fetch hasn't
    // landed (e.g. broken network) — extra safety net so the UI
    // doesn't deadlock waiting for a fetch. Reverse-usage fields
    // (`region_count` / `region_pages`) are zeroed out here — without
    // the per-pattern fetch we don't know which fields have regions,
    // and a "(0 regions)" warning would be misleading. The picker
    // suppresses the warning chip when the fetch hasn't resolved.
    return INVOICE_EXTRACTED_FIELDS.map((key) => ({
      key,
      label: INVOICE_EXTRACTED_FIELD_LABEL[key],
      type: "built_in" as const,
      color: null,
      hidden: false,
      region_count: 0,
      region_pages: [],
    }));
  }, [fieldsEntry]);

  // Filter rule for the dropdown:
  //   * always include non-hidden fields
  //   * always include the CURRENTLY-bound field even when hidden, so
  //     the operator sees what's there (with a warning chip)
  //   * always include any field where the bound key matches even if
  //     it's no longer in the pattern's option list (we synthesize a
  //     "(unknown field)" row in the dropdown)
  const visibleOptions = useMemo(() => {
    return fieldOptions.filter(
      (o) =>
        !o.hidden ||
        o.key === currentFieldKey ||
        o.key === normalizedCurrentFieldKey,
    );
  }, [fieldOptions, currentFieldKey, normalizedCurrentFieldKey]);
  const boundOption = useMemo(
    () =>
      currentFieldKey
        ? fieldOptions.find((o) => o.key === currentFieldKey) ??
          (normalizedCurrentFieldKey
            ? fieldOptions.find((o) => o.key === normalizedCurrentFieldKey) ??
              null
            : null)
        : null,
    [currentFieldKey, fieldOptions, normalizedCurrentFieldKey],
  );
  const isFieldUnknown =
    currentFieldKey != null &&
    !boundOption &&
    fieldsEntry?.status === "ready";
  const isFieldHidden = boundOption?.hidden === true;
  // Soft warning — the binding still works (extraction falls through
  // to broad-universe) but the operator almost certainly meant to draw
  // a region first. We only surface this once the per-pattern fetch is
  // ready; the canonical-fields fallback list zeroes `region_count`,
  // which would falsely flag every field while loading.
  const isFieldNoRegions =
    boundOption != null &&
    fieldsEntry?.status === "ready" &&
    boundOption.region_count === 0;

  // Default-field placeholder copy. Read the column's bound field key
  // when caller passed it; falls back to a generic label.
  const defaultFieldLabel = useMemo(() => {
    if (!defaultFieldKey) return "(default for column)";
    const descriptor = resolveExtractedFieldDescriptor(defaultFieldKey);
    if (descriptor) return descriptor.label;
    return defaultFieldKey;
  }, [defaultFieldKey]);

  // ---- Handlers --------------------------------------------------------

  const handlePatternChange = (raw: string) => {
    if (raw === BROAD_UNIVERSE_VALUE) {
      // Clearing the pattern wipes the binding (pattern + label) but
      // PRESERVES the operator's field pick — they may swap to another
      // pattern that has the same canonical field key, no need to
      // re-pick. Field gets cleared if a new pattern is chosen below
      // and the key is unknown there.
      onUpdate({
        pattern_id: null,
        pattern_label: null,
      });
      return;
    }
    const summary = patterns.find((p) => p.id === raw);
    onUpdate({
      pattern_id: raw,
      pattern_label: summary?.name ?? null,
      // Auto-fill the field if the operator hasn't picked one and the
      // column has a default. Otherwise leave the existing field key
      // so a pattern swap doesn't mid-air a half-finished binding.
      field_key:
        currentFieldKey ??
        (defaultFieldKey && isCanonicalField(defaultFieldKey)
          ? normalizeExtractedFieldKey(defaultFieldKey)
          : null),
    });
  };

  const handleFieldChange = (raw: string) => {
    if (!currentPatternId) return;
    if (raw === "") {
      onUpdate({ field_key: null, field_label: null });
      return;
    }
    const opt = fieldOptions.find((o) => o.key === raw);
    onUpdate({
      field_key: raw,
      field_label: opt?.label ?? null,
    });
  };

  // ---- Render ----------------------------------------------------------

  // Sub-row warnings collapsed into a single tone class for the field
  // dropdown so the operator's eye lands on the problem cell. Order of
  // priority: unknown (red, hard error) > hidden (amber, fixable) >
  // no-regions (amber, soft hint) > default neutral.
  const fieldDropdownTone = isFieldUnknown
    ? "border-red-300 text-red-700 dark:border-red-900 dark:text-red-300"
    : isFieldHidden
      ? "border-amber-300 text-amber-800 dark:border-yellow-900 dark:text-yellow-200"
      : isFieldNoRegions
        ? "border-amber-300 text-amber-800 dark:border-yellow-900 dark:text-yellow-200"
        : "border-gray-300 text-gray-800 dark:border-line dark:text-ink";

  return (
    <div className="flex items-start gap-1 min-w-0">
      <div className="grid grid-cols-2 gap-1 flex-1 min-w-0">
        {/* Pattern dropdown */}
        <select
          value={currentPatternId ?? BROAD_UNIVERSE_VALUE}
          onChange={(e) => handlePatternChange(e.target.value)}
          disabled={disabled || loadingPatterns}
          className={cn(
            "min-w-0 truncate rounded-sm border bg-white px-1 py-0.5 text-[11px] dark:bg-surface",
            "focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-gray-50",
            isMissingPattern
              ? "border-red-300 text-red-700 dark:border-red-900 dark:text-red-300"
              : "border-gray-300 text-gray-800 dark:border-line dark:text-ink",
          )}
          title={
            isMissingPattern
              ? `Pattern (deleted) — ${
                  binding.pattern_label ?? "id " + currentPatternId
                }`
              : livePattern?.name ?? "Pattern to extract from"
          }
        >
          <option value={BROAD_UNIVERSE_VALUE}>(pick a pattern)</option>
          {patterns.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.region_count > 0 ? ` · ${p.region_count}` : ""}
            </option>
          ))}
          {isMissingPattern && (
            <option value={currentPatternId ?? ""} disabled>
              (deleted) {binding.pattern_label ?? currentPatternId}
            </option>
          )}
        </select>

        {/* Field dropdown — pattern-specific options, with hidden /
            unknown surfaced inline. */}
        <div className="relative flex items-center gap-0.5 min-w-0">
          <select
            value={boundOption?.key ?? currentFieldKey ?? ""}
            onChange={(e) => handleFieldChange(e.target.value)}
            disabled={disabled || fieldsLoading || !currentPatternId}
            className={cn(
              "min-w-0 flex-1 truncate rounded-sm border bg-white px-1 py-0.5 text-[11px] dark:bg-surface",
              "focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-gray-50",
              fieldDropdownTone,
            )}
            title={
              isFieldUnknown
                ? `Field "${currentFieldKey}" is no longer defined on this pattern.`
                : isFieldHidden
                  ? `Field "${boundOption?.label ?? currentFieldKey}" is hidden on this pattern but the cell is still bound to it.`
                  : isFieldNoRegions
                    ? `Field "${boundOption?.label ?? currentFieldKey}" has no regions on this pattern. Extraction will fall through to broad-universe — open the Invoice Builder and draw a region to wire it up.`
                    : currentPatternId
                      ? boundOption && boundOption.region_count > 0
                        ? `${boundOption.label} · ${boundOption.region_count} region${boundOption.region_count === 1 ? "" : "s"}${boundOption.region_pages.length > 0 ? ` on p. ${boundOption.region_pages.join(", ")}` : ""}`
                        : "Field within the bound pattern"
                      : "Pick a pattern first"
            }
          >
            <option value="">{defaultFieldLabel}</option>
            {visibleOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
                {opt.type === "custom" ? " (custom)" : ""}
                {opt.hidden ? " (hidden)" : ""}
                {/* Suffix the region count so the operator can see at a
                    glance which field has training material on this
                    pattern. "(no region)" is the soft warning case —
                    the binding still resolves via broad-universe but
                    the operator probably wants to draw something. */}
                {opt.region_count > 0
                  ? ` · ${opt.region_count} region${opt.region_count === 1 ? "" : "s"}`
                  : " · (no region)"}
              </option>
            ))}
            {isFieldUnknown && currentFieldKey && (
              <option value={currentFieldKey} disabled>
                (unknown) {binding.field_label ?? currentFieldKey}
              </option>
            )}
          </select>
          {fieldsLoading && (
            <Loader2
              className="h-3 w-3 shrink-0 animate-spin text-gray-400"
              aria-label="Loading fields"
            />
          )}
          {!fieldsLoading && isFieldHidden && (
            <EyeOff
              className="h-3 w-3 shrink-0 text-amber-600 dark:text-yellow-400"
              aria-label="Field is hidden on this pattern"
            />
          )}
          {!fieldsLoading && isFieldUnknown && (
            <AlertTriangle
              className="h-3 w-3 shrink-0 text-red-600 dark:text-red-400"
              aria-label="Field is no longer defined on this pattern"
            />
          )}
          {!fieldsLoading &&
            !isFieldUnknown &&
            !isFieldHidden &&
            isFieldNoRegions && (
              <MapPin
                className="h-3 w-3 shrink-0 text-amber-600 dark:text-yellow-400"
                aria-label="Field has no regions on this pattern"
              />
            )}
        </div>
      </div>

      {/* Remove this binding row */}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove this binding"
        title="Remove this binding"
        className={cn(
          "shrink-0 rounded-sm p-0.5 text-gray-400 dark:text-ink-subtle",
          "hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <X className="h-3 w-3" />
      </button>

      {fieldsError && (
        <span
          className="text-[10px] text-red-600 truncate ml-1"
          title={fieldsError}
        >
          fields err
        </span>
      )}
    </div>
  );
}

function isCanonicalField(key: string): boolean {
  return isKnownExtractedFieldKey(key);
}
