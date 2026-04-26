"use client";

import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { UsedByDependent, UsedByReport } from "@/types/dependencies";

interface DependencyBlockerDialogProps {
  open: boolean;
  report: UsedByReport | null;
  onClose: () => void;
}

export function DependencyBlockerDialog({
  open,
  report,
  onClose,
}: DependencyBlockerDialogProps) {
  const blockers =
    report?.dependents.filter((d) => d.severity === "blocking") ?? [];
  const visibleDependents =
    blockers.length > 0 ? blockers : (report?.dependents ?? []);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cannot delete - still in use"
      size="lg"
    >
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="mt-0.5 rounded-md bg-red-50 p-2 text-red-600 dark:bg-red-950/40 dark:text-red-300">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-ink">
              This item is referenced by other Rivera workflows.
            </p>
            <p className="mt-1 text-xs text-gray-600 dark:text-ink-muted">
              Remove or change these dependencies before deleting{" "}
              {report?.resource_label ?? "this item"}.
            </p>
          </div>
        </div>

        <div className="max-h-[22rem] overflow-auto rounded-md border border-gray-200 dark:border-line">
          {visibleDependents.map((dependent, idx) => (
            <DependentRow
              key={[
                dependent.dependent_type,
                dependent.dependent_id ?? "none",
                dependent.location ?? idx,
              ].join("-")}
              dependent={dependent}
            />
          ))}
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-gray-500 dark:text-ink-muted">
            {report
              ? `${report.blocking_count} blocking, ${report.warning_count} warning, ${report.info_count} info`
              : "No dependency report loaded."}
          </p>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DependentRow({ dependent }: { dependent: UsedByDependent }) {
  return (
    <div className="border-b border-gray-100 px-3 py-2.5 last:border-b-0 dark:border-line/60">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-gray-900 dark:text-ink">
            {dependent.dependent_label ?? dependent.dependent_type}
          </p>
          {dependent.location && (
            <p className="mt-0.5 font-mono text-[10.5px] text-gray-500 dark:text-ink-subtle">
              {dependent.location}
            </p>
          )}
        </div>
        <SeverityBadge severity={dependent.severity} />
      </div>
      <p className="mt-1 text-xs text-gray-700 dark:text-ink-muted">
        {dependent.message}
      </p>
      {dependent.recommendation && (
        <p className="mt-1 text-[11px] text-gray-500 dark:text-ink-subtle">
          {dependent.recommendation}
        </p>
      )}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: UsedByDependent["severity"] }) {
  const classes =
    severity === "blocking"
      ? "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-200"
      : severity === "warning"
        ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-200"
        : "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-200";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${classes}`}
    >
      {severity}
    </span>
  );
}
