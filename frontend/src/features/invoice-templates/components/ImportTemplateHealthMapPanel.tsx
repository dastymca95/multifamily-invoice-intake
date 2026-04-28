"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FlaskConical,
  Hash,
  Info,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { getApiErrorMessage, invoiceTemplatesApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  ColumnReadinessOut,
  ImportTemplateReadinessPreviewResponse,
  ReadinessCategory,
  ReadinessItemOut,
  ReadinessStatus,
  ResolverExpectation,
} from "@/types/import-readiness";
import type {
  InvoiceTemplateColumn,
  InvoiceTemplateRule,
} from "@/types/invoice-template";

import {
  fixStepToWizardStep,
  type WizardStepKey,
} from "./ColumnInspector";

/**
 * Phase 1G — Template Health Map / Setup Overview.
 *
 * A "control-center" view of the template that aggregates the
 * backend readiness-preview response (the same contract Phase 1D /
 * 1F use) into five complementary lenses:
 *
 *   1. Overall status header
 *   2. Priority fixes — the most blocking items first
 *   3. Column board — full status table with filters
 *   4. Runtime dependency map — what the template needs at import
 *      time (extracted facts / catalog hints)
 *   5. Rule runtime map — per-rule readiness (FILL coverage)
 *
 * Plus an action bar at the bottom that proxies the editor's main
 * actions (Validate refresh / Save / Dry Run / Save then Dry Run)
 * so the operator can finish an end-to-end review without leaving
 * the panel.
 *
 * The panel self-fetches: every time it opens, AND when the local
 * template state changes while open, it re-runs
 * ``previewReadiness`` against the CURRENT local edits. The Column
 * Inspector + Validate panel both render the same backend contract,
 * so verdicts are guaranteed to agree across all three surfaces for
 * the same edits.
 *
 * No backend changes for this phase — strictly a new frontend
 * window onto an existing endpoint.
 */

// ---------------------------------------------------------------------------
// Status / category meta — local, deliberately not shared with the Validate
// panel. Both panels render the same contract but tune the visual treatment
// to their layout (Validate is dense; Health Map is broader / scannable).
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
    banner:
      "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40",
    Icon: CheckCircle2,
    iconClass: "text-green-600 dark:text-green-400",
  },
  warning: {
    label: "Needs attention",
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

interface ImportTemplateHealthMapPanelProps {
  open: boolean;
  onClose: () => void;
  /** Persisted id (or null for unsaved drafts). */
  templateId: string | null;
  /** Current local template name (echoed in the request body). */
  templateName: string;
  /** Current local columns — posted directly. */
  columns: InvoiceTemplateColumn[];
  /** Current local rules — posted directly. */
  rules: InvoiceTemplateRule[];
  /** True iff editor has local edits not yet persisted. */
  hasUnsavedChanges: boolean;
  /** True iff editing the unsaved canonical-default draft. */
  isDraft: boolean;
  /** Whether the editor's Save button would be enabled. */
  canSave: boolean;
  /** Whether a save is currently in flight (parent-tracked). */
  saving: boolean;
  /**
   * Persist-to-server hook. Resolves on success, REJECTS on save
   * failure (Phase 1E semantics). The Health Map's "Save changes"
   * and "Save then Dry Run" buttons chain off this.
   */
  onSave: () => Promise<void> | void;
  /**
   * Open the Dry Run modal. The Health Map closes itself before
   * calling this so the two modals don't stack.
   */
  onOpenDryRun: () => void;
  /**
   * Phase 2C — open the Template + Pattern Test Runner panel. Same
   * stacking rule as Dry Run: the Health Map closes itself first
   * so the two modals never overlap. Optional — when omitted the
   * action bar simply doesn't render the button.
   */
  onTestWithPattern?: () => void;
  /**
   * Phase 3B — open the Operational Resolution Preview panel.
   * Same stacking rule as the others. Optional — when omitted the
   * action bar simply doesn't render the button.
   */
  onOperationalPreview?: () => void;
  /**
   * Phase 1F handler — open the Column Inspector for ``columnId``
   * at the wizard ``step``. The Health Map's per-column "Fix" CTAs
   * close the Health Map and call this.
   */
  onFixColumn: (columnId: string, step?: WizardStepKey) => void;
}

export function ImportTemplateHealthMapPanel({
  open,
  onClose,
  templateId,
  templateName,
  columns,
  rules,
  hasUnsavedChanges,
  isDraft,
  canSave,
  saving,
  onSave,
  onOpenDryRun,
  onTestWithPattern,
  onOperationalPreview,
  onFixColumn,
}: ImportTemplateHealthMapPanelProps) {
  // ---- Self-fetched readiness state ---------------------------------
  // The panel owns its result so the parent doesn't need to thread
  // it. Re-fetched whenever the panel opens, the template inputs
  // change, or the operator clicks "Refresh".
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] =
    useState<ImportTemplateReadinessPreviewResponse | null>(null);

  // ---- Save chaining (mirrors Phase 1E pattern in Dry Run) --------
  const [saveThenDryRunBusy, setSaveThenDryRunBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ---- Race-protected request id ----------------------------------
  // Mirrors useBackendReadiness in ColumnInspector — if the operator
  // rapid-fires Refresh, only the latest response wins.
  const requestIdRef = useRef(0);
  const fetchAbortRef = useRef<AbortController | null>(null);

  // Snapshot the inputs into a stable string key so the auto-fetch
  // effect doesn't re-fire on every parent re-render (columns/rules
  // are new array references each commit even when the contents are
  // unchanged).
  const payloadKey = useMemo(() => {
    if (!open) return null;
    try {
      return JSON.stringify({
        tid: templateId,
        tname: templateName,
        columns,
        rules,
      });
    } catch {
      return `unhashable-${Math.random()}`;
    }
  }, [open, templateId, templateName, columns, rules]);

  const runFetch = useCallback(async () => {
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const myRequestId = ++requestIdRef.current;

    setLoading(true);
    setError(null);
    try {
      const result = await invoiceTemplatesApi.previewReadiness(
        {
          template_id: templateId,
          template_name: templateName,
          columns: columns as unknown[],
          rules: rules as unknown[],
        },
        { signal: controller.signal },
      );
      if (myRequestId !== requestIdRef.current) return;
      setResponse(result);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (myRequestId !== requestIdRef.current) return;
      setError(getApiErrorMessage(err, "Could not check template health."));
    } finally {
      if (myRequestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [templateId, templateName, columns, rules]);

  // Auto-fetch on open + when payload changes. Closing aborts any
  // in-flight request to avoid the panel ghost-updating after dismiss.
  useEffect(() => {
    if (!open) {
      fetchAbortRef.current?.abort();
      return;
    }
    void runFetch();
    return () => {
      fetchAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, payloadKey]);

  // ---- Action handlers --------------------------------------------

  const handleRefresh = useCallback(() => {
    setSaveError(null);
    void runFetch();
  }, [runFetch]);

  const handleSaveOnly = useCallback(async () => {
    if (!canSave || saving || saveThenDryRunBusy) return;
    setSaveError(null);
    try {
      const maybe = onSave();
      if (
        maybe &&
        typeof (maybe as Promise<void>).then === "function"
      ) {
        await maybe;
      }
      // Refresh after save so the Health Map shows the just-saved
      // state. (Local payloadKey doesn't change on save success since
      // the inputs are the same; we still re-fetch in case the
      // backend now sees the persisted template_id for the first
      // time on a draft → saved transition.)
      void runFetch();
    } catch (err) {
      setSaveError(getApiErrorMessage(err, "Could not save the template."));
    }
  }, [canSave, saving, saveThenDryRunBusy, onSave, runFetch]);

  const handleSaveThenDryRun = useCallback(async () => {
    if (!canSave || saving || saveThenDryRunBusy) return;
    setSaveError(null);
    setSaveThenDryRunBusy(true);
    try {
      const maybe = onSave();
      if (
        maybe &&
        typeof (maybe as Promise<void>).then === "function"
      ) {
        await maybe;
      }
      // Save succeeded — close Health Map and open Dry Run. The Dry
      // Run modal will re-fetch and (since dirty just cleared) show
      // a fresh result without the unsaved-changes banner.
      onClose();
      onOpenDryRun();
    } catch (err) {
      setSaveError(
        getApiErrorMessage(err, "Could not save the template before Dry Run."),
      );
    } finally {
      setSaveThenDryRunBusy(false);
    }
  }, [
    canSave,
    saving,
    saveThenDryRunBusy,
    onSave,
    onClose,
    onOpenDryRun,
  ]);

  const handleOpenDryRun = useCallback(() => {
    onClose();
    onOpenDryRun();
  }, [onClose, onOpenDryRun]);

  // Phase 2C — close Health Map first so the test panel doesn't
  // stack on top. The test runner reads its own data on open.
  const handleOpenTestWithPattern = useCallback(() => {
    if (!onTestWithPattern) return;
    onClose();
    onTestWithPattern();
  }, [onClose, onTestWithPattern]);

  // Phase 3B — same stacking rule as Test with Pattern.
  const handleOpenOperationalPreview = useCallback(() => {
    if (!onOperationalPreview) return;
    onClose();
    onOperationalPreview();
  }, [onClose, onOperationalPreview]);

  const handleFix = useCallback(
    (columnId: string, step?: WizardStepKey) => {
      onClose();
      onFixColumn(columnId, step);
    },
    [onClose, onFixColumn],
  );

  // ---- Derived data -----------------------------------------------

  const overallStatus = response ? normalizeStatus(response.status) : null;
  const buckets = useMemo(
    () => bucketByStatus(response?.columns ?? []),
    [response],
  );
  const priorityIssues = useMemo(
    () => derivePriorityIssues(response?.columns ?? []),
    [response],
  );
  const runtimeDeps = useMemo(
    () => deriveRuntimeDependencies(response?.columns ?? []),
    [response],
  );
  const ruleRuntime = useMemo(
    () => deriveRuleRuntime(response?.columns ?? []),
    [response],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Template health map"
      size="xl"
    >
      <div className="space-y-4 max-h-[72vh] overflow-y-auto pr-1">
        {/* ---- Scope / dirty banners ------------------------------- */}
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
          <p>
            <span className="font-semibold">Health Map</span> uses
            your current local edits — the same backend contract as
            Validate and the Column Inspector.
          </p>
          <p className="mt-1 text-blue-800 dark:text-blue-200">
            Dry Run uses the SAVED template unless you click{" "}
            <span className="font-semibold">Save then Dry Run</span>{" "}
            below.
          </p>
        </div>
        {hasUnsavedChanges && !isDraft && (
          <InlineAlert tone="warning">
            Unsaved changes are included in this health check. Save
            before Dry Run or Export so downstream surfaces see the
            same configuration.
          </InlineAlert>
        )}
        {isDraft && (
          <InlineAlert tone="warning">
            You're previewing a draft template. Save it before running
            Dry Run or Export.
          </InlineAlert>
        )}

        {/* ---- Loading / error / empty ----------------------------- */}
        {loading && !response && (
          <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin text-brand-600 dark:text-brand-50" />
            Checking template health…
          </div>
        )}

        {error && !loading && (
          <InlineAlert
            tone="error"
            action={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleRefresh}
              >
                Retry
              </Button>
            }
          >
            {error}
          </InlineAlert>
        )}

        {!loading && !error && response && response.columns.length === 0 && (
          <div className="rounded-md border border-dashed border-gray-300 bg-white px-4 py-6 text-center text-xs text-gray-500 dark:border-line dark:bg-surface-subtle dark:text-ink-muted">
            No columns configured yet. Add at least one column to
            check template health.
          </div>
        )}

        {/* ---- Sections (Header + Priority + Board + Runtime + Rules) -- */}
        {response && response.columns.length > 0 && overallStatus && (
          <>
            <HealthHeader
              status={overallStatus}
              templateName={response.template_name ?? templateName}
              summary={response.summary}
              loading={loading}
            />

            <PriorityFixesSection
              issues={priorityIssues}
              onFix={handleFix}
              hasUnsavedChanges={hasUnsavedChanges}
              isDraft={isDraft}
            />

            <ColumnBoardSection
              buckets={buckets}
              onFix={handleFix}
            />

            <RuntimeDependencySection
              dependencies={runtimeDeps}
              onFix={handleFix}
            />

            <RuleRuntimeSection
              items={ruleRuntime}
              onFix={handleFix}
            />
          </>
        )}

        {/* ---- Save error inline (chained Save + Save then Dry Run) -- */}
        {saveError && (
          <InlineAlert tone="error">Save failed: {saveError}</InlineAlert>
        )}

        {/* ---- Action bar ------------------------------------------- */}
        <ActionBar
          loading={loading}
          hasUnsavedChanges={hasUnsavedChanges}
          isDraft={isDraft}
          canSave={canSave}
          saving={saving}
          saveThenDryRunBusy={saveThenDryRunBusy}
          onRefresh={handleRefresh}
          onSave={handleSaveOnly}
          onDryRun={handleOpenDryRun}
          onSaveThenDryRun={handleSaveThenDryRun}
          onTestWithPattern={
            onTestWithPattern ? handleOpenTestWithPattern : undefined
          }
          onOperationalPreview={
            onOperationalPreview ? handleOpenOperationalPreview : undefined
          }
          onClose={onClose}
        />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Section: Overall status header
// ---------------------------------------------------------------------------

function HealthHeader({
  status,
  templateName,
  summary,
  loading,
}: {
  status: "ready" | "warning" | "blocked";
  templateName: string;
  summary: ImportTemplateReadinessPreviewResponse["summary"];
  loading: boolean;
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
            {loading && (
              <Loader2 className="ml-2 inline h-3 w-3 animate-spin text-brand-600 dark:text-brand-50" />
            )}
          </div>
          <div className="text-xs text-gray-700 truncate dark:text-ink-muted">
            {templateName || "Untitled template"}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs shrink-0">
        <SummaryStat
          label="Ready"
          value={summary.ready_columns}
          tone="text-green-700 dark:text-green-200"
        />
        <SummaryStat
          label="Warning"
          value={summary.warning_columns}
          tone="text-yellow-700 dark:text-yellow-200"
        />
        <SummaryStat
          label="Blocked"
          value={summary.blocked_columns}
          tone="text-red-700 dark:text-red-200"
        />
        <SummaryStat
          label="Errors"
          value={summary.error_count}
          tone="text-red-700 dark:text-red-200"
        />
        <SummaryStat
          label="Warnings"
          value={summary.warning_count}
          tone="text-yellow-700 dark:text-yellow-200"
        />
        <SummaryStat
          label="Info"
          value={summary.info_count}
          tone="text-blue-700 dark:text-blue-200"
        />
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={cn("text-base font-semibold", tone)}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: Priority fixes
// ---------------------------------------------------------------------------

interface PriorityIssue {
  column: ColumnReadinessOut;
  item: ReadinessItemOut;
  rank: number;
}

function PriorityFixesSection({
  issues,
  onFix,
  hasUnsavedChanges,
  isDraft,
}: {
  issues: PriorityIssue[];
  onFix: (columnId: string, step?: WizardStepKey) => void;
  hasUnsavedChanges: boolean;
  isDraft: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const visible = issues.slice(0, 8);
  const hidden = Math.max(0, issues.length - visible.length);

  // Empty-state copy depends on whether the operator has any
  // unsaved drift — the spec asks us to celebrate readiness only
  // when there's nothing left to address.
  if (issues.length === 0) {
    return (
      <section className="rounded-md border border-green-200 bg-green-50/60 px-3 py-3 text-xs text-green-800 dark:border-green-900 dark:bg-green-950/20 dark:text-green-200">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          <span className="font-semibold">
            Everything looks ready.
          </span>
          <span>
            You can run Dry Run or test with sample invoices.
          </span>
        </div>
        {(hasUnsavedChanges || isDraft) && (
          <p className="mt-1 pl-6 text-[11px] text-green-700 dark:text-green-300">
            Save your changes first so Dry Run sees them.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="rounded-md border border-red-200 bg-white dark:border-red-900 dark:bg-surface-subtle">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60"
      >
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-gray-400 dark:text-ink-subtle" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-gray-400 dark:text-ink-subtle" />
          )}
          <Wrench className="h-4 w-4 text-red-600 dark:text-red-300" />
          Priority fixes
        </div>
        <span className="text-xs font-semibold text-gray-500 dark:text-ink-muted">
          {issues.length}
        </span>
      </button>
      {expanded && (
        <div className="divide-y divide-gray-100 dark:divide-line/60">
          {visible.map((entry, idx) => (
            <PriorityIssueRow
              key={`${entry.column.column_id}-${entry.item.code ?? "uncoded"}-${idx}`}
              entry={entry}
              onFix={onFix}
            />
          ))}
          {hidden > 0 && (
            <p className="px-3 py-2 text-[11px] text-gray-500 dark:text-ink-muted">
              + {hidden} more issue{hidden === 1 ? "" : "s"} — see the
              column board below for the full list.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function PriorityIssueRow({
  entry,
  onFix,
}: {
  entry: PriorityIssue;
  onFix: (columnId: string, step?: WizardStepKey) => void;
}) {
  const status = normalizeStatus(entry.item.status);
  const meta = status ? STATUS_META[status] : STATUS_META.warning;
  const Icon = meta.Icon;
  const cat = entry.item.category;
  const categoryLabel =
    typeof cat === "string" ? CATEGORY_LABEL[cat] ?? cat : null;
  const step = fixStepToWizardStep(entry.item.fix_step);

  return (
    <div className="px-3 py-2.5 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.iconClass)} />
          <span className="text-xs font-semibold text-gray-900 dark:text-ink">
            {entry.column.column_name}
          </span>
          {entry.column.required && (
            <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              required
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
              meta.badge,
            )}
          >
            {meta.label}
          </span>
        </div>
        <p className="mt-1 text-xs text-gray-800 dark:text-ink">
          {entry.item.message}
        </p>
        {entry.item.recommendation && (
          <p className="mt-0.5 text-[11px] text-gray-700 dark:text-ink-muted">
            <Info className="inline h-3 w-3 mr-1 -mt-0.5" />
            {entry.item.recommendation}
          </p>
        )}
        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
          {categoryLabel && (
            <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
              {categoryLabel}
            </span>
          )}
          {entry.item.code && (
            <span className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gray-500 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
              {entry.item.code}
            </span>
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => onFix(entry.column.column_id, step)}
        title={`Open Column Inspector at step ${stepDisplay(step)}`}
      >
        <Wrench className="h-3.5 w-3.5" />
        Fix
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: Column status board (with filters)
// ---------------------------------------------------------------------------

type BoardFilter =
  | "all"
  | "blocked"
  | "warning"
  | "ready"
  | "required"
  | "runtime";

function ColumnBoardSection({
  buckets,
  onFix,
}: {
  buckets: ReturnType<typeof bucketByStatus>;
  onFix: (columnId: string, step?: WizardStepKey) => void;
}) {
  const [filter, setFilter] = useState<BoardFilter>("all");
  const all = useMemo(
    () => [...buckets.blocked, ...buckets.warning, ...buckets.ready],
    [buckets],
  );

  const filtered = useMemo(() => {
    switch (filter) {
      case "blocked":
        return buckets.blocked;
      case "warning":
        return buckets.warning;
      case "ready":
        return buckets.ready;
      case "required":
        return all.filter((c) => c.required);
      case "runtime":
        return all.filter(isRuntimeDependent);
      case "all":
      default:
        return all;
    }
  }, [filter, all, buckets]);

  const filters: Array<{ key: BoardFilter; label: string; count: number }> = [
    { key: "all", label: "All", count: all.length },
    { key: "blocked", label: "Blocked", count: buckets.blocked.length },
    { key: "warning", label: "Warning", count: buckets.warning.length },
    { key: "ready", label: "Ready", count: buckets.ready.length },
    {
      key: "required",
      label: "Required only",
      count: all.filter((c) => c.required).length,
    },
    {
      key: "runtime",
      label: "Runtime-dependent",
      count: all.filter(isRuntimeDependent).length,
    },
  ];

  return (
    <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
      <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
          <ListChecks className="h-4 w-4 text-brand-600 dark:text-brand-50" />
          Column board
        </div>
        <span className="text-xs font-semibold text-gray-500 dark:text-ink-muted">
          {filtered.length} / {all.length}
        </span>
      </header>
      <div className="px-3 py-2 border-b border-gray-100 dark:border-line/60 flex flex-wrap items-center gap-1.5">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
              filter === f.key
                ? "border-brand-500 bg-brand-50 text-brand-800 dark:border-brand-400 dark:bg-brand-950/40 dark:text-brand-50"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-line dark:bg-surface dark:text-ink-muted dark:hover:bg-surface-muted",
            )}
          >
            {f.label}
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-[10px]",
                filter === f.key
                  ? "bg-brand-600 text-white dark:bg-brand-500"
                  : "bg-gray-100 text-gray-600 dark:bg-surface-muted dark:text-ink-muted",
              )}
            >
              {f.count}
            </span>
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <p className="px-3 py-3 text-xs text-gray-500 dark:text-ink-muted">
          No columns match this filter.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 dark:bg-surface-muted">
              <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
                <th className="px-3 py-1.5">Column</th>
                <th className="px-2 py-1.5">Required</th>
                <th className="px-2 py-1.5">Source</th>
                <th className="px-2 py-1.5">Expectation</th>
                <th className="px-2 py-1.5">Status</th>
                <th className="px-2 py-1.5">Top issue</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-line/60">
              {filtered.map((col) => (
                <ColumnBoardRow
                  key={col.column_id}
                  column={col}
                  onFix={onFix}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ColumnBoardRow({
  column,
  onFix,
}: {
  column: ColumnReadinessOut;
  onFix: (columnId: string, step?: WizardStepKey) => void;
}) {
  const status = normalizeStatus(column.status);
  const meta = status ? STATUS_META[status] : null;
  const topItem = pickTopItem(column.items);
  const step = fixStepToWizardStep(topItem?.fix_step);

  return (
    <tr>
      <td className="px-3 py-1.5 align-top">
        <span className="font-semibold text-gray-900 dark:text-ink">
          {column.column_name}
        </span>
      </td>
      <td className="px-2 py-1.5 align-top">
        {column.required ? (
          <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            required
          </span>
        ) : (
          <span className="text-gray-400 dark:text-ink-subtle">—</span>
        )}
      </td>
      <td className="px-2 py-1.5 align-top font-mono text-[10px] text-gray-500 dark:text-ink-muted">
        {column.source_type ?? "—"}
      </td>
      <td className="px-2 py-1.5 align-top">
        <p className="text-[11px] text-gray-700 dark:text-ink">
          {column.expectation_label}
        </p>
        {column.expectation_detail && (
          <p className="text-[10px] text-gray-500 dark:text-ink-muted">
            {column.expectation_detail}
          </p>
        )}
      </td>
      <td className="px-2 py-1.5 align-top">
        {meta ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
              meta.badge,
            )}
          >
            <meta.Icon className="h-3 w-3" />
            {meta.label}
          </span>
        ) : (
          <span className="text-gray-400 dark:text-ink-subtle">—</span>
        )}
      </td>
      <td className="px-2 py-1.5 align-top">
        {topItem ? (
          <p className="text-[11px] text-gray-700 dark:text-ink-muted line-clamp-2">
            {topItem.message}
          </p>
        ) : (
          <span className="text-gray-400 dark:text-ink-subtle">—</span>
        )}
      </td>
      <td className="px-2 py-1.5 align-top">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onFix(column.column_id, step)}
          title={`Open Column Inspector at step ${stepDisplay(step)}`}
        >
          Fix
        </Button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Section: Runtime dependency map
// ---------------------------------------------------------------------------

interface RuntimeDependency {
  column: ColumnReadinessOut;
  kind: RuntimeDepKind;
  label: string;
}

type RuntimeDepKind =
  | "extracted_fact"
  | "vendor_hint"
  | "property_hint"
  | "gl_hint"
  | "rule_match"
  | "other";

const RUNTIME_DEP_LABEL: Record<RuntimeDepKind, string> = {
  extracted_fact: "Extracted invoice fact",
  vendor_hint: "Vendor catalog hint",
  property_hint: "Property catalog hint",
  gl_hint: "GL catalog hint",
  rule_match: "Conditional rule match",
  other: "Runtime-dependent",
};

function RuntimeDependencySection({
  dependencies,
  onFix,
}: {
  dependencies: RuntimeDependency[];
  onFix: (columnId: string, step?: WizardStepKey) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="rounded-md border border-blue-200 bg-white dark:border-blue-900 dark:bg-surface-subtle">
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
          <Hash className="h-4 w-4 text-blue-600 dark:text-blue-300" />
          Runtime dependency map
        </div>
        <span className="text-xs font-semibold text-gray-500 dark:text-ink-muted">
          {dependencies.length}
        </span>
      </button>
      {open && (
        <>
          <p className="px-3 py-2 text-[11px] text-gray-600 dark:text-ink-muted border-b border-gray-100 dark:border-line/60">
            Columns that need invoice data (extracted facts) or
            catalog hints at import time. Structurally configured but
            cannot resolve until runtime input arrives.
          </p>
          {dependencies.length === 0 ? (
            <p className="px-3 py-3 text-xs text-gray-500 dark:text-ink-muted">
              No runtime-dependent columns. Every required column has
              a direct or fallback value source.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-line/60">
              {dependencies.map((dep) => (
                <RuntimeDepRow
                  key={`${dep.column.column_id}-${dep.kind}`}
                  dep={dep}
                  onFix={onFix}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function RuntimeDepRow({
  dep,
  onFix,
}: {
  dep: RuntimeDependency;
  onFix: (columnId: string, step?: WizardStepKey) => void;
}) {
  const status = normalizeStatus(dep.column.status);
  const meta = status ? STATUS_META[status] : null;
  return (
    <li className="px-3 py-2 flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-900 dark:text-ink">
            {dep.column.column_name}
          </span>
          {dep.column.required ? (
            <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              required
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
              optional
            </span>
          )}
          {meta && (
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
                meta.badge,
              )}
            >
              {meta.label}
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-gray-700 dark:text-ink-muted">
          Needs:{" "}
          <span className="font-medium text-gray-900 dark:text-ink">
            {dep.label}
          </span>
          {" · "}
          {dep.column.expectation_label}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onFix(dep.column.column_id)}
        title="Open Column Inspector to test or refine this column"
      >
        Test
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Section: Rule runtime map
// ---------------------------------------------------------------------------

function RuleRuntimeSection({
  items,
  onFix,
}: {
  items: Array<{ column: ColumnReadinessOut; item: ReadinessItemOut }>;
  onFix: (columnId: string, step?: WizardStepKey) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="rounded-md border border-purple-200 bg-white dark:border-purple-900 dark:bg-surface-subtle">
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
          <Play className="h-4 w-4 text-purple-600 dark:text-purple-300" />
          Rule runtime map
        </div>
        <span className="text-xs font-semibold text-gray-500 dark:text-ink-muted">
          {items.length}
        </span>
      </button>
      {open && (
        <>
          <p className="px-3 py-2 text-[11px] text-gray-600 dark:text-ink-muted border-b border-gray-100 dark:border-line/60">
            Per-column rule readiness. Detailed per-rule match
            simulation happens in Dry Run.
          </p>
          {items.length === 0 ? (
            <p className="px-3 py-3 text-xs text-gray-500 dark:text-ink-muted">
              No rule-runtime advisories. Either no rules touch these
              columns or every rule's effect is unconditional.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-line/60">
              {items.map((entry, idx) => (
                <RuleRuntimeRow
                  key={`rr-${entry.column.column_id}-${entry.item.code ?? "uncoded"}-${idx}`}
                  entry={entry}
                  onFix={onFix}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function RuleRuntimeRow({
  entry,
  onFix,
}: {
  entry: { column: ColumnReadinessOut; item: ReadinessItemOut };
  onFix: (columnId: string, step?: WizardStepKey) => void;
}) {
  const status = normalizeStatus(entry.item.status);
  const meta = status ? STATUS_META[status] : STATUS_META.warning;
  const Icon = meta.Icon;
  const step = fixStepToWizardStep(entry.item.fix_step);
  return (
    <li className="px-3 py-2 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.iconClass)} />
          <span className="text-xs font-semibold text-gray-900 dark:text-ink">
            {entry.column.column_name}
          </span>
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
              meta.badge,
            )}
          >
            {meta.label}
          </span>
          {entry.item.code && (
            <span className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gray-500 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
              {entry.item.code}
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-gray-700 dark:text-ink">
          {entry.item.message}
        </p>
        {entry.item.recommendation && (
          <p className="mt-0.5 text-[11px] text-gray-700 dark:text-ink-muted">
            <Info className="inline h-3 w-3 mr-1 -mt-0.5" />
            {entry.item.recommendation}
          </p>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onFix(entry.column.column_id, step)}
        title={`Open Column Inspector at step ${stepDisplay(step)}`}
      >
        Fix
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Action bar
// ---------------------------------------------------------------------------

function ActionBar({
  loading,
  hasUnsavedChanges,
  isDraft,
  canSave,
  saving,
  saveThenDryRunBusy,
  onRefresh,
  onSave,
  onDryRun,
  onSaveThenDryRun,
  onTestWithPattern,
  onOperationalPreview,
  onClose,
}: {
  loading: boolean;
  hasUnsavedChanges: boolean;
  isDraft: boolean;
  canSave: boolean;
  saving: boolean;
  saveThenDryRunBusy: boolean;
  onRefresh: () => void;
  onSave: () => void;
  onDryRun: () => void;
  onSaveThenDryRun: () => void;
  /** Phase 2C — optional pass-through to the test runner panel. */
  onTestWithPattern?: () => void;
  /** Phase 3B — optional pass-through to the operational preview panel. */
  onOperationalPreview?: () => void;
  onClose: () => void;
}) {
  // The "Save then Dry Run" flow only appears when the operator has
  // a meaningful save to do AND the template can produce a saved id
  // for Dry Run to inspect. Drafts → no Dry Run path; saved-but-clean
  // → no save needed; saved + dirty → both paths offered.
  const showSaveThenDryRun =
    hasUnsavedChanges && canSave && !isDraft;
  const showDryRun = !isDraft;

  return (
    <div className="sticky bottom-0 -mx-1 -mb-1 mt-2 border-t border-gray-200 bg-white px-3 py-2 dark:border-line dark:bg-surface-subtle">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          title="Re-run readiness preview against current local edits"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", loading && "animate-spin")}
          />
          Validate setup
        </Button>
        {/* Phase 2C — Test with Pattern. Disabled for drafts (the
            backend test runner needs a saved template id); the
            test panel itself surfaces a clearer warning when
            opened with unsaved local edits. */}
        {onTestWithPattern && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onTestWithPattern}
            disabled={isDraft}
            title={
              isDraft
                ? "Save this template before testing with a pattern."
                : "Test this template against a saved invoice pattern."
            }
          >
            <FlaskConical className="h-3.5 w-3.5" />
            Test with Pattern
          </Button>
        )}
        {/* Phase 3B — Operational Preview. Same draft-disabled rule
            as Test with Pattern; the panel itself surfaces unsaved-
            change warnings + a Save then preview action. */}
        {onOperationalPreview && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onOperationalPreview}
            disabled={isDraft}
            title={
              isDraft
                ? "Save this template before running Operational Preview."
                : "Run the operational resolution pipeline (diagnostic only)."
            }
          >
            <Workflow className="h-3.5 w-3.5" />
            Operational Preview
          </Button>
        )}
        <div className="flex-1" />
        {canSave && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onSave}
            disabled={saving || saveThenDryRunBusy}
            loading={saving && !saveThenDryRunBusy}
            title="Persist current local edits to the server"
          >
            <Save className="h-3.5 w-3.5" />
            Save changes
          </Button>
        )}
        {showSaveThenDryRun && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onSaveThenDryRun}
            disabled={saving || saveThenDryRunBusy}
            loading={saveThenDryRunBusy}
            title="Save the template, then open Dry Run against the just-saved version"
          >
            <Play className="h-3.5 w-3.5" />
            Save then Dry Run
          </Button>
        )}
        {showDryRun && !showSaveThenDryRun && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onDryRun}
            title="Open Dry Run against the saved template"
          >
            <Play className="h-3.5 w-3.5" />
            Dry Run
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
          Close
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeStatus(
  status: ReadinessStatus | string | null | undefined,
): "ready" | "warning" | "blocked" | null {
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
    else warning.push(col);
  }
  return { blocked, warning, ready };
}

/**
 * Priority rank for a (column, item) pair. Lower rank = higher
 * priority = appears earlier in the Priority Fixes list.
 *
 * Tier breakdown (per Phase 1G spec):
 *
 *   Tier 0 (0–9)   — Blocked + required column
 *     0  value_source       (missing required value source)
 *     1  structure          (missing dropdown/list options, etc.)
 *     2  validation         (config-shape blockers)
 *     3  rule_runtime       (FILL/Action coverage)
 *     5  anything else
 *
 *   Tier 1 (10–19) — Blocked + optional column
 *
 *   Tier 2 (20–29) — Warning + required column
 *     20 value_source       (catalog hint required)
 *     21 structure
 *     22 rule_runtime       (conditional FILL only)
 *     25 anything else
 *
 *   Tier 3 (30–39) — Warning + optional
 *   Tier 4 (50+)   — Info / ready-status items
 *
 * The fixed offsets matter so that "blocked + required + missing
 * dropdown" (rank 1) sorts above "blocked + required + rule
 * runtime" (rank 3), reflecting the spec's
 * "missing dropdown options" priority over "rule FILL issues".
 */
function itemPriority(
  item: ReadinessItemOut,
  column: ColumnReadinessOut,
): number {
  const status = normalizeStatus(item.status);
  const required = column.required;
  const cat = item.category;

  if (status === "blocked" && required) {
    if (cat === "value_source") return 0;
    if (cat === "structure") return 1;
    if (cat === "validation") return 2;
    if (cat === "rule_runtime") return 3;
    return 5;
  }
  if (status === "blocked") {
    if (cat === "value_source") return 11;
    if (cat === "structure") return 12;
    return 15;
  }
  if (status === "warning" && required) {
    if (cat === "value_source") return 20;
    if (cat === "structure") return 21;
    if (cat === "rule_runtime") return 22;
    return 25;
  }
  if (status === "warning") return 35;
  return 50;
}

function derivePriorityIssues(
  columns: ColumnReadinessOut[],
): PriorityIssue[] {
  const out: PriorityIssue[] = [];
  for (const column of columns) {
    for (const item of column.items) {
      const status = normalizeStatus(item.status);
      // Only surface actionable items. Ready/info items live in the
      // column board for completeness; the priority list is meant to
      // point the operator at the next thing to do.
      if (status !== "blocked" && status !== "warning") continue;
      out.push({ column, item, rank: itemPriority(item, column) });
    }
  }
  out.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.column.column_name.localeCompare(b.column.column_name);
  });
  return out;
}

function deriveRuntimeDependencies(
  columns: ColumnReadinessOut[],
): RuntimeDependency[] {
  const out: RuntimeDependency[] = [];
  for (const col of columns) {
    if (!isRuntimeDependent(col)) continue;
    const kind = inferRuntimeDepKind(col);
    out.push({ column: col, kind, label: RUNTIME_DEP_LABEL[kind] });
  }
  // Required columns first, then alphabetical.
  out.sort((a, b) => {
    if (a.column.required !== b.column.required) {
      return a.column.required ? -1 : 1;
    }
    return a.column.column_name.localeCompare(b.column.column_name);
  });
  return out;
}

function isRuntimeDependent(column: ColumnReadinessOut): boolean {
  const exp = column.expectation as ResolverExpectation | string;
  if (exp === "may_be_missing" || exp === "will_be_missing") return true;
  if (column.value_source?.conditional === true) return true;
  return false;
}

function inferRuntimeDepKind(column: ColumnReadinessOut): RuntimeDepKind {
  switch (column.source_type) {
    case "invoice_field":
      return "extracted_fact";
    case "vendor_field":
      return "vendor_hint";
    case "property_field":
      return "property_hint";
    case "gl_field":
      return "gl_hint";
    case "empty":
    case "fixed_value":
    case "manual_list":
    case "derived":
      // Non-catalog non-extraction sources only become runtime-
      // dependent through conditional rule writes — surface that
      // explicitly so the operator knows the dependency is rule-
      // shaped, not data-shaped.
      return "rule_match";
    default:
      return "other";
  }
}

function deriveRuleRuntime(
  columns: ColumnReadinessOut[],
): Array<{ column: ColumnReadinessOut; item: ReadinessItemOut }> {
  const out: Array<{ column: ColumnReadinessOut; item: ReadinessItemOut }> = [];
  for (const col of columns) {
    for (const item of col.items) {
      const cat = item.category as ReadinessCategory | string;
      const code = item.code ?? "";
      const isRuleCategory = cat === "rule_runtime";
      // Belt-and-suspenders code prefix match for backends that ever
      // emit rule-runtime items under a different category.
      const isRuleCode =
        code.startsWith("READINESS_CONDITIONAL") ||
        code.startsWith("READINESS_UNCONDITIONAL") ||
        code.startsWith("READINESS_FILL") ||
        code.startsWith("READINESS_IF_LIMIT");
      if (!isRuleCategory && !isRuleCode) continue;
      out.push({ column: col, item });
    }
  }
  // Blocked first, warning next, ready last; within each, alphabetical.
  const rank: Record<string, number> = { blocked: 0, warning: 1, ready: 2 };
  out.sort((a, b) => {
    const ra = rank[normalizeStatus(a.item.status) ?? "warning"] ?? 1;
    const rb = rank[normalizeStatus(b.item.status) ?? "warning"] ?? 1;
    if (ra !== rb) return ra - rb;
    return a.column.column_name.localeCompare(b.column.column_name);
  });
  return out;
}

function pickTopItem(items: ReadinessItemOut[]): ReadinessItemOut | null {
  if (items.length === 0) return null;
  // Prefer blocked > warning > anything else.
  const blocked = items.find((i) => normalizeStatus(i.status) === "blocked");
  if (blocked) return blocked;
  const warning = items.find((i) => normalizeStatus(i.status) === "warning");
  if (warning) return warning;
  return items[0];
}

function stepDisplay(step: WizardStepKey): string {
  if (step === "advanced") return "Advanced";
  return `Step ${step}`;
}
