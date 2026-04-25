/**
 * Shared extracted-invoice field registry.
 *
 * Backend authority:
 * `backend/app/domain/extracted_invoice_fields.py`.
 *
 * This frontend mirror keeps synchronous dropdowns and fallbacks aligned
 * with the backend response. Custom Invoice Builder fields remain pattern-
 * specific and are not controlled by this registry.
 */

export type ExtractedFieldDataType =
  | "text"
  | "number"
  | "currency"
  | "date"
  | "boolean";

export interface ExtractedInvoiceFieldDescriptor {
  key: string;
  label: string;
  description?: string | null;
  default_data_type?: ExtractedFieldDataType | string | null;
  aliases?: readonly string[];
  category?: string | null;
  built_in?: boolean;
  commonly_required?: boolean;
  output_only?: boolean;
}

export const EXTRACTED_INVOICE_FIELD_REGISTRY = [
  {
    key: "vendor_name",
    label: "Vendor Name",
    description: "Name of the supplier or biller on the invoice.",
    aliases: ["vendor", "payee_name", "supplier_name"],
    category: "vendor",
    default_data_type: "text",
    built_in: true,
    commonly_required: true,
    output_only: false,
  },
  {
    key: "vendor_address",
    label: "Vendor Address",
    description: "Supplier or remittance address printed on the invoice.",
    aliases: ["remit_to_address", "supplier_address"],
    category: "vendor",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "vendor_tax_id",
    label: "Vendor Tax ID",
    description: "Tax identifier for the vendor when present.",
    aliases: ["tax_id", "tin", "ein"],
    category: "vendor",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "bill_to_name",
    label: "Bill To Name",
    description: "Bill-to entity name printed on the invoice.",
    aliases: ["billing_name"],
    category: "bill_to",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "bill_to_address",
    label: "Bill To Address",
    description: "Bill-to address printed on the invoice.",
    aliases: ["bill_to_addr"],
    category: "bill_to",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "billing_address",
    label: "Billing Address",
    description: "Billing address when the invoice uses billing terminology.",
    aliases: ["billing_addr"],
    category: "bill_to",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "property_name",
    label: "Property Name",
    description: "Property or community name visible on the invoice.",
    aliases: ["community_name", "site_name"],
    category: "property",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "property_code",
    label: "Property Code",
    description: "Property code or abbreviation visible on the invoice.",
    aliases: ["property_abbreviation", "property_abbr", "site_code"],
    category: "property",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "invoice_number",
    label: "Invoice Number",
    description: "Vendor-issued invoice, statement, or bill number.",
    aliases: ["invoice_no", "invoice_num", "invoice_id", "inv_no"],
    category: "metadata",
    default_data_type: "text",
    built_in: true,
    commonly_required: true,
    output_only: false,
  },
  {
    key: "invoice_date",
    label: "Invoice Date",
    description: "Date printed as the invoice, statement, or bill date.",
    aliases: ["bill_date", "statement_date", "accounting_date"],
    category: "dates",
    default_data_type: "date",
    built_in: true,
    commonly_required: true,
    output_only: false,
  },
  {
    key: "due_date",
    label: "Due Date",
    description: "Payment due date printed on the invoice.",
    aliases: ["payment_due_date"],
    category: "dates",
    default_data_type: "date",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "service_period_start",
    label: "Service Period Start",
    description: "First date in the invoice service period.",
    aliases: ["period_start", "service_from", "service_start"],
    category: "dates",
    default_data_type: "date",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "service_period_end",
    label: "Service Period End",
    description: "Last date in the invoice service period.",
    aliases: ["period_end", "service_to", "service_end"],
    category: "dates",
    default_data_type: "date",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "payment_terms",
    label: "Payment Terms",
    description: "Payment terms printed on the invoice.",
    aliases: ["terms"],
    category: "metadata",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "subtotal",
    label: "Subtotal",
    description: "Invoice subtotal before taxes, fees, or credits.",
    aliases: ["sub_total"],
    category: "amounts",
    default_data_type: "currency",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "tax_amount",
    label: "Tax Amount",
    description: "Tax amount charged on the invoice.",
    aliases: ["tax", "sales_tax"],
    category: "amounts",
    default_data_type: "currency",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "total_amount",
    label: "Total Amount",
    description: "Invoice total or balance due.",
    aliases: ["amount", "total", "invoice_total", "total_due", "balance_due"],
    category: "amounts",
    default_data_type: "currency",
    built_in: true,
    commonly_required: true,
    output_only: false,
  },
  {
    key: "previous_balance",
    label: "Previous Balance",
    description: "Previous balance carried into the current invoice.",
    aliases: ["prior_balance"],
    category: "amounts",
    default_data_type: "currency",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "current_charges",
    label: "Current Charges",
    description: "Current-period charges before prior balance adjustments.",
    aliases: ["current_amount", "new_charges"],
    category: "amounts",
    default_data_type: "currency",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "late_fee",
    label: "Late Fee",
    description: "Late fee or penalty amount when separately stated.",
    aliases: ["late_charge", "penalty"],
    category: "amounts",
    default_data_type: "currency",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "currency",
    label: "Currency",
    description: "Currency code or symbol printed on the invoice.",
    aliases: ["currency_code"],
    category: "amounts",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "invoice_type",
    label: "Invoice Type",
    description: "Invoice type or bill-credit indicator when printed.",
    aliases: ["bill_type", "document_type"],
    category: "classification",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "utility_type",
    label: "Utility Type",
    description: "Utility or service category when printed.",
    aliases: ["service_type"],
    category: "classification",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "account_number",
    label: "Account Number",
    description: "Vendor account number for this invoice.",
    aliases: ["acct_number", "acct_no", "account_no"],
    category: "account",
    default_data_type: "text",
    built_in: true,
    commonly_required: true,
    output_only: false,
  },
  {
    key: "meter_number",
    label: "Meter Number",
    description: "Meter identifier printed on a utility invoice.",
    aliases: ["meter_no", "meter_id"],
    category: "account",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "service_address",
    label: "Service Address",
    description: "Physical service address associated with the bill.",
    aliases: ["service_addr", "service_location"],
    category: "property",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "po_number",
    label: "PO Number",
    description: "Purchase order number printed on the invoice.",
    aliases: ["purchase_order", "purchase_order_number", "po_no"],
    category: "metadata",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "line_item_description",
    label: "Line Item Description",
    description: "Description text for a line item or charge.",
    aliases: ["line_description", "item_description", "description"],
    category: "line_items",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
  {
    key: "notes",
    label: "Notes",
    description: "Invoice note or memo text when extracted explicitly.",
    aliases: ["memo", "comments"],
    category: "metadata",
    default_data_type: "text",
    built_in: true,
    commonly_required: false,
    output_only: false,
  },
] as const satisfies readonly ExtractedInvoiceFieldDescriptor[];

export type InvoiceExtractedField =
  (typeof EXTRACTED_INVOICE_FIELD_REGISTRY)[number]["key"];

export const INVOICE_EXTRACTED_FIELDS = EXTRACTED_INVOICE_FIELD_REGISTRY.map(
  (field) => field.key,
) as readonly InvoiceExtractedField[];

export const INVOICE_EXTRACTED_FIELD_LABEL = Object.fromEntries(
  EXTRACTED_INVOICE_FIELD_REGISTRY.map((field) => [field.key, field.label]),
) as Record<InvoiceExtractedField, string>;

const FIELD_BY_KEY = new Map<string, ExtractedInvoiceFieldDescriptor>(
  EXTRACTED_INVOICE_FIELD_REGISTRY.map((field) => [field.key, field]),
);

const ALIAS_TO_KEY = new Map<string, InvoiceExtractedField>();
for (const field of EXTRACTED_INVOICE_FIELD_REGISTRY) {
  for (const alias of field.aliases ?? []) {
    ALIAS_TO_KEY.set(alias.trim().toLowerCase(), field.key);
  }
}

export function normalizeExtractedFieldKey(
  key: string | null | undefined,
): string | null {
  if (key == null) return null;
  const cleaned = String(key).trim().toLowerCase();
  if (cleaned.length === 0) return null;
  if (FIELD_BY_KEY.has(cleaned)) return cleaned;
  return ALIAS_TO_KEY.get(cleaned) ?? cleaned;
}

export function resolveExtractedFieldDescriptor(
  key: string | null | undefined,
): ExtractedInvoiceFieldDescriptor | null {
  const normalized = normalizeExtractedFieldKey(key);
  if (normalized == null) return null;
  return FIELD_BY_KEY.get(normalized) ?? null;
}

export function isKnownExtractedFieldKey(
  key: string | null | undefined,
): boolean {
  const normalized = normalizeExtractedFieldKey(key);
  return normalized != null && FIELD_BY_KEY.has(normalized);
}

export function getExtractedFieldAliases(
  key: string | null | undefined,
): readonly string[] {
  return resolveExtractedFieldDescriptor(key)?.aliases ?? [];
}
