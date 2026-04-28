"use client";

import { Loader2, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { getApiErrorMessage, invoiceTemplatesApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { InvoiceTemplateSummary } from "@/types/invoice-template";

import { OperationalResolutionPreviewPanel } from "./OperationalResolutionPreviewPanel";

/**
 * Phase 3C — Operational Preview launcher.
 *
 * Orchestrates the two-step "pick a template, then preview" flow
 * needed by surfaces that already know document/batch context but
 * NOT which Import Template the operator wants to test against —
 * i.e. the production review surface and the batch detail header.
 *
 * Flow:
 *
 *   Button click
 *       ↓
 *   Template chooser Modal (lists saved templates,
 *       loads via the existing invoiceTemplatesApi.list())
 *       ↓
 *   Operator picks → chooser closes
 *       ↓
 *   OperationalResolutionPreviewPanel opens with all
 *       launch context props pre-filled
 *
 * The two modals never overlap — the chooser closes before the
 * preview opens, mirroring the Phase 1G stacking pattern Health
 * Map already uses.
 *
 * Diagnostic-only — the launcher is a pure UI orchestrator. It
 * never mutates the document, batch, template, or any DB row.
 */

interface OperationalPreviewLauncherProps {
  /** Button label — defaults to "Operational Preview". */
  label?: string;
  /** Visual variant for the trigger button. */
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  /** Optional pre-selected template id (skips the chooser when set). */
  initialTemplateId?: string | null;
  /** Document context — when supplied, prefills the preview panel. */
  documentId?: string | null;
  /** Batch context — when supplied, prefills the preview panel. */
  batchId?: string | null;
  /** Mapping of canonical-field key → value (extracted invoice facts). */
  initialExtractedFacts?: Record<string, unknown>;
  /** Mapping of vendor / property / gl → string. */
  initialCatalogHints?: Record<string, unknown>;
  /** Caller-side metadata merged into the request's document_metadata. */
  initialDocumentMetadata?: Record<string, unknown>;
  /** Banner label inside the preview panel — e.g. "Document: epb-march.pdf". */
  launchContextLabel?: string;
  /** Optional one-line note inside the preview panel banner. */
  contextNotice?: string;
  /** Disabled state from the host (e.g. invoice not yet loaded). */
  disabled?: boolean;
}

export function OperationalPreviewLauncher({
  label = "Operational Preview",
  variant = "secondary",
  size = "sm",
  initialTemplateId,
  documentId,
  batchId,
  initialExtractedFacts,
  initialCatalogHints,
  initialDocumentMetadata,
  launchContextLabel,
  contextNotice,
  disabled = false,
}: OperationalPreviewLauncherProps) {
  // Modal-stack: only one of these is open at a time. The chooser
  // closes BEFORE the preview opens so we never stack two Modals.
  const [chooserOpen, setChooserOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Selected template — either pre-supplied by the caller or chosen
  // via the chooser. Stored in state so the operator can re-launch
  // the preview from the same surface with the same template.
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    initialTemplateId ?? null,
  );
  const [selectedTemplateName, setSelectedTemplateName] = useState<
    string | null
  >(null);

  // Template list state — fetched lazily when the chooser opens.
  const [templates, setTemplates] = useState<InvoiceTemplateSummary[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);

  // Click handler — if a template is already selected, skip the
  // chooser and open the preview directly.
  const handleClick = useCallback(() => {
    if (selectedTemplateId) {
      setPreviewOpen(true);
      return;
    }
    setChooserOpen(true);
  }, [selectedTemplateId]);

  // Lazy-load templates when the chooser opens. Re-fetches on every
  // open so a template added in another tab shows up.
  useEffect(() => {
    if (!chooserOpen) return;
    let cancelled = false;
    (async () => {
      setLoadingTemplates(true);
      setTemplatesError(null);
      try {
        const list = await invoiceTemplatesApi.list(200, 0);
        if (cancelled) return;
        setTemplates(list.items ?? []);
      } catch (err) {
        if (cancelled) return;
        setTemplatesError(
          getApiErrorMessage(err, "Could not load import templates."),
        );
      } finally {
        if (!cancelled) setLoadingTemplates(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chooserOpen]);

  const handleConfirmChoice = useCallback(() => {
    if (!selectedTemplateId) return;
    const found = templates.find((t) => t.id === selectedTemplateId);
    setSelectedTemplateName(found?.name ?? null);
    setChooserOpen(false);
    // Defer opening the preview to the next tick so the chooser
    // can fully unmount before the preview's own modal mounts —
    // avoids any same-tick scroll-lock contention.
    setTimeout(() => setPreviewOpen(true), 0);
  }, [selectedTemplateId, templates]);

  const handleClosePreview = useCallback(() => {
    setPreviewOpen(false);
  }, []);

  const handleChangeTemplate = useCallback(() => {
    // Operator wants to switch templates without re-launching from
    // the host surface. Close the preview, open the chooser.
    setPreviewOpen(false);
    setSelectedTemplateId(null);
    setSelectedTemplateName(null);
    setTimeout(() => setChooserOpen(true), 0);
  }, []);

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={handleClick}
        disabled={disabled}
        title="Run the operational resolution pipeline against this context (diagnostic only)."
      >
        <Workflow className="h-3.5 w-3.5" />
        {label}
      </Button>

      {/* ---- Template chooser modal ----------------------------- */}
      <Modal
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        title="Pick an import template"
        size="md"
      >
        <div className="space-y-3 text-sm">
          <p className="text-xs text-gray-600 dark:text-ink-muted">
            Operational Preview runs a saved import template against
            this {launchContextLabel ? "context" : "request"}. Pick
            which template to test — you can change it any time.
          </p>
          {loadingTemplates && (
            <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-ink-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-600 dark:text-brand-50" />
              Loading import templates…
            </div>
          )}
          {templatesError && !loadingTemplates && (
            <InlineAlert tone="error">{templatesError}</InlineAlert>
          )}
          {!loadingTemplates && !templatesError && templates.length === 0 && (
            <InlineAlert tone="warning">
              No saved import templates yet. Create one in Import
              Builder before running an Operational Preview.
            </InlineAlert>
          )}
          {!loadingTemplates && !templatesError && templates.length > 0 && (
            <select
              value={selectedTemplateId ?? ""}
              onChange={(e) => setSelectedTemplateId(e.target.value || null)}
              className={cn(
                "w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-800 outline-none",
                "focus:ring-2 focus:ring-brand-500",
                "dark:bg-surface dark:text-ink dark:border-line",
              )}
            >
              <option value="">— Select a template —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100 dark:border-line/60">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setChooserOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleConfirmChoice}
              disabled={!selectedTemplateId}
            >
              <Workflow className="h-3.5 w-3.5" />
              Continue
            </Button>
          </div>
        </div>
      </Modal>

      {/* ---- Preview panel -------------------------------------- */}
      {selectedTemplateId && (
        <OperationalResolutionPreviewPanel
          isOpen={previewOpen}
          onClose={handleClosePreview}
          templateId={selectedTemplateId}
          templateName={selectedTemplateName}
          // The launcher does NOT know whether the chosen template
          // has unsaved local edits (it's read separately in Import
          // Builder), so we always treat it as clean from here. The
          // template's saved version is what the backend reads
          // anyway.
          hasUnsavedChanges={false}
          isDraft={false}
          canSave={false}
          saving={false}
          // Document/batch surfaces don't have a save handler for
          // the chosen template — the Save then preview flow is
          // hidden.
          initialDocumentId={documentId ?? null}
          initialBatchId={batchId ?? null}
          initialExtractedFacts={initialExtractedFacts}
          initialCatalogHints={initialCatalogHints}
          initialDocumentMetadata={initialDocumentMetadata}
          launchContextLabel={launchContextLabel}
          contextNotice={
            contextNotice ??
            (selectedTemplateName
              ? `Running against template "${selectedTemplateName}". Click below to change template.`
              : undefined)
          }
        />
      )}

      {/* Floating "change template" hint — only renders when the
          preview is open AND the operator has a selection. Lives
          OUTSIDE the modal so it doesn't visually compete with
          the panel content. */}
      {previewOpen && selectedTemplateName && (
        <ChangeTemplateHint
          templateName={selectedTemplateName}
          onChange={handleChangeTemplate}
        />
      )}
    </>
  );
}

function ChangeTemplateHint({
  templateName,
  onChange,
}: {
  templateName: string;
  onChange: () => void;
}) {
  // A quiet bottom-corner pill — gives the operator an out without
  // asking them to close + re-launch from the host surface.
  return (
    <div className="fixed bottom-4 right-4 z-[60] inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs shadow-sm dark:border-line dark:bg-surface-subtle">
      <span className="text-gray-600 dark:text-ink-muted">
        Template:{" "}
        <span className="font-semibold text-gray-900 dark:text-ink">
          {templateName}
        </span>
      </span>
      <button
        type="button"
        onClick={onChange}
        className="text-brand-700 hover:underline dark:text-brand-300"
      >
        Change
      </button>
    </div>
  );
}
