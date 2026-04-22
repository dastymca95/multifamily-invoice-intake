"use client";

import { AlertCircle, FileSpreadsheet, Info, Pin, Table2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  CellStatus,
  ColumnRole,
  PreviewCell,
  PreviewColumn,
  PreviewRow,
  ReferenceSource,
  ResmanPreviewResponse,
} from "@/types/resman-preview";

/**
 * Reusable spreadsheet renderer for the ResMan import preview.
 *
 * Pure presentational — no fetching, no header chrome. The Import
 * Builder workspace wraps this with its own header (config name +
 * row-limit dropdown + save button), so factoring the table out keeps
 * the renderer reusable across "raw preview" and "config-driven preview"
 * surfaces.
 *
 * Layout strategy:
 *   - Outer wrapper has horizontal scroll
 *   - <thead> uses `sticky top-0` so the column-name + role-pill row
 *     stays visible while the parent scrolls vertically
 *   - First column (row label) uses `sticky left-0` + a higher z-index
 *     so it stays visible when scrolling horizontally
 *   - Cells get a subtle border on all sides for an Excel feel
 */

interface PreviewSpreadsheetProps {
  data: ResmanPreviewResponse;
  /**
   * Optional callback when a column header is clicked. Lets the
   * Import Builder open a "pin role" menu without this component
   * having to know what that UI looks like.
   */
  onColumnClick?: (columnName: string) => void;
  /** Cap the table's vertical extent (CSS max-height). Defaults to "28rem". */
  maxHeight?: string;
}

export function PreviewSpreadsheet({
  data,
  onColumnClick,
  maxHeight = "28rem",
}: PreviewSpreadsheetProps) {
  if (!data.has_template) {
    return (
      <div className="border-2 border-dashed border-gray-200 rounded-md px-6 py-10 text-center">
        <FileSpreadsheet className="h-8 w-8 text-gray-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-gray-700">
          No import template uploaded yet
        </p>
        <p className="text-xs text-gray-500 mt-1 max-w-md mx-auto">
          Upload your default ResMan invoice import template on the Reference
          Data page to define the column shape of this preview.
        </p>
      </div>
    );
  }

  if (data.rows.length === 0) {
    return (
      <div className="border-2 border-dashed border-gray-200 rounded-md px-6 py-10 text-center">
        <Table2 className="h-8 w-8 text-gray-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-gray-700">
          Template loaded — no rows to preview yet
        </p>
        <p className="text-xs text-gray-500 mt-1 max-w-md mx-auto">
          Upload at least one reference report (vendor / property / unit) on
          the Reference Data page to see synthetic rows, or approve invoices
          in the review queue to see real rows here.
        </p>
      </div>
    );
  }

  return (
    <div
      className="relative overflow-auto rounded-md border border-gray-200"
      style={{ maxHeight }}
    >
      <table className="min-w-full text-[11px] border-collapse">
        <thead className="sticky top-0 z-20 bg-gray-50">
          <tr>
            <th className="sticky left-0 z-30 bg-gray-100 border-r border-b border-gray-200 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wide w-[8rem] min-w-[8rem]">
              Row
            </th>
            {data.columns.map((c, i) => (
              <ColumnHeaderCell
                key={`${c.name}-${i}`}
                column={c}
                onClick={onColumnClick}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, ri) => (
            <PreviewTableRow
              key={ri}
              row={row}
              rowIndex={ri}
              columns={data.columns}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source tints — shared between header pills and the contributions panel.
// ---------------------------------------------------------------------------

export const SOURCE_TINT: Record<
  ReferenceSource,
  { bg: string; text: string; border: string }
> = {
  import_template: {
    bg: "bg-blue-50",
    text: "text-blue-800",
    border: "border-blue-200",
  },
  vendor_report: {
    bg: "bg-purple-50",
    text: "text-purple-800",
    border: "border-purple-200",
  },
  property_report: {
    bg: "bg-emerald-50",
    text: "text-emerald-800",
    border: "border-emerald-200",
  },
  unit_report: {
    bg: "bg-amber-50",
    text: "text-amber-900",
    border: "border-amber-200",
  },
};

// ---------------------------------------------------------------------------
// Header cell — name + role pill + (optional) override marker
// ---------------------------------------------------------------------------

function ColumnHeaderCell({
  column,
  onClick,
}: {
  column: PreviewColumn;
  onClick?: (columnName: string) => void;
}) {
  const tint = column.populated_from ? SOURCE_TINT[column.populated_from] : null;
  const isUnmapped = column.role === "unmapped";
  const clickable = onClick != null;

  return (
    <th
      className={cn(
        "border-r border-b border-gray-200 px-2 py-1.5 text-left align-top whitespace-nowrap",
        isUnmapped && "bg-gray-50",
        clickable && "cursor-pointer hover:bg-brand-50/50",
      )}
      onClick={clickable ? () => onClick?.(column.name) : undefined}
      title={
        column.role_overridden
          ? `Pinned role — click to change`
          : isUnmapped
            ? "This template column doesn't match any known role yet" +
              (clickable ? " — click to assign one" : "")
            : column.populated_from
              ? `Populated from ${column.populated_from.replace(
                  "_",
                  " ",
                )}` + (clickable ? " — click to override the role" : "")
              : "Populated from extracted invoices" +
                (clickable ? " — click to override the role" : "")
      }
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1">
          <span
            className={cn(
              "font-semibold text-[11.5px]",
              isUnmapped ? "text-gray-500 italic" : "text-gray-800",
            )}
          >
            {column.name}
          </span>
          {column.role_overridden && (
            <Pin
              className="h-3 w-3 text-brand-600 shrink-0"
              aria-label="Role pinned by override"
            />
          )}
        </div>
        <span
          className={cn(
            "inline-flex items-center self-start rounded px-1 text-[9.5px] font-mono lowercase",
            column.role_overridden
              ? "bg-brand-50 text-brand-800 border border-brand-200"
              : tint
                ? cn(tint.bg, tint.text, tint.border, "border")
                : isUnmapped
                  ? "bg-gray-100 text-gray-500 border border-gray-200"
                  : "bg-green-50 text-green-800 border border-green-200",
          )}
        >
          {prettyRole(column.role)}
        </span>
      </div>
    </th>
  );
}

export function prettyRole(role: ColumnRole): string {
  // Replace underscores → spaces. Keeps the backend enum stable while
  // making the UI feel less code-y.
  return role.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Body row + cells
// ---------------------------------------------------------------------------

function PreviewTableRow({
  row,
  rowIndex,
  columns,
}: {
  row: PreviewRow;
  rowIndex: number;
  columns: PreviewColumn[];
}) {
  return (
    <tr className={rowIndex % 2 === 0 ? "bg-white" : "bg-gray-50/40"}>
      <th
        className={cn(
          "sticky left-0 z-10 border-r border-b border-gray-200 px-2 py-1 text-left font-medium text-gray-700 align-top",
          rowIndex % 2 === 0 ? "bg-white" : "bg-gray-50/40",
        )}
        title={
          row.origin === "synthetic"
            ? "Synthetic preview row built from reference samples"
            : "Approved invoice"
        }
      >
        <div className="flex items-center gap-1">
          <span className="truncate max-w-[7rem]">{row.label}</span>
          {row.origin === "synthetic" && (
            <span className="text-[8.5px] uppercase font-semibold text-gray-400">
              sample
            </span>
          )}
        </div>
      </th>
      {row.cells.map((cell, ci) => (
        <PreviewCellTd
          key={ci}
          cell={cell}
          columnName={columns[ci]?.name ?? `col-${ci}`}
        />
      ))}
    </tr>
  );
}

function PreviewCellTd({
  cell,
  columnName,
}: {
  cell: PreviewCell;
  columnName: string;
}) {
  return (
    <td
      className={cn(
        "border-r border-b border-gray-200 px-2 py-1 align-top whitespace-nowrap max-w-[14rem]",
        cellBackground(cell.status),
      )}
      title={
        cell.note
          ? `${columnName}: ${cell.note}`
          : cell.value
            ? `${columnName}: ${cell.value}`
            : columnName
      }
    >
      <PreviewCellInner cell={cell} />
    </td>
  );
}

function PreviewCellInner({ cell }: { cell: PreviewCell }) {
  if (cell.status === "unmapped") {
    return (
      <span className="inline-flex items-center gap-1 text-gray-400 italic">
        <span className="font-mono">/</span>
        <span className="text-[10px]">no rule</span>
      </span>
    );
  }
  if (cell.status === "unresolved") {
    return (
      <span className="inline-flex items-center gap-1 text-yellow-800">
        {cell.value ? (
          <>
            <AlertCircle className="h-3 w-3 text-yellow-600 shrink-0" />
            <span className="truncate">{cell.value}</span>
          </>
        ) : (
          <span className="font-mono text-yellow-700/70">—</span>
        )}
        {cell.note && (
          <Info className="h-3 w-3 text-yellow-500 ml-0.5 shrink-0" />
        )}
      </span>
    );
  }
  // status === "ok"
  return (
    <span className="inline-flex items-center gap-1 text-gray-800">
      <span className="truncate">{cell.value ?? ""}</span>
      {cell.note && (
        <Info className="h-3 w-3 text-gray-300 ml-0.5 shrink-0" />
      )}
    </span>
  );
}

function cellBackground(status: CellStatus): string {
  switch (status) {
    case "ok":
      return "";
    case "unresolved":
      return "bg-yellow-50/60";
    case "unmapped":
      // A subtle diagonal-stripe pattern via Tailwind's bg-[image] arbitrary
      // value — distinguishes "no rule" cells from "missing value" cells
      // at a glance without shouting.
      return "bg-[repeating-linear-gradient(45deg,#f9fafb,#f9fafb_4px,#f3f4f6_4px,#f3f4f6_8px)]";
  }
}
