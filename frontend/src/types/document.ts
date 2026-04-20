import type { ExtractionStatus, ReviewStatus } from "./api";

export interface Document {
  id: string;
  batch_id: string;
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  document_kind: "native_pdf" | "scanned_pdf" | "image" | "unknown";
  extraction_status: ExtractionStatus;
  review_status: ReviewStatus;
  checksum_sha256: string;
  error_message: string | null;
  created_at: string;
}

export interface DocumentUploadResult {
  document_id: string;
  original_filename: string;
  document_kind: string;
  duplicate: boolean;
}
