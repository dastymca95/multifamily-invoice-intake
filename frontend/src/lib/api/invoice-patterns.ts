import type { InvoicePatternImportCoverage } from "@/types/invoice-pattern-coverage";
import type {
  InvoiceExtractedFieldsResponse,
  InvoicePatternCreate,
  InvoicePatternFieldOptionsResponse,
  InvoicePatternList,
  InvoicePatternOut,
  InvoicePatternUpdate,
} from "@/types/invoice-pattern";
import type { UsedByReport } from "@/types/dependencies";

import { apiClient } from "./client";

/**
 * Invoice Builder API client.
 *
 * `getCanonicalFields()` returns the canonical extracted-field
 * descriptors (key + human label) — the runtime authority for the
 * region inspector dropdown. Cached at workspace open so the editor
 * doesn't refetch on every selection.
 *
 * The mutation endpoints (`create`, `update`) return the full
 * `InvoicePatternOut` so the workspace can update both the rail
 * summary and the editor pane from a single round-trip without a
 * follow-up GET. Same pattern as the Import Builder client.
 */
export const invoicePatternsApi = {
  list: (limit?: number, offset?: number): Promise<InvoicePatternList> =>
    apiClient
      .get<InvoicePatternList>("/invoice-patterns", {
        params: { limit, offset },
      })
      .then((r) => r.data),

  getCanonicalFields: (): Promise<InvoiceExtractedFieldsResponse> =>
    apiClient
      .get<InvoiceExtractedFieldsResponse>(
        "/invoice-patterns/canonical-fields",
      )
      .then((r) => r.data),

  get: (id: string): Promise<InvoicePatternOut> =>
    apiClient
      .get<InvoicePatternOut>(`/invoice-patterns/${id}`)
      .then((r) => r.data),

  /**
   * Lightweight per-pattern field-option lookup. Returns just the
   * field universe (canonical built-ins folded with operator overrides
   * + custom fields) — NEVER the heavy source files. Used by the
   * Import Builder extraction-binding picker to populate its field
   * dropdown per bound pattern.
   */
  getFields: (id: string): Promise<InvoicePatternFieldOptionsResponse> =>
    apiClient
      .get<InvoicePatternFieldOptionsResponse>(
        `/invoice-patterns/${id}/fields`,
      )
      .then((r) => r.data),

  /**
   * Import Builder coverage view for a single pattern. With no
   * `templateId` argument, the response covers EVERY workspace
   * template — that's what the right-rail Coverage panel needs to
   * power its "All templates" drop-down. Pass a `templateId` to scope
   * down to one (Coverage panel after the operator picks a single
   * template; cheaper round-trip when the picker is filtered).
   *
   * The pattern row never tracks reverse pointers — this endpoint
   * derives them from `extraction_bindings` on each rule cell at read
   * time. Safe to refetch on every pattern open / template change.
   */
  getImportCoverage: (
    id: string,
    templateId?: string,
  ): Promise<InvoicePatternImportCoverage> =>
    apiClient
      .get<InvoicePatternImportCoverage>(
        `/invoice-patterns/${id}/import-coverage`,
        { params: templateId ? { template_id: templateId } : undefined },
      )
      .then((r) => r.data),

  create: (body: InvoicePatternCreate): Promise<InvoicePatternOut> =>
    apiClient
      .post<InvoicePatternOut>("/invoice-patterns", body)
      .then((r) => r.data),

  update: (
    id: string,
    body: InvoicePatternUpdate,
  ): Promise<InvoicePatternOut> =>
    apiClient
      .patch<InvoicePatternOut>(`/invoice-patterns/${id}`, body)
      .then((r) => r.data),

  getUsedBy: (id: string): Promise<UsedByReport> =>
    apiClient
      .get<UsedByReport>(`/invoice-patterns/${id}/used-by`)
      .then((r) => r.data),

  remove: (id: string): Promise<void> =>
    apiClient.delete(`/invoice-patterns/${id}`).then(() => undefined),
};
