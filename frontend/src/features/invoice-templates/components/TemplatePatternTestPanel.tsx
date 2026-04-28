"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FlaskConical,
  Info,
  Loader2,
  Play,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import {
  getApiErrorMessage,
  invoicePatternsApi,
  invoiceTemplatesApi,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  ExtractedFact,
  ResolvedImportCell,
  ResolvedImportRow,
  ResolverIssue,
  ResolverSeverity,
  ResolverStatus,
} from "@/types/import-resolver";
import type { InvoicePatternSummary } from "@/types/invoice-pattern";
import type {
  TemplatePatternTestRequest,
  TemplatePatternTestResult,
} from "@/types/template-pattern-test-runner";

/**
 * Phase 2C — Template + Pattern Test Runner UI.
 *
 * Frontend window onto the Phase 2B endpoint:
 *
 *   POST /api/v1/invoice-templates/{templateId}
 *        /test-with-pattern/{patternId}
 *
 * Lets the operator pick a saved invoice pattern, type manual
 * extracted-fact values + catalog hints, fire the diagnostic test,
 * and inspect what the resolver would do with that input.
 *
 * Hard constraints (carried over from the backend contract):
 *
 *   * Diagnostic only — never mutates the template / pattern, never
 *     enqueues review work, never exports.
 *   * Uses the SAVED template (the endpoint's URL is by id). Local
 *     unsaved edits are NOT included; the panel surfaces a strong
 *     warning + "Save then test" CTA when the editor is dirty.
 *   * Drafts (no persisted id yet) cannot be tested — Run is
 *     disabled and the operator is told to save first.
 *   * No OCR / AI / PDF parsing — the operator simulates extraction
 *     by typing values into the quick-fields form (or the advanced
 *     JSON editor for power users).
 */

// ---------------------------------------------------------------------------
// Quick-fields catalog
// ---------------------------------------------------------------------------
//
// The list below is a curated subset of the canonical extracted-field
// registry — the fields operators most commonly want to test against
// (identity, dates, amounts, accounting hints). Anything else can be
// typed into the Advanced JSON editor below.

interface QuickFieldDescriptor {
  key: string;
  label: string;
  placeholder?: string;
  /** Wider input for fields like service_address. */
  wide?: boolean;
}

const QUICK_FACT_FIELDS: readonly QuickFieldDescriptor[] = [
  { key: "invoice_number", label: "Invoice Number", placeholder: "INV-12345" },
  { key: "account_number", label: "Account Number", placeholder: "ACCT-001" },
  { key: "invoice_date", label: "Invoice Date", placeholder: "2026-04-10" },
  { key: "due_date", label: "Due Date", placeholder: "2026-05-10" },
  { key: "total_amount", label: "Total Amount", placeholder: "155.25" },
  { key: "subtotal", label: "Subtotal", placeholder: "140.00" },
  { key: "tax_amount", label: "Tax Amount", placeholder: "15.25" },
  {
    key: "service_period_start",
    label: "Service Period Start",
    placeholder: "2026-03-01",
  },
  {
    key: "service_period_end",
    label: "Service Period End",
    placeholder: "2026-03-31",
  },
  { key: "vendor_name", label: "Vendor Name", placeholder: "EPB", wide: true },
  {
    key: "property_name",
    label: "Property Name",
    placeholder: "ADM",
    wide: true,
  },
  {
    key: "service_address",
    label: "Service Address",
    placeholder: "123 Main St, Chattanooga TN",
    wide: true,
  },
];

// ---------------------------------------------------------------------------
// Status meta — local copy because the test runner has its own
// presentation tier (mirrors the dry-run panel and Validate panel
// vocabularies but tuned to the test runner's layout).
// ---------------------------------------------------------------------------

interface StatusMeta {
  label: string;
  badge: string;
  banner: string;
  Icon: LucideIcon;
  iconClass: string;
}

const RESOLVER_STATUS_META: Record<string, StatusMeta> = {
  ready: {
    label: "Ready",
    badge:
      "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900",
    banner:
      "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40",
    Icon: CheckCircle2,
    iconClass: "text-green-600 dark:text-green-400",
  },
  needs_review: {
    label: "Needs review",
    badge:
      "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900",
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
  conflict: {
    label: "Conflict",
    badge:
      "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-200 dark:border-orange-900",
    banner:
      "border-orange-200 bg-orange-50 dark:border-orange-900 dark:bg-orange-950/40",
    Icon: AlertTriangle,
    iconClass: "text-orange-600 dark:text-orange-400",
  },
};

const SEVERITY_META: Record<
  ResolverSeverity,
  { label: string; Icon: LucideIcon; badge: string; tone: string }
> = {
  error: {
    label: "Errors",
    Icon: CircleAlert,
    badge:
      "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
    tone: "border-red-200 dark:border-red-900",
  },
  warning: {
    label: "Warnings",
    Icon: AlertTriangle,
    badge:
      "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900",
    tone: "border-yellow-200 dark:border-yellow-900",
  },
  info: {
    label: "Info",
    Icon: Info,
    badge:
      "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-200 dark:border-blue-900",
    tone: "border-blue-200 dark:border-blue-900",
  },
};

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface TemplatePatternTestPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Persisted template id, or null for an unsaved draft. */
  templateId: string | null;
  templateName?: string | null;
  hasUnsavedChanges?: boolean;
  /** True iff editor has the in-memory canonical-default draft. */
  isDraft?: boolean;
  /** Whether the editor's Save would succeed if invoked now. */
  canSave?: boolean;
  /** True iff a save is currently in flight (parent-tracked). */
  saving?: boolean;
  /**
   * Persist-to-server hook (TemplateEditor.handleSave). Resolves on
   * success, REJECTS on save failure (Phase 1E semantics). The
   * panel's "Save then test" button awaits it before firing the
   * test. Optional — when absent the panel shows no Save-then-test
   * flow.
   */
  onSaveTemplate?: () => Promise<void> | void;
}

export function TemplatePatternTestPanel({
  isOpen,
  onClose,
  templateId,
  templateName,
  hasUnsavedChanges = false,
  isDraft = false,
  canSave = false,
  saving = false,
  onSaveTemplate,
}: TemplatePatternTestPanelProps) {
  // ---- Pattern listing -------------------------------------------
  const [patterns, setPatterns] = useState<InvoicePatternSummary[]>([]);
  const [loadingPatterns, setLoadingPatterns] = useState(false);
  const [patternsError, setPatternsError] = useState<string | null>(null);
  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(
    null,
  );

  // ---- Quick-fields state ----------------------------------------
  // Indexed by canonical field key. Empty / whitespace-only entries
  // are skipped at payload construction so the resolver never sees
  // synthetic blank facts.
  const [quickFacts, setQuickFacts] = useState<Record<string, string>>({});
  const [vendorHint, setVendorHint] = useState("");
  const [propertyHint, setPropertyHint] = useState("");
  const [glHint, setGlHint] = useState("");
  const [includeEmptyFields, setIncludeEmptyFields] = useState(false);

  // ---- Advanced JSON editor (collapsed by default) ---------------
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [factsJson, setFactsJson] = useState("");
  const [hintsJson, setHintsJson] = useState("");
  const [runtimeOptionsJson, setRuntimeOptionsJson] = useState("");
  const [docMetadataJson, setDocMetadataJson] = useState("");
  const [jsonErrors, setJsonErrors] = useState<{
    facts?: string;
    hints?: string;
    runtime_options?: string;
    document_metadata?: string;
  }>({});

  // ---- Run state -------------------------------------------------
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<TemplatePatternTestResult | null>(null);

  // ---- Save then test (chained) ----------------------------------
  const [saveThenTestBusy, setSaveThenTestBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ---- Race-protected request id ---------------------------------
  const runRequestIdRef = useRef(0);
  const runAbortRef = useRef<AbortController | null>(null);

  // ---- Pattern fetch on open -------------------------------------
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      setLoadingPatterns(true);
      setPatternsError(null);
      try {
        const list = await invoicePatternsApi.list(200, 0);
        if (cancelled) return;
        setPatterns(list.items ?? []);
        // Auto-select the first pattern when nothing is selected yet
        // — the operator usually wants to see the result for the
        // most-recently-edited pattern, which sorts to the top.
        if ((list.items ?? []).length > 0) {
          setSelectedPatternId((curr) =>
            curr && (list.items ?? []).some((p) => p.id === curr)
              ? curr
              : (list.items ?? [])[0].id,
          );
        }
      } catch (err) {
        if (cancelled) return;
        setPatternsError(
          getApiErrorMessage(err, "Could not load invoice patterns."),
        );
      } finally {
        if (!cancelled) setLoadingPatterns(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // ---- Cleanup in-flight test request when panel closes ----------
  useEffect(() => {
    if (!isOpen) {
      runAbortRef.current?.abort();
    }
  }, [isOpen]);

  // ---- Payload construction --------------------------------------
  // Builds a TemplatePatternTestRequest from the quick-fields form +
  // advanced JSON editor. Returns ``null`` (and sets jsonErrors) when
  // any JSON textarea fails to parse — caller short-circuits Run.
  const buildPayload = useCallback((): TemplatePatternTestRequest | null => {
    const errors: typeof jsonErrors = {};

    // Quick facts → record. Skip blanks.
    const factsFromQuick: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(quickFacts)) {
      if (value && value.trim()) {
        factsFromQuick[key] = value.trim();
      }
    }

    // Advanced JSON facts merge ON TOP of quick facts (operator
    // intent: explicit JSON is the override).
    let factsFromJson: Record<string, unknown> = {};
    if (factsJson.trim()) {
      try {
        const parsed = JSON.parse(factsJson);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          errors.facts = "Expected a JSON object.";
        } else {
          factsFromJson = parsed as Record<string, unknown>;
        }
      } catch (e) {
        errors.facts = `Invalid JSON: ${(e as Error).message}`;
      }
    }
    const manual_fact_values = { ...factsFromQuick, ...factsFromJson };

    // Quick catalog hints → record. Skip blanks.
    const hintsFromQuick: Record<string, unknown> = {};
    if (vendorHint.trim()) hintsFromQuick.vendor = vendorHint.trim();
    if (propertyHint.trim()) hintsFromQuick.property = propertyHint.trim();
    if (glHint.trim()) hintsFromQuick.gl = glHint.trim();

    let hintsFromJson: Record<string, unknown> = {};
    if (hintsJson.trim()) {
      try {
        const parsed = JSON.parse(hintsJson);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          errors.hints = "Expected a JSON object.";
        } else {
          hintsFromJson = parsed as Record<string, unknown>;
        }
      } catch (e) {
        errors.hints = `Invalid JSON: ${(e as Error).message}`;
      }
    }
    const manual_catalog_hints = { ...hintsFromQuick, ...hintsFromJson };

    let runtime_options: Record<string, unknown> | undefined;
    if (runtimeOptionsJson.trim()) {
      try {
        const parsed = JSON.parse(runtimeOptionsJson);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          errors.runtime_options = "Expected a JSON object.";
        } else {
          runtime_options = parsed as Record<string, unknown>;
        }
      } catch (e) {
        errors.runtime_options = `Invalid JSON: ${(e as Error).message}`;
      }
    }

    let document_metadata: Record<string, unknown> | undefined;
    if (docMetadataJson.trim()) {
      try {
        const parsed = JSON.parse(docMetadataJson);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          errors.document_metadata = "Expected a JSON object.";
        } else {
          document_metadata = parsed as Record<string, unknown>;
        }
      } catch (e) {
        errors.document_metadata = `Invalid JSON: ${(e as Error).message}`;
      }
    }

    setJsonErrors(errors);
    if (Object.keys(errors).length > 0) {
      // Force the advanced section open so the user can see/fix the
      // exact textarea that failed to parse.
      setAdvancedOpen(true);
      return null;
    }

    const payload: TemplatePatternTestRequest = { include_empty_fields: includeEmptyFields };
    if (Object.keys(manual_fact_values).length > 0) {
      payload.manual_fact_values = manual_fact_values;
    }
    if (Object.keys(manual_catalog_hints).length > 0) {
      payload.manual_catalog_hints = manual_catalog_hints;
    }
    if (runtime_options) payload.runtime_options = runtime_options;
    if (document_metadata) payload.document_metadata = document_metadata;
    return payload;
  }, [
    quickFacts,
    factsJson,
    vendorHint,
    propertyHint,
    glHint,
    hintsJson,
    runtimeOptionsJson,
    docMetadataJson,
    includeEmptyFields,
  ]);

  // ---- Run handler -----------------------------------------------
  const handleRun = useCallback(async () => {
    if (!templateId || isDraft || !selectedPatternId) return;
    const payload = buildPayload();
    if (payload === null) return;

    runAbortRef.current?.abort();
    const controller = new AbortController();
    runAbortRef.current = controller;
    const myRequestId = ++runRequestIdRef.current;

    setRunning(true);
    setRunError(null);
    try {
      const next = await invoiceTemplatesApi.testWithPattern(
        templateId,
        selectedPatternId,
        payload,
        { signal: controller.signal },
      );
      if (myRequestId !== runRequestIdRef.current) return;
      setResult(next);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (myRequestId !== runRequestIdRef.current) return;
      setRunError(getApiErrorMessage(err, "Could not run the pattern test."));
    } finally {
      if (myRequestId === runRequestIdRef.current) {
        setRunning(false);
      }
    }
  }, [templateId, isDraft, selectedPatternId, buildPayload]);

  // ---- Save then test --------------------------------------------
  // Mirrors the Phase 1E pattern in the dry-run panel: await save,
  // then fire the test against the just-saved template. Save errors
  // short-circuit the run.
  const handleSaveThenTest = useCallback(async () => {
    if (!onSaveTemplate || isDraft) return;
    if (saveThenTestBusy || saving) return;
    if (!selectedPatternId) return;
    setSaveError(null);
    setSaveThenTestBusy(true);
    try {
      const maybe = onSaveTemplate();
      if (maybe && typeof (maybe as Promise<void>).then === "function") {
        await maybe;
      }
      // Save succeeded — fire the test. handleRun has its own loading
      // lock and request-id guard.
      await handleRun();
    } catch (err) {
      setSaveError(
        getApiErrorMessage(err, "Could not save the template before test."),
      );
    } finally {
      setSaveThenTestBusy(false);
    }
  }, [
    onSaveTemplate,
    isDraft,
    saveThenTestBusy,
    saving,
    selectedPatternId,
    handleRun,
  ]);

  // ---- Derived ---------------------------------------------------
  const selectedPattern = useMemo(
    () => patterns.find((p) => p.id === selectedPatternId) ?? null,
    [patterns, selectedPatternId],
  );

  const canRun =
    !!templateId &&
    !isDraft &&
    !!selectedPatternId &&
    !running &&
    !saveThenTestBusy;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={
        templateName
          ? `Test with pattern · ${templateName}`
          : "Test with pattern"
      }
      size="xl"
    >
      <div className="space-y-4 max-h-[72vh] overflow-y-auto pr-1">
        {/* ---- Scope copy --------------------------------------- */}
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
          <p>
            <span className="font-semibold">Diagnostic test</span> —
            runs the SAVED import template against a selected SAVED
            invoice pattern. Manual values simulate extracted invoice
            facts until OCR/AI is wired.
          </p>
          <p className="mt-1 text-blue-800 dark:text-blue-200">
            Never mutates anything. Never exports. Never enqueues
            review work.
          </p>
        </div>

        {/* ---- Draft / dirty banners ---------------------------- */}
        {isDraft && (
          <InlineAlert
            tone="warning"
            action={
              onSaveTemplate && canSave ? (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    void Promise.resolve(onSaveTemplate()).catch(() => {
                      // mutationError on the editor toolbar surfaces
                      // the error; nothing to do here. Save then test
                      // can't proceed without a templateId.
                    });
                  }}
                  disabled={saving}
                  loading={saving}
                >
                  Save template
                </Button>
              ) : undefined
            }
          >
            Save this template before testing it with a pattern. The
            test runner reads the persisted version on the server.
          </InlineAlert>
        )}
        {!isDraft && hasUnsavedChanges && (
          <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-3 dark:border-yellow-900 dark:bg-yellow-950/30">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-yellow-700 dark:text-yellow-300" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-yellow-900 dark:text-yellow-100">
                  Unsaved changes are not included in this test
                </p>
                <p className="mt-0.5 text-xs text-yellow-800 dark:text-yellow-200">
                  The pattern test reads the LAST SAVED template from
                  the server. To test your local edits, save first.
                </p>
                {onSaveTemplate && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={handleSaveThenTest}
                      disabled={
                        !canSave ||
                        !selectedPatternId ||
                        running ||
                        saveThenTestBusy ||
                        saving
                      }
                      loading={saveThenTestBusy || saving}
                    >
                      Save then test
                    </Button>
                    <span className="text-[11px] text-yellow-700 dark:text-yellow-300">
                      Saves the template, then runs the pattern test.
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

        {/* ---- Pattern selector --------------------------------- */}
        <PatternSelectorSection
          patterns={patterns}
          loading={loadingPatterns}
          error={patternsError}
          selectedPatternId={selectedPatternId}
          onSelect={setSelectedPatternId}
        />

        {/* ---- Manual facts (quick + advanced JSON) ------------- */}
        {selectedPatternId && (
          <>
            <ManualFactsSection
              quickFacts={quickFacts}
              onChange={(key, value) =>
                setQuickFacts((curr) => ({ ...curr, [key]: value }))
              }
            />

            <ManualHintsSection
              vendor={vendorHint}
              property={propertyHint}
              gl={glHint}
              onChangeVendor={setVendorHint}
              onChangeProperty={setPropertyHint}
              onChangeGl={setGlHint}
            />

            <div className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-line dark:bg-surface-subtle">
              <Switch
                checked={includeEmptyFields}
                onChange={setIncludeEmptyFields}
                size="sm"
                label="Show known pattern fields without test values"
                description="Adds an advisory list of pattern field keys that have no manual value. Never invents fake extracted facts."
              />
            </div>

            <AdvancedJsonSection
              open={advancedOpen}
              onToggle={() => setAdvancedOpen((v) => !v)}
              factsJson={factsJson}
              hintsJson={hintsJson}
              runtimeOptionsJson={runtimeOptionsJson}
              docMetadataJson={docMetadataJson}
              jsonErrors={jsonErrors}
              onChangeFacts={setFactsJson}
              onChangeHints={setHintsJson}
              onChangeRuntimeOptions={setRuntimeOptionsJson}
              onChangeDocMetadata={setDocMetadataJson}
            />

            {/* ---- Run controls --------------------------------- */}
            <div className="flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5 dark:border-line dark:bg-surface-muted">
              <p className="text-xs text-gray-600 dark:text-ink-muted">
                {selectedPattern
                  ? `Run against “${selectedPattern.name}”${selectedPattern.vendor_hint ? ` · ${selectedPattern.vendor_hint}` : ""}`
                  : "Pick a pattern above to enable Run."}
              </p>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={!canRun}
                loading={running}
                onClick={handleRun}
                title={
                  !templateId
                    ? "Save the template first."
                    : isDraft
                      ? "Drafts can't be tested. Save first."
                      : !selectedPatternId
                        ? "Select an invoice pattern."
                        : hasUnsavedChanges
                          ? "Heads up: this uses the last SAVED template. Use Save then test above to include local edits."
                          : "Run the diagnostic pattern test."
                }
              >
                <Play className="h-3.5 w-3.5" />
                {result ? "Run again" : "Run test"}
              </Button>
            </div>
          </>
        )}

        {/* ---- Loading / error / empty -------------------------- */}
        {running && (
          <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin text-brand-600 dark:text-brand-50" />
            Running pattern test…
          </div>
        )}

        {runError && !running && (
          <InlineAlert
            tone="error"
            action={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleRun}
                disabled={!canRun}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
            }
          >
            {runError}
          </InlineAlert>
        )}

        {!running && !runError && !result && selectedPatternId && (
          <div className="rounded-md border border-dashed border-gray-300 bg-white px-4 py-6 text-center text-xs text-gray-500 dark:border-line dark:bg-surface-subtle dark:text-ink-muted">
            Click Run test to see how the resolver handles this
            template + pattern combination.
          </div>
        )}

        {/* ---- Result sections ---------------------------------- */}
        {result && !running && (
          <>
            {hasUnsavedChanges && !isDraft && (
              // Stale-result label — analogous to Phase 1E in the
              // dry-run panel.
              <div className="rounded-md border border-yellow-200 bg-yellow-50/60 px-2.5 py-1.5 text-[11px] text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/20 dark:text-yellow-200">
                These results reflect the LAST SAVED template. Local
                edits since the last save are not included — use
                “Save then test” above to refresh.
              </div>
            )}

            <SummaryCard result={result} />
            <BridgeInputCard result={result} />
            <ResolvedRowsCard rows={result.resolver_result.rows ?? []} />
            <IssuesCard issues={result.resolver_result.issues ?? []} />
            <NextActionsCard result={result} />
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Pattern selector
// ---------------------------------------------------------------------------

function PatternSelectorSection({
  patterns,
  loading,
  error,
  selectedPatternId,
  onSelect,
}: {
  patterns: InvoicePatternSummary[];
  loading: boolean;
  error: string | null;
  selectedPatternId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
      <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
          <FlaskConical className="h-4 w-4 text-brand-600 dark:text-brand-50" />
          Invoice pattern
        </div>
        <span className="text-xs text-gray-500 dark:text-ink-muted">
          {patterns.length} saved
        </span>
      </header>
      <div className="px-3 py-2">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-ink-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-600 dark:text-brand-50" />
            Loading invoice patterns…
          </div>
        )}
        {error && !loading && (
          <InlineAlert tone="error">{error}</InlineAlert>
        )}
        {!loading && !error && patterns.length === 0 && (
          <p className="text-xs text-gray-500 dark:text-ink-muted">
            No invoice patterns found. Create an Invoice Pattern in
            Invoice Builder first.
          </p>
        )}
        {!loading && !error && patterns.length > 0 && (
          <div className="space-y-2">
            <select
              value={selectedPatternId ?? ""}
              onChange={(e) => onSelect(e.target.value || null)}
              className={cn(
                "w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-800 outline-none",
                "focus:ring-2 focus:ring-brand-500",
                "dark:bg-surface dark:text-ink dark:border-line",
              )}
            >
              <option value="">— Select a pattern —</option>
              {patterns.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.vendor_hint ? ` · ${p.vendor_hint}` : ""}
                  {` · ${p.region_count} region${p.region_count === 1 ? "" : "s"}`}
                </option>
              ))}
            </select>
            {selectedPatternId &&
              (() => {
                const sel = patterns.find((p) => p.id === selectedPatternId);
                if (!sel) return null;
                return (
                  <div className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-[11px] text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-900 dark:text-ink">
                        {sel.name}
                      </span>
                      {sel.vendor_hint && (
                        <Badge color="cyan">vendor: {sel.vendor_hint}</Badge>
                      )}
                      <span>
                        {sel.source_file_count} file
                        {sel.source_file_count === 1 ? "" : "s"}
                      </span>
                      <span>·</span>
                      <span>
                        {sel.region_count} region
                        {sel.region_count === 1 ? "" : "s"}
                      </span>
                    </div>
                    {sel.description && (
                      <p className="mt-1">{sel.description}</p>
                    )}
                  </div>
                );
              })()}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Manual facts (quick fields)
// ---------------------------------------------------------------------------

function ManualFactsSection({
  quickFacts,
  onChange,
}: {
  quickFacts: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
      <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
        <div className="text-sm font-semibold text-gray-800 dark:text-ink">
          Manual extracted facts
        </div>
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          Simulates OCR / AI extraction
        </span>
      </header>
      <div className="px-3 py-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {QUICK_FACT_FIELDS.map((field) => (
          <label
            key={field.key}
            className={cn("flex flex-col gap-0.5", field.wide && "sm:col-span-2")}
          >
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-ink-muted">
              {field.label}
              <span className="ml-1 font-mono text-[10px] font-normal lowercase text-gray-400 dark:text-ink-subtle">
                {field.key}
              </span>
            </span>
            <input
              type="text"
              value={quickFacts[field.key] ?? ""}
              onChange={(e) => onChange(field.key, e.target.value)}
              placeholder={field.placeholder}
              className={cn(
                "rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 outline-none",
                "focus:ring-2 focus:ring-brand-500",
                "dark:bg-surface dark:text-ink dark:border-line",
              )}
            />
          </label>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Manual catalog hints (vendor / property / gl)
// ---------------------------------------------------------------------------

function ManualHintsSection({
  vendor,
  property,
  gl,
  onChangeVendor,
  onChangeProperty,
  onChangeGl,
}: {
  vendor: string;
  property: string;
  gl: string;
  onChangeVendor: (v: string) => void;
  onChangeProperty: (v: string) => void;
  onChangeGl: (v: string) => void;
}) {
  return (
    <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
      <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
        <div className="text-sm font-semibold text-gray-800 dark:text-ink">
          Manual catalog hints
        </div>
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          Override or seed catalog matches
        </span>
      </header>
      <div className="px-3 py-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <HintField label="Vendor" value={vendor} onChange={onChangeVendor} placeholder="EPB" />
        <HintField label="Property" value={property} onChange={onChangeProperty} placeholder="ADM" />
        <HintField label="GL" value={gl} onChange={onChangeGl} placeholder="6915" />
      </div>
    </section>
  );
}

function HintField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-ink-muted">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 outline-none",
          "focus:ring-2 focus:ring-brand-500",
          "dark:bg-surface dark:text-ink dark:border-line",
        )}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Advanced JSON editor
// ---------------------------------------------------------------------------

function AdvancedJsonSection({
  open,
  onToggle,
  factsJson,
  hintsJson,
  runtimeOptionsJson,
  docMetadataJson,
  jsonErrors,
  onChangeFacts,
  onChangeHints,
  onChangeRuntimeOptions,
  onChangeDocMetadata,
}: {
  open: boolean;
  onToggle: () => void;
  factsJson: string;
  hintsJson: string;
  runtimeOptionsJson: string;
  docMetadataJson: string;
  jsonErrors: {
    facts?: string;
    hints?: string;
    runtime_options?: string;
    document_metadata?: string;
  };
  onChangeFacts: (v: string) => void;
  onChangeHints: (v: string) => void;
  onChangeRuntimeOptions: (v: string) => void;
  onChangeDocMetadata: (v: string) => void;
}) {
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
          Advanced (JSON overrides)
        </span>
        <span className="text-[10px] font-normal text-gray-500 dark:text-ink-muted">
          Optional · facts / hints / runtime_options / document_metadata
        </span>
      </button>
      {open && (
        <div className="border-t border-gray-100 px-3 py-3 space-y-3 dark:border-line/60">
          <JsonField
            label="manual_fact_values (JSON object — merges on top of quick fields)"
            placeholder={'{ "invoice_number": "ABC", "amount": "99.50" }'}
            value={factsJson}
            onChange={onChangeFacts}
            error={jsonErrors.facts}
          />
          <JsonField
            label="manual_catalog_hints (JSON object — merges on top of quick hints)"
            placeholder={
              '{ "vendor": "EPB", "property": { "text": "ADM" } }'
            }
            value={hintsJson}
            onChange={onChangeHints}
            error={jsonErrors.hints}
          />
          <JsonField
            label="runtime_options (JSON object)"
            placeholder={'{ "scenario_label": "edge_case_1" }'}
            value={runtimeOptionsJson}
            onChange={onChangeRuntimeOptions}
            error={jsonErrors.runtime_options}
          />
          <JsonField
            label="document_metadata (JSON object — caller cannot spoof bridge / runner keys)"
            placeholder={'{ "test_run_label": "Q3 review" }'}
            value={docMetadataJson}
            onChange={onChangeDocMetadata}
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
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-ink-muted">
        {label}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
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
// Result — Summary card
// ---------------------------------------------------------------------------

function SummaryCard({ result }: { result: TemplatePatternTestResult }) {
  const meta =
    RESOLVER_STATUS_META[result.summary.status] ??
    RESOLVER_STATUS_META.needs_review;
  const Icon = meta.Icon;
  const cards = [
    { label: "Rows", value: result.summary.rows },
    { label: "Ready", value: result.summary.ready },
    { label: "Needs review", value: result.summary.needs_review },
    { label: "Blocked", value: result.summary.blocked },
    { label: "Conflict", value: result.summary.conflict },
    { label: "Errors", value: result.summary.errors },
    { label: "Warnings", value: result.summary.warnings },
    { label: "Info", value: result.summary.info },
    { label: "Facts", value: result.summary.extracted_fact_count },
    { label: "Hints", value: result.summary.catalog_hint_count },
  ];

  return (
    <section
      className={cn(
        "rounded-md border px-3 py-3 space-y-2",
        meta.banner,
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn("h-5 w-5 shrink-0", meta.iconClass)} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 dark:text-ink">
            {meta.label}
          </div>
          <div className="text-xs text-gray-700 truncate dark:text-ink-muted">
            {result.template_name ?? "Untitled template"}
            {result.pattern_name ? ` × ${result.pattern_name}` : ""}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {cards.map((card) => (
          <div
            key={card.label}
            className="rounded-md border border-gray-200 bg-white/70 px-2 py-1 dark:border-line dark:bg-surface-subtle/70"
          >
            <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
              {card.label}
            </p>
            <p className="text-base font-semibold text-gray-800 dark:text-ink">
              {card.value}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Result — Bridge input preview
// ---------------------------------------------------------------------------

function BridgeInputCard({ result }: { result: TemplatePatternTestResult }) {
  const [open, setOpen] = useState(false);
  const facts = result.bridge_input.extracted_facts ?? [];
  const hints = result.bridge_input.catalog_hints ?? {};
  const metadata = result.bridge_input.document_metadata ?? {};

  return (
    <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
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
          Bridge input (what the resolver received)
        </div>
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          {facts.length} fact{facts.length === 1 ? "" : "s"} ·{" "}
          {Object.keys(hints).length} hint
          {Object.keys(hints).length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="px-3 py-2 space-y-3">
          <FactsList facts={facts} />
          <HintsList hints={hints} />
          <DocumentMetadataList metadata={metadata} />
        </div>
      )}
    </section>
  );
}

function FactsList({ facts }: { facts: ExtractedFact[] }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
        Extracted facts
      </p>
      {facts.length === 0 ? (
        <p className="mt-1 text-[11px] text-gray-500 dark:text-ink-muted">
          No facts — pattern test ran with zero extracted values.
        </p>
      ) : (
        <table className="mt-1 w-full text-xs">
          <thead className="bg-gray-50 dark:bg-surface-muted">
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
              <th className="px-2 py-1">Field key</th>
              <th className="px-2 py-1">Normalized</th>
              <th className="px-2 py-1">Value</th>
              <th className="px-2 py-1">Source</th>
              <th className="px-2 py-1">Conf.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-line/60">
            {facts.map((f, idx) => (
              <tr key={`${f.field_key}-${idx}`}>
                <td className="px-2 py-1 font-mono text-[11px] text-gray-800 dark:text-ink">
                  {f.field_key}
                </td>
                <td className="px-2 py-1 font-mono text-[11px] text-gray-500 dark:text-ink-muted">
                  {f.normalized_field_key ?? "—"}
                </td>
                <td className="px-2 py-1 text-gray-800 dark:text-ink">
                  {formatValue(f.value)}
                </td>
                <td className="px-2 py-1">
                  <Badge color="gray">{f.source_type ?? "—"}</Badge>
                </td>
                <td className="px-2 py-1 text-gray-500 dark:text-ink-muted">
                  {f.confidence != null
                    ? `${(f.confidence * 100).toFixed(0)}%`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function HintsList({
  hints,
}: {
  hints: Record<string, { entry_id?: string | null; text?: string | null; field_values?: Record<string, unknown> }>;
}) {
  const entries = Object.entries(hints);
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
        Catalog hints
      </p>
      {entries.length === 0 ? (
        <p className="mt-1 text-[11px] text-gray-500 dark:text-ink-muted">
          No catalog hints provided.
        </p>
      ) : (
        <ul className="mt-1 space-y-0.5 text-[11px]">
          {entries.map(([kind, hint]) => (
            <li key={kind} className="font-mono">
              <span className="text-gray-500 dark:text-ink-muted">{kind}:</span>{" "}
              <span className="text-gray-800 dark:text-ink">
                {hint.text ?? hint.entry_id ?? "—"}
              </span>
              {hint.field_values && Object.keys(hint.field_values).length > 0 && (
                <span className="ml-2 text-gray-500 dark:text-ink-muted">
                  ({Object.keys(hint.field_values).length} field
                  {Object.keys(hint.field_values).length === 1 ? "" : "s"})
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocumentMetadataList({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) {
  // Surface the most useful keys explicitly. Other keys land in the
  // raw JSON dump below for power users.
  const KEY_ORDER = [
    "test_runner_source",
    "test_runner_version",
    "bridge_source",
    "bridge_version",
    "invoice_pattern_id",
    "invoice_pattern_name",
    "vendor_hint",
    "source_file_count",
    "source_file_names",
    "known_pattern_fields",
    "unfilled_pattern_fields",
    "diagnostic_only",
  ];
  const seen = new Set(KEY_ORDER);
  const ordered: Array<[string, unknown]> = [];
  for (const k of KEY_ORDER) {
    if (k in metadata) ordered.push([k, metadata[k]]);
  }
  for (const k of Object.keys(metadata)) {
    if (!seen.has(k)) ordered.push([k, metadata[k]]);
  }

  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
        Document metadata
      </p>
      {ordered.length === 0 ? (
        <p className="mt-1 text-[11px] text-gray-500 dark:text-ink-muted">
          (empty)
        </p>
      ) : (
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
          {ordered.map(([key, value]) => (
            <div key={key} className="flex gap-1.5">
              <dt className="font-mono text-gray-500 dark:text-ink-muted">
                {key}
              </dt>
              <dd className="text-gray-800 dark:text-ink truncate">
                {formatValue(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result — Resolved rows / cells
// ---------------------------------------------------------------------------

function ResolvedRowsCard({ rows }: { rows: ResolvedImportRow[] }) {
  const [open, setOpen] = useState(true);
  if (rows.length === 0) return null;

  return (
    <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
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
          Resolved rows
        </div>
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="divide-y divide-gray-100 dark:divide-line/60">
          {rows.map((row) => (
            <ResolvedRowBlock key={row.row_index} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function ResolvedRowBlock({ row }: { row: ResolvedImportRow }) {
  const meta =
    RESOLVER_STATUS_META[row.status as ResolverStatus | string] ??
    RESOLVER_STATUS_META.needs_review;
  const cells = row.cells ?? [];

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold text-gray-800 dark:text-ink">
          Row {row.row_index + 1}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
            meta.badge,
          )}
        >
          <meta.Icon className="h-3 w-3" />
          {meta.label}
        </span>
      </div>
      <div className="overflow-x-auto rounded border border-gray-200 dark:border-line">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 dark:bg-surface-muted">
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
              <th className="px-2 py-1">Column</th>
              <th className="px-2 py-1">Value</th>
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">Source</th>
              <th className="px-2 py-1">Issues</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-line/60">
            {cells.map((cell) => (
              <CellRow key={cell.column_id} cell={cell} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CellRow({ cell }: { cell: ResolvedImportCell }) {
  const issueCount =
    (cell.warnings?.length ?? 0) + (cell.issue_codes?.length ?? 0);
  const valueDisplay = formatCellValue(cell);
  return (
    <tr>
      <td className="px-2 py-1 align-top font-medium text-gray-800 dark:text-ink">
        {cell.column_label || cell.column_id}
      </td>
      <td className="px-2 py-1 align-top text-gray-700 dark:text-ink">
        {valueDisplay === null ? (
          <span className="text-gray-300 dark:text-ink-subtle">—</span>
        ) : (
          <span className="break-all">{valueDisplay}</span>
        )}
      </td>
      <td className="px-2 py-1 align-top">
        <Badge color="gray">{cell.status}</Badge>
      </td>
      <td className="px-2 py-1 align-top">
        <Badge color="gray">{cell.source_type}</Badge>
      </td>
      <td className="px-2 py-1 align-top text-gray-500 dark:text-ink-muted">
        {issueCount}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Result — Issues
// ---------------------------------------------------------------------------

function IssuesCard({ issues }: { issues: ResolverIssue[] }) {
  if (issues.length === 0) return null;
  const groups: Record<ResolverSeverity, ResolverIssue[]> = {
    error: [],
    warning: [],
    info: [],
  };
  for (const issue of issues) {
    if (issue.severity === "error") groups.error.push(issue);
    else if (issue.severity === "warning") groups.warning.push(issue);
    else if (issue.severity === "info") groups.info.push(issue);
  }
  return (
    <section className="space-y-2">
      {(["error", "warning", "info"] as ResolverSeverity[]).map((severity) => {
        const items = groups[severity];
        if (items.length === 0) return null;
        const meta = SEVERITY_META[severity];
        return (
          <div
            key={severity}
            className={cn(
              "rounded-md border bg-white dark:bg-surface-subtle",
              meta.tone,
            )}
          >
            <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
              <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
                <meta.Icon className="h-4 w-4" />
                {meta.label}
              </div>
              <span className="text-xs font-semibold text-gray-500 dark:text-ink-muted">
                {items.length}
              </span>
            </header>
            <ul className="divide-y divide-gray-100 dark:divide-line/60">
              {items.map((issue, idx) => (
                <li
                  key={`${issue.code}-${idx}`}
                  className="px-3 py-2 text-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 dark:text-ink">
                        {issue.message}
                      </p>
                      {issue.recommendation && (
                        <p className="mt-0.5 text-gray-700 dark:text-ink-muted">
                          {issue.recommendation}
                        </p>
                      )}
                      {issue.column_label && (
                        <p className="mt-0.5 text-[11px] text-gray-500 dark:text-ink-muted">
                          column: {issue.column_label}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gray-500 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                      {issue.code}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Result — Next actions / missing facts
// ---------------------------------------------------------------------------

function NextActionsCard({ result }: { result: TemplatePatternTestResult }) {
  const issues = result.resolver_result.issues ?? [];
  const rows = result.resolver_result.rows ?? [];

  const missingFacts: Array<{ column: string; field?: string }> = [];
  const missingHints: string[] = [];
  const blockedRequiredColumns: string[] = [];

  for (const issue of issues) {
    if (issue.code === "INVOICE_FIELD_FACT_NOT_FOUND") {
      missingFacts.push({
        column: issue.column_label ?? issue.column_id ?? "(unknown)",
        field: issue.field_key ?? undefined,
      });
    } else if (
      issue.code === "CATALOG_HINT_MISSING" ||
      issue.code === "CATALOG_NOT_FOUND"
    ) {
      const label = issue.column_label ?? issue.column_id ?? "(unknown)";
      missingHints.push(label);
    } else if (issue.code === "REQUIRED_RUNTIME_VALUE_MISSING") {
      const label = issue.column_label ?? issue.column_id ?? "(unknown)";
      blockedRequiredColumns.push(label);
    }
  }

  // Walk per-cell issue codes too — some resolver versions surface
  // these on cells rather than top-level issues.
  for (const row of rows) {
    for (const cell of row.cells ?? []) {
      const codes = cell.issue_codes ?? [];
      if (codes.includes("INVOICE_FIELD_FACT_NOT_FOUND")) {
        missingFacts.push({
          column: cell.column_label ?? cell.column_id,
        });
      }
      if (codes.includes("REQUIRED_RUNTIME_VALUE_MISSING")) {
        blockedRequiredColumns.push(cell.column_label ?? cell.column_id);
      }
    }
  }

  // Bridge-side: pattern declares fields the operator didn't fill.
  const unfilled =
    (result.bridge_input.document_metadata?.unfilled_pattern_fields as
      | string[]
      | undefined) ?? [];

  const hasAny =
    missingFacts.length > 0 ||
    missingHints.length > 0 ||
    blockedRequiredColumns.length > 0 ||
    unfilled.length > 0;

  if (!hasAny) {
    return (
      <section className="rounded-md border border-green-200 bg-green-50/60 px-3 py-2 text-xs text-green-800 dark:border-green-900 dark:bg-green-950/20 dark:text-green-200">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          <span className="font-semibold">Nothing missing.</span>
          <span>
            Every required column resolved. You can use this combination
            confidently in real extraction.
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-md border border-blue-200 bg-blue-50/60 px-3 py-3 dark:border-blue-900 dark:bg-blue-950/20">
      <div className="flex items-center gap-2 text-sm font-semibold text-blue-900 dark:text-blue-100">
        <Info className="h-4 w-4" />
        Missing facts &amp; next actions
      </div>
      <div className="mt-2 space-y-2 text-xs text-blue-900 dark:text-blue-100">
        {blockedRequiredColumns.length > 0 && (
          <div>
            <p className="font-semibold">Blocked required columns</p>
            <ul className="list-disc pl-5 text-blue-800 dark:text-blue-200">
              {dedupe(blockedRequiredColumns).map((c) => (
                <li key={`b-${c}`}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        {missingFacts.length > 0 && (
          <div>
            <p className="font-semibold">Missing extracted facts</p>
            <ul className="list-disc pl-5 text-blue-800 dark:text-blue-200">
              {dedupeFacts(missingFacts).map((f, idx) => (
                <li key={`f-${idx}`}>
                  {f.column}
                  {f.field ? (
                    <span className="ml-1 font-mono text-[10px] text-blue-700 dark:text-blue-300">
                      ({f.field})
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-blue-700 dark:text-blue-300">
              Add these as manual values above to simulate runtime
              extraction.
            </p>
          </div>
        )}
        {missingHints.length > 0 && (
          <div>
            <p className="font-semibold">Missing catalog hints</p>
            <ul className="list-disc pl-5 text-blue-800 dark:text-blue-200">
              {dedupe(missingHints).map((c) => (
                <li key={`h-${c}`}>{c}</li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-blue-700 dark:text-blue-300">
              Add a Vendor / Property / GL hint above to seed the
              catalog match.
            </p>
          </div>
        )}
        {unfilled.length > 0 && (
          <div>
            <p className="font-semibold">
              Pattern fields without test values
            </p>
            <p className="text-[11px] text-blue-800 dark:text-blue-200">
              This pattern knows about these fields but no test values
              were provided. Add them above (or enable the “show known
              pattern fields” switch to see this list every time):
            </p>
            <ul className="list-disc pl-5 text-blue-800 dark:text-blue-200">
              {dedupe(unfilled).map((f) => (
                <li key={`u-${f}`} className="font-mono">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

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
  if (
    typeof candidate === "string" ||
    typeof candidate === "number" ||
    typeof candidate === "boolean"
  ) {
    return String(candidate);
  }
  try {
    return JSON.stringify(candidate);
  } catch {
    return String(candidate);
  }
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function dedupeFacts(
  items: Array<{ column: string; field?: string }>,
): Array<{ column: string; field?: string }> {
  const seen = new Set<string>();
  const out: Array<{ column: string; field?: string }> = [];
  for (const item of items) {
    const key = `${item.column}::${item.field ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
