"use client";

import { Info, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";

import {
  EXPORT_PROFILE_TARGET_SYSTEMS,
  EXPORT_PROFILE_TARGET_SYSTEM_LABEL,
  buildCreatePayload,
  buildUpdatePayload,
  emptyFormErrors,
  hasFormErrors,
  validateForm,
  type ExportProfileFormErrors,
  type ExportProfileFormState,
} from "../lib/export-profile-form";
import { ExportProfileColumnsEditor } from "./ExportProfileColumnsEditor";
import { ExportProfileSettingsEditor } from "./ExportProfileSettingsEditor";

/**
 * Phase 4C — Modal editor for create + edit.
 *
 * The parent (ExportProfilesPage) owns ``initialState`` and the
 * Save / Deactivate handlers; this component owns the editable
 * form state, runs validation on Save, and forwards the payload.
 *
 * Strict scope:
 *   * Diagnostic only — saving a profile NEVER triggers an export
 *     run, file generation, or external posting.
 *   * Hard contract banner is always visible above the form.
 *   * No silent submit — Save shows inline errors, never blocks
 *     the modal close.
 */

export interface ExportProfileEditorPanelProps {
  open: boolean;
  onClose: () => void;
  /** Initial form state. Caller resets this when switching from
   *  edit-row-A to create-from-starter so the editor doesn't
   *  carry stale fields. */
  initialState: ExportProfileFormState;
  /** ``"create"`` | ``"edit"``. Drives modal title + button copy. */
  mode: "create" | "edit";
  busy: boolean;
  /** Top-level backend error (e.g. 422 message). Cleared by parent
   *  when the modal opens. */
  externalError: string | null;
  /** Resolved with the saved record on success. The parent reloads
   *  the list + closes the modal. Throws on backend rejection. */
  onSave: (state: ExportProfileFormState) => Promise<void>;
}

export function ExportProfileEditorPanel({
  open,
  onClose,
  initialState,
  mode,
  busy,
  externalError,
  onSave,
}: ExportProfileEditorPanelProps) {
  const [state, setState] = useState<ExportProfileFormState>(initialState);
  const [errors, setErrors] = useState<ExportProfileFormErrors>(
    emptyFormErrors(),
  );

  // Reset the form state whenever the modal opens with a new
  // initialState. Re-renders that don't change ``initialState`` or
  // ``open`` leave the in-progress edits alone.
  useEffect(() => {
    if (!open) return;
    setState(initialState);
    setErrors(emptyFormErrors());
  }, [open, initialState]);

  const targetLabel = useMemo(
    () => EXPORT_PROFILE_TARGET_SYSTEM_LABEL[state.target_system] ?? state.target_system,
    [state.target_system],
  );

  const handleSave = async () => {
    const { errors: nextErrors, sanitized } = validateForm(state);
    setErrors(nextErrors);
    if (hasFormErrors(nextErrors)) return;
    try {
      await onSave(sanitized);
    } catch {
      // Parent surfaces the backend error via externalError; we
      // intentionally swallow here so the modal stays open.
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        mode === "create"
          ? "Create export profile"
          : `Edit export profile · v${state.version}`
      }
      size="xl"
    >
      <div className="space-y-4 max-h-[72vh] overflow-y-auto pr-1">
        {/* Boundary banner — always visible. */}
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
          <p className="font-semibold">
            Saved profiles do not enable production export yet
          </p>
          <p className="mt-0.5">
            Export Profiles define column order, formatting, and
            validation rules for future exports. Rivera still does
            not generate export files, create export runs, or post
            to external accounting systems.
          </p>
        </div>

        {externalError && (
          <InlineAlert tone="error">{externalError}</InlineAlert>
        )}
        {hasFormErrors(errors) && errors.form.length > 0 && (
          <InlineAlert tone="warning" title="Resolve the following before saving">
            <ul className="list-disc list-inside space-y-0.5">
              {errors.form.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </InlineAlert>
        )}

        {/* ---- Identity --------------------------------------- */}
        <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle px-3 py-2 space-y-2">
          <header className="text-sm font-semibold text-gray-800 dark:text-ink">
            Profile identity
          </header>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-ink-muted">
                Name
              </span>
              <input
                type="text"
                value={state.name}
                onChange={(e) =>
                  setState((s) => ({ ...s, name: e.target.value }))
                }
                placeholder="e.g. ResMan — Rivera tenant import"
                disabled={busy}
                className={cn(
                  "rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 outline-none",
                  "focus:ring-2 focus:ring-brand-500",
                  "dark:bg-surface dark:text-ink dark:border-line",
                )}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-ink-muted">
                Target system
              </span>
              <select
                value={state.target_system}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    target_system:
                      e.target.value as ExportProfileFormState["target_system"],
                  }))
                }
                disabled={busy || mode === "edit"}
                title={
                  mode === "edit"
                    ? "Target system can't change after a profile is saved."
                    : undefined
                }
                className={cn(
                  "rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 outline-none",
                  "focus:ring-2 focus:ring-brand-500",
                  "dark:bg-surface dark:text-ink dark:border-line",
                  "disabled:opacity-60 disabled:cursor-not-allowed",
                )}
              >
                {EXPORT_PROFILE_TARGET_SYSTEMS.map((ts) => (
                  <option key={ts} value={ts}>
                    {EXPORT_PROFILE_TARGET_SYSTEM_LABEL[ts] ?? ts}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5 sm:col-span-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-ink-muted">
                Description
              </span>
              <textarea
                value={state.description}
                onChange={(e) =>
                  setState((s) => ({ ...s, description: e.target.value }))
                }
                placeholder={`Describe what this ${targetLabel} profile is for.`}
                disabled={busy}
                rows={2}
                className={cn(
                  "rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 outline-none",
                  "focus:ring-2 focus:ring-brand-500",
                  "dark:bg-surface dark:text-ink dark:border-line",
                )}
              />
            </label>
            <label className="flex flex-col gap-0.5 sm:col-span-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-ink-muted">
                Notes
              </span>
              <textarea
                value={state.notes}
                onChange={(e) =>
                  setState((s) => ({ ...s, notes: e.target.value }))
                }
                placeholder="Operator-only notes (paste-into-Slack-friendly)."
                disabled={busy}
                rows={2}
                className={cn(
                  "rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 outline-none",
                  "focus:ring-2 focus:ring-brand-500",
                  "dark:bg-surface dark:text-ink dark:border-line",
                )}
              />
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-ink select-none">
              <input
                type="checkbox"
                checked={state.is_default}
                onChange={(e) =>
                  setState((s) => ({ ...s, is_default: e.target.checked }))
                }
                disabled={busy}
                className="h-4 w-4"
              />
              Default for {targetLabel}
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-ink select-none">
              <input
                type="checkbox"
                checked={state.is_active}
                onChange={(e) =>
                  setState((s) => ({ ...s, is_active: e.target.checked }))
                }
                disabled={busy}
                className="h-4 w-4"
              />
              Active
            </label>
          </div>
          {mode === "edit" && (
            <p className="text-[11px] text-gray-500 dark:text-ink-muted">
              <Info className="inline h-3 w-3 mr-1 -mt-0.5" />
              Editing settings or columns increments the row's
              version. Pure metadata edits (name, description, notes,
              active/default flags) leave the version unchanged.
            </p>
          )}
        </section>

        {/* ---- File-level settings ---------------------------- */}
        <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle px-3 py-2 space-y-2">
          <header className="text-sm font-semibold text-gray-800 dark:text-ink">
            File-level settings
          </header>
          <ExportProfileSettingsEditor
            value={state.settings}
            onChange={(next) =>
              setState((s) => ({ ...s, settings: next }))
            }
            disabled={busy}
          />
        </section>

        {/* ---- Columns ---------------------------------------- */}
        <section className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle px-3 py-2 space-y-2">
          <header className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-gray-800 dark:text-ink">
              Columns
            </p>
            <p className="text-[11px] text-gray-500 dark:text-ink-muted">
              Order = output order. Keys must be unique.
            </p>
          </header>
          <ExportProfileColumnsEditor
            columns={state.columns}
            onChange={(next) =>
              setState((s) => ({ ...s, columns: next }))
            }
            errors={errors.columns}
            disabled={busy}
          />
        </section>

        {/* ---- Footer actions --------------------------------- */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={busy}
            loading={busy}
          >
            {busy && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            )}
            {mode === "create" ? "Save new profile" : "Save changes"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Re-export the payload builders so the page can call them with
// the validated form state without re-importing the form module.
export { buildCreatePayload, buildUpdatePayload };
