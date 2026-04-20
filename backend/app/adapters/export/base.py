from abc import ABC, abstractmethod
from typing import BinaryIO

from app.domain.invoice import CanonicalInvoice


class ExportAdapter(ABC):
    """
    Export adapter contract.

    Adapters receive a list of approved invoices and return a binary stream
    suitable for direct download or storage. The workflow layer handles
    persisting the result to storage and updating the ExportJob record.
    """

    @property
    @abstractmethod
    def format_name(self) -> str:
        """One of: csv, xlsx, json"""
        ...

    @property
    @abstractmethod
    def content_type(self) -> str:
        ...

    @property
    @abstractmethod
    def file_extension(self) -> str:
        ...

    @abstractmethod
    def export(self, invoices: list[CanonicalInvoice]) -> BinaryIO:
        """
        Serialize invoices to the target format.

        Returns a file-like object positioned at the start.
        """
        ...
