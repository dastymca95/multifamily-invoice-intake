import type {
  Document,
  DocumentDetailResponse,
  DocumentUploadResult,
} from "@/types/document";
import { apiClient } from "./client";

export const documentsApi = {
  upload: (batchId: string, file: File) => {
    const form = new FormData();
    form.append("batch_id", batchId);
    form.append("file", file);
    return apiClient
      .post<DocumentUploadResult>("/documents/upload", form, {
        headers: { "Content-Type": "multipart/form-data" },
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
};
