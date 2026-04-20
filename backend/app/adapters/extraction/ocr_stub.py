"""
OCR extraction adapter — STUB.

This adapter slot is reserved for scanned PDFs and images. The interface is
complete; the implementation is intentionally unfinished.

To wire a real OCR provider (Textract, Google Document AI, Azure Form Recognizer,
etc.), create a new module in this package, implement ExtractionAdapter, and
update the adapter factory in app/adapters/extraction/__init__.py.
"""

from typing import BinaryIO

import structlog

from app.adapters.extraction.base import ExtractionAdapter, ExtractionError, ExtractionResult

log = structlog.get_logger()


class OcrStubAdapter(ExtractionAdapter):
    """
    Placeholder OCR adapter.

    Returns a low-confidence empty result so that documents routed here
    are flagged for manual entry rather than silently dropped.
    """

    @property
    def name(self) -> str:
        return "ocr_stub"

    def can_handle(self, mime_type: str, route: str) -> bool:
        return route == "scanned_or_image"

    def extract(
        self,
        file: BinaryIO,
        filename: str,
        vendor_hints: dict | None = None,
    ) -> ExtractionResult:
        log.info("ocr_stub_invoked", filename=filename, note="OCR not yet implemented")
        # STUB: return an empty-but-valid result so the review UI opens with blank fields
        return ExtractionResult(
            raw_text="",
            structured={
                "vendor_name": "MANUAL ENTRY REQUIRED",
                "invoice_number": "",
                "invoice_date": None,
                "total_amount": None,
                "currency": "USD",
                "invoice_type": "unknown",
                "line_items": [],
            },
            confidence=0.0,
            adapter_name=self.name,
            metadata={"stub": True, "filename": filename},
        )
