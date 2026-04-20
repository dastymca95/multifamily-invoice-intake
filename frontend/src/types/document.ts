import type { ExtractionStatus, ReviewStatus } from "./api";

export type DocumentRoute = "native_pdf" | "scanned_or_image" | "unsupported";

export interface Document {
  id: string;
  batch_id: string;
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  route_used: DocumentRoute;
  extraction_status: ExtractionStatus;
  review_status: ReviewStatus;
  checksum_sha256: string;
  error_message: string | null;
  created_at: string;
}

export interface DocumentUploadResult {
  document_id: string;
  original_filename: string;
  route_used: DocumentRoute;
  extraction_status: ExtractionStatus;
  review_status: ReviewStatus;
  duplicate: boolean;
}

export interface ExtractionRun {
  id: string;
  adapter_name: string;
  status: string;
  confidence_score: number | null;
  review_required: boolean;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
}

export interface ValidationWarning {
  field: string | null;
  code: string;
  message: string;
  severity: "warning" | "info";
}

export interface CanonicalLineItemPayload {
  line_number: number;
  description: string;
  quantity: number | string | null;
  unit: string | null;
  unit_price: number | string | null;
  amount: number | string;
  gl_code: string | null;
}

export interface CanonicalInvoicePayload {
  vendor_name: string | null;
  vendor_address: string | null;
  property_name: string | null;
  property_code: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  service_period_start: string | null;
  service_period_end: string | null;
  payment_terms: string | null;
  subtotal: number | string | null;
  tax_amount: number | string | null;
  total_amount: number | string | null;
  currency: string;
  invoice_type: string;
  utility_type: string | null;
  account_number: string | null;
  meter_number: string | null;
  line_items: CanonicalLineItemPayload[];
}

export interface DocumentDetailResponse {
  document: Document;
  extraction_run: ExtractionRun | null;
  invoice: (CanonicalInvoicePayload & { id?: string; document_id: string }) | null;
  warnings: ValidationWarning[];
}
