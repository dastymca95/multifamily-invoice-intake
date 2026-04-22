"use client";

import {
  CheckCircle2,
  CircleDashed,
  FileSpreadsheet,
  Info,
  Pin,
  Save,
  Settings2,
  Sparkles,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ROW_LIMIT,
  ROW_LIMIT_MAX,
  ROW_LIMIT_MIN,
  type ImportConfigDetail,
  type ImportConfigUpdate,
} from "@/types/import-config";
import type {
  ColumnRole,
  PreviewContribution,
  ReferenceSource,
} from "@/types/resman-preview";

import { SOURCE_TINT, prettyRole } from "./PreviewSpreadsheet";

/**
 * The "what is this config" pane on the right of the workspace.
 *
 * Three sections, top-to-bottom:
 *   1. Config form    — name + description + row limit + Save / Delete
 *   2. Pinned roles   — any column-role overrides this config has set,
 *                       with quick "unpin" buttons + an "Add pin" picker
 *   3. Contributions  — what each uploaded reference source is adding
 *                       to the rendered preview, plus the notes block
 *
 * Form state is local to this component (so the Save button has
 * something to gate on) and resets whenever the loaded detail changes.
 */
interface ConfigDetailsPanelProps {
  detail: ImportConfigDetail;
  saving: boolean;
  mutationError: string | null;
  onSave: (body: ImportConfigUpdate) => Promise<void>;
  onDelete: () => Promise<void>;
}

const ALL_ROLES: ColumnRole[] = [
  "vendor_name",
  "vendor_id",
  "property_name",
  "property_code",
  "unit",
  "location",
  "invoice_number",
  "invoice_date",
  "due_date",
  "amount_total",
  "amount_subtotal",
  "amount_tax",
  "currency",
  "description",
  "account_number",
  "gl_code",
  "unmapped",
];

export function ConfigDetailsPanel({
  detail,
  saving,
  mutationError,
  onSave,
  onDelete,
}: ConfigDetailsPanelProps) {
  const { config, preview } = detail;

  // Local edit state — the form is uncontrolled by the parent so the
  // user can type freely and only commit on Save.
  const [name, setName] = useState(config.name);
  const [description, setDescription] = useState(config.description ?? "");
  const [rowLimit, setRowLimit] = useState<number>(config.row_limit);
  const [overrides, setOverrides] = useState<Record<string, ColumnRole>>(
    () => ({ ...config.column_role_overrides }),
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Reset local state when a new detail loads (selecting a different
  // config). Without this, the form would keep the previous config's
  // values until the next Save.
  useEffect(() => {
    setName(config.name);
    setDescription(config.description ?? "");
    setRowLimit(config.row_limit);
    setOverrides({ ...config.column_role_overrides });
    setConfirmingDelete(false);
  }, [
    config.id,
    config.name,
    config.description,
    config.row_limit,
    config.column_role_overrides,
  ]);

  const dirty = useMemo(() => {
    if (name.trim() !== config.name) return true;
    if ((description || null) !== (config.description ?? null)) return true;
    if (rowLimit !== config.row_limit) return true;
    if (
      JSON.stringify(sortedKeys(overrides)) !==
      JSON.stringify(sortedKeys(config.column_role_overrides))
    )
      return true;
    return false;
  }, [name, description, rowLimit, overrides, config]);

  const canSave = dirty && name.trim().length > 0 && !saving;

  const handleSave = () => {
    if (!canSave) return;
    void onSave({
      name: name.trim(),
      description: description.trim() ? description.trim() : null,
      row_limit: rowLimit,
      column_role_overrides: overrides,
    });
  };

  const handleAddOverride = (columnName: string, role: ColumnRole) => {
    setOverrides((curr) => ({ ...curr, [columnName]: role }));
  };
  const handleRemoveOverride = (columnName: string) => {
    setOverrides((curr) => {
      const next = { ...curr };
      delete next[columnName];
      return next;
    });
  };

  const overrideEntries = Object.entries(overrides).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  // Available template columns (for the "+ Pin a role" picker). Falls
  // back to nothing-pickable when the template isn't uploaded yet.
  const templateColumns = useMemo(
    () => preview.columns.map((c) => c.name),
    [preview.columns],
  );
  const unpinnedColumns = templateColumns.filter((c) => !(c in overrides));

  return (
    <aside className="w-[19rem] shrink-0 bg-white border-l border-gray-200 flex flex-col h-full">
      <div className="px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-brand-700" />
          <h2 className="text-sm font-semibold text-gray-800">
            Configuration
          </h2>
          {dirty && (
            <span className="text-[9.5px] font-semibold uppercase tracking-wide text-orange-600">
              · unsaved
            </span>
          )}
        </div>
        <p className="text-[10.5px] text-gray-500 mt-0.5">
          Edit and save this design. Changes re-render the preview on save.
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {/* ---- Form fields --------------------------------------------- */}
        <section className="px-4 py-3 border-b">
          <FieldLabel htmlFor="cfg-name">Name</FieldLabel>
          <input
            id="cfg-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={255}
            className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-500"
          />

          <FieldLabel htmlFor="cfg-desc" className="mt-3">
            Description
          </FieldLabel>
          <textarea
            id="cfg-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Optional — what is this config for?"
            className="w-full resize-none rounded-md border border-gray-300 px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-brand-500"
          />

          <FieldLabel htmlFor="cfg-rows" className="mt-3">
            Preview rows
            <span className="ml-1 font-normal text-gray-400">
              ({ROW_LIMIT_MIN}–{ROW_LIMIT_MAX})
            </span>
          </FieldLabel>
          <input
            id="cfg-rows"
            type="number"
            min={ROW_LIMIT_MIN}
            max={ROW_LIMIT_MAX}
            value={rowLimit}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (Number.isNaN(n)) return;
              setRowLimit(
                Math.max(ROW_LIMIT_MIN, Math.min(ROW_LIMIT_MAX, n)),
              );
            }}
            className="w-24 rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="text-[10.5px] text-gray-400 mt-0.5">
            Defaults to {DEFAULT_ROW_LIMIT}. Caps the approved invoices the
            preview pulls in.
          </p>
        </section>

        {/* ---- Pinned roles ------------------------------------------- */}
        <section className="px-4 py-3 border-b">
          <h3 className="text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5 inline-flex items-center gap-1">
            <Pin className="h-3 w-3" />
            Pinned roles ({overrideEntries.length})
          </h3>
          {overrideEntries.length === 0 ? (
            <p className="text-[11px] text-gray-500 italic">
              No role overrides — every column uses the auto-detected role.
            </p>
          ) : (
            <ul className="space-y-1">
              {overrideEntries.map(([col, role]) => (
                <PinnedOverrideRow
                  key={col}
                  columnName={col}
                  role={role}
                  onRemove={() => handleRemoveOverride(col)}
                  onChangeRole={(newRole) => handleAddOverride(col, newRole)}
                />
              ))}
            </ul>
          )}
          <AddPinPicker
            unpinnedColumns={unpinnedColumns}
            onAdd={handleAddOverride}
          />
        </section>

        {/* ---- Contributions ------------------------------------------ */}
        <section className="px-4 py-3 border-b">
          <h3 className="text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5 inline-flex items-center gap-1">
            <Sparkles className="h-3 w-3" />
            What each upload contributes
          </h3>
          <div className="grid gap-1.5">
            {preview.contributions.map((c) => (
              <ContributionChip key={c.source} contribution={c} />
            ))}
          </div>
        </section>

        {/* ---- Notes -------------------------------------------------- */}
        {preview.notes.length > 0 && (
          <section className="px-4 py-3 border-b">
            <h3 className="text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5 inline-flex items-center gap-1">
              <Info className="h-3 w-3" />
              Notes
            </h3>
            <ul className="space-y-1 text-[11px] text-gray-700 list-disc pl-4">
              {preview.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* ---- Sticky footer: Save / Delete ----------------------------- */}
      <div className="border-t px-4 py-3 shrink-0 space-y-2">
        {mutationError && (
          <InlineAlert tone="error">{mutationError}</InlineAlert>
        )}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="flex-1"
            disabled={!canSave}
            loading={saving}
            onClick={handleSave}
          >
            <Save className="h-3.5 w-3.5" />
            {dirty ? "Save changes" : "Saved"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => setConfirmingDelete(true)}
            title="Delete this config"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        {confirmingDelete && (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2.5 text-[11.5px] text-yellow-900 space-y-1.5">
            <p className="font-semibold">Delete this configuration?</p>
            <p className="text-yellow-900/80">
              The saved overrides will be lost. Reference uploads and approved
              invoices are not affected.
            </p>
            <div className="flex gap-1.5">
              <Button
                type="button"
                variant="danger"
                size="sm"
                loading={saving}
                onClick={() => {
                  setConfirmingDelete(false);
                  void onDelete();
                }}
              >
                Yes, delete
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Pinned-roles UI bits
// ---------------------------------------------------------------------------

function PinnedOverrideRow({
  columnName,
  role,
  onRemove,
  onChangeRole,
}: {
  columnName: string;
  role: ColumnRole;
  onRemove: () => void;
  onChangeRole: (role: ColumnRole) => void;
}) {
  return (
    <li className="rounded-md border border-brand-100 bg-brand-50/40 px-2 py-1.5">
      <div className="flex items-start gap-1.5">
        <Pin className="h-3 w-3 text-brand-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p
            className="text-[11.5px] font-medium text-gray-800 truncate"
            title={columnName}
          >
            {columnName}
          </p>
          <select
            className="mt-1 w-full rounded border border-brand-200 bg-white px-1.5 py-0.5 text-[10.5px] focus:outline-none focus:ring-1 focus:ring-brand-500"
            value={role}
            onChange={(e) => onChangeRole(e.target.value as ColumnRole)}
          >
            {ALL_ROLES.map((r) => (
              <option key={r} value={r}>
                {prettyRole(r)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-gray-400 hover:text-red-600 mt-0.5"
          title="Remove pin"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

function AddPinPicker({
  unpinnedColumns,
  onAdd,
}: {
  unpinnedColumns: string[];
  onAdd: (col: string, role: ColumnRole) => void;
}) {
  const [openCol, setOpenCol] = useState<string>("");
  const [pickRole, setPickRole] = useState<ColumnRole>("vendor_name");

  if (unpinnedColumns.length === 0) {
    return (
      <p className="text-[10.5px] text-gray-400 italic mt-2">
        All template columns are pinned (or no template uploaded yet).
      </p>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-dashed border-gray-200 px-2 py-2">
      <p className="text-[10.5px] text-gray-500 mb-1.5">Pin a role</p>
      <div className="flex gap-1">
        <select
          value={openCol}
          onChange={(e) => setOpenCol(e.target.value)}
          className="flex-1 min-w-0 rounded border border-gray-300 bg-white px-1.5 py-1 text-[10.5px]"
        >
          <option value="">Choose column…</option>
          {unpinnedColumns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={pickRole}
          onChange={(e) => setPickRole(e.target.value as ColumnRole)}
          className="rounded border border-gray-300 bg-white px-1.5 py-1 text-[10.5px]"
        >
          {ALL_ROLES.map((r) => (
            <option key={r} value={r}>
              {prettyRole(r)}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!openCol}
          onClick={() => {
            if (!openCol) return;
            onAdd(openCol, pickRole);
            setOpenCol("");
          }}
        >
          Pin
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Misc UI bits
// ---------------------------------------------------------------------------

const SOURCE_ICON: Record<
  ReferenceSource,
  React.ComponentType<{ className?: string }>
> = {
  vendor_report: Table2,
  property_report: Table2,
  unit_report: Table2,
  import_template: FileSpreadsheet,
};

function ContributionChip({
  contribution,
}: {
  contribution: PreviewContribution;
}) {
  const tint = SOURCE_TINT[contribution.source];
  const Icon = SOURCE_ICON[contribution.source];
  const StatusIcon = contribution.available ? CheckCircle2 : CircleDashed;

  return (
    <div
      className={cn(
        "rounded-md border px-2 py-1.5 text-[10.5px] flex flex-col gap-0.5",
        contribution.available
          ? cn(tint.bg, tint.border)
          : "bg-gray-50 border-gray-200",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon
          className={cn(
            "h-3 w-3 shrink-0",
            contribution.available ? tint.text : "text-gray-400",
          )}
        />
        <span
          className={cn(
            "font-semibold truncate",
            contribution.available ? tint.text : "text-gray-600",
          )}
        >
          {contribution.label}
        </span>
        <StatusIcon
          className={cn(
            "h-3 w-3 ml-auto shrink-0",
            contribution.available ? "text-green-600" : "text-gray-300",
          )}
        />
      </div>
      <p
        className={cn(
          "text-[10px]",
          contribution.available ? "text-gray-700" : "text-gray-500",
        )}
      >
        {contribution.available
          ? contribution.columns_powered.length > 0
            ? `Powers ${contribution.columns_powered.length} column${
                contribution.columns_powered.length === 1 ? "" : "s"
              }`
            : "Uploaded — no template columns map yet"
          : "Not uploaded"}
        {contribution.available && contribution.row_count != null && (
          <>
            {" · "}
            <span className="text-gray-500">
              {contribution.row_count.toLocaleString()} row
              {contribution.row_count === 1 ? "" : "s"}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

function FieldLabel({
  htmlFor,
  className,
  children,
}: {
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        "block text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold mb-1",
        className,
      )}
    >
      {children}
    </label>
  );
}

// Tiny helper just for the dirty check.
function sortedKeys(obj: Record<string, string>): Array<[string, string]> {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}
