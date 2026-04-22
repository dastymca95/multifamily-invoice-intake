import type {
  ReferenceFile,
  ReferenceKind,
  ReferenceListResponse,
} from "@/types/reference";
import type { ResmanPreviewResponse } from "@/types/resman-preview";

import { apiClient } from "./client";

export const referenceApi = {
  /**
   * Fetch the complete list of reference slots.
   *
   * Returns one entry per known kind (4 today). Slots without an
   * uploaded file have `current: null`. The response order is the
   * canonical order the workspace renders cards in.
   */
  list: (): Promise<ReferenceListResponse> =>
    apiClient.get<ReferenceListResponse>("/reference-data").then((r) => r.data),

  /**
   * Upload (or replace) the file for a single kind.
   *
   * The server stores the bytes, parses headers + row count, and
   * persists a sample of the first few rows for inspection. Parse
   * failures don't abort the upload — the response still carries the
   * stored file with `parse_status: "parse_failed"` and a
   * human-readable `parse_error`.
   *
   * Re-uploading the same kind replaces the previous file in place
   * (storage swap + DB update) — there is no version history.
   */
  upload: (
    kind: ReferenceKind,
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<ReferenceFile> => {
    const form = new FormData();
    form.append("file", file);
    return apiClient
      .post<ReferenceFile>(`/reference-data/${kind}/upload`, form, {
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

  /**
   * Drop the stored file for a kind. 404 if nothing is stored — callers
   * should usually disable the button when `current` is null rather
   * than relying on the error.
   */
  remove: (kind: ReferenceKind): Promise<void> =>
    apiClient.delete(`/reference-data/${kind}`).then(() => undefined),

  /**
   * Build a spreadsheet-shaped preview of the future ResMan-ready import
   * file from the uploaded template + reference reports + recent
   * approved invoices.
   *
   * Always returns a structurally complete response — empty arrays
   * rather than missing keys when prerequisites aren't uploaded yet, so
   * the UI can render a single skeleton with empty-state copy.
   */
  preview: (limit?: number): Promise<ResmanPreviewResponse> =>
    apiClient
      .get<ResmanPreviewResponse>("/reference-data/preview", {
        params: limit != null ? { limit } : undefined,
      })
      .then((r) => r.data),
};
