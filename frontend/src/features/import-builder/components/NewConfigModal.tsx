"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import {
  DEFAULT_ROW_LIMIT,
  ROW_LIMIT_MAX,
  ROW_LIMIT_MIN,
  type ImportConfigCreate,
} from "@/types/import-config";

/**
 * "Create configuration" dialog.
 *
 * Intentionally minimal: name + description + row-limit. Role overrides
 * are added inside the workspace once the config exists, since the
 * useful pinning happens against the rendered preview's column headers
 * (which only become visible once the config is open).
 */
interface NewConfigModalProps {
  open: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (body: ImportConfigCreate) => Promise<void>;
}

export function NewConfigModal({
  open,
  saving,
  error,
  onClose,
  onCreate,
}: NewConfigModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rowLimit, setRowLimit] = useState<number>(DEFAULT_ROW_LIMIT);

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onCreate({
      name: trimmedName,
      description: description.trim() ? description.trim() : null,
      row_limit: rowLimit,
      column_role_overrides: {},
    });
    // Reset for next open. The parent closes us on success via the
    // `onCreate` resolution; if it left us open (because of an error),
    // the user's typed values stay intact.
    setName("");
    setDescription("");
    setRowLimit(DEFAULT_ROW_LIMIT);
  };

  return (
    <Modal open={open} onClose={onClose} title="New configuration" size="md">
      <div className="space-y-3">
        <div>
          <label
            htmlFor="new-cfg-name"
            className="block text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold mb-1"
          >
            Name
          </label>
          <input
            id="new-cfg-name"
            type="text"
            value={name}
            autoFocus
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Default ResMan layout"
            className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label
            htmlFor="new-cfg-desc"
            className="block text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold mb-1"
          >
            Description
          </label>
          <textarea
            id="new-cfg-desc"
            value={description}
            rows={2}
            placeholder="Optional — what is this config for?"
            onChange={(e) => setDescription(e.target.value)}
            className="w-full resize-none rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label
            htmlFor="new-cfg-rows"
            className="block text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold mb-1"
          >
            Preview rows
            <span className="ml-1 font-normal text-gray-400">
              ({ROW_LIMIT_MIN}–{ROW_LIMIT_MAX})
            </span>
          </label>
          <input
            id="new-cfg-rows"
            type="number"
            min={ROW_LIMIT_MIN}
            max={ROW_LIMIT_MAX}
            value={rowLimit}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (Number.isNaN(n)) return;
              setRowLimit(
                Math.max(ROW_LIMIT_MIN, Math.min(ROW_LIMIT_MAX, n)),
              );
            }}
            className="w-24 rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="text-[10.5px] text-gray-400 mt-0.5">
            Caps how many recently-approved invoices feed the preview.
          </p>
        </div>

        {error && <InlineAlert tone="error">{error}</InlineAlert>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            loading={saving}
            onClick={() => void handleSubmit()}
          >
            Create configuration
          </Button>
        </div>
      </div>
    </Modal>
  );
}
