"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { cn } from "@/lib/utils";
import {
  findResolvedField,
  type ResolvedField,
} from "@/types/invoice-pattern";
import type {
  ImportTemplateCoverageSummary,
  InvoicePatternImportCoverage,
  RequiredColumnCoverage,
  RequiredColumnStatus,
} from "@/types/invoice-pattern-coverage";

/**
 * Right-rail "Coverage" tab — answers the question
 * "is this pattern actually being used by my Import Builder
 * templates, and which required columns are still bare?".
 *
 * Always renders top-down regardless of selection state, because
 * Coverage is a pattern-level diagnostic (unlike the Region tab,
 * which is per-region). Three layers:
 *
 *   1. Aggregate header — "M of N templates use this pattern · X of Y
 *      required columns satisfied". Comes from the response's pre-
 *      computed `aggregate` so the panel never has to fold the
 *      per-template arrays itself.
 *   2. Optional template scope hint — explains what the toolbar
 *      template-scope selector is filtering when it's not on
 *      "All templates".
 *   3. Per-template accordion — one collapsible row per template
 *      in the response. Inside each: used fields (with a list of
 *      rule-cell deep-links) and required-column status table.
 *
 * Read-only. The Coverage panel NEVER writes to Import Builder
 * mappings — see Part 8 of the spec. Operators who want to wire
 * something up follow the deep-link to the Import Builder editor.
 */
interface CoveragePanelProps {
  data: InvoicePatternImportCoverage | null;
  loading: boolean;
  error: string | null;
  /**
   * The toolbar's current template scope. `null` = "All templates".
   * When set, the panel collapses every other template into a hint at
   * the top of the per-template list, but still renders the chosen
   * template's section.
   */
  scopedTemplateId: string | null;
  /**
   * Resolved field universe for the open pattern — used to render
   * field swatches + labels in the "Used fields" subsection. Same
   * resolver as the Draw-as dropdown, so a custom field's color is
   * consistent across overlay, inspector, and coverage list.
   */
  resolvedFields: readonly ResolvedField[];
  onRefresh: () => void | Promise<void>;
}

export function CoveragePanel({
  data,
  loading,
  error,
  scopedTemplateId,
  resolvedFields,
  onRefresh,
}: CoveragePanelProps) {
  // Loading / error / empty states first — keeps the happy-path JSX
  // below uncluttered.
  if (loading && !data) {
    return (
      <div className="h-full bg-white border-l border-gray-200 px-4 py-4 flex items-center justify-center dark:bg-surface-subtle dark:border-line">
        <Loader2 className="h-4 w-4 animate-spin text-gray-400 dark:text-ink-subtle" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="h-full bg-white border-l border-gray-200 px-4 py-4 space-y-3 overflow-auto dark:bg-surface-subtle dark:border-line">
        <PanelHeader
          loading={loading}
          onRefresh={onRefresh}
          updatedHint="Couldn't load coverage."
        />
        <InlineAlert tone="error" title="Coverage unavailable">
          {error}
        </InlineAlert>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="h-full bg-white border-l border-gray-200 px-4 py-4 space-y-2 dark:bg-surface-subtle dark:border-line">
        <PanelHeader loading={loading} onRefresh={onRefresh} />
        <p className="text-[11.5px] text-gray-500 leading-relaxed dark:text-ink-muted">
          No coverage data yet. Save the pattern to generate one.
        </p>
      </div>
    );
  }

  return <CoveragePanelBody
    data={data}
    loading={loading}
    error={error}
    scopedTemplateId={scopedTemplateId}
    resolvedFields={resolvedFields}
    onRefresh={onRefresh}
  />;
}

/**
 * Happy path — separated so the early-return guards above stay flat
 * and the body can declare its derived state at the top without
 * re-checking the null gates on every render.
 */
interface CoveragePanelBodyProps
  extends Omit<CoveragePanelProps, "data"> {
  data: InvoicePatternImportCoverage;
}

function CoveragePanelBody({
  data,
  loading,
  error,
  scopedTemplateId,
  resolvedFields,
  onRefresh,
}: CoveragePanelBodyProps) {
  const { aggregate, templates } = data;
  const totalTemplates = templates.length;
  // Templates that actually reference this pattern via any rule-cell
  // extraction binding. The aggregate counters track required-column
  // coverage across ALL templates in the response, not just these — so
  // we compute `wiredTemplates` separately for the header chip.
  const wiredTemplates = useMemo(
    () => templates.filter((t) => t.used_field_keys.length > 0).length,
    [templates],
  );

  // Templates to render in the accordion. Honours the toolbar scope:
  //   * `null` (All templates) → render every template, with wired
  //     ones first (so the empty templates fall to the bottom of the
  //     list) then by template name.
  //   * specific id → just that template (or empty list when the id
  //     no longer matches anything in the response).
  const orderedTemplates = useMemo(() => {
    if (scopedTemplateId) {
      return templates.filter((t) => t.template_id === scopedTemplateId);
    }
    const sorted = [...templates];
    sorted.sort((a, b) => {
      const aWired = a.used_field_keys.length > 0 ? 0 : 1;
      const bWired = b.used_field_keys.length > 0 ? 0 : 1;
      if (aWired !== bWired) return aWired - bWired;
      return a.template_name.localeCompare(b.template_name);
    });
    return sorted;
  }, [templates, scopedTemplateId]);

  return (
    <div className="h-full bg-white border-l border-gray-200 px-4 py-4 space-y-3 overflow-auto dark:bg-surface-subtle dark:border-line">
      <PanelHeader loading={loading} onRefresh={onRefresh} />

      {error && (
        // Inline error chip when a refresh failed but we still have
        // last-known data to render. Don't blank the panel.
        <InlineAlert tone="warning" title="Refresh failed">
          {error}
        </InlineAlert>
      )}

      {/* ---- Aggregate stats -------------------------------------- */}
      <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2 space-y-1.5 dark:bg-surface-muted dark:border-line">
        <StatRow
          label="Templates using this pattern"
          numerator={wiredTemplates}
          denominator={totalTemplates}
          emphasis={
            wiredTemplates === 0 ? "warn" : "ok"
          }
        />
        <StatRow
          label="Pattern fields used"
          numerator={aggregate.used_fields_count}
          denominator={aggregate.total_fields_in_pattern}
          emphasis={
            aggregate.used_fields_count === 0
              ? "warn"
              : "ok"
          }
        />
        <StatRow
          label="Required columns satisfied"
          numerator={aggregate.satisfied_required_columns}
          denominator={aggregate.total_required_columns}
          emphasis={
            aggregate.missing_required_columns > 0 ? "warn" : "ok"
          }
        />
      </div>

      {/* ---- Scope hint (toolbar filter is engaged) -------------- */}
      {scopedTemplateId && orderedTemplates.length === 0 && (
        <InlineAlert tone="info" title="Template not in response">
          The selected template is no longer in the workspace. Switch
          to &ldquo;All templates&rdquo; to refresh the list.
        </InlineAlert>
      )}

      {/* ---- Per-template accordion ------------------------------ */}
      {orderedTemplates.length === 0 && !scopedTemplateId && (
        <p className="text-[11.5px] text-gray-500 leading-relaxed dark:text-ink-muted">
          No Import Builder templates exist yet. Create one in the
          Import Builder, then bind a rule cell to this pattern to
          start wiring fields.
        </p>
      )}

      <ul className="space-y-1.5">
        {orderedTemplates.map((t) => (
          <TemplateRow
            key={t.template_id}
            template={t}
            resolvedFields={resolvedFields}
            // When the user has scoped to a single template, render its
            // accordion already-expanded — nothing else to scroll past.
            initiallyExpanded={
              scopedTemplateId === t.template_id ||
              (orderedTemplates.length === 1 &&
                t.used_field_keys.length > 0)
            }
          />
        ))}
      </ul>

      {/* ---- Footer hint ----------------------------------------- */}
      <p className="text-[10.5px] text-gray-400 leading-relaxed pt-1 dark:text-ink-subtle">
        Pattern → template references are derived from each template&rsquo;s
        rule-cell extraction bindings. Edits land in the Import Builder.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header / stats bits
// ---------------------------------------------------------------------------

function PanelHeader({
  loading,
  onRefresh,
  updatedHint,
}: {
  loading: boolean;
  onRefresh: () => void | Promise<void>;
  updatedHint?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-ink">
          Coverage
        </h2>
        {loading && (
          <Loader2 className="h-3 w-3 animate-spin text-gray-400 dark:text-ink-subtle" />
        )}
      </div>
      <div className="flex items-center gap-2">
        {updatedHint && (
          <span className="text-[10.5px] text-gray-400 dark:text-ink-subtle">
            {updatedHint}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void onRefresh()}
          title="Refresh coverage"
          aria-label="Refresh coverage"
          disabled={loading}
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

/**
 * One "M of N — label" row in the aggregate stats block. The
 * numerator pops bold and tinted by emphasis so the operator's eye
 * lands on the bad rows first ("3 of 7 templates" → wants attention).
 */
function StatRow({
  label,
  numerator,
  denominator,
  emphasis,
}: {
  label: string;
  numerator: number;
  denominator: number;
  emphasis: "ok" | "warn";
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
      <span className="text-gray-600 dark:text-ink-muted">{label}</span>
      <span
        className={cn(
          "tabular-nums font-semibold",
          emphasis === "warn"
            ? "text-amber-700 dark:text-yellow-200"
            : "text-emerald-700 dark:text-emerald-300",
        )}
      >
        {numerator}
        <span className="text-gray-400 font-normal dark:text-ink-subtle">
          {" "}
          of {denominator}
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-template accordion row
// ---------------------------------------------------------------------------

function TemplateRow({
  template,
  resolvedFields,
  initiallyExpanded,
}: {
  template: ImportTemplateCoverageSummary;
  resolvedFields: readonly ResolvedField[];
  initiallyExpanded: boolean;
}) {
  const [open, setOpen] = useState(initiallyExpanded);
  const wired = template.used_field_keys.length > 0;
  const missing = template.missing_required_columns.length;
  const satisfied = template.coverage.satisfied_required_columns;
  const totalRequired = template.coverage.total_required_columns;

  return (
    <li
      className={cn(
        "rounded-md border bg-white dark:bg-surface",
        wired
          ? "border-gray-200 dark:border-line"
          : "border-dashed border-gray-200 dark:border-line",
      )}
    >
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 hover:bg-gray-50 rounded-md text-left dark:hover:bg-surface-muted"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {open ? (
            <ChevronDown className="h-3 w-3 text-gray-500 dark:text-ink-subtle shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-gray-500 dark:text-ink-subtle shrink-0" />
          )}
          <span
            className={cn(
              "text-[12px] truncate",
              wired
                ? "font-medium text-gray-800 dark:text-ink"
                : "text-gray-500 dark:text-ink-subtle",
            )}
            title={template.template_name}
          >
            {template.template_name}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!wired && (
            <span className="text-[10px] text-gray-400 dark:text-ink-subtle">
              no fields
            </span>
          )}
          {wired && (
            <span className="text-[10px] text-gray-500 dark:text-ink-muted tabular-nums">
              {template.used_field_keys.length} fld
            </span>
          )}
          {totalRequired > 0 && (
            <span
              className={cn(
                "text-[10px] tabular-nums px-1.5 py-[1px] rounded-full",
                missing > 0
                  ? "bg-amber-50 text-amber-700 dark:bg-yellow-950/40 dark:text-yellow-200"
                  : "bg-emerald-50 text-emerald-700 dark:bg-green-950/40 dark:text-green-200",
              )}
              title={
                missing > 0
                  ? `${missing} required column${missing === 1 ? "" : "s"} unresolved`
                  : "All required columns satisfied"
              }
            >
              {satisfied}/{totalRequired} req
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-2 pt-1 space-y-3 border-t border-gray-100 dark:border-line/60">
          {/* Used fields — list with rule-cell deep links */}
          {template.used_fields.length === 0 ? (
            <div className="rounded bg-gray-50 px-2 py-1.5 text-[11px] text-gray-600 dark:bg-surface-muted dark:text-ink-muted">
              This template has no rule cells bound to this pattern. Open
              the template editor and add an extraction binding to wire
              one of this pattern&rsquo;s fields.
            </div>
          ) : (
            <UsedFieldsList
              template={template}
              resolvedFields={resolvedFields}
            />
          )}

          {/* Required columns table */}
          {template.required_columns.length === 0 ? (
            <p className="text-[10.5px] text-gray-400 dark:text-ink-subtle">
              This template has no required columns.
            </p>
          ) : (
            <RequiredColumnsList
              templateId={template.template_id}
              columns={template.required_columns}
            />
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Sub-lists inside a template row
// ---------------------------------------------------------------------------

function UsedFieldsList({
  template,
  resolvedFields,
}: {
  template: ImportTemplateCoverageSummary;
  resolvedFields: readonly ResolvedField[];
}) {
  return (
    <div>
      <p className="text-[10.5px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle font-semibold mb-1">
        Used fields
      </p>
      <ul className="space-y-1">
        {template.used_fields.map((uf) => {
          const resolved = findResolvedField(uf.field_key, resolvedFields);
          const swatch = resolved?.color ?? "#9ca3af";
          return (
            <li
              key={uf.field_key}
              className="rounded border border-gray-100 px-2 py-1 dark:border-line/60"
            >
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-3 w-3 rounded-sm border border-black/10 shrink-0"
                  style={{ backgroundColor: swatch }}
                  aria-hidden
                />
                <span className="text-[12px] text-gray-800 dark:text-ink truncate">
                  {uf.field_label || uf.field_key}
                </span>
                <span className="ml-auto text-[10px] text-gray-500 dark:text-ink-muted tabular-nums">
                  {uf.used_by.length} cell{uf.used_by.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="mt-1 ml-5 space-y-0.5">
                {uf.used_by.map((u, i) => (
                  <li
                    key={`${u.template_id}:${u.rule_id}:${u.column_id}:${i}`}
                    className="flex items-center gap-1 text-[10.5px] text-gray-600 dark:text-ink-muted"
                  >
                    <Link
                      href={`/import-builder?template=${u.template_id}`}
                      className="text-brand-700 hover:underline truncate inline-flex items-center gap-0.5 dark:text-brand-50"
                      title="Open this template in the Import Builder"
                    >
                      <span className="truncate">
                        Rule {u.rule_index} → {u.column_name}
                      </span>
                      <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                    </Link>
                    {u.column_required && (
                      <span className="px-1 py-[1px] rounded text-[9px] font-bold tracking-wide bg-amber-50 text-amber-700 dark:bg-yellow-950/40 dark:text-yellow-200">
                        REQ
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RequiredColumnsList({
  templateId,
  columns,
}: {
  templateId: string;
  columns: readonly RequiredColumnCoverage[];
}) {
  return (
    <div>
      <p className="text-[10.5px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle font-semibold mb-1">
        Required columns
      </p>
      <ul className="space-y-0.5">
        {columns.map((c) => (
          <li
            key={c.column_id}
            className="flex items-center gap-1.5 text-[11px]"
          >
            <StatusDot status={c.status} />
            <span
              className="truncate text-gray-800 dark:text-ink"
              title={`${c.column_name} · ${c.data_type}`}
            >
              {c.column_name}
            </span>
            {c.extraction_field_key && (
              <span className="text-[9.5px] text-gray-500 dark:text-ink-muted truncate ml-auto shrink-0">
                ← {c.extraction_field_key}
              </span>
            )}
            {!c.extraction_field_key && (
              <span className="text-[9.5px] text-gray-500 dark:text-ink-muted ml-auto shrink-0">
                <StatusDescription status={c.status} />
              </span>
            )}
          </li>
        ))}
      </ul>
      {columns.some((c) => c.status === "missing") && (
        <Link
          href={`/import-builder?template=${templateId}`}
          className="mt-1 inline-flex items-center gap-0.5 text-[10.5px] text-brand-700 hover:underline"
        >
          Open template to fix
          <ExternalLink className="h-2.5 w-2.5" />
        </Link>
      )}
    </div>
  );
}

/** Single-character status indicator for the required-column rows. */
function StatusDot({ status }: { status: RequiredColumnStatus }) {
  switch (status) {
    case "satisfied_by_extraction":
      return (
        <CheckCircle2
          className="h-3 w-3 text-emerald-600 shrink-0"
          aria-label="Satisfied via extraction"
        />
      );
    case "satisfied_by_default":
    case "satisfied_by_catalog":
    case "satisfied_by_manual_or_rule":
      return (
        <CheckCircle2
          className="h-3 w-3 text-gray-400 dark:text-ink-subtle shrink-0"
          aria-label="Satisfied via fallback"
        />
      );
    case "missing":
      return (
        <AlertTriangle
          className="h-3 w-3 text-amber-600 dark:text-yellow-400 shrink-0"
          aria-label="Missing"
        />
      );
    default:
      return (
        <Info
          className="h-3 w-3 text-gray-400 dark:text-ink-subtle shrink-0"
          aria-hidden
        />
      );
  }
}

/**
 * Suffix copy used in required-column rows when there's no extraction
 * field to credit. Tells the operator WHICH fallback path resolved the
 * column — same semantic taxonomy as the backend resolver.
 */
function StatusDescription({ status }: { status: RequiredColumnStatus }) {
  switch (status) {
    case "satisfied_by_default":
      return <Fragment>default</Fragment>;
    case "satisfied_by_catalog":
      return <Fragment>catalog</Fragment>;
    case "satisfied_by_manual_or_rule":
      return <Fragment>rule / manual</Fragment>;
    case "satisfied_by_extraction":
      return <Fragment>broad extraction</Fragment>;
    case "missing":
      return <Fragment>no source</Fragment>;
    default:
      return null;
  }
}
