"use client";

import {
  AlertTriangle,
  Badge as BadgeIcon,
  Bookmark,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Hash,
  Info,
  Loader2,
  Play,
  RefreshCw,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import {
  getApiErrorMessage,
  invoicePatternsApi,
  operationalResolutionApi,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  ResolvedImportCell,
  ResolvedImportRow,
  ResolverIssue,
  ResolverSeverity,
  ResolverStatus,
} from "@/types/import-resolver";
import type { InvoicePatternSummary } from "@/types/invoice-pattern";
import type {
  OperationalResolutionRequest,
  OperationalResolutionResult,
  OperationalReviewDiagnostic,
  OperationalReviewFixArea,
  OperationalReviewSeverity,
  PatternSelectionMode,
} from "@/types/operational-resolution";

/**
 * Phase 3B — Operational Resolution Preview UI.
 *
 * Frontend window onto the Phase 3A endpoint:
 *
 *   POST /api/v1/operational-resolution/run
 *
 * Lets the operator rehearse the future production flow with
 * operator-supplied facts before OCR/AI is wired:
 *
 *   1. Pick a saved invoice pattern (or run with no pattern).
 *   2. Optionally tag the run with a document_id / batch_id /
 *      preview label so the metadata trace mimics what the future
 *      Phase 3C+ pipeline will carry.
 *   3. Type manual extracted facts + catalog hints OR paste
 *      structured JSON in the advanced editor.
 *   4. Fire the request and inspect the operational summary,
 *      review diagnostics, resolver input, and resolver result
 *      side by side.
 *
 * Hard contract (mirrors the backend):
 *
 *   * Diagnostic only — never mutates the template / pattern /
 *     document / batch, never enqueues review work, never exports.
 *   * Uses the SAVED template (the endpoint takes the template id);
 *     the panel surfaces a strong unsaved-changes warning + a
 *     Save then preview action.
 *   * Drafts cannot be previewed — Run is disabled and the
 *     operator is told to save first.
 *
 * Distinct from the Phase 2C Test with Pattern panel:
 *   * Pattern Test = scenario lab with saved local presets.
 *   * Operational Preview = production-shaped envelope with
 *     document/batch context + operational metadata + the same
 *     resolver underneath.
 */

// ---------------------------------------------------------------------------
// Quick-fields catalog — same canonical fields the Pattern Test panel uses
// so operators don't need to learn a new vocabulary.
// ---------------------------------------------------------------------------

interface QuickFieldDescriptor {
  key: string;
  label: string;
  placeholder?: string;
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
// Status meta
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

const REVIEW_SEVERITY_VISUAL: Record<
  "ready" | "info" | "warning" | "blocked",
  { Icon: LucideIcon; chip: string; iconClass: string; banner: string }
> = {
  ready: {
    Icon: CheckCircle2,
    chip:
      "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900",
    iconClass: "text-green-600 dark:text-green-400",
    banner:
      "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40",
  },
  info: {
    Icon: Info,
    chip:
      "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-200 dark:border-blue-900",
    iconClass: "text-blue-600 dark:text-blue-300",
    banner:
      "border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/40",
  },
  warning: {
    Icon: AlertTriangle,
    chip:
      "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900",
    iconClass: "text-yellow-600 dark:text-yellow-400",
    banner:
      "border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/40",
  },
  blocked: {
    Icon: CircleAlert,
    chip:
      "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
    iconClass: "text-red-600 dark:text-red-300",
    banner: "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40",
  },
};

const FIX_AREA_LABEL: Record<string, string> = {
  extracted_fact: "Extracted facts",
  catalog_hint: "Catalog hints",
  import_template: "Import Template",
  invoice_pattern: "Invoice Pattern",
  reference_data: "Reference Data",
  unknown: "Needs review",
};

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface OperationalResolutionPreviewPanelProps {
  isOpen: boolean;
  onClose: () => void;
  templateId: string | null;
  templateName?: string | null;
  hasUnsavedChanges?: boolean;
  isDraft?: boolean;
  canSave?: boolean;
  saving?: boolean;
  /**
   * Persist-to-server hook (TemplateEditor.handleSave). Resolves on
   * success, REJECTS on save failure (Phase 1E semantics). The
   * panel's "Save then preview" button awaits it before firing the
   * preview. Optional — when absent the chained flow is hidden.
   */
  onSaveTemplate?: () => Promise<void> | void;
  /**
   * Optional default pattern id when opened from a context that
   * already knows which pattern is in use. The panel still lets
   * the operator change it.
   */
  initialPatternId?: string | null;
}

export function OperationalResolutionPreviewPanel({
  isOpen,
  onClose,
  templateId,
  templateName,
  hasUnsavedChanges = false,
  isDraft = false,
  canSave = false,
  saving = false,
  onSaveTemplate,
  initialPatternId,
}: OperationalResolutionPreviewPanelProps) {
  // ---- Pattern listing ------------------------------------------
  const [patterns, setPatterns] = useState<InvoicePatternSummary[]>([]);
  const [loadingPatterns, setLoadingPatterns] = useState(false);
  const [patternsError, setPatternsError] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] =
    useState<PatternSelectionMode>("manual");
  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(
    initialPatternId ?? null,
  );

  // ---- Operational context inputs ------------------------------
  // Free-text strings — validated client-side only when the operator
  // submits. Empty entries are dropped from the request body.
  const [documentId, setDocumentId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [previewLabel, setPreviewLabel] = useState("");

  // ---- Quick-fields state --------------------------------------
  const [quickFacts, setQuickFacts] = useState<Record<string, string>>({});
  const [vendorHint, setVendorHint] = useState("");
  const [propertyHint, setPropertyHint] = useState("");
  const [glHint, setGlHint] = useState("");

  // ---- Advanced JSON editor (collapsed by default) -------------
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [factsJson, setFactsJson] = useState("");
  const [hintsJson, setHintsJson] = useState("");
  const [docMetadataJson, setDocMetadataJson] = useState("");
  const [runtimeOptionsJson, setRuntimeOptionsJson] = useState("");
  const [jsonErrors, setJsonErrors] = useState<{
    facts?: string;
    hints?: string;
    document_metadata?: string;
    runtime_options?: string;
  }>({});

  // ---- Run state ------------------------------------------------
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<OperationalResolutionResult | null>(
    null,
  );

  // ---- Save then preview chained flow --------------------------
  const [saveThenPreviewBusy, setSaveThenPreviewBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ---- Race-protected request id -------------------------------
  const runRequestIdRef = useRef(0);
  const runAbortRef = useRef<AbortController | null>(null);

  // ---- Pattern fetch on open -----------------------------------
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      setLoadingPatterns(true);
      setPatternsError(null);
      try {
        const list = await invoicePatternsApi.list(200, 0);
        if (cancelled) return;
        const items = list.items ?? [];
        setPatterns(items);
        // Honour ``initialPatternId`` first, then fall back to the
        // most-recently-edited pattern (top of the list).
        setSelectedPatternId((curr) => {
          if (curr && items.some((p) => p.id === curr)) return curr;
          if (initialPatternId && items.some((p) => p.id === initialPatternId)) {
            return initialPatternId;
          }
          return items[0]?.id ?? null;
        });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Cleanup: abort in-flight request when panel closes.
  useEffect(() => {
    if (!isOpen) {
      runAbortRef.current?.abort();
    }
  }, [isOpen]);

  // ---- Payload construction -----------------------------------
  // Returns ``null`` (and sets jsonErrors) when any JSON textarea
  // fails to parse. Quick-fields merge BELOW advanced JSON so
  // explicit JSON keys override quick fields on the same key.
  const buildPayload = useCallback(():
    | OperationalResolutionRequest
    | null => {
    if (!templateId) return null;

    const errors: typeof jsonErrors = {};

    // Quick facts (skip blanks).
    const factsFromQuick: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(quickFacts)) {
      if (value && value.trim()) factsFromQuick[key] = value.trim();
    }

    // Advanced facts JSON (mapping OR list — backend tolerates both).
    let factsFromJson: Record<string, unknown> | unknown[] | undefined;
    if (factsJson.trim()) {
      try {
        const parsed = JSON.parse(factsJson);
        if (Array.isArray(parsed)) {
          factsFromJson = parsed as unknown[];
        } else if (typeof parsed === "object" && parsed !== null) {
          factsFromJson = parsed as Record<string, unknown>;
        } else {
          errors.facts = "Expected a JSON object or array.";
        }
      } catch (e) {
        errors.facts = `Invalid JSON: ${(e as Error).message}`;
      }
    }

    // Quick hints (skip blanks).
    const hintsFromQuick: Record<string, unknown> = {};
    if (vendorHint.trim()) hintsFromQuick.vendor = vendorHint.trim();
    if (propertyHint.trim()) hintsFromQuick.property = propertyHint.trim();
    if (glHint.trim()) hintsFromQuick.gl = glHint.trim();

    let hintsFromJson: Record<string, unknown> = {};
    if (hintsJson.trim()) {
      try {
        const parsed = JSON.parse(hintsJson);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          errors.hints = "Expected a JSON object.";
        } else {
          hintsFromJson = parsed as Record<string, unknown>;
        }
      } catch (e) {
        errors.hints = `Invalid JSON: ${(e as Error).message}`;
      }
    }

    let docMetadataFromJson: Record<string, unknown> | undefined;
    if (docMetadataJson.trim()) {
      try {
        const parsed = JSON.parse(docMetadataJson);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          errors.document_metadata = "Expected a JSON object.";
        } else {
          docMetadataFromJson = parsed as Record<string, unknown>;
        }
      } catch (e) {
        errors.document_metadata = `Invalid JSON: ${(e as Error).message}`;
      }
    }

    let runtimeOptionsFromJson: Record<string, unknown> | undefined;
    if (runtimeOptionsJson.trim()) {
      try {
        const parsed = JSON.parse(runtimeOptionsJson);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          errors.runtime_options = "Expected a JSON object.";
        } else {
          runtimeOptionsFromJson = parsed as Record<string, unknown>;
        }
      } catch (e) {
        errors.runtime_options = `Invalid JSON: ${(e as Error).message}`;
      }
    }

    setJsonErrors(errors);
    if (Object.keys(errors).length > 0) {
      setAdvancedOpen(true);
      return null;
    }

    // Merge facts.
    let manual_fact_values:
      | Record<string, unknown>
      | unknown[]
      | undefined = undefined;
    if (Array.isArray(factsFromJson)) {
      // List-shape from advanced JSON wins outright — quick fields
      // are skipped because the user explicitly chose the list path.
      manual_fact_values = factsFromJson;
    } else if (factsFromJson || Object.keys(factsFromQuick).length > 0) {
      manual_fact_values = {
        ...factsFromQuick,
        ...(factsFromJson ?? {}),
      };
    }

    const merged_hints: Record<string, unknown> = {
      ...hintsFromQuick,
      ...hintsFromJson,
    };

    // Merge document_metadata: caller JSON wins over the preview
    // label. Backend strips protected keys before merging into the
    // bridge / operational layers.
    const docMetadata: Record<string, unknown> = {};
    if (previewLabel.trim()) {
      docMetadata.preview_label = previewLabel.trim();
    }
    if (docMetadataFromJson) Object.assign(docMetadata, docMetadataFromJson);

    const payload: OperationalResolutionRequest = {
      template_id: templateId,
      pattern_selection_mode: selectionMode,
      diagnostic_only: true,
    };
    if (selectionMode === "manual" && selectedPatternId) {
      payload.pattern_id = selectedPatternId;
    }
    if (documentId.trim()) payload.document_id = documentId.trim();
    if (batchId.trim()) payload.batch_id = batchId.trim();
    if (manual_fact_values !== undefined) {
      payload.extracted_facts = manual_fact_values as
        | Record<string, unknown>
        | OperationalResolutionRequest["extracted_facts"];
    }
    if (Object.keys(merged_hints).length > 0) {
      payload.catalog_hints = merged_hints;
    }
    if (Object.keys(docMetadata).length > 0) {
      payload.document_metadata = docMetadata;
    }
    if (runtimeOptionsFromJson) {
      payload.runtime_options = runtimeOptionsFromJson;
    }
    return payload;
  }, [
    templateId,
    selectionMode,
    selectedPatternId,
    documentId,
    batchId,
    previewLabel,
    quickFacts,
    vendorHint,
    propertyHint,
    glHint,
    factsJson,
    hintsJson,
    docMetadataJson,
    runtimeOptionsJson,
  ]);

  const handleRun = useCallback(async () => {
    if (!templateId || isDraft) return;
    if (selectionMode === "manual" && !selectedPatternId) return;
    const payload = buildPayload();
    if (payload === null) return;

    runAbortRef.current?.abort();
    const controller = new AbortController();
    runAbortRef.current = controller;
    const myRequestId = ++runRequestIdRef.current;

    setRunning(true);
    setRunError(null);
    try {
      const next = await operationalResolutionApi.run(payload, {
        signal: controller.signal,
      });
      if (myRequestId !== runRequestIdRef.current) return;
      setResult(next);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (myRequestId !== runRequestIdRef.current) return;
      setRunError(
        getApiErrorMessage(err, "Could not run operational preview."),
      );
    } finally {
      if (myRequestId === runRequestIdRef.current) {
        setRunning(false);
      }
    }
  }, [templateId, isDraft, selectionMode, selectedPatternId, buildPayload]);

  const handleSaveThenPreview = useCallback(async () => {
    if (!onSaveTemplate || isDraft) return;
    if (saveThenPreviewBusy || saving) return;
    if (selectionMode === "manual" && !selectedPatternId) return;
    setSaveError(null);
    setSaveThenPreviewBusy(true);
    try {
      const maybe = onSaveTemplate();
      if (maybe && typeof (maybe as Promise<void>).then === "function") {
        await maybe;
      }
      await handleRun();
    } catch (err) {
      setSaveError(
        getApiErrorMessage(err, "Could not save the template before preview."),
      );
    } finally {
      setSaveThenPreviewBusy(false);
    }
  }, [
    onSaveTemplate,
    isDraft,
    saveThenPreviewBusy,
    saving,
    selectionMode,
    selectedPatternId,
    handleRun,
  ]);

  // ---- Derived ------------------------------------------------
  const selectedPattern = useMemo(
    () => patterns.find((p) => p.id === selectedPatternId) ?? null,
    [patterns, selectedPatternId],
  );

  const canRun =
    !!templateId &&
    !isDraft &&
    !running &&
    !saveThenPreviewBusy &&
    (selectionMode !== "manual" || !!selectedPatternId);

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={
        templateName
          ? `Operational Preview · ${templateName}`
          : "Operational Preview"
      }
      size="xl"
    >
      <div className="space-y-4 max-h-[72vh] overflow-y-auto pr-1">
        {/* ---- Scope copy ------------------------------------- */}
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
          <p>
            <span className="font-semibold">Operational Preview</span>{" "}
            is diagnostic only. It runs the same resolver pipeline
            shape Rivera will use for real uploaded documents, but
            it does not export, create Review Queue items, or modify
            documents.
          </p>
        </div>

        {/* ---- Draft / dirty banners -------------------------- */}
        {isDraft && (
          <InlineAlert tone="warning">
            Save this template before running Operational Preview.
            The pipeline reads the persisted version on the server.
          </InlineAlert>
        )}
        {!isDraft && hasUnsavedChanges && (
          <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-3 dark:border-yellow-900 dark:bg-yellow-950/30">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-yellow-700 dark:text-yellow-300" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-yellow-900 dark:text-yellow-100">
                  Unsaved template changes are not included in this preview
                </p>
                <p className="mt-0.5 text-xs text-yellow-800 dark:text-yellow-200">
                  Operational Preview reads the LAST SAVED template
                  from the server. To preview your local edits, save
                  first.
                </p>
                {onSaveTemplate && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={handleSaveThenPreview}
                      disabled={
                        !canSave ||
                        (selectionMode === "manual" && !selectedPatternId) ||
                        running ||
                        saveThenPreviewBusy ||
                        saving
                      }
                      loading={saveThenPreviewBusy || saving}
                    >
                      Save then preview
                    </Button>
                    <span className="text-[11px] text-yellow-700 dark:text-yellow-300">
                      Saves the template, then re-runs the preview.
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

        {/* ---- Pattern selection ------------------------------ */}
        <PatternSelectorSection
          patterns={patterns}
          loading={loadingPatterns}
          error={patternsError}
          selectionMode={selectionMode}
          selectedPatternId={selectedPatternId}
          onChangeSelectionMode={setSelectionMode}
          onSelect={setSelectedPatternId}
        />

        {/* ---- Operational context ---------------------------- */}
        <OperationalContextSection
          documentId={documentId}
          batchId={batchId}
          previewLabel={previewLabel}
          onChangeDocumentId={setDocumentId}
          onChangeBatchId={setBatchId}
          onChangePreviewLabel={setPreviewLabel}
        />

        {/* ---- Manual extracted facts ------------------------- */}
        <ManualFactsSection
          quickFacts={quickFacts}
          onChange={(key, value) =>
            setQuickFacts((curr) => ({ ...curr, [key]: value }))
          }
        />

        {/* ---- Manual catalog hints --------------------------- */}
        <ManualHintsSection
          vendor={vendorHint}
          property={propertyHint}
          gl={glHint}
          onChangeVendor={setVendorHint}
          onChangeProperty={setPropertyHint}
          onChangeGl={setGlHint}
        />

        {/* ---- Advanced JSON ---------------------------------- */}
        <AdvancedJsonSection
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((v) => !v)}
          factsJson={factsJson}
          hintsJson={hintsJson}
          docMetadataJson={docMetadataJson}
          runtimeOptionsJson={runtimeOptionsJson}
          jsonErrors={jsonErrors}
          onChangeFacts={setFactsJson}
          onChangeHints={setHintsJson}
          onChangeDocMetadata={setDocMetadataJson}
          onChangeRuntimeOptions={setRuntimeOptionsJson}
        />

        {/* ---- Run controls ----------------------------------- */}
        <div className="flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5 dark:border-line dark:bg-surface-muted">
          <p className="text-xs text-gray-600 dark:text-ink-muted">
            {!templateId
              ? "Save the template before running Operational Preview."
              : selectionMode === "manual" && !selectedPatternId
                ? "Select an invoice pattern (or switch selection mode to ‘No pattern’)."
                : selectionMode === "none"
                  ? "Running with no pattern — extracted facts and hints come straight from the inputs above."
                  : selectedPattern
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
                  ? "Drafts can't be previewed. Save first."
                  : selectionMode === "manual" && !selectedPatternId
                    ? "Pick an invoice pattern first."
                    : hasUnsavedChanges
                      ? "Heads up: this uses the last SAVED template. Use Save then preview above to include local edits."
                      : "Run the diagnostic operational preview."
            }
          >
            <Play className="h-3.5 w-3.5" />
            {result ? "Run again" : "Run preview"}
          </Button>
        </div>

        {/* ---- Loading / error / empty ------------------------ */}
        {running && (
          <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin text-brand-600 dark:text-brand-50" />
            Running operational preview…
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

        {!running && !runError && !result && (
          <div className="rounded-md border border-dashed border-gray-300 bg-white px-4 py-6 text-center text-xs text-gray-500 dark:border-line dark:bg-surface-subtle dark:text-ink-muted">
            Click Run preview to fire the operational pipeline.
          </div>
        )}

        {/* ---- Result ----------------------------------------- */}
        {result && !running && (
          <>
            {hasUnsavedChanges && !isDraft && (
              <div className="rounded-md border border-yellow-200 bg-yellow-50/60 px-2.5 py-1.5 text-[11px] text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/20 dark:text-yellow-200">
                These results reflect the LAST SAVED template. Local
                edits since the last save are not included — use
                “Save then preview” above to refresh.
              </div>
            )}

            <OperationalSummaryCard result={result} />
            <ReviewDiagnosticsSection
              diagnostics={result.review_diagnostics ?? []}
            />
            <ResolverInputCard result={result} />
            <ResolverResultCard result={result} />
            <OperationalNoteCard />
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
  selectionMode,
  selectedPatternId,
  onChangeSelectionMode,
  onSelect,
}: {
  patterns: InvoicePatternSummary[];
  loading: boolean;
  error: string | null;
  selectionMode: PatternSelectionMode;
  selectedPatternId: string | null;
  onChangeSelectionMode: (mode: PatternSelectionMode) => void;
  onSelect: (id: string | null) => void;
}) {
  return (
    <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
      <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
          <Workflow className="h-4 w-4 text-brand-600 dark:text-brand-50" />
          Invoice pattern
        </div>
        <span className="text-xs text-gray-500 dark:text-ink-muted">
          {patterns.length} saved
        </span>
      </header>
      <div className="px-3 py-2 space-y-2">
        {/* Mode toggle */}
        <div className="flex flex-wrap items-center gap-1.5">
          <ModeChip
            active={selectionMode === "manual"}
            onClick={() => onChangeSelectionMode("manual")}
          >
            Pick a saved pattern
          </ModeChip>
          <ModeChip
            active={selectionMode === "none"}
            onClick={() => onChangeSelectionMode("none")}
          >
            No pattern (direct facts)
          </ModeChip>
          <span className="ml-auto text-[11px] text-gray-500 dark:text-ink-muted">
            {selectionMode === "manual"
              ? "Bridges through the selected pattern's structural metadata."
              : "Sends only the facts and hints below — pattern is omitted."}
          </span>
        </div>

        {/* Manual selector */}
        {selectionMode === "manual" && (
          <>
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
                No invoice patterns found. Switch to “No pattern”
                above to run with direct facts only, or create a
                pattern in Invoice Builder.
              </p>
            )}
            {!loading && !error && patterns.length > 0 && (
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
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ModeChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-brand-500 bg-brand-50 text-brand-800 dark:border-brand-400 dark:bg-brand-950/40 dark:text-brand-50"
          : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-line dark:bg-surface dark:text-ink-muted dark:hover:bg-surface-muted",
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Operational context (document_id / batch_id / preview label)
// ---------------------------------------------------------------------------

function OperationalContextSection({
  documentId,
  batchId,
  previewLabel,
  onChangeDocumentId,
  onChangeBatchId,
  onChangePreviewLabel,
}: {
  documentId: string;
  batchId: string;
  previewLabel: string;
  onChangeDocumentId: (v: string) => void;
  onChangeBatchId: (v: string) => void;
  onChangePreviewLabel: (v: string) => void;
}) {
  return (
    <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
      <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
          <Hash className="h-4 w-4 text-brand-600 dark:text-brand-50" />
          Operational context
        </div>
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          Optional — diagnostic metadata only
        </span>
      </header>
      <div className="px-3 py-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <ContextField
          label="Document ID"
          placeholder="doc-uuid…"
          value={documentId}
          onChange={onChangeDocumentId}
        />
        <ContextField
          label="Batch ID"
          placeholder="batch-uuid…"
          value={batchId}
          onChange={onChangeBatchId}
        />
        <ContextField
          label="Preview label"
          placeholder="e.g. Q3 dry run"
          value={previewLabel}
          onChange={onChangePreviewLabel}
        />
      </div>
      <p className="px-3 pb-2 text-[11px] text-gray-500 dark:text-ink-muted">
        These ids are used only as metadata in this diagnostic preview.
        They never trigger a real document or batch lookup.
      </p>
    </section>
  );
}

function ContextField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
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
          Extracted facts
        </div>
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          Simulates OCR / AI extraction
        </span>
      </header>
      <div className="px-3 py-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {QUICK_FACT_FIELDS.map((field) => (
          <label
            key={field.key}
            className={cn(
              "flex flex-col gap-0.5",
              field.wide && "sm:col-span-2",
            )}
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
// Manual catalog hints
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
          Catalog hints
        </div>
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          Override or seed catalog matches
        </span>
      </header>
      <div className="px-3 py-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <ContextField
          label="Vendor"
          value={vendor}
          onChange={onChangeVendor}
          placeholder="EPB"
        />
        <ContextField
          label="Property"
          value={property}
          onChange={onChangeProperty}
          placeholder="ADM"
        />
        <ContextField
          label="GL"
          value={gl}
          onChange={onChangeGl}
          placeholder="6915"
        />
      </div>
    </section>
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
  docMetadataJson,
  runtimeOptionsJson,
  jsonErrors,
  onChangeFacts,
  onChangeHints,
  onChangeDocMetadata,
  onChangeRuntimeOptions,
}: {
  open: boolean;
  onToggle: () => void;
  factsJson: string;
  hintsJson: string;
  docMetadataJson: string;
  runtimeOptionsJson: string;
  jsonErrors: {
    facts?: string;
    hints?: string;
    document_metadata?: string;
    runtime_options?: string;
  };
  onChangeFacts: (v: string) => void;
  onChangeHints: (v: string) => void;
  onChangeDocMetadata: (v: string) => void;
  onChangeRuntimeOptions: (v: string) => void;
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
          Optional · facts (object or list) / hints / document_metadata / runtime_options
        </span>
      </button>
      {open && (
        <div className="border-t border-gray-100 px-3 py-3 space-y-3 dark:border-line/60">
          <JsonField
            label="extracted_facts (JSON object — merges on top of quick fields — or list of ExtractedFact)"
            placeholder={
              '{ "invoice_number": "ABC", "amount": "99.50" }\n— or —\n[{ "field_key": "invoice_number", "value": "ABC", "source_type": "ocr", "confidence": 0.92 }]'
            }
            value={factsJson}
            onChange={onChangeFacts}
            error={jsonErrors.facts}
          />
          <JsonField
            label="catalog_hints (JSON object — merges on top of quick hints)"
            placeholder={'{ "vendor": "EPB", "property": { "text": "ADM" } }'}
            value={hintsJson}
            onChange={onChangeHints}
            error={jsonErrors.hints}
          />
          <JsonField
            label="document_metadata (JSON object — caller cannot spoof bridge / operational keys)"
            placeholder={'{ "preview_label": "Q3 review" }'}
            value={docMetadataJson}
            onChange={onChangeDocMetadata}
            error={jsonErrors.document_metadata}
          />
          <JsonField
            label="runtime_options (JSON object)"
            placeholder={'{ "scenario_label": "edge_case_1" }'}
            value={runtimeOptionsJson}
            onChange={onChangeRuntimeOptions}
            error={jsonErrors.runtime_options}
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
// Result — Operational summary card
// ---------------------------------------------------------------------------

function OperationalSummaryCard({
  result,
}: {
  result: OperationalResolutionResult;
}) {
  const summary = result.operational_summary;
  const status = String(summary.status);
  const meta =
    RESOLVER_STATUS_META[status] ?? RESOLVER_STATUS_META.needs_review;
  const Icon = meta.Icon;
  const cards = [
    { label: "Rows", value: summary.row_count },
    { label: "Ready", value: summary.ready_rows },
    { label: "Needs review", value: summary.needs_review_rows },
    { label: "Blocked", value: summary.blocked_rows },
    { label: "Conflict", value: summary.conflict_rows },
    { label: "Errors", value: summary.error_count },
    { label: "Warnings", value: summary.warning_count },
    { label: "Info", value: summary.info_count },
    { label: "Facts", value: summary.extracted_fact_count },
    { label: "Hints", value: summary.catalog_hint_count },
    { label: "Missing required", value: summary.missing_required_count },
    { label: "Missing facts", value: summary.missing_fact_count },
    { label: "Missing hints", value: summary.missing_catalog_hint_count },
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
              {result.document_id ? ` · doc ${result.document_id}` : ""}
              {result.batch_id ? ` · batch ${result.batch_id}` : ""}
            </div>
          </div>
        </div>
        {summary.diagnostic_only && (
          <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
            <BadgeIcon className="h-3 w-3" />
            Diagnostic only
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
// Result — Review diagnostics
// ---------------------------------------------------------------------------

function ReviewDiagnosticsSection({
  diagnostics,
}: {
  diagnostics: OperationalReviewDiagnostic[];
}) {
  if (!diagnostics || diagnostics.length === 0) {
    return (
      <section className="rounded-md border border-green-200 bg-green-50/60 px-3 py-2 text-xs text-green-800 dark:border-green-900 dark:bg-green-950/20 dark:text-green-200">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          <span>
            No review diagnostics. Resolver output is ready or
            advisory-only.
          </span>
        </div>
      </section>
    );
  }
  // Sort: blocked → warning → info → ready → unknown.
  const SORT: Record<string, number> = {
    blocked: 0,
    warning: 1,
    info: 2,
    ready: 3,
  };
  const sorted = [...diagnostics].sort((a, b) => {
    const ra = SORT[String(a.severity)] ?? 4;
    const rb = SORT[String(b.severity)] ?? 4;
    return ra - rb;
  });

  return (
    <section
      className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle"
      aria-label="Review diagnostics"
    >
      <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
          <Bookmark className="h-4 w-4 text-brand-600 dark:text-brand-50" />
          Review diagnostics
        </div>
        <span className="text-xs font-semibold text-gray-500 dark:text-ink-muted">
          {sorted.length}
        </span>
      </header>
      <ul className="divide-y divide-gray-100 dark:divide-line/60">
        {sorted.map((d, idx) => (
          <DiagnosticRow key={`${d.code ?? "uncoded"}-${idx}`} diagnostic={d} />
        ))}
      </ul>
    </section>
  );
}

function DiagnosticRow({
  diagnostic,
}: {
  diagnostic: OperationalReviewDiagnostic;
}) {
  const severity = (
    ["ready", "info", "warning", "blocked"].includes(String(diagnostic.severity))
      ? (diagnostic.severity as "ready" | "info" | "warning" | "blocked")
      : "warning"
  ) as "ready" | "info" | "warning" | "blocked";
  const visual = REVIEW_SEVERITY_VISUAL[severity];
  const fixArea =
    (diagnostic.fix_area as OperationalReviewFixArea) ?? "unknown";
  const fixLabel = FIX_AREA_LABEL[String(fixArea)] ?? String(fixArea);

  return (
    <li className="px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <visual.Icon
          className={cn("h-3.5 w-3.5 shrink-0 mt-0.5", visual.iconClass)}
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-gray-900 dark:text-ink">
            {diagnostic.message}
          </p>
          {diagnostic.recommendation && (
            <p className="mt-0.5 text-gray-700 dark:text-ink-muted">
              <Info className="inline h-3 w-3 mr-1 -mt-0.5" />
              {diagnostic.recommendation}
            </p>
          )}
          <div className="mt-1 flex items-center gap-1 flex-wrap">
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                visual.chip,
              )}
            >
              {severity}
            </span>
            <span
              className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted"
              title={`Fix area: ${fixLabel}`}
            >
              {fixLabel}
            </span>
            {diagnostic.column_name && (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                column: {diagnostic.column_name}
              </span>
            )}
            {diagnostic.code && (
              <span className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gray-500 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                {diagnostic.code}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Result — Resolver Input preview (collapsed by default)
// ---------------------------------------------------------------------------

function ResolverInputCard({
  result,
}: {
  result: OperationalResolutionResult;
}) {
  const [open, setOpen] = useState(false);
  const facts = result.resolver_input.extracted_facts ?? [];
  const hints = result.resolver_input.catalog_hints ?? {};
  const metadata = result.resolver_input.document_metadata ?? {};
  const runtimeOptions = result.resolver_input.runtime_options ?? {};

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
          Resolver input (what the pipeline received)
        </div>
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          {facts.length} fact{facts.length === 1 ? "" : "s"} ·{" "}
          {Object.keys(hints).length} hint
          {Object.keys(hints).length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="px-3 py-2 space-y-3">
          {/* Facts */}
          <div>
            <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
              Extracted facts
            </p>
            {facts.length === 0 ? (
              <p className="mt-1 text-[11px] text-gray-500 dark:text-ink-muted">
                No facts in this preview.
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

          {/* Hints */}
          <div>
            <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
              Catalog hints
            </p>
            {Object.keys(hints).length === 0 ? (
              <p className="mt-1 text-[11px] text-gray-500 dark:text-ink-muted">
                No catalog hints provided.
              </p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-[11px]">
                {Object.entries(hints).map(([kind, hint]) => (
                  <li key={kind} className="font-mono">
                    <span className="text-gray-500 dark:text-ink-muted">
                      {kind}:
                    </span>{" "}
                    <span className="text-gray-800 dark:text-ink">
                      {hint.text ?? hint.entry_id ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Metadata */}
          <div>
            <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
              Document metadata
            </p>
            {Object.keys(metadata).length === 0 ? (
              <p className="mt-1 text-[11px] text-gray-500 dark:text-ink-muted">
                (empty)
              </p>
            ) : (
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                {Object.entries(metadata).map(([key, value]) => (
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

          {/* Runtime options */}
          {Object.keys(runtimeOptions).length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
                Runtime options
              </p>
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                {Object.entries(runtimeOptions).map(([key, value]) => (
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
            </div>
          )}

          {/* Operational ids — explicit so they're visible at a
              glance even if the metadata block is long. */}
          <div className="text-[11px] text-gray-700 dark:text-ink-muted">
            <span className="font-semibold">document_id:</span>{" "}
            {result.resolver_input.document_id ?? "—"}{" "}
            <span className="ml-3 font-semibold">batch_id:</span>{" "}
            {result.resolver_input.batch_id ?? "—"}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Result — Resolver Result preview
// ---------------------------------------------------------------------------

function ResolverResultCard({
  result,
}: {
  result: OperationalResolutionResult;
}) {
  const rows = result.resolver_result.rows ?? [];
  const issues = result.resolver_result.issues ?? [];
  return (
    <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
      <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
          Resolver result
        </div>
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          {rows.length} row{rows.length === 1 ? "" : "s"} · {issues.length}{" "}
          issue{issues.length === 1 ? "" : "s"}
        </span>
      </header>
      <div className="divide-y divide-gray-100 dark:divide-line/60">
        {rows.length === 0 && (
          <p className="px-3 py-3 text-xs text-gray-500 dark:text-ink-muted">
            The resolver returned no rows.
          </p>
        )}
        {rows.map((row) => (
          <ResolvedRowBlock key={row.row_index} row={row} />
        ))}
      </div>
      {issues.length > 0 && <IssuesBlock issues={issues} />}
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
      {cells.length === 0 ? (
        <p className="text-[11px] text-gray-500 dark:text-ink-muted">
          No cells in this row.
        </p>
      ) : (
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
      )}
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

function IssuesBlock({ issues }: { issues: ResolverIssue[] }) {
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
    <div className="border-t border-gray-100 dark:border-line/60 px-3 py-2 space-y-2">
      {(["error", "warning", "info"] as ResolverSeverity[]).map((sev) => {
        const items = groups[sev];
        if (items.length === 0) return null;
        return (
          <div key={sev}>
            <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
              {sev}s ({items.length})
            </p>
            <ul className="mt-1 space-y-1">
              {items.map((issue, idx) => (
                <li
                  key={`${issue.code}-${idx}`}
                  className="rounded border border-gray-200 px-2 py-1 text-xs dark:border-line"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-gray-800 dark:text-ink">
                      {issue.message}
                    </p>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Operational note (footer)
// ---------------------------------------------------------------------------

function OperationalNoteCard() {
  return (
    <p className="text-[11px] text-gray-500 dark:text-ink-muted">
      <Info className="inline h-3 w-3 mr-1 -mt-0.5" />
      This preview does not create Review Queue items or exports.
      Future phases will use this same envelope to create review-ready
      records.
    </p>
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
