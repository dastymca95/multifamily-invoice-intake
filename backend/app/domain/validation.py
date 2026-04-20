"""
Invoice validation — pure function returning warnings (never failures).

Validation in this product is advisory. The reviewer is the final authority;
warnings exist to guide attention, not block work.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

from app.domain.invoice import CanonicalInvoice

Severity = Literal["warning", "info"]

_SUBTOTAL_TOLERANCE = Decimal("0.02")


@dataclass(frozen=True)
class ValidationWarning:
    field: str | None
    code: str
    message: str
    severity: Severity = "warning"

    def to_dict(self) -> dict:
        return {
            "field": self.field,
            "code": self.code,
            "message": self.message,
            "severity": self.severity,
        }


def _is_blank(value: str | None) -> bool:
    return value is None or not str(value).strip() or str(value).strip().upper() == "UNKNOWN"


def validate_invoice(invoice: CanonicalInvoice) -> list[ValidationWarning]:
    """Return validation warnings for an invoice. Empty list = clean."""
    warnings: list[ValidationWarning] = []

    if _is_blank(invoice.vendor_name):
        warnings.append(ValidationWarning(
            field="vendor_name", code="missing_vendor_name",
            message="Vendor name is missing or unknown.",
        ))

    if _is_blank(invoice.invoice_number):
        warnings.append(ValidationWarning(
            field="invoice_number", code="missing_invoice_number",
            message="Invoice number is missing.",
        ))

    if invoice.total_amount is None or invoice.total_amount == Decimal("0"):
        warnings.append(ValidationWarning(
            field="total_amount", code="missing_total_amount",
            message="Total amount is missing or zero.",
        ))

    if invoice.line_items:
        line_sum = sum((li.amount for li in invoice.line_items), Decimal("0"))

        # Compare against subtotal if present, otherwise against total.
        reference = invoice.subtotal if invoice.subtotal is not None else invoice.total_amount
        if reference is not None and abs(line_sum - reference) > _SUBTOTAL_TOLERANCE:
            warnings.append(ValidationWarning(
                field=None, code="line_total_mismatch",
                message=(
                    f"Line items sum to {line_sum} but invoice "
                    f"{'subtotal' if invoice.subtotal is not None else 'total'} is {reference}."
                ),
            ))

    return warnings
