"use client";

import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";
import {
  colorForFieldKey,
  FIELD_COLOR_PALETTE,
  type InvoiceExtractedFieldDescriptor,
  type InvoicePatternFieldDefinition,
  isValidFieldColor,
  MAX_PATTERN_FIELD_DEFINITIONS,
  MAX_PATTERN_FIELD_LABEL_LENGTH,
  resolveFieldList,
  uniqueCustomFieldKey,
} from "@/types/invoice-pattern";

/**
 * "Manage fields" modal.
 *
 * Lets the operator:
 *
 *   * Add custom extraction fields (e.g. "Service Address") that
 *     don't exist on the canonical `Invoice` model. Each gets a
 *     stable slug-shaped key derived from the label, and a default
 *     palette color.
 *   * Override the color or hide a built-in canonical field for this
 *     pattern (each canonical field still ships from the API; the
 *     override layer only carries deltas).
 *   * Delete a custom field — blocked when in use, with a count
 *     ("This field is used by N regions") telling the operator
 *     which regions to reassign first.
 *   * Pick a color from a curated 12-color palette.
 *
 * Emits the FULL `field_definitions` array via `onChange` whenever
 * anything changes. Storage strategy: built-ins only land in
 * `field_definitions` when the operator actually customised them
 * (color, label, or hidden) — keeps the JSONB payload minimal.
 */
interface ManageFieldsModalProps {
  open: boolean;
  onClose: () => void;
  /** Canonical extracted-field descriptors from the API (label fallback). */
  canonicalFields: readonly InvoiceExtractedFieldDescriptor[];
  /** Current field definitions on the pattern. */
  fieldDefinitions: InvoicePatternFieldDefinition[];
  /** Region counts per field key — drives the "in use" warning. */
  regionUsageByKey: Record<string, number>;
  /** Emit the full new field_definitions array. */
  onChange: (next: InvoicePatternFieldDefinition[]) => void;
  disabled?: boolean;
}

export function ManageFieldsModal({
  open,
  onClose,
  canonicalFields,
  fieldDefinitions,
  regionUsageByKey,
  onChange,
  disabled,
}: ManageFieldsModalProps) {
  const [newLabel, setNewLabel] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  // Resolved list — what the operator actually sees. Includes built-ins
  // (with override-applied colors / labels / hidden) and customs.
  const resolved = useMemo(
    () => resolveFieldList(canonicalFields, fieldDefinitions),
    [canonicalFields, fieldDefinitions],
  );

  // Index of overrides + customs by key for fast lookup.
  const defByKey = useMemo(() => {
    const m = new Map<string, InvoicePatternFieldDefinition>();
    for (const d of fieldDefinitions) m.set(d.key, d);
    return m;
  }, [fieldDefinitions]);

  // ---- Mutators emit the FULL next array via onChange ----------------

  /**
   * Apply a partial change to a single field's def. Built-ins lazily
   * materialize a def row when the override is non-default; customs
   * always have a def. Setting all overrides back to defaults removes
   * the built-in def from storage so the JSONB stays minimal.
   */
  const updateBuiltInOverride = useCallback(
    (
      key: string,
      patch: Partial<Pick<InvoicePatternFieldDefinition, "color" | "hidden">>,
    ) => {
      const cf = canonicalFields.find((c) => c.key === key);
      if (!cf) return; // not canonical → fall through to updateCustom
      const existing = defByKey.get(key);
      const merged: InvoicePatternFieldDefinition = {
        key,
        label: existing?.label || cf.label,
        type: "built_in",
        color: existing?.color ?? null,
        hidden: existing?.hidden ?? false,
        ...patch,
      };
      // If everything's default, drop the def to keep storage clean.
      const isDefault =
        merged.color == null && merged.hidden !== true;
      const next = fieldDefinitions.filter((d) => d.key !== key);
      if (!isDefault) next.push(merged);
      onChange(next);
    },
    [canonicalFields, defByKey, fieldDefinitions, onChange],
  );

  const updateCustom = useCallback(
    (
      key: string,
      patch: Partial<
        Pick<InvoicePatternFieldDefinition, "label" | "color">
      >,
    ) => {
      const next = fieldDefinitions.map((d) =>
        d.key === key && d.type === "custom" ? { ...d, ...patch } : d,
      );
      onChange(next);
    },
    [fieldDefinitions, onChange],
  );

  const addCustom = useCallback(() => {
    setAddError(null);
    const label = newLabel.trim();
    if (!label) {
      setAddError("Label can't be empty.");
      return;
    }
    if (fieldDefinitions.length >= MAX_PATTERN_FIELD_DEFINITIONS) {
      setAddError(
        `Reached the ${MAX_PATTERN_FIELD_DEFINITIONS}-field cap. Delete an unused field first.`,
      );
      return;
    }
    const existingKeys = [
      ...canonicalFields.map((c) => c.key),
      ...fieldDefinitions.map((d) => d.key),
    ];
    const key = uniqueCustomFieldKey(label, existingKeys);
    const created: InvoicePatternFieldDefinition = {
      key,
      label: label.slice(0, MAX_PATTERN_FIELD_LABEL_LENGTH),
      type: "custom",
      color: colorForFieldKey(key),
      hidden: false,
    };
    onChange([...fieldDefinitions, created]);
    setNewLabel("");
  }, [
    canonicalFields,
    fieldDefinitions,
    newLabel,
    onChange,
  ]);

  const deleteCustom = useCallback(
    (key: string) => {
      // Block deletion when regions reference this field. Per spec:
      // minimum acceptable MVP shows the message and bails.
      const usage = regionUsageByKey[key] ?? 0;
      if (usage > 0) {
        setAddError(
          `"${key}" is used by ${usage} region${usage === 1 ? "" : "s"}. ` +
            `Reassign or delete those regions first.`,
        );
        return;
      }
      onChange(fieldDefinitions.filter((d) => d.key !== key));
    },
    [fieldDefinitions, onChange, regionUsageByKey],
  );

  // ---- Render --------------------------------------------------------

  return (
    <Modal open={open} onClose={onClose} title="Manage extraction fields" size="xl">
      <div className="space-y-3">
        <p className="text-[12px] text-gray-600 dark:text-ink-muted">
          Built-in fields come from the canonical invoice model — you
          can hide ones you don&apos;t use or change their color. Add
          custom fields (e.g. &ldquo;Service Address&rdquo;) for
          anything not on the canonical list.
        </p>

        {/* ---- Add custom field row -------------------------------- */}
        <div className="flex items-end gap-2 p-2 rounded-md bg-gray-50 border border-gray-200 dark:bg-surface-muted dark:border-line">
          <label className="flex-1 min-w-0 block">
            <span className="text-[10.5px] font-semibold text-gray-700 uppercase tracking-wide dark:text-ink-muted">
              New custom field
            </span>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => {
                setNewLabel(e.target.value);
                setAddError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom();
                }
              }}
              placeholder="e.g. Service Address"
              maxLength={MAX_PATTERN_FIELD_LABEL_LENGTH}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-[13px] text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink dark:placeholder:text-ink-subtle"
              disabled={disabled}
            />
          </label>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={addCustom}
            disabled={disabled || !newLabel.trim()}
          >
            <Plus className="h-3.5 w-3.5" />
            Add field
          </Button>
        </div>

        {addError && (
          <InlineAlert tone="error" title="Couldn't update fields">
            {addError}
          </InlineAlert>
        )}

        {/* ---- Field list --------------------------------------- */}
        <div className="border border-gray-200 rounded-md divide-y bg-white max-h-[28rem] overflow-y-auto dark:border-line dark:bg-surface dark:divide-line/60">
          {resolved.map((rf) => {
            const def = defByKey.get(rf.key);
            const usage = regionUsageByKey[rf.key] ?? 0;
            const isBuiltIn = rf.type === "built_in";
            const isCustomized =
              isBuiltIn &&
              (def?.color != null || def?.hidden === true);
            return (
              <div
                key={rf.key}
                className="px-3 py-2 flex items-start gap-3"
              >
                {/* Color swatch + picker */}
                <ColorPickerSwatch
                  value={rf.color}
                  onChange={(hex) => {
                    if (isBuiltIn) {
                      updateBuiltInOverride(rf.key, { color: hex });
                    } else {
                      updateCustom(rf.key, { color: hex });
                    }
                  }}
                  disabled={disabled}
                />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "text-[12.5px] font-semibold",
                        rf.hidden
                          ? "text-gray-400 dark:text-ink-subtle"
                          : "text-gray-800 dark:text-ink",
                      )}
                    >
                      {rf.label}
                    </span>
                    {isBuiltIn ? (
                      <span className="text-[9px] uppercase tracking-wide font-bold text-blue-700 bg-blue-50 border border-blue-200 px-1 rounded dark:bg-blue-950/40 dark:text-blue-200 dark:border-blue-900">
                        Built-in
                      </span>
                    ) : (
                      <span className="text-[9px] uppercase tracking-wide font-bold text-purple-700 bg-purple-50 border border-purple-200 px-1 rounded dark:bg-purple-950/40 dark:text-purple-200 dark:border-purple-900">
                        Custom
                      </span>
                    )}
                    {isCustomized && (
                      <span className="text-[9px] uppercase tracking-wide font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1 rounded dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900">
                        Customized
                      </span>
                    )}
                  </div>
                  <div className="text-[10.5px] text-gray-500 font-mono mt-0.5 dark:text-ink-subtle">
                    {rf.key}
                    {usage > 0 && (
                      <span className="ml-2 text-gray-700 dark:text-ink-muted">
                        · {usage} region{usage === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                </div>

                {/* Hide / show toggle (built-ins only) */}
                {isBuiltIn ? (
                  <button
                    type="button"
                    onClick={() =>
                      updateBuiltInOverride(rf.key, {
                        hidden: !rf.hidden,
                      })
                    }
                    className={cn(
                      "px-1.5 py-0.5 rounded border text-[11px] inline-flex items-center gap-1",
                      rf.hidden
                        ? "border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100 dark:border-line dark:bg-surface-muted dark:text-ink-subtle dark:hover:bg-surface"
                        : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-line dark:bg-surface-subtle dark:text-ink-muted dark:hover:bg-surface-muted",
                    )}
                    disabled={disabled}
                    title={
                      rf.hidden
                        ? "Show this built-in field in the Draw-as dropdown"
                        : "Hide this built-in field from the Draw-as dropdown"
                    }
                  >
                    {rf.hidden ? (
                      <>
                        <EyeOff className="h-3 w-3" />
                        Hidden
                      </>
                    ) : (
                      <>
                        <Eye className="h-3 w-3" />
                        Visible
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => deleteCustom(rf.key)}
                    className={cn(
                      "px-1.5 py-0.5 rounded border text-[11px] inline-flex items-center gap-1",
                      usage > 0
                        ? "border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed dark:border-line/60 dark:bg-surface-muted dark:text-ink-subtle"
                        : "border-red-200 bg-white text-red-600 hover:bg-red-50 dark:border-red-900 dark:bg-surface-subtle dark:text-red-400 dark:hover:bg-red-950/40",
                    )}
                    disabled={disabled || usage > 0}
                    title={
                      usage > 0
                        ? `In use by ${usage} region${usage === 1 ? "" : "s"} — reassign first`
                        : "Delete this custom field"
                    }
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </button>
                )}

                {/* Custom-only label edit */}
                {!isBuiltIn && (
                  <input
                    type="text"
                    value={rf.label}
                    onChange={(e) =>
                      updateCustom(rf.key, {
                        label: e.target.value.slice(
                          0,
                          MAX_PATTERN_FIELD_LABEL_LENGTH,
                        ),
                      })
                    }
                    placeholder="Label"
                    className="rounded-sm border border-gray-200 bg-white px-1.5 py-0.5 text-[11.5px] text-gray-800 focus:border-brand-500 focus:outline-none w-32 ml-1 dark:border-line dark:bg-surface dark:text-ink"
                    disabled={disabled}
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100 dark:border-line/60">
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onClose}
          >
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Color picker — palette grid + current swatch
// ---------------------------------------------------------------------------

interface ColorPickerSwatchProps {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
}

function ColorPickerSwatch({
  value,
  onChange,
  disabled,
}: ColorPickerSwatchProps) {
  const [open, setOpen] = useState(false);
  const safeValue = isValidFieldColor(value) ? value : "#9ca3af";
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        className={cn(
          "h-6 w-6 rounded-md border border-gray-300 shadow-sm dark:border-line",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:ring-2 hover:ring-brand-200",
        )}
        style={{ backgroundColor: safeValue }}
        title={`Current color: ${safeValue}. Click to change.`}
        disabled={disabled}
      />
      {open && (
        <>
          {/* Click-outside scrim. */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute z-20 top-full left-0 mt-1 p-1.5 bg-white border border-gray-200 rounded-md shadow-lg grid grid-cols-6 gap-1 dark:bg-surface-subtle dark:border-line">
            {FIELD_COLOR_PALETTE.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => {
                  onChange(hex);
                  setOpen(false);
                }}
                className={cn(
                  "h-5 w-5 rounded-sm border",
                  hex === safeValue
                    ? "border-gray-700 ring-2 ring-brand-200 dark:border-ink dark:ring-brand-500/40"
                    : "border-gray-300 hover:scale-110 transition-transform dark:border-line",
                )}
                style={{ backgroundColor: hex }}
                title={hex}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
