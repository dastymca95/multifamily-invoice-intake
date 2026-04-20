import csv
import io
from typing import BinaryIO

from app.adapters.export.base import ExportAdapter
from app.domain.invoice import CanonicalInvoice

_HEADER_FIELDS = [
    "invoice_id", "document_id", "vendor_name", "property_name", "property_code",
    "invoice_number", "invoice_date", "due_date", "service_period_start",
    "service_period_end", "invoice_type", "utility_type", "account_number",
    "subtotal", "tax_amount", "total_amount", "currency", "payment_terms",
]

_LINE_FIELDS = [
    "invoice_id", "line_number", "description", "quantity", "unit", "unit_price", "amount", "gl_code",
]


class CsvExportAdapter(ExportAdapter):
    """
    Exports approved invoices as two-sheet CSV (headers + lines).

    Because CSV is single-sheet, we emit a flat joined row: one row per line item,
    with invoice header fields repeated on each row. This mirrors how AP teams
    typically import data into accounting software.
    """

    @property
    def format_name(self) -> str:
        return "csv"

    @property
    def content_type(self) -> str:
        return "text/csv"

    @property
    def file_extension(self) -> str:
        return "csv"

    def export(self, invoices: list[CanonicalInvoice]) -> BinaryIO:
        buf = io.StringIO()
        writer = csv.writer(buf)

        flat_header = [
            "invoice_id", "vendor_name", "property_name", "property_code",
            "invoice_number", "invoice_date", "due_date", "invoice_type",
            "utility_type", "account_number", "total_amount", "currency",
            "line_number", "description", "quantity", "unit", "unit_price",
            "line_amount", "gl_code",
        ]
        writer.writerow(flat_header)

        for inv in invoices:
            base = [
                str(inv.id), inv.vendor_name, inv.property_name or "", inv.property_code or "",
                inv.invoice_number, inv.invoice_date, inv.due_date or "", inv.invoice_type,
                inv.utility_type or "", inv.account_number or "", inv.total_amount, inv.currency,
            ]
            if inv.line_items:
                for li in inv.line_items:
                    writer.writerow(base + [
                        li.line_number, li.description, li.quantity or "", li.unit or "",
                        li.unit_price or "", li.amount, li.gl_code or "",
                    ])
            else:
                writer.writerow(base + ["", "", "", "", "", "", ""])

        buf.seek(0)
        return io.BytesIO(buf.getvalue().encode("utf-8-sig"))
