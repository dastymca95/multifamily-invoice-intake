"use client";

import { Loader2, Plus, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import {
  formatFileSize,
  type InvoicePatternCreate,
  type InvoicePatternSourceFile,
  MAX_PATTERN_FILE_SIZE_BYTES,
  MAX_PATTERN_NAME_LENGTH,
  MAX_PATTERN_SOURCE_FILES,
  MAX_PATTERN_VENDOR_HINT_LENGTH,
  newSourceFileId,
} from "@/types/invoice-pattern";

import { ingestFile } from "../lib/file-ingest";

/**
 * "+ New pattern" modal.
 *
 * The product spec is explicit that this is **not** a generic upload
 * page — it's a focused "name the pattern + (optionally) attach
 * training docs + open the editor" flow. The modal lets the operator:
 *
 *   1. Name the pattern (required) and add an optional vendor hint /
 *      description.
 *   2. Optionally drop in one or more training documents (PDF / image)
 *      so the editor opens with something to draw on. Files are
 *      converted to inline data URLs in the browser before submit;
 *      the modal enforces the 10 MB / 10 file caps client-side so
 *      the operator gets an immediate error rather than a 422 on
 *      submit.
 *
 * The modal is a one-shot create — it doesn't manage in-flight
 * editing state. After the create succeeds the parent selects the
 * new row and the editor takes over.
 */
interface NewPatternModalProps {
  open: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (body: InvoicePatternCreate) => Promise<void>;
}

interface PendingFile {
  /** Stable id used to key the staged-file list. The eventual
   *  `InvoicePatternSourceFile.id` is generated independently by
   *  `ingestFile`; this id is purely a React list key during the
   *  transient pre-submit phase. */
  id: string;
  file: File;
  /** Successfully-ingested record (with real PDF page count). Null
   *  while the read + probe is still in flight or after a failure. */
  source: InvoicePatternSourceFile | null;
  /** Validation / read failure surfaced inline on the staged row. */
  error: string | null;
  /** Read + (PDF-only) page-count probe in flight. Disables submit. */
  reading: boolean;
}

export function NewPatternModal({
  open,
  saving,
  error,
  onClose,
  onCreate,
}: NewPatternModalProps) {
  const [name, setName] = useState("");
  const [vendorHint, setVendorHint] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset every time the modal closes — opening is a fresh start.
  useEffect(() => {
    if (!open) {
      setName("");
      setVendorHint("");
      setDescription("");
      setPending([]);
    }
  }, [open]);

  const stageFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const incoming = Array.from(files);
      // Cap-aware addition — silently truncate past the limit. The
      // operator can see how many were dropped via the "N of M added"
      // counter once the rows render.
      setPending((curr) => {
        const room = Math.max(0, MAX_PATTERN_SOURCE_FILES - curr.length);
        const toAdd = incoming.slice(0, room);
        const next = [...curr];
        for (const file of toAdd) {
          const id = newSourceFileId();
          next.push({
            id,
            file,
            source: null,
            error: null,
            reading: true,
          });
          // Centralized ingest: validates type + size, reads as data
          // URL, and (for PDFs) probes the page count. Using id-based
          // merge so ordering / removals during the async read don't
          // desync the list.
          void ingestFile(file)
            .then((source) =>
              setPending((p) =>
                p.map((row) =>
                  row.id === id
                    ? { ...row, source, reading: false }
                    : row,
                ),
              ),
            )
            .catch((err) =>
              setPending((p) =>
                p.map((row) =>
                  row.id === id
                    ? {
                        ...row,
                        error:
                          err instanceof Error
                            ? err.message
                            : "Couldn't read file",
                        reading: false,
                      }
                    : row,
                ),
              ),
            );
        }
        return next;
      });
      // Reset the input so the same file can be re-picked after
      // removal (otherwise `change` won't fire on the same value).
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [],
  );

  const removePending = useCallback((id: string) => {
    setPending((curr) => curr.filter((p) => p.id !== id));
  }, []);

  const trimmedName = name.trim();
  const trimmedHint = vendorHint.trim();
  const trimmedDesc = description.trim();
  const anyReading = pending.some((p) => p.reading);
  const anyErrored = pending.some((p) => p.error != null);
  const validName = trimmedName.length > 0;
  // Disable submit while any file is still reading or errored — the
  // payload would either be incomplete (data_url empty) or rejected
  // by the server-side cap enforcement.
  const submitDisabled =
    !validName || anyReading || anyErrored || saving;

  const handleSubmit = useCallback(async () => {
    if (submitDisabled) return;
    // Only fully-ingested rows contribute. Errored / still-reading
    // rows shouldn't reach this branch (submitDisabled gates them
    // out) but defensively we skip them so the payload never carries
    // a half-baked entry. Each `source` already has the correct
    // `page_count` (probed by `ingestFile` for PDFs, defaulted to 1
    // for images / corrupt PDFs).
    const source_files: InvoicePatternSourceFile[] = pending
      .filter((p) => p.source != null && p.error == null)
      .map((p) => p.source as InvoicePatternSourceFile);

    await onCreate({
      name: trimmedName,
      description: trimmedDesc || null,
      vendor_hint: trimmedHint || null,
      source_files,
      regions: [],
      // No field overrides on creation — the pattern starts with
      // every canonical field visible at its default color. The
      // editor's "Manage fields" modal is where overrides land.
      field_definitions: [],
    });
  }, [
    submitDisabled,
    pending,
    trimmedName,
    trimmedDesc,
    trimmedHint,
    onCreate,
  ]);

  return (
    <Modal open={open} onClose={onClose} title="New pattern" size="lg">
      <div className="space-y-4">
        {/* ---- Name + metadata --------------------------------------- */}
        <div className="space-y-3">
          <Field
            label="Name"
            required
            help="Operator-facing label, e.g. “EPB Utility Bill” or “Comcast Business Internet”."
          >
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_PATTERN_NAME_LENGTH}
              autoFocus
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="e.g. EPB Utility Bill"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Vendor hint"
              help="Optional free-text recognition hint. Not bound to a vendor row."
            >
              <input
                type="text"
                value={vendorHint}
                onChange={(e) => setVendorHint(e.target.value)}
                maxLength={MAX_PATTERN_VENDOR_HINT_LENGTH}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                placeholder="e.g. EPB"
              />
            </Field>
            <Field
              label="Description"
              help="Optional. What kind of bills this pattern covers."
            >
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                placeholder="e.g. Monthly electric bill"
              />
            </Field>
          </div>
        </div>

        {/* ---- Training docs ---------------------------------------- */}
        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">
              Training documents{" "}
              <span className="text-[11px] font-normal text-gray-400">
                (optional)
              </span>
            </h3>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Drop in one or more sample bills (PDF or image). You can
              also add them later from the editor. Capped at{" "}
              {MAX_PATTERN_SOURCE_FILES} files,{" "}
              {formatFileSize(MAX_PATTERN_FILE_SIZE_BYTES)} each.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,image/*"
              multiple
              className="hidden"
              onChange={(e) => stageFiles(e.target.files)}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={pending.length >= MAX_PATTERN_SOURCE_FILES}
            >
              <Upload className="h-3.5 w-3.5" />
              Add files…
            </Button>
            {pending.length > 0 && (
              <span className="text-[11px] text-gray-500">
                {pending.length} of {MAX_PATTERN_SOURCE_FILES} added
              </span>
            )}
          </div>

          {pending.length > 0 && (
            <ul className="border border-gray-200 rounded-md divide-y bg-gray-50/60">
              {pending.map((p) => (
                <li
                  key={p.id}
                  className="px-3 py-2 flex items-center gap-2 text-[12px]"
                >
                  <span className="flex-1 min-w-0">
                    <span
                      className="block truncate text-gray-800 font-medium"
                      title={p.file.name}
                    >
                      {p.file.name}
                    </span>
                    <span className="block text-[10.5px] text-gray-500">
                      {formatFileSize(p.file.size)} ·{" "}
                      {p.file.type || "unknown type"}
                    </span>
                    {p.error && (
                      <span className="block text-[10.5px] text-red-600">
                        {p.error}
                      </span>
                    )}
                  </span>
                  {p.reading && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
                  )}
                  <button
                    type="button"
                    className="text-[11px] text-gray-500 hover:text-red-600"
                    onClick={() => removePending(p.id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <InlineAlert tone="error" title="Couldn't create pattern">
            {error}
          </InlineAlert>
        )}

        <div className="flex items-center justify-end gap-2 pt-1 border-t border-gray-100">
          <Button
            type="button"
            variant="secondary"
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
            loading={saving}
            disabled={submitDisabled}
            onClick={handleSubmit}
          >
            <Plus className="h-3.5 w-3.5" />
            Create pattern
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11.5px] font-semibold text-gray-700">
        {label}
        {required && <span className="text-red-600 ml-0.5">*</span>}
      </span>
      <div className="mt-1">{children}</div>
      {help && (
        <p className="text-[10.5px] text-gray-500 mt-0.5">{help}</p>
      )}
    </label>
  );
}
