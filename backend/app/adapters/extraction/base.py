"""
Extraction adapter contract.

All extraction backends (native PDF, OCR providers, LLM-based, etc.) must
implement ExtractionAdapter. The workflow layer is adapter-agnostic; swapping
backends is a config change, not a code change.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import BinaryIO


@dataclass
class ExtractionResult:
    raw_text: str
    structured: dict  # matches CanonicalInvoice shape (pre-Pydantic validation)
    confidence: float  # 0.0–1.0
    adapter_name: str
    metadata: dict  # adapter-specific provenance (pages, OCR engine version, etc.)


class ExtractionAdapter(ABC):
    """
    Stateless adapter — each call to extract() is independent.

    Adapters may load vendor hints at instantiation time if needed, but must
    not mutate shared state during extraction.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique identifier stored in extraction_runs.adapter_name."""
        ...

    @abstractmethod
    def can_handle(self, mime_type: str, document_kind: str) -> bool:
        """Return True if this adapter can process the given file type."""
        ...

    @abstractmethod
    def extract(
        self,
        file: BinaryIO,
        filename: str,
        vendor_hints: dict | None = None,
    ) -> ExtractionResult:
        """
        Extract structured data from file.

        vendor_hints: optional pattern data from VendorPattern for this vendor.
        Raises ExtractionError on unrecoverable failure.
        """
        ...


class ExtractionError(Exception):
    """Raised by adapters when extraction fails in a way that requires human review."""
