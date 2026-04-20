"""
Document routing — pure function. Decides which extraction path applies.

Output values are persisted on Document.route_used and consumed by the
extraction workflow to pick an adapter.
"""

from __future__ import annotations

from typing import Literal

RouteUsed = Literal["native_pdf", "scanned_or_image", "unsupported"]

_PDF_MIME = "application/pdf"
_IMAGE_MIMES = frozenset({"image/jpeg", "image/jpg", "image/png", "image/tiff", "image/webp"})


def route_document(mime_type: str, raw_bytes: bytes) -> RouteUsed:
    """
    Classify an uploaded document for extraction.

    - native_pdf: PDF with an embedded text layer (BT/ET text operators present).
      Fast path — pdfplumber can extract directly without OCR.
    - scanned_or_image: PDFs without text layer, or any raster image.
      Goes through the OCR adapter.
    - unsupported: file type we cannot process.
    """
    mime = (mime_type or "").lower().strip()

    if mime == _PDF_MIME:
        # Heuristic: text-bearing PDFs include text-show operators (BT...ET blocks).
        # We scan a generous prefix because these can appear past the header.
        # If absent, the PDF is almost certainly a scanned image wrapper.
        snippet = raw_bytes[: 64 * 1024]
        if b"BT" in snippet and b"ET" in snippet:
            return "native_pdf"
        return "scanned_or_image"

    if mime in _IMAGE_MIMES:
        return "scanned_or_image"

    return "unsupported"
