"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getApiErrorMessage } from "@/lib/api";
import { referenceApi } from "@/lib/api/reference";
import type {
  ReferenceFile,
  ReferenceKind,
  ReferenceSlot,
} from "@/types/reference";

/**
 * Per-slot transient state. The slot itself (with its `current` file) is
 * fetched from the backend; this hook layers per-kind upload + delete
 * state on top so the UI can show "uploading…" and per-card error
 * messages without polluting the persisted shape.
 */
export interface SlotUiState {
  /** True while a POST /upload is in flight for this kind. */
  uploading: boolean;
  /** 0..100 — bytes uploaded. */
  uploadProgress: number;
  /** True while a DELETE is in flight. */
  removing: boolean;
  /** Per-card error message (cleared on the next attempt). */
  error: string | null;
}

const _emptySlotState: SlotUiState = {
  uploading: false,
  uploadProgress: 0,
  removing: false,
  error: null,
};

export interface UseReferenceDataResult {
  slots: ReferenceSlot[];
  loading: boolean;
  /** Top-level error from the initial list fetch. */
  loadError: string | null;
  /** Per-kind transient state (upload progress / errors / removing). */
  slotStates: Record<ReferenceKind, SlotUiState>;
  /**
   * Replace (or set) the file for one kind. Returns the freshly-parsed
   * `ReferenceFile` on success, or `null` on failure (in which case the
   * per-kind error in `slotStates` carries the message). The return
   * value lets callers that need to act on the *just-uploaded* file
   * (e.g. an inline upload inside a modal) avoid reading from the
   * global slot — which may still be holding a previous upload.
   */
  upload: (kind: ReferenceKind, file: File) => Promise<ReferenceFile | null>;
  /** Drop the stored file for one kind. */
  remove: (kind: ReferenceKind) => Promise<void>;
  /** Re-fetch the slot list (e.g. after a manual error retry). */
  refresh: () => Promise<void>;
}

export function useReferenceData(): UseReferenceDataResult {
  const [slots, setSlots] = useState<ReferenceSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [slotStates, setSlotStates] = useState<Record<string, SlotUiState>>({});

  // Latest snapshot for use in async handlers without re-binding callbacks.
  const slotsRef = useRef<ReferenceSlot[]>(slots);
  slotsRef.current = slots;

  const _patchState = useCallback(
    (kind: ReferenceKind, patch: Partial<SlotUiState>) => {
      setSlotStates((curr) => ({
        ...curr,
        [kind]: { ..._emptySlotState, ...curr[kind], ...patch },
      }));
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const resp = await referenceApi.list();
      setSlots(resp.slots);
    } catch (err) {
      setLoadError(getApiErrorMessage(err, "Couldn't load reference data."));
      setSlots([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = useCallback(
    async (
      kind: ReferenceKind,
      file: File,
    ): Promise<ReferenceFile | null> => {
      _patchState(kind, {
        uploading: true,
        uploadProgress: 0,
        error: null,
      });
      try {
        const next: ReferenceFile = await referenceApi.upload(
          kind,
          file,
          (pct) => _patchState(kind, { uploadProgress: pct }),
        );
        // Patch the matching slot in place so the rest of the page
        // doesn't re-render unnecessarily. Other slots keep their
        // identity and don't lose, e.g., a dropdown's open state.
        setSlots((curr) =>
          curr.map((s) => (s.kind === kind ? { ...s, current: next } : s)),
        );
        _patchState(kind, {
          uploading: false,
          uploadProgress: 100,
          error: null,
        });
        return next;
      } catch (err) {
        _patchState(kind, {
          uploading: false,
          uploadProgress: 0,
          error: getApiErrorMessage(err, "Upload failed."),
        });
        return null;
      }
    },
    [_patchState],
  );

  const remove = useCallback(
    async (kind: ReferenceKind): Promise<void> => {
      _patchState(kind, { removing: true, error: null });
      try {
        await referenceApi.remove(kind);
        setSlots((curr) =>
          curr.map((s) => (s.kind === kind ? { ...s, current: null } : s)),
        );
        _patchState(kind, { removing: false, error: null });
      } catch (err) {
        _patchState(kind, {
          removing: false,
          error: getApiErrorMessage(err, "Couldn't remove file."),
        });
      }
    },
    [_patchState],
  );

  return {
    slots,
    loading,
    loadError,
    // Cast: TS can't see that we've populated every kind, and missing
    // entries default to `_emptySlotState` via the spread in `_patchState`.
    slotStates: slotStates as Record<ReferenceKind, SlotUiState>,
    upload,
    remove,
    refresh,
  };
}

/** Helper for components that want a guaranteed-present state object. */
export function getSlotState(
  states: Record<ReferenceKind, SlotUiState>,
  kind: ReferenceKind,
): SlotUiState {
  return states[kind] ?? _emptySlotState;
}
