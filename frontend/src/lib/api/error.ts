import axios from "axios";
import type { ApiError } from "@/types/api";

/**
 * Extract a user-friendly message from an error thrown by the API client.
 *
 * - FastAPI 4xx/5xx: `{ "detail": "..." }`  → returns `detail`
 * - Network failure / timeout                → returns a generic message
 * - Anything else                            → returns the fallback
 */
export function getApiErrorMessage(err: unknown, fallback = "Something went wrong."): string {
  if (axios.isAxiosError<ApiError>(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
    if (err.code === "ERR_NETWORK") return "Cannot reach the server. Check your connection.";
    if (err.response?.status === 404) return "Not found.";
    if (err.response?.status === 401) return "Your session has expired. Please sign in again.";
    if (err.response?.status === 422) return "The submitted data was invalid.";
    return err.message || fallback;
  }
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}
