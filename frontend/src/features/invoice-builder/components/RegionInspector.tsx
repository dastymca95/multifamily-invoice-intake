"use client";

import { AlertTriangle, Trash2 } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/Button";
import {
  findResolvedField,
  type InvoicePatternRegion,
  MAX_PATTERN_REGION_LABEL_LENGTH,
  MAX_PATTERN_REGION_NOTES_LENGTH,
  normalizeExtractedFieldKey,
  regionShape,
  type ResolvedField,
  visibleFieldList,
} from "@/types/invoice-pattern";

/**
 * Right-rail inspector for the currently-selected region.
 *
 * Owns three editable fields:
 *   * `field_key`  — which field this region pins. Drives the runtime
 *                    extractor's mapping. Built-in canonical OR
 *                    operator-coined custom; resolution comes from
 *                    `resolvedFields` (passed in from the editor).
 *   * `label`      — optional operator-friendly tag (e.g. "Account #
 *                    — top of page"). Defaults to the resolved field's
 *                    display name when blank.
 *   * `notes`      — operator scratch space.
 *
 * Plus a "Delete region" affordance.
 *
 * Edge cases handled here:
 *
 *   * **Unknown field key** — region was pinned to a custom field that
 *     was later deleted, or a canonical field that was removed from
 *     the model. Renders an amber warning banner naming the orphan
 *     key, plus a "Reassign to…" dropdown that re-binds the region to
 *     a live field on selection.
 *
 *   * **Hidden built-in** — region pinned to a canonical field the
 *     operator hid via Manage Fields. Still selectable in the
 *     dropdown (with a "(hidden)" suffix) so the inspector shows the
 *     real label rather than reading as Unknown.
 *
 * When no region is selected, renders a contextual hint pointing at
 * the document-viewer drag-to-draw flow.
 */
interface RegionInspectorProps {
  region: InvoicePatternRegion | null;
  /**
   * FULL resolved field list (canonical + per-pattern overrides +
   * customs, INCLUDING hidden built-ins). Inspector filters to visible
   * for the dropdown but uses the unfiltered list to resolve labels +
   * colors so a region pinned to a hidden built-in still reads as its
   * proper field name.
   */
  resolvedFields: readonly ResolvedField[];
  /**
   * Region count per field key. Currently informational — surfaces
   * "N regions on this field" so the operator can gauge impact before
   * editing. Comes from `countRegionsByFieldKey(regions)`.
   */
  regionUsageByKey: Record<string, number>;
  disabled?: boolean;
  onChange: (next: InvoicePatternRegion) => void;
  onDelete: () => void;
}

export function RegionInspector({
  region,
  resolvedFields,
  regionUsageByKey,
  disabled,
  onChange,
  onDelete,
}: RegionInspectorProps) {
  // Visible fields are what the operator picks from. Hidden built-ins
  // get folded back in as a single special option below if the
  // current region happens to point at one.
  const visibleFields = useMemo(
    () => visibleFieldList(resolvedFields),
    [resolvedFields],
  );

  // Resolution for the current region's key. `null` ⇒ unknown ⇒
  // amber warning + reassign UI.
  const resolved = useMemo(
    () =>
      region ? findResolvedField(region.field_key, resolvedFields) : null,
    [region, resolvedFields],
  );

  if (!region) {
    return (
      <div className="h-full bg-white border-l border-gray-200 px-4 py-4">
        <h2 className="text-sm font-semibold text-gray-800">Region</h2>
        <p className="text-[11.5px] text-gray-500 mt-2 leading-relaxed">
          No region selected.
          <br />
          Drag on the document to draw a new region, or click an
          existing one in the canvas to edit it here.
        </p>
      </div>
    );
  }

  const isUnknown = resolved == null;
  const isHiddenBuiltin = resolved != null && resolved.hidden;
  const swatchColor = resolved?.color ?? "#6b7280";
  const labelPlaceholder = resolved?.label ?? "Unknown field";
  const normalizedFieldKey =
    normalizeExtractedFieldKey(region.field_key) ?? region.field_key;
  const usageOnThisField =
    regionUsageByKey[region.field_key] ??
    regionUsageByKey[normalizedFieldKey] ??
    0;

  // Build dropdown options. Order:
  //   1. Optional "Unknown — reassign…" disabled placeholder (only
  //      when the current key is orphan; carries the orphan value
  //      so the select renders it as the current selection).
  //   2. Optional hidden built-in entry (only when current key is a
  //      hidden field — so the operator can keep it selected without
  //      it disappearing from the dropdown).
  //   3. All visible fields (canonical + custom).
  const dropdownOptions: {
    key: string;
    label: string;
    disabled?: boolean;
  }[] = [];
  if (isUnknown) {
    dropdownOptions.push({
      key: region.field_key,
      label: `Unknown (${region.field_key}) — reassign…`,
      disabled: true,
    });
  }
  if (
    isHiddenBuiltin &&
    !visibleFields.some((f) => f.key === resolved!.key)
  ) {
    dropdownOptions.push({
      key: resolved!.key,
      label: `${resolved!.label} (hidden)`,
    });
  }
  for (const f of visibleFields) {
    dropdownOptions.push({ key: f.key, label: f.label });
  }

  return (
    <div className="h-full bg-white border-l border-gray-200 px-4 py-4 space-y-3 overflow-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800">Region</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-red-600 hover:bg-red-50"
          onClick={onDelete}
          disabled={disabled}
          title="Delete this region"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>

      {/* Orphan-key warning. Inline (not the InlineAlert component)
          so the layout stays compact in the right rail. */}
      {isUnknown && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-[1px] shrink-0" />
          <p className="text-[11px] text-amber-800 leading-snug">
            This region is pinned to a field that no longer exists.
            Pick a replacement below to keep it useful at extraction
            time.
          </p>
        </div>
      )}

      <Field label="Field">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-4 w-4 rounded-sm border border-black/10 shrink-0"
            style={{ backgroundColor: swatchColor }}
            aria-hidden
          />
          <select
            value={resolved?.key ?? region.field_key}
            onChange={(e) =>
              onChange({ ...region, field_key: e.target.value })
            }
            disabled={disabled}
            className="flex-1 min-w-0 rounded-md border border-gray-300 bg-white px-2 py-1 text-[13px] text-gray-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-gray-50"
          >
            {dropdownOptions.length === 0 ? (
              <option value={region.field_key}>
                {labelPlaceholder}
              </option>
            ) : (
              dropdownOptions.map((opt) => (
                <option
                  key={opt.key}
                  value={opt.key}
                  disabled={opt.disabled}
                >
                  {opt.label}
                </option>
              ))
            )}
          </select>
        </div>
        {!isUnknown && usageOnThisField > 1 && (
          <p className="text-[10.5px] text-gray-500 mt-1">
            {usageOnThisField} regions are pinned to this field.
          </p>
        )}
      </Field>

      <Field
        label="Display label"
        help="Optional. Shown on the region overlay; defaults to the field name."
      >
        <input
          type="text"
          value={region.label ?? ""}
          onChange={(e) =>
            onChange({ ...region, label: e.target.value || null })
          }
          disabled={disabled}
          maxLength={MAX_PATTERN_REGION_LABEL_LENGTH}
          placeholder={labelPlaceholder}
          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-[13px] text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-gray-50"
        />
      </Field>

      <Field label="Notes" help="Optional operator scratch space.">
        <textarea
          value={region.notes ?? ""}
          onChange={(e) =>
            onChange({ ...region, notes: e.target.value || null })
          }
          disabled={disabled}
          maxLength={MAX_PATTERN_REGION_NOTES_LENGTH}
          rows={3}
          placeholder="e.g. Only on bills from 2025-Q3 onwards."
          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-[12.5px] text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-gray-50"
        />
      </Field>

      {/* Read-only diagnostic: shape, page, geometry. Geometry is shown
          as PERCENTAGES of the page rect (instead of normalized
          decimals) because operators reason naturally about "this
          region covers the right 30% of the page" — way more useful
          than 0.700 / 0.030. The polygon path additionally surfaces
          the point count since the bbox is the polygon's enclosing
          rect (computed by the data-model helpers, not user-set). */}
      <div className="pt-2 border-t border-gray-100 text-[10.5px] text-gray-500 space-y-0.5">
        <p>
          Shape:{" "}
          <span className="text-gray-700 font-medium">
            {regionShape(region) === "polygon"
              ? `Polygon (${region.points?.length ?? 0} points)`
              : "Rectangle"}
          </span>
        </p>
        <p>Page {region.page}</p>
        <p className="font-mono">
          x {pct(region.bbox.x)} · y {pct(region.bbox.y)} · w{" "}
          {pct(region.bbox.w)} · h {pct(region.bbox.h)}
        </p>
      </div>
    </div>
  );
}

/**
 * Format a normalized [0, 1] coordinate as a 1-decimal-place
 * percentage. 0.4567 → "45.7%". One decimal is the sweet spot for
 * inspector copy: precise enough to confirm the operator dragged to
 * the right spot, terse enough to fit on one line for all four
 * geometry components.
 */
function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11.5px] font-semibold text-gray-700">
        {label}
      </span>
      <div className="mt-1">{children}</div>
      {help && (
        <p className="text-[10.5px] text-gray-500 mt-0.5">{help}</p>
      )}
    </label>
  );
}
