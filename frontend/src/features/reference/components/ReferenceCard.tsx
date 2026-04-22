"use client";

import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Layers3,
  Loader2,
  Replace,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { cn, formatDate, formatFileSize } from "@/lib/utils";
import type { ReferenceKind, ReferenceSlot } from "@/types/reference";

import type { SlotUiState } from "../hooks/useReferenceData";

const KIND_ICON: Record<ReferenceKind, React.ComponentType<{ className?: string }>> = {
  properties: Building2,
  units: Layers3,
  vendors: Users,
  import_template: FileSpreadsheet,
};

/** Accepted on the file picker. The backend validates the same set. */
const ACCEPT_ATTR = ".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv";

interface ReferenceCardProps {
  slot: ReferenceSlot;
  state: SlotUiState;
  onUpload: (file: File) => void;
  onRemove: () => void;
  /**
   * When true, the card is part of a "select-to-inspect" grid: clicking
   * the body (outside the upload picker) calls `onSelect` so the side
   * panel can render the parsed contents. The selected card gets a
   * subtle ring + brand background.
   */
  selected?: boolean;
  onSelect?: () => void;
  /**
   * Compact mode hides the per-card column-chip list + sample-rows
   * toggle. Used when a side panel takes over the deep-inspection job
   * (Reference Data page) so the card itself stays small enough that
   * all four fit at a glance.
   */
  compact?: boolean;
}

/**
 * One card per reference kind. Two visual states:
 *
 *  1. Empty — header + description + drag/click upload zone
 *  2. Populated — header + filename + parse status + row count +
 *     detected columns + sample rows preview + Replace + Remove
 *
 * The card is the same size in both states so the page grid doesn't
 * jump when a single kind's upload completes.
 */
export function ReferenceCard({
  slot,
  state,
  onUpload,
  onRemove,
  selected = false,
  onSelect,
  compact = false,
}: ReferenceCardProps) {
  const Icon = KIND_ICON[slot.kind];
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showSample, setShowSample] = useState(false);
  // Inline confirm before destructive remove. Two-step rather than a
  // modal because cards are small and a modal here would feel heavy
  // for what's essentially "drop a file".
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const handlePickFile = () => {
    if (state.uploading || state.removing) return;
    fileInputRef.current?.click();
  };
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onUpload(f);
    // Reset so picking the same filename again still triggers onChange.
    e.target.value = "";
  };
  const handleConfirmRemove = () => {
    setConfirmingRemove(false);
    onRemove();
  };

  const current = slot.current;
  const isPopulated = current != null;
  const parseFailed = current?.parse_status === "parse_failed";
  const hasColumns =
    current?.parsed_columns != null && current.parsed_columns.length > 0;
  // When the card is part of a select-to-inspect grid, clicking
  // anywhere on it (outside the upload affordances) selects it. We
  // attach the click handler to the outer section but only when
  // `onSelect` is provided so the standalone card behaves the same
  // as before.
  const handleSectionClick = onSelect
    ? (e: React.MouseEvent<HTMLElement>) => {
        // Don't hijack clicks on interactive children (buttons, inputs, etc).
        const target = e.target as HTMLElement;
        if (target.closest("button, input, a, label, select, textarea")) {
          return;
        }
        onSelect();
      }
    : undefined;

  return (
    <section
      className={cn(
        "bg-white rounded-xl border flex flex-col transition-shadow",
        onSelect && "cursor-pointer hover:shadow-sm",
        selected && "ring-2 ring-brand-500 border-brand-200",
      )}
      onClick={handleSectionClick}
      aria-pressed={onSelect ? selected : undefined}
    >
      {/* ---- Header (always present) --------------------------------- */}
      <div className="px-4 py-3 border-b flex items-start gap-3">
        <div
          className={cn(
            "h-9 w-9 shrink-0 rounded-md flex items-center justify-center",
            isPopulated
              ? parseFailed
                ? "bg-yellow-100"
                : "bg-brand-50"
              : "bg-gray-100",
          )}
        >
          <Icon
            className={cn(
              "h-4 w-4",
              isPopulated
                ? parseFailed
                  ? "text-yellow-700"
                  : "text-brand-700"
                : "text-gray-500",
            )}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-800">
              {slot.label}
            </h2>
            <StatusBadge populated={isPopulated} parseFailed={parseFailed} />
          </div>
          <p className="text-[11.5px] text-gray-500 mt-0.5">
            {slot.description}
          </p>
        </div>
      </div>

      {/* ---- Body ---------------------------------------------------- */}
      <div className="p-4 flex-1 flex flex-col gap-3">
        {!isPopulated && (
          <EmptyState
            uploading={state.uploading}
            uploadProgress={state.uploadProgress}
            error={state.error}
            onPick={handlePickFile}
          />
        )}

        {isPopulated && current && (
          <PopulatedState
            slotKind={slot.kind}
            current={current}
            state={state}
            showSample={showSample}
            onToggleSample={() => setShowSample((v) => !v)}
            onReplace={handlePickFile}
            confirmingRemove={confirmingRemove}
            onAskRemove={() => setConfirmingRemove(true)}
            onCancelRemove={() => setConfirmingRemove(false)}
            onConfirmRemove={handleConfirmRemove}
            compact={compact}
          />
        )}

        {/* Hidden picker — triggered by Replace / Upload buttons. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Status badge — single source of truth so header + body don't drift.
// ---------------------------------------------------------------------------

function StatusBadge({
  populated,
  parseFailed,
}: {
  populated: boolean;
  parseFailed: boolean;
}) {
  if (!populated) return <Badge color="gray">Not uploaded</Badge>;
  if (parseFailed) return <Badge color="yellow">Stored, parse failed</Badge>;
  return <Badge color="green">Parsed</Badge>;
}

// ---------------------------------------------------------------------------
// Empty state — friendly upload affordance + per-card error
// ---------------------------------------------------------------------------

function EmptyState({
  uploading,
  uploadProgress,
  error,
  onPick,
}: {
  uploading: boolean;
  uploadProgress: number;
  error: string | null;
  onPick: () => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onPick}
        disabled={uploading}
        className={cn(
          "border-2 border-dashed rounded-md px-4 py-6 text-center transition-colors",
          "flex flex-col items-center justify-center gap-1.5",
          uploading
            ? "border-brand-300 bg-brand-50/50 cursor-wait"
            : "border-gray-200 hover:border-brand-300 hover:bg-brand-50/40",
        )}
      >
        {uploading ? (
          <>
            <Loader2 className="h-5 w-5 text-brand-600 animate-spin" />
            <p className="text-xs font-medium text-brand-700">
              Uploading… {uploadProgress}%
            </p>
          </>
        ) : (
          <>
            <Upload className="h-5 w-5 text-gray-400" />
            <p className="text-xs font-medium text-gray-700">
              Click to upload
            </p>
            <p className="text-[10.5px] text-gray-400">
              .csv or .xlsx — up to the configured size limit
            </p>
          </>
        )}
      </button>
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Populated state — file meta + columns + sample + actions
// ---------------------------------------------------------------------------

function PopulatedState({
  slotKind,
  current,
  state,
  showSample,
  onToggleSample,
  onReplace,
  confirmingRemove,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
  compact = false,
}: {
  slotKind: ReferenceKind;
  current: NonNullable<ReferenceSlot["current"]>;
  state: SlotUiState;
  showSample: boolean;
  onToggleSample: () => void;
  onReplace: () => void;
  confirmingRemove: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
  compact?: boolean;
}) {
  const parseFailed = current.parse_status === "parse_failed";
  const isTemplate = slotKind === "import_template";
  const cols = current.parsed_columns ?? [];

  return (
    <>
      {/* ---- Filename + meta row ------------------------------------- */}
      <div className="flex items-start gap-2">
        <FileText className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p
            className="text-[12.5px] font-medium text-gray-800 truncate"
            title={current.original_filename}
          >
            {current.original_filename}
          </p>
          <p className="text-[10.5px] text-gray-500 mt-0.5">
            {formatFileSize(current.file_size_bytes)}
            <span className="mx-1.5 text-gray-300">·</span>
            Updated {formatDate(current.updated_at)}
          </p>
        </div>
      </div>

      {/* ---- Parse summary OR parse failure message ----------------- */}
      {parseFailed ? (
        <InlineAlert
          tone="warning"
          title="File stored — but BillsIQ couldn't parse it"
        >
          {current.parse_error ??
            "Parser returned no details. Try re-exporting and uploading again."}
        </InlineAlert>
      ) : compact ? (
        // Compact mode: a one-liner summary only — the side panel
        // handles the deep "what's actually in this file" inspection.
        <CompactParsedLine
          rowCount={current.parsed_row_count}
          columnCount={cols.length}
          isTemplate={isTemplate}
        />
      ) : (
        <ParsedSummary
          rowCount={current.parsed_row_count}
          columns={cols}
          isTemplate={isTemplate}
          showSample={showSample}
          sampleRows={current.sample_rows ?? []}
          onToggleSample={onToggleSample}
        />
      )}

      {/* ---- Per-card error (e.g. failed remove) -------------------- */}
      {state.error && <InlineAlert tone="error">{state.error}</InlineAlert>}

      {/* ---- Inline confirm before remove --------------------------- */}
      {confirmingRemove && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2.5 text-[11.5px] text-yellow-900 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-yellow-700" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Remove this reference file?</p>
            <p className="mt-0.5 text-yellow-900/80">
              The stored file and its parsed columns will be cleared. You can
              upload a replacement at any time.
            </p>
            <div className="mt-2 flex items-center gap-1.5">
              <Button
                type="button"
                variant="primary"
                size="sm"
                loading={state.removing}
                onClick={onConfirmRemove}
                disabled={state.removing}
              >
                Yes, remove
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onCancelRemove}
                disabled={state.removing}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Action row -------------------------------------------- */}
      <div className="flex items-center gap-1.5 pt-1">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={state.uploading}
          onClick={onReplace}
          disabled={state.uploading || state.removing}
        >
          <Replace className="h-3.5 w-3.5" />
          {state.uploading
            ? `Replacing… ${state.uploadProgress}%`
            : "Replace file"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onAskRemove}
          disabled={state.uploading || state.removing || confirmingRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Compact parsed line — used when a side panel takes over deep inspection.
// ---------------------------------------------------------------------------

function CompactParsedLine({
  rowCount,
  columnCount,
  isTemplate,
}: {
  rowCount: number | null;
  columnCount: number;
  isTemplate: boolean;
}) {
  if (columnCount === 0) {
    return (
      <p className="text-[11.5px] text-gray-500 inline-flex items-center gap-1">
        <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
        File stored — no columns detected.
      </p>
    );
  }
  return (
    <p className="text-[11.5px] text-gray-700 inline-flex items-center gap-1.5 flex-wrap">
      <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
      <span>
        <span className="font-medium">{columnCount}</span> column
        {columnCount === 1 ? "" : "s"}
        {rowCount != null && (
          <>
            <span className="text-gray-300 mx-1">·</span>
            <span className="font-medium">{rowCount.toLocaleString()}</span>{" "}
            row{rowCount === 1 ? "" : "s"}
          </>
        )}
      </span>
      {isTemplate && (
        <Badge color="blue" className="text-[9.5px] py-0">
          Required export shape
        </Badge>
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Parsed-summary block — row count + columns chip list + optional sample
// ---------------------------------------------------------------------------

function ParsedSummary({
  rowCount,
  columns,
  isTemplate,
  showSample,
  sampleRows,
  onToggleSample,
}: {
  rowCount: number | null;
  columns: string[];
  isTemplate: boolean;
  showSample: boolean;
  sampleRows: Array<Record<string, string>>;
  onToggleSample: () => void;
}) {
  if (columns.length === 0) {
    return (
      <p className="text-[11.5px] text-gray-500 inline-flex items-center gap-1">
        <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
        File stored — no columns detected.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {/* ---- One-line summary -------------------------------------- */}
      <div className="text-[11.5px] text-gray-700 flex items-center gap-1.5 flex-wrap">
        <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
        <span>
          <span className="font-medium">{columns.length}</span>{" "}
          column{columns.length === 1 ? "" : "s"}
          {rowCount != null && (
            <>
              <span className="text-gray-300 mx-1">·</span>
              <span className="font-medium">{rowCount.toLocaleString()}</span>{" "}
              row{rowCount === 1 ? "" : "s"}
            </>
          )}
        </span>
        {/* The template's columns ARE the export shape — make that obvious. */}
        {isTemplate && (
          <Badge color="blue" className="text-[9.5px] py-0">
            Required export shape
          </Badge>
        )}
      </div>

      {/* ---- Detected-columns chip list ---------------------------- */}
      <div>
        <p className="text-[10.5px] uppercase tracking-wide text-gray-400 font-semibold mb-1">
          Detected columns
        </p>
        <div className="flex flex-wrap gap-1">
          {columns.map((col, i) => (
            <span
              key={`${col}-${i}`}
              className={cn(
                "inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-mono",
                isTemplate
                  ? "bg-blue-50 text-blue-800 border border-blue-100"
                  : "bg-gray-50 text-gray-700 border border-gray-200",
              )}
              title={col}
            >
              {col}
            </span>
          ))}
        </div>
      </div>

      {/* ---- Sample-rows toggle ------------------------------------ */}
      {sampleRows.length > 0 && (
        <div>
          <button
            type="button"
            onClick={onToggleSample}
            className="text-[11px] font-medium text-brand-600 hover:text-brand-700 hover:underline"
          >
            {showSample
              ? "Hide sample rows"
              : `Preview ${sampleRows.length} sample row${
                  sampleRows.length === 1 ? "" : "s"
                }`}
          </button>
          {showSample && (
            <div className="mt-1.5 overflow-x-auto rounded-md border border-gray-200">
              <table className="min-w-full text-[10.5px]">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    {columns.map((col, i) => (
                      <th
                        key={`${col}-${i}`}
                        className="px-2 py-1.5 text-left font-medium whitespace-nowrap border-b border-gray-200"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sampleRows.map((row, ri) => (
                    <tr
                      key={ri}
                      className={ri % 2 === 0 ? "bg-white" : "bg-gray-50/50"}
                    >
                      {columns.map((col, ci) => (
                        <td
                          key={`${ci}-${col}`}
                          className="px-2 py-1 align-top text-gray-700 whitespace-nowrap max-w-[14rem] truncate"
                          title={row[col] ?? ""}
                        >
                          {row[col] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
