"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { exportProfilesApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  PersistedExportProfileRead,
  PersistedExportProfileSummary,
  PersistedExportProfileTargetSystem,
} from "@/types/export-profile-persistence";

import { usePersistedExportProfiles } from "@/features/invoice-templates/hooks/usePersistedExportProfiles";

import { useExportProfileMutations } from "../hooks/useExportProfileMutations";
import {
  EXPORT_PROFILE_TARGET_SYSTEM_LABEL,
  buildCreatePayload,
  buildEmptyForm,
  buildFormFromRecord,
  buildUpdatePayload,
  type ExportProfileFormState,
} from "../lib/export-profile-form";
import {
  EXPORT_PROFILE_STARTERS,
  buildStarterForm,
} from "../lib/export-profile-starters";
import { ExportProfileEditorPanel } from "./ExportProfileEditorPanel";

/**
 * Phase 4C — Export Profile management page.
 *
 * Sits under Settings → Export Profiles. Displays the persisted
 * profile catalog as a table; supports create-from-starter, edit,
 * set-default, and deactivate. Diagnostic only — saving / editing
 * a profile NEVER triggers an export run, file generation, or
 * external posting.
 *
 * The list reload uses the same Phase 4B ``usePersistedExportProfiles``
 * hook so this page stays in lockstep with the picker in
 * ``OperationalResolutionPreviewPanel``.
 */

export function ExportProfilesPage() {
  // List loader — defaults to active rows; the page surfaces a
  // separate toggle if/when an admin path is added later. We
  // include inactive rows (``isActive=null``) so the operator can
  // see + reactivate soft-deleted profiles inline. Built-in
  // catalogs are NOT shown here — they're code-shipped starter
  // profiles, not catalog rows.
  const list = usePersistedExportProfiles({
    enabled: true,
    isActive: null,
  });
  const mutations = useExportProfileMutations();

  // ---- Editor modal state -------------------------------------
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"create" | "edit">("create");
  const [editorState, setEditorState] = useState<ExportProfileFormState>(
    buildEmptyForm({ targetSystem: "custom_csv" }),
  );

  // ---- Starter chooser modal ----------------------------------
  const [starterChooserOpen, setStarterChooserOpen] = useState(false);

  // ---- Deactivate confirmation modal --------------------------
  const [confirmDeactivate, setConfirmDeactivate] =
    useState<PersistedExportProfileSummary | null>(null);

  // ---- Phase 4D — edit-load error state ----------------------
  // Tracks the profile id we tried to load + the raw error message
  // so the page can render an inline alert with a Retry control.
  // Cleared whenever a fresh edit succeeds OR the operator opens
  // the starter chooser / closes the alert.
  const [editLoadError, setEditLoadError] = useState<{
    profileId: string;
    profileName: string | null;
    message: string;
  } | null>(null);
  const [editLoading, setEditLoading] = useState(false);

  // Sort active first, then by updated_at desc — list endpoint
  // already orders by updated_at desc. Active-first ensures
  // soft-deleted rows sink to the bottom even if they were
  // modified more recently.
  const orderedProfiles = useMemo(() => {
    const items = [...list.profiles];
    items.sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      return b.updated_at.localeCompare(a.updated_at);
    });
    return items;
  }, [list.profiles]);

  // ---- Handlers -----------------------------------------------
  const handleOpenStarterChooser = useCallback(() => {
    mutations.clearStatus();
    setEditLoadError(null);
    setStarterChooserOpen(true);
  }, [mutations]);

  const handlePickStarter = useCallback(
    (targetSystem: PersistedExportProfileTargetSystem) => {
      setStarterChooserOpen(false);
      mutations.clearStatus();
      setEditLoadError(null);
      setEditorState(buildStarterForm(targetSystem));
      setEditorMode("create");
      setEditorOpen(true);
    },
    [mutations],
  );

  const handleOpenEdit = useCallback(
    async (profile: PersistedExportProfileSummary | { id: string; name: string | null }) => {
      mutations.clearStatus();
      setEditLoadError(null);
      setEditLoading(true);
      try {
        const record = await exportProfilesApi.get(profile.id);
        setEditorState(buildFormFromRecord(record));
        setEditorMode("edit");
        setEditorOpen(true);
        setEditLoadError(null);
      } catch (err) {
        // Phase 4D — surface as a UI alert (was console-only). The
        // operator gets a Retry control via ``editLoadError`` so
        // they don't have to re-find the row.
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "Unknown error.";
        setEditLoadError({
          profileId: profile.id,
          profileName: profile.name ?? null,
          message,
        });
        // Don't open the editor in a partially-populated state.
        setEditorOpen(false);
      } finally {
        setEditLoading(false);
      }
    },
    [mutations],
  );

  const handleRetryEditLoad = useCallback(() => {
    if (!editLoadError) return;
    void handleOpenEdit({
      id: editLoadError.profileId,
      name: editLoadError.profileName,
    });
  }, [editLoadError, handleOpenEdit]);

  const handleSetDefault = useCallback(
    async (profile: PersistedExportProfileSummary) => {
      mutations.clearStatus();
      setEditLoadError(null);
      try {
        await mutations.updateProfile(profile.id, { is_default: true });
        list.retry();
      } catch {
        // Phase 4D — error surfaced via ``mutations.error`` page
        // banner. We deliberately do NOT clear the failed state
        // automatically; the operator decides whether to Retry,
        // pick a different default, or move on.
      }
    },
    [mutations, list],
  );

  const handleConfirmDeactivate = useCallback(async () => {
    if (!confirmDeactivate) return;
    try {
      await mutations.deactivateProfile(confirmDeactivate.id);
      // Success path — close the confirm modal + reload.
      list.retry();
      setConfirmDeactivate(null);
    } catch {
      // Phase 4D — keep the confirm modal OPEN on backend error
      // so the operator can read the error pill and Retry without
      // re-finding the row in the catalog. The modal's Confirm
      // button stays disabled while ``mutations.busy`` is true,
      // which the modal already handles.
    }
  }, [confirmDeactivate, mutations, list]);

  const handleSave = useCallback(
    async (state: ExportProfileFormState) => {
      let saved: PersistedExportProfileRead;
      if (editorMode === "create") {
        saved = await mutations.createProfile(buildCreatePayload(state));
      } else if (state.id) {
        saved = await mutations.updateProfile(
          state.id,
          buildUpdatePayload(state),
        );
      } else {
        // Defensive — edit mode without an id should never happen.
        throw new Error("Cannot save edit: missing profile id.");
      }
      // Refresh list + close modal. If the parent surface re-opens
      // the editor after this, the next initialState will carry the
      // freshly-saved row.
      list.retry();
      setEditorOpen(false);
      setEditorState(buildFormFromRecord(saved));
    },
    [editorMode, mutations, list],
  );

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-ink">
          Export Profiles
        </h1>
        <p className="text-sm text-gray-600 dark:text-ink-muted">
          Manage saved export profile definitions. Used by the
          Operational Preview&apos;s Export Profile Check.
        </p>
      </header>

      {/* Boundary banner — always visible above the catalog. */}
      <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
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

      {/* Mutation feedback */}
      {mutations.error && (
        <InlineAlert tone="error">{mutations.error}</InlineAlert>
      )}
      {!mutations.error && mutations.lastCompletedAt && (
        <div className="rounded-md border border-green-200 bg-green-50/60 px-3 py-1.5 text-[11px] text-green-800 dark:border-green-900 dark:bg-green-950/20 dark:text-green-200">
          <CheckCircle2 className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
          Saved.
        </div>
      )}

      {/* Phase 4D — edit-load error alert. Surfaced when GET /
          export-profiles/{id} fails so the operator gets a Retry
          control without re-finding the row. Cleared on the next
          successful Edit / opening Create-from-starter / closing
          the alert. */}
      {editLoadError && (
        <InlineAlert
          tone="warning"
          title="Could not load this export profile"
          action={
            <div className="inline-flex items-center gap-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleRetryEditLoad}
                disabled={editLoading}
                loading={editLoading}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditLoadError(null)}
              >
                Dismiss
              </Button>
            </div>
          }
        >
          {editLoadError.profileName ? (
            <p>
              Could not load{" "}
              <span className="font-semibold">{editLoadError.profileName}</span>
              . Please retry.
            </p>
          ) : (
            <p>Could not load this export profile. Please retry.</p>
          )}
          <p className="mt-1 font-mono text-[11px] break-words">
            {editLoadError.message}
          </p>
        </InlineAlert>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleOpenStarterChooser}
          >
            <Plus className="h-3.5 w-3.5" />
            Create from starter
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={list.retry}
            disabled={list.loading}
            title="Reload the saved profile catalog."
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
        <span className="text-[11px] text-gray-500 dark:text-ink-muted">
          {list.profiles.length} saved profile
          {list.profiles.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* List */}
      <ProfileCatalog
        profiles={orderedProfiles}
        loading={list.loading}
        error={list.error}
        mutationsBusy={mutations.busy || editLoading}
        onRetry={list.retry}
        onEdit={(p) => handleOpenEdit(p)}
        onSetDefault={handleSetDefault}
        onDeactivate={(p) => setConfirmDeactivate(p)}
      />

      {/* ---- Modals ------------------------------------------- */}
      <ExportProfileEditorPanel
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        initialState={editorState}
        mode={editorMode}
        busy={mutations.busy}
        externalError={mutations.error}
        onSave={handleSave}
      />

      <StarterChooserModal
        open={starterChooserOpen}
        onClose={() => setStarterChooserOpen(false)}
        onPick={handlePickStarter}
      />

      <DeactivateConfirmModal
        profile={confirmDeactivate}
        busy={mutations.busy}
        // Phase 4D — surface the deactivate error inline so the
        // operator can read it without losing the modal context.
        error={confirmDeactivate ? mutations.error : null}
        onCancel={() => {
          setConfirmDeactivate(null);
          mutations.clearStatus();
        }}
        onConfirm={handleConfirmDeactivate}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Catalog list
// ---------------------------------------------------------------------------

function ProfileCatalog({
  profiles,
  loading,
  error,
  mutationsBusy,
  onRetry,
  onEdit,
  onSetDefault,
  onDeactivate,
}: {
  profiles: PersistedExportProfileSummary[];
  loading: boolean;
  error: string | null;
  mutationsBusy: boolean;
  onRetry: () => void;
  onEdit: (p: PersistedExportProfileSummary) => void;
  onSetDefault: (p: PersistedExportProfileSummary) => void;
  onDeactivate: (p: PersistedExportProfileSummary) => void;
}) {
  if (loading && profiles.length === 0) {
    return (
      <div className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle px-3 py-6 text-center text-sm text-gray-600 dark:text-ink-muted">
        <Loader2 className="inline h-4 w-4 mr-2 animate-spin text-brand-600 dark:text-brand-50" />
        Loading saved profiles…
      </div>
    );
  }
  if (error && profiles.length === 0) {
    return (
      <InlineAlert
        tone="error"
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onRetry}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        }
      >
        Could not load saved profiles: {error}
      </InlineAlert>
    );
  }
  if (profiles.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-gray-300 bg-white dark:border-line dark:bg-surface-subtle px-3 py-6 text-center text-sm text-gray-600 dark:text-ink-muted">
        No saved profiles yet. Use{" "}
        <span className="font-semibold">Create from starter</span> to
        seed one from a built-in template.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-line">
      {error && (
        <div className="px-3 py-1.5 text-[11px] bg-yellow-50 text-yellow-900 border-b border-yellow-200 dark:bg-yellow-950/20 dark:text-yellow-100 dark:border-yellow-900">
          <AlertTriangle className="inline h-3 w-3 mr-1 -mt-0.5" />
          Showing the previously-loaded list. Latest refresh failed:{" "}
          {error}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="bg-gray-50 dark:bg-surface-muted">
          <tr className="text-left text-[10.5px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle">
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Target</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Default</th>
            <th className="px-3 py-2">Version</th>
            <th className="px-3 py-2">Source</th>
            <th className="px-3 py-2">Updated</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-line/60">
          {profiles.map((profile) => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              busy={mutationsBusy}
              onEdit={() => onEdit(profile)}
              onSetDefault={() => onSetDefault(profile)}
              onDeactivate={() => onDeactivate(profile)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProfileRow({
  profile,
  busy,
  onEdit,
  onSetDefault,
  onDeactivate,
}: {
  profile: PersistedExportProfileSummary;
  busy: boolean;
  onEdit: () => void;
  onSetDefault: () => void;
  onDeactivate: () => void;
}) {
  const targetLabel =
    EXPORT_PROFILE_TARGET_SYSTEM_LABEL[profile.target_system] ??
    profile.target_system;
  return (
    <tr className={cn(!profile.is_active && "bg-gray-50/60 dark:bg-surface-muted/30")}>
      <td className="px-3 py-2 text-gray-900 dark:text-ink">
        <p className="font-medium">{profile.name}</p>
        {profile.description && (
          <p className="text-[11px] text-gray-500 dark:text-ink-muted line-clamp-2">
            {profile.description}
          </p>
        )}
      </td>
      <td className="px-3 py-2">
        <span className="inline-flex items-center rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] text-gray-700 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
          {targetLabel}
        </span>
      </td>
      <td className="px-3 py-2">
        {profile.is_active ? (
          <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
            Active
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-gray-600 dark:border-line dark:bg-surface-muted dark:text-ink-muted">
            Deactivated
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        {profile.is_default ? (
          <span className="inline-flex items-center rounded-full border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950/40 dark:text-cyan-200">
            default
          </span>
        ) : (
          <span className="text-gray-400 dark:text-ink-subtle">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-[12px] font-mono text-gray-700 dark:text-ink-muted">
        v{profile.version}
      </td>
      <td className="px-3 py-2 text-[11px] text-gray-600 dark:text-ink-muted">
        {profile.source}
      </td>
      <td className="px-3 py-2 text-[11px] text-gray-500 dark:text-ink-muted">
        {new Date(profile.updated_at).toLocaleString()}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="inline-flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onEdit}
            disabled={busy}
          >
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onSetDefault}
            disabled={busy || !profile.is_active || profile.is_default}
            title={
              !profile.is_active
                ? "Re-activate the profile before setting it as default."
                : profile.is_default
                  ? "Already the default for this target system."
                  : "Mark this profile as the default for its target system."
            }
          >
            Set default
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDeactivate}
            disabled={busy || !profile.is_active}
            title={
              !profile.is_active
                ? "Profile is already deactivated."
                : "Soft-deactivate this profile (no hard delete)."
            }
          >
            Deactivate
          </Button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Starter chooser modal
// ---------------------------------------------------------------------------

function StarterChooserModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (targetSystem: PersistedExportProfileTargetSystem) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Choose a starter" size="lg">
      <div className="space-y-3">
        <p className="text-xs text-gray-600 dark:text-ink-muted">
          Pick a starter as the foundation. You&apos;ll review and
          adjust the settings + columns before saving.
        </p>
        <ul className="space-y-2">
          {EXPORT_PROFILE_STARTERS.map((s) => (
            <li
              key={s.id}
              className="rounded-md border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-800 dark:text-ink">
                    {s.label}
                  </p>
                  <p className="mt-0.5 text-[11px] text-gray-600 dark:text-ink-muted">
                    {s.description}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => onPick(s.id)}
                >
                  Use this starter
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Deactivate confirmation
// ---------------------------------------------------------------------------

function DeactivateConfirmModal({
  profile,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  profile: PersistedExportProfileSummary | null;
  busy: boolean;
  /** Phase 4D — backend error from the deactivate mutation. When
   *  set, the modal stays OPEN so the operator can read the error
   *  inline and Retry without re-finding the row. */
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!profile) return null;
  return (
    <Modal
      open={true}
      onClose={onCancel}
      title="Deactivate profile"
      size="md"
    >
      <div className="space-y-3 text-sm text-gray-800 dark:text-ink">
        <p>
          Deactivate <span className="font-semibold">{profile.name}</span>
          ? The profile stays in the catalog but is hidden from the
          Operational Preview picker. Operators with the management
          page can re-activate it later.
        </p>
        <p className="text-[11px] text-gray-600 dark:text-ink-muted">
          This action does not delete the profile or trigger any
          export side effect.
        </p>
        {error && (
          <InlineAlert tone="error">
            <p>Deactivate failed:</p>
            <p className="mt-0.5 font-mono text-[11px] break-words">
              {error}
            </p>
          </InlineAlert>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            loading={busy}
          >
            {error ? "Retry deactivate" : "Deactivate"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
