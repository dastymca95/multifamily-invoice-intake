"use client";

import {
  AlertTriangle,
  Badge as BadgeIcon,
  Bookmark,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardCopy,
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

import {
  SEVERITY_LABEL,
  buildOperationalDiagnosticCards,
  groupOperationalDiagnosticCards,
  summarizeOperationalDiagnosticCards,
  type NormalizedFixArea,
  type NormalizedSeverity,
  type OperationalDiagnosticCard,
} from "../lib/operational-review-diagnostics";
import {
  buildOperationalDiagnosticsMarkdownReport,
  copyTextToClipboard,
} from "../lib/operational-review-reports";
import {
  buildOperationalExportPreview,
  type ExportPreviewRowStatus,
  type OperationalExportPreview,
  type OperationalExportPreviewCell,
  type OperationalExportPreviewRow,
} from "../lib/operational-export-preview";
import { buildOperationalExportPreviewMarkdownReport } from "../lib/operational-export-preview-reports";
import {
  getBuiltInExportProfiles,
  type ExportProfile,
} from "../lib/export-profile-contract";
import {
  validateExportPreviewAgainstProfile,
  type ExportProfileIssueSeverity,
  type ExportProfileValidationResult,
} from "../lib/export-profile-validation";
import { buildExportProfileValidationMarkdownReport } from "../lib/export-profile-reports";

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
  // ---- Phase 3C — document/batch operational bridge ----------
  /**
   * Operator can still edit any of these once the panel is open;
   * the values are applied on the open transition (false → true)
   * and re-applied if the panel is closed and reopened with new
   * context. While the panel stays open with the same context,
   * the operator's edits are preserved.
   */
  initialDocumentId?: string | null;
  initialBatchId?: string | null;
  /** Mapping of canonical field key → value, e.g. extracted invoice
   *  facts captured during Review. Empty / null entries are skipped
   *  on hydrate. Quick fields ONLY — keys that aren't in the panel's
   *  built-in quick-field set still flow into the request payload
   *  via the pre-filled JSON editor. */
  initialExtractedFacts?: Record<string, unknown>;
  /** Mapping of vendor / property / gl hint → string. Other kinds /
   *  structured shapes are ignored on hydrate. */
  initialCatalogHints?: Record<string, unknown>;
  /** Caller metadata merged into the request's ``document_metadata``
   *  alongside the operator's own JSON edits. The operator's
   *  ``document_metadata`` JSON wins on key collision so they can
   *  always override. */
  initialDocumentMetadata?: Record<string, unknown>;
  /** Short label for the context banner — e.g. ``"Document: epb-march.pdf"``
   *  or ``"Batch: April 2026 Utilities"``. */
  launchContextLabel?: string;
  /** Optional one-line note shown below the context label. */
  contextNotice?: string;
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
  initialDocumentId,
  initialBatchId,
  initialExtractedFacts,
  initialCatalogHints,
  initialDocumentMetadata,
  launchContextLabel,
  contextNotice,
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

  // ---- Phase 3C — context-derived metadata --------------------
  // Captured from ``initialDocumentMetadata`` on open; merged into
  // the request payload alongside the operator's JSON edits (the
  // operator's JSON wins on key collision so they can override).
  const [contextDocumentMetadata, setContextDocumentMetadata] = useState<
    Record<string, unknown>
  >({});

  // ---- Race-protected request id -------------------------------
  const runRequestIdRef = useRef(0);
  const runAbortRef = useRef<AbortController | null>(null);

  // ---- Phase 3D — section refs for "focus input" assistance ----
  // Each diagnostic card with a fix area like extracted_fact /
  // catalog_hint / runtime_context can offer a button that scrolls
  // the relevant input section into view. Refs are wired on the
  // wrapper divs below so the section components themselves stay
  // unchanged.
  const factsSectionRef = useRef<HTMLDivElement | null>(null);
  const hintsSectionRef = useRef<HTMLDivElement | null>(null);
  const contextSectionRef = useRef<HTMLDivElement | null>(null);

  // ---- Phase 3D — copy-diagnostics transient toast ------------
  const [diagnosticsCopyStatus, setDiagnosticsCopyStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const diagnosticsCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // ---- Phase 3E — copy-export-preview transient toast ---------
  // Separate from diagnosticsCopyStatus so the two surfaces never
  // overwrite each other's confirmation ("Diagnostics copied" vs
  // "Preview copied").
  const [exportCopyStatus, setExportCopyStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const exportCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // ---- Phase 3E — "Show only issues" filter toggle ------------
  const [exportShowOnlyIssues, setExportShowOnlyIssues] = useState(false);

  // ---- Phase 3F — Export Profile selection + copy toast --------
  // Stored separately from the preview-copy toast so the two
  // surfaces never overwrite each other's confirmation.
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    null,
  );
  const [profileCopyStatus, setProfileCopyStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const profileCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // ---- Phase 3C — apply launch context on open transition -----
  // Re-applies whenever the panel transitions from closed → open OR
  // when the launch identity changes while open. Operator edits
  // mid-panel are preserved as long as the identity stays the same.
  // Tracks the last-applied identity so re-renders with stable
  // initial props don't blow away in-progress edits.
  const lastAppliedContextRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen) {
      lastAppliedContextRef.current = null;
      return;
    }
    const contextKey = [
      initialDocumentId ?? "",
      initialBatchId ?? "",
      launchContextLabel ?? "",
    ].join("::");
    if (lastAppliedContextRef.current === contextKey) return;
    lastAppliedContextRef.current = contextKey;

    // Document / batch ids — empty string when caller didn't supply.
    setDocumentId(initialDocumentId ?? "");
    setBatchId(initialBatchId ?? "");

    // Quick facts — only canonical fields the panel renders inputs
    // for. Unknown keys are dropped here (caller can put them in
    // initialDocumentMetadata if they want them on the request).
    const knownQuickKeys = new Set(QUICK_FACT_FIELDS.map((f) => f.key));
    if (initialExtractedFacts) {
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(initialExtractedFacts)) {
        if (!knownQuickKeys.has(key)) continue;
        if (value === null || value === undefined) continue;
        const text = String(value).trim();
        if (!text) continue;
        next[key] = text;
      }
      setQuickFacts(next);
    } else {
      setQuickFacts({});
    }

    // Hints — only string values for vendor/property/gl flow into
    // the quick fields.
    if (initialCatalogHints) {
      const v = initialCatalogHints.vendor;
      const p = initialCatalogHints.property;
      const g = initialCatalogHints.gl;
      setVendorHint(typeof v === "string" ? v : "");
      setPropertyHint(typeof p === "string" ? p : "");
      setGlHint(typeof g === "string" ? g : "");
    } else {
      setVendorHint("");
      setPropertyHint("");
      setGlHint("");
    }

    // Caller-side metadata — held in state, merged into the payload
    // at request time. Operator's advanced JSON wins on collision.
    setContextDocumentMetadata(
      initialDocumentMetadata ? { ...initialDocumentMetadata } : {},
    );
  }, [
    isOpen,
    initialDocumentId,
    initialBatchId,
    initialExtractedFacts,
    initialCatalogHints,
    initialDocumentMetadata,
    launchContextLabel,
  ]);

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

    // Merge document_metadata. Order (lowest → highest precedence):
    //   1. preview_label (always wins over the caller's launch
    //      context if both happen to set the same key)
    //   2. caller-side launch context (Phase 3C — preset by the
    //      document/batch surface)
    //   3. operator's advanced JSON edits — wins on every key
    //      collision so operators can always override
    // Backend strips its own protected keys before merging into the
    // bridge / operational layers, so spoofing isn't a concern here.
    const docMetadata: Record<string, unknown> = {};
    if (previewLabel.trim()) {
      docMetadata.preview_label = previewLabel.trim();
    }
    if (
      contextDocumentMetadata &&
      Object.keys(contextDocumentMetadata).length > 0
    ) {
      Object.assign(docMetadata, contextDocumentMetadata);
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

  // ---- Phase 3D — focus / scroll helpers + copy diagnostics ---

  const showDiagnosticsCopyStatus = useCallback(
    (type: "success" | "error", message: string) => {
      setDiagnosticsCopyStatus({ type, message });
      if (diagnosticsCopyTimerRef.current) {
        clearTimeout(diagnosticsCopyTimerRef.current);
      }
      diagnosticsCopyTimerRef.current = setTimeout(() => {
        setDiagnosticsCopyStatus(null);
        diagnosticsCopyTimerRef.current = null;
      }, 4000);
    },
    [],
  );

  // Phase 3E — separate transient toast for the export preview's
  // "Copy preview" action. Same auto-clear semantics as the
  // diagnostics toast.
  const showExportCopyStatus = useCallback(
    (type: "success" | "error", message: string) => {
      setExportCopyStatus({ type, message });
      if (exportCopyTimerRef.current) {
        clearTimeout(exportCopyTimerRef.current);
      }
      exportCopyTimerRef.current = setTimeout(() => {
        setExportCopyStatus(null);
        exportCopyTimerRef.current = null;
      }, 4000);
    },
    [],
  );

  // Phase 3F — separate transient toast for the export-profile
  // "Copy profile check" action.
  const showProfileCopyStatus = useCallback(
    (type: "success" | "error", message: string) => {
      setProfileCopyStatus({ type, message });
      if (profileCopyTimerRef.current) {
        clearTimeout(profileCopyTimerRef.current);
      }
      profileCopyTimerRef.current = setTimeout(() => {
        setProfileCopyStatus(null);
        profileCopyTimerRef.current = null;
      }, 4000);
    },
    [],
  );

  // Clear the toasts on panel close so they don't settle onto an
  // unmounted view.
  useEffect(() => {
    if (!isOpen && diagnosticsCopyTimerRef.current) {
      clearTimeout(diagnosticsCopyTimerRef.current);
      diagnosticsCopyTimerRef.current = null;
      setDiagnosticsCopyStatus(null);
    }
    if (!isOpen && exportCopyTimerRef.current) {
      clearTimeout(exportCopyTimerRef.current);
      exportCopyTimerRef.current = null;
      setExportCopyStatus(null);
    }
    if (!isOpen && profileCopyTimerRef.current) {
      clearTimeout(profileCopyTimerRef.current);
      profileCopyTimerRef.current = null;
      setProfileCopyStatus(null);
    }
  }, [isOpen]);

  const handleFocusSection = useCallback(
    (target: "facts" | "hints" | "context") => {
      const ref =
        target === "facts"
          ? factsSectionRef
          : target === "hints"
            ? hintsSectionRef
            : contextSectionRef;
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [],
  );

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

        {/* ---- Phase 3C — launch context banner --------------- */}
        {launchContextLabel && (
          <LaunchContextBanner
            label={launchContextLabel}
            notice={contextNotice}
            documentId={initialDocumentId ?? null}
            batchId={initialBatchId ?? null}
            extractedFactsCount={
              initialExtractedFacts
                ? Object.values(initialExtractedFacts).filter(
                    (v) =>
                      v !== null && v !== undefined && String(v).trim() !== "",
                  ).length
                : 0
            }
          />
        )}

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
        {/* Phase 3D — wrap in a ref-bearing div so the diagnostic
            "Edit context" button can scroll the section into view. */}
        <div ref={contextSectionRef}>
          <OperationalContextSection
            documentId={documentId}
            batchId={batchId}
            previewLabel={previewLabel}
            onChangeDocumentId={setDocumentId}
            onChangeBatchId={setBatchId}
            onChangePreviewLabel={setPreviewLabel}
          />
        </div>

        {/* ---- Manual extracted facts ------------------------- */}
        <div ref={factsSectionRef}>
          <ManualFactsSection
            quickFacts={quickFacts}
            onChange={(key, value) =>
              setQuickFacts((curr) => ({ ...curr, [key]: value }))
            }
          />
        </div>

        {/* ---- Manual catalog hints --------------------------- */}
        <div ref={hintsSectionRef}>
          <ManualHintsSection
            vendor={vendorHint}
            property={propertyHint}
            gl={glHint}
            onChangeVendor={setVendorHint}
            onChangeProperty={setPropertyHint}
            onChangeGl={setGlHint}
          />
        </div>

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
            {/* Phase 3D — replaced the old simple list with the
                review-style grouped cards + summary + copy. The
                section preserves backend code/message/recommendation
                inside each card so support / debugging are unchanged. */}
            <OperationalReviewSection
              result={result}
              contextLabel={launchContextLabel ?? null}
              copyStatus={diagnosticsCopyStatus}
              onCopyStatus={showDiagnosticsCopyStatus}
              onFocusSection={handleFocusSection}
            />
            {/* Phase 3E — Export-style Rows Preview. Diagnostic-only
                visualisation of how the resolver_result rows would
                look as future export rows. Sits ABOVE the technical
                Resolver Result section so operators see the cleaner
                layout first; the technical view stays for debugging. */}
            <ExportPreviewSection
              result={result}
              contextLabel={launchContextLabel ?? null}
              copyStatus={exportCopyStatus}
              onCopyStatus={showExportCopyStatus}
              showOnlyIssues={exportShowOnlyIssues}
              onToggleShowOnlyIssues={() =>
                setExportShowOnlyIssues((v) => !v)
              }
              // Phase 3F — Export Profile selector + validation
              // sit inside the same section so the operator
              // mental-models them as part of the export-style
              // preview rather than a separate surface.
              selectedProfileId={selectedProfileId}
              onSelectProfileId={setSelectedProfileId}
              profileCopyStatus={profileCopyStatus}
              onProfileCopyStatus={showProfileCopyStatus}
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
// Phase 3C — Launch context banner
// ---------------------------------------------------------------------------

function LaunchContextBanner({
  label,
  notice,
  documentId,
  batchId,
  extractedFactsCount,
}: {
  label: string;
  notice?: string;
  documentId: string | null;
  batchId: string | null;
  extractedFactsCount: number;
}) {
  return (
    <div className="rounded-md border border-cyan-200 bg-cyan-50/60 px-3 py-2 text-xs text-cyan-900 dark:border-cyan-900 dark:bg-cyan-950/20 dark:text-cyan-100">
      <p className="font-semibold">{label}</p>
      <p className="mt-0.5 text-cyan-800 dark:text-cyan-200">
        {notice ??
          (extractedFactsCount > 0
            ? `Pre-filled with ${extractedFactsCount} extracted fact${extractedFactsCount === 1 ? "" : "s"}. You can edit any value below before running.`
            : "No extracted facts are available for this context yet — enter facts manually below to test the resolver.")}
      </p>
      {(documentId || batchId) && (
        <p className="mt-1 font-mono text-[10px] text-cyan-700 dark:text-cyan-300">
          {documentId ? `document_id: ${documentId}` : ""}
          {documentId && batchId ? "  ·  " : ""}
          {batchId ? `batch_id: ${batchId}` : ""}
        </p>
      )}
      <p className="mt-1 text-[11px] text-cyan-700 dark:text-cyan-300">
        Diagnostic only — this will not update the document, create
        review items, or export rows.
      </p>
    </div>
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
// Phase 3D — Operational Review section (replaces the old simple list)
// ---------------------------------------------------------------------------
//
// Renders the operational diagnostics as review-style cards grouped
// by severity (blocked → warning → info → ready). Includes:
//   * a summary card (counts + top fix area + first recommended action)
//   * a "Copy diagnostics" Markdown action
//   * per-card "Edit facts / hints / context" focus buttons that
//     scroll the relevant input section into view (Phase 3D
//     intentionally stops short of auto-applying fixes)
//   * an empty state for runs that produce no diagnostics

const FIX_AREA_CHIP_CLASSES: Record<NormalizedFixArea, string> = {
  extracted_fact:
    "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-200 dark:border-blue-900",
  catalog_hint:
    "bg-cyan-50 text-cyan-800 border-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-200 dark:border-cyan-900",
  reference_data:
    "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/30 dark:text-orange-200 dark:border-orange-900",
  import_template:
    "bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-950/30 dark:text-purple-200 dark:border-purple-900",
  invoice_pattern:
    "bg-cyan-50 text-cyan-800 border-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-200 dark:border-cyan-900",
  runtime_context:
    "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-200 dark:border-yellow-900",
  unknown:
    "bg-gray-100 text-gray-700 border-gray-200 dark:bg-surface-muted dark:text-ink-muted dark:border-line",
};

function OperationalReviewSection({
  result,
  contextLabel,
  copyStatus,
  onCopyStatus,
  onFocusSection,
}: {
  result: OperationalResolutionResult;
  contextLabel: string | null;
  copyStatus: { type: "success" | "error"; message: string } | null;
  onCopyStatus: (type: "success" | "error", message: string) => void;
  onFocusSection: (target: "facts" | "hints" | "context") => void;
}) {
  const cards = useMemo(
    () => buildOperationalDiagnosticCards(result.review_diagnostics ?? []),
    [result.review_diagnostics],
  );
  const summary = useMemo(
    () => summarizeOperationalDiagnosticCards(cards),
    [cards],
  );
  const groups = useMemo(
    () => groupOperationalDiagnosticCards(cards),
    [cards],
  );

  const handleCopy = useCallback(async () => {
    try {
      const text = buildOperationalDiagnosticsMarkdownReport({
        result,
        cards,
        contextLabel,
      });
      await copyTextToClipboard(text);
      onCopyStatus("success", "Diagnostics copied.");
    } catch (err) {
      onCopyStatus(
        "error",
        `Could not copy diagnostics: ${(err as Error).message}`,
      );
    }
  }, [result, cards, contextLabel, onCopyStatus]);

  // Empty state — careful wording per spec: do NOT claim
  // production-ready. Future export readiness still depends on the
  // production export phase.
  if (cards.length === 0) {
    return (
      <section
        className="rounded-md border border-green-200 bg-green-50/60 px-3 py-3 dark:border-green-900 dark:bg-green-950/20"
        aria-label="Review diagnostics"
      >
        <div className="flex items-start gap-2 text-xs text-green-800 dark:text-green-200">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">No review diagnostics found.</p>
            <p className="mt-0.5">
              This diagnostic preview did not produce exceptions.
              Future export readiness still depends on the final
              export phase.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3" aria-label="Operational Review diagnostics">
      {/* ---- Summary card + copy ----------------------------- */}
      <div className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
        <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-ink">
            <Bookmark className="h-4 w-4 text-brand-600 dark:text-brand-50" />
            Operational Review summary
          </div>
          <div className="flex items-center gap-2">
            {copyStatus && (
              <span
                className={cn(
                  "text-[11px] font-medium",
                  copyStatus.type === "success"
                    ? "text-green-700 dark:text-green-300"
                    : "text-red-700 dark:text-red-300",
                )}
                role={copyStatus.type === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {copyStatus.message}
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              title="Copy a Markdown summary of these diagnostics to the clipboard (support / debugging)."
            >
              <ClipboardCopy className="h-3.5 w-3.5" />
              Copy diagnostics
            </Button>
          </div>
        </header>
        <div className="px-3 py-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <SummaryCount
            label="Total"
            value={summary.total}
            tone="text-gray-800 dark:text-ink"
          />
          <SummaryCount
            label="Blocked"
            value={summary.blocked}
            tone="text-red-700 dark:text-red-200"
          />
          <SummaryCount
            label="Needs review"
            value={summary.warning}
            tone="text-yellow-700 dark:text-yellow-200"
          />
          <SummaryCount
            label="Info"
            value={summary.info}
            tone="text-blue-700 dark:text-blue-200"
          />
        </div>
        {(summary.top_fix_area_label || summary.first_recommended_action) && (
          <div className="px-3 pb-2 space-y-1 text-[11px] text-gray-700 dark:text-ink-muted">
            {summary.top_fix_area_label && (
              <p>
                <span className="font-semibold text-gray-800 dark:text-ink">
                  Top fix area:
                </span>{" "}
                {summary.top_fix_area_label}
              </p>
            )}
            {summary.first_recommended_action && (
              <p>
                <span className="font-semibold text-gray-800 dark:text-ink">
                  First recommended next step:
                </span>{" "}
                {summary.first_recommended_action}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ---- Grouped diagnostic cards ------------------------ */}
      <DiagnosticGroup
        severity="blocked"
        cards={groups.blocked}
        onFocusSection={onFocusSection}
      />
      <DiagnosticGroup
        severity="warning"
        cards={groups.warning}
        onFocusSection={onFocusSection}
      />
      <DiagnosticGroup
        severity="info"
        cards={groups.info}
        onFocusSection={onFocusSection}
      />
      <DiagnosticGroup
        severity="ready"
        cards={groups.ready}
        onFocusSection={onFocusSection}
      />
    </section>
  );
}

function SummaryCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="rounded border border-gray-200 bg-white px-2 py-1 dark:border-line dark:bg-surface-subtle">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
        {label}
      </p>
      <p className={cn("text-lg font-semibold", tone)}>{value}</p>
    </div>
  );
}

function DiagnosticGroup({
  severity,
  cards,
  onFocusSection,
}: {
  severity: NormalizedSeverity;
  cards: OperationalDiagnosticCard[];
  onFocusSection: (target: "facts" | "hints" | "context") => void;
}) {
  if (cards.length === 0) return null;
  // Severity groups have their own header tone — green for ready,
  // amber for warning, red for blocked, blue for info. Matches the
  // SaaS palette already used elsewhere in the panel.
  const headerClasses =
    severity === "blocked"
      ? "border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20"
      : severity === "warning"
        ? "border-yellow-200 bg-yellow-50/60 dark:border-yellow-900 dark:bg-yellow-950/20"
        : severity === "info"
          ? "border-blue-200 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/20"
          : "border-green-200 bg-green-50/60 dark:border-green-900 dark:bg-green-950/20";
  return (
    <section
      className={cn("rounded-md border", headerClasses)}
      aria-label={SEVERITY_LABEL[severity]}
    >
      <header className="flex items-center justify-between gap-3 border-b border-gray-100/70 px-3 py-2 dark:border-line/60">
        <p className="text-sm font-semibold text-gray-900 dark:text-ink">
          {SEVERITY_LABEL[severity]}
        </p>
        <span className="text-xs font-semibold text-gray-500 dark:text-ink-muted">
          {cards.length}
        </span>
      </header>
      <ul className="divide-y divide-gray-100/70 dark:divide-line/60">
        {cards.map((card) => (
          <li key={card.id} className="px-3 py-3">
            <DiagnosticCardView card={card} onFocusSection={onFocusSection} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DiagnosticCardView({
  card,
  onFocusSection,
}: {
  card: OperationalDiagnosticCard;
  onFocusSection: (target: "facts" | "hints" | "context") => void;
}) {
  const visual = REVIEW_SEVERITY_VISUAL[card.severity];
  const fixChip = FIX_AREA_CHIP_CLASSES[card.fix_area];

  // Map the fix area to a focus target — only three of the six are
  // reachable inside this panel. The others (import_template /
  // invoice_pattern / unknown) get a small note explaining where
  // to fix instead of a button.
  const focusTarget: "facts" | "hints" | "context" | null =
    card.fix_area === "extracted_fact"
      ? "facts"
      : card.fix_area === "catalog_hint" ||
          card.fix_area === "reference_data"
        ? "hints"
        : card.fix_area === "runtime_context"
          ? "context"
          : null;

  const focusLabel: string | null =
    focusTarget === "facts"
      ? "Edit facts"
      : focusTarget === "hints"
        ? "Edit hints"
        : focusTarget === "context"
          ? "Edit context"
          : null;

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-start gap-2">
        <visual.Icon
          className={cn("h-4 w-4 shrink-0 mt-0.5", visual.iconClass)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-900 dark:text-ink">
              {card.title}
            </p>
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                visual.chip,
              )}
            >
              {card.severity}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                fixChip,
              )}
              title={`Fix area: ${card.fix_area_label}`}
            >
              {card.fix_area_label}
            </span>
            {(card.column_name || card.column_id) && (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                column: {card.column_name ?? card.column_id}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pl-6">
        <DiagnosticDetail label="What happened" body={card.what_happened} />
        <DiagnosticDetail label="Why it matters" body={card.why_it_matters} />
        <DiagnosticDetail label="Where to fix" body={card.where_to_fix} />
        <DiagnosticDetail
          label="Recommended next step"
          body={card.recommended_action}
        />
      </div>

      <div className="pl-6 flex items-center gap-2 flex-wrap">
        {focusTarget && focusLabel && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onFocusSection(focusTarget)}
            title={`Scroll the ${focusLabel.toLowerCase()} section into view above.`}
          >
            {focusLabel}
          </Button>
        )}
        {card.fix_area === "import_template" && (
          <span className="text-[11px] text-gray-600 dark:text-ink-muted">
            Open Import Builder column setup to adjust this template.
          </span>
        )}
        {card.fix_area === "invoice_pattern" && (
          <span className="text-[11px] text-gray-600 dark:text-ink-muted">
            Open Invoice Builder to adjust this pattern's regions or
            field definitions.
          </span>
        )}
        {card.backend_code && (
          <span className="ml-auto rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gray-500 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
            {card.backend_code}
          </span>
        )}
      </div>

      {/* Show the backend message verbatim when our operator-friendly
          template's "what_happened" doesn't already use it — keeps
          the source of truth visible for support / debugging without
          duplicating identical copy. */}
      {card.raw_message && card.raw_message !== card.what_happened && (
        <div className="pl-6">
          <p className="text-[11px] text-gray-600 dark:text-ink-muted">
            <span className="font-semibold text-gray-700 dark:text-ink">
              Backend message:
            </span>{" "}
            {card.raw_message}
          </p>
        </div>
      )}
      {card.raw_recommendation &&
        card.raw_recommendation !== card.recommended_action && (
          <div className="pl-6">
            <p className="text-[11px] text-gray-600 dark:text-ink-muted">
              <span className="font-semibold text-gray-700 dark:text-ink">
                Backend recommendation:
              </span>{" "}
              {card.raw_recommendation}
            </p>
          </div>
        )}
    </div>
  );
}

function DiagnosticDetail({
  label,
  body,
}: {
  label: string;
  body: string;
}) {
  return (
    <div className="rounded border border-gray-100 px-2 py-1.5 dark:border-line/60">
      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
        {label}
      </p>
      <p className="mt-0.5 text-[11px] text-gray-800 dark:text-ink">
        {body}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 3E — Export-style Rows Preview section
// ---------------------------------------------------------------------------
//
// Renders the resolver_result rows in a table that resembles the
// future export/import spreadsheet layout. Diagnostic-only —
// every label and copy avoids "production / export ready" wording
// per spec. Status chips and missing-value markers come from the
// pure ``operational-export-preview`` utility; this component is
// pure presentation.

const EXPORT_ROW_STATUS_LABEL: Record<ExportPreviewRowStatus, string> = {
  clear: "Clear",
  needs_review: "Needs review",
  blocked: "Blocked",
  conflict: "Conflict",
};

const EXPORT_ROW_STATUS_CHIP: Record<ExportPreviewRowStatus, string> = {
  clear:
    "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900",
  needs_review:
    "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900",
  blocked:
    "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
  conflict:
    "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-200 dark:border-orange-900",
};

const EXPORT_ROW_TONE: Record<ExportPreviewRowStatus, string> = {
  clear: "",
  needs_review:
    "bg-yellow-50/40 dark:bg-yellow-950/10",
  blocked: "bg-red-50/40 dark:bg-red-950/10",
  conflict: "bg-orange-50/40 dark:bg-orange-950/10",
};

function ExportPreviewSection({
  result,
  contextLabel,
  copyStatus,
  onCopyStatus,
  showOnlyIssues,
  onToggleShowOnlyIssues,
  selectedProfileId,
  onSelectProfileId,
  profileCopyStatus,
  onProfileCopyStatus,
}: {
  result: OperationalResolutionResult;
  contextLabel: string | null;
  copyStatus: { type: "success" | "error"; message: string } | null;
  onCopyStatus: (type: "success" | "error", message: string) => void;
  showOnlyIssues: boolean;
  onToggleShowOnlyIssues: () => void;
  // Phase 3F — profile-check plumbing.
  selectedProfileId: string | null;
  onSelectProfileId: (id: string | null) => void;
  profileCopyStatus: { type: "success" | "error"; message: string } | null;
  onProfileCopyStatus: (type: "success" | "error", message: string) => void;
}) {
  const preview = useMemo(
    () => buildOperationalExportPreview(result),
    [result],
  );

  // Phase 3F — built-in profile bundle, refreshed when the preview
  // changes (column inference flows through ``buildCustomCsvMirrorProfile``).
  const profiles = useMemo(
    () => getBuiltInExportProfiles(preview),
    [preview],
  );

  // Default to the first profile (Custom CSV mirror) on mount, and
  // fall back to it whenever the previously-selected profile is no
  // longer present in the rebuilt list.
  const effectiveProfileId = useMemo(() => {
    if (selectedProfileId && profiles.some((p) => p.id === selectedProfileId)) {
      return selectedProfileId;
    }
    return profiles[0]?.id ?? null;
  }, [selectedProfileId, profiles]);

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === effectiveProfileId) ?? null,
    [profiles, effectiveProfileId],
  );

  // Validation runs in a pure useMemo so it stays cheap on
  // re-renders that don't change the preview / profile.
  const validation = useMemo(
    () =>
      selectedProfile
        ? validateExportPreviewAgainstProfile(preview, selectedProfile)
        : null,
    [preview, selectedProfile],
  );

  const visibleRows = useMemo(
    () =>
      showOnlyIssues
        ? preview.rows.filter((r) => r.issue_count > 0 || r.blocked || r.warning)
        : preview.rows,
    [preview.rows, showOnlyIssues],
  );

  const handleCopy = useCallback(async () => {
    try {
      const text = buildOperationalExportPreviewMarkdownReport({
        result,
        preview,
        contextLabel,
      });
      await copyTextToClipboard(text);
      onCopyStatus("success", "Preview copied.");
    } catch (err) {
      onCopyStatus(
        "error",
        `Could not copy preview: ${(err as Error).message}`,
      );
    }
  }, [result, preview, contextLabel, onCopyStatus]);

  // Empty state — no rows OR no columns. Careful copy: do NOT
  // claim production-ready, just describe the diagnostic state.
  if (!preview.can_preview_export) {
    return (
      <section
        className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle"
        aria-label="Export-style rows preview"
      >
        <header className="flex items-start justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
          <div>
            <p className="text-sm font-semibold text-gray-800 dark:text-ink">
              Export-style Rows Preview
            </p>
            <p className="mt-0.5 text-[11px] text-gray-500 dark:text-ink-muted">
              Diagnostic preview only — no export file is generated.
            </p>
          </div>
        </header>
        <div className="px-3 py-3 text-xs text-gray-600 dark:text-ink-muted">
          <p className="font-medium text-gray-800 dark:text-ink">
            No resolved rows to preview yet.
          </p>
          <p className="mt-0.5">
            Run a preview with enough invoice facts and template
            rules to see export-style rows.
          </p>
        </div>
      </section>
    );
  }

  // Section banner tone — drives a thin coloured top stripe so
  // the worst severity is visible at a glance even before the
  // operator scrolls the table.
  const worst = preview.summary.worst_status ?? "clear";
  const sectionBorder =
    worst === "blocked"
      ? "border-red-200 dark:border-red-900"
      : worst === "conflict"
        ? "border-orange-200 dark:border-orange-900"
        : worst === "needs_review"
          ? "border-yellow-200 dark:border-yellow-900"
          : "border-green-200 dark:border-green-900";

  return (
    <section
      className={cn("rounded-md border bg-white dark:bg-surface-subtle", sectionBorder)}
      aria-label="Export-style rows preview"
    >
      <header className="flex items-start justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-line/60">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-800 dark:text-ink">
            Export-style Rows Preview
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500 dark:text-ink-muted">
            Diagnostic preview only — no export file is generated.
            Future export depends on export profiles and final
            validation.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {copyStatus && (
            <span
              className={cn(
                "text-[11px] font-medium",
                copyStatus.type === "success"
                  ? "text-green-700 dark:text-green-300"
                  : "text-red-700 dark:text-red-300",
              )}
              role={copyStatus.type === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {copyStatus.message}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            title="Copy a Markdown summary of these preview rows to the clipboard. No file is generated."
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
            Copy preview
          </Button>
        </div>
      </header>

      <div className="px-3 py-2 space-y-3">
        <ExportPreviewSummary preview={preview} />

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-[11px] text-gray-600 dark:text-ink-muted">
            {visibleRows.length === preview.rows.length
              ? `Showing all ${preview.rows.length} preview row${preview.rows.length === 1 ? "" : "s"}.`
              : `Showing ${visibleRows.length} of ${preview.rows.length} preview rows.`}
          </p>
          <label className="inline-flex items-center gap-1.5 text-[11px] text-gray-700 dark:text-ink-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showOnlyIssues}
              onChange={onToggleShowOnlyIssues}
              className="h-3 w-3"
            />
            Show only rows with issues
          </label>
        </div>

        {visibleRows.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-ink-muted px-2 py-3">
            {showOnlyIssues
              ? "No issue rows in this diagnostic preview."
              : "No resolved rows to preview yet."}
          </p>
        ) : (
          <ExportPreviewTable
            preview={preview}
            visibleRows={visibleRows}
          />
        )}

        {/* Phase 3F — Export Profile check. Lives inside the same
            section so the operator sees it as part of the same
            export-style preview rather than a separate surface. */}
        <ExportProfileCheckBlock
          result={result}
          preview={preview}
          contextLabel={contextLabel}
          profiles={profiles}
          selectedProfileId={effectiveProfileId}
          onSelectProfileId={onSelectProfileId}
          selectedProfile={selectedProfile}
          validation={validation}
          copyStatus={profileCopyStatus}
          onCopyStatus={onProfileCopyStatus}
        />
      </div>
    </section>
  );
}

function ExportPreviewSummary({
  preview,
}: {
  preview: OperationalExportPreview;
}) {
  const cards = [
    { label: "Rows", value: preview.row_count, tone: "text-gray-800 dark:text-ink" },
    { label: "Clear", value: preview.ready_row_count, tone: "text-green-700 dark:text-green-200" },
    { label: "Needs review", value: preview.warning_row_count, tone: "text-yellow-700 dark:text-yellow-200" },
    { label: "Blocked", value: preview.blocked_row_count, tone: "text-red-700 dark:text-red-200" },
    { label: "Conflict", value: preview.conflict_row_count, tone: "text-orange-700 dark:text-orange-200" },
    { label: "Columns", value: preview.summary.column_count, tone: "text-gray-800 dark:text-ink" },
    { label: "Cells with issues", value: preview.summary.cells_with_issues, tone: "text-yellow-700 dark:text-yellow-200" },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded border border-gray-200 bg-white px-2 py-1 dark:border-line dark:bg-surface-subtle"
        >
          <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
            {card.label}
          </p>
          <p className={cn("text-base font-semibold", card.tone)}>{card.value}</p>
        </div>
      ))}
    </div>
  );
}

function ExportPreviewTable({
  preview,
  visibleRows,
}: {
  preview: OperationalExportPreview;
  visibleRows: OperationalExportPreviewRow[];
}) {
  return (
    <div className="overflow-x-auto rounded border border-gray-200 dark:border-line">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 dark:bg-surface-muted">
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
            <th className="px-2 py-1.5">Row</th>
            <th className="px-2 py-1.5">Status</th>
            {preview.columns.map((col) => (
              <th key={col.key} className="px-2 py-1.5">
                <div className="flex items-center gap-1">
                  <span>{col.label}</span>
                  {col.has_issues && (
                    <span
                      className="inline-flex items-center justify-center rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-200 px-1 text-[10px] font-semibold"
                      title={`${col.issue_count} issue${col.issue_count === 1 ? "" : "s"} in this column`}
                    >
                      {col.issue_count}
                    </span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-line/60">
          {visibleRows.map((row) => (
            <tr key={row.row_index} className={cn(EXPORT_ROW_TONE[row.status])}>
              <td className="px-2 py-1.5 align-top font-medium text-gray-700 dark:text-ink-muted">
                {row.row_index + 1}
              </td>
              <td className="px-2 py-1.5 align-top">
                <ExportPreviewStatusBadge status={row.status} />
                {row.issue_count > 0 && (
                  <span className="ml-1 text-[10px] text-gray-500 dark:text-ink-muted">
                    · {row.issue_count} issue{row.issue_count === 1 ? "" : "s"}
                  </span>
                )}
              </td>
              {preview.columns.map((col) => {
                const cell = row.cells.find((c) => c.column_key === col.key);
                return (
                  <td
                    key={col.key}
                    className="px-2 py-1.5 align-top"
                    title={cell?.issues.map((i) => `${i.text} (${i.source})`).join("; ")}
                  >
                    <ExportPreviewCell cell={cell} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExportPreviewCell({
  cell,
}: {
  cell: OperationalExportPreviewCell | undefined;
}) {
  if (!cell) {
    return (
      <span className="text-gray-300 dark:text-ink-subtle">—</span>
    );
  }
  // Missing — render an explicit pill so the operator can scan for
  // gaps without reading values.
  if (cell.status === "missing") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
        Missing
      </span>
    );
  }
  // Blocked / conflict / warning — render the value in tone-appropriate
  // text so the table column still reads as a value (not a chip), but
  // visibly marked.
  const valueText = cell.display_value ?? "—";
  const tone =
    cell.status === "blocked" || cell.status === "conflict"
      ? "text-red-700 dark:text-red-200"
      : cell.status === "warning"
        ? "text-yellow-700 dark:text-yellow-200"
        : cell.status === "ignored"
          ? "text-gray-500 dark:text-ink-muted line-through"
          : "text-gray-800 dark:text-ink";
  return (
    <div className="flex items-start gap-1 min-w-0">
      <span className={cn("break-all", tone)}>{valueText}</span>
      {(cell.status === "blocked" ||
        cell.status === "conflict" ||
        cell.status === "warning") && (
        <AlertTriangle
          className={cn(
            "h-3 w-3 shrink-0 mt-0.5",
            cell.status === "blocked" || cell.status === "conflict"
              ? "text-red-500 dark:text-red-300"
              : "text-yellow-600 dark:text-yellow-300",
          )}
          aria-hidden
        />
      )}
    </div>
  );
}

function ExportPreviewStatusBadge({
  status,
}: {
  status: ExportPreviewRowStatus;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        EXPORT_ROW_STATUS_CHIP[status],
      )}
    >
      {EXPORT_ROW_STATUS_LABEL[status]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Phase 3F — Export Profile check sub-section
// ---------------------------------------------------------------------------
//
// Lives inside the Export-style Rows Preview section. Operator
// picks one of the built-in profiles, sees a status banner +
// settings strip + issues list + column-mapping table, and can
// copy a Markdown report. Strictly diagnostic — no file is ever
// generated.

const PROFILE_STATUS_LABEL: Record<
  NonNullable<ExportProfileValidationResult>["status"],
  string
> = {
  clear: "No blocking issues in this diagnostic profile check",
  needs_review: "Needs review",
  blocked: "Blocked",
  conflict: "Conflict",
};

const PROFILE_STATUS_CHIP: Record<
  NonNullable<ExportProfileValidationResult>["status"],
  string
> = {
  clear:
    "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900",
  needs_review:
    "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900",
  blocked:
    "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
  conflict:
    "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-200 dark:border-orange-900",
};

const PROFILE_SEVERITY_CHIP: Record<ExportProfileIssueSeverity, string> = {
  blocked:
    "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
  warning:
    "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200 dark:border-yellow-900",
  info:
    "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-200 dark:border-blue-900",
  clear:
    "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900",
};

function ExportProfileCheckBlock({
  result,
  preview,
  contextLabel,
  profiles,
  selectedProfileId,
  onSelectProfileId,
  selectedProfile,
  validation,
  copyStatus,
  onCopyStatus,
}: {
  result: OperationalResolutionResult;
  preview: OperationalExportPreview;
  contextLabel: string | null;
  profiles: ExportProfile[];
  selectedProfileId: string | null;
  onSelectProfileId: (id: string | null) => void;
  selectedProfile: ExportProfile | null;
  validation: ExportProfileValidationResult | null;
  copyStatus: { type: "success" | "error"; message: string } | null;
  onCopyStatus: (type: "success" | "error", message: string) => void;
}) {
  const handleCopy = useCallback(async () => {
    if (!selectedProfile || !validation) return;
    try {
      const text = buildExportProfileValidationMarkdownReport({
        result,
        preview,
        profile: selectedProfile,
        validation,
        contextLabel,
      });
      await copyTextToClipboard(text);
      onCopyStatus("success", "Profile check copied.");
    } catch (err) {
      onCopyStatus(
        "error",
        `Could not copy profile check: ${(err as Error).message}`,
      );
    }
  }, [
    result,
    preview,
    selectedProfile,
    validation,
    contextLabel,
    onCopyStatus,
  ]);

  // No profile available (preview empty + getBuiltInExportProfiles
  // returned []). Render nothing — the host section's empty state
  // already explains the situation.
  if (profiles.length === 0 || !selectedProfile || !validation) {
    return null;
  }

  return (
    <section
      className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle"
      aria-label="Export profile check"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-3 py-2 dark:border-line/60">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-800 dark:text-ink">
            Export profile check
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500 dark:text-ink-muted">
            Diagnostic profile check only — no export file is generated.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {copyStatus && (
            <span
              className={cn(
                "text-[11px] font-medium",
                copyStatus.type === "success"
                  ? "text-green-700 dark:text-green-300"
                  : "text-red-700 dark:text-red-300",
              )}
              role={copyStatus.type === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {copyStatus.message}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            title="Copy a Markdown summary of this profile check to the clipboard. No file is generated."
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
            Copy profile check
          </Button>
        </div>
      </header>

      <div className="px-3 py-2 space-y-3">
        {/* Selector + status badge */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px] font-semibold text-gray-700 dark:text-ink-muted">
            Profile
          </label>
          <select
            value={selectedProfileId ?? ""}
            onChange={(e) => onSelectProfileId(e.target.value || null)}
            className={cn(
              "min-w-[14rem] rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 outline-none",
              "focus:ring-2 focus:ring-brand-500",
              "dark:bg-surface dark:text-ink dark:border-line",
            )}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              PROFILE_STATUS_CHIP[validation.status],
            )}
          >
            {PROFILE_STATUS_LABEL[validation.status]}
          </span>
        </div>

        {/* Description + settings strip */}
        <p className="text-[11px] text-gray-700 dark:text-ink-muted">
          {selectedProfile.description}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          <ProfileMetaCell label="Target system" value={selectedProfile.target_system} />
          <ProfileMetaCell label="Delimiter" value={selectedProfile.settings.delimiter} />
          <ProfileMetaCell
            label="Header"
            value={selectedProfile.settings.include_header ? "Included" : "Omitted"}
          />
          <ProfileMetaCell label="Date format" value={selectedProfile.settings.date_format} />
          <ProfileMetaCell label="Amount format" value={selectedProfile.settings.amount_format} />
          <ProfileMetaCell label="Quote strategy" value={selectedProfile.settings.quote_strategy} />
          <ProfileMetaCell label="Newline" value={selectedProfile.settings.newline} />
          <ProfileMetaCell label="Encoding" value={selectedProfile.settings.encoding} />
        </div>

        {/* Validation summary counts */}
        <ProfileValidationCounts validation={validation} profile={selectedProfile} />

        {/* Issues + column mapping */}
        <ProfileIssuesList issues={validation.issues} />
        <ProfileColumnMappingTable validation={validation} />
      </div>
    </section>
  );
}

function ProfileMetaCell({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded border border-gray-200 bg-white px-2 py-1 dark:border-line dark:bg-surface-subtle">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
        {label}
      </p>
      <p className="text-xs font-mono text-gray-800 dark:text-ink truncate">
        {value}
      </p>
    </div>
  );
}

function ProfileValidationCounts({
  validation,
  profile,
}: {
  validation: ExportProfileValidationResult;
  profile: ExportProfile;
}) {
  const cards = [
    { label: "Blocked", value: validation.summary.blocked_count, tone: "text-red-700 dark:text-red-200" },
    { label: "Needs review", value: validation.summary.warning_count, tone: "text-yellow-700 dark:text-yellow-200" },
    { label: "Info", value: validation.summary.info_count, tone: "text-blue-700 dark:text-blue-200" },
    {
      label: "Columns matched",
      value: `${validation.summary.matched_columns} / ${profile.columns.length}`,
      tone: "text-gray-800 dark:text-ink",
    },
    { label: "Rows blocked", value: validation.summary.rows_blocked, tone: "text-red-700 dark:text-red-200" },
    {
      label: "Rows with issues",
      value: validation.summary.rows_with_issues,
      tone: "text-yellow-700 dark:text-yellow-200",
    },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded border border-gray-200 bg-white px-2 py-1 dark:border-line dark:bg-surface-subtle"
        >
          <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
            {card.label}
          </p>
          <p className={cn("text-base font-semibold", card.tone)}>{card.value}</p>
        </div>
      ))}
    </div>
  );
}

function ProfileIssuesList({
  issues,
}: {
  issues: ExportProfileValidationResult["issues"];
}) {
  if (issues.length === 0) {
    return (
      <div className="rounded border border-green-200 bg-green-50/60 px-3 py-2 text-xs text-green-800 dark:border-green-900 dark:bg-green-950/20 dark:text-green-200">
        No blocking issues in this diagnostic check. Future
        production export depends on final export profiles and
        validation.
      </div>
    );
  }
  // Group blocked → warning → info — same order the report uses.
  const grouped: Array<[ExportProfileIssueSeverity, typeof issues]> = [
    ["blocked", issues.filter((i) => i.severity === "blocked")],
    ["warning", issues.filter((i) => i.severity === "warning")],
    ["info", issues.filter((i) => i.severity === "info")],
  ];
  return (
    <div className="space-y-2">
      {grouped.map(([sev, items]) => {
        if (items.length === 0) return null;
        return (
          <div
            key={sev}
            className="rounded border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle"
          >
            <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-2 py-1 dark:border-line/60">
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  PROFILE_SEVERITY_CHIP[sev],
                )}
              >
                {sev}
              </span>
              <span className="text-[11px] text-gray-500 dark:text-ink-muted">
                {items.length}
              </span>
            </header>
            <ul className="divide-y divide-gray-100 dark:divide-line/60">
              {items.map((issue, idx) => (
                <li
                  key={`${issue.code}-${idx}`}
                  className="px-2 py-1.5 text-[11px]"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-gray-900 dark:text-ink">
                        {issue.message}
                      </p>
                      <p className="text-gray-600 dark:text-ink-muted">
                        <Info className="inline h-3 w-3 mr-1 -mt-0.5" />
                        {issue.recommendation}
                      </p>
                      <div className="mt-1 flex items-center gap-1 flex-wrap">
                        {issue.row_index != null && (
                          <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                            row {issue.row_index + 1}
                          </span>
                        )}
                        {issue.profile_column_key && (
                          <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
                            column {issue.profile_column_key}
                          </span>
                        )}
                      </div>
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
    </div>
  );
}

function ProfileColumnMappingTable({
  validation,
}: {
  validation: ExportProfileValidationResult;
}) {
  if (validation.column_results.length === 0) return null;
  return (
    <div className="rounded border border-gray-200 dark:border-line overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 dark:bg-surface-muted">
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
            <th className="px-2 py-1.5">Profile column</th>
            <th className="px-2 py-1.5">Required</th>
            <th className="px-2 py-1.5">Matched preview column</th>
            <th className="px-2 py-1.5">Issues</th>
            <th className="px-2 py-1.5">Worst severity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-line/60">
          {validation.column_results.map((col) => (
            <tr key={col.profile_column_key}>
              <td className="px-2 py-1.5 align-top">
                <span className="font-medium text-gray-800 dark:text-ink">
                  {col.profile_column_label}
                </span>
                <span className="ml-1 font-mono text-[10px] text-gray-400 dark:text-ink-subtle">
                  {col.profile_column_key}
                </span>
              </td>
              <td className="px-2 py-1.5 align-top">
                {col.required ? (
                  <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                    required
                  </span>
                ) : (
                  <span className="text-gray-400 dark:text-ink-subtle">—</span>
                )}
              </td>
              <td className="px-2 py-1.5 align-top">
                {col.matched ? (
                  <span className="text-gray-800 dark:text-ink">
                    {col.matched_preview_column_label ?? col.matched_preview_column_key}
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full border border-yellow-200 bg-yellow-50 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-200">
                    unmapped
                  </span>
                )}
              </td>
              <td className="px-2 py-1.5 align-top text-gray-700 dark:text-ink-muted">
                {col.issue_count}
              </td>
              <td className="px-2 py-1.5 align-top">
                <span
                  className={cn(
                    "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    PROFILE_SEVERITY_CHIP[col.worst_severity],
                  )}
                >
                  {col.worst_severity}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
