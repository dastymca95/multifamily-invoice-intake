import type { InvoiceType, ReviewStatus, UtilityType } from "./api";

export interface LineItem {
  id: string;
  line_number: number;
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  amount: number;
  gl_code: string | null;
}

export interface Invoice {
  id: string;
  document_id: string;
  vendor_name: string;
  vendor_address: string | null;
  property_name: string | null;
  property_code: string | null;
  invoice_number: string;
  invoice_date: string | null;
  due_date: string | null;
  service_period_start: string | null;
  service_period_end: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  total_amount: number;
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
