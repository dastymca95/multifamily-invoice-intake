import type {
  ImportTemplateValidationResult,
  InvoiceTemplateCreate,
  InvoiceTemplateDefault,
  InvoiceTemplateList,
  InvoiceTemplateOut,
  InvoiceTemplateUpdate,
} from "@/types/invoice-template";
import type { UsedByReport } from "@/types/dependencies";

import { apiClient } from "./client";

/**
 * Invoice Template Builder API client.
 *
 * `getDefault()` returns the built-in canonical template — used by
 * the workspace as a starter draft when the user has nothing saved
 * yet. Pure read; nothing is persisted server-side.
 *
 * The mutation endpoints (`create`, `update`) return the full
 * `InvoiceTemplateOut` so the workspace can update both the rail
 * summary and the editor pane from a single round-trip without a
 * follow-up GET.
 */
export const invoiceTemplatesApi = {
  list: (limit?: number, offset?: number): Promise<InvoiceTemplateList> =>
    apiClient
      .get<InvoiceTemplateList>("/invoice-templates", {
        params: { limit, offset },
      })
      .then((r) => r.data),

  getDefault: (): Promise<InvoiceTemplateDefault> =>
    apiClient
      .get<InvoiceTemplateDefault>("/invoice-templates/defaults/canonical")
      .then((r) => r.data),

  get: (id: string): Promise<InvoiceTemplateOut> =>
    apiClient
      .get<InvoiceTemplateOut>(`/invoice-templates/${id}`)
      .then((r) => r.data),

  validate: (id: string): Promise<ImportTemplateValidationResult> =>
    apiClient
      .get<ImportTemplateValidationResult>(`/invoice-templates/${id}/validate`)
      .then((r) => r.data),

  getUsedBy: (id: string): Promise<UsedByReport> =>
    apiClient
      .get<UsedByReport>(`/invoice-templates/${id}/used-by`)
      .then((r) => r.data),

  create: (body: InvoiceTemplateCreate): Promise<InvoiceTemplateOut> =>
    apiClient
      .post<InvoiceTemplateOut>("/invoice-templates", body)
      .then((r) => r.data),

  update: (
    id: string,
    body: InvoiceTemplateUpdate,
  ): Promise<InvoiceTemplateOut> =>
    apiClient
      .patch<InvoiceTemplateOut>(`/invoice-templates/${id}`, body)
      .then((r) => r.data),

  remove: (id: string): Promise<void> =>
    apiClient.delete(`/invoice-templates/${id}`).then(() => undefined),
};
