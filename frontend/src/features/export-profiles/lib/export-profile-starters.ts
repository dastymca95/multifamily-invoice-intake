/**
 * Phase 4C — Starter profiles for the management page.
 *
 * Convert the Phase 3F built-in profile factories into editable
 * form state so an operator can use them as a foundation rather
 * than building a profile from scratch. The resulting form is
 * NOT auto-saved — the operator reviews + saves explicitly.
 *
 * For Custom CSV the management page doesn't have an Operational
 * Preview to mirror, so we synthesise a minimal generic preview
 * with three example columns (Description / Amount / Date). The
 * built-in ResMan / Yardi / AppFolio factories don't actually
 * depend on the preview content — their column lists are
 * canonical accounting fields baked into the factory — so we
 * pass an empty preview shape and reuse the same canonical
 * columns the Operational Preview would produce.
 *
 * Pure / synchronous. No fetch, no DOM.
 */

import {
  buildCustomCsvMirrorProfile,
  buildGenericAppFolioProfile,
  buildGenericResManProfile,
  buildGenericYardiProfile,
} from "@/features/invoice-templates/lib/export-profile-contract";
import type { ExportProfile } from "@/features/invoice-templates/lib/export-profile-contract";
import type { OperationalExportPreview } from "@/features/invoice-templates/lib/operational-export-preview";
import type { PersistedExportProfileTargetSystem } from "@/types/export-profile-persistence";

import {
  appendColumn,
  blankFormColumn,
  buildEmptyForm,
  defaultExportProfileSettings,
  type ExportProfileFormColumn,
  type ExportProfileFormDataType,
  type ExportProfileFormState,
  type ExportProfileFormTrim,
} from "./export-profile-form";

// ---------------------------------------------------------------------------
// Public — starter selector
// ---------------------------------------------------------------------------

export interface ExportProfileStarterDescriptor {
  id: PersistedExportProfileTargetSystem;
  label: string;
  description: string;
}

export const EXPORT_PROFILE_STARTERS: ExportProfileStarterDescriptor[] = [
  {
    id: "custom_csv",
    label: "Custom CSV starter",
    description:
      "Three example columns (Description / Amount / Date). Adjust to match the file you plan to send downstream.",
  },
  {
    id: "resman",
    label: "ResMan generic starter",
    description:
      "Canonical multifamily AP columns (Property / Vendor / Invoice Number / GL / Amount / Date). Property-specific tweaks usually still required.",
  },
  {
    id: "yardi",
    label: "Yardi generic starter",
    description:
      "Same column set as ResMan generic — Rivera doesn't ship a definitive Yardi spec.",
  },
  {
    id: "appfolio",
    label: "AppFolio generic starter",
    description:
      "Same column set as ResMan generic — final mappings depend on the AppFolio import setup.",
  },
];

/**
 * Build a starter form for the chosen target system. The form is
 * UN-NAMED so the operator must provide a name before saving — this
 * prevents two anonymous "ResMan generic starter" rows landing in
 * the catalog by accident.
 */
export function buildStarterForm(
  targetSystem: PersistedExportProfileTargetSystem,
): ExportProfileFormState {
  if (targetSystem === "custom_csv") {
    return _buildCustomCsvStarter();
  }
  return _buildContractDerivedStarter(targetSystem);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _buildCustomCsvStarter(): ExportProfileFormState {
  const base = buildEmptyForm({ targetSystem: "custom_csv" });
  base.description =
    "Custom CSV starter. Adjust columns / settings before saving.";
  let columns: ExportProfileFormColumn[] = [];
  columns = appendColumn(columns, {
    key: "description",
    label: "Description",
    output_header: "Description",
    required: true,
    data_type: "text",
    match_aliases: "memo, line description",
  });
  columns = appendColumn(columns, {
    key: "amount",
    label: "Amount",
    output_header: "Amount",
    required: true,
    data_type: "amount",
    match_aliases: "total, total_amount",
  });
  columns = appendColumn(columns, {
    key: "date",
    label: "Date",
    output_header: "Date",
    required: true,
    data_type: "date",
    match_aliases: "invoice_date, bill date",
  });
  return { ...base, columns };
}

function _buildContractDerivedStarter(
  targetSystem: PersistedExportProfileTargetSystem,
): ExportProfileFormState {
  // Synthetic empty preview — the generic factories don't need
  // preview rows for their canonical column lists, but the API
  // requires a preview shape. Keep this tiny.
  const emptyPreview: OperationalExportPreview = {
    status: "ready",
    row_count: 0,
    ready_row_count: 0,
    blocked_row_count: 0,
    warning_row_count: 0,
    conflict_row_count: 0,
    columns: [],
    rows: [],
    issues: [],
    summary: {
      row_count: 0,
      ready_row_count: 0,
      warning_row_count: 0,
      blocked_row_count: 0,
      conflict_row_count: 0,
      cells_with_issues: 0,
      column_count: 0,
      worst_status: null,
    },
    can_preview_export: false,
    can_future_export_hint: false,
  };
  const profile = _buildContractForTarget(targetSystem, emptyPreview);
  const base = buildEmptyForm({ targetSystem });
  base.description = profile.description ?? "";
  return {
    ...base,
    columns: profile.columns.map((c) =>
      blankFormColumn({
        key: c.key,
        label: c.label,
        output_header: c.output_header,
        required: c.required,
        source_column_key: c.source_column_key ?? "",
        source_column_label: c.source_column_label ?? "",
        data_type: _coerceDataType(c.data_type),
        max_length:
          typeof c.max_length === "number" && c.max_length > 0
            ? String(c.max_length)
            : "",
        allowed_values: c.allowed_values
          ? c.allowed_values.join(", ")
          : "",
        default_value:
          c.default_value === undefined || c.default_value === null
            ? ""
            : String(c.default_value),
        trim: _coerceTrim(c.trim),
        match_aliases: c.match_aliases
          ? c.match_aliases.join(", ")
          : "",
        // ``order`` lives implicitly via the array index in the
        // payload builder — not part of the form column shape.
      }),
    ),
    settings: defaultExportProfileSettings(),
  };
  // Note: ``c.format`` (per-column date format override) is not
  // surfaced in the form yet — the management page uses the
  // profile-level ``settings.date_format``. Existing records that
  // already carry a per-column ``format`` round-trip through the
  // edit form unchanged because the form only writes the keys it
  // owns; columns with overrides go through ``buildFormFromRecord``
  // and back out via ``buildUpdatePayload`` losing the override.
  // Documented as a known limitation in the phase report.
  // (Starter columns never set a per-column format.)
}

function _buildContractForTarget(
  targetSystem: PersistedExportProfileTargetSystem,
  preview: OperationalExportPreview,
): ExportProfile {
  switch (targetSystem) {
    case "resman":
      return buildGenericResManProfile(preview);
    case "yardi":
      return buildGenericYardiProfile(preview);
    case "appfolio":
      return buildGenericAppFolioProfile(preview);
    case "custom_csv":
      return buildCustomCsvMirrorProfile(preview);
    default:
      // Forward-compat — fall back to the custom-csv starter so
      // an unrecognised target system doesn't crash the page.
      return buildCustomCsvMirrorProfile(preview);
  }
}

function _coerceDataType(value: string): ExportProfileFormDataType {
  if (
    value === "text" ||
    value === "date" ||
    value === "amount" ||
    value === "integer" ||
    value === "decimal" ||
    value === "boolean"
  ) {
    return value;
  }
  return "text";
}

function _coerceTrim(value: string): ExportProfileFormTrim {
  if (value === "none" || value === "trim" || value === "trim_collapse") {
    return value;
  }
  return "trim";
}
