import type { Invoice, ReviewEvent } from "@/types/invoice";
import { apiClient } from "./client";

export const reviewApi = {
  queue: (limit?: number) =>
    apiClient.get<Invoice[]>("/review/queue", { params: { limit } }).then((r) => r.data),

  getInvoice: (invoiceId: string) =>
    apiClient.get<Invoice>(`/review/${invoiceId}`).then((r) => r.data),

  editField: (invoiceId: string, field_name: string, new_value: unknown, note?: string) =>
    apiClient
      .patch<ReviewEvent>(`/review/${invoiceId}/fields`, { field_name, new_value, note })
      .then((r) => r.data),

  approve: (invoiceId: string) =>
    apiClient.post<ReviewEvent>(`/review/${invoiceId}/approve`, {}).then((r) => r.data),

  reject: (invoiceId: string, note?: string) =>
    apiClient.post<ReviewEvent>(`/review/${invoiceId}/reject`, { note }).then((r) => r.data),

  history: (invoiceId: string) =>
    apiClient.get<ReviewEvent[]>(`/review/${invoiceId}/history`).then((r) => r.data),
};
