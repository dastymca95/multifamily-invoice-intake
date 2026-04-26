"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";

import { DependencyBlockerDialog } from "@/components/dependencies/DependencyBlockerDialog";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import type { UsedByReport } from "@/types/dependencies";

/**
 * Confirm-then-delete footer used at the bottom of catalog editors.
 *
 * Two-state UI: a single "Delete catalog" button by default; on click,
 * swaps to a Cancel / "Delete catalog" pair with a confirmation
 * sentence. Same UX across GL, Property, and Vendor catalog editors so
 * destructive actions feel consistent.
 *
 * Holds its own `confirming` state — no need for the parent to thread
 * it through.
 */
export interface DeleteCatalogFooterProps {
  /** True while the parent is awaiting the delete request to settle. */
  saving: boolean;
  /** Invoked when the user confirms the delete. */
  onDelete: () => void | Promise<void>;
  /** Optional preflight used-by check before showing final confirmation. */
  onCheckDependencies?: () => Promise<UsedByReport>;
  /** Confirmation copy. Default works for "Delete this catalog?". */
  confirmMessage?: string;
  /** Button label. Default "Delete catalog". */
  buttonLabel?: string;
}

export function DeleteCatalogFooter({
  saving,
  onDelete,
  onCheckDependencies,
  confirmMessage = "Delete this catalog? This can't be undone.",
  buttonLabel = "Delete catalog",
}: DeleteCatalogFooterProps) {
  const [confirming, setConfirming] = useState(false);
  const [checking, setChecking] = useState(false);
  const [blockerReport, setBlockerReport] = useState<UsedByReport | null>(
    null,
  );
  const [checkError, setCheckError] = useState<string | null>(null);

  const beginDelete = async () => {
    if (!onCheckDependencies) {
      setConfirming(true);
      return;
    }
    setChecking(true);
    setCheckError(null);
    try {
      const report = await onCheckDependencies();
      if (report.safe_to_delete) {
        setConfirming(true);
      } else {
        setBlockerReport(report);
      }
    } catch {
      setCheckError("Could not check where this catalog is used.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <div className="px-5 py-3 border-t border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
        <div className="flex items-center gap-2">
          {confirming ? (
            <>
              <span className="text-[12.5px] text-gray-700 dark:text-ink-muted">
                {confirmMessage}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                loading={saving}
                onClick={() => void onDelete()}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {buttonLabel}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
              onClick={() => void beginDelete()}
              disabled={saving}
              loading={checking}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {buttonLabel}
            </Button>
          )}
        </div>
        {checkError && (
          <InlineAlert tone="error" className="mt-2">
            {checkError}
          </InlineAlert>
        )}
      </div>
      <DependencyBlockerDialog
        open={blockerReport != null}
        report={blockerReport}
        onClose={() => setBlockerReport(null)}
      />
    </>
  );
}
