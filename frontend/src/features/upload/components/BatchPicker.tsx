"use client";

import { Check, ChevronDown, FolderOpen, PlusCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { batchesApi } from "@/lib/api/batches";
import { getApiErrorMessage } from "@/lib/api";
import { displayBatchStatus } from "@/lib/status";
import { cn, formatDate } from "@/lib/utils";
import type { Batch } from "@/types/batch";

interface BatchPickerProps {
  /** Batch the workspace is currently bound to. */
  current: Batch | null;
  /** Asked to switch into an existing batch. */
  onPick: (batch: Batch) => void;
  /** Asked to drop the current batch and start a fresh one. */
  onStartNew: () => void;
  /** Disable interaction while uploads are in flight. */
  disabled?: boolean;
}

/**
 * Compact recent-batches picker for the Upload workspace.
 *
 * The picker is the entry point into the "persistent batch management"
 * flow — it lets a user reopen a batch they were working on earlier (to add
 * more files, remove documents, or just preview them) without needing to
 * round-trip through the dashboard.
 *
 * - When no batch is open: shows "Start a new batch" + "Open existing".
 * - When a batch is open:  shows the current batch summary with a switch
 *                          control to pick a different one or start fresh.
 *
 * Recent batches are loaded lazily — only when the dropdown opens — so
 * we don't burn an API call on every Upload page visit.
 */
export function BatchPicker({
  current,
  onPick,
  onStartNew,
  disabled,
}: BatchPickerProps) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<Batch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ---- Click-outside / Escape ---------------------------------------------
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // ---- Lazy-load recent batches the first time the menu opens -------------
  useEffect(() => {
    if (!open || recent !== null || loading) return;
    setLoading(true);
    setError(null);
    batchesApi
      .list({ limit: 20 })
      .then((rows) => setRecent(rows))
      .catch((err) =>
        setError(getApiErrorMessage(err, "Couldn't load recent batches.")),
      )
      .finally(() => setLoading(false));
  }, [open, recent, loading]);

  const handleStartNew = () => {
    setOpen(false);
    onStartNew();
  };

  const handlePick = (b: Batch) => {
    setOpen(false);
    onPick(b);
  };

  return (
    <div className="relative" ref={wrapperRef}>
      {/* ---- Trigger ------------------------------------------------------- */}
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className={cn(
          "w-full flex items-center justify-between gap-2 rounded-md border bg-white px-3 py-2 text-left text-sm transition-colors",
          "hover:border-brand-400",
          "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-gray-300",
          open ? "border-brand-500 ring-2 ring-brand-100" : "border-gray-300",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpen className="h-4 w-4 shrink-0 text-gray-400" />
          <div className="min-w-0">
            {current ? (
              <>
                <p className="text-[10.5px] uppercase tracking-wide text-gray-400 leading-none">
                  Working in
                </p>
                <p className="text-sm font-medium text-gray-800 truncate mt-0.5">
                  {current.name}
                </p>
              </>
            ) : (
              <>
                <p className="text-[10.5px] uppercase tracking-wide text-gray-400 leading-none">
                  Batch
                </p>
                <p className="text-sm font-medium text-gray-600 mt-0.5">
                  Start new or open existing
                </p>
              </>
            )}
          </div>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-gray-400 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {/* ---- Panel --------------------------------------------------------- */}
      {open && (
        <div
          className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-gray-200 bg-white shadow-lg overflow-hidden"
          role="listbox"
        >
          {/* Start new batch action */}
          <button
            type="button"
            onClick={handleStartNew}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm text-gray-700 hover:bg-brand-50 border-b border-gray-100"
          >
            <PlusCircle className="h-4 w-4 text-brand-500" />
            <div>
              <p className="font-medium text-gray-800">Start a new batch</p>
              <p className="text-[11px] text-gray-500 mt-0.5">
                Clears the workspace and prompts for a name.
              </p>
            </div>
          </button>

          <div className="px-3 py-1.5 text-[10.5px] uppercase tracking-wide text-gray-400 bg-gray-50 border-b border-gray-100">
            Recent batches
          </div>

          <div className="max-h-72 overflow-y-auto">
            {loading && (
              <p className="px-3 py-3 text-xs text-gray-400">Loading…</p>
            )}
            {error && (
              <p className="px-3 py-3 text-xs text-red-600">{error}</p>
            )}
            {!loading && !error && recent && recent.length === 0 && (
              <p className="px-3 py-3 text-xs text-gray-400">
                No previous batches yet — start a new one above.
              </p>
            )}
            {!loading &&
              !error &&
              recent &&
              recent.map((b) => {
                const status = displayBatchStatus(b);
                const isCurrent = current?.id === b.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => handlePick(b)}
                    className={cn(
                      "w-full flex items-start gap-2 px-3 py-2.5 text-left text-sm hover:bg-gray-50 border-b border-gray-50 last:border-b-0",
                      isCurrent && "bg-brand-50/40",
                    )}
                  >
                    <span className="mt-0.5 h-4 w-4 shrink-0 flex items-center justify-center">
                      {isCurrent ? (
                        <Check className="h-3.5 w-3.5 text-brand-600" />
                      ) : null}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-gray-800 truncate">
                          {b.name}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge color={status.tone} className="text-[10px] py-0">
                          {status.label}
                        </Badge>
                        <span className="text-[11px] text-gray-500">
                          {b.processed_documents} / {b.total_documents} docs
                        </span>
                        <span className="text-[11px] text-gray-400">
                          · {formatDate(b.created_at)}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
