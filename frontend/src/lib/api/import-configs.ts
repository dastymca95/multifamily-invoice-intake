import type {
  ImportConfigCreate,
  ImportConfigDetail,
  ImportConfigList,
  ImportConfigUpdate,
} from "@/types/import-config";

import { apiClient } from "./client";

/**
 * Import Builder API client.
 *
 * Detail endpoints (`get`, `create`, `update`) return the full
 * `ImportConfigDetail` bundle (config + freshly-rendered preview)
 * so the workspace can update both panes from a single round-trip.
 *
 * The list endpoint returns the lightweight `ImportConfigSummary` —
 * used to render the left rail without paying for a per-config
 * preview computation.
 */
export const importConfigsApi = {
  list: (limit?: number, offset?: number): Promise<ImportConfigList> =>
    apiClient
      .get<ImportConfigList>("/import-configs", {
        params: { limit, offset },
      })
      .then((r) => r.data),

  get: (id: string): Promise<ImportConfigDetail> =>
    apiClient
      .get<ImportConfigDetail>(`/import-configs/${id}`)
      .then((r) => r.data),

  create: (body: ImportConfigCreate): Promise<ImportConfigDetail> =>
    apiClient
      .post<ImportConfigDetail>("/import-configs", body)
      .then((r) => r.data),

  update: (
    id: string,
    body: ImportConfigUpdate,
  ): Promise<ImportConfigDetail> =>
    apiClient
      .patch<ImportConfigDetail>(`/import-configs/${id}`, body)
      .then((r) => r.data),

  remove: (id: string): Promise<void> =>
    apiClient.delete(`/import-configs/${id}`).then(() => undefined),
};
