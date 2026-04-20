import type { Batch, BatchCreate } from "@/types/batch";
import type { Document } from "@/types/document";
import { apiClient } from "./client";

export const batchesApi = {
  create: (data: BatchCreate) =>
    apiClient.post<Batch>("/batches", data).then((r) => r.data),

  list: (params?: { limit?: number; offset?: number }) =>
    apiClient.get<Batch[]>("/batches", { params }).then((r) => r.data),

  get: (id: string) =>
    apiClient.get<Batch>(`/batches/${id}`).then((r) => r.data),

  listDocuments: (batchId: string, params?: { limit?: number; offset?: number }) =>
    apiClient.get<Document[]>(`/batches/${batchId}/documents`, { params }).then((r) => r.data),
};
