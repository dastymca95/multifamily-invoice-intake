"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { exportProfilesApi, getApiErrorMessage } from "@/lib/api";
import type {
  PersistedExportProfileCreate,
  PersistedExportProfileRead,
  PersistedExportProfileUpdate,
} from "@/types/export-profile-persistence";

/**
 * Phase 4C — CRUD mutations for the persisted export profile catalog.
 *
 * Wraps ``exportProfilesApi.create`` / ``update`` / ``deactivate``
 * with a small ``{ busy, error, lastCompletedAt }`` state machine
 * so the management page doesn't have to re-implement the
 * try / abort / unmount-safety pattern every time.
 *
 * Each mutation:
 *   * aborts any prior in-flight request from the same hook
 *     instance (race protection),
 *   * blocks ``setState`` after unmount,
 *   * RETURNS the API response (or throws) so the caller can
 *     reload the list / select the new profile inline.
 *
 * No retry / no debounce — the management page wires explicit
 * Save buttons instead of streaming behaviour.
 */

export interface UseExportProfileMutationsReturn {
  /** True while ANY mutation from this hook is in flight. */
  busy: boolean;
  /** Last error message; cleared at the start of each mutation. */
  error: string | null;
  /** ISO stamp of the most recent successful mutation (for "Saved a
   *  moment ago" banners). Cleared at the start of each mutation. */
  lastCompletedAt: string | null;
  createProfile: (
    payload: PersistedExportProfileCreate,
  ) => Promise<PersistedExportProfileRead>;
  updateProfile: (
    profileId: string,
    payload: PersistedExportProfileUpdate,
  ) => Promise<PersistedExportProfileRead>;
  deactivateProfile: (profileId: string) => Promise<void>;
  /** Imperative dismiss for the "Saved" pill / error pill — used
   *  when the form panel closes without another mutation. */
  clearStatus: () => void;
}

/**
 * Phase 4D — auto-clear window for the success ("Saved.") pill.
 * Errors persist until the next mutation or an explicit
 * ``clearStatus`` call so the operator doesn't miss them.
 */
const SUCCESS_AUTO_CLEAR_MS = 4000;

export function useExportProfileMutations(): UseExportProfileMutationsReturn {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCompletedAt, setLastCompletedAt] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  // Phase 4D — pending auto-clear timer for the success pill.
  // Cleared on unmount + at the start of every new mutation so the
  // pill from a stale completion doesn't reappear after a fresh
  // failure.
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelSuccessTimer = useCallback(() => {
    if (successTimerRef.current !== null) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
      // Defensive — avoid setState on an unmounted hook.
      if (successTimerRef.current !== null) {
        clearTimeout(successTimerRef.current);
        successTimerRef.current = null;
      }
    };
  }, []);

  const beginMutation = useCallback((): AbortController => {
    abortRef.current?.abort();
    cancelSuccessTimer();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setLastCompletedAt(null);
    return controller;
  }, [cancelSuccessTimer]);

  const handleSuccess = useCallback(() => {
    if (!aliveRef.current) return;
    setLastCompletedAt(new Date().toISOString());
    setBusy(false);
    // Phase 4D — auto-clear the success pill after a short window
    // so it doesn't sit indefinitely. Cancel any prior pending
    // timer first; the new mutation owns the visible pill.
    cancelSuccessTimer();
    successTimerRef.current = setTimeout(() => {
      successTimerRef.current = null;
      if (aliveRef.current) {
        setLastCompletedAt(null);
      }
    }, SUCCESS_AUTO_CLEAR_MS);
  }, [cancelSuccessTimer]);

  const handleError = useCallback(
    (err: unknown, fallbackMessage: string): never => {
      const msg = getApiErrorMessage(err, fallbackMessage);
      if (aliveRef.current) {
        setError(msg);
        setBusy(false);
      }
      // Errors persist — cancel any leftover success timer so an
      // old "Saved." pill can't fade in next to the error.
      cancelSuccessTimer();
      throw err;
    },
    [cancelSuccessTimer],
  );

  const createProfile = useCallback(
    async (
      payload: PersistedExportProfileCreate,
    ): Promise<PersistedExportProfileRead> => {
      const controller = beginMutation();
      try {
        const next = await exportProfilesApi.create(payload, {
          signal: controller.signal,
        });
        handleSuccess();
        return next;
      } catch (err) {
        return handleError(err, "Could not create export profile.");
      }
    },
    [beginMutation, handleSuccess, handleError],
  );

  const updateProfile = useCallback(
    async (
      profileId: string,
      payload: PersistedExportProfileUpdate,
    ): Promise<PersistedExportProfileRead> => {
      const controller = beginMutation();
      try {
        const next = await exportProfilesApi.update(profileId, payload, {
          signal: controller.signal,
        });
        handleSuccess();
        return next;
      } catch (err) {
        return handleError(err, "Could not update export profile.");
      }
    },
    [beginMutation, handleSuccess, handleError],
  );

  const deactivateProfile = useCallback(
    async (profileId: string): Promise<void> => {
      const controller = beginMutation();
      try {
        await exportProfilesApi.deactivate(profileId, {
          signal: controller.signal,
        });
        handleSuccess();
      } catch (err) {
        handleError(err, "Could not deactivate export profile.");
      }
    },
    [beginMutation, handleSuccess, handleError],
  );

  const clearStatus = useCallback(() => {
    cancelSuccessTimer();
    if (!aliveRef.current) return;
    setError(null);
    setLastCompletedAt(null);
  }, [cancelSuccessTimer]);

  return {
    busy,
    error,
    lastCompletedAt,
    createProfile,
    updateProfile,
    deactivateProfile,
    clearStatus,
  };
}
