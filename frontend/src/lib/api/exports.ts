import type { ExportJob } from "@/types/invoice";
import type { ExportFormat } from "@/types/api";
import { apiClient } from "./client";

export const exportsApi = {
  createForBatch: (batchId: string, format: ExportFormat = "csv") =>
    apiClient
      .post<ExportJob>(`/exports/batch/${batchId}`, null, { params: { format } })
      .then((r) => r.data),

  list: () =>
    apiClient.get<ExportJob[]>("/exports").then((r) => r.data),

  get: (id: string) =>
    apiClient.get<ExportJob>(`/exports/${id}`).then((r) => r.data),

  getDownloadUrl: (id: string) =>
    apiClient
      .get<{ url: string; expires_in: number }>(`/exports/${id}/download-url`)
      .then((r) => r.data),
};
