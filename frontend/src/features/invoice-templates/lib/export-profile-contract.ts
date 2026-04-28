/**
 * Phase 3F — Export Profile contract.
 *
 * First-cut profile abstraction for what real export configs will
 * eventually look like (ResMan / Yardi / AppFolio / custom CSV).
 *
 * What this module IS:
 *   * A typed contract describing an export profile (settings +
 *     columns) that the diagnostic Operational Preview can validate
 *     the export-style rows preview against.
 *   * A small set of built-in profile builders that derive sensible
 *     defaults from the existing ``OperationalExportPreview`` —
 *     no hard-coded vendor specs, no false claims about exact
 *     ResMan / Yardi / AppFolio import requirements.
 *   * Pure + deterministic — no React, no DOM, no API calls.
 *
 * What this module is NOT:
 *   * NOT an export file generator.
 *   * NOT a download trigger.
 *   * NOT a backend persistence layer.
 *   * NOT a claim of production export readiness.
 *
 * Naming convention: every public type starts with ``Export*``
 * so a future backend-persisted profile model can mirror these
 * shapes without renames.
 */

import type {
  OperationalExportPreview,
  OperationalExportPreviewColumn,
} from "./operational-export-preview";

// ---------------------------------------------------------------------------
// Public enums + scalars
// ---------------------------------------------------------------------------

export type ExportTargetSystem =
  | "resman"
  | "yardi"
  | "appfolio"
  | "custom_csv";

export type ExportProfileDelimiter = "comma" | "tab" | "semicolon" | "pipe";

export type ExportProfileQuoteStrategy =
  | "minimal"
  | "all"
  | "non_numeric"
  | "none";

export type ExportProfileNewline = "lf" | "crlf";

export type ExportProfileEncoding = "utf-8" | "utf-8-bom" | "windows-1252";

export type ExportProfileDateFormat =
  | "MM/DD/YYYY"
  | "M/D/YYYY"
  | "YYYY-MM-DD"
  | "DD/MM/YYYY";

export type ExportProfileAmountFormat =
  | "decimal_2"
  | "decimal_4"
  | "integer"
  | "decimal_2_neg_paren";

export type ExportProfileBooleanFormat =
  | "true_false"
  | "yes_no"
  | "1_0"
  | "y_n";

export type ExportProfileEmptyValuePolicy =
  | "blank"
  | "literal_null"
  | "dash";

export type ExportProfileColumnDataType =
  | "text"
  | "date"
  | "amount"
  | "integer"
  | "decimal"
  | "boolean";

export type ExportProfileColumnTrim = "none" | "trim" | "trim_collapse";

// ---------------------------------------------------------------------------
// Profile + column shapes
// ---------------------------------------------------------------------------

export interface ExportProfileSettings {
  delimiter: ExportProfileDelimiter;
  include_header: boolean;
  quote_strategy: ExportProfileQuoteStrategy;
  newline: ExportProfileNewline;
  encoding: ExportProfileEncoding;
  date_format: ExportProfileDateFormat;
  amount_format: ExportProfileAmountFormat;
  boolean_format?: ExportProfileBooleanFormat;
  empty_value_policy: ExportProfileEmptyValuePolicy;
  /** Pure preview string — never used to generate a real file. */
  file_naming_preview: string;
}

export interface ExportProfileColumn {
  /** Stable id within the profile. */
  key: string;
  /** Operator-facing label. */
  label: string;
  /** Whether this column must be present in the preview AND have a
   *  value for the validator to mark the row as clear. */
  required: boolean;
  /** Best-known preview column key the profile expects to draw
   *  from. The validator falls back to label / alias matching when
   *  this is null. */
  source_column_key: string | null;
  /** Best-known preview column label the validator should look for
   *  when ``source_column_key`` doesn't match. */
  source_column_label: string | null;
  /** What the column would be named in the output file's header
   *  row (when ``settings.include_header === true``). */
  output_header: string;
  /** Display order — lower comes first. */
  order: number;
  data_type: ExportProfileColumnDataType;
  /** Optional format override (e.g. "yyyy-mm-dd" for a date column
   *  that needs to differ from the profile-wide ``date_format``). */
  format?: string;
  max_length?: number;
  allowed_values?: string[];
  default_value?: string;
  trim: ExportProfileColumnTrim;
  /** Optional aliases the validator considers when matching against
   *  preview columns by label. Lowercased + space-normalised. */
  match_aliases?: string[];
}

export interface ExportProfile {
  id: string;
  name: string;
  description: string;
  target_system: ExportTargetSystem;
  settings: ExportProfileSettings;
  columns: ExportProfileColumn[];
}

// ---------------------------------------------------------------------------
// Built-in profile builders
// ---------------------------------------------------------------------------

/**
 * Mirror the current Export-style Rows Preview's columns into a
 * permissive Custom CSV profile. Every preview column becomes a
 * profile column with ``required=false`` (the preview itself
 * doesn't carry per-column "required" today). Blocked / conflict
 * cells will still be flagged by the validator regardless.
 */
export function buildCustomCsvMirrorProfile(
  preview: OperationalExportPreview,
): ExportProfile {
  const columns: ExportProfileColumn[] = preview.columns.map((col, idx) =>
    _customMirrorColumn(col, idx),
  );
  return {
    id: "builtin:custom-csv-mirror",
    name: "Custom CSV mirror",
    description:
      "Mirrors the current preview columns for diagnostic checks. " +
      "Permissive — blocked or conflict cells still surface.",
    target_system: "custom_csv",
    settings: {
      delimiter: "comma",
      include_header: true,
      quote_strategy: "minimal",
      newline: "crlf",
      encoding: "utf-8",
      date_format: "YYYY-MM-DD",
      amount_format: "decimal_2",
      boolean_format: "true_false",
      empty_value_policy: "blank",
      file_naming_preview: "rivera-custom-export-{template}-{timestamp}.csv",
    },
    columns,
  };
}

/**
 * ResMan-style generic profile. Marks the common accounting fields
 * (Property / Vendor / Invoice Number / Invoice Date / GL Account /
 * Amount) as required, with flexible alias matching against the
 * preview columns.
 *
 * Cautious description — Rivera doesn't ship a definitive ResMan
 * spec; this is the operator-facing "diagnostic preview" of what
 * a typical multifamily AP import expects.
 */
export function buildGenericResManProfile(
  preview: OperationalExportPreview,
): ExportProfile {
  return _buildGenericAccountingProfile({
    id: "builtin:resman-generic",
    name: "ResMan generic import",
    description:
      "Generic ResMan-style profile check. Validates the most common multifamily AP fields. " +
      "Final production exports may require property-specific template configuration.",
    target_system: "resman",
    preview,
  });
}

/**
 * Yardi-style generic profile. Same column set as ResMan generic
 * for now — Rivera doesn't ship a definitive Yardi spec.
 */
export function buildGenericYardiProfile(
  preview: OperationalExportPreview,
): ExportProfile {
  return _buildGenericAccountingProfile({
    id: "builtin:yardi-generic",
    name: "Yardi generic import",
    description:
      "Generic Yardi-style profile check. Validates the most common multifamily AP fields. " +
      "Final production exports may require client-specific mapping.",
    target_system: "yardi",
    preview,
  });
}

/**
 * AppFolio-style generic profile. Same column set as ResMan
 * generic.
 */
export function buildGenericAppFolioProfile(
  preview: OperationalExportPreview,
): ExportProfile {
  return _buildGenericAccountingProfile({
    id: "builtin:appfolio-generic",
    name: "AppFolio generic import",
    description:
      "Generic AppFolio-style profile check. Validates the most common multifamily AP fields. " +
      "Final production exports may require client-specific mapping.",
    target_system: "appfolio",
    preview,
  });
}

/**
 * Default profile bundle exposed to the panel. Order matters — the
 * panel uses the first one as the default selection on mount.
 */
export function getBuiltInExportProfiles(
  preview: OperationalExportPreview,
): ExportProfile[] {
  return [
    buildCustomCsvMirrorProfile(preview),
    buildGenericResManProfile(preview),
    buildGenericYardiProfile(preview),
    buildGenericAppFolioProfile(preview),
  ];
}

// ---------------------------------------------------------------------------
// Public helpers (used by the validator + panel)
// ---------------------------------------------------------------------------

/**
 * Normalise a column label / key for alias matching. Case-folds,
 * trims, collapses whitespace + underscores into a single space.
 * Pure — safe to call inside hot loops.
 */
export function normalizeColumnLabel(value: string | null | undefined): string {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the preview column that best matches a profile column.
 * Match priority:
 *   1. Exact ``source_column_key`` match against ``preview.columns[].key``
 *   2. Normalised label match against ``preview.columns[].label``
 *   3. Normalised match against any of the profile column's
 *      ``match_aliases``
 *
 * Returns ``null`` when nothing matches.
 */
export function findPreviewColumnForProfileColumn(
  profileColumn: ExportProfileColumn,
  previewColumns: OperationalExportPreviewColumn[],
): OperationalExportPreviewColumn | null {
  // Tier 1 — exact key match.
  if (profileColumn.source_column_key) {
    const byKey = previewColumns.find(
      (c) => c.key === profileColumn.source_column_key,
    );
    if (byKey) return byKey;
  }
  // Tier 2 — normalised label match.
  const targets = new Set<string>();
  if (profileColumn.source_column_label) {
    targets.add(normalizeColumnLabel(profileColumn.source_column_label));
  }
  targets.add(normalizeColumnLabel(profileColumn.label));
  // Tier 3 — alias match.
  for (const alias of profileColumn.match_aliases ?? []) {
    targets.add(normalizeColumnLabel(alias));
  }
  // ``Array.from(set)`` works regardless of TS lib target; ``for...of set``
  // would require --downlevelIteration.
  const targetList = Array.from(targets);
  for (const target of targetList) {
    if (!target) continue;
    const found = previewColumns.find(
      (c) => normalizeColumnLabel(c.label) === target,
    );
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _customMirrorColumn(
  previewColumn: OperationalExportPreviewColumn,
  idx: number,
): ExportProfileColumn {
  return {
    key: `mirror-${previewColumn.key}`,
    label: previewColumn.label,
    required: false,
    source_column_key: previewColumn.key,
    source_column_label: previewColumn.label,
    output_header: previewColumn.label,
    order: idx,
    data_type: _guessDataType(previewColumn.label),
    trim: "trim",
  };
}

/** Best-effort data-type guess based on the column label.
 *  Used by the Custom CSV mirror so common columns get sensible
 *  validation. Conservative — defaults to ``text`` when unsure. */
function _guessDataType(label: string): ExportProfileColumnDataType {
  const norm = normalizeColumnLabel(label);
  if (
    norm.includes("date") ||
    norm.includes("period start") ||
    norm.includes("period end")
  ) {
    return "date";
  }
  if (
    norm === "amount" ||
    norm.endsWith("amount") ||
    norm.includes("total") ||
    norm.includes("subtotal") ||
    norm.includes("tax") ||
    norm.includes("balance") ||
    norm.includes("fee") ||
    norm.includes("charge")
  ) {
    return "amount";
  }
  return "text";
}

interface _GenericProfileArgs {
  id: string;
  name: string;
  description: string;
  target_system: ExportTargetSystem;
  preview: OperationalExportPreview;
}

/**
 * Shared builder for the ResMan / Yardi / AppFolio generic
 * profiles. Each defines the same canonical AP column set with
 * flexible alias matching against the operator's preview columns.
 *
 * Per-vendor spec is intentionally generic — Rivera doesn't ship
 * a definitive ResMan / Yardi / AppFolio import schema today.
 */
function _buildGenericAccountingProfile(args: _GenericProfileArgs): ExportProfile {
  // The canonical accounting columns the generic profile expects.
  // Aliases cover the most common Import Builder / Operational
  // Preview labels Rivera operators have used so far.
  const definitions: Array<{
    key: string;
    label: string;
    required: boolean;
    data_type: ExportProfileColumnDataType;
    aliases: string[];
    allowed_values?: string[];
  }> = [
    {
      key: "property",
      label: "Property",
      required: true,
      data_type: "text",
      aliases: ["Property Name", "property_name", "property_code", "Property Code"],
    },
    {
      key: "vendor",
      label: "Vendor",
      required: true,
      data_type: "text",
      aliases: ["Vendor Name", "vendor_name", "Payee", "Supplier"],
    },
    {
      key: "invoice_number",
      label: "Invoice Number",
      required: true,
      data_type: "text",
      aliases: [
        "invoice_number",
        "Invoice #",
        "Invoice No",
        "Invoice ID",
        "Inv #",
      ],
    },
    {
      key: "invoice_date",
      label: "Invoice Date",
      required: true,
      data_type: "date",
      aliases: [
        "invoice_date",
        "Date",
        "Bill Date",
        "Statement Date",
      ],
    },
    {
      key: "due_date",
      label: "Due Date",
      required: false,
      data_type: "date",
      aliases: ["due_date", "Payment Due", "Payment Due Date"],
    },
    {
      key: "gl_account",
      label: "GL Account",
      required: true,
      data_type: "text",
      aliases: [
        "GL",
        "gl_account",
        "Account",
        "GL Code",
        "Account Number",
      ],
    },
    {
      key: "amount",
      label: "Amount",
      required: true,
      data_type: "amount",
      aliases: [
        "amount",
        "Total",
        "total_amount",
        "Total Amount",
        "Bill Amount",
      ],
    },
    {
      key: "description",
      label: "Description",
      required: false,
      data_type: "text",
      aliases: ["description", "Memo", "line_description", "Notes"],
    },
    {
      key: "bill_or_credit",
      label: "Bill or Credit",
      required: false,
      data_type: "text",
      allowed_values: ["Bill", "Credit"],
      aliases: [
        "bill_or_credit",
        "Bill/Credit",
        "Type",
        "Invoice Type",
      ],
    },
  ];
  const columns: ExportProfileColumn[] = definitions.map((d, idx) => ({
    key: d.key,
    label: d.label,
    required: d.required,
    source_column_key: null,
    source_column_label: d.label,
    output_header: d.label,
    order: idx,
    data_type: d.data_type,
    trim: "trim",
    allowed_values: d.allowed_values,
    match_aliases: d.aliases,
  }));
  void args.preview; // Reserved for future per-preview customisation.
  return {
    id: args.id,
    name: args.name,
    description: args.description,
    target_system: args.target_system,
    settings: {
      delimiter: "comma",
      include_header: true,
      quote_strategy: "minimal",
      newline: "crlf",
      encoding: "utf-8",
      date_format: "MM/DD/YYYY",
      amount_format: "decimal_2",
      boolean_format: "true_false",
      empty_value_policy: "blank",
      file_naming_preview: `rivera-${args.target_system}-{template}-{timestamp}.csv`,
    },
    columns,
  };
}
