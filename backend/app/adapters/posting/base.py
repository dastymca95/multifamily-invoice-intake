"""
External posting adapter — FUTURE INTERFACE.

This stub reserves the interface for writing approved invoices to an external
system (ResMan, Yardi, MRI, AppFolio, etc.). The interface is intentionally
left minimal — the exact contract will be driven by the target system's API.

DO NOT implement business logic here until the first integration target is chosen.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass

from app.domain.invoice import CanonicalInvoice


@dataclass
class PostingResult:
    success: bool
    external_id: str | None
    message: str
    raw_response: dict | None = None


class PostingAdapter(ABC):
    """
    Posts an approved invoice to an external accounting/property management system.

    Each integration (ResMan, Yardi, etc.) gets its own concrete adapter in a
    sibling module. The workflow layer calls adapters by name via a registry,
    keeping integration details isolated.
    """

    @property
    @abstractmethod
    def system_name(self) -> str:
        """Unique identifier for the target system (e.g. 'resman', 'yardi')."""
        ...

    @abstractmethod
    def post(self, invoice: CanonicalInvoice) -> PostingResult:
        """
        Post a single approved invoice to the external system.

        Should be idempotent: posting the same invoice_number for the same
        vendor twice must not create a duplicate in the target system.
        """
        ...

    @abstractmethod
    def health_check(self) -> bool:
        """Return True if the external system is reachable and credentials are valid."""
        ...
