"""
Pydantic shapes for the Reference Data API.

The list endpoint always returns ALL four kinds, even those not yet
uploaded — the frontend renders one card per kind, so it needs a stable
slot for "properties with no file yet" alongside "properties uploaded".
That's why `current` is nullable rather than the endpoint omitting empty
kinds.
"""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.domain.reference_parse import REFERENCE_KINDS

ReferenceKindLiteral = Literal["properties", "units", "vendors", "import_template"]


class ReferenceFileOut(BaseModel):
    id: uuid.UUID
    kind: ReferenceKindLiteral
    original_filename: str
    mime_type: str
    file_size_bytes: int
    checksum_sha256: str
    parse_status: str
    parse_error: str | None
    parsed_columns: list[str] | None
    parsed_row_count: int | None
    sample_rows: list[dict[str, str]] | None
    uploaded_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ReferenceSlot(BaseModel):
    """One card on the Reference Data page."""

    kind: ReferenceKindLiteral
    label: str
    description: str
    current: ReferenceFileOut | None = None


class ReferenceListResponse(BaseModel):
    slots: list[ReferenceSlot] = Field(default_factory=list)


# Display copy for each kind. Lives in the schema layer (not the model)
# because it's API-facing and can change without a migration. The frontend
# uses the labels verbatim — keep them in sync if you adjust them here.
REFERENCE_LABELS: dict[str, tuple[str, str]] = {
    "properties": (
        "Property report",
        "ResMan property report — the canonical list of properties the "
        "exported invoices will be matched against.",
    ),
    "units": (
        "Unit report",
        "ResMan unit report — used for property/unit lookups when a "
        "vendor invoice references a specific apartment.",
    ),
    "vendors": (
        "Vendor report",
        "ResMan vendor report — vendors that already exist in ResMan, "
        "used to map extracted vendor names to existing ResMan vendor IDs.",
    ),
    "import_template": (
        "Invoice import template",
        "The default ResMan invoice import template. Its column headers "
        "define the required shape of the final export file.",
    ),
}

# Sanity check at import time — keeps the schema labels and the parser's
# canonical kind list from drifting apart unnoticed.
assert set(REFERENCE_LABELS.keys()) == set(REFERENCE_KINDS)
