"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Phase 3H — Operational Preview QA Hardening.
 *
 * Reusable transient toast helper for the four "Copy <thing>"
 * surfaces in the Operational Resolution Preview panel:
 *
 *   * Copy diagnostics (Phase 3D)
 *   * Copy preview     (Phase 3E)
 *   * Copy profile check (Phase 3F)
 *   * Copy full report (Phase 3G)
 *
 * Each surface needs IDENTICAL behaviour:
 *
 *   1. Show a status pill (success or error) with a short message.
 *   2. Auto-clear after 4 seconds so the pill doesn't sit forever.
 *   3. If a new ``show`` arrives before the timer expires, replace
 *      the message and reset the timer so the operator sees the
 *      latest event for the full 4 s window.
 *   4. Clear timers on panel close so the toast doesn't settle on
 *      an unmounted view, AND on component unmount so we never
 *      ``setState`` on an unmounted component.
 *
 * The hook returns a stable ``show`` reference (so it's safe in
 * ``useCallback`` dep arrays) plus the current ``status`` and an
 * imperative ``clear`` for the rare cases where the host wants to
 * dismiss without waiting for the timer (e.g. on result reset).
 *
 * The hook listens to an optional ``isMounted`` flag (default
 * ``true``) and clears its own state whenever the host transitions
 * to ``false``. The Operational Preview panel passes ``isOpen`` here
 * so toasts disappear when the modal closes.
 *
 * The hook is intentionally framework-light — no React Query, no
 * context — so it can be unit-tested or moved to ``@/hooks`` if
 * other surfaces (Pattern Test, Validate, Import Builder) want the
 * same toast pattern later.
 */

export type TransientCopyStatusType = "success" | "error";

export interface TransientCopyStatus {
  type: TransientCopyStatusType;
  message: string;
}

export interface UseTransientCopyStatusReturn {
  /** Current status, or ``null`` when no toast is visible. */
  status: TransientCopyStatus | null;
  /**
   * Show a new toast. Replaces any pending toast and resets the
   * 4-second auto-clear timer. Stable reference — safe to depend on
   * inside ``useCallback`` / ``useMemo``.
   */
  show: (type: TransientCopyStatusType, message: string) => void;
  /** Imperative clear — use sparingly (e.g. on Run-again). */
  clear: () => void;
}

/**
 * @param isMounted Optional gating flag (defaults to ``true``). When
 *   it transitions to ``false`` the hook clears the visible status
 *   and any pending timer. The hook ALSO always clears on unmount.
 * @param autoClearMs Auto-clear delay in milliseconds. Defaults to
 *   4 000 to match the existing operational preview surfaces.
 */
export function useTransientCopyStatus(
  isMounted: boolean = true,
  autoClearMs: number = 4000,
): UseTransientCopyStatusReturn {
  const [status, setStatus] = useState<TransientCopyStatus | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks live mount state so the timer callback doesn't call
  // ``setState`` on an unmounted component when the host unmounts
  // mid-window.
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (aliveRef.current) {
      setStatus(null);
    }
  }, []);

  const show = useCallback(
    (type: TransientCopyStatusType, message: string) => {
      if (!aliveRef.current) return;
      setStatus({ type, message });
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (aliveRef.current) {
          setStatus(null);
        }
      }, autoClearMs);
    },
    [autoClearMs],
  );

  // Host-driven clear — the panel passes ``isOpen``; flipping it
  // off discards any visible toast + pending timer so the next open
  // starts from a clean slate.
  useEffect(() => {
    if (isMounted) return;
    clear();
  }, [isMounted, clear]);

  return { status, show, clear };
}
