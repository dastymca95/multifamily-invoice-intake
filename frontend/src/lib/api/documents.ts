import type { Document, DocumentUploadResult } from "@/types/document";
import { apiClient } from "./client";

export const documentsApi = {
  upload: (batchId: string, files: File[]) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    return apiClient
      .post<DocumentUploadResult[]>(`/documents/upload/${batchId}`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data);
  },

  get: (id: string) =>
    apiClient.get<Document>(`/documents/${id}`).then((r) => r.data),

  listPendingReview: (limit?: number) =>
    apiClient.get<Document[]>("/documents/pending-review", { params: { limit } }).then((r) => r.data),
};
