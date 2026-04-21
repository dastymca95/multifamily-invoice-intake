import type {
  Document,
  DocumentDetailResponse,
  DocumentUploadResult,
} from "@/types/document";
import { apiClient } from "./client";

export const documentsApi = {
  /**
   * Upload a single file to the given batch.
   *
   * @param onProgress  Optional callback invoked with an integer 0-100 as
   *                    bytes are sent. Backed by axios's `onUploadProgress`,
   *                    which fires from XMLHttpRequest progress events. Only
   *                    measures *upload* progress; the server's extraction
   *                    work happens in the response phase and isn't reflected.
   */
  upload: (
    batchId: string,
    file: File,
    onProgress?: (percent: number) => void,
  ) => {
    const form = new FormData();
    form.append("batch_id", batchId);
    form.append("file", file);
    return apiClient
      .post<DocumentUploadResult>("/documents/upload", form, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: onProgress
          ? (e) => {
              if (!e.total) return;
              const pct = Math.min(100, Math.round((e.loaded / e.total) * 100));
              onProgress(pct);
            }
          : undefined,
      })
      .then((r) => r.data);
  },

  uploadMany: async (batchId: string, files: File[]): Promise<DocumentUploadResult[]> => {
    const out: DocumentUploadResult[] = [];
    for (const f of files) {
      out.push(await documentsApi.upload(batchId, f));
    }
    return out;
  },

  get: (id: string) =>
    apiClient.get<DocumentDetailResponse>(`/documents/${id}`).then((r) => r.data),

  listPendingReview: (limit?: number) =>
    apiClient.get<Document[]>("/documents/pending-review", { params: { limit } }).then((r) => r.data),

  /**
   * Permanently delete a document, its extraction history, and its derived
   * invoice. The server cascades through invoice/lines/review_events and
   * decrements the owning batch's denormalised counters.
   *
   * Used by the Upload workspace's "Remove from batch" action on a persisted
   * document tile.
   */
  delete: (id: string): Promise<void> =>
    apiClient.delete(`/documents/${id}`).then(() => undefined),

  /**
   * Fetch the raw file bytes for a persisted document. The caller is
   * responsible for `URL.createObjectURL` + `URL.revokeObjectURL` lifecycle.
   *
   * Used by the preview pane when the user reopens an existing batch — we
   * don't have the original `File` object anymore, so we stream the bytes
   * back from storage through the JWT-protected backend route.
   *
   * @param version  Optional cache-buster appended as `?v=…`. The backend
   *                 ignores unknown query params; the value just changes
   *                 the URL the browser caches against. Pass the document's
   *                 current `checksum_sha256` so a trim/re-extract makes
   *                 the next fetch bypass the previous cached blob.
   */
  fetchFileBlob: async (id: string, version?: string): Promise<Blob> => {
    const res = await apiClient.get(`/documents/${id}/file`, {
      responseType: "blob",
      params: version ? { v: version } : undefined,
    });
    return res.data as Blob;
  },

  /**
   * Re-write a persisted PDF on the server, dropping the listed 1-indexed
   * pages, and re-run extraction against the trimmed file.
   *
   * Returns the same enriched response shape as `get(id)` — the trimmed
   * Document with its new size/checksum/route + the freshly-extracted
   * invoice (if extraction succeeded). The frontend uses this to swap the
   * doc into `persistedDocuments` and bust the preview blob cache.
   *
   * Server-side this:
   *   1. Trims the PDF with pypdf
   *   2. Writes new bytes under a new checksum-derived storage key
   *   3. Cascade-deletes the existing invoice + extraction_runs
   *      (review_events + invoice_lines fall via DB cascade)
   *   4. Updates the Document row in place (storage_key, checksum,
   *      file_size_bytes, route_used, statuses reset to "pending")
   *   5. Best-effort deletes the old storage key
   *   6. Re-runs extraction inline so the response carries fresh data
   *
   * Errors:
   *   - 422 PageTrimError (empty list, out-of-range, all pages, parse
   *     failure, size limit exceeded)
   *   - 404 if the document or its stored file is missing
   */
  trimPages: (
    id: string,
    removedPages: number[],
  ): Promise<DocumentDetailResponse> =>
    apiClient
      .post<DocumentDetailResponse>(`/documents/${id}/trim`, {
        removed_pages: removedPages,
      })
      .then((r) => r.data),
};
