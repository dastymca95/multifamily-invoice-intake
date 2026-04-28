/**
 * Single-import barrel for the typed backend API client.
 *
 * Usage:
 *   import { batchesApi, documentsApi, getApiErrorMessage } from "@/lib/api";
 *
 * Each `*Api` object is a thin axios wrapper for one backend resource. All of
 * them share the auth-aware `apiClient` defined in ./client.ts.
 */
export { apiClient } from "./client";
export { getApiErrorMessage } from "./error";
export { batchesApi } from "./batches";
export { documentsApi } from "./documents";
export { reviewApi } from "./review";
export { exportsApi } from "./exports";
export { vendorPatternsApi } from "./vendor-patterns";
export { referenceApi } from "./reference";
export { importConfigsApi } from "./import-configs";
export { invoiceTemplatesApi } from "./invoice-templates";
export { invoicePatternsApi } from "./invoice-patterns";
export { glCatalogsApi } from "./gl-catalogs";
export { propertyCatalogsApi } from "./property-catalogs";
export { vendorCatalogsApi } from "./vendor-catalogs";
// Phase 3A — Operational Resolution Pipeline.
export { operationalResolutionApi } from "./operational-resolution";
