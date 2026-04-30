"use client";

import {
  AlertTriangle,
  ChevronDown,
  ClipboardList,
  Eye,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import type {
  PersistedExportRunRead,
  PersistedExportRunStatus,
  PersistedExportRunSummary,
} from "@/types/export-run-persistence";

import { useExportRuns } from "../hooks/useExportRuns";
import {
  EXPORT_RUN_STATUS_FILTER_OPTIONS,
  EXPORT_RUN_TARGET_SYSTEM_FILTER_OPTIONS,
  formatExportRunTimestamp,
  getPhaseLabel,
  getSourceLabel,
  getTargetSystemLabel,
} from "../lib/export-run-display";

import { ExportRunApprovalStatusBadge } from "./ExportRunApprovalStatusBadge";
import { ExportRunDetailPanel } from "./ExportRunDetailPanel";
import { ExportRunStatusBadge } from "./ExportRunStatusBadge";

/**
 * Phase 5C — Export Runs audit-list page.
 *
 * Sits under Settings → Export Runs. Displays the persisted draft
 * / audit catalog as a table; supports status + target-system
 * filtering, View detail (modal), and notes-only edit through
 * the detail panel.
 *
 * Diagnostic only — listing / opening / saving notes NEVER
 * triggers an export run, file generation, finalization, or
 * external posting. The page deliberately omits any
 * finalize / download / generate / post / mark-exported / delete
 * actions; the backend doesn't expose them either (Phase 5A
 * locks ``phase="draft"`` for every row).
 */
export function ExportRunsPage() {
  const [statusFilter, setStatusFilter] = useState<
    PersistedExportRunStatus | "all"
  >("all");
  const [targetSystemFilter, setTargetSystemFilter] = useState<
    string | "all"
  >("all");

  const list = useExportRuns({
    status: statusFilter === "all" ? null : statusFilter,
    targetSystem: targetSystemFilter === "all" ? null : targetSystemFilter,
  });

  // Detail panel state — modal that opens when the operator
  // clicks View on a row.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const handleOpenDetail = useCallback((id: string) => {
    setSelectedId(id);
    setDetailOpen(true);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setDetailOpen(false);
    // Keep ``selectedId`` set briefly so the modal's exit
    // animation (if added later) doesn't lose context. The next
    // open replaces it.
  }, []);

  // Phase 5D — when the detail panel saves notes, replace the
  // updated row in the existing list IN PLACE (no full refetch,
  // no Load More state reset). The PATCH response is the
  // canonical record; we project it onto the lighter list-summary
  // shape so the table cells stay in sync without firing a
  // separate GET. If the projection ever falls behind the wire
  // shape, the operator can still hit Refresh to force a clean
  // first-page load.
  const handleRecordSaved = useCallback(
    (record: PersistedExportRunRead) => {
      const summary: PersistedExportRunSummary = {
        id: record.id,
        status: record.status,
        phase: record.phase,
        source: record.source,
        export_profile_name: record.export_profile_name ?? null,
        export_profile_version: record.export_profile_version ?? null,
        target_system: record.target_system ?? null,
        row_count: record.row_count,
        blocked_row_count: record.blocked_row_count,
        warning_row_count: record.warning_row_count,
        issue_count: record.issue_count,
        // Phase 6B — propagate the freshest ``approval_status`` so
        // a successful approval transition (or notes save while a
        // record is in pending_review) reflects in the list row
        // without a full refetch.
        approval_status: record.approval_status,
        created_at: record.created_at,
        updated_at: record.updated_at,
      };
      list.replaceItem(summary);
    },
    [list],
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <header>
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-gray-500 dark:text-ink-subtle" />
          <h1 className="text-lg font-semibold text-gray-900 dark:text-ink">
            Export Runs
          </h1>
        </div>
        <p className="mt-1 text-[13px] text-gray-600 dark:text-ink-muted">
          Draft audit records only. No export files are generated
          from this page.
        </p>
      </header>

      {/* Boundary banner — always present so the operator can never
          misread the list as "exported". */}
      <div className="rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 text-[12px] text-blue-900 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-100">
        Export run records shown here are draft / audit records.
        They do not indicate finalized export, file generation,
        document status changes, or external posting. Production
        export remains unavailable.
      </div>

      {/* Filters */}
      <section className="flex flex-wrap items-end gap-3">
        <FilterSelect
          label="Status"
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as typeof statusFilter)}
          options={EXPORT_RUN_STATUS_FILTER_OPTIONS}
        />
        <FilterSelect
          label="Target system"
          value={targetSystemFilter}
          onChange={(v) => setTargetSystemFilter(v)}
          options={EXPORT_RUN_TARGET_SYSTEM_FILTER_OPTIONS}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={list.retry}
          disabled={list.loading}
          title="Reload the audit list."
          className="ml-auto"
        >
          {list.loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
      </section>

      {/* Error state */}
      {list.error && (
        <div
          className="rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-[12px] text-rose-900 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-100"
          role="alert"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-300" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Could not load draft audit records</p>
              <p className="mt-0.5 font-mono text-[10px] break-words">
                {list.error}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={list.retry}
              title="Retry loading the audit list."
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        </div>
      )}

      {/* Loading state — only when there's no prior data to keep
          visible during a refetch. */}
      {list.loading && list.items.length === 0 && !list.error && (
        <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading draft audit records…
        </div>
      )}

      {/* Empty state */}
      {!list.loading && list.items.length === 0 && !list.error && (
        <div className="rounded-md border border-dashed border-gray-300 bg-white px-4 py-6 text-center text-[12px] text-gray-600 dark:border-line dark:bg-surface-subtle dark:text-ink-muted">
          <p className="font-medium text-gray-800 dark:text-ink">
            No draft audit records yet
          </p>
          <p className="mt-1">
            Save a draft from the Operational Preview panel to
            populate this list. No export file is generated from
            either surface.
          </p>
        </div>
      )}

      {/* List table — Phase 5D wraps the table + the Load More
          control in a single section so the error / "all loaded"
          affordances render together with the rows. */}
      {list.items.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-line">
          <table className="min-w-full divide-y divide-gray-200 text-[12px] dark:divide-line">
            <thead className="bg-gray-50 dark:bg-surface-muted/60">
              <tr>
                <Th>Created</Th>
                <Th>Status</Th>
                <Th>Approval</Th>
                <Th>Phase</Th>
                <Th>Source</Th>
                <Th>Profile</Th>
                <Th>Target</Th>
                <Th align="right">Rows</Th>
                <Th align="right">Blocked</Th>
                <Th align="right">Warnings</Th>
                <Th align="right">Issues</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white dark:divide-line dark:bg-surface-subtle">
              {list.items.map((item) => (
                <tr
                  key={item.id}
                  className="hover:bg-gray-50 dark:hover:bg-surface-muted/40"
                >
                  <Td>{formatExportRunTimestamp(item.created_at)}</Td>
                  <Td>
                    <ExportRunStatusBadge status={item.status} />
                  </Td>
                  <Td>
                    <ExportRunApprovalStatusBadge
                      status={item.approval_status}
                    />
                  </Td>
                  <Td
                    className="font-mono text-[10.5px] uppercase tracking-wide"
                    title={`Phase: ${getPhaseLabel(item.phase)}`}
                  >
                    {item.phase || "—"}
                  </Td>
                  <Td
                    className="font-mono text-[10.5px]"
                    title={`Source: ${getSourceLabel(item.source)}`}
                  >
                    {item.source || "—"}
                  </Td>
                  <Td>
                    {item.export_profile_name ?? (
                      <span className="text-gray-400 dark:text-ink-subtle">
                        —
                      </span>
                    )}
                    {item.export_profile_version != null && (
                      <span className="ml-1 text-[10.5px] text-gray-500 dark:text-ink-subtle">
                        v{item.export_profile_version}
                      </span>
                    )}
                  </Td>
                  <Td>{getTargetSystemLabel(item.target_system)}</Td>
                  <Td align="right">{item.row_count}</Td>
                  <Td
                    align="right"
                    className={cn(
                      item.blocked_row_count > 0 &&
                        "text-rose-700 dark:text-rose-200",
                    )}
                  >
                    {item.blocked_row_count}
                  </Td>
                  <Td
                    align="right"
                    className={cn(
                      item.warning_row_count > 0 &&
                        "text-yellow-800 dark:text-yellow-200",
                    )}
                  >
                    {item.warning_row_count}
                  </Td>
                  <Td align="right">{item.issue_count}</Td>
                  <Td align="right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleOpenDetail(item.id)}
                      title="View this audit record."
                    >
                      <Eye className="h-3.5 w-3.5" />
                      View
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Phase 5D — Load More + load-more error + "all loaded"
          affordances. Rendered only when the first page has
          actually returned rows (no point dangling a Load More
          control under an empty list). */}
      {list.items.length > 0 && (
        <div className="flex flex-col items-center gap-2">
          {list.loadMoreError && (
            <div
              className="w-full rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-[12px] text-rose-900 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-100"
              role="alert"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-300" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    Could not load more draft audit records
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] break-words">
                    {list.loadMoreError}
                  </p>
                  <p className="mt-0.5 text-[11px]">
                    The records already shown above remain
                    available. Try Load more again to retry.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={list.loadMore}
                  disabled={list.loadingMore || !list.canLoadMore}
                  title="Retry loading the next page."
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              </div>
            </div>
          )}
          {list.canLoadMore ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={list.loadMore}
              disabled={list.loadingMore || list.loading}
              title="Load the next page of draft audit records."
            >
              {list.loadingMore ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              {list.loadingMore ? "Loading more…" : "Load more"}
            </Button>
          ) : (
            <p className="text-[11px] text-gray-500 dark:text-ink-subtle">
              All draft audit records loaded ({list.items.length}).
            </p>
          )}
        </div>
      )}

      <ExportRunDetailPanel
        runId={selectedId}
        open={detailOpen}
        onClose={handleCloseDetail}
        onRecordSaved={handleRecordSaved}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny render helpers
// ---------------------------------------------------------------------------

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px]">
      <span className="font-semibold uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[12px] text-gray-800 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300 dark:border-line dark:bg-surface-subtle dark:text-ink"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "right";
}) {
  return (
    <th
      className={cn(
        "px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wide text-gray-600 dark:text-ink-muted",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  className,
  title,
}: {
  children: React.ReactNode;
  align?: "right";
  className?: string;
  /** Phase 5D — optional native tooltip so the table can carry
   *  the operator-friendly label of a forward-compat phase / source
   *  literal without changing the visible cell value. */
  title?: string;
}) {
  return (
    <td
      className={cn(
        "px-3 py-2 align-middle text-gray-800 dark:text-ink",
        align === "right" && "text-right",
        className,
      )}
      title={title}
    >
      {children}
    </td>
  );
}
