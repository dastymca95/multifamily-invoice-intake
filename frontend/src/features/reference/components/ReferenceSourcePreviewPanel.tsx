"use client";

import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Layers3,
  MousePointerClick,
  Sparkles,
  Users,
} from "lucide-react";

import { InlineAlert } from "@/components/ui/InlineAlert";
import { cn, formatDate, formatFileSize } from "@/lib/utils";
import type { ReferenceKind, ReferenceSlot } from "@/types/reference";

import { detectKeyFields, prettyHeader } from "../lib/normalize";

const KIND_ICON: Record<
  ReferenceKind,
  React.ComponentType<{ className?: string }>
> = {
  properties: Building2,
  units: Layers3,
  vendors: Users,
  import_template: FileSpreadsheet,
};

/**
 * Right-side panel on the Reference Data page.
 *
 * Renders a Power Query-style normalized preview of whichever reference
 * source the user has clicked. Top-down:
 *
 *   1. Header — kind icon + kind label + filename + meta (size, date)
 *   2. One-line parsed summary (column / row counts) — or a parse-failure
 *      alert that short-circuits the rest
 *   3. Key fields caption — per-kind "spine" columns we identified
 *      (Name / Code / Address for properties, Unit / Property for units,
 *      Vendor / ID for vendors). Skipped for the import template.
 *   4. Normalized table — the parsed columns shown as a real bordered
 *      grid with sticky header row, sticky-left row index, prettified
 *      column titles, and the parser's up-to-5 sample rows. Key columns
 *      get a subtle brand tint so the spine pops at a glance.
 *
 * What this panel deliberately does NOT do:
 *   * Invent columns. Headers are pretty-formatted but never renamed,
 *     reordered, or hidden.
 *   * Show a "chip list of detected columns" — the chip blob has been
 *     replaced by the table itself, which is the better data answer.
 *
 * Width is owned by the parent layout (a grid cell inside
 * `ReferenceSourceWorkspace`); this panel just fills its container
 * vertically and manages its own scroll.
 */
interface ReferenceSourcePreviewPanelProps {
  selected: ReferenceSlot | null;
  /**
   * True when the user has uploaded something but selected nothing —
   * we render a hint inviting them to click a card. Lets the workspace
   * differentiate "nothing uploaded yet" from "uploaded, just nothing
   * selected".
   */
  hasAnyUploaded: boolean;
}

export function ReferenceSourcePreviewPanel({
  selected,
  hasAnyUploaded,
}: ReferenceSourcePreviewPanelProps) {
  return (
    <aside className="h-full w-full bg-white border border-gray-200 rounded-xl flex flex-col min-h-0 min-w-0 dark:bg-surface-subtle dark:border-line">
      <div className="px-4 py-3 border-b border-gray-200 shrink-0 dark:border-line">
        <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2 dark:text-ink">
          <FileText className="h-4 w-4 text-brand-700 dark:text-brand-50" />
          Source preview
        </h2>
        <p className="text-[10.5px] text-gray-500 mt-0.5 dark:text-ink-muted">
          Cleaned, table-style view of the selected source. Drag the divider
          on the left to widen this panel when you need to inspect more
          columns.
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {selected == null ? (
          <EmptyHint hasAnyUploaded={hasAnyUploaded} />
        ) : selected.current == null ? (
          <NotUploaded slot={selected} />
        ) : (
          <PopulatedPreview slot={selected} />
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Empty / not-yet-uploaded states
// ---------------------------------------------------------------------------

function EmptyHint({ hasAnyUploaded }: { hasAnyUploaded: boolean }) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="mx-auto h-10 w-10 rounded-full bg-gray-100 flex items-center justify-center mb-2 dark:bg-surface-muted">
        <MousePointerClick className="h-5 w-5 text-gray-500 dark:text-ink-subtle" />
      </div>
      <p className="text-sm font-medium text-gray-700 dark:text-ink">
        Select a source to inspect
      </p>
      <p className="text-[11px] text-gray-500 mt-1 max-w-xs mx-auto dark:text-ink-muted">
        {hasAnyUploaded
          ? "Click any card on the left to preview its parsed columns and sample rows."
          : "Once you upload one of the four reference files, click its card to see the parsed contents here."}
      </p>
    </div>
  );
}

function NotUploaded({ slot }: { slot: ReferenceSlot }) {
  const Icon = KIND_ICON[slot.kind];
  return (
    <div className="px-4 py-10 text-center">
      <div className="mx-auto h-10 w-10 rounded-full bg-gray-100 flex items-center justify-center mb-2 dark:bg-surface-muted">
        <Icon className="h-5 w-5 text-gray-500 dark:text-ink-subtle" />
      </div>
      <p className="text-sm font-medium text-gray-700 dark:text-ink">
        {slot.label} not uploaded yet
      </p>
      <p className="text-[11px] text-gray-500 mt-1 max-w-xs mx-auto dark:text-ink-muted">
        Upload a file using the card on the left to see its parsed columns
        and sample rows here.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Populated state
// ---------------------------------------------------------------------------

function PopulatedPreview({ slot }: { slot: ReferenceSlot }) {
  const current = slot.current!;
  const Icon = KIND_ICON[slot.kind];
  const parseFailed = current.parse_status === "parse_failed";
  const isTemplate = slot.kind === "import_template";
  const cols = current.parsed_columns ?? [];
  const sample = current.sample_rows ?? [];
  const keyFields = detectKeyFields(slot.kind, cols);
  const keyColumnSet = new Set(keyFields.map((k) => k.columnName));

  return (
    <div className="px-4 py-3 space-y-3">
      {/* ---- Header: filename + meta ------------------------------- */}
      <div className="flex items-start gap-2">
        <div
          className={cn(
            "h-9 w-9 shrink-0 rounded-md flex items-center justify-center",
            parseFailed
              ? "bg-yellow-100 dark:bg-yellow-950/40"
              : "bg-brand-50 dark:bg-brand-900/40",
          )}
        >
          <Icon
            className={cn(
              "h-4 w-4",
              parseFailed
                ? "text-yellow-700 dark:text-yellow-200"
                : "text-brand-700 dark:text-brand-50",
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-gray-400 font-semibold dark:text-ink-subtle">
            {slot.label}
          </p>
          <p
            className="text-[12.5px] font-semibold text-gray-800 truncate dark:text-ink"
            title={current.original_filename}
          >
            {current.original_filename}
          </p>
          <p className="text-[10.5px] text-gray-500 dark:text-ink-muted">
            {formatFileSize(current.file_size_bytes)}
            <span className="mx-1.5 text-gray-300 dark:text-line-strong">·</span>
            Updated {formatDate(current.updated_at)}
          </p>
        </div>
      </div>

      {/* ---- Parse failure short-circuit -------------------------- */}
      {parseFailed ? (
        <InlineAlert
          tone="warning"
          title="Stored — but BillsIQ couldn't parse it"
        >
          {current.parse_error ??
            "Parser returned no details. Try re-exporting and uploading again."}
        </InlineAlert>
      ) : (
        <>
          {/* ---- One-line parsed summary ---------------------------- */}
          <p className="text-[11.5px] text-gray-700 dark:text-ink inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
            <span>
              <span className="font-medium">{cols.length}</span> column
              {cols.length === 1 ? "" : "s"}
              {current.parsed_row_count != null && (
                <>
                  <span className="text-gray-300 mx-1 dark:text-line-strong">·</span>
                  <span className="font-medium">
                    {current.parsed_row_count.toLocaleString()}
                  </span>{" "}
                  row{current.parsed_row_count === 1 ? "" : "s"}
                </>
              )}
            </span>
          </p>

          {/* ---- Per-kind "key fields" caption --------------------- */}
          {keyFields.length > 0 && (
            <div className="rounded-md border border-gray-200 bg-gray-50/80 px-2.5 py-1.5 dark:border-line dark:bg-surface-muted/80">
              <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold inline-flex items-center gap-1 mb-1 dark:text-ink-subtle">
                <Sparkles className="h-3 w-3" />
                Key fields detected
              </p>
              <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                {keyFields.map((k) => (
                  <li
                    key={k.label}
                    className="inline-flex items-baseline gap-1"
                  >
                    <span className="text-gray-500 dark:text-ink-muted">
                      {k.label}:
                    </span>
                    <span
                      className="font-medium text-gray-800 dark:text-ink"
                      title={`Source column: ${k.columnName}`}
                    >
                      {prettyHeader(k.columnName)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ---- Normalized preview table -------------------------- */}
          {cols.length > 0 ? (
            <NormalizedTable
              columns={cols}
              rows={sample}
              keyColumnSet={keyColumnSet}
            />
          ) : (
            <p className="text-[11px] text-gray-500 italic dark:text-ink-muted">
              File stored — parser found no header columns.
            </p>
          )}

          {/* ---- Footer caveats ----------------------------------- */}
          {isTemplate ? (
            <InlineAlert tone="info">
              <span className="text-[11px]">
                This template defines the column shape of every saved
                Import Builder configuration.
              </span>
            </InlineAlert>
          ) : (
            <p className="text-[11px] text-gray-500 inline-flex items-start gap-1.5 dark:text-ink-muted">
              <AlertTriangle className="h-3 w-3 text-gray-400 shrink-0 mt-0.5 dark:text-ink-subtle" />
              <span>
                Lookups today match against this sampled subset — full-file
                matching is a future phase.
              </span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Normalized table renderer
// ---------------------------------------------------------------------------

/**
 * Bordered "Excel-feel" preview grid. Visually mirrors the Import
 * Builder's PreviewSpreadsheet (sticky header row, sticky-left row
 * index, alternating row tint) so users see one consistent
 * spreadsheet shell across both pages — they're inspecting the same
 * kind of thing, just at different stages of the pipeline.
 */
function NormalizedTable({
  columns,
  rows,
  keyColumnSet,
}: {
  columns: string[];
  rows: Array<Record<string, string>>;
  keyColumnSet: Set<string>;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold dark:text-ink-subtle">
          Normalized preview
        </p>
        <p className="text-[10px] text-gray-400 dark:text-ink-subtle">
          {rows.length === 0
            ? "headers only"
            : `${rows.length} sample row${rows.length === 1 ? "" : "s"}`}
        </p>
      </div>

      <div className="relative overflow-auto rounded-md border border-gray-200 dark:border-line">
        <table className="min-w-full text-[11px] border-collapse">
          <thead className="sticky top-0 z-20 bg-gray-50 dark:bg-surface-muted">
            <tr>
              <th className="sticky left-0 z-30 bg-gray-100 border-r border-b border-gray-200 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wide w-[3rem] min-w-[3rem] dark:bg-surface-muted dark:border-line dark:text-ink-subtle">
                #
              </th>
              {columns.map((col, i) => {
                const isKey = keyColumnSet.has(col);
                return (
                  <th
                    key={`${col}-${i}`}
                    className={cn(
                      "border-r border-b border-gray-200 px-2 py-1.5 text-left align-top whitespace-nowrap dark:border-line",
                      isKey
                        ? "bg-brand-50/70 dark:bg-brand-900/30"
                        : "bg-gray-50 dark:bg-surface-muted",
                    )}
                    title={col}
                  >
                    <div className="flex flex-col gap-0.5">
                      <span
                        className={cn(
                          "font-semibold text-[11.5px]",
                          isKey
                            ? "text-brand-900 dark:text-brand-50"
                            : "text-gray-800 dark:text-ink",
                        )}
                      >
                        {prettyHeader(col)}
                      </span>
                      <span
                        className={cn(
                          "font-mono text-[9.5px] truncate max-w-[14rem]",
                          isKey
                            ? "text-brand-700/80 dark:text-brand-50/80"
                            : "text-gray-400 dark:text-ink-subtle",
                        )}
                      >
                        {col}
                      </span>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="px-3 py-4 text-center text-[11px] text-gray-500 italic bg-white dark:bg-surface dark:text-ink-muted"
                >
                  Header row parsed — no sample rows captured.
                </td>
              </tr>
            ) : (
              rows.map((row, ri) => {
                const stripeClass =
                  ri % 2 === 0
                    ? "bg-white dark:bg-surface"
                    : "bg-gray-50/40 dark:bg-surface-muted/40";
                return (
                  <tr key={ri} className={stripeClass}>
                    <th
                      className={cn(
                        "sticky left-0 z-10 border-r border-b border-gray-200 px-2 py-1 text-left align-top text-[10px] font-mono text-gray-400 w-[3rem] min-w-[3rem] dark:border-line dark:text-ink-subtle",
                        stripeClass,
                      )}
                    >
                      {ri + 1}
                    </th>
                    {columns.map((col, ci) => {
                      const value = row[col] ?? "";
                      const isKey = keyColumnSet.has(col);
                      const isEmpty = value === "";
                      return (
                        <td
                          key={`${ci}-${col}`}
                          className={cn(
                            "border-r border-b border-gray-200 px-2 py-1 align-top whitespace-nowrap max-w-[16rem] truncate dark:border-line",
                            isEmpty
                              ? "text-gray-300 italic dark:text-ink-subtle"
                              : "text-gray-700 dark:text-ink-muted",
                            isKey &&
                              !isEmpty &&
                              "font-medium text-gray-900 dark:text-ink",
                          )}
                          title={
                            isEmpty
                              ? `(empty) — ${prettyHeader(col)}`
                              : `${prettyHeader(col)}: ${value}`
                          }
                        >
                          {isEmpty ? "—" : value}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && (
        <p className="text-[10px] text-gray-400 italic mt-1 dark:text-ink-subtle">
          Showing the parser&apos;s up-to-5 sampled rows — not the full file.
          Cell-level lookups today match against this sampled subset.
        </p>
      )}
    </div>
  );
}
