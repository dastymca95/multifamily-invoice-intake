"use client";

import { useCallback, useRef, useState } from "react";

import { batchesApi } from "@/lib/api/batches";
import { documentsApi } from "@/lib/api/documents";
import { getApiErrorMessage } from "@/lib/api";
import type { Batch } from "@/types/batch";
import type { Document, DocumentUploadResult } from "@/types/document";

import { getDocumentMeta, type DocMeta } from "../lib/pdfMeta";

/**
 * Per-file lifecycle in the upload workspace:
 *
 *   queued    → file selected, not yet uploaded
 *   uploading → POST in flight (carries `progress` 0..100)
 *   uploaded  → server returned 2xx but extraction is still pending
 *               (only happens when EXTRACTION_USE_CELERY=True)
 *   extracted → server returned and extraction_status === "extracted"
 *   duplicate → server returned with duplicate=true (yellow, not an error)
 *   failed    → POST rejected, OR extraction_status === "failed"
 */
export type TrackedFileStatus =
  | "queued"
  | "uploading"
  | "uploaded"
  | "extracted"
  | "duplicate"
  | "failed";

export interface TrackedFile {
  /** Stable client-side id for React keys. */
  id: string;
  file: File;
  /** `null` while metadata is still being probed. */
  meta: DocMeta | null;
  status: TrackedFileStatus;
  /** 0..100, only meaningful while `status === "uploading"`. */
  progress: number;
  /** Server response when the upload completes (any terminal non-failed state). */
  result?: DocumentUploadResult;
  /** Human-readable error if status === "failed". */
  error?: string;
}

export type BatchPhase =
  | "idle"
  | "creating_batch"
  | "uploading"
  | "done"
  | "error";

/**
 * Pending page-removal edits keyed by workspace item id (TrackedFile.id or
 * Document.id). The `Set<number>` holds 1-indexed page numbers the user
 * marked for removal. Cleared on commit, on `restoreAllPages`, and when
 * the underlying item is removed.
 *
 * We use a plain object (not a Map) so React's `===` comparison plays
 * nicely with referential-equality memoization in child components.
 */
export type PageEditMap = Record<string, ReadonlySet<number>>;

export interface UseBatchUploadResult {
  // ---- Items ---------------------------------------------------------------
  /** Client-side queue: files added in the current session, before/during/just-after upload. */
  files: TrackedFile[];
  /**
   * Documents already saved to the batch on the server. Populated by
   * `openBatch` and refreshed after every successful upload pass. Empty for
   * a brand-new batch until the first upload completes.
   */
  persistedDocuments: Document[];
  /** True while `batchesApi.listDocuments()` is in flight. */
  loadingPersisted: boolean;

  // ---- Phase ---------------------------------------------------------------
  phase: BatchPhase;
  /** Set if we failed before any per-file uploads started (e.g. batch create) or on a delete failure. */
  topLevelError: string | null;
  /** The batch the workspace is currently bound to. `null` until a batch is created or opened. */
  batch: Batch | null;
  /** 0..100 over the queued/uploading items only. */
  overallProgress: number;

  // ---- Selection -----------------------------------------------------------
  /** Id of the currently-selected workspace item — either a `TrackedFile.id` or a `Document.id`. */
  selectedItemId: string | null;
  setSelectedItemId: (id: string | null) => void;

  // ---- Page-level edits ----------------------------------------------------
  /**
   * For each item id, the (1-indexed) page numbers the user has marked
   * for removal but not yet committed. Empty entries are pruned.
   */
  pageEdits: PageEditMap;
  /** Id whose page edits are currently being committed (pdf-lib rewrite in flight). */
  pendingEditsId: string | null;
  /** Toggle a single page in/out of the removal set for the given item. */
  togglePageEdit: (id: string, pageNumber: number) => void;
  /** Clear all pending edits for the given item. */
  restoreAllPages: (id: string) => void;
  /**
   * Commit pending page edits.
   *
   * For QUEUED PDFs we rewrite the PDF in-browser with `pdf-lib`,
   * replace the underlying `File` on the TrackedFile, and refresh meta
   * (page count, etc). The change is durable: the next upload sends the
   * trimmed file.
   *
   * For PERSISTED documents we POST to `/documents/{id}/trim` so the
   * server rewrites the stored file (new checksum + storage key) and
   * re-runs extraction. On success the doc in `persistedDocuments` is
   * replaced with the server's view, the batch is refreshed for accurate
   * counters, and the page-edit set is cleared. On failure the
   * top-level error is set and the page-edit set is preserved so the
   * user can retry.
   */
  commitPageEdits: (id: string) => Promise<void>;

  // ---- Actions -------------------------------------------------------------
  addFiles: (files: File[]) => void;
  /** Legacy queued-only remove. New code should call `removeDocument`. */
  removeFile: (id: string) => void;
  /**
   * Unified remove — accepts a queued `TrackedFile.id` OR a persisted
   * `Document.id` and does the right thing (local for not-yet-persisted,
   * DELETE + counter rollback for server-side rows).
   */
  removeDocument: (id: string) => Promise<void>;
  clearAll: () => void;
  /** Submit the current queue. Creates a batch if one isn't open yet. */
  startUpload: (batchName: string) => Promise<void>;
  /**
   * Bind the workspace to an existing batch and load its documents into
   * `persistedDocuments`. Clears any in-flight queue and selection.
   */
  openBatch: (batch: Batch) => Promise<void>;
  /**
   * Dismiss the post-upload "done" banner and return to `idle` while keeping
   * the batch open. Successful uploads are now in `persistedDocuments`, so
   * we drop the queued list and let the user add more.
   */
  continueBatch: () => void;
  /** Tear everything down — batch, queue, persisted, selection. */
  reset: () => void;
}

function _newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function _statusFromResult(result: DocumentUploadResult): TrackedFileStatus {
  if (result.duplicate) return "duplicate";
  if (result.extraction_status === "extracted") return "extracted";
  if (result.extraction_status === "failed") return "failed";
  // pending | processing — extraction is still queued.
  return "uploaded";
}

export function useBatchUpload(): UseBatchUploadResult {
  const [files, setFiles] = useState<TrackedFile[]>([]);
  const [persistedDocuments, setPersistedDocuments] = useState<Document[]>([]);
  const [loadingPersisted, setLoadingPersisted] = useState(false);
  const [phase, setPhase] = useState<BatchPhase>("idle");
  const [batch, setBatch] = useState<Batch | null>(null);
  const [topLevelError, setTopLevelError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [pageEdits, setPageEdits] = useState<PageEditMap>({});
  const [pendingEditsId, setPendingEditsId] = useState<string | null>(null);

  // Latest snapshots for use inside async loops without re-binding callbacks.
  const filesRef = useRef<TrackedFile[]>(files);
  filesRef.current = files;
  const persistedRef = useRef<Document[]>(persistedDocuments);
  persistedRef.current = persistedDocuments;
  const selectedRef = useRef<string | null>(selectedItemId);
  selectedRef.current = selectedItemId;
  const batchRef = useRef<Batch | null>(batch);
  batchRef.current = batch;

  const _patchFile = useCallback((id: string, patch: Partial<TrackedFile>) => {
    setFiles((curr) => curr.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const _refreshPersisted = useCallback(async (batchId: string) => {
    try {
      const docs = await batchesApi.listDocuments(batchId);
      setPersistedDocuments(docs);
    } catch {
      // Non-fatal: the user can re-open the batch to retry. Surfacing this as
      // a top-level error would be alarming for a background sync.
    }
  }, []);

  const addFiles = useCallback(
    (incoming: File[]) => {
      // Block additions once an upload is in flight or finished (until the
      // user dismisses the done banner via continueBatch / reset).
      if (phase !== "idle") return;

      // Dedupe by name+size against both the queued list AND the persisted
      // list — a file already saved to this batch is almost certainly a
      // duplicate, so don't make the user upload it just to find out.
      const existingKeys = new Set<string>();
      for (const t of filesRef.current) {
        existingKeys.add(`${t.file.name}::${t.file.size}`);
      }
      for (const d of persistedRef.current) {
        existingKeys.add(`${d.original_filename}::${d.file_size_bytes}`);
      }

      const fresh: TrackedFile[] = [];
      for (const f of incoming) {
        const key = `${f.name}::${f.size}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        fresh.push({
          id: _newId(),
          file: f,
          meta: null,
          status: "queued",
          progress: 0,
        });
      }
      if (fresh.length === 0) return;
      setFiles((curr) => [...curr, ...fresh]);

      // Probe metadata in parallel; each result patches its own row.
      for (const tf of fresh) {
        getDocumentMeta(tf.file)
          .then((meta) => _patchFile(tf.id, { meta }))
          .catch(() =>
            _patchFile(tf.id, {
              meta: { pageCount: null, source: "unknown", kindLabel: "File" },
            }),
          );
      }
    },
    [phase, _patchFile],
  );

  const removeFile = useCallback(
    (id: string) => {
      // Only allow removal of still-queued files. Kept for backward compat
      // with the existing "Clear" / X-button affordances.
      setFiles((curr) =>
        curr.filter((f) => !(f.id === id && f.status === "queued")),
      );
      if (selectedRef.current === id) setSelectedItemId(null);
      // If this id had pending page edits, drop them too.
      setPageEdits((curr) => {
        if (!(id in curr)) return curr;
        const next = { ...curr };
        delete next[id];
        return next;
      });
    },
    [],
  );

  // ---- Page-level edits --------------------------------------------------
  const togglePageEdit = useCallback(
    (id: string, pageNumber: number) => {
      setPageEdits((curr) => {
        const existing = curr[id] ?? new Set<number>();
        const next = new Set(existing);
        if (next.has(pageNumber)) next.delete(pageNumber);
        else next.add(pageNumber);

        const out = { ...curr };
        if (next.size === 0) {
          delete out[id];
        } else {
          out[id] = next;
        }
        return out;
      });
    },
    [],
  );

  const restoreAllPages = useCallback((id: string) => {
    setPageEdits((curr) => {
      if (!(id in curr)) return curr;
      const next = { ...curr };
      delete next[id];
      return next;
    });
  }, []);

  const commitPageEdits = useCallback(
    async (id: string): Promise<void> => {
      const removed = pageEdits[id];
      if (!removed || removed.size === 0) return;

      // ---- Persisted branch: server-side trim + re-extract --------------
      // The endpoint rewrites the stored file under a new checksum-derived
      // key, drops the existing invoice + extraction_runs, and re-runs
      // extraction. We replace the doc in our list with the server's view
      // and refresh the batch so the dashboard counters stay honest.
      const persisted = persistedRef.current.find((d) => d.id === id);
      if (persisted) {
        const removedPages = Array.from(removed).sort((a, b) => a - b);
        setPendingEditsId(id);
        setTopLevelError(null);
        try {
          const detail = await documentsApi.trimPages(id, removedPages);
          // Swap in the trimmed doc. The new checksum_sha256 is what the
          // preview pane keys its blob URL off of, so the iframe re-fetches
          // the new bytes automatically.
          setPersistedDocuments((curr) =>
            curr.map((d) => (d.id === id ? detail.document : d)),
          );
          // Drop the page-edit set — it has been applied.
          setPageEdits((curr) => {
            if (!(id in curr)) return curr;
            const next = { ...curr };
            delete next[id];
            return next;
          });
          // Refresh the batch so any counter drift from the re-extraction
          // (e.g. extracted -> failed) is reflected in the header stats.
          if (batchRef.current) {
            try {
              const refreshed = await batchesApi.get(batchRef.current.id);
              setBatch(refreshed);
            } catch {
              /* non-fatal */
            }
          }
        } catch (err) {
          setTopLevelError(
            getApiErrorMessage(
              err,
              "Couldn't trim and re-extract the document.",
            ),
          );
        } finally {
          setPendingEditsId(null);
        }
        return;
      }

      const tracked = filesRef.current.find((f) => f.id === id);
      if (!tracked) return;

      // Only PDFs can be trimmed in-place. Images are single-page; if a
      // user marked the lone page they want the whole row removed, which
      // is what `removeDocument` is for.
      if (tracked.meta?.source !== "pdf") {
        setTopLevelError(
          "Page edits are only supported for PDFs. Use “Remove from batch” to drop a non-PDF file instead.",
        );
        return;
      }
      if (tracked.status !== "queued") {
        // Files mid-upload or already uploaded shouldn't be mutated under
        // the workflow's feet.
        setTopLevelError(
          "Page edits can only be applied while the file is still queued.",
        );
        return;
      }

      setPendingEditsId(id);
      setTopLevelError(null);
      try {
        const bytes = await tracked.file.arrayBuffer();
        // Dynamic import to keep pdf-lib out of the initial chunk for
        // anyone who never opens the page editor.
        const { PDFDocument } = await import("pdf-lib");
        const src = await PDFDocument.load(bytes, {
          ignoreEncryption: true,
          updateMetadata: false,
        });
        const total = src.getPageCount();
        // 1-indexed page numbers → 0-indexed indices we want to KEEP.
        const keepIndices: number[] = [];
        for (let i = 1; i <= total; i += 1) {
          if (!removed.has(i)) keepIndices.push(i - 1);
        }
        if (keepIndices.length === 0) {
          setTopLevelError(
            "Can't remove every page — at least one page has to remain. Use “Remove from batch” to drop the file entirely.",
          );
          return;
        }

        const out = await PDFDocument.create();
        const copied = await out.copyPages(src, keepIndices);
        for (const p of copied) out.addPage(p);
        const trimmedBytes = await out.save();

        // Wrap in a fresh File so axios's FormData encoding picks up the
        // new size. Keep the original filename + mime so the user can
        // still recognize it; lastModified bumps to "now" since the
        // contents really did change.
        const newFile = new File(
          [new Uint8Array(trimmedBytes)],
          tracked.file.name,
          { type: tracked.file.type || "application/pdf", lastModified: Date.now() },
        );

        // Patch the tracked file: new bytes + refreshed meta. We trust
        // pdf-lib's reported page count so we don't need to re-probe.
        const newMeta: DocMeta = {
          pageCount: keepIndices.length,
          source: "pdf",
          kindLabel: tracked.meta.kindLabel,
        };
        _patchFile(id, { file: newFile, meta: newMeta });

        // Drop the edits — they've been applied.
        setPageEdits((curr) => {
          if (!(id in curr)) return curr;
          const next = { ...curr };
          delete next[id];
          return next;
        });
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Couldn't rewrite the PDF.";
        setTopLevelError(`Couldn't apply page changes: ${msg}`);
      } finally {
        setPendingEditsId(null);
      }
    },
    [pageEdits],
  );

  const removeDocument = useCallback(
    async (id: string): Promise<void> => {
      // 1) Try the queued list first.
      const queued = filesRef.current.find((f) => f.id === id);
      if (queued) {
        if (queued.status === "uploading") return; // can't pull mid-upload

        // If the file already produced a server-side row (extracted /
        // uploaded), we have to DELETE it server-side too. Duplicates and
        // failed items have no row to clean up.
        const hasServerRow =
          (queued.status === "extracted" || queued.status === "uploaded") &&
          queued.result != null;

        if (hasServerRow && queued.result) {
          try {
            await documentsApi.delete(queued.result.document_id);
          } catch (err) {
            setTopLevelError(
              getApiErrorMessage(err, "Failed to delete document."),
            );
            return;
          }
          // Server delete also touches the batch counters — refresh the
          // batch so the header stats stay accurate.
          if (batchRef.current) {
            try {
              const refreshed = await batchesApi.get(batchRef.current.id);
              setBatch(refreshed);
            } catch {
              /* non-fatal */
            }
          }
        }

        setFiles((curr) => curr.filter((f) => f.id !== id));
        if (selectedRef.current === id) setSelectedItemId(null);
        // Drop any pending page edits for the now-removed item.
        setPageEdits((curr) => {
          if (!(id in curr)) return curr;
          const next = { ...curr };
          delete next[id];
          return next;
        });
        return;
      }

      // 2) Otherwise, try the persisted list.
      const persisted = persistedRef.current.find((d) => d.id === id);
      if (!persisted) return;

      try {
        await documentsApi.delete(id);
      } catch (err) {
        setTopLevelError(getApiErrorMessage(err, "Failed to delete document."));
        return;
      }
      setPersistedDocuments((curr) => curr.filter((d) => d.id !== id));
      if (selectedRef.current === id) setSelectedItemId(null);
      setPageEdits((curr) => {
        if (!(id in curr)) return curr;
        const next = { ...curr };
        delete next[id];
        return next;
      });

      // Refresh batch for accurate counters.
      if (batchRef.current) {
        try {
          const refreshed = await batchesApi.get(batchRef.current.id);
          setBatch(refreshed);
        } catch {
          /* non-fatal */
        }
      }
    },
    [],
  );

  const clearAll = useCallback(() => {
    if (phase !== "idle") return;
    setFiles([]);
    if (selectedRef.current != null) {
      const stillExists = persistedRef.current.some(
        (d) => d.id === selectedRef.current,
      );
      if (!stillExists) setSelectedItemId(null);
    }
  }, [phase]);

  const startUpload = useCallback(
    async (batchName: string) => {
      if (filesRef.current.length === 0) return;
      if (phase !== "idle") return;

      setTopLevelError(null);

      // If a batch is already open (created earlier OR opened from picker),
      // upload directly into it. Otherwise, create one from the typed name.
      let workingBatch: Batch | null = batchRef.current;
      if (workingBatch === null) {
        const trimmed = batchName.trim();
        if (!trimmed) return;
        setPhase("creating_batch");
        try {
          workingBatch = await batchesApi.create({ name: trimmed });
          setBatch(workingBatch);
        } catch (err) {
          setTopLevelError(getApiErrorMessage(err, "Failed to create batch."));
          setPhase("error");
          return;
        }
      }

      setPhase("uploading");

      // Upload sequentially so the visualizer reads as a clear, ordered
      // progression rather than a chaotic burst. Per-file progress is wired
      // through axios's onUploadProgress.
      for (const tf of filesRef.current) {
        if (tf.status !== "queued") continue; // skip already-finished items
        _patchFile(tf.id, { status: "uploading", progress: 0 });
        try {
          const result = await documentsApi.upload(
            workingBatch.id,
            tf.file,
            (pct) => _patchFile(tf.id, { progress: pct }),
          );
          _patchFile(tf.id, {
            status: _statusFromResult(result),
            progress: 100,
            result,
          });
        } catch (err) {
          _patchFile(tf.id, {
            status: "failed",
            progress: 100,
            error: getApiErrorMessage(err, "Upload failed."),
          });
        }
      }

      // Pick up newly-saved docs (and refreshed batch counters) so the
      // workspace shows them under "saved to batch" once the user clicks
      // Continue.
      await _refreshPersisted(workingBatch.id);
      try {
        const refreshed = await batchesApi.get(workingBatch.id);
        setBatch(refreshed);
      } catch {
        /* non-fatal */
      }

      setPhase("done");
    },
    [phase, _patchFile, _refreshPersisted],
  );

  const openBatch = useCallback(
    async (next: Batch): Promise<void> => {
      setBatch(next);
      setFiles([]);
      setSelectedItemId(null);
      setTopLevelError(null);
      setPageEdits({});
      setPendingEditsId(null);
      setPhase("idle");
      setLoadingPersisted(true);
      try {
        const docs = await batchesApi.listDocuments(next.id);
        setPersistedDocuments(docs);
      } catch (err) {
        setTopLevelError(
          getApiErrorMessage(err, "Failed to load batch documents."),
        );
        setPersistedDocuments([]);
      } finally {
        setLoadingPersisted(false);
      }
    },
    [],
  );

  const continueBatch = useCallback(() => {
    // Successful items are now in `persistedDocuments`; failed/duplicate
    // items have already been seen in the visualizer. Clear the queued list
    // and return to idle so the user can add more files.
    setFiles([]);
    setSelectedItemId((curr) => {
      if (curr == null) return null;
      // Keep selection if it points at a persisted doc; drop if it pointed
      // at a now-cleared queued file.
      return persistedRef.current.some((d) => d.id === curr) ? curr : null;
    });
    // Drop any page edits attached to the just-cleared queued items.
    // Edits on persisted ids (preview-only annotations) survive.
    setPageEdits((curr) => {
      const persistedIds = new Set(persistedRef.current.map((d) => d.id));
      const next: PageEditMap = {};
      for (const [id, set] of Object.entries(curr)) {
        if (persistedIds.has(id)) next[id] = set;
      }
      return next;
    });
    setPhase("idle");
    setTopLevelError(null);
  }, []);

  const reset = useCallback(() => {
    setFiles([]);
    setPersistedDocuments([]);
    setBatch(null);
    setTopLevelError(null);
    setSelectedItemId(null);
    setPageEdits({});
    setPendingEditsId(null);
    setPhase("idle");
  }, []);

  // Overall progress: each queued/uploading file contributes equally.
  // Persisted docs are excluded — they're already 100% done by definition,
  // and including them would dilute the bar to near-zero on a re-open.
  const overallProgress = (() => {
    if (files.length === 0) return 0;
    let total = 0;
    for (const f of files) {
      if (f.status === "queued") total += 0;
      else if (f.status === "uploading") total += f.progress;
      else total += 100;
    }
    return Math.round(total / files.length);
  })();

  return {
    files,
    persistedDocuments,
    loadingPersisted,
    phase,
    topLevelError,
    batch,
    overallProgress,
    selectedItemId,
    setSelectedItemId,
    pageEdits,
    pendingEditsId,
    togglePageEdit,
    restoreAllPages,
    commitPageEdits,
    addFiles,
    removeFile,
    removeDocument,
    clearAll,
    startUpload,
    openBatch,
    continueBatch,
    reset,
  };
}
