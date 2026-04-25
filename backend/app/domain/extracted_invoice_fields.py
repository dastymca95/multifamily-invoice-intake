"""Shared extracted-invoice field registry.

This module is the backend source of truth for built-in invoice fields
that can be extracted from an invoice pattern and referenced by Import
Builder rule cells. It also owns legacy aliases so older templates keep
loading without a destructive JSON rewrite.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ExtractedFieldDataType = Literal["text", "number", "currency", "date", "boolean"]


@dataclass(frozen=True, slots=True)
class ExtractedInvoiceFieldDescriptor:
    """One built-in extracted invoice field."""

    key: str
    label: str
    description: str | None = None
    default_data_type: ExtractedFieldDataType = "text"
    aliases: tuple[str, ...] = ()
    category: str | None = None
    built_in: bool = True
    commonly_required: bool = False
    output_only: bool = False


# Keep the order operator-friendly: identity, parties, dates, amounts,
# operational/accounting hints. Custom pattern fields remain separate.
EXTRACTED_INVOICE_FIELD_REGISTRY: tuple[ExtractedInvoiceFieldDescriptor, ...] = (
    ExtractedInvoiceFieldDescriptor(
        key="vendor_name",
        label="Vendor Name",
        description="Name of the supplier or biller on the invoice.",
        aliases=("vendor", "payee_name", "supplier_name"),
        category="vendor",
        commonly_required=True,
    ),
    ExtractedInvoiceFieldDescriptor(
        key="vendor_address",
        label="Vendor Address",
        description="Supplier or remittance address printed on the invoice.",
        aliases=("remit_to_address", "supplier_address"),
        category="vendor",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="vendor_tax_id",
        label="Vendor Tax ID",
        description="Tax identifier for the vendor when present.",
        aliases=("tax_id", "tin", "ein"),
        category="vendor",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="bill_to_name",
        label="Bill To Name",
        description="Bill-to entity name printed on the invoice.",
        aliases=("billing_name",),
        category="bill_to",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="bill_to_address",
        label="Bill To Address",
        description="Bill-to address printed on the invoice.",
        aliases=("bill_to_addr",),
        category="bill_to",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="billing_address",
        label="Billing Address",
        description="Billing address when the invoice uses billing terminology.",
        aliases=("billing_addr",),
        category="bill_to",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="property_name",
        label="Property Name",
        description="Property or community name visible on the invoice.",
        aliases=("community_name", "site_name"),
        category="property",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="property_code",
        label="Property Code",
        description="Property code or abbreviation visible on the invoice.",
        aliases=("property_abbreviation", "property_abbr", "site_code"),
        category="property",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="invoice_number",
        label="Invoice Number",
        description="Vendor-issued invoice, statement, or bill number.",
        aliases=("invoice_no", "invoice_num", "invoice_id", "inv_no"),
        category="metadata",
        commonly_required=True,
    ),
    ExtractedInvoiceFieldDescriptor(
        key="invoice_date",
        label="Invoice Date",
        description="Date printed as the invoice, statement, or bill date.",
        # accounting_date is intentionally a compatibility alias only.
        # Product still needs to decide whether Accounting Date is a
        # separate output/import field rather than extracted invoice data.
        aliases=("bill_date", "statement_date", "accounting_date"),
        default_data_type="date",
        category="dates",
        commonly_required=True,
    ),
    ExtractedInvoiceFieldDescriptor(
        key="due_date",
        label="Due Date",
        description="Payment due date printed on the invoice.",
        aliases=("payment_due_date",),
        default_data_type="date",
        category="dates",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="service_period_start",
        label="Service Period Start",
        description="First date in the invoice service period.",
        aliases=("period_start", "service_from", "service_start"),
        default_data_type="date",
        category="dates",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="service_period_end",
        label="Service Period End",
        description="Last date in the invoice service period.",
        aliases=("period_end", "service_to", "service_end"),
        default_data_type="date",
        category="dates",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="payment_terms",
        label="Payment Terms",
        description="Payment terms printed on the invoice.",
        aliases=("terms",),
        category="metadata",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="subtotal",
        label="Subtotal",
        description="Invoice subtotal before taxes, fees, or credits.",
        aliases=("sub_total",),
        default_data_type="currency",
        category="amounts",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="tax_amount",
        label="Tax Amount",
        description="Tax amount charged on the invoice.",
        aliases=("tax", "sales_tax"),
        default_data_type="currency",
        category="amounts",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="total_amount",
        label="Total Amount",
        description="Invoice total or balance due.",
        aliases=("amount", "total", "invoice_total", "total_due", "balance_due"),
        default_data_type="currency",
        category="amounts",
        commonly_required=True,
    ),
    ExtractedInvoiceFieldDescriptor(
        key="previous_balance",
        label="Previous Balance",
        description="Previous balance carried into the current invoice.",
        aliases=("prior_balance",),
        default_data_type="currency",
        category="amounts",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="current_charges",
        label="Current Charges",
        description="Current-period charges before prior balance adjustments.",
        aliases=("current_amount", "new_charges"),
        default_data_type="currency",
        category="amounts",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="late_fee",
        label="Late Fee",
        description="Late fee or penalty amount when separately stated.",
        aliases=("late_charge", "penalty"),
        default_data_type="currency",
        category="amounts",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="currency",
        label="Currency",
        description="Currency code or symbol printed on the invoice.",
        aliases=("currency_code",),
        category="amounts",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="invoice_type",
        label="Invoice Type",
        description="Invoice type or bill-credit indicator when printed.",
        aliases=("bill_type", "document_type"),
        category="classification",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="utility_type",
        label="Utility Type",
        description="Utility or service category when printed.",
        aliases=("service_type",),
        category="classification",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="account_number",
        label="Account Number",
        description="Vendor account number for this invoice.",
        aliases=("acct_number", "acct_no", "account_no"),
        category="account",
        commonly_required=True,
    ),
    ExtractedInvoiceFieldDescriptor(
        key="meter_number",
        label="Meter Number",
        description="Meter identifier printed on a utility invoice.",
        aliases=("meter_no", "meter_id"),
        category="account",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="service_address",
        label="Service Address",
        description="Physical service address associated with the bill.",
        aliases=("service_addr", "service_location"),
        category="property",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="po_number",
        label="PO Number",
        description="Purchase order number printed on the invoice.",
        aliases=("purchase_order", "purchase_order_number", "po_no"),
        category="metadata",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="line_item_description",
        label="Line Item Description",
        description="Description text for a line item or charge.",
        aliases=("line_description", "item_description", "description"),
        category="line_items",
    ),
    ExtractedInvoiceFieldDescriptor(
        key="notes",
        label="Notes",
        description="Invoice note or memo text when extracted explicitly.",
        aliases=("memo", "comments"),
        category="metadata",
    ),
)

EXTRACTED_INVOICE_FIELDS: tuple[str, ...] = tuple(
    field.key for field in EXTRACTED_INVOICE_FIELD_REGISTRY
)
EXTRACTED_INVOICE_FIELD_LABELS: dict[str, str] = {
    field.key: field.label for field in EXTRACTED_INVOICE_FIELD_REGISTRY
}

_FIELD_BY_KEY: dict[str, ExtractedInvoiceFieldDescriptor] = {
    field.key: field for field in EXTRACTED_INVOICE_FIELD_REGISTRY
}
_ALIAS_TO_KEY: dict[str, str] = {}
for field in EXTRACTED_INVOICE_FIELD_REGISTRY:
    for alias in field.aliases:
        _ALIAS_TO_KEY.setdefault(alias.strip().lower(), field.key)


def normalize_extracted_field_key(key: str | None) -> str | None:
    """Return the canonical key for a known key or alias.

    Unknown keys are returned cleaned, not rejected. That preserves custom
    field keys and stale legacy values so callers can warn instead of crash.
    """

    if key is None:
        return None
    cleaned = str(key).strip().lower()
    if not cleaned:
        return None
    if cleaned in _FIELD_BY_KEY:
        return cleaned
    return _ALIAS_TO_KEY.get(cleaned, cleaned)


def resolve_extracted_field_descriptor(
    key: str | None,
) -> ExtractedInvoiceFieldDescriptor | None:
    """Resolve a key or alias to its descriptor, when known."""

    normalized = normalize_extracted_field_key(key)
    if normalized is None:
        return None
    return _FIELD_BY_KEY.get(normalized)


def is_known_extracted_field_key(key: str | None) -> bool:
    """True when `key` is a built-in key or registered legacy alias."""

    normalized = normalize_extracted_field_key(key)
    return bool(normalized and normalized in _FIELD_BY_KEY)


def get_extracted_field_aliases(key: str | None) -> tuple[str, ...]:
    """Return aliases for a canonical key or alias."""

    descriptor = resolve_extracted_field_descriptor(key)
    if descriptor is None:
        return ()
    return descriptor.aliases


def get_extracted_field_registry() -> tuple[ExtractedInvoiceFieldDescriptor, ...]:
    """Return the immutable registry in display order."""

    return EXTRACTED_INVOICE_FIELD_REGISTRY
