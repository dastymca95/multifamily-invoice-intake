import io
import json
from decimal import Decimal
from typing import BinaryIO
from uuid import UUID

from app.adapters.export.base import ExportAdapter
from app.domain.invoice import CanonicalInvoice


def _default(obj):
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, UUID):
        return str(obj)
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    raise TypeError(f"Not serializable: {type(obj)}")


class JsonExportAdapter(ExportAdapter):
    @property
    def format_name(self) -> str:
        return "json"

    @property
    def content_type(self) -> str:
        return "application/json"

    @property
    def file_extension(self) -> str:
        return "json"

    def export(self, invoices: list[CanonicalInvoice]) -> BinaryIO:
        payload = [inv.model_dump(mode="json") for inv in invoices]
        raw = json.dumps({"invoices": payload, "count": len(payload)}, default=_default, indent=2)
        return io.BytesIO(raw.encode("utf-8"))
