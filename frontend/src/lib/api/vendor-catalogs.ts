import type {
  ParsedVendorUpload,
  VendorCatalogCreate,
  VendorCatalogDefault,
  VendorCatalogList,
  VendorCatalogOut,
  VendorCatalogUpdate,
} from "@/types/vendor-catalog";

import { apiClient } from "./client";

/**
 * Vendors (vendor master data) API client.
 *
 * `getDefault()` returns the built-in canonical catalog — used by
 * the workspace as a starter draft when the user has nothing saved
 * yet. Pure read; nothing is persisted server-side.
 *
 * `parseUpload()` is a one-shot parse: the file is sent to the server,
 * its rows are surfaced as raw source columns + rows + a suggested
 * mapping, and the parsed result is returned. The file itself is NOT
 * stored — the catalog the user eventually creates from the
 * user-confirmed mapping is the authoritative artifact, not the
 * upload.
 *
 * The mutation endpoints (`create`, `update`) return the full
 * `VendorCatalogOut` so the workspace can update both the rail summary
 * and the editor pane from a single round-trip without a follow-up
 * GET.
 */
export const vendorCatalogsApi = {
  list: (limit?: number, offset?: number): Promise<VendorCatalogList> =>
    apiClient
      .get<VendorCatalogList>("/vendor-catalogs", {
        params: { limit, offset },
      })
      .then((r) => r.data),

  getDefault: (): Promise<VendorCatalogDefault> =>
    apiClient
      .get<VendorCatalogDefault>("/vendor-catalogs/defaults/canonical")
      .then((r) => r.data),

  /**
   * Parse a vendor master upload (csv / xlsx) and return its source
   * columns + rows + a suggested canonical mapping. The bytes
   * themselves are discarded server-side — the frontend uses the
   * returned shape as the seed for the mapping step, then creates a
   * real catalog with `source="from_upload"` from the resulting
   * canonical entries.
   *
   * `onProgress` mirrors `referenceApi.upload` so the modal can
   * render a progress bar.
   */
  parseUpload: (
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<ParsedVendorUpload> => {
    const form = new FormData();
    form.append("file", file);
    return apiClient
      .post<ParsedVendorUpload>("/vendor-catalogs/parse-upload", form, {
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

  get: (id: string): Promise<VendorCatalogOut> =>
    apiClient
      .get<VendorCatalogOut>(`/vendor-catalogs/${id}`)
      .then((r) => r.data),

  create: (body: VendorCatalogCreate): Promise<VendorCatalogOut> =>
    apiClient
      .post<VendorCatalogOut>("/vendor-catalogs", body)
      .then((r) => r.data),

  update: (
    id: string,
    body: VendorCatalogUpdate,
  ): Promise<VendorCatalogOut> =>
    apiClient
      .patch<VendorCatalogOut>(`/vendor-catalogs/${id}`, body)
      .then((r) => r.data),

  remove: (id: string): Promise<void> =>
    apiClient.delete(`/vendor-catalogs/${id}`).then(() => undefined),
};
