import type {
  ParsedPropertyUpload,
  PropertyCatalogCreate,
  PropertyCatalogDefault,
  PropertyCatalogList,
  PropertyCatalogOut,
  PropertyCatalogUpdate,
} from "@/types/property-catalog";
import type { UsedByReport } from "@/types/dependencies";

import { apiClient } from "./client";

/**
 * Properties (property/unit master) API client.
 *
 * `getDefault()` returns the built-in canonical catalog — used by the
 * workspace as a starter draft when the user has nothing saved yet.
 * Pure read; nothing is persisted server-side.
 *
 * `parseUpload()` is a one-shot parse of a SINGLE file. The file is
 * sent to the server, its rows are surfaced as raw source data + a
 * suggested mapping, and the parsed result is returned. The file
 * itself is NOT stored — the catalog the user eventually creates from
 * the merged + mapped rows is the authoritative artifact.
 *
 * Multi-file uploads are orchestrated client-side: call `parseUpload`
 * once per file, accumulate the results, present a per-file mapping
 * UI, then `mergePropertyFiles` (in `@/types/property-catalog`) the
 * confirmed mappings into one canonical entries list before calling
 * `create`.
 *
 * The mutation endpoints (`create`, `update`) return the full
 * `PropertyCatalogOut` so the workspace can update both the rail
 * summary and the editor pane from a single round-trip without a
 * follow-up GET.
 */
export const propertyCatalogsApi = {
  list: (limit?: number, offset?: number): Promise<PropertyCatalogList> =>
    apiClient
      .get<PropertyCatalogList>("/property-catalogs", {
        params: { limit, offset },
      })
      .then((r) => r.data),

  getDefault: (): Promise<PropertyCatalogDefault> =>
    apiClient
      .get<PropertyCatalogDefault>("/property-catalogs/defaults/canonical")
      .then((r) => r.data),

  /**
   * Parse ONE property upload (csv / xlsx) and return source columns +
   * rows + a suggested canonical-field mapping. The bytes themselves
   * are discarded server-side. Multi-file workflows call this per file
   * and merge results in the client.
   *
   * `onProgress` mirrors `referenceApi.upload` so the modal can render
   * a progress bar per file.
   */
  parseUpload: (
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<ParsedPropertyUpload> => {
    const form = new FormData();
    form.append("file", file);
    return apiClient
      .post<ParsedPropertyUpload>("/property-catalogs/parse-upload", form, {
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

  get: (id: string): Promise<PropertyCatalogOut> =>
    apiClient
      .get<PropertyCatalogOut>(`/property-catalogs/${id}`)
      .then((r) => r.data),

  create: (body: PropertyCatalogCreate): Promise<PropertyCatalogOut> =>
    apiClient
      .post<PropertyCatalogOut>("/property-catalogs", body)
      .then((r) => r.data),

  update: (
    id: string,
    body: PropertyCatalogUpdate,
  ): Promise<PropertyCatalogOut> =>
    apiClient
      .patch<PropertyCatalogOut>(`/property-catalogs/${id}`, body)
      .then((r) => r.data),

  getUsedBy: (id: string): Promise<UsedByReport> =>
    apiClient
      .get<UsedByReport>(`/property-catalogs/${id}/used-by`)
      .then((r) => r.data),

  remove: (id: string): Promise<void> =>
    apiClient.delete(`/property-catalogs/${id}`).then(() => undefined),
};
