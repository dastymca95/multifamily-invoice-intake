import type { VendorPattern } from "@/types/invoice";
import { apiClient } from "./client";

export const vendorPatternsApi = {
  list: (q?: string, limit?: number) =>
    apiClient.get<VendorPattern[]>("/vendor-patterns", { params: { q, limit } }).then((r) => r.data),

  get: (id: string) =>
    apiClient.get<VendorPattern>(`/vendor-patterns/${id}`).then((r) => r.data),

  update: (id: string, field_hints: Record<string, unknown>) =>
    apiClient.patch<VendorPattern>(`/vendor-patterns/${id}`, { field_hints }).then((r) => r.data),

  delete: (id: string) =>
    apiClient.delete(`/vendor-patterns/${id}`),
};
