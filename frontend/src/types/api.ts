export interface ApiError {
  detail: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export type ExtractionStatus = "pending" | "processing" | "extracted" | "failed";
export type ReviewStatus = "pending" | "in_review" | "approved" | "rejected";
export type ExportFormat = "csv" | "xlsx" | "json";
export type ExportStatus = "pending" | "processing" | "completed" | "failed";
export type InvoiceType = "utility" | "vendor" | "unknown";
export type UtilityType = "electric" | "gas" | "water" | "sewer" | "trash" | "telecom" | "other";
