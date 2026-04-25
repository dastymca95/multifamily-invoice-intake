"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Info,
  Loader2,
  type LucideIcon,
} from "lucide-react";

import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";
import type {
  ImportTemplateValidationIssue,
  ImportTemplateValidationResult,
  ImportTemplateValidationSeverity,
} from "@/types/invoice-template";

interface ImportTemplateValidationPanelProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  result: ImportTemplateValidationResult | null;
  hasUnsavedChanges: boolean;
  onClose: () => void;
}

const SEVERITY_ORDER: ImportTemplateValidationSeverity[] = [
  "error",
  "warning",
  "info",
];

const SEVERITY_META: Record<
  ImportTemplateValidationSeverity,
  {
    label: string;
    Icon: LucideIcon;
    badge: string;
    section: string;
    empty: string;
  }
> = {
  error: {
    label: "Errors",
    Icon: CircleAlert,
    badge: "bg-red-50 text-red-700 border-red-200",
    section: "border-red-200",
    empty: "No blocking errors.",
  },
  warning: {
    label: "Warnings",
    Icon: AlertTriangle,
    badge: "bg-yellow-50 text-yellow-800 border-yellow-200",
    section: "border-yellow-200",
    empty: "No warnings.",
  },
  info: {
    label: "Info",
    Icon: Info,
    badge: "bg-blue-50 text-blue-700 border-blue-200",
    section: "border-blue-200",
    empty: "No info diagnostics.",
  },
};

export function ImportTemplateValidationPanel({
  open,
  loading,
  error,
  result,
  hasUnsavedChanges,
  onClose,
}: ImportTemplateValidationPanelProps) {
  const grouped = groupIssues(result?.issues ?? []);
  const StatusIcon = result?.ready ? CheckCircle2 : CircleAlert;

  return (
    <Modal open={open} onClose={onClose} title="Template readiness" size="xl">
      <div className="space-y-4 max-h-[72vh] overflow-y-auto pr-1">
        {hasUnsavedChanges && (
          <InlineAlert tone="warning">
            Validation checks the last saved version. Save changes first to
            validate the current draft state.
          </InlineAlert>
        )}

        {loading && (
          <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-600">
            <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
            Checking template readiness...
          </div>
        )}

        {error && !loading && <InlineAlert tone="error">{error}</InlineAlert>}

        {result && !loading && (
          <>
            <div
              className={cn(
                "rounded-md border px-4 py-3 flex items-center justify-between gap-4",
                result.ready
                  ? "border-green-200 bg-green-50"
                  : "border-red-200 bg-red-50",
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <StatusIcon
                  className={cn(
                    "h-5 w-5 shrink-0",
                    result.ready ? "text-green-600" : "text-red-600",
                  )}
                />
                <div className="min-w-0">
                  <div
                    className={cn(
                      "text-sm font-semibold",
                      result.ready ? "text-green-800" : "text-red-800",
                    )}
                  >
                    {result.ready ? "Ready to use" : "Not ready"}
                  </div>
                  <div className="text-xs text-gray-600 truncate">
                    {result.template_name}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs shrink-0">
                <CountPill
                  severity="error"
                  count={result.summary.errors}
                />
                <CountPill
                  severity="warning"
                  count={result.summary.warnings}
                />
                <CountPill severity="info" count={result.summary.info} />
              </div>
            </div>

            <div className="space-y-3">
              {SEVERITY_ORDER.map((severity) => {
                const issues = grouped[severity];
                return (
                  <IssueSection
                    key={severity}
                    severity={severity}
                    issues={issues}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function CountPill({
  severity,
  count,
}: {
  severity: ImportTemplateValidationSeverity;
  count: number;
}) {
  const meta = SEVERITY_META[severity];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold",
        meta.badge,
      )}
    >
      {count}
      <span className="capitalize">{severity}</span>
    </span>
  );
}

function IssueSection({
  severity,
  issues,
}: {
  severity: ImportTemplateValidationSeverity;
  issues: ImportTemplateValidationIssue[];
}) {
  const meta = SEVERITY_META[severity];
  const Icon = meta.Icon;

  return (
    <section className={cn("rounded-md border bg-white", meta.section)}>
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800">
          <Icon className="h-4 w-4" />
          {meta.label}
        </div>
        <span className="text-xs font-semibold text-gray-500">
          {issues.length}
        </span>
      </div>
      {issues.length === 0 ? (
        <div className="px-3 py-3 text-xs text-gray-500">{meta.empty}</div>
      ) : (
        <div className="divide-y divide-gray-100">
          {issues.map((issue, idx) => (
            <IssueRow key={`${issue.code}-${issue.path ?? ""}-${idx}`} issue={issue} />
          ))}
        </div>
      )}
    </section>
  );
}

function IssueRow({ issue }: { issue: ImportTemplateValidationIssue }) {
  const context = [
    issue.column_label ? `Column: ${issue.column_label}` : null,
    issue.rule_id ? `Rule: ${issue.rule_label || issue.rule_id}` : null,
    issue.cell_key ? `Cell: ${issue.cell_key}` : null,
  ].filter(Boolean);

  return (
    <div className="px-3 py-2.5 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-gray-900">{issue.message}</p>
          {context.length > 0 && (
            <p className="mt-1 text-gray-500">{context.join(" | ")}</p>
          )}
          {issue.recommendation && (
            <p className="mt-1 text-gray-700">{issue.recommendation}</p>
          )}
        </div>
        <span className="shrink-0 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gray-500">
          {issue.code}
        </span>
      </div>
      {issue.path && (
        <div className="mt-1 font-mono text-[10px] text-gray-400">
          {issue.path}
        </div>
      )}
    </div>
  );
}

function groupIssues(issues: ImportTemplateValidationIssue[]) {
  return SEVERITY_ORDER.reduce(
    (acc, severity) => {
      acc[severity] = issues.filter((issue) => issue.severity === severity);
      return acc;
    },
    {
      error: [],
      warning: [],
      info: [],
    } as Record<ImportTemplateValidationSeverity, ImportTemplateValidationIssue[]>,
  );
}
