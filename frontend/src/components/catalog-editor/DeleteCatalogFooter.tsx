"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";

/**
 * Confirm-then-delete footer used at the bottom of catalog editors.
 *
 * Two-state UI: a single "Delete catalog" button by default; on click,
 * swaps to a Cancel / "Delete catalog" pair with a confirmation
 * sentence. Same UX across GL + Property catalog editors so destructive
 * actions feel consistent.
 *
 * Holds its own `confirming` state — no need for the parent to thread
 * it through.
 */
export interface DeleteCatalogFooterProps {
  /** True while the parent is awaiting the delete request to settle. */
  saving: boolean;
  /** Invoked when the user confirms the delete. */
  onDelete: () => void | Promise<void>;
  /** Confirmation copy. Default works for "Delete this catalog?". */
  confirmMessage?: string;
  /** Button label. Default "Delete catalog". */
  buttonLabel?: string;
}

export function DeleteCatalogFooter({
  saving,
  onDelete,
  confirmMessage = "Delete this catalog? This can't be undone.",
  buttonLabel = "Delete catalog",
}: DeleteCatalogFooterProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="px-5 py-3 border-t bg-white flex items-center gap-2">
      {confirming ? (
        <>
          <span className="text-[12.5px] text-gray-700">{confirmMessage}</span>
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
          className="text-red-600 hover:bg-red-50"
          onClick={() => setConfirming(true)}
          disabled={saving}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {buttonLabel}
        </Button>
      )}
    </div>
  );
}
