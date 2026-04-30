"use client";

import {
  ArrowDown,
  ArrowUp,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

import {
  EXPORT_PROFILE_DATA_TYPES,
  EXPORT_PROFILE_TRIM_OPTIONS,
  appendColumn,
  blankFormColumn,
  moveColumn,
  removeColumn,
  type ExportProfileFormColumn,
} from "../lib/export-profile-form";

/**
 * Phase 4C — Per-column editor for the management page.
 *
 * Each column renders as a collapsible row to keep the editor
 * scannable. The row header always shows ``key · label · data_type``;
 * expanding the row reveals the rest (output_header, source binding,
 * required flag, max_length, allowed_values, default_value, trim,
 * match_aliases).
 *
 * Reorder + remove + add live next to each row. ``errors`` are
 * keyed by row index — the parent's validator surfaces them; the
 * row visibly tints when its index has any error.
 */

export interface ExportProfileColumnsEditorProps {
  columns: ExportProfileFormColumn[];
  onChange: (next: ExportProfileFormColumn[]) => void;
  errors: Map<number, string[]>;
  disabled?: boolean;
}

export function ExportProfileColumnsEditor({
  columns,
  onChange,
  errors,
  disabled,
}: ExportProfileColumnsEditorProps) {
  const updateColumn = (index: number, patch: Partial<ExportProfileFormColumn>) => {
    onChange(
      columns.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    );
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-gray-600 dark:text-ink-muted">
          {columns.length === 0
            ? "No columns yet — add at least one column to save the profile."
            : `${columns.length} column${columns.length === 1 ? "" : "s"}.`}
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => onChange(appendColumn(columns, blankFormColumn()))}
        >
          <Plus className="h-3.5 w-3.5" />
          Add column
        </Button>
      </div>

      {columns.length > 0 && (
        <ul className="space-y-2">
          {columns.map((column, idx) => (
            <ColumnRow
              key={idx}
              index={idx}
              total={columns.length}
              column={column}
              errors={errors.get(idx) ?? []}
              disabled={disabled}
              onUpdate={(patch) => updateColumn(idx, patch)}
              onRemove={() => onChange(removeColumn(columns, idx))}
              onMoveUp={() => onChange(moveColumn(columns, idx, "up"))}
              onMoveDown={() => onChange(moveColumn(columns, idx, "down"))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ColumnRow({
  index,
  total,
  column,
  errors,
  disabled,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  index: number;
  total: number;
  column: ExportProfileFormColumn;
  errors: string[];
  disabled?: boolean;
  onUpdate: (patch: Partial<ExportProfileFormColumn>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [open, setOpen] = useState(true);
  const hasErrors = errors.length > 0;
  return (
    <li
      className={cn(
        "rounded border bg-white dark:bg-surface-subtle",
        hasErrors
          ? "border-rose-300 dark:border-rose-900"
          : "border-gray-200 dark:border-line",
      )}
    >
      <header className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-gray-700 dark:text-ink"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <span className="font-mono">{column.key || "(no key)"}</span>
          <span className="text-gray-400 dark:text-ink-subtle">·</span>
          <span className="text-gray-600 dark:text-ink-muted">
            {column.label || "(no label)"}
          </span>
          <span className="text-gray-400 dark:text-ink-subtle">·</span>
          <span className="text-[10px] text-gray-500 dark:text-ink-subtle uppercase tracking-wide">
            {column.data_type}
          </span>
          {column.required && (
            <span className="ml-1 inline-flex items-center rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              required
            </span>
          )}
        </button>
        <span className="ml-auto inline-flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onMoveUp}
            disabled={disabled || index === 0}
            title="Move column up"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onMoveDown}
            disabled={disabled || index === total - 1}
            title="Move column down"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={disabled}
            title="Remove column"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </span>
      </header>

      {open && (
        <div className="border-t border-gray-100 dark:border-line/60 px-2.5 py-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <TextField
            label="Key"
            value={column.key}
            onChange={(v) => onUpdate({ key: v })}
            disabled={disabled}
            placeholder="invoice_number"
            mono
          />
          <TextField
            label="Label"
            value={column.label}
            onChange={(v) => onUpdate({ label: v })}
            disabled={disabled}
            placeholder="Invoice Number"
          />
          <TextField
            label="Output header"
            value={column.output_header}
            onChange={(v) => onUpdate({ output_header: v })}
            disabled={disabled}
            placeholder="Defaults to label"
          />
          <SelectField
            label="Data type"
            value={column.data_type}
            onChange={(v) =>
              onUpdate({
                data_type: v as ExportProfileFormColumn["data_type"],
              })
            }
            options={EXPORT_PROFILE_DATA_TYPES}
            disabled={disabled}
          />
          <TextField
            label="Source column key"
            value={column.source_column_key}
            onChange={(v) => onUpdate({ source_column_key: v })}
            disabled={disabled}
            placeholder="(optional preview key)"
            mono
          />
          <TextField
            label="Source column label"
            value={column.source_column_label}
            onChange={(v) => onUpdate({ source_column_label: v })}
            disabled={disabled}
            placeholder="(optional)"
          />
          <TextField
            label="Max length"
            value={column.max_length}
            onChange={(v) => onUpdate({ max_length: v })}
            disabled={disabled}
            placeholder="e.g. 64"
            mono
          />
          <SelectField
            label="Trim"
            value={column.trim}
            onChange={(v) =>
              onUpdate({ trim: v as ExportProfileFormColumn["trim"] })
            }
            options={EXPORT_PROFILE_TRIM_OPTIONS}
            disabled={disabled}
          />
          <TextareaField
            label="Allowed values (comma or newline separated)"
            value={column.allowed_values}
            onChange={(v) => onUpdate({ allowed_values: v })}
            disabled={disabled}
            placeholder="bill, credit"
          />
          <TextareaField
            label="Match aliases (comma or newline separated)"
            value={column.match_aliases}
            onChange={(v) => onUpdate({ match_aliases: v })}
            disabled={disabled}
            placeholder="invoice #, inv #"
          />
          <TextField
            label="Default value"
            value={column.default_value}
            onChange={(v) => onUpdate({ default_value: v })}
            disabled={disabled}
            placeholder="(optional)"
          />
          <CheckboxField
            label="Required"
            checked={column.required}
            onChange={(v) => onUpdate({ required: v })}
            disabled={disabled}
          />
        </div>
      )}

      {hasErrors && (
        <ul className="border-t border-rose-100 dark:border-rose-900/40 px-3 py-1.5 text-[11px] text-rose-700 dark:text-rose-200 list-disc list-inside">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Tiny field primitives — kept local so the editor stays portable
// without dragging the entire form library into the bundle.
// ---------------------------------------------------------------------------

function TextField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-ink-muted">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className={cn(
          "rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 outline-none",
          "focus:ring-2 focus:ring-brand-500",
          "dark:bg-surface dark:text-ink dark:border-line",
          "disabled:opacity-60 disabled:cursor-not-allowed",
          mono && "font-mono",
        )}
      />
    </label>
  );
}

function TextareaField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-0.5 sm:col-span-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-ink-muted">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        rows={2}
        className={cn(
          "rounded border border-gray-300 bg-white px-2 py-1 text-[12px] text-gray-800 outline-none",
          "focus:ring-2 focus:ring-brand-500",
          "dark:bg-surface dark:text-ink dark:border-line",
          "disabled:opacity-60 disabled:cursor-not-allowed",
        )}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-ink-muted">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          "rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 outline-none",
          "focus:ring-2 focus:ring-brand-500",
          "dark:bg-surface dark:text-ink dark:border-line",
          "disabled:opacity-60 disabled:cursor-not-allowed",
        )}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-2 mt-5 text-sm text-gray-800 dark:text-ink select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-4 w-4"
      />
      {label}
    </label>
  );
}
