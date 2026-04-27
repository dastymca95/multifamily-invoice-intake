"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Info,
  Loader2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";
import type {
  ColumnReadinessOut,
  ImportTemplateReadinessPreviewResponse,
  ReadinessCategory,
  ReadinessItemOut,
  ReadinessStatus,
} from "@/types/import-readiness";

import { fixStepToWizardStep, type WizardStepKey } from "./ColumnInspector";

/**
 * Phase 1F — Validate panel rebuilt around the backend
 * readiness-preview contract.
 *
 * Before Phase 1F this panel rendered the response of the legacy
 * ``GET /invoice-templates/{id}/validate`` endpoint, which only
 * inspects the SAVED template. That created a contradiction:
 *
 *   * Column Inspector (Phase 1D) talks readiness for current
 *     LOCAL edits.
 *   * Dry Run (Phase 1E) talks resolver verdict for the SAVED
 *     template, with a clear "Save then run" escape hatch.
 *   * Validate (legacy) talked saved-template validation in a
 *     different language ("ready" boolean, severity-only issues).
 *
 * The operator could see "Looks good" in the Column Inspector but
 * "Not ready" in Validate, with no way to reconcile the gap. Phase
 * 1F unifies the two readiness surfaces — Column Inspector and
 * Validate — onto the same backend readiness-preview contract so
 * the wording, codes, and verdicts MATCH for the same edits.
 *
 * Layout:
 *
 *   1. Scope banner — explicit copy that this verdict reflects
 *      LOCAL edits (matches the inspector banner).
 *   2. Status card — overall ready/warning/blocked + summary counts.
 *   3. Per-column sections (Blocked → Warning → Ready), each row
 *      with an inline "Fix" button that opens the Column Inspector
 *      at the relevant wizard step (mapped from ``fix_step``).
 *   4. Template-level issues (``response.issues``) at the bottom —
 *      currently empty per Phase 1C but reserved for future use.
 *
 * The legacy ``validate(id)`` API is intentionally NOT removed; it
 * stays available for potential future surfaces / scripted callers.
 */

// ---------------------------------------------------------------------------
// Status / category meta
// ---------------------------------------------------------------------------

interface StatusMeta {
  label: string;
  badge: string;
  banner: string;
  Icon: LucideIcon;
  iconClass: string;
}

const STATUS_META: Record<"ready" | "warning" | "blocked", StatusMeta> = {
  ready: {
    label: "Ready",
    badge:
      "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900",
    banner: "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40",
    Icon: CheckCircle2,
    iconClass: "text-green-600 dark:text-green-400",
  },
  warning: {
    label: "Needs review",
    badge:
      "bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900",
    banner:
      "border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/40",
    Icon: AlertTriangle,
    iconClass: "text-yellow-600 dark:text-yellow-400",
  },
  blocked: {
    label: "Blocked",
    badge:
      "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
    banner: "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40",
    Icon: CircleAlert,
    iconClass: "text-red-600 dark:text-red-400",
  },
};

const CATEGORY_LABEL: Record<string, string> = {
  structure: "Structure",
  value_source: "Value source",
  rule_runtime: "Rule runtime",
  advanced: "Advanced",
  validation: "Validation",
};

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface ImportTemplateValidationPanelProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  result: ImportTemplateReadinessPreviewResponse | null;
  hasUnsavedChanges: boolean;
  /** True iff editing the unsaved canonical-default draft. */
  isDraft?: boolean;
  onClose: () => void;
  /**
   * Re-run the readiness preview after an error or after the user
   * has fixed something inline. When omitted the retry button is
   * hidden.
   */
  onRetry?: () => void;
  /**
   * Called when the operator clicks "Fix" on a per-column issue.
   * The parent should open the Column Inspector for ``columnId`` and
   * (if ``step`` is provided) jump to that wizard step.
   */
  onFixColumn?: (columnId: string, step?: WizardStepKey) => void;
}

export function ImportTemplateValidationPanel({
  open,
  loading,
  error,
  result,
  hasUnsavedChanges,
  isDraft = false,
  onClose,
  onRetry,
  onFixColumn,
}: ImportTemplateValidationPanelProps) {
  // Bucket columns by status for the three sections. Memoized so
  // collapse-toggle re-renders don't recompute the bucketing.
  const buckets = useMemo(() => bucketByStatus(result?.columns ?? []), [
    result,
  ]);
  const overallStatus = result ? normalizeStatus(result.status) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Template readiness"
      size="xl"
    >
      <div className="space-y-4 max-h-[72vh] overflow-y-auto pr-1">
        {/* ---- Scope banner ----------------------------------------- */}
        {/* Always rendered (loading / error / result alike) so the
            operator always understands the panel's perspective. */}
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
          <p>
            <span className="font-semibold">Validation preview</span>{" "}
            checks your current local edits — the same backend
            contract the Column Inspector uses.
          </p>
          <p className="mt-1 text-blue-800 dark:text-blue-200">
            Dry Run, Export, and downstream import use the SAVED
            template. Save your changes first to make Dry Run reflect
            this verdict.
          </p>
        </div>

        {hasUnsavedChanges && !isDraft && (
          <InlineAlert tone="warning">
            Your changes are not saved yet. Save before Dry Run or
            Export so downstream surfaces see the same configuration.
          </InlineAlert>
        )}
        {isDraft && (
          <InlineAlert tone="warning">
            You're previewing readiness for a draft. The template
            isn't persisted yet — save it before running Dry Run or
            Export.
          </InlineAlert>
        )}

        {/* ---- Loading / error / empty ------------------------------- */}
        {loading && (
          <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin text-brand-600 dark:text-brand-50" />
            Checking template readiness…
          </div>
        )}

        {error && !loading && (
          <InlineAlert
            tone="error"
            action={
              onRetry ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={onRetry}
                >
                  Retry
                </Button>
              ) : undefined
            }
          >
            {error}
          </InlineAlert>
        )}

        {!loading && !error && !result && (
          <div className="rounded-md border border-dashed border-gray-300 bg-white px-4 py-6 text-center text-xs text-gray-500 dark:border-line dark:bg-surface-subtle dark:text-ink-muted">
            Click Validate again to re-run the readiness check.
          </div>
        )}

        {/* ---- Result ------------------------------------------------ */}
        {result && !loading && overallStatus && (
          <>
            <OverallStatusCard
              status={overallStatus}
              templateName={result.template_name ?? null}
              summary={result.summary}
            />

            <SummaryGrid summary={result.summary} />

            {/* Sections — blocked first, then warning, then ready. */}
            <ColumnSection
              status="blocked"
              columns={buckets.blocked}
              defaultOpen
              onFixColumn={onFixColumn}
            />
            <ColumnSection
              status="warning"
              columns={buckets.warning}
              defaultOpen
              onFixColumn={onFixColumn}
            />
            <ColumnSection
              status="ready"
              columns={buckets.ready}
              // Ready sections collapse by default — the operator
              // typically cares about the columns that need work.
              defaultOpen={false}
              onFixColumn={onFixColumn}
            />

            {/* Template-level issues — currently empty per Phase 1C
                but rendered if the backend ever emits any. */}
            {(result.issues ?? []).length > 0 && (
              <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
                <header className="border-b border-gray-100 px-3 py-2 text-sm font-semibold text-gray-800 dark:border-line/60 dark:text-ink">
                  Template-level issues
                </header>
                <div className="divide-y divide-gray-100 dark:divide-line/60">
                  {result.issues.map((item, idx) => (
                    <ItemRow
                      key={`tpl-${item.code ?? "uncoded"}-${idx}`}
                      item={item}
                      onFixColumn={onFixColumn}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Status card / summary grid
// ---------------------------------------------------------------------------

function OverallStatusCard({
  status,
  templateName,
  summary,
}: {
  status: "ready" | "warning" | "blocked";
  templateName: string | null;
  summary: ImportTemplateReadinessPreviewResponse["summary"];
}) {
  const meta = STATUS_META[status];
  const Icon = meta.Icon;
  return (
    <div
      className={cn(
        "rounded-md border px-4 py-3 flex items-center justify-between gap-4",
        meta.banner,
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon className={cn("h-5 w-5 shrink-0", meta.iconClass)} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 dark:text-ink">
            {meta.label}
          </div>
          <div className="text-xs text-gray-600 truncate dark:text-ink-muted">
            {templateName ?? "Untitled template"}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs shrink-0">
        <CountPill tone="error" count={summary.error_count} label="Errors" />
        <CountPill
          tone="warning"
          count={summary.warning_count}
          label="Warnings"
        />
        <CountPill tone="info" count={summary.info_count} label="Info" />
      </div>
    </div>
  );
}

function SummaryGrid({
  summary,
}: {
  summary: ImportTemplateReadinessPreviewResponse["summary"];
}) {
  const cards: Array<{ label: string; value: number; tone: string }> = [
    {
      label: "Columns",
      value: summary.column_count,
      tone: "text-gray-700 dark:text-ink",
    },
    {
      label: "Ready",
      value: summary.ready_columns,
      tone: "text-green-700 dark:text-green-200",
    },
    {
      label: "Warning",
      value: summary.warning_columns,
      tone: "text-yellow-700 dark:text-yellow-200",
    },
    {
      label: "Blocked",
      value: summary.blocked_columns,
      tone: "text-red-700 dark:text-red-200",
    },
  ];
  return (
    <div className="grid grid-cols-4 gap-2">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-line dark:bg-surface-subtle"
        >
          <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
            {card.label}
          </p>
          <p className={cn("text-lg font-semibold", card.tone)}>
            {card.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function CountPill({
  tone,
  count,
  label,
}: {
  tone: "error" | "warning" | "info";
  count: number;
  label: string;
}) {
  const className =
    tone === "error"
      ? "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900"
      : tone === "warning"
        ? "bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900"
        : "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-200 dark:border-blue-900";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold",
        className,
      )}
    >
      {count}
      <span>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Per-status column section + per-column row
// ---------------------------------------------------------------------------

function ColumnSection({
  status,
  columns,
  defaultOpen,
  onFixColumn,
}: {
  status: "ready" | "warning" | "blocked";
  columns: ColumnReadinessOut[];
  defaultOpen: boolean;
  onFixColumn?: (columnId: string, step?: WizardStepKey) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = STATUS_META[status];
  const Icon = meta.Icon;
  const titleByStatus: Record<typeof status, string> = {
    blocked: "Blocked columns",
    warning: "Columns to review",
    ready: "Ready columns",
  };

  if (columns.length === 0) {
    // Zero-state row — keep the chrome so the operator knows we
    // CHECKED for this category (vs. silently omitted).
    return (
      <section
        className={cn(
          "rounded-md border bg-white dark:bg-surface-subtle",
          status === "blocked"
            ? "border-red-200 dark:border-red-900"
            : status === "warning"
              ? "border-yellow-200 dark:border-yellow-900"
              : "border-green-200 dark:border-green-900",
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
            <Icon className={cn("h-4 w-4", meta.iconClass)} />
            {titleByStatus[status]}
          </div>
          <span className="text-xs font-semibold text-gray-500 dark:text-ink-muted">
            0
          </span>
        </header>
        <p className="px-3 py-2 text-xs text-gray-500 dark:text-ink-muted">
          {status === "ready"
            ? "No columns are fully ready yet."
            : status === "warning"
              ? "No warnings — nothing here needs review."
              : "No blocking issues — nothing is preventing readiness."}
        </p>
      </section>
    );
  }

  return (
    <section
      className={cn(
        "rounded-md border bg-white dark:bg-surface-subtle",
        status === "blocked"
          ? "border-red-200 dark:border-red-900"
          : status === "warning"
            ? "border-yellow-200 dark:border-yellow-900"
            : "border-green-200 dark:border-green-900",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60"
      >
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-gray-400 dark:text-ink-subtle" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-gray-400 dark:text-ink-subtle" />
          )}
          <Icon className={cn("h-4 w-4", meta.iconClass)} />
          {titleByStatus[status]}
        </div>
        <span className="text-xs font-semibold text-gray-500 dark:text-ink-muted">
          {columns.length}
        </span>
      </button>
      {open && (
        <div className="divide-y divide-gray-100 dark:divide-line/60">
          {columns.map((col) => (
            <ColumnRow
              key={col.column_id}
              column={col}
              onFixColumn={onFixColumn}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ColumnRow({
  column,
  onFixColumn,
}: {
  column: ColumnReadinessOut;
  onFixColumn?: (columnId: string, step?: WizardStepKey) => void;
}) {
  const status = normalizeStatus(column.status);
  const meta = status ? STATUS_META[status] : null;
  // Show top items (errors + warnings first). Cap to keep the panel
  // scannable; the operator can open the Column Inspector to see
  // everything in context.
  const items = useMemo(() => sortItemsBySeverity(column.items), [column.items]);
  const visible = items.slice(0, 4);
  const hidden = Math.max(0, items.length - visible.length);

  // The "Fix" CTA jumps to the FIRST blocking/warning item's
  // ``fix_step`` (falling back to Step 5 = Readiness when missing).
  // Ready-column rows still get a Fix button but it lands on Step 1
  // so the operator can review the column without surprise.
  const primaryItem = items[0];
  const primaryStep = primaryItem
    ? fixStepToWizardStep(primaryItem.fix_step)
    : 1;

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900 dark:text-ink">
              {column.column_name}
            </span>
            {meta && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
                  meta.badge,
                )}
              >
                <meta.Icon className="h-3 w-3" />
                {meta.label}
              </span>
            )}
            {column.required && (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                required
              </span>
            )}
            {column.source_type && (
              <span className="font-mono text-[10px] text-gray-400 dark:text-ink-subtle">
                {column.source_type}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-700 dark:text-ink-muted">
            <span className="font-medium">{column.expectation_label}</span>
            {column.expectation_detail
              ? ` · ${column.expectation_detail}`
              : ""}
          </p>
        </div>
        {onFixColumn && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onFixColumn(column.column_id, primaryStep)}
            title={
              primaryItem
                ? `Open Column Inspector at step ${stepDisplay(primaryStep)} to fix this`
                : "Open Column Inspector"
            }
          >
            <Wrench className="h-3.5 w-3.5" />
            Fix
          </Button>
        )}
      </div>

      {visible.length > 0 && (
        <ul className="mt-2 space-y-1">
          {visible.map((item, idx) => (
            <ItemRow
              key={`${column.column_id}-${item.code ?? "uncoded"}-${idx}`}
              item={item}
              onFixColumn={onFixColumn}
              hideColumnHint
            />
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p className="mt-1 text-[11px] text-gray-500 dark:text-ink-muted">
          + {hidden} more issue{hidden === 1 ? "" : "s"} — open the
          Column Inspector to see all.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item row — used both for per-column items and template-level issues
// ---------------------------------------------------------------------------

function ItemRow({
  item,
  onFixColumn,
  hideColumnHint = false,
}: {
  item: ReadinessItemOut;
  onFixColumn?: (columnId: string, step?: WizardStepKey) => void;
  hideColumnHint?: boolean;
}) {
  const status = normalizeStatus(item.status);
  const meta = status ? STATUS_META[status] : STATUS_META.warning;
  const Icon = meta.Icon;
  const category = item.category as ReadinessCategory | undefined;
  const categoryLabel =
    typeof category === "string"
      ? CATEGORY_LABEL[category] ?? category
      : null;

  return (
    <li className="rounded border border-gray-100 px-2 py-1.5 dark:border-line/60">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            <Icon
              className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", meta.iconClass)}
            />
            <p className="text-xs font-medium text-gray-900 dark:text-ink">
              {item.message}
            </p>
          </div>
          {item.detail && (
            <p className="mt-0.5 pl-5 text-[11px] text-gray-600 dark:text-ink-muted">
              {item.detail}
            </p>
          )}
          {item.recommendation && (
            <p className="mt-0.5 pl-5 text-[11px] text-gray-700 dark:text-ink-muted">
              <Info className="inline h-3 w-3 mr-1 -mt-0.5" />
              {item.recommendation}
            </p>
          )}
          <div className="mt-1 pl-5 flex items-center gap-1.5 flex-wrap">
            {categoryLabel && (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                {categoryLabel}
              </span>
            )}
            {item.code && (
              <span className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gray-500 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                {item.code}
              </span>
            )}
            {!hideColumnHint && item.column_id && (
              <span className="text-[10px] text-gray-400 dark:text-ink-subtle">
                column {item.column_id}
              </span>
            )}
            {item.fix_step != null && (
              <span className="text-[10px] text-gray-400 dark:text-ink-subtle">
                fix in {stepDisplay(fixStepToWizardStep(item.fix_step))}
              </span>
            )}
          </div>
        </div>
        {onFixColumn && item.column_id && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onFixColumn(
                item.column_id as string,
                fixStepToWizardStep(item.fix_step),
              )
            }
            title={`Open Column Inspector at step ${stepDisplay(fixStepToWizardStep(item.fix_step))}`}
          >
            Fix
          </Button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Narrow the widened backend status string onto the three concrete
 * literals the panel renders. Forward-compat: unknown future
 * statuses fall through as ``null`` so we don't accidentally crash
 * — the caller renders without a status badge in that case.
 */
function normalizeStatus(
  status: ReadinessStatus | string | null | undefined,
): "ready" | "warning" | "blocked" | null {
  // Explicit cast — ReadinessStatus is widened with ``(string & {})``
  // for forward-compat, which prevents TS from narrowing the union
  // through a literal === check. The runtime check is still tight.
  if (status === "ready" || status === "warning" || status === "blocked") {
    return status as "ready" | "warning" | "blocked";
  }
  return null;
}

function bucketByStatus(columns: ColumnReadinessOut[]) {
  const blocked: ColumnReadinessOut[] = [];
  const warning: ColumnReadinessOut[] = [];
  const ready: ColumnReadinessOut[] = [];
  for (const col of columns) {
    const s = normalizeStatus(col.status);
    if (s === "blocked") blocked.push(col);
    else if (s === "warning") warning.push(col);
    else if (s === "ready") ready.push(col);
    // Unknown future statuses lump into warning so they don't get
    // hidden in the "Ready" bucket by accident.
    else warning.push(col);
  }
  return { blocked, warning, ready };
}

const SEVERITY_RANK: Record<string, number> = {
  blocked: 0,
  warning: 1,
  ready: 2,
};

function sortItemsBySeverity(items: ReadinessItemOut[]): ReadinessItemOut[] {
  return [...items].sort((a, b) => {
    const ra = SEVERITY_RANK[normalizeStatus(a.status) ?? "warning"] ?? 1;
    const rb = SEVERITY_RANK[normalizeStatus(b.status) ?? "warning"] ?? 1;
    return ra - rb;
  });
}

function stepDisplay(step: WizardStepKey): string {
  if (step === "advanced") return "Advanced";
  // Steps are 1-indexed in the wizard label, e.g. "Step 3".
  return `Step ${step}`;
}
