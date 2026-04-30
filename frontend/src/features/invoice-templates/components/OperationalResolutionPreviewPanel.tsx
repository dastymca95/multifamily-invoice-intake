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
  ExternalLink,
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
  buildExportProfileSelectionOptions,
  defaultExportProfileOptionId,
  exportProfileSourceMarker,
  isStaleSavedSelection,
  resolveSelectedExportProfileContract,
  resolveSelectedOption,
  type ExportProfileSelectionOption,
} from "../lib/export-profile-selection";
import { usePersistedExportProfiles } from "../hooks/usePersistedExportProfiles";
import { usePersistedExportProfileContract } from "../hooks/usePersistedExportProfileContract";
import { useTransientCopyStatus } from "../hooks/useTransientCopyStatus";
import {
  BACKEND_VALIDATION_SOURCE_COPY,
  backendValidationSourceMarker,
  backendValidationToLocalShape,
  type ExportProfileValidationSource,
} from "../lib/export-profile-backend-adapter";
import { useBackendExportProfileValidation } from "../hooks/useBackendExportProfileValidation";
import {
  compareExportValidationResults,
  summarizeExportValidationParity,
  type ExportValidationParityResult,
} from "../lib/export-validation-parity";
import {
  EXPORT_DIAGNOSTIC_STATUS_LABEL,
  EXPORT_READINESS_BOUNDARY_REASON_LABEL,
  PRODUCTION_EXPORT_STATUS_LABEL,
  buildExportReadinessBoundary,
  type ExportReadinessBoundary,
} from "../lib/export-readiness-boundary";
import {
  buildBackendExportRunDraftRequest,
  exportRunDraftSourceMarker,
  pickExportRunDraftSourceCopy,
} from "../lib/export-run-draft-adapter";
import { useBackendExportRunDraft } from "../hooks/useBackendExportRunDraft";
import type { BackendExportRunDraftResult } from "@/types/export-run-draft";
// Phase 5B — Persisted Export Run draft / audit wiring.
import type { PersistedExportRunRead } from "@/types/export-run-persistence";
import {
  PERSISTED_DRAFT_RECORD_DISCLAIMERS,
  buildPersistedExportRunDraftCreatePayload,
  exportRunDraftSaveFingerprint,
  persistedDraftRecordSourceMarker,
} from "../lib/export-run-persistence-adapter";
import { usePersistExportRunDraft } from "../hooks/usePersistExportRunDraft";
import {
  BACKEND_BOUNDARY_SOURCE_COPY,
  backendBoundarySourceMarker,
  backendBoundaryToLocalShape,
  type ExportReadinessBoundarySource,
} from "../lib/export-readiness-boundary-backend-adapter";
import { useBackendExportReadinessBoundary } from "../hooks/useBackendExportReadinessBoundary";
import {
  validateExportPreviewAgainstProfile,
  type ExportProfileIssueSeverity,
  type ExportProfileValidationResult,
} from "../lib/export-profile-validation";
import { buildExportProfileValidationMarkdownReport } from "../lib/export-profile-reports";
import { buildOperationalFullMarkdownReport } from "../lib/operational-full-report";

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

  // ---- Phase 3D / 3E / 3F / 3G — copy toast surfaces ----------
  // Each surface owns its own transient toast so messages never
  // overwrite each other ("Diagnostics copied" vs "Preview copied"
  // vs "Profile check copied" vs "Full report copied"). The shared
  // ``useTransientCopyStatus`` hook (Phase 3H) replaces what used
  // to be four hand-rolled state + ref + show + close-cleanup
  // patterns. The ``isOpen`` arg flushes any pending toast on close
  // AND on component unmount.
  const diagnosticsCopy = useTransientCopyStatus(isOpen);
  const exportCopy = useTransientCopyStatus(isOpen);
  const profileCopy = useTransientCopyStatus(isOpen);
  const fullReportCopy = useTransientCopyStatus(isOpen);

  // ---- Phase 3E — "Show only issues" filter toggle ------------
  const [exportShowOnlyIssues, setExportShowOnlyIssues] = useState(false);

  // ---- Phase 3F + Phase 4B — Export Profile selection ---------
  // ``selectedOptionId`` is the namespaced selector id from
  // ``export-profile-selection.ts`` — ``saved:<uuid>`` for a
  // persisted profile, ``builtin:<id>`` for a built-in starter.
  // The namespace prevents saved + built-in collisions and lets a
  // previous selection survive saved-profile-list refreshes.
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(
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

  // Phase 3H — also abort on real unmount (host route change /
  // parent re-key / tree teardown). The ``isOpen`` effect alone
  // doesn't fire if the component is removed without first
  // toggling ``isOpen`` to false.
  useEffect(() => {
    return () => {
      runAbortRef.current?.abort();
    };
  }, []);

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

  // ---- Phase 3D — focus / scroll helpers ----------------------
  // The four copy-status surfaces moved to ``useTransientCopyStatus``
  // (Phase 3H). The hook handles auto-clear, close-cleanup, and
  // unmount-safety internally so we don't repeat that here.

  // Phase 3J — Lift export-preview / profile / validation derivation
  // to the panel level so:
  //   (a) the inline ExportPreviewSection AND the consolidated
  //       full-report use the SAME activeValidation, and
  //   (b) the backend validator hook (which needs profile + preview
  //       + result) lives at one stable site.
  // ExportPreviewSection now consumes these via props instead of
  // recomputing them locally. The memo dep arrays are stable —
  // every helper here is deterministic and pure.
  const exportPreview = useMemo(
    () => (result ? buildOperationalExportPreview(result) : null),
    [result],
  );
  // Phase 3F — Built-in profile bundle (always available, even
  // when the saved-profile catalog can't be reached).
  const builtInExportProfiles = useMemo(
    () => (exportPreview ? getBuiltInExportProfiles(exportPreview) : []),
    [exportPreview],
  );

  // ---- Phase 4B — Persisted export profile catalog -------------
  // Loads on panel open (gated by ``isOpen``). Failure is
  // non-blocking — the picker continues to surface built-ins. The
  // hook owns its own loading + abort + retry semantics.
  const persistedProfiles = usePersistedExportProfiles({
    enabled: isOpen,
  });

  // Phase 4B — Combine saved + built-in into one option model.
  const profileSelectionOptions = useMemo(
    () =>
      buildExportProfileSelectionOptions({
        savedSummaries: persistedProfiles.profiles,
        builtInProfiles: builtInExportProfiles,
      }),
    [persistedProfiles.profiles, builtInExportProfiles],
  );

  // Phase 4B — Resolve the selected option, falling back to the
  // default (saved-default → first saved → custom-csv-mirror →
  // first built-in → null) when the operator hasn't picked or the
  // previous pick is no longer present.
  const selectedExportOption: ExportProfileSelectionOption | null = useMemo(
    () => resolveSelectedOption(profileSelectionOptions, selectedOptionId),
    [profileSelectionOptions, selectedOptionId],
  );

  // Phase 4E — Detect when a previously-selected SAVED profile
  // disappeared after a refresh (e.g. deactivated in another tab).
  // Drives a one-line warning in the picker. The dismiss flag lets
  // the operator clear the warning without the next refresh
  // re-triggering it; the dismiss is keyed on the missing id, so
  // a NEW disappearance still warns.
  const staleSavedSelection = useMemo(
    () => isStaleSavedSelection(selectedOptionId, selectedExportOption),
    [selectedOptionId, selectedExportOption],
  );
  const [dismissedStaleSavedId, setDismissedStaleSavedId] = useState<
    string | null
  >(null);
  const showStaleSavedWarning =
    staleSavedSelection && dismissedStaleSavedId !== selectedOptionId;
  const handleDismissStaleSavedWarning = useCallback(() => {
    setDismissedStaleSavedId(selectedOptionId);
  }, [selectedOptionId]);

  // Phase 4B — Saved profile contracts arrive via a per-id fetch
  // because the LIST endpoint returns summaries only. Built-in
  // options carry their contract eagerly; the hook stays idle for
  // those cases.
  const savedProfileContractFetch = usePersistedExportProfileContract({
    profileId:
      selectedExportOption?.source === "saved"
        ? selectedExportOption.persisted_profile_id
        : null,
    enabled: isOpen,
  });

  // Phase 4B — The active ``ExportProfile`` contract that flows
  // into validation / parity / boundary / reports. Null when a
  // saved option is selected and its contract hasn't loaded yet
  // (or failed) — the panel surfaces that explicitly via the
  // saved-contract status notice instead of validating against a
  // mismatched fallback.
  const selectedExportProfile = useMemo(
    () =>
      resolveSelectedExportProfileContract(
        selectedExportOption,
        savedProfileContractFetch.data,
      ),
    [selectedExportOption, savedProfileContractFetch.data],
  );
  const localProfileValidation = useMemo(
    () =>
      exportPreview && selectedExportProfile
        ? validateExportPreviewAgainstProfile(exportPreview, selectedExportProfile)
        : null,
    [exportPreview, selectedExportProfile],
  );

  // Phase 3J — Backend profile validation hook (Phase 3I endpoint).
  // Fires whenever the lifted preview / profile / result identity
  // changes. The hook handles debounce + abort + race + unmount
  // safety internally; here we just feed it the same inputs the
  // local validator uses so the backend verdict and local estimate
  // describe the same diagnostic state.
  const backendValidation = useBackendExportProfileValidation({
    profile: selectedExportProfile,
    preview: exportPreview,
    result,
    enabled: !!result && !!selectedExportProfile && !!exportPreview,
    contextLabel: launchContextLabel ?? null,
  });

  // Phase 3J — When the backend has data, project it into the local
  // ``ExportProfileValidationResult`` shape so the existing UI
  // components + Markdown report helpers stay untouched.
  const backendAdaptedValidation = useMemo(
    () =>
      backendValidation.data && selectedExportProfile
        ? backendValidationToLocalShape(
            backendValidation.data,
            selectedExportProfile,
          )
        : null,
    [backendValidation.data, selectedExportProfile],
  );

  // Phase 3J — Active validation: backend-verified when we have a
  // verified response, otherwise the local estimate. The panel
  // banner narrates which source is showing so the operator never
  // confuses an unverified estimate with backend truth.
  const activeProfileValidation = backendAdaptedValidation ?? localProfileValidation;
  const activeValidationSource: ExportProfileValidationSource =
    backendValidation.source;

  // Phase 3K — Parity diagnostics. ONLY runs when we have BOTH a
  // verified backend response AND a local estimate for the SAME
  // selected profile. Diagnostic only — never overrides backend
  // truth, never blocks the operator. Surfaces drift so support /
  // developers can see when local fallback is diverging.
  const parityResult: ExportValidationParityResult | null = useMemo(() => {
    if (!backendAdaptedValidation || !localProfileValidation) return null;
    return compareExportValidationResults({
      localValidation: localProfileValidation,
      backendValidation: backendAdaptedValidation,
      profile: selectedExportProfile,
      preview: exportPreview,
    });
  }, [
    backendAdaptedValidation,
    localProfileValidation,
    selectedExportProfile,
    exportPreview,
  ]);

  // Phase 4B — Saved-profile selection drives ``has_persisted_profile``
  // on both the local and backend boundary. Built-in starters keep
  // the flag false so the boundary correctly retains the
  // ``no_export_profile_persistence`` reason for those.
  const hasPersistedProfileSelected =
    selectedExportOption?.source === "saved";

  // Phase 3L — Local Export Readiness Boundary fallback. Pure /
  // cheap; routes the current diagnostic state through one helper
  // that computes the explicit gap to a future production export.
  // ALSO computed when the run is unsuccessful so the panel +
  // reports always have a boundary to render.
  const localReadinessBoundary: ExportReadinessBoundary = useMemo(
    () =>
      buildExportReadinessBoundary({
        operationalResult: result,
        exportPreview,
        activeProfileValidation,
        parityResult,
        validationSource: activeValidationSource,
        selectedProfile: selectedExportProfile,
        hasPersistedProfile: hasPersistedProfileSelected,
      }),
    [
      result,
      exportPreview,
      activeProfileValidation,
      parityResult,
      activeValidationSource,
      selectedExportProfile,
      hasPersistedProfileSelected,
    ],
  );

  // Phase 3N — Backend boundary mirror. Same diagnostic-state
  // snapshot routed through the canonical Phase 3M endpoint. The
  // hook handles debounce + abort + race + unmount safety
  // internally; here we just feed it the same inputs the local
  // boundary uses so backend and local describe the same state.
  const backendBoundary = useBackendExportReadinessBoundary({
    result,
    exportPreview,
    activeProfileValidation,
    parityResult,
    validationSource: activeValidationSource,
    selectedProfile: selectedExportProfile,
    hasPersistedProfile: hasPersistedProfileSelected,
    enabled: !!result,
  });

  // Phase 3N — When the backend has data, project it into the
  // local boundary shape so the existing Phase 3L UI panel +
  // Markdown report helpers stay untouched.
  const backendAdaptedBoundary = useMemo(
    () =>
      backendBoundary.data
        ? backendBoundaryToLocalShape(backendBoundary.data)
        : null,
    [backendBoundary.data],
  );

  // Phase 3N — Active boundary: backend-verified when we have a
  // verified response, otherwise the local estimate. The boundary
  // panel banner narrates which source is showing so the operator
  // never misreads a verified backend pill as "ready to export".
  const activeReadinessBoundary: ExportReadinessBoundary =
    backendAdaptedBoundary ?? localReadinessBoundary;
  const activeBoundarySource: ExportReadinessBoundarySource =
    backendBoundary.source;

  // Phase 4G — Backend Export Run Draft hook. Same diagnostic
  // snapshot threaded through the Phase 4F endpoint. The hook
  // handles debounce + abort + race + unmount safety internally;
  // here we just feed it the panel's current state so the draft
  // verdict re-fires whenever any input the classifier reads from
  // changes (selected profile, validation status, boundary status,
  // row counts, etc.).
  const exportRunDraft = useBackendExportRunDraft({
    result,
    exportPreview,
    selectedExportOption,
    selectedExportProfile,
    activeProfileValidation,
    activeReadinessBoundary,
    activeValidationSource,
    activeBoundarySource,
    parityStatus: parityResult?.status ?? null,
    enabled: !!result,
  });

  // Phase 5B — Manual save of the current diagnostic draft as a
  // persisted draft / audit record. The hook is manual-click only;
  // no useEffect fires the request. The fingerprint we stamp on the
  // saved record (alongside the backend ``id``) lets the panel
  // detect "preview changed since save" without re-fetching.
  const persistDraft = usePersistExportRunDraft();
  const [draftNotes, setDraftNotes] = useState("");
  const [savedDraftFingerprint, setSavedDraftFingerprint] = useState<
    string | null
  >(null);
  // ``currentDraftFingerprint`` is recomputed every render from the
  // SAME inputs the Phase 4G hook uses to drive the evaluator; the
  // panel compares it against ``savedDraftFingerprint`` to surface
  // a "preview changed after save" notice. Cheap join — no memo
  // needed for a 15-segment string.
  const currentDraftRequest = result
    ? buildBackendExportRunDraftRequest({
        result,
        exportPreview,
        selectedExportOption,
        selectedExportProfile,
        activeProfileValidation,
        activeReadinessBoundary,
        activeValidationSource,
        activeBoundarySource,
        parityStatus: parityResult?.status ?? null,
      })
    : null;
  const currentDraftFingerprint =
    currentDraftRequest && selectedExportOption
      ? exportRunDraftSaveFingerprint({
          draftRequest: currentDraftRequest,
          selectedExportOption,
        })
      : null;

  const handleSaveDraftAuditRecord = useCallback(async () => {
    if (!result || !currentDraftRequest || !selectedExportOption) {
      // Defensive — the Save button is disabled when any of these
      // is missing, but a stale onClick could still fire briefly.
      return;
    }
    const payload = buildPersistedExportRunDraftCreatePayload({
      draftRequest: currentDraftRequest,
      draftResult: exportRunDraft.data,
      staleDraftResult: exportRunDraft.stale,
      result,
      selectedExportOption,
      selectedExportProfile,
      activeProfileValidation,
      activeReadinessBoundary,
      exportPreview,
      notes: draftNotes,
    });
    try {
      await persistDraft.createDraftRecord(payload);
      // Stamp the fingerprint that produced the saved record. The
      // panel's stale-after-save notice compares this against
      // ``currentDraftFingerprint`` on every render.
      setSavedDraftFingerprint(
        exportRunDraftSaveFingerprint({
          draftRequest: currentDraftRequest,
          selectedExportOption,
        }),
      );
      // Clear the notes textarea on success — the saved record
      // already carries the notes; leaving the textarea filled
      // would tempt the operator into re-saving the same text.
      setDraftNotes("");
    } catch {
      // The hook stores the error message on its own state; the
      // panel reads ``persistDraft.error`` to render the inline
      // banner. Nothing to do here.
    }
  }, [
    result,
    currentDraftRequest,
    selectedExportOption,
    selectedExportProfile,
    activeProfileValidation,
    activeReadinessBoundary,
    exportPreview,
    exportRunDraft.data,
    exportRunDraft.stale,
    draftNotes,
    persistDraft,
  ]);

  // Phase 3K — Dev-only console.debug on major drift so engineers
  // notice quickly without forcing a telemetry service. Silent in
  // production; never triggered for ``aligned`` / ``minor_drift`` /
  // ``not_checked``.
  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" &&
      parityResult?.status === "major_drift"
    ) {
      // eslint-disable-next-line no-console
      console.debug(
        "[ExportValidationParity] major drift detected",
        {
          profile_id: selectedExportProfile?.id,
          local_status: parityResult.local_status,
          backend_status: parityResult.backend_status,
          differences: parityResult.differences,
        },
      );
    }
  }, [parityResult, selectedExportProfile]);

  /**
   * Phase 3G — Build the consolidated Markdown report from the
   * current result + the same derived state the per-section
   * surfaces use (review cards, export preview, selected profile,
   * profile validation). Phase 3J — pulls activeValidation +
   * source label so the full report reflects what's visible.
   *
   * Pure rebuild on every click — keeps the panel from holding a
   * memoised report that could go stale if the operator changed
   * inputs but hasn't re-run.
   */
  const handleCopyFullReport = useCallback(async () => {
    if (!result) return;
    try {
      const reviewCards = buildOperationalDiagnosticCards(
        result.review_diagnostics ?? [],
      );
      // Rebuild defensively so the report never depends on the
      // panel's memoised state being current — picks up edits
      // mid-render too.
      const previewForReport =
        exportPreview ?? buildOperationalExportPreview(result);
      // Reuse the panel-resolved profile contract. If a saved
      // option is selected and its contract hasn't loaded yet, the
      // active selectedExportProfile is null — we don't fabricate
      // a fallback contract here because the report would otherwise
      // mis-attribute its verdicts to the saved profile.
      const selectedProfile = selectedExportProfile;
      // Reuse the same active validation the panel is showing —
      // backend verdict when we have one, local estimate otherwise.
      // Falls back to a fresh local compute if no memo is available
      // yet (e.g. report copy fired immediately after Run).
      const validationForReport =
        activeProfileValidation ??
        (selectedProfile
          ? validateExportPreviewAgainstProfile(
              previewForReport,
              selectedProfile,
            )
          : null);
      // Phase 4B — single-line marker that the report's profile
      // section is honest about whether it's reading a saved
      // profile or a built-in starter, AND about a still-loading
      // saved-profile contract.
      const profileSourceLine = exportProfileSourceMarker({
        option: selectedExportOption,
        contractAvailable: selectedProfile !== null,
      });
      const text = buildOperationalFullMarkdownReport({
        result,
        reviewCards,
        exportPreview: previewForReport,
        selectedProfile,
        profileValidation: validationForReport,
        contextLabel: launchContextLabel ?? null,
        validationSourceMarker: backendValidationSourceMarker(
          activeValidationSource,
        ),
        // Phase 3K — only attach when actually checked. The report
        // builder gates on ``parityResult.checked`` so a "not checked"
        // result still suppresses the audit section cleanly.
        parityResult: parityResult ?? null,
        // Phase 3L — explicit boundary block; always present so the
        // consolidated report carries the contract regardless of
        // diagnostic state.
        // Phase 3N — uses the active (backend-verified-when-available)
        // boundary so the consolidated report matches the panel.
        readinessBoundary: activeReadinessBoundary,
        boundarySourceMarker: backendBoundarySourceMarker(activeBoundarySource),
        // Phase 4B — Profile source marker (saved vs built-in).
        profileSourceMarker: profileSourceLine,
        // Phase 4G — Backend-evaluated draft (when available) +
        // its source marker. Falls back gracefully when the draft
        // hook is in any non-backend state.
        // Phase 4H — also thread the stale flag + last-updated
        // timestamp so the report header is honest about
        // last-known-good rendering.
        exportRunDraft: exportRunDraft.data,
        exportRunDraftSourceMarker: exportRunDraftSourceMarker(
          exportRunDraft.source,
          exportRunDraft.stale,
        ),
        exportRunDraftStale: exportRunDraft.stale,
        exportRunDraftLastUpdatedAt: exportRunDraft.lastUpdatedAt,
        // Phase 5B — persisted draft / audit record (when the
        // operator clicked "Save draft audit record"). Always
        // honest about being a draft / audit row; the marker
        // explicitly denies finalisation / file generation.
        persistedExportRun: persistDraft.lastSavedRecord,
        persistedExportRunSourceMarker: persistedDraftRecordSourceMarker(
          persistDraft.lastSavedRecord,
        ),
        persistedExportRunStaleAfterSave:
          persistDraft.lastSavedRecord !== null &&
          savedDraftFingerprint !== null &&
          currentDraftFingerprint !== null &&
          savedDraftFingerprint !== currentDraftFingerprint,
      });
      await copyTextToClipboard(text);
      fullReportCopy.show("success", "Full report copied.");
    } catch (err) {
      fullReportCopy.show(
        "error",
        `Could not copy full report: ${(err as Error).message}`,
      );
    }
  }, [
    result,
    launchContextLabel,
    fullReportCopy,
    exportPreview,
    selectedExportProfile,
    selectedExportOption,
    activeProfileValidation,
    activeValidationSource,
    parityResult,
    activeReadinessBoundary,
    activeBoundarySource,
    exportRunDraft.data,
    exportRunDraft.source,
    exportRunDraft.stale,
    exportRunDraft.lastUpdatedAt,
    persistDraft.lastSavedRecord,
    savedDraftFingerprint,
    currentDraftFingerprint,
  ]);

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

  // Phase 3H — wrap the four JSON setters so editing a textarea
  // also clears that field's error pill. Without this the error
  // sticks until the next Run, which makes operators think they
  // haven't fixed the JSON even after they have. The other fields'
  // errors are preserved so each pill is independent.
  const clearJsonError = useCallback((key: keyof typeof jsonErrors) => {
    setJsonErrors((curr) => {
      if (!curr[key]) return curr;
      const { [key]: _omit, ...rest } = curr;
      void _omit;
      return rest;
    });
  }, []);
  const handleChangeFactsJson = useCallback(
    (v: string) => {
      setFactsJson(v);
      clearJsonError("facts");
    },
    [clearJsonError],
  );
  const handleChangeHintsJson = useCallback(
    (v: string) => {
      setHintsJson(v);
      clearJsonError("hints");
    },
    [clearJsonError],
  );
  const handleChangeDocMetadataJson = useCallback(
    (v: string) => {
      setDocMetadataJson(v);
      clearJsonError("document_metadata");
    },
    [clearJsonError],
  );
  const handleChangeRuntimeOptionsJson = useCallback(
    (v: string) => {
      setRuntimeOptionsJson(v);
      clearJsonError("runtime_options");
    },
    [clearJsonError],
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
          onChangeFacts={handleChangeFactsJson}
          onChangeHints={handleChangeHintsJson}
          onChangeDocMetadata={handleChangeDocMetadataJson}
          onChangeRuntimeOptions={handleChangeRuntimeOptionsJson}
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
            {/* Phase 3G — Consolidated Markdown report covering
                all four diagnostic surfaces (summary + review
                diagnostics + export-style preview + profile check).
                Sits directly under the summary card so the
                operator's first action after seeing the verdict
                is one-click "share this with QA / support". */}
            <FullReportCopyRow
              copyStatus={fullReportCopy.status}
              onCopy={handleCopyFullReport}
            />
            {/* Phase 3D — replaced the old simple list with the
                review-style grouped cards + summary + copy. The
                section preserves backend code/message/recommendation
                inside each card so support / debugging are unchanged. */}
            <OperationalReviewSection
              result={result}
              contextLabel={launchContextLabel ?? null}
              copyStatus={diagnosticsCopy.status}
              onCopyStatus={diagnosticsCopy.show}
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
              copyStatus={exportCopy.status}
              onCopyStatus={exportCopy.show}
              showOnlyIssues={exportShowOnlyIssues}
              onToggleShowOnlyIssues={() =>
                setExportShowOnlyIssues((v) => !v)
              }
              // Phase 3F + 4B — Export Profile selector + validation
              // sit inside the same section so the operator
              // mental-models them as part of the export-style
              // preview rather than a separate surface. The
              // selector now lists Saved profiles + Built-in
              // starters via ``selectionOptions``.
              selectedOptionId={selectedOptionId}
              onSelectOptionId={setSelectedOptionId}
              selectionOptions={profileSelectionOptions}
              selectedOption={selectedExportOption}
              persistedProfilesLoading={persistedProfiles.loading}
              persistedProfilesError={persistedProfiles.error}
              onRetryPersistedProfiles={persistedProfiles.retry}
              savedContractLoading={savedProfileContractFetch.loading}
              savedContractError={savedProfileContractFetch.error}
              onRetrySavedContract={savedProfileContractFetch.retry}
              // Phase 4E — stale-saved-selection warning + dismiss.
              staleSavedSelectionWarning={showStaleSavedWarning}
              onDismissStaleSavedSelectionWarning={
                handleDismissStaleSavedWarning
              }
              profileCopyStatus={profileCopy.status}
              onProfileCopyStatus={profileCopy.show}
              // Phase 3J — lifted derived state + backend validation.
              preview={exportPreview}
              selectedProfile={selectedExportProfile}
              activeValidation={activeProfileValidation}
              validationSource={activeValidationSource}
              validationLoading={backendValidation.loading}
              validationError={backendValidation.error}
              onRetryBackendValidation={backendValidation.retry}
              // Phase 3K — diagnostic-only parity audit.
              parityResult={parityResult}
              // Phase 3N — boundary + source marker so the
              // per-section Copy profile check report carries the
              // active boundary and its provenance.
              readinessBoundary={activeReadinessBoundary}
              boundarySourceMarker={backendBoundarySourceMarker(
                activeBoundarySource,
              )}
            />
            {/* Phase 3L — Explicit boundary contract. Sits directly
                under the Export-style Rows Preview / Export Profile
                Check area so the operator reads it after the verdict.
                ALWAYS rendered while a result exists (even when the
                preview shows the empty-state) so the boundary is
                on screen whenever the panel has anything diagnostic.
                Phase 3N — uses the active boundary (backend-verified
                when available) and surfaces the source through a
                small banner inside the panel. */}
            <ExportReadinessBoundaryPanel
              boundary={activeReadinessBoundary}
              source={activeBoundarySource}
              loading={backendBoundary.loading}
              error={backendBoundary.error}
              onRetry={backendBoundary.retry}
            />
            {/* Phase 4G — Export Run Draft. Sits AFTER the readiness
                boundary panel and BEFORE the technical Resolver
                Input / Resolver Result so the operator sees the
                draft verdict in context with the boundary it builds
                on. Diagnostic only — backend evaluator never
                generates a file or finalises a run. */}
            <ExportRunDraftPanel
              data={exportRunDraft.data}
              source={exportRunDraft.source}
              loading={exportRunDraft.loading}
              error={exportRunDraft.error}
              onRetry={exportRunDraft.retry}
              // Phase 4H — stale + last-updated timestamp.
              stale={exportRunDraft.stale}
              lastUpdatedAt={exportRunDraft.lastUpdatedAt}
              // Phase 5B — manual save action + saved-record card +
              // optional notes input + stale-after-save notice.
              // The persistence hook is manual-click only; no
              // useEffect auto-save.
              persistBusy={persistDraft.busy}
              persistError={persistDraft.error}
              persistedRecord={persistDraft.lastSavedRecord}
              persistedAt={persistDraft.lastSavedAt}
              draftNotes={draftNotes}
              onChangeDraftNotes={setDraftNotes}
              onSaveDraftAuditRecord={handleSaveDraftAuditRecord}
              onClearPersistStatus={persistDraft.clearStatus}
              persistDisabled={
                !result ||
                !selectedExportOption ||
                !selectedExportProfile
              }
              staleAfterSave={
                persistDraft.lastSavedRecord !== null &&
                savedDraftFingerprint !== null &&
                currentDraftFingerprint !== null &&
                savedDraftFingerprint !== currentDraftFingerprint
              }
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
  // Phase 3H — defensive nullguard. Phase 3A guarantees a summary
  // block on every successful response, but if a future backend
  // revision ever returned ``null`` we'd rather render an empty
  // placeholder than crash the panel.
  if (!summary) {
    return (
      <section className="rounded-md border border-gray-200 bg-white px-3 py-3 text-xs text-gray-500 dark:border-line dark:bg-surface-subtle dark:text-ink-muted">
        Operational summary not available for this run.
      </section>
    );
  }
  const status = String(summary.status);
  const meta =
    RESOLVER_STATUS_META[status] ?? RESOLVER_STATUS_META.needs_review;
  const Icon = meta.Icon;
  // Phase 3H — coerce missing numeric counts to 0 so the cards
  // always render a number even if the backend ever omitted a
  // field. This is the same defensive pattern the resolver-result
  // section already uses for its row/issue counts.
  const n = (v: number | null | undefined): number => v ?? 0;
  const cards = [
    { label: "Rows", value: n(summary.row_count) },
    { label: "Ready", value: n(summary.ready_rows) },
    { label: "Needs review", value: n(summary.needs_review_rows) },
    { label: "Blocked", value: n(summary.blocked_rows) },
    { label: "Conflict", value: n(summary.conflict_rows) },
    { label: "Errors", value: n(summary.error_count) },
    { label: "Warnings", value: n(summary.warning_count) },
    { label: "Info", value: n(summary.info_count) },
    { label: "Facts", value: n(summary.extracted_fact_count) },
    { label: "Hints", value: n(summary.catalog_hint_count) },
    { label: "Missing required", value: n(summary.missing_required_count) },
    { label: "Missing facts", value: n(summary.missing_fact_count) },
    { label: "Missing hints", value: n(summary.missing_catalog_hint_count) },
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
  selectedOptionId,
  onSelectOptionId,
  selectionOptions,
  selectedOption,
  persistedProfilesLoading,
  persistedProfilesError,
  onRetryPersistedProfiles,
  savedContractLoading,
  savedContractError,
  onRetrySavedContract,
  staleSavedSelectionWarning,
  onDismissStaleSavedSelectionWarning,
  profileCopyStatus,
  onProfileCopyStatus,
  preview: previewProp,
  selectedProfile,
  activeValidation,
  validationSource,
  validationLoading,
  validationError,
  onRetryBackendValidation,
  parityResult,
  readinessBoundary,
  boundarySourceMarker,
}: {
  result: OperationalResolutionResult;
  contextLabel: string | null;
  copyStatus: { type: "success" | "error"; message: string } | null;
  onCopyStatus: (type: "success" | "error", message: string) => void;
  showOnlyIssues: boolean;
  onToggleShowOnlyIssues: () => void;
  // Phase 3F + 4B — profile-check plumbing (saved + built-in
  // selection model).
  selectedOptionId: string | null;
  onSelectOptionId: (id: string | null) => void;
  selectionOptions: ReturnType<typeof buildExportProfileSelectionOptions>;
  selectedOption: ExportProfileSelectionOption | null;
  persistedProfilesLoading: boolean;
  persistedProfilesError: string | null;
  onRetryPersistedProfiles: () => void;
  savedContractLoading: boolean;
  savedContractError: string | null;
  onRetrySavedContract: () => void;
  // Phase 4E — stale-saved-selection warning + dismiss.
  staleSavedSelectionWarning: boolean;
  onDismissStaleSavedSelectionWarning: () => void;
  profileCopyStatus: { type: "success" | "error"; message: string } | null;
  onProfileCopyStatus: (type: "success" | "error", message: string) => void;
  // Phase 3J — lifted derived state + backend validation source.
  preview: OperationalExportPreview | null;
  selectedProfile: ExportProfile | null;
  activeValidation: ExportProfileValidationResult | null;
  validationSource: ExportProfileValidationSource;
  validationLoading: boolean;
  validationError: string | null;
  onRetryBackendValidation: () => void;
  // Phase 3K — diagnostic-only parity audit.
  parityResult: ExportValidationParityResult | null;
  // Phase 3N — active boundary + boundary source marker. Threaded
  // here only so the per-section Copy profile check report can
  // include the boundary block + provenance.
  readinessBoundary: ExportReadinessBoundary;
  boundarySourceMarker: string;
}) {
  // Phase 3J — derived state lifted to the panel. Fall back to a
  // local rebuild when the panel hasn't memoised yet (e.g. initial
  // render race) so the section never crashes on a missing prop.
  const preview = useMemo(
    () => previewProp ?? buildOperationalExportPreview(result),
    [previewProp, result],
  );
  // Phase 4B — selector-namespaced ID echoed back to the picker so
  // the controlled <select> stays anchored to the actual selection
  // even when the saved-default fallback kicks in.
  const effectiveOptionId =
    selectedOption?.option_id
    ?? defaultExportProfileOptionId(selectionOptions);

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

        {/* Phase 3F + 4B — Export Profile check. The picker now
            lists Saved profiles (Phase 4A backend catalog) +
            Built-in starters (Phase 3F factories). Backend-
            verified validation when available; local estimate as
            fallback (banner explains source). */}
        <ExportProfileCheckBlock
          result={result}
          preview={preview}
          contextLabel={contextLabel}
          selectionOptions={selectionOptions}
          selectedOptionId={effectiveOptionId}
          onSelectOptionId={onSelectOptionId}
          selectedOption={selectedOption}
          persistedProfilesLoading={persistedProfilesLoading}
          persistedProfilesError={persistedProfilesError}
          onRetryPersistedProfiles={onRetryPersistedProfiles}
          savedContractLoading={savedContractLoading}
          savedContractError={savedContractError}
          onRetrySavedContract={onRetrySavedContract}
          // Phase 4E — stale-saved warning + dismiss + sync actions.
          staleSavedSelectionWarning={staleSavedSelectionWarning}
          onDismissStaleSavedSelectionWarning={
            onDismissStaleSavedSelectionWarning
          }
          selectedProfile={selectedProfile}
          validation={activeValidation}
          copyStatus={profileCopyStatus}
          onCopyStatus={onProfileCopyStatus}
          validationSource={validationSource}
          validationLoading={validationLoading}
          validationError={validationError}
          onRetryBackendValidation={onRetryBackendValidation}
          // Phase 3K — diagnostic-only parity audit.
          parityResult={parityResult}
          // Phase 3N — readiness boundary + source marker for the
          // per-section profile-check Markdown report.
          readinessBoundary={readinessBoundary}
          boundarySourceMarker={boundarySourceMarker}
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
  // Phase 3H — pre-index each row's cells by column_key once so the
  // table render is O(rows × cols) lookups, not O(rows × cols ×
  // cells). With 100 visible rows × 12 columns × ~12 cells per row
  // the previous .find() loop did ~14k linear scans per render.
  const cellMaps = useMemo(
    () =>
      visibleRows.map((row) => {
        const map = new Map<string, OperationalExportPreviewCell>();
        for (const c of row.cells) map.set(c.column_key, c);
        return map;
      }),
    [visibleRows],
  );
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
          {visibleRows.map((row, rowIdx) => {
            const cellMap = cellMaps[rowIdx];
            return (
              <tr
                key={row.row_index}
                className={cn(EXPORT_ROW_TONE[row.status])}
              >
                <td className="px-2 py-1.5 align-top font-medium text-gray-700 dark:text-ink-muted">
                  {row.row_index + 1}
                </td>
                <td className="px-2 py-1.5 align-top">
                  <ExportPreviewStatusBadge status={row.status} />
                  {row.issue_count > 0 && (
                    <span className="ml-1 text-[10px] text-gray-500 dark:text-ink-muted">
                      · {row.issue_count} issue
                      {row.issue_count === 1 ? "" : "s"}
                    </span>
                  )}
                </td>
                {preview.columns.map((col) => {
                  const cell = cellMap?.get(col.key);
                  return (
                    <td
                      key={col.key}
                      className="px-2 py-1.5 align-top"
                      title={cell?.issues
                        .map((i) => `${i.text} (${i.source})`)
                        .join("; ")}
                    >
                      <ExportPreviewCell cell={cell} />
                    </td>
                  );
                })}
              </tr>
            );
          })}
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
  selectionOptions,
  selectedOptionId,
  onSelectOptionId,
  selectedOption,
  persistedProfilesLoading,
  persistedProfilesError,
  onRetryPersistedProfiles,
  savedContractLoading,
  savedContractError,
  onRetrySavedContract,
  staleSavedSelectionWarning,
  onDismissStaleSavedSelectionWarning,
  selectedProfile,
  validation,
  copyStatus,
  onCopyStatus,
  validationSource,
  validationLoading,
  validationError,
  onRetryBackendValidation,
  parityResult,
  readinessBoundary,
  boundarySourceMarker,
}: {
  result: OperationalResolutionResult;
  preview: OperationalExportPreview;
  contextLabel: string | null;
  // Phase 3F + 4B — saved + built-in selection model.
  selectionOptions: ReturnType<typeof buildExportProfileSelectionOptions>;
  selectedOptionId: string | null;
  onSelectOptionId: (id: string | null) => void;
  selectedOption: ExportProfileSelectionOption | null;
  persistedProfilesLoading: boolean;
  persistedProfilesError: string | null;
  onRetryPersistedProfiles: () => void;
  savedContractLoading: boolean;
  savedContractError: string | null;
  onRetrySavedContract: () => void;
  // Phase 4E — stale-saved-selection warning + dismiss + sync actions.
  staleSavedSelectionWarning: boolean;
  onDismissStaleSavedSelectionWarning: () => void;
  selectedProfile: ExportProfile | null;
  validation: ExportProfileValidationResult | null;
  copyStatus: { type: "success" | "error"; message: string } | null;
  onCopyStatus: (type: "success" | "error", message: string) => void;
  // Phase 3J — backend validation source plumbing.
  validationSource: ExportProfileValidationSource;
  validationLoading: boolean;
  validationError: string | null;
  onRetryBackendValidation: () => void;
  // Phase 3K — diagnostic-only parity audit.
  parityResult: ExportValidationParityResult | null;
  // Phase 3N — boundary + boundary-source marker for the report.
  readinessBoundary: ExportReadinessBoundary;
  boundarySourceMarker: string;
}) {
  // Phase 4B — single-line marker that the per-section profile-check
  // report is honest about whether it's reading a saved profile or a
  // built-in starter, AND about a still-loading saved-profile contract.
  const profileSourceMarkerLine = exportProfileSourceMarker({
    option: selectedOption,
    contractAvailable: selectedProfile !== null,
  });

  const handleCopy = useCallback(async () => {
    if (!selectedProfile || !validation) return;
    try {
      // Phase 3J — embed the active validation source so a paste-
      // into-Slack workflow makes the verdict's provenance visible.
      // Phase 3K — also embed the parity audit so the recipient
      // sees backend↔local drift alongside the verdict.
      // Phase 3N — also embed the active boundary + boundary
      // source marker so the per-section report carries the
      // production-export-unavailable contract verbatim.
      // Phase 4B — also embed the profile source marker so the
      // recipient knows whether the profile is saved or built-in.
      const text = buildExportProfileValidationMarkdownReport({
        result,
        preview,
        profile: selectedProfile,
        validation,
        contextLabel,
        validationSourceMarker: backendValidationSourceMarker(validationSource),
        parityResult: parityResult ?? null,
        readinessBoundary,
        boundarySourceMarker,
        profileSourceMarker: profileSourceMarkerLine,
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
    validationSource,
    parityResult,
    readinessBoundary,
    boundarySourceMarker,
    profileSourceMarkerLine,
  ]);

  // No selection options at all (preview empty AND saved catalog
  // empty). Render nothing — the host section's empty state already
  // explains the situation.
  if (selectionOptions.combined.length === 0) {
    return null;
  }
  // No selected profile contract (saved-contract loading or
  // failed). Render the picker + a status notice instead of
  // bailing — the operator should still be able to switch to a
  // built-in starter without re-opening the panel.
  // (Handled inline below — we don't early-return.)

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
        {/* Phase 4B — Saved/built-in selector with grouped options
            and source badge. */}
        <ProfileSelectorRow
          selectionOptions={selectionOptions}
          selectedOptionId={selectedOptionId}
          selectedOption={selectedOption}
          onSelectOptionId={onSelectOptionId}
          persistedProfilesLoading={persistedProfilesLoading}
          persistedProfilesError={persistedProfilesError}
          onRetryPersistedProfiles={onRetryPersistedProfiles}
          validationStatus={validation?.status ?? null}
          // Phase 4E — sync actions + stale-saved-selection warning.
          savedContractLoading={savedContractLoading}
          onRefreshSavedContract={onRetrySavedContract}
          staleSavedSelectionWarning={staleSavedSelectionWarning}
          onDismissStaleSavedSelectionWarning={
            onDismissStaleSavedSelectionWarning
          }
        />

        {/* Phase 4B — saved-profile contract loading / failure
            notice. Shows ONLY when the operator picked a saved
            option whose contract is mid-fetch or failed. */}
        <SavedProfileContractStatus
          selectedOption={selectedOption}
          loading={savedContractLoading}
          error={savedContractError}
          onRetry={onRetrySavedContract}
        />

        {/* Phase 3J — Validation source banner. Sits between the
            selector and the description/settings strip so the
            operator sees provenance before reading the verdict. */}
        <ValidationSourceBanner
          source={validationSource}
          loading={validationLoading}
          error={validationError}
          onRetry={onRetryBackendValidation}
        />

        {/* Phase 3K — Diagnostic-only source audit. Secondary line
            under the source banner. Only renders when parity has
            actually been checked (backend + local both available
            for the same profile). NEVER overrides backend truth
            and never blocks the operator. */}
        <ValidationSourceAudit parityResult={parityResult} />

        {/* Profile detail + verdict — only rendered when the
            selected profile contract IS available AND the
            validator returned a verdict. Otherwise the picker +
            status notices above explain the missing state. */}
        {selectedProfile && validation && (
          <>
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
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Phase 4B — Profile selector with grouped saved + built-in options
// ---------------------------------------------------------------------------

function ProfileSelectorRow({
  selectionOptions,
  selectedOptionId,
  selectedOption,
  onSelectOptionId,
  persistedProfilesLoading,
  persistedProfilesError,
  onRetryPersistedProfiles,
  validationStatus,
  savedContractLoading,
  onRefreshSavedContract,
  staleSavedSelectionWarning,
  onDismissStaleSavedSelectionWarning,
}: {
  selectionOptions: ReturnType<typeof buildExportProfileSelectionOptions>;
  selectedOptionId: string | null;
  selectedOption: ExportProfileSelectionOption | null;
  onSelectOptionId: (id: string | null) => void;
  persistedProfilesLoading: boolean;
  persistedProfilesError: string | null;
  onRetryPersistedProfiles: () => void;
  validationStatus: ExportProfileValidationResult["status"] | null;
  // Phase 4E — sync actions + stale-saved-selection warning.
  savedContractLoading: boolean;
  onRefreshSavedContract: () => void;
  staleSavedSelectionWarning: boolean;
  onDismissStaleSavedSelectionWarning: () => void;
}) {
  const hasSaved = selectionOptions.saved.length > 0;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] font-semibold text-gray-700 dark:text-ink-muted">
          Profile
        </label>
        <select
          value={selectedOptionId ?? ""}
          onChange={(e) => onSelectOptionId(e.target.value || null)}
          className={cn(
            "min-w-[16rem] rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 outline-none",
            "focus:ring-2 focus:ring-brand-500",
            "dark:bg-surface dark:text-ink dark:border-line",
          )}
        >
          {/* Grouped — saved first, built-in second. Optgroups
              degrade gracefully on every browser. */}
          {hasSaved && (
            <optgroup label="Saved profiles">
              {selectionOptions.saved.map((opt) => (
                <option key={opt.option_id} value={opt.option_id}>
                  {opt.label}
                  {opt.is_default ? " · default" : ""}
                  {` · v${opt.version}`}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Built-in starter profiles">
            {selectionOptions.builtIn.map((opt) => (
              <option key={opt.option_id} value={opt.option_id}>
                {opt.label}
              </option>
            ))}
          </optgroup>
        </select>
        {/* Source badge — Saved vs Built-in */}
        {selectedOption && (
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              selectedOption.source === "saved"
                ? "border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950/40 dark:text-cyan-200"
                : "border-gray-200 bg-gray-50 text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted",
            )}
            title={
              selectedOption.source === "saved"
                ? "Selected profile is a saved catalog row."
                : "Selected profile is a built-in starter."
            }
          >
            {selectedOption.source === "saved" ? "Saved profile" : "Built-in starter"}
          </span>
        )}
        {selectedOption?.source === "saved" && selectedOption.is_default && (
          <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
            default
          </span>
        )}
        {validationStatus && (
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              PROFILE_STATUS_CHIP[validationStatus],
            )}
          >
            {PROFILE_STATUS_LABEL[validationStatus]}
          </span>
        )}
      </div>

      {/* Phase 4E — Sync action row. Compact secondary controls
          for refreshing the saved-profile catalog, refreshing the
          selected saved profile contract, and opening the
          Settings → Export Profiles management page in a new tab
          (so the operator's preview state survives). */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-600 dark:text-ink-muted">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRetryPersistedProfiles}
          disabled={persistedProfilesLoading}
          title="Reload the saved profile catalog from the backend."
        >
          <RefreshCw
            className={cn(
              "h-3.5 w-3.5",
              persistedProfilesLoading && "animate-spin",
            )}
          />
          Refresh saved profiles
        </Button>
        {selectedOption?.source === "saved" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRefreshSavedContract}
            disabled={savedContractLoading}
            title="Reload the selected saved profile's contract."
          >
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5",
                savedContractLoading && "animate-spin",
              )}
            />
            Refresh contract
          </Button>
        )}
        <a
          href="/settings/export-profiles"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150",
            "text-gray-700 hover:bg-gray-100 dark:text-ink-muted dark:hover:bg-surface-muted",
          )}
          title="Open Settings → Export Profiles in a new tab. Operational Preview state stays open here."
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open Export Profiles
        </a>
      </div>

      {/* Phase 4E — Stale-saved-selection warning. Surfaced when
          the operator-requested saved profile is no longer in the
          refreshed catalog (e.g. deactivated in another tab) and
          the resolver fell back to a different option. Dismissible
          per-id so the next disappearance still warns. */}
      {staleSavedSelectionWarning && (
        <div className="flex items-start gap-2 rounded border border-yellow-200 bg-yellow-50/60 px-2 py-1 text-[11px] text-yellow-900 dark:border-yellow-900 dark:bg-yellow-950/20 dark:text-yellow-100">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p>
              The selected saved profile is no longer active. Rivera
              selected the next available profile.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDismissStaleSavedSelectionWarning}
            title="Dismiss this notice."
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* Saved-profile load loading + error notices. Non-blocking —
          built-in starters remain in the picker either way. */}
      {persistedProfilesLoading && !hasSaved && (
        <p className="text-[11px] text-gray-600 dark:text-ink-muted">
          <Loader2 className="inline h-3 w-3 mr-1 -mt-0.5 animate-spin text-brand-600 dark:text-brand-50" />
          Loading saved profiles…
        </p>
      )}
      {persistedProfilesError && (
        <div className="flex items-start gap-2 rounded border border-yellow-200 bg-yellow-50/60 px-2 py-1 text-[11px] text-yellow-900 dark:border-yellow-900 dark:bg-yellow-950/20 dark:text-yellow-100">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p>
              Could not load saved profiles. Built-in starter profiles
              are still available.
            </p>
            <p className="mt-0.5 font-mono text-[10px] text-yellow-800 dark:text-yellow-200 break-words">
              {persistedProfilesError}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRetryPersistedProfiles}
            title="Retry loading the saved profile catalog."
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      )}
      {!persistedProfilesLoading &&
        !persistedProfilesError &&
        !hasSaved && (
          <p className="text-[11px] text-gray-500 dark:text-ink-muted">
            No saved profiles yet. Built-in starter profiles are
            available.
          </p>
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 4B — Saved profile contract loading / failure status
// ---------------------------------------------------------------------------

function SavedProfileContractStatus({
  selectedOption,
  loading,
  error,
  onRetry,
}: {
  selectedOption: ExportProfileSelectionOption | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  // Only render when a SAVED option is selected and either the
  // contract is mid-fetch or the fetch errored. Built-in selections
  // carry their contract eagerly so this status notice is irrelevant.
  if (!selectedOption || selectedOption.source !== "saved") return null;
  if (loading) {
    return (
      <p className="text-[11px] text-blue-800 dark:text-blue-200">
        <Loader2 className="inline h-3 w-3 mr-1 -mt-0.5 animate-spin" />
        Loading saved profile contract…
      </p>
    );
  }
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded border border-yellow-300 bg-yellow-50/70 px-2 py-1 text-[11px] text-yellow-900 dark:border-yellow-900 dark:bg-yellow-950/20 dark:text-yellow-100">
        <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p>
            Could not load this saved profile&rsquo;s contract. Pick a
            built-in starter or retry.
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-yellow-800 dark:text-yellow-200 break-words">
            {error}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRetry}
          title="Retry loading the saved profile contract."
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 3J — Backend validation source banner
// ---------------------------------------------------------------------------
//
// Sits inside the Export Profile Check block. Tells the operator
// whether the verdict they're seeing is backend-verified or a
// local estimate, with a retry control on backend failure.

function ValidationSourceBanner({
  source,
  loading,
  error,
  onRetry,
}: {
  source: ExportProfileValidationSource;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  // While the request is in flight after a previous success, prefer
  // the "backend" copy (we still show the previously-verified data)
  // so operators don't see Backend verified flicker to Loading on
  // every input nudge. The hook's ``source`` already reflects this
  // — only "loading" when no prior data is available.
  const copy = BACKEND_VALIDATION_SOURCE_COPY[source];
  const tone = copy.tone;
  const wrapClass =
    tone === "success"
      ? "border-green-200 bg-green-50/60 dark:border-green-900 dark:bg-green-950/20"
      : tone === "warning"
        ? "border-yellow-300 bg-yellow-50/70 dark:border-yellow-900 dark:bg-yellow-950/20"
        : tone === "info"
          ? "border-blue-200 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/20"
          : "border-gray-200 bg-gray-50/70 dark:border-line dark:bg-surface-muted";
  const titleClass =
    tone === "success"
      ? "text-green-800 dark:text-green-200"
      : tone === "warning"
        ? "text-yellow-900 dark:text-yellow-100"
        : tone === "info"
          ? "text-blue-900 dark:text-blue-100"
          : "text-gray-800 dark:text-ink";
  const detailClass =
    tone === "success"
      ? "text-green-800/90 dark:text-green-200/90"
      : tone === "warning"
        ? "text-yellow-900/90 dark:text-yellow-100/90"
        : tone === "info"
          ? "text-blue-900/90 dark:text-blue-100/90"
          : "text-gray-700 dark:text-ink-muted";
  const Icon =
    tone === "success"
      ? CheckCircle2
      : tone === "warning"
        ? AlertTriangle
        : tone === "info"
          ? Loader2
          : Info;
  const iconClass =
    tone === "success"
      ? "text-green-600 dark:text-green-400"
      : tone === "warning"
        ? "text-yellow-700 dark:text-yellow-300"
        : tone === "info"
          ? "text-blue-600 dark:text-blue-300 animate-spin"
          : "text-gray-500 dark:text-ink-muted";
  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2 text-[11px]",
        wrapClass,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", iconClass)} />
        <div className="min-w-0 flex-1">
          <p className={cn("font-semibold", titleClass)}>{copy.title}</p>
          <p className={cn("mt-0.5", detailClass)}>{copy.detail}</p>
          {/* Surface the backend error verbatim — useful for support
              tickets without forcing the operator to re-trigger and
              read DevTools. */}
          {error && source !== "backend" && (
            <p className="mt-1 font-mono text-[10px] text-red-700 dark:text-red-300 break-words">
              {error}
            </p>
          )}
        </div>
        {/* Retry only makes sense when the last attempt failed and
            we're not already retrying. */}
        {source === "local" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRetry}
            disabled={loading}
            title="Retry backend profile check."
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 3K — Validation source audit (parity diagnostic)
// ---------------------------------------------------------------------------
//
// Compact, secondary line that surfaces drift between the local
// validator and the backend validator. Diagnostic only — never
// overrides backend truth, never blocks the operator. Hidden when
// parity has not been checked (backend not yet available, no local
// estimate, or different profiles).

function ValidationSourceAudit({
  parityResult,
}: {
  parityResult: ExportValidationParityResult | null;
}) {
  if (!parityResult || !parityResult.checked) {
    // Stay quiet — the panel already has a Source banner narrating
    // backend vs local. Adding a "not checked" line here would just
    // be noise for the operator.
    return null;
  }
  const summary = summarizeExportValidationParity(parityResult);
  const tone = parityResult.status;
  const wrapClass =
    tone === "aligned"
      ? "border-green-200 bg-green-50/40 dark:border-green-900 dark:bg-green-950/10"
      : tone === "minor_drift"
        ? "border-yellow-200 bg-yellow-50/40 dark:border-yellow-900 dark:bg-yellow-950/10"
        : "border-rose-200 bg-rose-50/40 dark:border-rose-900 dark:bg-rose-950/10";
  const titleClass =
    tone === "aligned"
      ? "text-green-800 dark:text-green-200"
      : tone === "minor_drift"
        ? "text-yellow-900 dark:text-yellow-100"
        : "text-rose-900 dark:text-rose-100";
  const Icon =
    tone === "aligned"
      ? CheckCircle2
      : tone === "minor_drift"
        ? Info
        : AlertTriangle;
  const iconClass =
    tone === "aligned"
      ? "text-green-600 dark:text-green-400"
      : tone === "minor_drift"
        ? "text-yellow-700 dark:text-yellow-300"
        : "text-rose-700 dark:text-rose-300";
  // Aligned needs no expandable details — there are no
  // differences to show. Drift cases get a <details> so the
  // operator can choose to look at the technical breakdown.
  const showDetails =
    parityResult.status !== "aligned" && parityResult.differences.length > 0;
  return (
    <div
      className={cn("rounded-md border px-2.5 py-1.5 text-[11px]", wrapClass)}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", iconClass)} />
        <div className="min-w-0 flex-1">
          <p className={cn("font-medium", titleClass)}>{summary}</p>
          {/* Mini status comparison so the audit line stays useful
              even when collapsed. */}
          <p className="mt-0.5 text-[10px] text-gray-600 dark:text-ink-muted">
            Local says <span className="font-mono">{parityResult.local_status ?? "—"}</span>
            {" · "}
            Backend says <span className="font-mono">{parityResult.backend_status ?? "—"}</span>
            {" · "}
            {parityResult.local_issue_count} local /{" "}
            {parityResult.backend_issue_count} backend issues
          </p>
          {showDetails && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[11px] text-gray-700 dark:text-ink-muted">
                Show {parityResult.differences.length} drift detail
                {parityResult.differences.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 space-y-1">
                {parityResult.differences.map((d, idx) => (
                  <li
                    key={`${d.area}-${idx}`}
                    className="rounded border border-gray-200 px-2 py-1 dark:border-line bg-white/60 dark:bg-surface-subtle/60"
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
                          d.severity === "blocked"
                            ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200"
                            : d.severity === "warning"
                              ? "border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/30 dark:text-yellow-200"
                              : "border-gray-200 bg-gray-50 text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted",
                        )}
                      >
                        {d.severity}
                      </span>
                      <span className="font-mono text-[10px] text-gray-500 dark:text-ink-subtle uppercase tracking-wide shrink-0">
                        {d.area}
                      </span>
                      <span className="text-[11px] text-gray-800 dark:text-ink min-w-0">
                        {d.message}
                      </span>
                    </div>
                    <p className="mt-0.5 pl-1 text-[10px] text-gray-600 dark:text-ink-muted">
                      Local: <span className="font-mono">{d.local_value}</span>
                      {" · "}
                      Backend: <span className="font-mono">{d.backend_value}</span>
                    </p>
                    <p className="mt-0.5 pl-1 text-[10px] text-gray-600 dark:text-ink-muted">
                      <Info className="inline h-3 w-3 mr-1 -mt-0.5" />
                      {d.recommendation}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 3L — Export Readiness Boundary panel
// ---------------------------------------------------------------------------
//
// Always-on small section that makes the gap between current
// diagnostic surfaces and a future production export engine
// explicit. NEVER says "ready to export" — always carries
// production_export_ready=false through the contract. Tone is
// blue/cyan when diagnostics are clear (so green doesn't get
// misread as "good to go"), amber on needs_review, rose on
// blocked.

const _BOUNDARY_TONE: Record<
  ExportReadinessBoundary["diagnostic_status"],
  {
    border: string;
    title: string;
    detail: string;
    pillBorder: string;
    pillBg: string;
    pillText: string;
    Icon: LucideIcon;
    iconClass: string;
  }
> = {
  clear: {
    border: "border-cyan-200 bg-cyan-50/50 dark:border-cyan-900 dark:bg-cyan-950/20",
    title: "text-cyan-900 dark:text-cyan-100",
    detail: "text-cyan-900/90 dark:text-cyan-100/90",
    pillBorder: "border-cyan-200 dark:border-cyan-900",
    pillBg: "bg-cyan-50 dark:bg-cyan-950/40",
    pillText: "text-cyan-800 dark:text-cyan-200",
    Icon: Info,
    iconClass: "text-cyan-600 dark:text-cyan-300",
  },
  needs_review: {
    border:
      "border-yellow-300 bg-yellow-50/60 dark:border-yellow-900 dark:bg-yellow-950/20",
    title: "text-yellow-900 dark:text-yellow-100",
    detail: "text-yellow-900/90 dark:text-yellow-100/90",
    pillBorder: "border-yellow-200 dark:border-yellow-900",
    pillBg: "bg-yellow-50 dark:bg-yellow-950/40",
    pillText: "text-yellow-800 dark:text-yellow-200",
    Icon: AlertTriangle,
    iconClass: "text-yellow-700 dark:text-yellow-300",
  },
  blocked: {
    border:
      "border-rose-300 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/20",
    title: "text-rose-900 dark:text-rose-100",
    detail: "text-rose-900/90 dark:text-rose-100/90",
    pillBorder: "border-rose-200 dark:border-rose-900",
    pillBg: "bg-rose-50 dark:bg-rose-950/40",
    pillText: "text-rose-800 dark:text-rose-200",
    Icon: CircleAlert,
    iconClass: "text-rose-600 dark:text-rose-300",
  },
  not_available: {
    border:
      "border-gray-200 bg-gray-50/70 dark:border-line dark:bg-surface-muted",
    title: "text-gray-800 dark:text-ink",
    detail: "text-gray-700 dark:text-ink-muted",
    pillBorder: "border-gray-200 dark:border-line",
    pillBg: "bg-gray-50 dark:bg-surface-muted",
    pillText: "text-gray-700 dark:text-ink-muted",
    Icon: Info,
    iconClass: "text-gray-500 dark:text-ink-muted",
  },
};

function ExportReadinessBoundaryPanel({
  boundary,
  source,
  loading,
  error,
  onRetry,
}: {
  boundary: ExportReadinessBoundary;
  // Phase 3N — backend boundary mirror plumbing.
  source: ExportReadinessBoundarySource;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const tone = _BOUNDARY_TONE[boundary.diagnostic_status];
  const Icon = tone.Icon;
  return (
    <section
      className={cn("rounded-md border px-3 py-2.5", tone.border)}
      aria-label="Export readiness boundary"
    >
      <header className="flex items-start gap-2">
        <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", tone.iconClass)} />
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm font-semibold", tone.title)}>
            Export readiness boundary
          </p>
          <p className={cn("mt-0.5 text-[11px]", tone.detail)}>
            Diagnostic checks can be clear, but production export is not
            enabled yet.
          </p>
        </div>
      </header>

      {/* Phase 3N — Boundary source banner. Tells the operator
          whether the verdict they're seeing is the backend mirror
          (Phase 3M) or the local fallback (Phase 3L). Sits right
          under the header so the source is visible BEFORE the
          status row + operator messaging. NEVER says "ready" — the
          boundary contract holds regardless of source. */}
      <BoundarySourceBanner
        source={source}
        loading={loading}
        error={error}
        onRetry={onRetry}
      />

      {/* Status row — three immutable claims */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-1.5 py-0.5 font-semibold uppercase tracking-wide",
            tone.pillBorder,
            tone.pillBg,
            tone.pillText,
          )}
          title="Diagnostic verdict (operator-facing)."
        >
          Diagnostic: {EXPORT_DIAGNOSTIC_STATUS_LABEL[boundary.diagnostic_status]}
        </span>
        <span
          className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted"
          title="Production export status (always unavailable in this phase)."
        >
          Production export:{" "}
          {PRODUCTION_EXPORT_STATUS_LABEL[boundary.production_export_status]}
        </span>
        <span
          className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono uppercase tracking-wide text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted"
          title="Hard contract — always No in this phase."
        >
          production_export_ready: No
        </span>
      </div>

      {/* Operator headline + message */}
      <div className="mt-2">
        <p className={cn("text-xs font-semibold", tone.title)}>
          {boundary.operator_title}
        </p>
        <p className={cn("mt-0.5 text-[11px]", tone.detail)}>
          {boundary.operator_message}
        </p>
      </div>

      {/* Reasons + next steps in a compact <details> so the
          operator can choose to look at the full list. */}
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-gray-700 dark:text-ink-muted">
          Why production export is unavailable ({boundary.reasons.length}{" "}
          reason{boundary.reasons.length === 1 ? "" : "s"}) · Next steps (
          {boundary.next_steps.length})
        </summary>
        <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="rounded border border-gray-200 px-2 py-1.5 dark:border-line bg-white/60 dark:bg-surface-subtle/60">
            <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
              Reasons
            </p>
            <ul className="mt-1 space-y-0.5 text-[11px] text-gray-800 dark:text-ink">
              {boundary.reasons.map((reason) => (
                <li key={reason} className="flex items-start gap-1.5">
                  <span className="mt-0.5 shrink-0 text-gray-400 dark:text-ink-subtle">
                    •
                  </span>
                  <span>
                    {EXPORT_READINESS_BOUNDARY_REASON_LABEL[reason]}{" "}
                    <span className="font-mono text-[10px] text-gray-400 dark:text-ink-subtle">
                      {reason}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded border border-gray-200 px-2 py-1.5 dark:border-line bg-white/60 dark:bg-surface-subtle/60">
            <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
              Next steps
            </p>
            <ol className="mt-1 space-y-0.5 text-[11px] text-gray-800 dark:text-ink list-decimal list-inside">
              {boundary.next_steps.map((step, idx) => (
                <li key={idx}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      </details>

      {/* Disclaimers — always visible small print */}
      <p className="mt-2 text-[10px] text-gray-600 dark:text-ink-muted">
        {boundary.disclaimers.join(" · ")}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Phase 3N — Boundary source banner (backend mirror vs local fallback)
// ---------------------------------------------------------------------------
//
// Sits inside ``ExportReadinessBoundaryPanel``. Tells the operator
// whether the verdict above is the canonical backend boundary
// (Phase 3M endpoint) or the local fallback (Phase 3L helper).
// NEVER claims production export readiness regardless of source —
// the boundary contract holds either way.

function BoundarySourceBanner({
  source,
  loading,
  error,
  onRetry,
}: {
  source: ExportReadinessBoundarySource;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const copy = BACKEND_BOUNDARY_SOURCE_COPY[source];
  const tone = copy.tone;
  const wrapClass =
    tone === "success"
      ? "border-green-200 bg-green-50/40 dark:border-green-900 dark:bg-green-950/15"
      : tone === "warning"
        ? "border-yellow-300 bg-yellow-50/50 dark:border-yellow-900 dark:bg-yellow-950/15"
        : tone === "info"
          ? "border-blue-200 bg-blue-50/40 dark:border-blue-900 dark:bg-blue-950/15"
          : "border-gray-200 bg-gray-50/50 dark:border-line dark:bg-surface-muted/60";
  const titleClass =
    tone === "success"
      ? "text-green-800 dark:text-green-200"
      : tone === "warning"
        ? "text-yellow-900 dark:text-yellow-100"
        : tone === "info"
          ? "text-blue-900 dark:text-blue-100"
          : "text-gray-800 dark:text-ink";
  const detailClass =
    tone === "success"
      ? "text-green-800/90 dark:text-green-200/90"
      : tone === "warning"
        ? "text-yellow-900/90 dark:text-yellow-100/90"
        : tone === "info"
          ? "text-blue-900/90 dark:text-blue-100/90"
          : "text-gray-700 dark:text-ink-muted";
  const Icon =
    tone === "success"
      ? CheckCircle2
      : tone === "warning"
        ? AlertTriangle
        : tone === "info"
          ? Loader2
          : Info;
  const iconClass =
    tone === "success"
      ? "text-green-600 dark:text-green-400"
      : tone === "warning"
        ? "text-yellow-700 dark:text-yellow-300"
        : tone === "info"
          ? "text-blue-600 dark:text-blue-300 animate-spin"
          : "text-gray-500 dark:text-ink-muted";
  return (
    <div
      className={cn("mt-2 rounded-md border px-2 py-1.5 text-[11px]", wrapClass)}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", iconClass)} />
        <div className="min-w-0 flex-1">
          <p className={cn("font-semibold", titleClass)}>{copy.title}</p>
          <p className={cn("mt-0.5", detailClass)}>{copy.detail}</p>
          {error && source !== "backend" && (
            <p className="mt-1 font-mono text-[10px] text-red-700 dark:text-red-300 break-words">
              {error}
            </p>
          )}
        </div>
        {/* Retry only makes sense when the last attempt failed and
            we're not already retrying. */}
        {source === "local" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRetry}
            disabled={loading}
            title="Retry backend boundary check."
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 4G — Export Run Draft panel
// ---------------------------------------------------------------------------
//
// Wraps the Phase 4F backend draft endpoint result. Diagnostic
// only — the backend draft contract is hard-pinned to
// ``draft_only=true`` / ``finalized=false`` / ``file_generated=false``
// / ``download_available=false`` / ``production_export_ready=false``
// regardless of input. The panel narrates that contract verbatim
// so the operator can never misread a "Draft clear" pill as
// "ready to export". ``draft_clear`` uses cyan/blue styling, NOT
// green, for the same reason the boundary panel does.

const _DRAFT_STATUS_LABEL: Record<string, string> = {
  draft_clear: "Draft clear",
  needs_review: "Needs review",
  blocked: "Blocked",
  not_available: "Not available",
};

const _DRAFT_REASON_LABEL: Record<string, string> = {
  diagnostic_only_pipeline: "Diagnostic-only pipeline",
  no_export_engine: "No export engine",
  no_file_generation: "No export file generation",
  no_export_run_persistence: "No export run persistence",
  no_final_approval: "No final approval workflow",
  no_export_audit_trail: "No export run / audit trail",
  no_external_posting: "No external posting (ResMan / Yardi / AppFolio)",
  readiness_boundary_not_clear: "Readiness boundary not clear",
  profile_not_persisted: "Selected profile is not persisted",
  profile_validation_blocked: "Profile validation blocked",
  profile_validation_needs_review: "Profile validation needs review",
  no_rows_to_export: "No rows to export",
  row_issues_present: "Row issues present",
};

function ExportRunDraftPanel({
  data,
  source,
  loading,
  error,
  onRetry,
  stale,
  lastUpdatedAt,
  // Phase 5B — manual save action + saved-record success card +
  // notes input + stale-after-save notice. The persistence hook
  // is manual-click only; no useEffect auto-save.
  persistBusy,
  persistError,
  persistedRecord,
  persistedAt,
  draftNotes,
  onChangeDraftNotes,
  onSaveDraftAuditRecord,
  onClearPersistStatus,
  persistDisabled,
  staleAfterSave,
}: {
  data: BackendExportRunDraftResult | null;
  source: "backend" | "loading" | "unavailable" | "error";
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  // Phase 4H — when ``stale=true``, the panel is showing
  // last-known-good data while a fresh request is in flight or
  // just failed. The body labels itself accordingly.
  stale: boolean;
  lastUpdatedAt: string | null;
  // Phase 5B — persistence wiring.
  persistBusy: boolean;
  persistError: string | null;
  persistedRecord: PersistedExportRunRead | null;
  persistedAt: string | null;
  draftNotes: string;
  onChangeDraftNotes: (next: string) => void;
  onSaveDraftAuditRecord: () => void;
  onClearPersistStatus: () => void;
  /** Disable the Save button when prerequisites (result / option /
   *  profile contract) are missing. */
  persistDisabled: boolean;
  /** TRUE when a record was saved AND the current diagnostic
   *  fingerprint differs from the one captured at save time. */
  staleAfterSave: boolean;
}) {
  // Pick a tone based on the draft status when we have data,
  // otherwise fall back to the source state's tone.
  const status = data?.status ?? null;
  const tone = _draftToneFor(status, source);

  // Phase 5B — Save button is enabled only when the panel has a
  // backend-evaluated draft to persist. We deliberately allow saves
  // when ``stale=true`` (the backend re-evaluates anyway) but
  // disable while a fresh request is in flight with no prior data.
  const canSaveDraft =
    !persistBusy &&
    !persistDisabled &&
    !!data &&
    source !== "loading" &&
    source !== "unavailable";

  return (
    <section
      className={cn("rounded-md border px-3 py-2.5", tone.border)}
      aria-label="Export Run Draft"
    >
      <header className="flex items-start gap-2">
        <tone.Icon className={cn("h-4 w-4 mt-0.5 shrink-0", tone.iconClass)} />
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm font-semibold", tone.title)}>
            Export Run Draft
          </p>
          <p className={cn("mt-0.5 text-[11px]", tone.detail)}>
            Diagnostic draft only — no export file is generated.
          </p>
        </div>
      </header>

      {/* Phase 4G — source banner. Tells the operator whether the
          verdict is backend-evaluated or fell back to a not-evaluated
          state. NEVER claims production-export readiness.
          Phase 4H — also surfaces stale labelling when the body
          is showing last-known-good while a fresh request is in
          flight or just failed. */}
      <DraftSourceBanner
        source={source}
        loading={loading}
        error={error}
        onRetry={onRetry}
        stale={stale}
        lastUpdatedAt={lastUpdatedAt}
      />

      {data ? (
        <DraftBody data={data} tone={tone} stale={stale} />
      ) : (
        <p className={cn("mt-2 text-[11px]", tone.detail)}>
          {source === "loading"
            ? "Evaluating export draft…"
            : source === "error"
              ? "Backend draft evaluation failed. Operational Preview remains diagnostic."
              : "Run an operational preview with export-style rows and select a saved profile before evaluating an export draft."}
        </p>
      )}

      {/* Phase 5B — persistence action area. Sits BELOW the body so
          the operator reads the verdict first, then the action.
          Manual-click only; never fires on render. */}
      <PersistDraftAuditAction
        canSave={canSaveDraft}
        busy={persistBusy}
        error={persistError}
        savedRecord={persistedRecord}
        savedAt={persistedAt}
        notes={draftNotes}
        onChangeNotes={onChangeDraftNotes}
        onSave={onSaveDraftAuditRecord}
        onClearStatus={onClearPersistStatus}
        staleAfterSave={staleAfterSave}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Phase 5B — Save Draft Audit Record action area
// ---------------------------------------------------------------------------
//
// Sits inside ``ExportRunDraftPanel``. Renders:
//   * A small notes textarea (optional — operator may leave blank).
//   * A Save button + helper text.
//   * A success card with the saved record id, phase, status, and
//     created_at — explicit "no export file was generated" disclaimer.
//   * A stale-after-save notice when the diagnostic fingerprint has
//     drifted since the last save (operator should save again to
//     create a new audit row; the existing record is left alone).
//   * An inline error banner on save failure.
//
// Tone uses cyan/blue (NOT green) so the saved card never reads as
// proof of export. Same convention the boundary + draft body use.
function PersistDraftAuditAction({
  canSave,
  busy,
  error,
  savedRecord,
  savedAt,
  notes,
  onChangeNotes,
  onSave,
  onClearStatus,
  staleAfterSave,
}: {
  canSave: boolean;
  busy: boolean;
  error: string | null;
  savedRecord: PersistedExportRunRead | null;
  savedAt: string | null;
  notes: string;
  onChangeNotes: (next: string) => void;
  onSave: () => void;
  onClearStatus: () => void;
  staleAfterSave: boolean;
}) {
  const savedAtLabel = (() => {
    if (!savedAt) return null;
    try {
      const parsed = new Date(savedAt);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toLocaleString();
      }
    } catch {
      return null;
    }
    return null;
  })();

  const recordCreatedAtLabel = (() => {
    if (!savedRecord?.created_at) return null;
    try {
      const parsed = new Date(savedRecord.created_at);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toLocaleString();
      }
    } catch {
      return null;
    }
    return null;
  })();

  return (
    <div className="mt-3 space-y-2 border-t border-gray-200 pt-2 dark:border-line">
      <div>
        <label
          className="block text-[11px] font-semibold text-gray-700 dark:text-ink-muted"
          htmlFor="persist-draft-notes"
        >
          Notes for audit record
          <span className="ml-1 text-[10px] font-normal text-gray-500 dark:text-ink-subtle">
            (optional)
          </span>
        </label>
        <textarea
          id="persist-draft-notes"
          className="mt-1 w-full resize-y rounded-md border border-gray-200 bg-white px-2 py-1 text-[12px] text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300 dark:border-line dark:bg-surface-subtle dark:text-ink dark:placeholder:text-ink-subtle"
          rows={2}
          value={notes}
          onChange={(e) => onChangeNotes(e.target.value)}
          placeholder="Optional context for the audit record. No file is generated."
          disabled={busy}
          maxLength={2000}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onSave}
          disabled={!canSave}
          title={
            canSave
              ? "Persist this diagnostic draft as an audit record. No export file is generated."
              : "Run an operational preview with a saved profile before saving an audit record."
          }
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Bookmark className="h-3.5 w-3.5" />
          )}
          {busy ? "Saving…" : "Save draft audit record"}
        </Button>
        <p className="text-[11px] text-gray-600 dark:text-ink-muted">
          Saves this diagnostic draft as an audit record. No export
          file is generated.
        </p>
      </div>

      {error && (
        <div
          className="rounded-md border border-rose-200 bg-rose-50/60 px-2 py-1.5 text-[11px] text-rose-900 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-100"
          role="alert"
        >
          <p className="font-semibold">Could not save draft audit record</p>
          <p className="mt-0.5 font-mono text-[10px] break-words">{error}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClearStatus}
            title="Dismiss the error message."
            className="mt-1"
          >
            Dismiss
          </Button>
        </div>
      )}

      {savedRecord && (
        // Cyan/blue tone — never green — so the operator can never
        // misread the success card as proof of export. Mirrors the
        // boundary + draft-body conventions.
        <div
          className="rounded-md border border-cyan-200 bg-cyan-50/60 px-2 py-1.5 text-[11px] text-cyan-900 dark:border-cyan-900 dark:bg-cyan-950/20 dark:text-cyan-100"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-600 dark:text-cyan-300" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Draft audit record saved</p>
              <ul className="mt-1 space-y-0.5 text-[11px]">
                <li>
                  <span className="font-mono text-[10px] uppercase tracking-wide text-cyan-800/80 dark:text-cyan-200/80">
                    ID:
                  </span>{" "}
                  <span className="font-mono break-all">{savedRecord.id}</span>
                </li>
                <li>
                  <span className="font-mono text-[10px] uppercase tracking-wide text-cyan-800/80 dark:text-cyan-200/80">
                    Phase:
                  </span>{" "}
                  <span className="font-mono">{savedRecord.phase}</span>
                </li>
                <li>
                  <span className="font-mono text-[10px] uppercase tracking-wide text-cyan-800/80 dark:text-cyan-200/80">
                    Status:
                  </span>{" "}
                  <span className="font-mono">
                    {_DRAFT_STATUS_LABEL[savedRecord.status] ??
                      savedRecord.status}
                  </span>
                </li>
                {recordCreatedAtLabel && (
                  <li>
                    <span className="font-mono text-[10px] uppercase tracking-wide text-cyan-800/80 dark:text-cyan-200/80">
                      Created at:
                    </span>{" "}
                    {recordCreatedAtLabel}
                  </li>
                )}
                {savedAtLabel &&
                  savedAtLabel !== recordCreatedAtLabel && (
                    <li>
                      <span className="font-mono text-[10px] uppercase tracking-wide text-cyan-800/80 dark:text-cyan-200/80">
                        Saved locally at:
                      </span>{" "}
                      {savedAtLabel}
                    </li>
                  )}
              </ul>
              <ul className="mt-1 space-y-0.5 text-[10px] text-cyan-900/90 dark:text-cyan-100/90">
                {PERSISTED_DRAFT_RECORD_DISCLAIMERS.map((line) => (
                  <li key={line}>· {line}</li>
                ))}
              </ul>
              {staleAfterSave && (
                <p className="mt-1 rounded border border-yellow-300 bg-yellow-50/70 px-1.5 py-1 text-[10px] font-semibold text-yellow-900 dark:border-yellow-900 dark:bg-yellow-950/30 dark:text-yellow-100">
                  Current preview changed after save. Save again to
                  create a new audit record; the existing record was
                  not modified.
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClearStatus}
              title="Dismiss the success card."
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface _DraftTone {
  border: string;
  title: string;
  detail: string;
  pillBorder: string;
  pillBg: string;
  pillText: string;
  Icon: LucideIcon;
  iconClass: string;
}

const _DRAFT_TONE_BY_STATUS: Record<string, _DraftTone> = {
  draft_clear: {
    // Cyan, NOT green — green would imply "ready to export". The
    // boundary panel uses the same convention.
    border:
      "border-cyan-200 bg-cyan-50/50 dark:border-cyan-900 dark:bg-cyan-950/20",
    title: "text-cyan-900 dark:text-cyan-100",
    detail: "text-cyan-900/90 dark:text-cyan-100/90",
    pillBorder: "border-cyan-200 dark:border-cyan-900",
    pillBg: "bg-cyan-50 dark:bg-cyan-950/40",
    pillText: "text-cyan-800 dark:text-cyan-200",
    Icon: Info,
    iconClass: "text-cyan-600 dark:text-cyan-300",
  },
  needs_review: {
    border:
      "border-yellow-300 bg-yellow-50/60 dark:border-yellow-900 dark:bg-yellow-950/20",
    title: "text-yellow-900 dark:text-yellow-100",
    detail: "text-yellow-900/90 dark:text-yellow-100/90",
    pillBorder: "border-yellow-200 dark:border-yellow-900",
    pillBg: "bg-yellow-50 dark:bg-yellow-950/40",
    pillText: "text-yellow-800 dark:text-yellow-200",
    Icon: AlertTriangle,
    iconClass: "text-yellow-700 dark:text-yellow-300",
  },
  blocked: {
    border:
      "border-rose-300 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/20",
    title: "text-rose-900 dark:text-rose-100",
    detail: "text-rose-900/90 dark:text-rose-100/90",
    pillBorder: "border-rose-200 dark:border-rose-900",
    pillBg: "bg-rose-50 dark:bg-rose-950/40",
    pillText: "text-rose-800 dark:text-rose-200",
    Icon: CircleAlert,
    iconClass: "text-rose-600 dark:text-rose-300",
  },
  not_available: {
    border:
      "border-gray-200 bg-gray-50/70 dark:border-line dark:bg-surface-muted",
    title: "text-gray-800 dark:text-ink",
    detail: "text-gray-700 dark:text-ink-muted",
    pillBorder: "border-gray-200 dark:border-line",
    pillBg: "bg-gray-50 dark:bg-surface-muted",
    pillText: "text-gray-700 dark:text-ink-muted",
    Icon: Info,
    iconClass: "text-gray-500 dark:text-ink-muted",
  },
};

function _draftToneFor(
  status: string | null,
  source: "backend" | "loading" | "unavailable" | "error",
): _DraftTone {
  if (status && _DRAFT_TONE_BY_STATUS[status]) {
    return _DRAFT_TONE_BY_STATUS[status]!;
  }
  // No data yet — pick a neutral tone unless there's an error.
  if (source === "error") {
    return _DRAFT_TONE_BY_STATUS.needs_review!;
  }
  return _DRAFT_TONE_BY_STATUS.not_available!;
}

function DraftSourceBanner({
  source,
  loading,
  error,
  onRetry,
  stale,
  lastUpdatedAt,
}: {
  source: "backend" | "loading" | "unavailable" | "error";
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  // Phase 4H — when ``stale=true`` AND source is loading / error,
  // the banner uses the stale-aware copy bucket so the operator
  // reads "Refreshing export draft…" / "Could not refresh export
  // draft" instead of the first-time variants.
  stale: boolean;
  // Phase 4H — ISO timestamp of when ``data`` was last loaded.
  // Renders a "Last evaluated: <localized time>" line when set.
  lastUpdatedAt: string | null;
}) {
  // Phase 4H — pick the right source-copy bucket. When ``stale`` is
  // true the loading / error cases swap to the "showing last
  // evaluated draft…" wording.
  const copy = pickExportRunDraftSourceCopy(source, stale);
  const tone = copy.tone;
  // Phase 4H — operator-facing localized time of the last successful
  // backend draft. Wrapped in a try/catch so a malformed ISO string
  // never breaks the panel render.
  let lastEvaluatedLabel: string | null = null;
  if (lastUpdatedAt) {
    try {
      const parsed = new Date(lastUpdatedAt);
      if (!Number.isNaN(parsed.getTime())) {
        lastEvaluatedLabel = parsed.toLocaleString();
      }
    } catch {
      lastEvaluatedLabel = null;
    }
  }
  const wrapClass =
    tone === "success"
      ? "border-green-200 bg-green-50/40 dark:border-green-900 dark:bg-green-950/15"
      : tone === "warning"
        ? "border-yellow-300 bg-yellow-50/50 dark:border-yellow-900 dark:bg-yellow-950/15"
        : tone === "info"
          ? "border-blue-200 bg-blue-50/40 dark:border-blue-900 dark:bg-blue-950/15"
          : "border-gray-200 bg-gray-50/50 dark:border-line dark:bg-surface-muted/60";
  const titleClass =
    tone === "success"
      ? "text-green-800 dark:text-green-200"
      : tone === "warning"
        ? "text-yellow-900 dark:text-yellow-100"
        : tone === "info"
          ? "text-blue-900 dark:text-blue-100"
          : "text-gray-800 dark:text-ink";
  const detailClass =
    tone === "success"
      ? "text-green-800/90 dark:text-green-200/90"
      : tone === "warning"
        ? "text-yellow-900/90 dark:text-yellow-100/90"
        : tone === "info"
          ? "text-blue-900/90 dark:text-blue-100/90"
          : "text-gray-700 dark:text-ink-muted";
  const Icon =
    tone === "success"
      ? CheckCircle2
      : tone === "warning"
        ? AlertTriangle
        : tone === "info"
          ? Loader2
          : Info;
  const iconClass =
    tone === "success"
      ? "text-green-600 dark:text-green-400"
      : tone === "warning"
        ? "text-yellow-700 dark:text-yellow-300"
        : tone === "info"
          ? "text-blue-600 dark:text-blue-300 animate-spin"
          : "text-gray-500 dark:text-ink-muted";
  return (
    <div
      className={cn("mt-2 rounded-md border px-2 py-1.5 text-[11px]", wrapClass)}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", iconClass)} />
        <div className="min-w-0 flex-1">
          <p className={cn("font-semibold", titleClass)}>{copy.title}</p>
          <p className={cn("mt-0.5", detailClass)}>{copy.detail}</p>
          {/* Phase 4H — last-evaluated timestamp. Always rendered when
              we have one, regardless of source, so the operator can
              see when the visible verdict was actually computed. */}
          {lastEvaluatedLabel && (
            <p
              className={cn(
                "mt-0.5 font-mono text-[10px]",
                detailClass,
              )}
              title="When the currently displayed draft was evaluated by the backend."
            >
              Last evaluated: {lastEvaluatedLabel}
            </p>
          )}
          {error && source === "error" && (
            <p className="mt-1 font-mono text-[10px] text-red-700 dark:text-red-300 break-words">
              {error}
            </p>
          )}
        </div>
        {source === "error" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRetry}
            disabled={loading}
            title="Retry export draft evaluation."
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

function DraftBody({
  data,
  tone,
  stale,
}: {
  data: BackendExportRunDraftResult;
  tone: _DraftTone;
  // Phase 4H — when ``stale=true`` the body renders a small label
  // above the status row so the operator reads the verdict as
  // last-known-good, not as the current backend state.
  stale: boolean;
}) {
  const statusLabel = _DRAFT_STATUS_LABEL[data.status] ?? data.status;
  return (
    <div className="mt-2 space-y-2">
      {/* Phase 4H — stale label. Visible only when the panel is
          showing a previously-evaluated verdict while the latest
          backend request is in flight or just failed. Always says
          "Showing last evaluated draft…" so the operator never
          misreads the body as the current backend verdict. */}
      {stale && (
        <p
          className="text-[10px] font-semibold uppercase tracking-wide text-yellow-800 dark:text-yellow-200"
          title="The draft below was evaluated earlier; Rivera is refreshing it now."
        >
          Showing last evaluated draft…
        </p>
      )}
      {/* Status row — three immutable claims plus the dynamic
          status pill. Same visual rhythm as the readiness boundary
          panel for operator familiarity. */}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-1.5 py-0.5 font-semibold uppercase tracking-wide",
            tone.pillBorder,
            tone.pillBg,
            tone.pillText,
          )}
          title="Draft verdict (operator-facing)."
        >
          Status: {statusLabel}
        </span>
        <span
          className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono uppercase tracking-wide text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted"
          title="Hard contract — always Yes in this phase."
        >
          draft_only: Yes
        </span>
        <span
          className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono uppercase tracking-wide text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted"
          title="Hard contract — always No in this phase."
        >
          finalized: No
        </span>
        <span
          className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono uppercase tracking-wide text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted"
          title="Hard contract — always No in this phase."
        >
          file_generated: No
        </span>
        <span
          className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono uppercase tracking-wide text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted"
          title="Hard contract — always No in this phase."
        >
          download_available: No
        </span>
        <span
          className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono uppercase tracking-wide text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted"
          title="Hard contract — always No in this phase."
        >
          production_export_ready: No
        </span>
      </div>

      {/* Operator headline + message */}
      <div>
        <p className={cn("text-xs font-semibold", tone.title)}>
          {data.operator_title}
        </p>
        <p className={cn("mt-0.5 text-[11px]", tone.detail)}>
          {data.operator_message}
        </p>
      </div>

      {/* Compact row summary */}
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div className="rounded border border-gray-200 px-2 py-1 dark:border-line bg-white/60 dark:bg-surface-subtle/60">
          <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
            Rows
          </p>
          <p className="text-sm font-semibold text-gray-800 dark:text-ink">
            {data.row_count}
          </p>
        </div>
        <div className="rounded border border-gray-200 px-2 py-1 dark:border-line bg-white/60 dark:bg-surface-subtle/60">
          <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
            Blocked rows
          </p>
          <p className="text-sm font-semibold text-rose-700 dark:text-rose-200">
            {data.blocked_row_count}
          </p>
        </div>
        <div className="rounded border border-gray-200 px-2 py-1 dark:border-line bg-white/60 dark:bg-surface-subtle/60">
          <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
            Warning rows
          </p>
          <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-200">
            {data.warning_row_count}
          </p>
        </div>
      </div>

      {/* Reasons + next steps in a compact <details> so the operator
          can choose to look at the full lists. */}
      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-gray-700 dark:text-ink-muted">
          Why this draft is {statusLabel.toLowerCase()} (
          {data.reasons.length} reason
          {data.reasons.length === 1 ? "" : "s"}) · Next steps (
          {data.next_steps.length})
        </summary>
        <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="rounded border border-gray-200 px-2 py-1.5 dark:border-line bg-white/60 dark:bg-surface-subtle/60">
            <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
              Reasons
            </p>
            <ul className="mt-1 space-y-0.5 text-[11px] text-gray-800 dark:text-ink">
              {data.reasons.map((reason) => (
                <li key={reason} className="flex items-start gap-1.5">
                  <span className="mt-0.5 shrink-0 text-gray-400 dark:text-ink-subtle">
                    •
                  </span>
                  <span>
                    {_DRAFT_REASON_LABEL[reason] ?? reason}{" "}
                    <span className="font-mono text-[10px] text-gray-400 dark:text-ink-subtle">
                      {reason}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded border border-gray-200 px-2 py-1.5 dark:border-line bg-white/60 dark:bg-surface-subtle/60">
            <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 dark:text-ink-subtle">
              Next steps
            </p>
            <ol className="mt-1 space-y-0.5 text-[11px] text-gray-800 dark:text-ink list-decimal list-inside">
              {data.next_steps.map((step, idx) => (
                <li key={idx}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      </details>

      {/* Disclaimers — always visible small print */}
      <p className="mt-2 text-[10px] text-gray-600 dark:text-ink-muted">
        {data.disclaimers.join(" · ")}
      </p>
    </div>
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
// Phase 3G — Copy full report row (renders directly under the
// Operational Summary card)
// ---------------------------------------------------------------------------
//
// Compact row that exposes a single "Copy full report" action +
// a transient toast. Distinct from the per-section copy buttons
// (Copy diagnostics / Copy preview / Copy profile check) so the
// operator can grab one consolidated artefact without stitching
// three reports together.

function FullReportCopyRow({
  copyStatus,
  onCopy,
}: {
  copyStatus: { type: "success" | "error"; message: string } | null;
  onCopy: () => void;
}) {
  return (
    <section
      className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle px-3 py-2"
      aria-label="Copy full operational report"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-800 dark:text-ink">
            Copy full report
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500 dark:text-ink-muted">
            Copies a diagnostic Markdown report combining the
            operational summary, review diagnostics, export-style
            preview, and the selected profile check. No file is
            generated.
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
            variant="secondary"
            size="sm"
            onClick={onCopy}
            title="Copy a consolidated diagnostic Markdown report to the clipboard. No file is generated."
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
            Copy full report
          </Button>
        </div>
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
