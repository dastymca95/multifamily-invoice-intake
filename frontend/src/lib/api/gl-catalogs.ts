import type {
  GLCatalogCreate,
  GLCatalogDefault,
  GLCatalogList,
  GLCatalogOut,
  GLCatalogUpdate,
  ParsedGLUpload,
} from "@/types/gl-catalog";
import type { UsedByReport } from "@/types/dependencies";

import { apiClient } from "./client";

/**
 * GL Codes (chart of accounts) API client.
 *
 * `getDefault()` returns the built-in canonical catalog — used by
 * the workspace as a starter draft when the user has nothing saved
 * yet. Pure read; nothing is persisted server-side.
 *
 * `parseUpload()` is a one-shot parse: the file is sent to the server,
 * its rows are mapped into editable entries, and the parsed result is
 * returned. The file itself is NOT stored — the catalog the user
 * eventually creates is the authoritative artifact, not the upload.
 *
 * The mutation endpoints (`create`, `update`) return the full
 * `GLCatalogOut` so the workspace can update both the rail summary
 * and the editor pane from a single round-trip without a follow-up GET.
 */
export const glCatalogsApi = {
  list: (limit?: number, offset?: number): Promise<GLCatalogList> =>
    apiClient
      .get<GLCatalogList>("/gl-catalogs", {
        params: { limit, offset },
      })
      .then((r) => r.data),

  getDefault: (): Promise<GLCatalogDefault> =>
    apiClient
      .get<GLCatalogDefault>("/gl-catalogs/defaults/canonical")
      .then((r) => r.data),

  /**
   * Parse a chart-of-accounts upload (csv / xlsx) and return inferred
   * entries. The bytes themselves are discarded server-side — the
   * frontend uses the returned entries as the seed for an editable
   * draft, then creates a real catalog with `source="from_upload"`.
   *
   * `onProgress` mirrors `referenceApi.upload` so the modal can
   * render a progress bar.
   */
  parseUpload: (
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<ParsedGLUpload> => {
    const form = new FormData();
    form.append("file", file);
    return apiClient
      .post<ParsedGLUpload>("/gl-catalogs/parse-upload", form, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: onProgress
          ? (e) => {
              if (!e.total) return;
              const pct = Math.min(
                100,
                Math.round((e.loaded / e.total) * 100),
              );
              onProgress(pct);
            }
          : undefined,
      })
      .then((r) => r.data);
  },

  get: (id: string): Promise<GLCatalogOut> =>
    apiClient
      .get<GLCatalogOut>(`/gl-catalogs/${id}`)
      .then((r) => r.data),

  create: (body: GLCatalogCreate): Promise<GLCatalogOut> =>
    apiClient
      .post<GLCatalogOut>("/gl-catalogs", body)
      .then((r) => r.data),

  update: (
    id: string,
    body: GLCatalogUpdate,
  ): Promise<GLCatalogOut> =>
    apiClient
      .patch<GLCatalogOut>(`/gl-catalogs/${id}`, body)
      .then((r) => r.data),

  getUsedBy: (id: string): Promise<UsedByReport> =>
    apiClient
      .get<UsedByReport>(`/gl-catalogs/${id}/used-by`)
      .then((r) => r.data),

  remove: (id: string): Promise<void> =>
    apiClient.delete(`/gl-catalogs/${id}`).then(() => undefined),
};
