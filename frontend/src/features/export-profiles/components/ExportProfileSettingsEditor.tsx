"use client";

import { cn } from "@/lib/utils";

import {
  EXPORT_PROFILE_AMOUNT_FORMATS,
  EXPORT_PROFILE_DATE_FORMATS,
  EXPORT_PROFILE_DELIMITERS,
  EXPORT_PROFILE_EMPTY_VALUE_POLICIES,
  EXPORT_PROFILE_ENCODINGS,
  EXPORT_PROFILE_NEWLINES,
  EXPORT_PROFILE_QUOTE_STRATEGIES,
  type ExportProfileFormSettings,
} from "../lib/export-profile-form";

/**
 * Phase 4C — Profile-level settings editor.
 *
 * Controlled component — every input flows ``value`` + ``onChange``
 * through the parent. Pure presentation; no fetch / no validation
 * (the parent owns it). Splits each setting into its own row to
 * keep the form scannable on a narrow modal.
 */

export interface ExportProfileSettingsEditorProps {
  value: ExportProfileFormSettings;
  onChange: (next: ExportProfileFormSettings) => void;
  disabled?: boolean;
}

export function ExportProfileSettingsEditor({
  value,
  onChange,
  disabled,
}: ExportProfileSettingsEditorProps) {
  const update = <K extends keyof ExportProfileFormSettings>(
    key: K,
    next: ExportProfileFormSettings[K],
  ) => {
    onChange({ ...value, [key]: next });
  };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <SelectField
        label="Delimiter"
        value={value.delimiter}
        onChange={(v) => update("delimiter", v)}
        options={EXPORT_PROFILE_DELIMITERS}
        disabled={disabled}
      />
      <SelectField
        label="Quote strategy"
        value={value.quote_strategy}
        onChange={(v) => update("quote_strategy", v)}
        options={EXPORT_PROFILE_QUOTE_STRATEGIES}
        disabled={disabled}
      />
      <SelectField
        label="Newline"
        value={value.newline}
        onChange={(v) => update("newline", v)}
        options={EXPORT_PROFILE_NEWLINES}
        disabled={disabled}
      />
      <SelectField
        label="Encoding"
        value={value.encoding}
        onChange={(v) => update("encoding", v)}
        options={EXPORT_PROFILE_ENCODINGS}
        disabled={disabled}
      />
      <SelectField
        label="Date format"
        value={value.date_format}
        onChange={(v) => update("date_format", v)}
        options={EXPORT_PROFILE_DATE_FORMATS}
        disabled={disabled}
      />
      <SelectField
        label="Amount format"
        value={value.amount_format}
        onChange={(v) => update("amount_format", v)}
        options={EXPORT_PROFILE_AMOUNT_FORMATS}
        disabled={disabled}
      />
      <SelectField
        label="Empty value policy"
        value={value.empty_value_policy}
        onChange={(v) => update("empty_value_policy", v)}
        options={EXPORT_PROFILE_EMPTY_VALUE_POLICIES}
        disabled={disabled}
      />
      <CheckboxField
        label="Include header row"
        checked={value.include_header}
        onChange={(v) => update("include_header", v)}
        disabled={disabled}
      />
    </div>
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
