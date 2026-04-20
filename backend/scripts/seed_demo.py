"""
Seed a stable demo dataset for first-run / pilot walkthrough demos.

Goal: drop a single batch into the database that exercises every state a
reviewer will see — fully extracted, partially extracted (drives the soft
validation panel), approved, and rejected — so the app can be demonstrated
end to end without manually uploading files.

Usage (from the `backend/` directory):

    python -m scripts.seed_demo            # idempotent: skip if demo batch exists
    python -m scripts.seed_demo --reset    # wipe + re-seed (interactive prompt)
    python -m scripts.seed_demo --reset --yes   # wipe + re-seed, no prompt

Notes:
- IDs are stable so the same demo URLs work across re-seeds.
- `--reset` is refused when APP_ENV=production.
- A tiny placeholder PDF is written to the storage adapter so any code path
  that later tries to fetch the file by storage_key finds something.
- Records are inserted directly via SQLAlchemy; this bypasses the live
  extraction pipeline on purpose so the dataset is deterministic.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import sys
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.adapters.storage.base import StorageAdapter
from app.adapters.storage.local import LocalStorageAdapter
from app.adapters.storage.s3 import S3StorageAdapter
from app.config import settings
from app.database import AsyncSessionLocal
from app.models import (
    Batch,
    Document,
    ExtractionRun,
    Invoice,
    InvoiceLine,
    ReviewEvent,
)

# --- Stable IDs -------------------------------------------------------------

# Matches the DEV admin in `app/api/v1/auth.py`.
DEMO_USER_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")

# Fixed UUID so the demo batch URL is the same after every reseed:
#   /batches/11111111-1111-1111-1111-111111111111
DEMO_BATCH_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")

# Minimal valid PDF placeholder. We just need *something* on disk at the
# document's storage_key; nothing in the demo flow re-extracts these files.
PLACEHOLDER_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n"
    b"xref\n0 4\n0000000000 65535 f \n"
    b"trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF\n"
)


# --- Helpers ----------------------------------------------------------------


def _today() -> date:
    return datetime.now(UTC).date()


def _storage_key(batch_id: uuid.UUID, checksum: str, filename: str) -> str:
    """Mirrors the convention used by `IngestWorkflow`."""
    return f"documents/{batch_id}/{checksum[:8]}_{filename}"


def _get_storage_adapter() -> StorageAdapter:
    """Same selection rule as `app/api/v1/documents.py`."""
    if settings.STORAGE_BACKEND == "s3":
        return S3StorageAdapter()
    return LocalStorageAdapter()


# --- Fixtures ---------------------------------------------------------------
#
# Each fixture returns a self-contained spec consumed by `_seed`. Keeping
# them as plain dicts (instead of model instances) lets us flush and link
# IDs cleanly inside the seed loop.


def _make_pending_full() -> dict:
    """Acme Power & Gas — fully extracted, awaiting review, no problems."""
    return dict(
        original_filename="acme_power_gas_april_2026.pdf",
        mime_type="application/pdf",
        confidence=0.92,
        review_status="pending",
        invoice=dict(
            vendor_name="Acme Power & Gas",
            vendor_address="100 Industry Way, Springfield, IL 62701",
            bill_to_name="Riverside Holdings LLC",
            property_name="Riverside Apartments",
            property_code="RVA-001",
            invoice_number="ACM-2026-04-7821",
            invoice_date=_today() - timedelta(days=10),
            due_date=_today() + timedelta(days=20),
            service_period_start=_today() - timedelta(days=40),
            service_period_end=_today() - timedelta(days=11),
            subtotal=Decimal("1284.00"),
            tax_amount=Decimal("96.30"),
            total_amount=Decimal("1380.30"),
            invoice_type="utility",
            utility_type="electricity",
            account_number="AC-552187",
            meter_number="M-77821",
        ),
        lines=[
            dict(
                line_number=1,
                description="Electricity usage — 8,432 kWh @ $0.118",
                quantity=Decimal("8432"),
                unit="kWh",
                unit_price=Decimal("0.118"),
                amount=Decimal("994.98"),
                gl_code="6100-ELEC",
            ),
            dict(
                line_number=2,
                description="Demand charge — peak usage adjustment",
                quantity=Decimal("1"),
                unit="ea",
                unit_price=Decimal("214.50"),
                amount=Decimal("214.50"),
                gl_code="6100-ELEC",
            ),
            dict(
                line_number=3,
                description="Service connection fee",
                quantity=Decimal("1"),
                unit="ea",
                unit_price=Decimal("74.52"),
                amount=Decimal("74.52"),
                gl_code="6100-ELEC",
            ),
        ],
    )


def _make_pending_partial() -> dict:
    """Hilltop Water — extraction succeeded but several fields are blank.

    Designed to drive the soft-validation panel:
      - missing invoice_number
      - missing invoice_date
      - no line items
    """
    return dict(
        original_filename="hilltop_water_scan.png",
        mime_type="image/png",
        confidence=0.58,
        review_status="pending",
        invoice=dict(
            vendor_name="Hilltop Water Authority",
            property_name="Riverside Apartments",
            property_code="RVA-001",
            invoice_number=None,
            invoice_date=None,
            subtotal=Decimal("412.00"),
            tax_amount=Decimal("0.00"),
            total_amount=Decimal("412.00"),
            invoice_type="utility",
            utility_type="water",
            account_number="W-99021",
        ),
        lines=[],
    )


def _make_approved() -> dict:
    """CitiTrash — extracted, reviewed, approved (happy-path completed)."""
    return dict(
        original_filename="cititrash_april_2026.pdf",
        mime_type="application/pdf",
        confidence=0.97,
        review_status="approved",
        invoice=dict(
            vendor_name="CitiTrash Removal",
            vendor_address="2200 Hauler Ave, Springfield, IL 62702",
            bill_to_name="Riverside Holdings LLC",
            property_name="Riverside Apartments",
            property_code="RVA-001",
            invoice_number="CT-04-2026-3310",
            invoice_date=_today() - timedelta(days=14),
            due_date=_today() + timedelta(days=16),
            service_period_start=_today() - timedelta(days=44),
            service_period_end=_today() - timedelta(days=15),
            subtotal=Decimal("420.00"),
            tax_amount=Decimal("31.50"),
            total_amount=Decimal("451.50"),
            invoice_type="utility",
            utility_type="trash",
            account_number="TR-44781",
        ),
        lines=[
            dict(
                line_number=1,
                description="Weekly trash pickup — week of 03/16",
                quantity=Decimal("1"),
                unit="wk",
                unit_price=Decimal("105.00"),
                amount=Decimal("105.00"),
                gl_code="6300-TRASH",
            ),
            dict(
                line_number=2,
                description="Weekly trash pickup — week of 03/23",
                quantity=Decimal("1"),
                unit="wk",
                unit_price=Decimal("105.00"),
                amount=Decimal("105.00"),
                gl_code="6300-TRASH",
            ),
            dict(
                line_number=3,
                description="Weekly trash pickup — week of 03/30",
                quantity=Decimal("1"),
                unit="wk",
                unit_price=Decimal("105.00"),
                amount=Decimal("105.00"),
                gl_code="6300-TRASH",
            ),
            dict(
                line_number=4,
                description="Weekly trash pickup — week of 04/06",
                quantity=Decimal("1"),
                unit="wk",
                unit_price=Decimal("105.00"),
                amount=Decimal("105.00"),
                gl_code="6300-TRASH",
            ),
        ],
        review=dict(
            event_type="approve",
            note="All fields verified against PDF; service period matches contract.",
        ),
    )


def _make_rejected() -> dict:
    """ABC Telecom — extracted, reviewed, rejected (vendor billed wrong property)."""
    return dict(
        original_filename="abc_telecom_april_2026.pdf",
        mime_type="application/pdf",
        confidence=0.88,
        review_status="rejected",
        invoice=dict(
            vendor_name="ABC Telecom",
            vendor_address="500 Network Blvd, Chicago, IL 60601",
            bill_to_name="Riverside Holdings LLC",
            property_name="Riverside Apartments",
            property_code="RVA-001",
            invoice_number="ABC-2026-04-118",
            invoice_date=_today() - timedelta(days=8),
            due_date=_today() + timedelta(days=22),
            subtotal=Decimal("189.00"),
            tax_amount=Decimal("14.18"),
            total_amount=Decimal("203.18"),
            invoice_type="utility",
            utility_type="telecom",
            account_number="TEL-200901",
        ),
        lines=[
            dict(
                line_number=1,
                description="Business internet — 200 Mbps",
                quantity=Decimal("1"),
                unit="mo",
                unit_price=Decimal("129.00"),
                amount=Decimal("129.00"),
                gl_code="6900-COMM",
            ),
            dict(
                line_number=2,
                description="Static IP add-on",
                quantity=Decimal("1"),
                unit="mo",
                unit_price=Decimal("60.00"),
                amount=Decimal("60.00"),
                gl_code="6900-COMM",
            ),
        ],
        review=dict(
            event_type="reject",
            note=(
                "Wrong property — bill belongs to Maple Court, not Riverside. "
                "Vendor invoiced the wrong account."
            ),
        ),
    )


FIXTURES = (
    _make_pending_full,
    _make_pending_partial,
    _make_approved,
    _make_rejected,
)


# --- Seed / reset ----------------------------------------------------------


async def _existing_demo_batch(session) -> Batch | None:
    res = await session.execute(select(Batch).where(Batch.id == DEMO_BATCH_ID))
    return res.scalar_one_or_none()


async def _delete_demo_batch(session, storage: StorageAdapter) -> None:
    """Delete the demo batch + its storage objects.

    DB cascade handles documents → extraction_runs / invoices → invoice_lines /
    review_events. We just need to clean up the files first since storage
    isn't transactional.
    """
    res = await session.execute(
        select(Document).where(Document.batch_id == DEMO_BATCH_ID)
    )
    docs = res.scalars().all()
    for d in docs:
        try:
            storage.delete(d.storage_key)
        except Exception as e:  # noqa: BLE001 - best-effort cleanup
            print(f"  warn: failed to delete storage key {d.storage_key}: {e}", file=sys.stderr)

    batch = await _existing_demo_batch(session)
    if batch is not None:
        await session.delete(batch)
        await session.commit()


async def _seed(session, storage: StorageAdapter) -> None:
    batch = Batch(
        id=DEMO_BATCH_ID,
        name="April 2026 Utilities — Riverside Portfolio (DEMO)",
        description=(
            "Sample dataset created by scripts/seed_demo.py. Exercises every "
            "document state: full / partial / approved / rejected."
        ),
        created_by=DEMO_USER_ID,
        total_documents=0,
        processed_documents=0,
        failed_documents=0,
    )
    session.add(batch)
    await session.flush()

    for factory in FIXTURES:
        spec = factory()
        filename = spec["original_filename"]
        mime_type = spec["mime_type"]
        raw = PLACEHOLDER_PDF

        # Synthesise a deterministic checksum that's distinct per filename.
        # This avoids the ingest-style dedupe that would happen if all four
        # documents shared the same `PLACEHOLDER_PDF` checksum.
        checksum = hashlib.sha256(
            f"seed-demo::{DEMO_BATCH_ID}::{filename}".encode()
        ).hexdigest()
        storage_key = _storage_key(DEMO_BATCH_ID, checksum, filename)
        storage.put(storage_key, io.BytesIO(raw), mime_type)

        review_status = spec["review_status"]
        doc = Document(
            batch_id=DEMO_BATCH_ID,
            original_filename=filename,
            storage_key=storage_key,
            mime_type=mime_type,
            file_size_bytes=len(raw),
            checksum_sha256=checksum,
            route_used=(
                "native_pdf" if mime_type == "application/pdf" else "scanned_or_image"
            ),
            extraction_status="extracted",
            review_status=review_status,
        )
        session.add(doc)
        await session.flush()

        run = ExtractionRun(
            document_id=doc.id,
            adapter_name="seed_demo",
            status="completed",
            confidence_score=spec["confidence"],
            review_required=True,
            raw_output_json={
                "source": "seed_demo",
                "vendor": spec["invoice"].get("vendor_name"),
            },
            normalized_output_json={
                "vendor_name": spec["invoice"].get("vendor_name"),
                "invoice_number": spec["invoice"].get("invoice_number"),
                "total_amount": str(spec["invoice"].get("total_amount") or ""),
            },
            duration_ms=1234,
        )
        session.add(run)
        await session.flush()

        invoice = Invoice(
            document_id=doc.id,
            extraction_run_id=run.id,
            extraction_confidence=spec["confidence"],
            **spec["invoice"],
        )
        session.add(invoice)
        await session.flush()

        for line in spec["lines"]:
            session.add(InvoiceLine(invoice_id=invoice.id, **line))

        review = spec.get("review")
        if review is not None:
            session.add(
                ReviewEvent(
                    invoice_id=invoice.id,
                    reviewer_id=DEMO_USER_ID,
                    event_type=review["event_type"],
                    note=review.get("note"),
                    value_after={"review_status": review_status},
                )
            )

        await session.flush()

    # All four documents extracted successfully; nothing failed.
    batch.total_documents = len(FIXTURES)
    batch.processed_documents = len(FIXTURES)
    batch.failed_documents = 0

    await session.commit()


# --- Entry point ------------------------------------------------------------


_NEXT_STEPS = """\
Seeded demo batch {batch_id} with {n} documents.

Next steps:
  1. Start the backend (uvicorn app.main:app --reload) and frontend
     (cd ../frontend && npm run dev) if they aren't already running.
  2. Log in as admin@example.com / devpassword.
  3. Open the dashboard — the DEMO batch is at the top.
       • Acme Power & Gas      → pending review, fully extracted.
       • Hilltop Water         → pending review, exercises the soft
                                 validation panel (missing #/date/lines).
       • CitiTrash Removal     → already approved.
       • ABC Telecom           → already rejected, with reviewer note.
  4. From the batch detail page use 'Export Batch' to test CSV/XLSX/JSON.

Re-run with --reset to wipe and start fresh (will prompt unless --yes).
"""


async def main(reset: bool, assume_yes: bool) -> int:
    if reset and settings.is_production:
        print(
            "Refusing to --reset: APP_ENV=production. Demo seeding is for "
            "development environments only.",
            file=sys.stderr,
        )
        return 2

    storage = _get_storage_adapter()

    async with AsyncSessionLocal() as session:
        existing = await _existing_demo_batch(session)

        if existing is not None and not reset:
            print(
                f"Demo batch {DEMO_BATCH_ID} already exists "
                f"({existing.total_documents} documents). "
                "Re-run with --reset to wipe and re-seed."
            )
            return 0

        if existing is not None and reset:
            if not assume_yes:
                ans = input(
                    f"This will DELETE the demo batch {DEMO_BATCH_ID} and all of "
                    f"its documents/invoices/review history. Continue? [y/N] "
                ).strip().lower()
                if ans not in ("y", "yes"):
                    print("Aborted.")
                    return 1
            await _delete_demo_batch(session, storage)

        await _seed(session, storage)

    print(_NEXT_STEPS.format(batch_id=DEMO_BATCH_ID, n=len(FIXTURES)))
    return 0


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="scripts.seed_demo",
        description=(
            "Seed a stable demo dataset for first-run / pilot walkthrough demos."
        ),
    )
    p.add_argument(
        "--reset",
        action="store_true",
        help="Wipe the existing demo batch (and all its data) before re-seeding.",
    )
    p.add_argument(
        "--yes",
        action="store_true",
        help="Skip the interactive confirmation prompt for --reset.",
    )
    return p.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    raise SystemExit(asyncio.run(main(reset=args.reset, assume_yes=args.yes)))
