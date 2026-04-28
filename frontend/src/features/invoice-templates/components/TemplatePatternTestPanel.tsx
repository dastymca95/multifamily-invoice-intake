"use client";

import {
  AlertTriangle,
  Bookmark,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardCopy,
  Copy,
  Download,
  Eraser,
  FilePlus,
  FileText,
  FlaskConical,
  Info,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  Table,
  Trash2,
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

import {
  MAX_SCENARIO_NAME_LENGTH,
  MAX_SCENARIOS_PER_PAIR,
  _normalizeName,
  buildStarterScenarios,
  createScenarioFromPayload,
  deleteScenarioById,
  duplicateScenario,
  loadScenarios,
  mergeStarterScenarios,
  payloadEqualsScenario,
  saveScenarios,
  scenarioFormState,
  stampLastRun,
  updateScenarioFromPayload,
  type PatternTestScenario,
} from "../lib/pattern-test-scenarios";
import {
  FIX_AREA_LABEL,
  derivePatternTestDiagnostics,
  deriveMultiScenarioDiagnostics,
  type DiagnosticFixArea,
  type DiagnosticSeverity,
  type MultiScenarioDiagnosticSummary,
  type PatternTestDiagnostic,
  type PatternTestDiagnosticSummary,
} from "../lib/pattern-test-diagnostics";
import {
  buildMultiScenarioCsvReport,
  buildMultiScenarioMarkdownReport,
  buildReportFilename,
  buildSinglePatternTestMarkdownReport,
  copyTextToClipboard,
  downloadTextFile,
} from "../lib/pattern-test-reports";

/**
 * Phase 2E — per-scenario state row in the multi-scenario QA matrix.
 *
 * Drives the comparison table and the inline details drawer. Each
 * row starts as ``queued``, transitions to ``running`` while its
 * Phase 2B request is in flight, then settles to one of
 * ``success`` / ``failed`` / ``cancelled``. The full
 * ``TemplatePatternTestResult`` is held in memory only — we do NOT
 * persist results to localStorage to avoid blowing the storage cap
 * on large templates.
 */
type ScenarioRunStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

interface ScenarioRunState {
  scenarioId: string;
  scenarioName: string;
  status: ScenarioRunStatus;
  result?: TemplatePatternTestResult;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

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

  // ---- Phase 2D — scenario presets -------------------------------
  // Scenarios are local-only (localStorage), keyed by the
  // (templateId, patternId) pair. The panel re-loads them whenever
  // either id changes. Storage errors land in scenarioStorageError
  // and surface as a non-blocking warning — scenario management
  // continues to work in-memory even if the browser refuses writes.
  const [scenarios, setScenarios] = useState<PatternTestScenario[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(
    null,
  );
  const [scenarioStorageError, setScenarioStorageError] = useState<
    string | null
  >(null);
  // One-time toast after a Load — clears on the next form change.
  const [scenarioLoadedNote, setScenarioLoadedNote] = useState<string | null>(
    null,
  );

  // ---- Phase 2E — multi-scenario QA ------------------------------
  // Sequential batch runner. Each selected scenario is fired through
  // the same ``invoiceTemplatesApi.testWithPattern`` endpoint as the
  // single-scenario flow; results are accumulated into a per-row
  // state list ``multiRuns`` that drives the comparison matrix.
  // Continues on per-scenario failure so one bad scenario doesn't
  // block the rest of the batch.
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [multiRuns, setMultiRuns] = useState<ScenarioRunState[]>([]);
  const [multiRunning, setMultiRunning] = useState(false);
  const [multiSaveThenRunBusy, setMultiSaveThenRunBusy] = useState(false);
  const [multiSaveError, setMultiSaveError] = useState<string | null>(null);
  const [multiExpandedId, setMultiExpandedId] = useState<string | null>(null);
  // Cancellation: fold the AbortController for HTTP-level abort with
  // a synchronous cancel flag the loop checks between iterations.
  // Keeps "user clicked Cancel after request settled" handled too.
  const multiAbortRef = useRef<AbortController | null>(null);
  const multiCancelledRef = useRef(false);

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

  // ---- Phase 2D — load scenarios from localStorage when the
  // (templateId, patternId) pair changes (or panel opens). Drafts /
  // missing patterns yield an empty list since the storage key
  // requires both ids.
  useEffect(() => {
    if (!isOpen) return;
    if (!templateId || !selectedPatternId) {
      setScenarios([]);
      setSelectedScenarioId(null);
      setScenarioStorageError(null);
      return;
    }
    setScenarioStorageError(null);
    const loaded = loadScenarios(templateId, selectedPatternId, (msg) => {
      setScenarioStorageError(msg);
    });
    setScenarios(loaded);
    // Selected scenario carries forward only if it's still present
    // for the current pair; otherwise reset.
    setSelectedScenarioId((curr) =>
      curr && loaded.some((s) => s.id === curr) ? curr : null,
    );
  }, [isOpen, templateId, selectedPatternId]);

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
      // Phase 2D — stamp last-run metadata on the selected scenario.
      // Persisted to localStorage so the operator sees the freshness
      // indicator next time they open the panel. We only stamp when
      // a scenario is actually selected; ad-hoc runs don't auto-create
      // a scenario (the spec is explicit about not silently saving).
      if (selectedScenarioId && templateId && selectedPatternId) {
        const status = next.summary?.status ?? "unknown";
        setScenarios((curr) => {
          const updated = curr.map((s) =>
            s.id === selectedScenarioId ? stampLastRun(s, status) : s,
          );
          const write = saveScenarios(
            templateId,
            selectedPatternId,
            updated,
          );
          if (!write.ok && write.error) {
            setScenarioStorageError(write.error);
          }
          return updated;
        });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (myRequestId !== runRequestIdRef.current) return;
      setRunError(getApiErrorMessage(err, "Could not run the pattern test."));
    } finally {
      if (myRequestId === runRequestIdRef.current) {
        setRunning(false);
      }
    }
  }, [
    templateId,
    isDraft,
    selectedPatternId,
    buildPayload,
    selectedScenarioId,
  ]);

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

  const selectedScenario = useMemo(
    () => scenarios.find((s) => s.id === selectedScenarioId) ?? null,
    [scenarios, selectedScenarioId],
  );

  // Phase 2D — scenario dirty detection. Compares the current
  // form's effective payload against the selected scenario's stored
  // payload via a stable canonical-JSON serialisation. Only meaningful
  // when a scenario is selected AND the current form parses cleanly
  // (parse errors gate Save anyway).
  const scenarioDirty = useMemo(() => {
    if (!selectedScenario) return false;
    try {
      const payload = _buildPayloadForCompare({
        quickFacts,
        vendorHint,
        propertyHint,
        glHint,
        factsJson,
        hintsJson,
        runtimeOptionsJson,
        docMetadataJson,
        includeEmptyFields,
      });
      if (!payload) return true; // current form has parse errors
      return !payloadEqualsScenario(selectedScenario, payload);
    } catch {
      return true;
    }
  }, [
    selectedScenario,
    quickFacts,
    vendorHint,
    propertyHint,
    glHint,
    factsJson,
    hintsJson,
    runtimeOptionsJson,
    docMetadataJson,
    includeEmptyFields,
  ]);

  // Clear the "Scenario loaded" toast on the next form change so it
  // doesn't linger after the operator starts editing.
  useEffect(() => {
    if (!scenarioLoadedNote) return;
    if (scenarioDirty) setScenarioLoadedNote(null);
  }, [scenarioLoadedNote, scenarioDirty]);

  const canRun =
    !!templateId &&
    !isDraft &&
    !!selectedPatternId &&
    !running &&
    !saveThenTestBusy;

  // ---- Scenario actions -----------------------------------------
  const persistScenarios = useCallback(
    (next: PatternTestScenario[]): boolean => {
      if (!templateId || !selectedPatternId) return false;
      const write = saveScenarios(templateId, selectedPatternId, next);
      if (!write.ok && write.error) {
        setScenarioStorageError(write.error);
        return false;
      }
      setScenarioStorageError(null);
      return true;
    },
    [templateId, selectedPatternId],
  );

  const hydrateFromScenario = useCallback((s: PatternTestScenario) => {
    const form = scenarioFormState(s);
    setQuickFacts(form.quickFacts);
    setVendorHint(form.vendorHint);
    setPropertyHint(form.propertyHint);
    setGlHint(form.glHint);
    setFactsJson(form.factsJson);
    setHintsJson(form.hintsJson);
    setRuntimeOptionsJson(form.runtimeOptionsJson);
    setDocMetadataJson(form.docMetadataJson);
    setIncludeEmptyFields(form.includeEmptyFields);
    setJsonErrors({});
    // Open the advanced section if the scenario carries non-quick
    // overflow — otherwise the operator sees an apparently empty
    // form even though the scenario has data.
    if (
      form.factsJson ||
      form.hintsJson ||
      form.runtimeOptionsJson ||
      form.docMetadataJson
    ) {
      setAdvancedOpen(true);
    }
    setScenarioLoadedNote(`Loaded scenario “${s.name}”. Click Run test to execute.`);
  }, []);

  const handleSelectScenario = useCallback(
    (id: string | null) => {
      setSelectedScenarioId(id);
      if (!id) return;
      const s = scenarios.find((sc) => sc.id === id);
      if (s) hydrateFromScenario(s);
    },
    [scenarios, hydrateFromScenario],
  );

  /** Save the current form payload onto the selected scenario, OR
   *  prompt for a name and create a new one if nothing is selected. */
  const handleSave = useCallback(() => {
    if (!templateId || !selectedPatternId) return;
    const payload = buildPayload();
    if (payload === null) return; // JSON errors block save
    if (selectedScenarioId) {
      const base = scenarios.find((s) => s.id === selectedScenarioId);
      if (!base) return;
      const updated = updateScenarioFromPayload(base, payload);
      const next = scenarios.map((s) =>
        s.id === selectedScenarioId ? updated : s,
      );
      setScenarios(next);
      persistScenarios(next);
      return;
    }
    // No selection — prompt for a new name.
    const raw = window.prompt("Name this scenario:", "");
    if (raw === null) return; // user cancelled
    const name = _normalizeName(raw);
    if (!name) return;
    if (scenarios.length >= MAX_SCENARIOS_PER_PAIR) {
      window.alert(
        `You already have ${MAX_SCENARIOS_PER_PAIR} scenarios for this template + pattern. Delete one before saving more.`,
      );
      return;
    }
    if (
      scenarios.some((s) => s.name.toLowerCase() === name.toLowerCase()) &&
      !window.confirm(
        `A scenario called “${name}” already exists for this template + pattern. Save anyway as a duplicate?`,
      )
    ) {
      return;
    }
    const created = createScenarioFromPayload({
      templateId,
      patternId: selectedPatternId,
      name,
      payload,
    });
    const next = [...scenarios, created];
    setScenarios(next);
    setSelectedScenarioId(created.id);
    persistScenarios(next);
  }, [
    templateId,
    selectedPatternId,
    selectedScenarioId,
    scenarios,
    buildPayload,
    persistScenarios,
  ]);

  const handleSaveAsNew = useCallback(() => {
    if (!templateId || !selectedPatternId) return;
    const payload = buildPayload();
    if (payload === null) return;
    const seed = selectedScenario ? `${selectedScenario.name} copy` : "";
    const raw = window.prompt("Save as new scenario name:", seed);
    if (raw === null) return;
    const name = _normalizeName(raw);
    if (!name) return;
    if (scenarios.length >= MAX_SCENARIOS_PER_PAIR) {
      window.alert(
        `You already have ${MAX_SCENARIOS_PER_PAIR} scenarios for this template + pattern. Delete one before saving more.`,
      );
      return;
    }
    if (
      scenarios.some((s) => s.name.toLowerCase() === name.toLowerCase()) &&
      !window.confirm(
        `A scenario called “${name}” already exists. Save anyway as a duplicate?`,
      )
    ) {
      return;
    }
    const created = createScenarioFromPayload({
      templateId,
      patternId: selectedPatternId,
      name,
      payload,
    });
    const next = [...scenarios, created];
    setScenarios(next);
    setSelectedScenarioId(created.id);
    persistScenarios(next);
  }, [
    templateId,
    selectedPatternId,
    selectedScenario,
    scenarios,
    buildPayload,
    persistScenarios,
  ]);

  const handleDuplicate = useCallback(() => {
    if (!selectedScenario) return;
    if (scenarios.length >= MAX_SCENARIOS_PER_PAIR) {
      window.alert(
        `You already have ${MAX_SCENARIOS_PER_PAIR} scenarios for this template + pattern. Delete one before duplicating.`,
      );
      return;
    }
    const dup = duplicateScenario(selectedScenario);
    const next = [...scenarios, dup];
    setScenarios(next);
    setSelectedScenarioId(dup.id);
    persistScenarios(next);
  }, [selectedScenario, scenarios, persistScenarios]);

  const handleDelete = useCallback(() => {
    if (!selectedScenario) return;
    if (
      !window.confirm(
        `Delete scenario “${selectedScenario.name}”? This cannot be undone.`,
      )
    ) {
      return;
    }
    const next = deleteScenarioById(scenarios, selectedScenario.id);
    setScenarios(next);
    setSelectedScenarioId(null);
    persistScenarios(next);
  }, [selectedScenario, scenarios, persistScenarios]);

  const handleClearForm = useCallback(() => {
    setQuickFacts({});
    setVendorHint("");
    setPropertyHint("");
    setGlHint("");
    setFactsJson("");
    setHintsJson("");
    setRuntimeOptionsJson("");
    setDocMetadataJson("");
    setIncludeEmptyFields(false);
    setJsonErrors({});
    setSelectedScenarioId(null);
    setScenarioLoadedNote(null);
  }, []);

  const handleAddStarters = useCallback(() => {
    if (!templateId || !selectedPatternId) return;
    const { merged, added } = mergeStarterScenarios(
      scenarios,
      templateId,
      selectedPatternId,
    );
    if (added === 0) {
      window.alert(
        "All starter scenarios already exist for this template + pattern.",
      );
      return;
    }
    setScenarios(merged);
    persistScenarios(merged);
    window.alert(
      `Added ${added} starter scenario${added === 1 ? "" : "s"}. Adjust values to match your bills before running.`,
    );
  }, [scenarios, templateId, selectedPatternId, persistScenarios]);

  // ---- Phase 2E — multi-scenario QA --------------------------------

  // Reset multi-scenario selection + result matrix when the pattern
  // changes (the previous results no longer make sense for the new
  // pattern, and saved scenarios are scoped per pair).
  useEffect(() => {
    setMultiSelectedIds(new Set());
    setMultiRuns([]);
    setMultiExpandedId(null);
    setMultiSaveError(null);
    multiAbortRef.current?.abort();
    multiCancelledRef.current = false;
  }, [selectedPatternId]);

  // Drop selection entries that point at deleted / unknown scenarios.
  // Cheap diff — runs whenever the saved scenario list changes.
  useEffect(() => {
    setMultiSelectedIds((curr) => {
      const ids = new Set(scenarios.map((s) => s.id));
      let changed = false;
      const next = new Set<string>();
      // ``Array.from(set)`` works regardless of TS lib target;
      // ``for...of set`` requires --downlevelIteration.
      Array.from(curr).forEach((id) => {
        if (ids.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : curr;
    });
  }, [scenarios]);

  // Abort an in-flight batch when the panel closes — prevents the
  // network request from settling onto an unmounted view.
  useEffect(() => {
    if (!isOpen) {
      multiAbortRef.current?.abort();
      multiCancelledRef.current = true;
    }
  }, [isOpen]);

  const handleToggleMultiSelect = useCallback((id: string) => {
    setMultiSelectedIds((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAllMulti = useCallback(() => {
    setMultiSelectedIds(new Set(scenarios.map((s) => s.id)));
  }, [scenarios]);

  const handleClearMultiSelection = useCallback(() => {
    setMultiSelectedIds(new Set());
  }, []);

  const stampScenarioStatus = useCallback(
    (scenarioId: string, status: string) => {
      if (!templateId || !selectedPatternId) return;
      setScenarios((curr) => {
        const next = curr.map((s) =>
          s.id === scenarioId ? stampLastRun(s, status) : s,
        );
        const write = saveScenarios(templateId, selectedPatternId, next);
        if (!write.ok && write.error) setScenarioStorageError(write.error);
        return next;
      });
    },
    [templateId, selectedPatternId],
  );

  /**
   * Run a list of scenarios sequentially through the existing
   * single-scenario endpoint. Continues on per-scenario failure so
   * one bad scenario doesn't block the rest of the batch.
   *
   * Cancellation: aborts the in-flight HTTP request AND sets a
   * synchronous flag the loop checks between iterations. The
   * remaining queued scenarios get marked ``cancelled`` and the
   * loop exits cleanly.
   *
   * Each scenario's last_run metadata is stamped after settle —
   * success → ``result.summary.status``, failure → ``"failed"``.
   * The cancelled state does NOT stamp (the operator hadn't
   * actually run those scenarios).
   */
  const handleRunMulti = useCallback(
    async (ids: string[]) => {
      if (!templateId || isDraft || !selectedPatternId) return;
      if (ids.length === 0) return;
      if (multiRunning) return;

      // Snapshot the scenario lookup at the start so per-iteration
      // payloads see a consistent view (stamping during the loop
      // doesn't affect what we send for subsequent scenarios).
      const idToScenario = new Map(scenarios.map((s) => [s.id, s]));
      // Drop any ids that no longer exist (defensive — should
      // already be filtered by the selection effect).
      const safeIds = ids.filter((id) => idToScenario.has(id));
      if (safeIds.length === 0) return;

      const initial: ScenarioRunState[] = safeIds.map((id) => {
        const s = idToScenario.get(id)!;
        return {
          scenarioId: id,
          scenarioName: s.name,
          status: "queued",
        };
      });
      setMultiRuns(initial);
      setMultiExpandedId(null);
      setMultiRunning(true);
      multiCancelledRef.current = false;
      multiAbortRef.current?.abort();
      multiAbortRef.current = new AbortController();
      const signal = multiAbortRef.current.signal;

      try {
        for (let i = 0; i < safeIds.length; i++) {
          if (multiCancelledRef.current) {
            // Mark the rest as cancelled in one swoop and exit.
            setMultiRuns((curr) =>
              curr.map((r, idx) =>
                idx >= i ? { ...r, status: "cancelled" } : r,
              ),
            );
            break;
          }
          const scenario = idToScenario.get(safeIds[i])!;
          const startedAt = new Date().toISOString();
          setMultiRuns((curr) =>
            curr.map((r, idx) =>
              idx === i ? { ...r, status: "running", startedAt } : r,
            ),
          );

          // Build payload from the scenario. Document_metadata gets
          // an extra layer to mark this as a multi-scenario run —
          // useful in trace / debugging downstream. Bridge / runner
          // protected keys can't be overridden anyway (Phase 2B
          // enforces that), so we just add identifying fields.
          const payload: TemplatePatternTestRequest = {
            include_empty_fields: scenario.include_empty_fields,
          };
          if (scenario.manual_fact_values) {
            payload.manual_fact_values = scenario.manual_fact_values;
          }
          if (scenario.manual_catalog_hints) {
            payload.manual_catalog_hints = scenario.manual_catalog_hints;
          }
          if (scenario.runtime_options) {
            payload.runtime_options = scenario.runtime_options;
          }
          payload.document_metadata = {
            ...(scenario.document_metadata ?? {}),
            scenario_id: scenario.id,
            scenario_name: scenario.name,
            multi_scenario_run: true,
          };

          try {
            const result = await invoiceTemplatesApi.testWithPattern(
              templateId,
              selectedPatternId,
              payload,
              { signal },
            );
            const finishedAt = new Date().toISOString();
            setMultiRuns((curr) =>
              curr.map((r, idx) =>
                idx === i
                  ? { ...r, status: "success", result, finishedAt }
                  : r,
              ),
            );
            stampScenarioStatus(
              scenario.id,
              result.summary?.status ?? "unknown",
            );
          } catch (err) {
            // Cancellation manifests as an aborted fetch — treat as
            // cancellation, not failure.
            if (signal.aborted || multiCancelledRef.current) {
              setMultiRuns((curr) =>
                curr.map((r, idx) =>
                  idx >= i ? { ...r, status: "cancelled" } : r,
                ),
              );
              break;
            }
            const message = getApiErrorMessage(
              err,
              `Pattern test failed for scenario “${scenario.name}”.`,
            );
            const finishedAt = new Date().toISOString();
            setMultiRuns((curr) =>
              curr.map((r, idx) =>
                idx === i
                  ? { ...r, status: "failed", error: message, finishedAt }
                  : r,
              ),
            );
            stampScenarioStatus(scenario.id, "failed");
            // Continue to the next scenario — per spec, one failure
            // does not block the rest of the batch.
          }
        }
      } finally {
        setMultiRunning(false);
      }
    },
    [
      templateId,
      isDraft,
      selectedPatternId,
      scenarios,
      multiRunning,
      stampScenarioStatus,
    ],
  );

  /**
   * Phase 2E — Save then run selected scenarios. Mirrors the
   * Phase 1E save-then-run flow used by Dry Run / Pattern Test.
   */
  const handleSaveThenRunMulti = useCallback(async () => {
    if (
      !onSaveTemplate ||
      isDraft ||
      multiSaveThenRunBusy ||
      saving ||
      multiRunning
    ) {
      return;
    }
    if (multiSelectedIds.size === 0) return;
    setMultiSaveError(null);
    setMultiSaveThenRunBusy(true);
    try {
      const maybe = onSaveTemplate();
      if (maybe && typeof (maybe as Promise<void>).then === "function") {
        await maybe;
      }
      await handleRunMulti(Array.from(multiSelectedIds));
    } catch (err) {
      setMultiSaveError(
        getApiErrorMessage(
          err,
          "Could not save the template before multi-scenario run.",
        ),
      );
    } finally {
      setMultiSaveThenRunBusy(false);
    }
  }, [
    onSaveTemplate,
    isDraft,
    multiSaveThenRunBusy,
    saving,
    multiRunning,
    multiSelectedIds,
    handleRunMulti,
  ]);

  const handleCancelMulti = useCallback(() => {
    multiCancelledRef.current = true;
    multiAbortRef.current?.abort();
  }, []);

  /** Load a multi-scenario row's scenario into the single-run form. */
  const handleLoadMultiIntoForm = useCallback(
    (scenarioId: string) => {
      const s = scenarios.find((sc) => sc.id === scenarioId);
      if (!s) return;
      // Reuse the single-run handler — populates form + selects in
      // the scenario dropdown. Doesn't auto-run.
      handleSelectScenario(scenarioId);
      // Collapse the details drawer so the operator's eye lands on
      // the form rather than the details panel.
      setMultiExpandedId(null);
    },
    [scenarios, handleSelectScenario],
  );

  // ---- Phase 2H — QA report copy / download ---------------------
  // Single transient toast surface for both single-run and
  // multi-scenario report actions. Auto-clears after a few seconds
  // so the operator doesn't have to dismiss it manually. Errors
  // (clipboard blocked, download blocked) surface in the same lane.
  const [reportStatus, setReportStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const reportStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const showReportStatus = useCallback(
    (type: "success" | "error", message: string) => {
      setReportStatus({ type, message });
      if (reportStatusTimerRef.current) {
        clearTimeout(reportStatusTimerRef.current);
      }
      reportStatusTimerRef.current = setTimeout(() => {
        setReportStatus(null);
        reportStatusTimerRef.current = null;
      }, 4000);
    },
    [],
  );

  // Make sure the timer is cleared when the panel closes — keeps
  // the toast from settling onto an unmounted view.
  useEffect(() => {
    if (!isOpen && reportStatusTimerRef.current) {
      clearTimeout(reportStatusTimerRef.current);
      reportStatusTimerRef.current = null;
      setReportStatus(null);
    }
  }, [isOpen]);

  const handleCopySingleReport = useCallback(async () => {
    if (!result) return;
    try {
      const text = buildSinglePatternTestMarkdownReport({
        result,
        templateName: templateName ?? null,
        patternName: selectedPattern?.name ?? null,
        scenarioName: selectedScenario?.name ?? null,
      });
      await copyTextToClipboard(text);
      showReportStatus("success", "Report copied.");
    } catch (err) {
      showReportStatus(
        "error",
        `Could not copy report: ${(err as Error).message}`,
      );
    }
  }, [
    result,
    templateName,
    selectedPattern,
    selectedScenario,
    showReportStatus,
  ]);

  const handleDownloadSingleReport = useCallback(() => {
    if (!result) return;
    try {
      const text = buildSinglePatternTestMarkdownReport({
        result,
        templateName: templateName ?? null,
        patternName: selectedPattern?.name ?? null,
        scenarioName: selectedScenario?.name ?? null,
      });
      const filename = buildReportFilename({
        kind: "pattern-test",
        templateName: templateName ?? null,
        patternName: selectedPattern?.name ?? null,
        extension: "md",
      });
      downloadTextFile(filename, text, "text/markdown;charset=utf-8");
      showReportStatus("success", "Report downloaded.");
    } catch (err) {
      showReportStatus(
        "error",
        `Could not download report: ${(err as Error).message}`,
      );
    }
  }, [
    result,
    templateName,
    selectedPattern,
    selectedScenario,
    showReportStatus,
  ]);

  // Multi-scenario "settled" check — needed both for enabling the
  // buttons and (later) for showing partial-data warnings.
  const multiHasSettledRun = useMemo(
    () =>
      multiRuns.some(
        (r) =>
          r.status === "success" ||
          r.status === "failed" ||
          r.status === "cancelled",
      ),
    [multiRuns],
  );

  const handleCopyMultiReport = useCallback(async () => {
    if (!multiHasSettledRun || multiRunning) return;
    try {
      const text = buildMultiScenarioMarkdownReport({
        runs: multiRuns,
        templateName: templateName ?? null,
        patternName: selectedPattern?.name ?? null,
      });
      await copyTextToClipboard(text);
      showReportStatus("success", "QA report copied.");
    } catch (err) {
      showReportStatus(
        "error",
        `Could not copy QA report: ${(err as Error).message}`,
      );
    }
  }, [
    multiRuns,
    multiHasSettledRun,
    multiRunning,
    templateName,
    selectedPattern,
    showReportStatus,
  ]);

  const handleDownloadMultiReport = useCallback(() => {
    if (!multiHasSettledRun || multiRunning) return;
    try {
      const text = buildMultiScenarioMarkdownReport({
        runs: multiRuns,
        templateName: templateName ?? null,
        patternName: selectedPattern?.name ?? null,
      });
      const filename = buildReportFilename({
        kind: "multi-scenario-qa",
        templateName: templateName ?? null,
        patternName: selectedPattern?.name ?? null,
        extension: "md",
      });
      downloadTextFile(filename, text, "text/markdown;charset=utf-8");
      showReportStatus("success", "QA report downloaded.");
    } catch (err) {
      showReportStatus(
        "error",
        `Could not download QA report: ${(err as Error).message}`,
      );
    }
  }, [
    multiRuns,
    multiHasSettledRun,
    multiRunning,
    templateName,
    selectedPattern,
    showReportStatus,
  ]);

  const handleCopyMultiCsv = useCallback(async () => {
    if (!multiHasSettledRun || multiRunning) return;
    try {
      const text = buildMultiScenarioCsvReport({
        runs: multiRuns,
        templateName: templateName ?? null,
        patternName: selectedPattern?.name ?? null,
      });
      await copyTextToClipboard(text);
      showReportStatus("success", "Matrix CSV copied.");
    } catch (err) {
      showReportStatus(
        "error",
        `Could not copy matrix CSV: ${(err as Error).message}`,
      );
    }
  }, [
    multiRuns,
    multiHasSettledRun,
    multiRunning,
    templateName,
    selectedPattern,
    showReportStatus,
  ]);

  const handleDownloadMultiCsv = useCallback(() => {
    if (!multiHasSettledRun || multiRunning) return;
    try {
      const text = buildMultiScenarioCsvReport({
        runs: multiRuns,
        templateName: templateName ?? null,
        patternName: selectedPattern?.name ?? null,
      });
      const filename = buildReportFilename({
        kind: "multi-scenario-qa",
        templateName: templateName ?? null,
        patternName: selectedPattern?.name ?? null,
        extension: "csv",
      });
      downloadTextFile(filename, text, "text/csv;charset=utf-8");
      showReportStatus("success", "Matrix CSV downloaded.");
    } catch (err) {
      showReportStatus(
        "error",
        `Could not download matrix CSV: ${(err as Error).message}`,
      );
    }
  }, [
    multiRuns,
    multiHasSettledRun,
    multiRunning,
    templateName,
    selectedPattern,
    showReportStatus,
  ]);

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

        {/* ---- Phase 2D — Scenarios ---------------------------- */}
        {selectedPatternId && (
          <ScenariosSection
            scenarios={scenarios}
            selectedScenarioId={selectedScenarioId}
            scenarioDirty={scenarioDirty}
            scenarioLoadedNote={scenarioLoadedNote}
            scenarioStorageError={scenarioStorageError}
            onSelect={handleSelectScenario}
            onSave={handleSave}
            onSaveAsNew={handleSaveAsNew}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
            onClearForm={handleClearForm}
            onAddStarters={handleAddStarters}
          />
        )}

        {/* ---- Phase 2E — Multi-scenario QA -------------------- */}
        {selectedPatternId && (
          <MultiScenarioQASection
            scenarios={scenarios}
            multiSelectedIds={multiSelectedIds}
            multiRuns={multiRuns}
            multiRunning={multiRunning}
            multiSaveThenRunBusy={multiSaveThenRunBusy}
            multiSaveError={multiSaveError}
            multiExpandedId={multiExpandedId}
            multiHasSettledRun={multiHasSettledRun}
            templateId={templateId}
            isDraft={isDraft}
            hasUnsavedChanges={hasUnsavedChanges}
            canSave={canSave}
            saving={saving}
            onSaveTemplate={onSaveTemplate}
            onToggleSelect={handleToggleMultiSelect}
            onSelectAll={handleSelectAllMulti}
            onClearSelection={handleClearMultiSelection}
            onRunSelected={() =>
              handleRunMulti(Array.from(multiSelectedIds))
            }
            onRunAll={() => handleRunMulti(scenarios.map((s) => s.id))}
            onSaveThenRunSelected={handleSaveThenRunMulti}
            onCancelRun={handleCancelMulti}
            onExpand={(id) =>
              setMultiExpandedId((curr) => (curr === id ? null : id))
            }
            onLoadIntoForm={handleLoadMultiIntoForm}
            onRunSingle={(id) => handleRunMulti([id])}
            // Phase 2H — report actions threaded through the
            // sub-component; status toast lives at the panel level
            // so it renders above the modal scroll area.
            reportStatus={reportStatus}
            onCopyMultiReport={handleCopyMultiReport}
            onDownloadMultiReport={handleDownloadMultiReport}
            onCopyMultiCsv={handleCopyMultiCsv}
            onDownloadMultiCsv={handleDownloadMultiCsv}
          />
        )}

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

            <SummaryCard
              result={result}
              scenarioName={selectedScenario?.name ?? null}
            />
            {/* Phase 2H — Single-run report actions. Diagnostic-only
                Markdown report; intentionally separate from the
                production export engine. */}
            <ReportActionRow
              kind="single"
              status={reportStatus}
              onCopy={handleCopySingleReport}
              onDownload={handleDownloadSingleReport}
            />
            {/* Phase 2G — Review-style diagnostics. Sits between
                the summary card and the raw bridge / resolver
                preview so the operator sees operational language
                first ("Rivera needs invoice_number to resolve…")
                and the technical detail second. */}
            <DiagnosticReviewCard result={result} />
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
// Phase 2D — Scenarios section
// ---------------------------------------------------------------------------

function ScenariosSection({
  scenarios,
  selectedScenarioId,
  scenarioDirty,
  scenarioLoadedNote,
  scenarioStorageError,
  onSelect,
  onSave,
  onSaveAsNew,
  onDuplicate,
  onDelete,
  onClearForm,
  onAddStarters,
}: {
  scenarios: PatternTestScenario[];
  selectedScenarioId: string | null;
  scenarioDirty: boolean;
  scenarioLoadedNote: string | null;
  scenarioStorageError: string | null;
  onSelect: (id: string | null) => void;
  onSave: () => void;
  onSaveAsNew: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClearForm: () => void;
  onAddStarters: () => void;
}) {
  const selected =
    scenarios.find((s) => s.id === selectedScenarioId) ?? null;
  const lastRunRel = selected
    ? _formatRelativeTime(selected.last_run_at)
    : "";
  // Sort scenarios for the dropdown — most recently updated first.
  const sorted = useMemo(
    () =>
      [...scenarios].sort((a, b) =>
        (b.updated_at || "").localeCompare(a.updated_at || ""),
      ),
    [scenarios],
  );

  return (
    <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
      <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
          <Bookmark className="h-4 w-4 text-brand-600 dark:text-brand-50" />
          Scenarios
        </div>
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          {scenarios.length} saved · stored in this browser only
        </span>
      </header>
      <div className="px-3 py-2 space-y-2">
        {/* Selector + dirty / last-run pill */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedScenarioId ?? ""}
            onChange={(e) => onSelect(e.target.value || null)}
            className={cn(
              "min-w-[12rem] rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 outline-none",
              "focus:ring-2 focus:ring-brand-500",
              "dark:bg-surface dark:text-ink dark:border-line",
            )}
          >
            <option value="">— No scenario selected —</option>
            {sorted.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.last_result_status ? ` · ${s.last_result_status}` : ""}
              </option>
            ))}
          </select>
          {selected && scenarioDirty && (
            <span
              className="inline-flex items-center rounded-full border border-yellow-300 bg-yellow-50 px-2 py-0.5 text-[10px] font-semibold text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-200"
              title="The current form differs from the saved scenario."
            >
              Unsaved scenario changes
            </span>
          )}
          {selected && lastRunRel && (
            <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
              Last run: {lastRunRel}
              {selected.last_result_status
                ? ` · ${selected.last_result_status}`
                : ""}
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onSave}
            title={
              selected
                ? "Save current form values onto this scenario"
                : "Save current form values as a new scenario"
            }
          >
            <Save className="h-3.5 w-3.5" />
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onSaveAsNew}
            title="Save current form values as a new scenario"
          >
            <FilePlus className="h-3.5 w-3.5" />
            Save as new
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDuplicate}
            disabled={!selected}
            title="Create a copy of the selected scenario"
          >
            <Copy className="h-3.5 w-3.5" />
            Duplicate
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={!selected}
            title="Delete the selected scenario"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
          <div className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClearForm}
            title="Clear the form and deselect any scenario (does not delete the saved scenario)"
          >
            <Eraser className="h-3.5 w-3.5" />
            Clear form
          </Button>
          {scenarios.length === 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onAddStarters}
              title="Add three sample scenarios — adjust values to match your bills before running"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Add starter scenarios
            </Button>
          )}
        </div>

        {/* Empty / loaded / storage error notes */}
        {scenarios.length === 0 && (
          <p className="text-[11px] text-gray-500 dark:text-ink-muted">
            No saved scenarios yet. Fill in test values and click Save
            — or click Add starter scenarios for a few placeholders.
          </p>
        )}
        {scenarioLoadedNote && (
          <p className="text-[11px] text-blue-700 dark:text-blue-300">
            <Info className="inline h-3 w-3 mr-1 -mt-0.5" />
            {scenarioLoadedNote}
          </p>
        )}
        {scenarioStorageError && (
          <p className="text-[11px] text-red-700 dark:text-red-300">
            {scenarioStorageError}
          </p>
        )}
        {selected && (
          <p className="text-[11px] text-gray-500 dark:text-ink-muted">
            Scenario changes only affect local test values — they
            never modify the template configuration.
          </p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Phase 2E — Multi-scenario QA section
// ---------------------------------------------------------------------------

function MultiScenarioQASection({
  scenarios,
  multiSelectedIds,
  multiRuns,
  multiRunning,
  multiSaveThenRunBusy,
  multiSaveError,
  multiExpandedId,
  multiHasSettledRun,
  templateId,
  isDraft,
  hasUnsavedChanges,
  canSave,
  saving,
  onSaveTemplate,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  onRunSelected,
  onRunAll,
  onSaveThenRunSelected,
  onCancelRun,
  onExpand,
  onLoadIntoForm,
  onRunSingle,
  reportStatus,
  onCopyMultiReport,
  onDownloadMultiReport,
  onCopyMultiCsv,
  onDownloadMultiCsv,
}: {
  scenarios: PatternTestScenario[];
  multiSelectedIds: Set<string>;
  multiRuns: ScenarioRunState[];
  multiRunning: boolean;
  multiSaveThenRunBusy: boolean;
  multiSaveError: string | null;
  multiExpandedId: string | null;
  multiHasSettledRun: boolean;
  templateId: string | null;
  isDraft: boolean;
  hasUnsavedChanges: boolean;
  canSave: boolean;
  saving: boolean;
  onSaveTemplate?: () => Promise<void> | void;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onRunSelected: () => void;
  onRunAll: () => void;
  onSaveThenRunSelected: () => void;
  onCancelRun: () => void;
  onExpand: (id: string) => void;
  onLoadIntoForm: (id: string) => void;
  onRunSingle: (id: string) => void;
  // Phase 2H — report-action plumbing.
  reportStatus: { type: "success" | "error"; message: string } | null;
  onCopyMultiReport: () => void;
  onDownloadMultiReport: () => void;
  onCopyMultiCsv: () => void;
  onDownloadMultiCsv: () => void;
}) {
  const [open, setOpen] = useState(false);

  // Render a flat alphabetical-ish list (re-uses scenarios order
  // from the parent — most-recently-updated first). Keeps the UI
  // small even with up to 50 scenarios.
  const sorted = useMemo(
    () =>
      [...scenarios].sort((a, b) =>
        (b.updated_at || "").localeCompare(a.updated_at || ""),
      ),
    [scenarios],
  );

  // Progress for the header count.
  const inFlight = multiRuns.filter((r) => r.status === "running").length;
  const completed = multiRuns.filter(
    (r) =>
      r.status === "success" ||
      r.status === "failed" ||
      r.status === "cancelled",
  ).length;
  const total = multiRuns.length;

  const safeIds = useMemo(
    () => new Set(scenarios.map((s) => s.id)),
    [scenarios],
  );
  // Defensive — ignore stray ids that point to deleted scenarios.
  const selectedCount = Array.from(multiSelectedIds).filter((id) =>
    safeIds.has(id),
  ).length;

  // Disable rules
  const noTemplate = !templateId;
  const noScenarios = scenarios.length === 0;
  const cannotRun =
    multiRunning ||
    multiSaveThenRunBusy ||
    isDraft ||
    noTemplate ||
    noScenarios;
  const showSaveThenRun =
    !!onSaveTemplate && hasUnsavedChanges && !isDraft && canSave;

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
          <FlaskConical className="h-4 w-4 text-brand-600 dark:text-brand-50" />
          Multi-scenario QA
        </div>
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          {scenarios.length === 0
            ? "No saved scenarios yet"
            : multiRunning
              ? `Running ${Math.min(completed + inFlight, total)} of ${total}…`
              : total > 0
                ? `Last batch: ${completed} of ${total} done`
                : `${selectedCount} selected · ${scenarios.length} saved`}
        </span>
      </button>
      {open && (
        <div className="px-3 py-2 space-y-2">
          {/* Empty / draft / unsaved-template warnings */}
          {noScenarios && (
            <p className="text-[11px] text-gray-500 dark:text-ink-muted">
              Save scenarios first to run multi-scenario QA. Add a few
              starter scenarios via the Scenarios card above.
            </p>
          )}
          {isDraft && (
            <InlineAlert tone="warning">
              Save this template before running multi-scenario QA.
              The runner reads the persisted version on the server.
            </InlineAlert>
          )}
          {!isDraft && hasUnsavedChanges && !noScenarios && (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 dark:border-yellow-900 dark:bg-yellow-950/30">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-yellow-700 dark:text-yellow-300" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-yellow-900 dark:text-yellow-100">
                    Unsaved template changes are not included in
                    multi-scenario QA
                  </p>
                  <p className="mt-0.5 text-[11px] text-yellow-800 dark:text-yellow-200">
                    The runner reads the LAST SAVED template. To
                    test your local edits, save first.
                  </p>
                  {showSaveThenRun && (
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      className="mt-2"
                      onClick={onSaveThenRunSelected}
                      disabled={
                        cannotRun ||
                        selectedCount === 0 ||
                        saving ||
                        multiSaveThenRunBusy
                      }
                      loading={multiSaveThenRunBusy || saving}
                    >
                      Save then run selected
                    </Button>
                  )}
                  {multiSaveError && (
                    <p className="mt-2 text-[11px] text-red-700 dark:text-red-300">
                      Save failed: {multiSaveError}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Scenario picker — checkbox list */}
          {!noScenarios && (
            <div className="rounded border border-gray-200 dark:border-line">
              <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-2 py-1 dark:border-line/60">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onSelectAll}
                    className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300"
                  >
                    Select all
                  </button>
                  <span className="text-[11px] text-gray-300 dark:text-ink-subtle">
                    ·
                  </span>
                  <button
                    type="button"
                    onClick={onClearSelection}
                    className="text-[11px] font-medium text-gray-600 hover:underline dark:text-ink-muted"
                  >
                    Clear
                  </button>
                </div>
                <span className="text-[11px] text-gray-500 dark:text-ink-muted">
                  {selectedCount} of {scenarios.length} selected
                </span>
              </div>
              <ul className="max-h-48 overflow-y-auto divide-y divide-gray-100 dark:divide-line/60">
                {sorted.map((s) => {
                  const checked = multiSelectedIds.has(s.id);
                  return (
                    <li
                      key={s.id}
                      className="flex items-center gap-2 px-2 py-1 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleSelect(s.id)}
                        disabled={multiRunning}
                        className="h-3.5 w-3.5"
                      />
                      <span className="flex-1 min-w-0 truncate text-gray-800 dark:text-ink">
                        {s.name}
                      </span>
                      {s.last_result_status && (
                        <span className="font-mono text-[10px] text-gray-500 dark:text-ink-muted">
                          {s.last_result_status}
                        </span>
                      )}
                      {s.last_run_at && (
                        <span className="text-[10px] text-gray-400 dark:text-ink-subtle">
                          {_formatRelativeTime(s.last_run_at)}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Run controls */}
          {!noScenarios && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={cannotRun || selectedCount === 0}
                loading={multiRunning && !multiSaveThenRunBusy}
                onClick={onRunSelected}
                title={
                  isDraft
                    ? "Save this template first."
                    : selectedCount === 0
                      ? "Pick at least one scenario."
                      : "Run all selected scenarios sequentially."
                }
              >
                <Play className="h-3.5 w-3.5" />
                Run selected
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={cannotRun || scenarios.length === 0}
                onClick={onRunAll}
                title="Run every saved scenario for this template + pattern."
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Run all
              </Button>
              {multiRunning && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onCancelRun}
                  title="Stop the batch after the current scenario settles."
                >
                  <CircleAlert className="h-3.5 w-3.5" />
                  Cancel
                </Button>
              )}
              <div className="flex-1" />
              {scenarios.length >= 10 && selectedCount >= 10 && !multiRunning && (
                <span className="text-[10px] text-yellow-700 dark:text-yellow-300">
                  Running many scenarios may take a while.
                </span>
              )}
            </div>
          )}

          {/* Phase 2G — Aggregate diagnostic summary above the matrix.
              Shown only after a batch has at least one settled
              scenario so the operator doesn't see a half-baked
              rollup mid-run. */}
          {multiRuns.length > 0 &&
            multiRuns.some(
              (r) =>
                r.status === "success" ||
                r.status === "failed" ||
                r.status === "cancelled",
            ) && (
              <MultiScenarioDiagnosticSummaryCard
                runs={multiRuns}
                running={multiRunning}
              />
            )}

          {/* Phase 2H — Multi-scenario report actions. Disabled
              while the batch is mid-run to avoid ambiguous
              "did this include the running scenarios?" reports. */}
          {multiRuns.length > 0 && (
            <ReportActionRow
              kind="multi"
              status={reportStatus}
              disabled={!multiHasSettledRun || multiRunning}
              onCopy={onCopyMultiReport}
              onDownload={onDownloadMultiReport}
              onCopyCsv={onCopyMultiCsv}
              onDownloadCsv={onDownloadMultiCsv}
            />
          )}

          {/* Progress + result matrix */}
          {multiRuns.length > 0 && (
            <ResultMatrix
              runs={multiRuns}
              expandedId={multiExpandedId}
              onExpand={onExpand}
              onLoadIntoForm={onLoadIntoForm}
              onRunSingle={onRunSingle}
              multiRunning={multiRunning}
            />
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Phase 2E — Result matrix + per-row details drawer
// ---------------------------------------------------------------------------

function ResultMatrix({
  runs,
  expandedId,
  onExpand,
  onLoadIntoForm,
  onRunSingle,
  multiRunning,
}: {
  runs: ScenarioRunState[];
  expandedId: string | null;
  onExpand: (id: string) => void;
  onLoadIntoForm: (id: string) => void;
  onRunSingle: (id: string) => void;
  multiRunning: boolean;
}) {
  return (
    <div className="rounded border border-gray-200 dark:border-line overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 dark:bg-surface-muted">
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
            <th className="px-2 py-1.5">Scenario</th>
            <th className="px-2 py-1.5">Run</th>
            <th className="px-2 py-1.5">Status</th>
            <th className="px-2 py-1.5">Rows</th>
            <th className="px-2 py-1.5">Ready</th>
            <th className="px-2 py-1.5">Warn</th>
            <th className="px-2 py-1.5">Block</th>
            <th className="px-2 py-1.5">Errors</th>
            <th className="px-2 py-1.5">Missing</th>
            <th className="px-2 py-1.5"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-line/60">
          {runs.map((r) => (
            <ResultMatrixRow
              key={r.scenarioId}
              run={r}
              expanded={expandedId === r.scenarioId}
              onExpand={() => onExpand(r.scenarioId)}
              onLoadIntoForm={() => onLoadIntoForm(r.scenarioId)}
              onRunSingle={() => onRunSingle(r.scenarioId)}
              multiRunning={multiRunning}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultMatrixRow({
  run,
  expanded,
  onExpand,
  onLoadIntoForm,
  onRunSingle,
  multiRunning,
}: {
  run: ScenarioRunState;
  expanded: boolean;
  onExpand: () => void;
  onLoadIntoForm: () => void;
  onRunSingle: () => void;
  multiRunning: boolean;
}) {
  const metrics = run.result ? deriveScenarioMetrics(run.result) : null;
  const summary = run.result?.summary;
  const resolverStatus = summary?.status ?? "—";
  const resolverMeta =
    RESOLVER_STATUS_META[resolverStatus] ?? null;

  // Row tone — distinct from resolver status because the request
  // itself can succeed-but-need-review or outright fail.
  const rowTone =
    run.status === "failed"
      ? "bg-red-50/60 dark:bg-red-950/20"
      : run.status === "cancelled"
        ? "bg-gray-50 dark:bg-surface-muted/40"
        : run.status === "success"
          ? resolverStatus === "blocked" || resolverStatus === "conflict"
            ? "bg-red-50/40 dark:bg-red-950/10"
            : resolverStatus === "needs_review"
              ? "bg-yellow-50/40 dark:bg-yellow-950/10"
              : "bg-white dark:bg-transparent"
          : "bg-white dark:bg-transparent";

  const missingCount = metrics
    ? metrics.missingFacts.length +
      metrics.missingHints.length +
      metrics.blockedColumns.length
    : 0;

  return (
    <>
      <tr className={cn(rowTone)}>
        <td className="px-2 py-1.5 align-top">
          <button
            type="button"
            onClick={onExpand}
            className="text-left text-xs font-medium text-gray-800 dark:text-ink hover:underline"
            disabled={!run.result && run.status !== "failed"}
            title={
              run.result || run.status === "failed"
                ? expanded
                  ? "Hide details"
                  : "Show details"
                : "Result not yet available"
            }
          >
            {expanded ? (
              <ChevronDown className="inline h-3 w-3 mr-0.5 text-gray-400 dark:text-ink-subtle" />
            ) : (
              <ChevronRight className="inline h-3 w-3 mr-0.5 text-gray-400 dark:text-ink-subtle" />
            )}
            {run.scenarioName}
          </button>
        </td>
        <td className="px-2 py-1.5 align-top">
          <RunStatusPill status={run.status} />
        </td>
        <td className="px-2 py-1.5 align-top">
          {resolverMeta ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
                resolverMeta.badge,
              )}
            >
              <resolverMeta.Icon className="h-3 w-3" />
              {resolverMeta.label}
            </span>
          ) : (
            <span className="text-gray-400 dark:text-ink-subtle">—</span>
          )}
        </td>
        <td className="px-2 py-1.5 align-top text-gray-700 dark:text-ink">
          {summary?.rows ?? "—"}
        </td>
        <td className="px-2 py-1.5 align-top text-green-700 dark:text-green-200">
          {summary?.ready ?? "—"}
        </td>
        <td className="px-2 py-1.5 align-top text-yellow-700 dark:text-yellow-200">
          {summary?.warnings ?? "—"}
        </td>
        <td className="px-2 py-1.5 align-top text-red-700 dark:text-red-200">
          {summary?.blocked ?? "—"}
        </td>
        <td className="px-2 py-1.5 align-top text-red-700 dark:text-red-200">
          {summary?.errors ?? "—"}
        </td>
        <td className="px-2 py-1.5 align-top text-gray-700 dark:text-ink">
          {metrics ? (
            <span title={`${metrics.missingFacts.length} fact(s), ${metrics.missingHints.length} hint(s), ${metrics.blockedColumns.length} blocked column(s)`}>
              {missingCount}
            </span>
          ) : (
            "—"
          )}
        </td>
        <td className="px-2 py-1.5 align-top text-right">
          <div className="inline-flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onLoadIntoForm}
              disabled={multiRunning}
              title="Load this scenario into the single-run form above"
            >
              Load
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRunSingle}
              disabled={multiRunning}
              title="Re-run only this scenario"
            >
              Run
            </Button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className={cn(rowTone)}>
          <td colSpan={10} className="px-3 py-2">
            <ResultMatrixDetails run={run} />
          </td>
        </tr>
      )}
    </>
  );
}

function RunStatusPill({ status }: { status: ScenarioRunStatus }) {
  const meta: Record<
    ScenarioRunStatus,
    { label: string; classes: string; Icon: LucideIcon | null }
  > = {
    queued: {
      label: "Queued",
      classes:
        "bg-gray-100 text-gray-700 border-gray-200 dark:bg-surface-muted dark:text-ink-muted dark:border-line",
      Icon: null,
    },
    running: {
      label: "Running",
      classes:
        "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-200 dark:border-blue-900",
      Icon: Loader2,
    },
    success: {
      label: "Success",
      classes:
        "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900",
      Icon: CheckCircle2,
    },
    failed: {
      label: "Failed",
      classes:
        "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
      Icon: CircleAlert,
    },
    cancelled: {
      label: "Cancelled",
      classes:
        "bg-gray-100 text-gray-600 border-gray-200 dark:bg-surface-muted dark:text-ink-muted dark:border-line",
      Icon: null,
    },
  };
  const m = meta[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
        m.classes,
      )}
    >
      {m.Icon && (
        <m.Icon
          className={cn("h-3 w-3", status === "running" && "animate-spin")}
        />
      )}
      {m.label}
    </span>
  );
}

function ResultMatrixDetails({ run }: { run: ScenarioRunState }) {
  if (run.status === "failed") {
    return (
      <InlineAlert tone="error">
        {run.error ?? "Pattern test request failed."}
      </InlineAlert>
    );
  }
  if (run.status === "cancelled") {
    return (
      <p className="text-xs text-gray-500 dark:text-ink-muted">
        This scenario was cancelled before completion.
      </p>
    );
  }
  if (!run.result) {
    return (
      <p className="text-xs text-gray-500 dark:text-ink-muted">
        No result available yet.
      </p>
    );
  }
  const result = run.result;
  const metrics = deriveScenarioMetrics(result);
  const summary = result.summary;
  const status = summary?.status ?? "—";
  const meta = RESOLVER_STATUS_META[status];

  // Top issues — capped to keep the drawer compact. Operators
  // who need the full view can use "Load into form" + Run.
  const issues = (result.resolver_result.issues ?? []).slice(0, 5);

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
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
        <span className="text-gray-500 dark:text-ink-muted">
          Rows {summary?.rows ?? 0} · Ready {summary?.ready ?? 0} ·
          Warnings {summary?.warnings ?? 0} · Errors{" "}
          {summary?.errors ?? 0}
        </span>
      </div>

      {/* Phase 2G — compact diagnostic review per row. Sits above
          the legacy quick-list so the operator sees operational
          guidance before the raw lists. */}
      <DiagnosticReviewCard result={result} compact />

      {metrics.blockedColumns.length > 0 && (
        <div>
          <p className="text-[10px] uppercase font-semibold text-gray-500 dark:text-ink-subtle">
            Blocked required columns
          </p>
          <p className="text-gray-800 dark:text-ink">
            {metrics.blockedColumns.join(", ")}
          </p>
        </div>
      )}
      {metrics.missingFacts.length > 0 && (
        <div>
          <p className="text-[10px] uppercase font-semibold text-gray-500 dark:text-ink-subtle">
            Missing extracted facts
          </p>
          <p className="text-gray-800 dark:text-ink">
            {metrics.missingFacts.join(", ")}
          </p>
        </div>
      )}
      {metrics.missingHints.length > 0 && (
        <div>
          <p className="text-[10px] uppercase font-semibold text-gray-500 dark:text-ink-subtle">
            Missing catalog hints
          </p>
          <p className="text-gray-800 dark:text-ink">
            {metrics.missingHints.join(", ")}
          </p>
        </div>
      )}

      {issues.length > 0 && (
        <div>
          <p className="text-[10px] uppercase font-semibold text-gray-500 dark:text-ink-subtle">
            Top issues
          </p>
          <ul className="mt-1 space-y-1">
            {issues.map((issue, idx) => (
              <li
                key={`${issue.code}-${idx}`}
                className="rounded border border-gray-200 px-2 py-1 dark:border-line"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-gray-800 dark:text-ink">
                    <span className="font-medium capitalize">
                      {issue.severity}
                    </span>
                    {": "}
                    {issue.message}
                  </p>
                  <span className="shrink-0 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] uppercase text-gray-500 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                    {issue.code}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {(result.resolver_result.issues?.length ?? 0) > issues.length && (
            <p className="mt-1 text-[11px] text-gray-500 dark:text-ink-muted">
              + {(result.resolver_result.issues?.length ?? 0) - issues.length}{" "}
              more — click Load + Run to see the full single-run detail.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 2E — Pure metric derivation shared by the matrix + details drawer
// ---------------------------------------------------------------------------

interface ScenarioMetrics {
  missingFacts: string[];
  missingHints: string[];
  blockedColumns: string[];
}

function deriveScenarioMetrics(
  result: TemplatePatternTestResult,
): ScenarioMetrics {
  const missingFacts: string[] = [];
  const missingHints: string[] = [];
  const blockedColumns: string[] = [];

  for (const issue of result.resolver_result.issues ?? []) {
    if (issue.code === "INVOICE_FIELD_FACT_NOT_FOUND") {
      const label =
        issue.field_key ?? issue.column_label ?? issue.column_id ?? "(unknown)";
      missingFacts.push(label);
    } else if (
      issue.code === "CATALOG_HINT_MISSING" ||
      issue.code === "CATALOG_NOT_CONFIGURED" ||
      issue.code === "CATALOG_ENTRY_NOT_FOUND" ||
      issue.code === "CATALOG_NOT_FOUND"
    ) {
      missingHints.push(
        issue.column_label ?? issue.column_id ?? "(unknown)",
      );
    } else if (issue.code === "REQUIRED_RUNTIME_VALUE_MISSING") {
      blockedColumns.push(
        issue.column_label ?? issue.column_id ?? "(unknown)",
      );
    }
  }

  // Cell-level codes — some resolver versions surface these on cells.
  for (const row of result.resolver_result.rows ?? []) {
    for (const cell of row.cells ?? []) {
      const codes = cell.issue_codes ?? [];
      if (codes.includes("INVOICE_FIELD_FACT_NOT_FOUND")) {
        missingFacts.push(cell.column_label ?? cell.column_id);
      }
      if (codes.includes("REQUIRED_RUNTIME_VALUE_MISSING")) {
        blockedColumns.push(cell.column_label ?? cell.column_id);
      }
    }
  }

  // Bridge-side: pattern declares fields the operator didn't fill.
  const unfilled =
    (result.bridge_input.document_metadata?.unfilled_pattern_fields as
      | string[]
      | undefined) ?? [];
  for (const f of unfilled) missingFacts.push(f);

  return {
    missingFacts: Array.from(new Set(missingFacts)),
    missingHints: Array.from(new Set(missingHints)),
    blockedColumns: Array.from(new Set(blockedColumns)),
  };
}

// ---------------------------------------------------------------------------
// Phase 2G — Diagnostic review card (single-run + per-row in matrix)
// ---------------------------------------------------------------------------

const SEVERITY_VISUAL: Record<
  DiagnosticSeverity,
  { Icon: LucideIcon; banner: string; chip: string; iconClass: string }
> = {
  ready: {
    Icon: CheckCircle2,
    banner:
      "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40",
    chip:
      "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900",
    iconClass: "text-green-600 dark:text-green-400",
  },
  info: {
    Icon: Info,
    banner:
      "border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/40",
    chip:
      "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-200 dark:border-blue-900",
    iconClass: "text-blue-600 dark:text-blue-300",
  },
  warning: {
    Icon: AlertTriangle,
    banner:
      "border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/40",
    chip:
      "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900",
    iconClass: "text-yellow-600 dark:text-yellow-300",
  },
  blocked: {
    Icon: CircleAlert,
    banner: "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40",
    chip:
      "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
    iconClass: "text-red-600 dark:text-red-300",
  },
};

const FIX_AREA_CHIP: Record<DiagnosticFixArea, string> = {
  scenario_input:
    "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-200 dark:border-blue-900",
  invoice_pattern:
    "bg-cyan-50 text-cyan-800 border-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-200 dark:border-cyan-900",
  import_template:
    "bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-950/30 dark:text-purple-200 dark:border-purple-900",
  reference_data:
    "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/30 dark:text-orange-200 dark:border-orange-900",
  runtime_context:
    "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-200 dark:border-yellow-900",
  unknown:
    "bg-gray-100 text-gray-700 border-gray-200 dark:bg-surface-muted dark:text-ink-muted dark:border-line",
};

function DiagnosticReviewCard({
  result,
  compact = false,
}: {
  result: TemplatePatternTestResult;
  /** ``true`` when rendered inside the multi-scenario row drawer —
   *  trims the headline + caps the diagnostic list. */
  compact?: boolean;
}) {
  const summary = useMemo(
    () => derivePatternTestDiagnostics(result),
    [result],
  );
  const visual = SEVERITY_VISUAL[summary.status];
  const visibleDiagnostics = compact
    ? summary.diagnostics.slice(0, 4)
    : summary.diagnostics;
  const overflow = Math.max(
    0,
    summary.diagnostics.length - visibleDiagnostics.length,
  );

  return (
    <section
      className={cn(
        "rounded-md border space-y-2",
        visual.banner,
        compact ? "p-2" : "p-3",
      )}
      aria-label="Diagnostic review"
    >
      <header className="flex items-start gap-2">
        <visual.Icon
          className={cn("h-4 w-4 shrink-0 mt-0.5", visual.iconClass)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p
              className={cn(
                "font-semibold text-gray-900 dark:text-ink",
                compact ? "text-xs" : "text-sm",
              )}
            >
              {summary.headline}
            </p>
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                visual.chip,
              )}
            >
              {summary.status}
            </span>
          </div>
          {!compact && (
            <p className="mt-0.5 text-xs text-gray-700 dark:text-ink-muted">
              {summary.detail}
            </p>
          )}
          <p
            className={cn(
              "mt-1 text-gray-800 dark:text-ink",
              compact ? "text-[11px]" : "text-xs",
            )}
          >
            <span className="font-medium">Next:</span>{" "}
            {summary.suggestedNextAction}
          </p>
        </div>
      </header>

      {visibleDiagnostics.length > 0 && (
        <ul className="space-y-1.5">
          {visibleDiagnostics.map((d) => (
            <li key={d.id}>
              <DiagnosticItem diagnostic={d} compact={compact} />
            </li>
          ))}
        </ul>
      )}
      {overflow > 0 && (
        <p className="text-[11px] text-gray-600 dark:text-ink-muted">
          + {overflow} more diagnostic{overflow === 1 ? "" : "s"} —
          re-run the single-scenario flow to see the full list.
        </p>
      )}
    </section>
  );
}

function DiagnosticItem({
  diagnostic,
  compact = false,
}: {
  diagnostic: PatternTestDiagnostic;
  compact?: boolean;
}) {
  const visual = SEVERITY_VISUAL[diagnostic.severity];
  return (
    <div
      className={cn(
        "rounded border bg-white px-2.5 py-2 dark:bg-surface-subtle",
        visual.banner.replace(/bg-[a-z]+-50\b/g, "").replace(
          /dark:bg-[a-z]+-950\/40\b/g,
          "",
        ),
      )}
    >
      <div className="flex items-start gap-2">
        <visual.Icon
          className={cn("h-3.5 w-3.5 shrink-0 mt-0.5", visual.iconClass)}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "font-semibold text-gray-900 dark:text-ink",
              compact ? "text-[11px]" : "text-xs",
            )}
          >
            {diagnostic.title}
          </p>
          <p
            className={cn(
              "mt-0.5 text-gray-700 dark:text-ink",
              compact ? "text-[11px]" : "text-xs",
            )}
          >
            {diagnostic.message}
          </p>
          <p
            className={cn(
              "mt-0.5 text-gray-700 dark:text-ink-muted",
              compact ? "text-[11px]" : "text-xs",
            )}
          >
            <Info className="inline h-3 w-3 mr-1 -mt-0.5" />
            {diagnostic.recommendation}
          </p>
          <div className="mt-1.5 flex items-center gap-1 flex-wrap">
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                FIX_AREA_CHIP[diagnostic.fixArea],
              )}
              title={`Fix area: ${FIX_AREA_LABEL[diagnostic.fixArea]}`}
            >
              {FIX_AREA_LABEL[diagnostic.fixArea]}
            </span>
            {diagnostic.relatedColumn && (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                column: {diagnostic.relatedColumn}
              </span>
            )}
            {diagnostic.relatedField && (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                field: {diagnostic.relatedField}
              </span>
            )}
            {diagnostic.relatedHint && (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                hint: {diagnostic.relatedHint}
              </span>
            )}
            {diagnostic.issueCodes.map((code) => (
              <span
                key={code}
                className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gray-500 dark:border-line dark:bg-surface-muted dark:text-ink-muted"
              >
                {code}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 2G — Aggregate diagnostic summary above the multi-scenario matrix
// ---------------------------------------------------------------------------

function MultiScenarioDiagnosticSummaryCard({
  runs,
  running,
}: {
  runs: ScenarioRunState[];
  running: boolean;
}) {
  const aggregate: MultiScenarioDiagnosticSummary = useMemo(
    () => deriveMultiScenarioDiagnostics(runs),
    [runs],
  );

  // Pick the dominant severity for the banner tone — blocked > warning > ready.
  const tone: DiagnosticSeverity =
    aggregate.blocked > 0 || aggregate.failed > 0
      ? "blocked"
      : aggregate.needsReview > 0
        ? "warning"
        : aggregate.ready > 0
          ? "ready"
          : "info";
  const visual = SEVERITY_VISUAL[tone];

  return (
    <section
      className={cn("rounded-md border p-3 space-y-2", visual.banner)}
      aria-label="Multi-scenario diagnostic summary"
    >
      <header className="flex items-start gap-2">
        <visual.Icon
          className={cn("h-4 w-4 shrink-0 mt-0.5", visual.iconClass)}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900 dark:text-ink">
            {running ? "Batch in progress · " : ""}
            {aggregate.totalRuns} scenario
            {aggregate.totalRuns === 1 ? "" : "s"} run · {aggregate.ready}{" "}
            ready · {aggregate.needsReview} needs review ·{" "}
            {aggregate.blocked} blocked
            {aggregate.failed > 0 ? ` · ${aggregate.failed} failed` : ""}
            {aggregate.cancelled > 0
              ? ` · ${aggregate.cancelled} cancelled`
              : ""}
          </p>
          <p className="mt-0.5 text-xs text-gray-800 dark:text-ink">
            <span className="font-medium">Next:</span>{" "}
            {aggregate.suggestedNextAction}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <AggregateList
          label="Most common missing facts"
          items={aggregate.topMissingFacts}
        />
        <AggregateList
          label="Most common missing hints"
          items={aggregate.topMissingHints}
        />
        <AggregateList
          label="Most common blocked columns"
          items={aggregate.topBlockedColumns}
        />
      </div>
    </section>
  );
}

function AggregateList({
  label,
  items,
}: {
  label: string;
  items: Array<{ value: string; count: number; scenarios: string[] }>;
}) {
  return (
    <div className="rounded border border-gray-200 bg-white/70 px-2 py-1.5 dark:border-line dark:bg-surface-subtle/70">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle font-semibold">
        {label}
      </p>
      {items.length === 0 ? (
        <p className="mt-0.5 text-[11px] text-gray-500 dark:text-ink-muted">
          —
        </p>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {items.map((item) => (
            <li
              key={item.value}
              className="text-[11px] text-gray-800 dark:text-ink"
              title={`Scenarios: ${item.scenarios.join(", ")}`}
            >
              <span className="font-medium">{item.value}</span>{" "}
              <span className="text-gray-500 dark:text-ink-muted">
                · {item.count} scenario{item.count === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 2H — QA report action row (single + multi shared component)
// ---------------------------------------------------------------------------

function ReportActionRow({
  kind,
  status,
  disabled = false,
  onCopy,
  onDownload,
  onCopyCsv,
  onDownloadCsv,
}: {
  /** Drives label copy + which action set is rendered. */
  kind: "single" | "multi";
  status: { type: "success" | "error"; message: string } | null;
  disabled?: boolean;
  onCopy: () => void;
  onDownload: () => void;
  /** Multi-only — the matrix CSV actions. */
  onCopyCsv?: () => void;
  onDownloadCsv?: () => void;
}) {
  const isMulti = kind === "multi";
  return (
    <section
      className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-line dark:bg-surface-subtle"
      aria-label={
        isMulti
          ? "Multi-scenario QA report actions"
          : "Pattern test report actions"
      }
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-700 dark:text-ink-muted">
          <FileText className="h-3.5 w-3.5 text-brand-600 dark:text-brand-50" />
          {isMulti ? "QA report" : "Report"}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCopy}
          disabled={disabled}
          title={
            isMulti
              ? "Copy a Markdown summary of every settled scenario to the clipboard"
              : "Copy a Markdown summary of this run to the clipboard"
          }
        >
          <ClipboardCopy className="h-3.5 w-3.5" />
          Copy {isMulti ? "QA report" : "report"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDownload}
          disabled={disabled}
          title={
            isMulti
              ? "Download a Markdown summary of every settled scenario"
              : "Download a Markdown summary of this run"
          }
        >
          <Download className="h-3.5 w-3.5" />
          Download {isMulti ? "QA report" : "report"}
        </Button>
        {isMulti && onCopyCsv && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCopyCsv}
            disabled={disabled}
            title="Copy the QA matrix as CSV (Excel / Google Sheets ready)"
          >
            <Table className="h-3.5 w-3.5" />
            Copy matrix CSV
          </Button>
        )}
        {isMulti && onDownloadCsv && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDownloadCsv}
            disabled={disabled}
            title="Download the QA matrix as a .csv file"
          >
            <Download className="h-3.5 w-3.5" />
            Download CSV
          </Button>
        )}
        <div className="flex-1" />
        {status && (
          <span
            className={cn(
              "text-[11px] font-medium",
              status.type === "success"
                ? "text-green-700 dark:text-green-300"
                : "text-red-700 dark:text-red-300",
            )}
            role={status.type === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {status.message}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-gray-500 dark:text-ink-muted">
        Diagnostic only — the report doesn't export accounting data.
      </p>
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

function SummaryCard({
  result,
  scenarioName,
}: {
  result: TemplatePatternTestResult;
  /** Phase 2D — selected scenario name (when one is selected). */
  scenarioName?: string | null;
}) {
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
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
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
        {scenarioName && (
          <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2 py-0.5 text-[11px] font-semibold text-gray-700 shrink-0 dark:border-line dark:bg-surface-subtle dark:text-ink">
            <Bookmark className="h-3 w-3" />
            Scenario: {scenarioName}
          </span>
        )}
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

// ---------------------------------------------------------------------------
// Phase 2D — pure compare-only payload builder.
//
// Mirrors ``buildPayload`` (the in-component callback) but is SIDE-
// EFFECT FREE: no setState, no setting of jsonErrors, no auto-opening
// the advanced section. Used by the scenario dirty-detection effect
// where calling setState would cause a render-loop warning.
// Returns ``null`` when any JSON textarea fails to parse — the
// scenario dirty check treats that as "dirty" (the operator has
// half-typed JSON that doesn't match the saved scenario).
// ---------------------------------------------------------------------------
function _buildPayloadForCompare(state: {
  quickFacts: Record<string, string>;
  vendorHint: string;
  propertyHint: string;
  glHint: string;
  factsJson: string;
  hintsJson: string;
  runtimeOptionsJson: string;
  docMetadataJson: string;
  includeEmptyFields: boolean;
}): TemplatePatternTestRequest | null {
  const factsFromQuick: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state.quickFacts)) {
    if (value && value.trim()) factsFromQuick[key] = value.trim();
  }
  let factsFromJson: Record<string, unknown> = {};
  if (state.factsJson.trim()) {
    try {
      const parsed = JSON.parse(state.factsJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      factsFromJson = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const manual_fact_values = { ...factsFromQuick, ...factsFromJson };

  const hintsFromQuick: Record<string, unknown> = {};
  if (state.vendorHint.trim()) hintsFromQuick.vendor = state.vendorHint.trim();
  if (state.propertyHint.trim())
    hintsFromQuick.property = state.propertyHint.trim();
  if (state.glHint.trim()) hintsFromQuick.gl = state.glHint.trim();

  let hintsFromJson: Record<string, unknown> = {};
  if (state.hintsJson.trim()) {
    try {
      const parsed = JSON.parse(state.hintsJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      hintsFromJson = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const manual_catalog_hints = { ...hintsFromQuick, ...hintsFromJson };

  let runtime_options: Record<string, unknown> | undefined;
  if (state.runtimeOptionsJson.trim()) {
    try {
      const parsed = JSON.parse(state.runtimeOptionsJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      runtime_options = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  let document_metadata: Record<string, unknown> | undefined;
  if (state.docMetadataJson.trim()) {
    try {
      const parsed = JSON.parse(state.docMetadataJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      document_metadata = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const out: TemplatePatternTestRequest = {
    include_empty_fields: state.includeEmptyFields,
  };
  if (Object.keys(manual_fact_values).length > 0)
    out.manual_fact_values = manual_fact_values;
  if (Object.keys(manual_catalog_hints).length > 0)
    out.manual_catalog_hints = manual_catalog_hints;
  if (runtime_options) out.runtime_options = runtime_options;
  if (document_metadata) out.document_metadata = document_metadata;
  return out;
}

// ---------------------------------------------------------------------------
// Phase 2D — friendly relative timestamp ("2 minutes ago", etc.) for
// the scenario "Last run" line. Tiny implementation — keeps the
// dependency surface minimal.
// ---------------------------------------------------------------------------
function _formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60)
    return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  // Fall back to the absolute date for older runs — relative copy
  // gets vague past a month.
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}
