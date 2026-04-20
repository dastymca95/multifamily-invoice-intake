import type { InvoiceType, ReviewStatus, UtilityType } from "./api";

/**
 * Numeric fields backed by Postgres NUMERIC are serialized by FastAPI/Pydantic
 * as JSON strings to preserve column scale (e.g. "1284.0000"). Treat them as
 * strings on the wire and parse with Number()/Decimal at the call site.
 */
export type DecimalString = string;

export interface LineItem {
  id: string;
  line_number: number;
  description: string;
  quantity: DecimalString | null;
  unit: string | null;
  unit_price: DecimalString | null;
  amount: DecimalString;
  gl_code: string | null;
}

export interface Invoice {
  id: string;
  document_id: string;
  // Phase 1 review-first schema: header fields are reviewer-fillable and
  // therefore nullable until saved.
  vendor_name: string | null;
  vendor_address: string | null;
  property_name: string | null;
  property_code: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  service_period_start: string | null;
  service_period_end: string | null;
  subtotal: DecimalString | null;
  tax_amount: DecimalString | null;
  total_amount: DecimalString | null;
  currency: string;
  invoice_type: InvoiceType;
  utility_type: UtilityType | null;
  account_number: string | null;
  meter_number: string | null;
  extraction_confidence: number | null;
  lines: LineItem[];
  updated_at: string;
}

export interface ReviewEvent {
  id: string;
  invoice_id: string;
  reviewer_id: string;
  event_type: string;
  field_name: string | null;
  value_before: Record<string, unknown> | null;
  value_after: Record<string, unknown> | null;
  note: string | null;
  created_at: string;
}

export interface VendorPattern {
  id: string;
  vendor_name_normalized: string;
  vendor_name_display: string;
  field_hints: Record<string, unknown>;
  confidence_score: number;
  sample_count: number;
  updated_at: string;
}

export interface ExportJob {
  id: string;
  format: string;
  status: string;
  batch_id: string | null;
  requested_by: string;
  row_count: number | null;
  storage_key: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}
