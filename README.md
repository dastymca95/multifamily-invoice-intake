# BillsIQ — Property Accounting Document Processing

Intake → Extraction → Review → Export workflow for multifamily/property accounting teams.

Ingests utility bills and vendor invoices (PDF, scanned, image), extracts structured data,
surfaces it to reviewers for correction, and exports clean CSV/XLSX/JSON.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Next.js Frontend (TypeScript + Tailwind)                    │
│  /dashboard  /upload  /review  /exports  /vendor-patterns    │
└────────────────────────────┬────────────────────────────────┘
                             │ REST / JSON
┌────────────────────────────▼────────────────────────────────┐
│  FastAPI Backend                                             │
│  ├── api/v1/  (auth, batches, documents, review, exports)    │
│  ├── workflows/  (ingest, extraction, review, export)        │
│  ├── adapters/  (extraction, storage, export, posting)       │
│  ├── repositories/  (data access layer)                      │
│  └── models/  (SQLAlchemy ORM)                               │
└──────────┬──────────────────────────┬───────────────────────┘
           │ SQLAlchemy async          │ Celery tasks
┌──────────▼──────────┐    ┌──────────▼───────────────────────┐
│  PostgreSQL          │    │  Celery Workers                   │
│  (8 tables)          │    │  ├── tasks_extraction             │
└─────────────────────┘    │  ├── tasks_export                 │
                           │  └── tasks_vendor                 │
┌─────────────────────┐    └──────────────────────────────────┘
│  Redis (broker +    │
│  result backend)    │
└─────────────────────┘
┌─────────────────────┐
│  Storage            │
│  Local (dev) / S3   │
└─────────────────────┘
```

### Key design decisions

| Decision | Rationale |
|---|---|
| Modular monolith | Avoids premature microservice complexity while keeping clear domain boundaries |
| Human review as first-class | Document state machine: `pending → extracted → reviewed → approved/rejected` |
| Adapter pattern for extraction/storage/export | Swap backends via config, not code |
| Export-first | No ERP write-back in MVP; output is clean files for human handoff |
| Vendor pattern memory | Corrections from reviewers improve future extraction confidence over time |
| NUMERIC for money | PostgreSQL `NUMERIC(14,4)` everywhere — no floating-point for financials |

---

## Database Schema

| Table | Purpose |
|---|---|
| `batches` | Groups of uploaded documents |
| `documents` | Individual files with checksum, storage key, routing status |
| `extraction_runs` | Per-document extraction attempts with adapter name, confidence, raw output |
| `invoices` | Structured header fields after extraction |
| `invoice_lines` | Line items per invoice |
| `review_events` | Immutable audit log of every reviewer action |
| `vendor_patterns` | Learned extraction hints per vendor |
| `export_jobs` | Export requests with status and output storage key |

---

## Local Development Setup

### Prerequisites

- Docker Desktop
- Node.js 20+
- Python 3.11+

### 1. Clone and configure

```bash
cp .env.example .env
# Edit .env if needed — defaults work for Docker dev
```

### 2. Start infrastructure

```bash
docker compose up postgres redis minio -d
```

### 3. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Run migrations
alembic upgrade head

# Start API
uvicorn app.main:app --reload

# Start worker (separate terminal)
celery -A app.workers.celery_app worker --loglevel=info
```

### 4. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Default dev credentials: `admin@bills.local` / `devpassword`.

### 5. Full stack via Docker Compose

```bash
docker compose up
```

API docs: [http://localhost:8000/docs](http://localhost:8000/docs)  
MinIO console: [http://localhost:9001](http://localhost:9001) (minioadmin / minioadmin)

---

## Project Structure

```
B2B_SaaS_web_app/
├── backend/
│   ├── app/
│   │   ├── main.py                  # FastAPI app factory
│   │   ├── config.py                # Pydantic settings
│   │   ├── database.py              # Async SQLAlchemy engine
│   │   ├── dependencies.py          # FastAPI DI (auth, DB)
│   │   ├── domain/
│   │   │   └── invoice.py           # Canonical invoice + line item (Pydantic)
│   │   ├── models/                  # SQLAlchemy ORM models
│   │   ├── repositories/            # Data access layer (one per aggregate)
│   │   ├── adapters/
│   │   │   ├── extraction/          # PDF + OCR adapters (pluggable)
│   │   │   ├── storage/             # Local + S3 adapters
│   │   │   ├── export/              # CSV, XLSX, JSON exporters
│   │   │   └── posting/             # Future ERP posting (stub)
│   │   ├── workflows/               # Use-case orchestration
│   │   ├── workers/                 # Celery tasks
│   │   ├── api/v1/                  # FastAPI route handlers
│   │   └── schemas/                 # Pydantic request/response schemas
│   ├── alembic/                     # DB migrations
│   └── tests/
├── frontend/
│   └── src/
│       ├── app/                     # Next.js App Router
│       ├── features/                # Feature-scoped components + hooks
│       │   ├── dashboard/
│       │   ├── upload/
│       │   ├── review/
│       │   ├── exports/
│       │   └── vendor-patterns/
│       ├── lib/api/                 # API client wrappers
│       ├── types/                   # TypeScript types
│       └── components/              # Shared UI + layout components
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Canonical Invoice Schema

The `CanonicalInvoice` is the single contract between extraction, review, and export.

- Python: [`backend/app/domain/invoice.py`](backend/app/domain/invoice.py)
- JSON Schema: [`backend/app/schemas/canonical_invoice.schema.json`](backend/app/schemas/canonical_invoice.schema.json)

Key fields: vendor identity, bill-to/property, invoice dates, amounts (NUMERIC), classification (utility type, account number), and line items with GL code slots.

---

## Extending the System

### Add an OCR extraction backend

1. Create `backend/app/adapters/extraction/my_ocr.py` implementing `ExtractionAdapter`
2. Register it in `tasks_extraction.py` adapter list
3. Set `EXTRACTION_BACKEND=my_ocr` in `.env`

### Add an export format

1. Create `backend/app/adapters/export/my_format.py` implementing `ExportAdapter`
2. Add to the `adapters` dict in `tasks_export.py`

### Add an ERP posting integration

1. Implement `PostingAdapter` from `backend/app/adapters/posting/base.py`
2. Wire it into a new workflow + Celery task post-approval

---

## Running Tests

```bash
cd backend
pytest tests/ -v
```

Tests require a running PostgreSQL instance. The conftest creates and drops a `bills_test` database around the session.

---

## Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://...` | Async DB URL for the API |
| `DATABASE_SYNC_URL` | `postgresql://...` | Sync DB URL for Celery workers |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection |
| `STORAGE_BACKEND` | `local` | `local` or `s3` |
| `EXTRACTION_BACKEND` | `native_pdf` | Active extraction adapter name |
| `SECRET_KEY` | *(change this)* | JWT signing key |
| `LOG_LEVEL` | `INFO` | structlog level |
