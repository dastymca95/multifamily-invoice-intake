"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Info,
  Loader2,
  Play,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { getApiErrorMessage, invoiceTemplatesApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  CellProvenance,
  MatchedRuleResult,
  ResolvedImportCell,
  ResolvedImportRow,
  ResolvedCellStatus,
  ResolverInput,
  ResolverIssue,
  ResolverResult,
  ResolverSeverity,
  ResolverStatus,
  ResolverSummary,
  RuleConditionEvaluation,
  RuleRestrictionEvaluation,
} from "@/types/import-resolver";

/**
 * Diagnostic preview surface for the Import Builder dry-run resolver.
 *
 * The backend at POST /invoice-templates/{id}/resolve-dry-run already
 * implements the full contract. This panel is purely a UI window onto
 * that contract:
 *
 *   * Run a dry-run against the LAST SAVED template (no auto-save,
 *     no template mutation, no export, no review queue, no OCR/AI).
 *   * Summarise rows + issues at the top.
 *   * Group resolver issues by severity (mirrors the validation panel).
 *   * Per row → cell table → expandable provenance.
 *   * Per matched rule → conditions + restrictions diagnostics.
 *   * Optional "Advanced test input" with JSON textareas for
 *     extracted_facts / catalog_hints / document_metadata so an
 *     operator can simulate a populated runtime payload without
 *     touching real OCR/AI.
 *
 * Nothing here is wired to mutating endpoints; the panel is read-only.
 */

// ---------------------------------------------------------------------------
// Status meta
// ---------------------------------------------------------------------------

interface StatusMeta {
  label: string;
  badge: string;
  icon: LucideIcon;
  iconClass: string;
}

const RESOLVER_STATUS_META: Record<ResolverStatus, StatusMeta> = {
  ready: {
    label: "Ready",
    badge:
      "bg-green-50 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900",
    icon: CheckCircle2,
    iconClass: "text-green-600 dark:text-green-400",
  },
  needs_review: {
    label: "Needs review",
    badge:
      "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900",
    icon: AlertTriangle,
    iconClass: "text-yellow-600 dark:text-yellow-400",
  },
  blocked: {
    label: "Blocked",
    badge:
      "bg-red-50 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
    icon: CircleAlert,
    iconClass: "text-red-600 dark:text-red-400",
  },
  conflict: {
    label: "Conflict",
    badge:
      "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-200 dark:border-orange-900",
    icon: AlertTriangle,
    iconClass: "text-orange-600 dark:text-orange-400",
  },
};

const CELL_STATUS_META: Record<ResolvedCellStatus, { label: string; tone: string }> = {
  resolved: {
    label: "Resolved",
    tone: "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900",
  },
  missing: {
    label: "Missing",
    tone: "bg-gray-100 text-gray-700 border-gray-200 dark:bg-surface-muted dark:text-ink-muted dark:border-line",
  },
  conflict: {
    label: "Conflict",
    tone: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-200 dark:border-orange-900",
  },
  fallback: {
    label: "Fallback",
    tone: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-200 dark:border-blue-900",
  },
  manual_review: {
    label: "Manual review",
    tone: "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900",
  },
  ignored: {
    label: "Ignored",
    tone: "bg-gray-50 text-gray-500 border-gray-200 dark:bg-surface-muted dark:text-ink-subtle dark:border-line",
  },
};

const SEVERITY_ORDER: ResolverSeverity[] = ["error", "warning", "info"];

const SEVERITY_META: Record<
  ResolverSeverity,
  { label: string; Icon: LucideIcon; badge: string; section: string; empty: string }
> = {
  error: {
    label: "Errors",
    Icon: CircleAlert,
    badge:
      "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
    section: "border-red-200 dark:border-red-900",
    empty: "No blocking errors.",
  },
  warning: {
    label: "Warnings",
    Icon: AlertTriangle,
    badge:
      "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900",
    section: "border-yellow-200 dark:border-yellow-900",
    empty: "No warnings.",
  },
  info: {
    label: "Info",
    Icon: Info,
    badge:
      "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-200 dark:border-blue-900",
    section: "border-blue-200 dark:border-blue-900",
    empty: "No info diagnostics.",
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ImportTemplateResolverPreviewPanelProps {
  templateId: string | null;
  templateName?: string | null;
  isOpen: boolean;
  onClose: () => void;
  hasUnsavedChanges?: boolean;
  /** True when the editor is showing the in-memory canonical-default
   *  draft (no persisted id yet) — disables the run button. */
  isDraft?: boolean;
  /**
   * Optional save handler — when provided AND there are unsaved
   * changes, the panel renders a "Save then run" button that awaits
   * the save and then automatically re-runs Dry Run against the
   * freshly-saved template, eliminating the "save outside the modal,
   * reopen, click Run" friction loop.
   *
   * Phase 1E refactored TemplateEditor.handleSave to return
   * Promise<void> so this chain works deterministically. Older
   * void-returning handlers still type-check (the panel just doesn't
   * await anything meaningful and re-runs immediately).
   */
  onSave?: () => Promise<void> | void;
  /** Whether the editor's Save button is currently enabled. */
  canSave?: boolean;
  /** Whether a save is currently in flight (parent-tracked). */
  saving?: boolean;
}

export function ImportTemplateResolverPreviewPanel({
  templateId,
  templateName,
  isOpen,
  onClose,
  hasUnsavedChanges,
  isDraft,
  onSave,
  canSave = false,
  saving = false,
}: ImportTemplateResolverPreviewPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolverResult | null>(null);

  // Advanced JSON input state — collapsed by default. Each textarea is
  // a free-form string the user types; we only parse on Run, so the
  // user can leave half-typed JSON in the box without breaking the UI.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [extractedFactsJson, setExtractedFactsJson] = useState("");
  const [catalogHintsJson, setCatalogHintsJson] = useState("");
  const [documentMetadataJson, setDocumentMetadataJson] = useState("");
  const [jsonErrors, setJsonErrors] = useState<{
    extracted_facts?: string;
    catalog_hints?: string;
    document_metadata?: string;
  }>({});

  // ---- Phase 1E — Save then run flow --------------------------------
  //
  // When the operator opens Dry Run with unsaved changes, we surface
  // a Save-then-run action that (1) awaits the parent save promise,
  // (2) then auto-fires a fresh dry-run against the saved template.
  // Eliminates the manual "close modal, click Save in editor, reopen
  // modal, click Run" friction loop.
  //
  // `saveThenRunBusy` is the panel-local lock for the chained flow;
  // distinct from the parent's `saving` prop (which guards the
  // editor's main Save button). Both are checked when disabling the
  // Save-then-run button to prevent double-fire.
  //
  // `resultIsStale` flips true the moment we have a result AND the
  // parent reports unsaved changes; used to label the result panel
  // so the operator never confuses old saved-version diagnostics
  // with their in-flight edits. Cleared after a fresh run.
  const [saveThenRunBusy, setSaveThenRunBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Request counter — guards against out-of-order responses if a
  // user fires multiple runs in quick succession. Belt-and-suspenders
  // race protection (the run promise itself is awaited in sequence
  // for Save-then-run, but the manual Run button can fire while a
  // previous run is settling).
  const runRequestIdRef = useRef(0);

  const handleRun = useCallback(async () => {
    if (!templateId || isDraft) return;

    // Parse the advanced JSON inputs (if any). Any parse error short-
    // circuits the request — we never POST half-typed JSON to the
    // backend. Empty strings are treated as "field omitted from payload".
    const nextErrors: typeof jsonErrors = {};
    let extractedFacts: ResolverInput["extracted_facts"];
    let catalogHints: ResolverInput["catalog_hints"];
    let documentMetadata: ResolverInput["document_metadata"];

    if (extractedFactsJson.trim()) {
      try {
        const parsed = JSON.parse(extractedFactsJson);
        if (!Array.isArray(parsed)) {
          nextErrors.extracted_facts = "Expected a JSON array.";
        } else {
          extractedFacts = parsed;
        }
      } catch (e) {
        nextErrors.extracted_facts = `Invalid JSON: ${(e as Error).message}`;
      }
    }
    if (catalogHintsJson.trim()) {
      try {
        const parsed = JSON.parse(catalogHintsJson);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          nextErrors.catalog_hints = "Expected a JSON object.";
        } else {
          catalogHints = parsed;
        }
      } catch (e) {
        nextErrors.catalog_hints = `Invalid JSON: ${(e as Error).message}`;
      }
    }
    if (documentMetadataJson.trim()) {
      try {
        const parsed = JSON.parse(documentMetadataJson);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          nextErrors.document_metadata = "Expected a JSON object.";
        } else {
          documentMetadata = parsed;
        }
      } catch (e) {
        nextErrors.document_metadata = `Invalid JSON: ${(e as Error).message}`;
      }
    }

    setJsonErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      // Force the advanced section open so the user can see + fix the
      // exact textarea that failed to parse.
      setAdvancedOpen(true);
      return;
    }

    // Build the payload. Omit fields the user didn't fill so the
    // backend defaults take effect (empty list / empty dict) instead
    // of receiving an explicit `null`.
    const payload: Partial<ResolverInput> = {};
    if (extractedFacts) payload.extracted_facts = extractedFacts;
    if (catalogHints) payload.catalog_hints = catalogHints;
    if (documentMetadata) payload.document_metadata = documentMetadata;

    // Bump request id BEFORE we await — any earlier in-flight request
    // sees a stale id when its response settles and will silently
    // discard its own setResult / setError. Belt-and-suspenders against
    // out-of-order responses from the chained Save-then-run flow or
    // rapid manual clicks.
    const requestId = ++runRequestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await invoiceTemplatesApi.resolveDryRun(templateId, payload);
      if (runRequestIdRef.current !== requestId) return;
      setResult(next);
    } catch (err) {
      if (runRequestIdRef.current !== requestId) return;
      setError(getApiErrorMessage(err, "Could not run the resolver dry-run."));
    } finally {
      if (runRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [
    templateId,
    isDraft,
    extractedFactsJson,
    catalogHintsJson,
    documentMetadataJson,
  ]);

  // Phase 1E — chained "Save then run" handler.
  //
  // Awaits the parent save (which may be a no-op or void-returning
  // legacy handler) and, only on success, fires a fresh dry-run. Any
  // save error short-circuits the run and surfaces inline so the
  // operator never gets stale results without realising the save
  // didn't land.
  //
  // We deliberately do NOT call this from anywhere except the user-
  // initiated "Save then run" button — Phase 1E spec explicitly
  // forbids silent auto-save when the operator clicks Run.
  const handleSaveThenRun = useCallback(async () => {
    if (!onSave || isDraft || saveThenRunBusy || saving) return;
    setSaveError(null);
    setSaveThenRunBusy(true);
    try {
      const maybePromise = onSave();
      if (
        maybePromise &&
        typeof (maybePromise as Promise<void>).then === "function"
      ) {
        await maybePromise;
      }
      // Save succeeded — fire the dry-run against the freshly
      // persisted template. handleRun has its own loading lock and
      // request-id guard, so it's safe to await here.
      await handleRun();
    } catch (err) {
      setSaveError(
        getApiErrorMessage(err, "Could not save the template before dry-run."),
      );
    } finally {
      setSaveThenRunBusy(false);
    }
  }, [onSave, isDraft, saveThenRunBusy, saving, handleRun]);

  const summary = useMemo(
    () => deriveSummary(result),
    [result],
  );

  const groupedIssues = useMemo(
    () => groupIssuesBySeverity(result?.issues ?? []),
    [result],
  );

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={
        templateName
          ? `Resolver dry-run · ${templateName}`
          : "Resolver dry-run"
      }
      size="xl"
    >
      <div className="space-y-4 max-h-[72vh] overflow-y-auto pr-1">
        {/* ---- Banners ------------------------------------------------- */}
        {isDraft && (
          <InlineAlert tone="warning">
            Save this template before running a dry-run. The resolver
            inspects the persisted version on the server.
          </InlineAlert>
        )}
        {!isDraft && hasUnsavedChanges && (
          // Phase 1E — strong unsaved-changes banner. Replaces the
          // older "Save and re-open" InlineAlert with a more visible
          // panel that owns its own primary "Save then run" CTA and
          // surfaces any save error inline. We use a custom div
          // (instead of InlineAlert) so the action area can host both
          // a button + helper copy + error line without fighting the
          // alert's compact layout.
          <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-3 dark:border-yellow-900 dark:bg-yellow-950/30">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-yellow-700 dark:text-yellow-300" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-yellow-900 dark:text-yellow-100">
                  Unsaved changes are not included in this dry-run
                </p>
                <p className="mt-0.5 text-xs text-yellow-800 dark:text-yellow-200">
                  Dry Run reads the LAST SAVED template from the
                  server. To test your local edits, save first.
                </p>
                {onSave && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={handleSaveThenRun}
                      disabled={
                        !canSave ||
                        loading ||
                        saveThenRunBusy ||
                        saving
                      }
                      loading={saveThenRunBusy || saving}
                    >
                      Save then run
                    </Button>
                    <span className="text-[11px] text-yellow-700 dark:text-yellow-300">
                      Saves the template, then runs a fresh dry-run.
                    </span>
                  </div>
                )}
                {saveError && (
                  <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                    Save failed: {saveError}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ---- Run controls ------------------------------------------- */}
        <div className="flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5 dark:border-line dark:bg-surface-muted">
          <p className="text-xs text-gray-600 dark:text-ink-muted">
            Diagnostic only — runs against the LAST SAVED template.
            Never mutates, exports, or touches Review Queue.
          </p>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={loading || !templateId || isDraft || saveThenRunBusy}
            loading={loading}
            onClick={handleRun}
            title={
              hasUnsavedChanges && !isDraft
                ? "Heads up: this uses the last SAVED template. Use 'Save then run' above to include your local edits."
                : "Run a diagnostic dry-run of the resolver."
            }
          >
            <Play className="h-3.5 w-3.5" />
            {result ? "Run again" : "Run dry-run"}
          </Button>
        </div>

        {/* ---- Advanced input ----------------------------------------- */}
        <AdvancedInput
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((v) => !v)}
          extractedFactsJson={extractedFactsJson}
          catalogHintsJson={catalogHintsJson}
          documentMetadataJson={documentMetadataJson}
          jsonErrors={jsonErrors}
          onChangeExtractedFacts={setExtractedFactsJson}
          onChangeCatalogHints={setCatalogHintsJson}
          onChangeDocumentMetadata={setDocumentMetadataJson}
        />

        {/* ---- Loading / error / empty -------------------------------- */}
        {loading && (
          <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin text-brand-600 dark:text-brand-50" />
            Running dry-run…
          </div>
        )}

        {error && !loading && <InlineAlert tone="error">{error}</InlineAlert>}

        {!loading && !error && !result && (
          <div className="rounded-md border border-dashed border-gray-300 bg-white px-4 py-6 text-center text-xs text-gray-500 dark:border-line dark:bg-surface-subtle dark:text-ink-muted">
            Run a dry-run to see how this template resolves sample
            invoice data. The result includes per-row cells, provenance,
            and matched-rule diagnostics.
          </div>
        )}

        {/* ---- Result ------------------------------------------------- */}
        {result && !loading && (
          <>
            {hasUnsavedChanges && !isDraft && (
              // Phase 1E — stale-result label. The result we are
              // rendering was computed against the saved template;
              // the operator's local edits are NOT reflected. Without
              // this label it is too easy to mistake "Ready" for
              // "Ready including my edits".
              <div className="rounded-md border border-yellow-200 bg-yellow-50/60 px-2.5 py-1.5 text-[11px] text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/20 dark:text-yellow-200">
                These results reflect the LAST SAVED version. Local
                edits since the last save are not included — use
                “Save then run” above to refresh.
              </div>
            )}

            <ResultStatusCard result={result} summary={summary} />

            <SummaryGrid summary={summary} />

            <div className="space-y-3">
              {SEVERITY_ORDER.map((severity) => (
                <IssueSection
                  key={severity}
                  severity={severity}
                  issues={groupedIssues[severity]}
                />
              ))}
            </div>

            {(result.rows ?? []).length > 0 && (
              <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
                <header className="border-b border-gray-100 px-3 py-2 text-sm font-semibold text-gray-800 dark:border-line/60 dark:text-ink">
                  Resolved rows
                </header>
                <div className="divide-y divide-gray-100 dark:divide-line/60">
                  {(result.rows ?? []).map((row) => (
                    <ResolvedRow key={row.row_index} row={row} />
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
// Status card + summary cards
// ---------------------------------------------------------------------------

function ResultStatusCard({
  result,
  summary,
}: {
  result: ResolverResult;
  summary: Required<ResolverSummary>;
}) {
  const meta = RESOLVER_STATUS_META[result.status] ?? RESOLVER_STATUS_META.needs_review;
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        "rounded-md border px-4 py-3 flex items-center justify-between gap-4",
        meta.badge,
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon className={cn("h-5 w-5 shrink-0", meta.iconClass)} />
        <div className="min-w-0">
          <div className="text-sm font-semibold">{meta.label}</div>
          <div className="text-xs opacity-80 truncate">
            {result.template_name ?? "Untitled template"}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs shrink-0">
        <SeverityPill severity="error" count={summary.error_count} />
        <SeverityPill severity="warning" count={summary.warning_count} />
        <SeverityPill severity="info" count={summary.info_count} />
      </div>
    </div>
  );
}

function SummaryGrid({ summary }: { summary: Required<ResolverSummary> }) {
  const cards: Array<{ label: string; value: number; tone: string }> = [
    { label: "Rows", value: summary.row_count, tone: "text-gray-700 dark:text-ink" },
    {
      label: "Ready",
      value: summary.ready_rows,
      tone: "text-green-700 dark:text-green-200",
    },
    {
      label: "Needs review",
      value: summary.needs_review_rows,
      tone: "text-yellow-700 dark:text-yellow-200",
    },
    {
      label: "Blocked",
      value: summary.blocked_rows,
      tone: "text-red-700 dark:text-red-200",
    },
    {
      label: "Conflict",
      value: summary.conflict_rows,
      tone: "text-orange-700 dark:text-orange-200",
    },
    {
      label: "Errors",
      value: summary.error_count,
      tone: "text-red-700 dark:text-red-200",
    },
    {
      label: "Warnings",
      value: summary.warning_count,
      tone: "text-yellow-700 dark:text-yellow-200",
    },
    {
      label: "Info",
      value: summary.info_count,
      tone: "text-blue-700 dark:text-blue-200",
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

function SeverityPill({
  severity,
  count,
}: {
  severity: ResolverSeverity;
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

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function IssueSection({
  severity,
  issues,
}: {
  severity: ResolverSeverity;
  issues: ResolverIssue[];
}) {
  const meta = SEVERITY_META[severity];
  const Icon = meta.Icon;
  return (
    <section
      className={cn(
        "rounded-md border bg-white dark:bg-surface-subtle",
        meta.section,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
          <Icon className="h-4 w-4" />
          {meta.label}
        </div>
        <span className="text-xs font-semibold text-gray-500 dark:text-ink-muted">
          {issues.length}
        </span>
      </div>
      {issues.length === 0 ? (
        <div className="px-3 py-3 text-xs text-gray-500 dark:text-ink-muted">
          {meta.empty}
        </div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-line/60">
          {issues.map((issue, idx) => (
            <IssueRow
              key={`${issue.code}-${issue.path ?? ""}-${idx}`}
              issue={issue}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function IssueRow({ issue }: { issue: ResolverIssue }) {
  const context = [
    issue.scope ? `Scope: ${issue.scope}` : null,
    issue.column_label ? `Column: ${issue.column_label}` : null,
    issue.rule_label || issue.rule_id
      ? `Rule: ${issue.rule_label || issue.rule_id}`
      : null,
    issue.field_key ? `Field: ${issue.field_key}` : null,
    issue.pattern_id ? `Pattern: ${issue.pattern_id}` : null,
  ].filter(Boolean);

  return (
    <div className="px-3 py-2.5 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-gray-900 dark:text-ink">
            {issue.message}
          </p>
          {context.length > 0 && (
            <p className="mt-1 text-gray-500 dark:text-ink-muted">
              {context.join(" · ")}
            </p>
          )}
          {issue.recommendation && (
            <p className="mt-1 text-gray-700 dark:text-ink-muted">
              {issue.recommendation}
            </p>
          )}
        </div>
        <span className="shrink-0 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gray-500 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
          {issue.code}
        </span>
      </div>
      {issue.path && (
        <div className="mt-1 font-mono text-[10px] text-gray-400 dark:text-ink-subtle">
          {issue.path}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resolved row (cells + matched rules)
// ---------------------------------------------------------------------------

function ResolvedRow({ row }: { row: ResolvedImportRow }) {
  const [open, setOpen] = useState(false);
  const meta = RESOLVER_STATUS_META[row.status] ?? RESOLVER_STATUS_META.needs_review;
  const Icon = meta.icon;
  const issueCount = row.issues?.length ?? 0;
  const cells = row.cells ?? [];
  const matchedRules = row.matched_rules ?? [];

  return (
    <div className="px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-left text-xs"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-ink-subtle" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-ink-subtle" />
        )}
        <span className="font-semibold text-gray-800 dark:text-ink">
          Row {row.row_index + 1}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
            meta.badge,
          )}
        >
          <Icon className="h-3 w-3" />
          {meta.label}
        </span>
        {row.confidence != null && (
          <span className="text-[10px] text-gray-500 dark:text-ink-muted">
            confidence {(row.confidence * 100).toFixed(0)}%
          </span>
        )}
        {issueCount > 0 && (
          <span className="text-[10px] text-gray-500 dark:text-ink-muted">
            {issueCount} issue{issueCount === 1 ? "" : "s"}
          </span>
        )}
        <span className="ml-auto text-[10px] text-gray-400 dark:text-ink-subtle">
          {cells.length} cell{cells.length === 1 ? "" : "s"}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-3 pl-5">
          {cells.length === 0 ? (
            <p className="text-xs text-gray-500 dark:text-ink-muted">
              No cells in this row.
            </p>
          ) : (
            <CellTable cells={cells} />
          )}

          {(row.issues ?? []).length > 0 && (
            <div className="rounded border border-gray-200 dark:border-line">
              <div className="px-3 py-1.5 text-[11px] font-semibold text-gray-700 dark:text-ink-muted">
                Row issues
              </div>
              <div className="divide-y divide-gray-100 dark:divide-line/60">
                {(row.issues ?? []).map((issue, idx) => (
                  <IssueRow
                    key={`row-${row.row_index}-${idx}`}
                    issue={issue}
                  />
                ))}
              </div>
            </div>
          )}

          {matchedRules.length > 0 && (
            <div className="rounded border border-gray-200 dark:border-line">
              <div className="px-3 py-1.5 text-[11px] font-semibold text-gray-700 dark:text-ink-muted">
                Matched rules ({matchedRules.length})
              </div>
              <div className="divide-y divide-gray-100 dark:divide-line/60">
                {matchedRules.map((rule) => (
                  <MatchedRuleCard
                    key={`${row.row_index}-${rule.rule_id}`}
                    rule={rule}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CellTable({ cells }: { cells: ResolvedImportCell[] }) {
  return (
    <div className="overflow-x-auto rounded border border-gray-200 dark:border-line">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 dark:bg-surface-muted">
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
            <th className="px-2 py-1.5 w-6"></th>
            <th className="px-2 py-1.5">Column</th>
            <th className="px-2 py-1.5">Value</th>
            <th className="px-2 py-1.5">Status</th>
            <th className="px-2 py-1.5">Source</th>
            <th className="px-2 py-1.5">Conf.</th>
            <th className="px-2 py-1.5">Issues</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-line/60">
          {cells.map((cell) => (
            <CellRow key={cell.column_id} cell={cell} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CellRow({ cell }: { cell: ResolvedImportCell }) {
  const [open, setOpen] = useState(false);
  const status = CELL_STATUS_META[cell.status] ?? {
    label: cell.status,
    tone:
      "bg-gray-100 text-gray-700 border-gray-200 dark:bg-surface-muted dark:text-ink-muted dark:border-line",
  };
  const issueCount = (cell.warnings?.length ?? 0) + (cell.issue_codes?.length ?? 0);
  const valueDisplay = formatCellValue(cell);

  return (
    <>
      <tr
        className="cursor-pointer hover:bg-gray-50 dark:hover:bg-surface-muted/50"
        onClick={() => setOpen((v) => !v)}
      >
        <td className="px-2 py-1.5 align-top text-gray-400 dark:text-ink-subtle">
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </td>
        <td className="px-2 py-1.5 align-top font-medium text-gray-800 dark:text-ink">
          {cell.column_label || cell.column_id}
        </td>
        <td className="px-2 py-1.5 align-top text-gray-700 dark:text-ink">
          {valueDisplay === null ? (
            <span className="text-gray-300 dark:text-ink-subtle">—</span>
          ) : (
            <span className="break-all">{valueDisplay}</span>
          )}
        </td>
        <td className="px-2 py-1.5 align-top">
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
              status.tone,
            )}
          >
            {status.label}
          </span>
        </td>
        <td className="px-2 py-1.5 align-top">
          <Badge color="gray">{cell.source_type}</Badge>
        </td>
        <td className="px-2 py-1.5 align-top text-gray-500 dark:text-ink-muted">
          {cell.confidence != null
            ? `${(cell.confidence * 100).toFixed(0)}%`
            : "—"}
        </td>
        <td className="px-2 py-1.5 align-top text-gray-500 dark:text-ink-muted">
          {issueCount}
        </td>
      </tr>
      {open && (
        <tr className="bg-gray-50/50 dark:bg-surface-muted/30">
          <td></td>
          <td colSpan={6} className="px-2 py-2">
            <CellDetails cell={cell} />
          </td>
        </tr>
      )}
    </>
  );
}

function CellDetails({ cell }: { cell: ResolvedImportCell }) {
  const warnings = cell.warnings ?? [];
  const codes = cell.issue_codes ?? [];
  return (
    <div className="space-y-2 text-[11px]">
      <ProvenanceBlock provenance={cell.provenance} />
      {(warnings.length > 0 || codes.length > 0) && (
        <div>
          <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
            Warnings & codes
          </p>
          <ul className="mt-1 space-y-0.5">
            {warnings.map((w, i) => (
              <li
                key={`w-${i}`}
                className="text-yellow-700 dark:text-yellow-200"
              >
                · {w}
              </li>
            ))}
            {codes.map((c, i) => (
              <li
                key={`c-${i}`}
                className="font-mono text-gray-500 dark:text-ink-muted"
              >
                · {c}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ProvenanceBlock({ provenance }: { provenance?: CellProvenance | null }) {
  if (!provenance) {
    return (
      <p className="text-gray-500 italic dark:text-ink-muted">
        No provenance available.
      </p>
    );
  }
  const rows: Array<[string, string | number | null | undefined]> = [
    ["source_type", provenance.source_type],
    ["source_label", provenance.source_label],
    ["source_detail", provenance.source_detail],
    ["rule_id", provenance.rule_id],
    ["rule_label", provenance.rule_label],
    ["pattern_id", provenance.pattern_id],
    ["field_key", provenance.field_key],
    ["normalized_field_key", provenance.normalized_field_key],
    ["catalog_id", provenance.catalog_id],
    ["entry_id", provenance.entry_id],
  ];
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
        Provenance
      </p>
      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
        {rows.map(([key, value]) => (
          <div key={key} className="flex gap-1.5">
            <dt className="font-mono text-gray-500 dark:text-ink-muted">
              {key}
            </dt>
            <dd className="text-gray-800 dark:text-ink truncate">
              {value === null || value === undefined || value === ""
                ? "—"
                : String(value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Matched rule diagnostics
// ---------------------------------------------------------------------------

function MatchedRuleCard({ rule }: { rule: MatchedRuleResult }) {
  const [open, setOpen] = useState(false);
  const matchedConditions = rule.matched_conditions ?? [];
  const restrictions = rule.restrictions ?? [];
  const actionIssues = rule.action_issues ?? [];

  const statusLabel = rule.matched
    ? rule.eligible_for_actions
      ? "Eligible"
      : "Matched"
    : rule.skipped
      ? "Skipped"
      : "Not matched";
  const statusTone = rule.matched
    ? rule.eligible_for_actions
      ? "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900"
      : "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900"
    : "bg-gray-100 text-gray-600 border-gray-200 dark:bg-surface-muted dark:text-ink-muted dark:border-line";

  return (
    <div className="px-3 py-2 text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-gray-400 dark:text-ink-subtle" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-gray-400 dark:text-ink-subtle" />
        )}
        <span className="font-semibold text-gray-800 dark:text-ink truncate">
          {rule.rule_label || rule.rule_id}
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
            statusTone,
          )}
        >
          {statusLabel}
        </span>
        {rule.restricted_out && (
          <span className="text-[10px] text-orange-600 dark:text-orange-300">
            restricted out
          </span>
        )}
        <span className="ml-auto text-[10px] text-gray-500 dark:text-ink-muted">
          cond {rule.conditions_passed ?? 0}/{rule.condition_count ?? 0}
          {" · "}
          rest {rule.restrictions_passed ?? 0}/{rule.restriction_count ?? 0}
          {" · "}
          act {rule.actions_applied ?? 0}
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-2 pl-5">
          {rule.skip_reason && (
            <p className="text-gray-600 italic dark:text-ink-muted">
              Skip reason: {rule.skip_reason}
            </p>
          )}

          {matchedConditions.length > 0 && (
            <ConditionList
              title="Conditions"
              items={matchedConditions}
            />
          )}

          {restrictions.length > 0 && (
            <RestrictionList items={restrictions} />
          )}

          {actionIssues.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
                Action issues
              </p>
              <div className="mt-1 divide-y divide-gray-100 rounded border border-gray-200 dark:divide-line/60 dark:border-line">
                {actionIssues.map((issue, idx) => (
                  <IssueRow key={`act-${idx}`} issue={issue} />
                ))}
              </div>
            </div>
          )}

          {(rule.issues ?? []).length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
                Rule issues
              </p>
              <div className="mt-1 divide-y divide-gray-100 rounded border border-gray-200 dark:divide-line/60 dark:border-line">
                {(rule.issues ?? []).map((issue, idx) => (
                  <IssueRow key={`ri-${idx}`} issue={issue} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConditionList({
  title,
  items,
}: {
  title: string;
  items: RuleConditionEvaluation[];
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
        {title}
      </p>
      <ul className="mt-1 space-y-1">
        {items.map((c, idx) => (
          <li
            key={`${c.column_id}-${idx}`}
            className="rounded border border-gray-200 px-2 py-1.5 dark:border-line"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-800 dark:text-ink">
                {c.column_label || c.column_id}
              </span>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
                  c.matched
                    ? "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900"
                    : "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
                )}
              >
                {c.matched ? "matched" : "failed"}
              </span>
            </div>
            <ExpectedActual
              expected={c.expected_values}
              actual={c.actual_values}
            />
            {c.issue_codes && c.issue_codes.length > 0 && (
              <p className="mt-0.5 font-mono text-[10px] text-gray-500 dark:text-ink-muted">
                {c.issue_codes.join(", ")}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RestrictionList({ items }: { items: RuleRestrictionEvaluation[] }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
        Restrictions
      </p>
      <ul className="mt-1 space-y-1">
        {items.map((r, idx) => (
          <li
            key={`${r.column_id}-${idx}`}
            className="rounded border border-gray-200 px-2 py-1.5 dark:border-line"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-800 dark:text-ink">
                {r.column_label || r.column_id}
              </span>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
                  r.passed
                    ? "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900"
                    : "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
                )}
              >
                {r.passed ? "passed" : "failed"}
              </span>
              {r.restricted_out && (
                <span className="text-[10px] text-orange-600 dark:text-orange-300">
                  restricted out
                </span>
              )}
            </div>
            <ExpectedActual
              expected={r.expected_values}
              actual={r.actual_values}
            />
            {r.issue_codes && r.issue_codes.length > 0 && (
              <p className="mt-0.5 font-mono text-[10px] text-gray-500 dark:text-ink-muted">
                {r.issue_codes.join(", ")}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExpectedActual({
  expected,
  actual,
}: {
  expected?: unknown[];
  actual?: unknown[];
}) {
  return (
    <div className="mt-0.5 grid grid-cols-2 gap-2 text-[10px]">
      <div>
        <span className="text-gray-500 dark:text-ink-muted">expected:</span>{" "}
        <span className="font-mono text-gray-700 dark:text-ink">
          {formatList(expected)}
        </span>
      </div>
      <div>
        <span className="text-gray-500 dark:text-ink-muted">actual:</span>{" "}
        <span className="font-mono text-gray-700 dark:text-ink">
          {formatList(actual)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advanced JSON input
// ---------------------------------------------------------------------------

interface AdvancedInputProps {
  open: boolean;
  onToggle: () => void;
  extractedFactsJson: string;
  catalogHintsJson: string;
  documentMetadataJson: string;
  jsonErrors: {
    extracted_facts?: string;
    catalog_hints?: string;
    document_metadata?: string;
  };
  onChangeExtractedFacts: (v: string) => void;
  onChangeCatalogHints: (v: string) => void;
  onChangeDocumentMetadata: (v: string) => void;
}

const PLACEHOLDER_FACTS = `[
  { "field_key": "amount", "value": 123.45, "source_type": "invoice_pattern", "confidence": 0.95 },
  { "field_key": "invoice_number", "value": "ABC123", "source_type": "invoice_pattern", "confidence": 0.98 }
]`;

const PLACEHOLDER_HINTS = `{
  "vendor": { "text": "EPB" },
  "property": { "text": "ADM" },
  "gl": { "text": "6915" }
}`;

const PLACEHOLDER_METADATA = `{
  "document_id": "doc-123",
  "page_count": 1
}`;

function AdvancedInput({
  open,
  onToggle,
  extractedFactsJson,
  catalogHintsJson,
  documentMetadataJson,
  jsonErrors,
  onChangeExtractedFacts,
  onChangeCatalogHints,
  onChangeDocumentMetadata,
}: AdvancedInputProps) {
  return (
    <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm font-semibold text-gray-700 dark:text-ink"
      >
        <span className="inline-flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          Advanced test input
        </span>
        <span className="text-[10px] font-normal text-gray-500 dark:text-ink-muted">
          Optional · simulate facts / hints / metadata
        </span>
      </button>
      {open && (
        <div className="border-t border-gray-100 px-3 py-3 space-y-3 dark:border-line/60">
          <JsonField
            label="Extracted facts (JSON array)"
            placeholder={PLACEHOLDER_FACTS}
            value={extractedFactsJson}
            onChange={onChangeExtractedFacts}
            error={jsonErrors.extracted_facts}
          />
          <JsonField
            label="Catalog hints (JSON object)"
            placeholder={PLACEHOLDER_HINTS}
            value={catalogHintsJson}
            onChange={onChangeCatalogHints}
            error={jsonErrors.catalog_hints}
          />
          <JsonField
            label="Document metadata (JSON object)"
            placeholder={PLACEHOLDER_METADATA}
            value={documentMetadataJson}
            onChange={onChangeDocumentMetadata}
            error={jsonErrors.document_metadata}
          />
        </div>
      )}
    </section>
  );
}

function JsonField({
  label,
  placeholder,
  value,
  onChange,
  error,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
        {label}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className={cn(
          "mt-1 w-full rounded border bg-white px-2 py-1.5 font-mono text-[11px] text-gray-800 outline-none",
          "focus:ring-2 focus:ring-brand-500",
          "dark:bg-surface dark:text-ink",
          error
            ? "border-red-300 dark:border-red-900"
            : "border-gray-200 dark:border-line",
        )}
      />
      {error && (
        <p className="mt-1 text-[10px] text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveSummary(result: ResolverResult | null): Required<ResolverSummary> {
  // Prefer the backend's summary; fall back to deriving from rows +
  // issues so an older / stripped-down response still renders sensible
  // numbers in the cards instead of zeros.
  const s = result?.summary ?? {};
  const rows = result?.rows ?? [];
  const issues = result?.issues ?? [];
  const derivedRowCounts = countByStatus(rows);
  const derivedIssueCounts = countBySeverity(issues);
  return {
    row_count: s.row_count ?? rows.length,
    ready_rows: s.ready_rows ?? derivedRowCounts.ready,
    needs_review_rows: s.needs_review_rows ?? derivedRowCounts.needs_review,
    blocked_rows: s.blocked_rows ?? derivedRowCounts.blocked,
    conflict_rows: s.conflict_rows ?? derivedRowCounts.conflict,
    error_count: s.error_count ?? derivedIssueCounts.error,
    warning_count: s.warning_count ?? derivedIssueCounts.warning,
    info_count: s.info_count ?? derivedIssueCounts.info,
  };
}

function countByStatus(rows: ResolvedImportRow[]) {
  const counts = { ready: 0, needs_review: 0, blocked: 0, conflict: 0 };
  for (const row of rows) {
    if (row.status === "ready") counts.ready += 1;
    else if (row.status === "needs_review") counts.needs_review += 1;
    else if (row.status === "blocked") counts.blocked += 1;
    else if (row.status === "conflict") counts.conflict += 1;
  }
  return counts;
}

function countBySeverity(issues: ResolverIssue[]) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) {
    if (issue.severity === "error") counts.error += 1;
    else if (issue.severity === "warning") counts.warning += 1;
    else if (issue.severity === "info") counts.info += 1;
  }
  return counts;
}

function groupIssuesBySeverity(issues: ResolverIssue[]) {
  return SEVERITY_ORDER.reduce(
    (acc, severity) => {
      acc[severity] = issues.filter((i) => i.severity === severity);
      return acc;
    },
    { error: [], warning: [], info: [] } as Record<
      ResolverSeverity,
      ResolverIssue[]
    >,
  );
}

/**
 * Pick the friendliest representation of a cell value to render in
 * the table. Returns `null` when the value is genuinely empty so the
 * caller can paint a muted dash instead.
 */
function formatCellValue(cell: ResolvedImportCell): string | null {
  if (cell.formatted_value != null && cell.formatted_value !== "") {
    return cell.formatted_value;
  }
  const candidate =
    cell.normalized_value !== undefined && cell.normalized_value !== null
      ? cell.normalized_value
      : cell.value;
  if (candidate === undefined || candidate === null || candidate === "") {
    return null;
  }
  if (typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean") {
    return String(candidate);
  }
  try {
    return JSON.stringify(candidate);
  } catch {
    return String(candidate);
  }
}

function formatList(values: unknown[] | undefined): string {
  if (!values || values.length === 0) return "—";
  return values
    .map((v) => {
      if (v === null || v === undefined) return "null";
      if (typeof v === "string") return JSON.stringify(v);
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    })
    .join(", ");
}
