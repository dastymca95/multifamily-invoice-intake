import type { ExportJob } from "@/types/invoice";
import type { ExportFormat } from "@/types/api";
import { apiClient } from "./client";

export const exportsApi = {
  createForBatch: (batchId: string, format: ExportFormat = "csv") =>
    apiClient
      .post<ExportJob>(`/exports/batch/${batchId}`, null, { params: { format } })
      .then((r) => r.data),

  list: () =>
    apiClient.get<ExportJob[]>("/exports").then((r) => r.data),

  get: (id: string) =>
    apiClient.get<ExportJob>(`/exports/${id}`).then((r) => r.data),

  getDownloadUrl: (id: string) =>
    apiClient
      .get<{ url: string; expires_in: number }>(`/exports/${id}/download-url`)
      .then((r) => r.data),

  /**
   * Trigger a browser download for a completed export job.
   *
   * The backend's `/download-url` endpoint returns one of two shapes:
   *
   *  - **S3 backend**: a fully-qualified presigned URL (`https://…?…`) whose
   *    auth signature is in the URL. `window.open` is fine — the browser
   *    request needs no Authorization header.
   *  - **Local backend (dev)**: a relative path
   *    (`/api/v1/exports/{id}/download`) that still requires the JWT bearer
   *    token. `window.open` opens a new tab without our `Authorization`
   *    header and the request 401s. So for the relative case we go through
   *    `apiClient` (which adds the header), pull the file as a blob, and
   *    trigger the download via a temporary anchor element.
   */
  download: async (id: string, format: string): Promise<void> => {
    const { url } = await exportsApi.getDownloadUrl(id);

    if (/^https?:\/\//i.test(url)) {
      // S3 presigned URL — open in a new tab.
      window.open(url, "_blank");
      return;
    }

    // Local storage — strip the apiClient baseURL prefix so axios doesn't
    // double-prepend `/api/v1`.
    const path = url.replace(/^\/api\/v1/, "") || `/exports/${id}/download`;
    const res = await apiClient.get<Blob>(path, { responseType: "blob" });

    const blobUrl = window.URL.createObjectURL(res.data);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = `export_${id}.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(blobUrl);
  },
};
