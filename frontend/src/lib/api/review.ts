import type { CanonicalInvoicePayload } from "@/types/document";
import type { Invoice, ReviewEvent } from "@/types/invoice";
import { apiClient } from "./client";

export const reviewApi = {
  queue: (limit?: number) =>
    apiClient.get<Invoice[]>("/review/queue", { params: { limit } }).then((r) => r.data),

  save: (documentId: string, payload: CanonicalInvoicePayload) =>
    apiClient
      .post<ReviewEvent>(`/review/${documentId}/save`, payload)
      .then((r) => r.data),

  approve: (documentId: string) =>
    apiClient.post<ReviewEvent>(`/review/${documentId}/approve`, {}).then((r) => r.data),

  reject: (documentId: string, note?: string) =>
    apiClient.post<ReviewEvent>(`/review/${documentId}/reject`, { note }).then((r) => r.data),

  history: (invoiceId: string) =>
    apiClient.get<ReviewEvent[]>(`/review/${invoiceId}/history`).then((r) => r.data),
};
