"""
Native PDF extraction adapter using pdfplumber.

Handles text-based (non-scanned) PDFs. Uses heuristic pattern matching to
locate invoice fields. Vendor hints can narrow the search regions.
"""

from __future__ import annotations

import hashlib
import re
from typing import BinaryIO

import pdfplumber
import structlog

from app.adapters.extraction.base import ExtractionAdapter, ExtractionError, ExtractionResult

log = structlog.get_logger()

# Regexes for common invoice field patterns
_DATE_RE = re.compile(r"\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b")
_AMOUNT_RE = re.compile(r"\$?\s*([\d,]+\.\d{2})")
_INVOICE_NUM_RE = re.compile(r"(?i)invoice\s*(?:#|no\.?|number)?\s*:?\s*([A-Z0-9\-]+)")
_DUE_DATE_RE = re.compile(r"(?i)(?:due\s+date|payment\s+due)\s*:?\s*(\S+)")


class NativePdfAdapter(ExtractionAdapter):
    """Extracts invoice fields from digital (text-layer) PDFs."""

    @property
    def name(self) -> str:
        return "native_pdf"

    def can_handle(self, mime_type: str, route: str) -> bool:
        return mime_type == "application/pdf" and route == "native_pdf"

    def extract(
        self,
        file: BinaryIO,
        filename: str,
        vendor_hints: dict | None = None,
    ) -> ExtractionResult:
        try:
            return self._run_extraction(file, filename, vendor_hints or {})
        except Exception as exc:
            log.warning("native_pdf_extraction_failed", filename=filename, error=str(exc))
            raise ExtractionError(f"Native PDF extraction failed: {exc}") from exc

    def _run_extraction(self, file: BinaryIO, filename: str, hints: dict) -> ExtractionResult:
        raw_pages: list[str] = []
        with pdfplumber.open(file) as pdf:
            for page in pdf.pages:
                text = page.extract_text() or ""
                raw_pages.append(text)

        full_text = "\n".join(raw_pages)
        raw_hash = hashlib.sha256(full_text.encode()).hexdigest()

        structured = self._parse_fields(full_text, hints)
        confidence = self._score_confidence(structured)

        return ExtractionResult(
            raw_text=full_text,
            structured={**structured, "raw_text_hash": raw_hash},
            confidence=confidence,
            adapter_name=self.name,
            metadata={"page_count": len(raw_pages)},
        )

    def _parse_fields(self, text: str, hints: dict) -> dict:
        """Heuristic field extraction. Results are best-effort; review UI fills gaps."""
        lines = text.split("\n")

        invoice_number = self._find_invoice_number(text, hints)
        dates = _DATE_RE.findall(text)
        amounts = _AMOUNT_RE.findall(text)

        invoice_date = dates[0] if dates else None
        due_date_match = _DUE_DATE_RE.search(text)
        due_date = due_date_match.group(1) if due_date_match else (dates[1] if len(dates) > 1 else None)

        total_amount = self._find_total_amount(text, amounts)
        vendor_name = self._find_vendor_name(lines, hints)

        # Emit None (not "UNKNOWN") for fields we couldn't read — the review
        # UI and validation warnings handle the empty state cleanly.
        return {
            "vendor_name": vendor_name,
            "invoice_number": invoice_number,
            "invoice_date": invoice_date,
            "due_date": due_date,
            "total_amount": total_amount,
            "currency": "USD",
            "invoice_type": "unknown",
            "line_items": self._extract_line_items(text),
        }

    def _find_invoice_number(self, text: str, hints: dict) -> str | None:
        if "invoice_number_pattern" in hints:
            m = re.search(hints["invoice_number_pattern"], text)
            if m:
                return m.group(1)
        m = _INVOICE_NUM_RE.search(text)
        return m.group(1) if m else None

    def _find_vendor_name(self, lines: list[str], hints: dict) -> str | None:
        if "vendor_name" in hints:
            return hints["vendor_name"]
        # Heuristic: first non-empty line is often the vendor name on a standard invoice
        for line in lines[:5]:
            stripped = line.strip()
            if stripped and len(stripped) > 2:
                return stripped
        return None

    def _find_total_amount(self, text: str, amounts: list[str]) -> float | None:
        total_re = re.compile(r"(?i)(?:total|amount\s+due|balance\s+due)\s*:?\s*\$?\s*([\d,]+\.\d{2})")
        m = total_re.search(text)
        if m:
            return float(m.group(1).replace(",", ""))
        if amounts:
            return float(max(amounts, key=lambda x: float(x.replace(",", ""))).replace(",", ""))
        return None

    def _extract_line_items(self, text: str) -> list[dict]:
        # Placeholder: a production implementation would parse tabular regions
        # from pdfplumber's table extraction. Stubbed here intentionally.
        return []

    def _score_confidence(self, fields: dict) -> float:
        score = 0.0
        if fields.get("vendor_name"):
            score += 0.25
        if fields.get("invoice_number"):
            score += 0.25
        if fields.get("invoice_date"):
            score += 0.25
        if fields.get("total_amount"):
            score += 0.25
        return round(score, 2)
