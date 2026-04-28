import type {
  OperationalResolutionRequest,
  OperationalResolutionResult,
} from "@/types/operational-resolution";

import { apiClient } from "./client";

/**
 * Phase 3A — Operational Resolution Pipeline API client.
 *
 * Single endpoint that runs the same dry-run resolver as Phase 2B,
 * but in a "production-shaped" envelope carrying ``document_id`` /
 * ``batch_id`` operational ids. Diagnostic-only — never mutates,
 * never exports, never creates Review Queue records.
 *
 * The ``signal`` option lets callers abort in-flight requests when
 * inputs change (Run-clicked-twice race, panel close, etc.).
 *
 * Lives in its own client module (vs. tacking onto
 * ``invoiceTemplatesApi``) because the endpoint sits at
 * ``/operational-resolution/run`` rather than under
 * ``/invoice-templates`` — keeping the namespace clean makes the
 * future Phase 3C+ extensions (per-document / per-batch routes)
 * easier to plug in.
 */
export const operationalResolutionApi = {
  run: (
    payload: OperationalResolutionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<OperationalResolutionResult> =>
    apiClient
      .post<OperationalResolutionResult>(
        "/operational-resolution/run",
        payload,
        options?.signal ? { signal: options.signal } : undefined,
      )
      .then((r) => r.data),
};
