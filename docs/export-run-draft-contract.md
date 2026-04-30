# Export Run Draft Contract

> **Status:** frozen as of Phase 4I (Phases 4F–4H delivered).
> Extended in Phase 5A with optional persisted draft / audit
> records — see §11.
> **Scope:** diagnostic only. No production export, no file
> generation, no external posting. Phase 5A introduces an
> optional persisted draft / audit row but the row remains a
> draft — see §11 for the contract shift.
>
> This document is the canonical reference for any future phase that
> touches the Export Run Draft surfaces. It defines what the
> contract IS, what it explicitly is NOT, and which boundaries
> future engine work must continue to honour.
>
> See also: [`operational-preview-contract.md`](./operational-preview-contract.md)
> §8 for the broader Operational Preview hard boundaries this
> contract sits under.

---

## 1. Purpose

The **Export Run Draft** is a stateless diagnostic verdict that
asks: "if Rivera could create an export run today, would the
current diagnostic snapshot form a clean draft, a blocked one, or
something in between?"

It composes:

* the operator's selected export profile (saved vs. built-in),
* the Phase 3J profile validation status,
* the Phase 3M readiness boundary diagnostic status,
* the export-style preview row counts + issue counts,
* a small whitelisted context echo for Slack-paste provenance,

and returns a single typed verdict the panel + the consolidated
Markdown report can render.

**It is a draft preview surface — not an export run.**

It does NOT create a draft record, an export run, an export batch,
a file, a download URL, or any external posting. It does NOT
mutate documents, batches, or templates.

---

## 2. Inputs

The endpoint accepts one body — `{ "input": ExportRunDraftInput }`.
Every field on `ExportRunDraftInput` is optional; an empty body
returns `not_available`.

Allowed input fields (all are diagnostic only):

| Field | Purpose |
| --- | --- |
| `operational_result_id` | Echoed for provenance — never loaded. |
| `template_id` | Echoed for provenance — never loaded. |
| `document_id` | Echoed for provenance — never loaded. |
| `batch_id` | Echoed for provenance — never loaded. |
| `selected_profile_id` | Profile id (saved or built-in). |
| `selected_profile_source` | `saved`, `built_in`, etc. Drives the `profile_not_persisted` reason. |
| `profile_validation_status` | `clear`, `needs_review`, `blocked`, `conflict`. |
| `readiness_diagnostic_status` | `clear`, `needs_review`, `blocked`. |
| `production_export_ready` | Caller's claim. **Captured + IGNORED.** Response stays pinned to `False`. |
| `export_preview_row_count` | Total rows in the diagnostic preview. |
| `export_preview_issue_count` | Cells with issues in the diagnostic preview. |
| `blocked_row_count` | Rows the resolver / profile check blocked. |
| `warning_row_count` | Rows the resolver / profile check flagged. |
| `context` | Diagnostic-only context echo (allowlisted on the frontend). |

The backend service NEVER loads anything from these IDs. They are
echoed back inside `ExportRunDraft.context` so a paste-into-Slack
workflow keeps provenance without re-querying.

The frontend adapter
(`frontend/src/features/invoice-templates/lib/export-run-draft-adapter.ts`)
sanitises `context` against a closed allowlist — see §6.

---

## 3. Hard pins

The response model
(`backend/app/schemas/export_run_draft.py::ExportRunDraft`) carries
five hard-pinned fields. All five are typed with Pydantic
`Literal[True]` / `Literal[False]` so a downstream consumer
**cannot** construct an `ExportRunDraft` with any other value:

| Field | Type | Value |
| --- | --- | --- |
| `draft_only` | `Literal[True]` | `True` |
| `finalized` | `Literal[False]` | `False` |
| `file_generated` | `Literal[False]` | `False` |
| `download_available` | `Literal[False]` | `False` |
| `production_export_ready` | `Literal[False]` | `False` |

Every diagnostic status (`draft_clear`, `needs_review`, `blocked`,
`not_available`) ships with the same five hard pins. `draft_clear`
does NOT mean the future export engine could ship a file — it
means the diagnostic axes are currently clean.

---

## 4. Forbidden outputs

The response from the **stateless evaluator** endpoint
(`POST /api/v1/export-run-drafts/evaluate`) MUST NOT contain any
of the following keys at any nesting depth (the same set the
Phase 3O regression audit guards):

* `download_url`
* `file_url`
* `file_id`
* `export_id`
* `export_run_id`
* `export_batch_id`
* `posted_at`
* `external_posting_id`

`selected_profile_id` is **allowed** because a profile id is a
catalog reference, not an export handle. The Phase 3O audit
helper (`assert_no_export_handles`) explicitly excludes profile
ids from its forbidden set.

The Phase 5A **persistence** endpoint
(`POST /api/v1/export-runs/drafts`) returns a draft / audit
record id under the field name `id`. That field is the database
record id of a draft / audit row — it is **not** an export id,
**not** a finalised export run id, **not** a file id, and does
**not** imply file generation, document / batch / template
mutation, or external posting. See §11 for the persistence
contract; see §4 above for the keys that remain forbidden on
both endpoints.

The persistence endpoint MUST NOT return any of the following
keys (Phase 5A regression):

* `download_url`
* `file_url`
* `file_id`
* `export_id`
* `export_run_id` *(use `id` instead)*
* `export_batch_id`
* `posted_at`
* `external_posting_id`
* `finalized_at`
* `exported_at`
* `external_system_id`

If a future phase needs any of the forbidden keys above, it MUST
land on a NEW endpoint (e.g. `/export-runs/finalize`) with its own
model + audit trail. The diagnostic evaluator stays stateless on
the wire so the diagnostic / production boundary stays sharp.

---

## 5. Backend endpoint

### `POST /api/v1/export-run-drafts/evaluate` (Phase 4F)

* Accepts `ExportRunDraftRequest` (envelope around
  `ExportRunDraftInput`); the body can be `{}` and the input
  defaults to an empty model.
* `diagnostic_only` is implied — the endpoint is purely
  computational. The response is built by
  `app.services.export_run_draft.build_export_run_draft_from_input`
  and never persists anything.
* `production_export_ready` from the input is intentionally
  IGNORED for the response field (Pydantic `Literal[False]` keeps
  the response pinned). The caller's claim is captured inside
  `context.input_production_export_ready_claim` for audit.
* `selected_profile_source != "saved"` (built-in / inline /
  unknown / null) can never reach `draft_clear`; the classifier
  returns `needs_review` with `profile_not_persisted` in the
  reason list.
* Returns deterministic `status` + `reasons` + operator messaging
  + next steps + disclaimers.
* No DB lookup. No file generation. No mutation. No external
  posting. Read-only with respect to ALL persisted state.

---

## 6. Frontend integration

* The Export Run Draft panel lives inside
  `OperationalResolutionPreviewPanel` (Phase 4G) — it sits below
  the readiness boundary section so the operator reads the
  boundary contract first.
* The `useBackendExportRunDraft` hook (Phase 4G + 4H):
  * Debounces input changes (~350 ms) and aborts in-flight
    requests on input change.
  * Tracks a stale fingerprint so the panel can keep showing
    last-known-good data while a fresh request is in flight or
    just failed.
  * Exposes `data`, `loading`, `error`, `verified`, `source`,
    `stale`, `lastUpdatedAt`, and `retry()`.
* The Phase 4H frontend adapter sanitises every outbound `context`
  value against a closed allowlist
  (`EXPORT_RUN_DRAFT_CONTEXT_ALLOWLIST`):
  * `validation_source`
  * `boundary_source`
  * `profile_option_id`
  * `profile_label`
  * `profile_version`
  * `profile_target_system`
  * `export_preview_status`
  * `export_preview_columns`
  * `parity_status`

  Any other key is silently dropped by
  `sanitizeExportRunDraftContext`. Forbidden export / file /
  posting handles cannot escape onto the wire even if a future
  caller accidentally adds them to `rawContext`.
* The Phase 4H adapter coerces every numeric count through
  `_normalizeCount`: NaN / `Infinity` / negative / non-numeric
  → 0; fractionals are floored. The wire body stays internally
  consistent even when an upstream memo briefly produced a
  transient bad value.
* The frontend NEVER sends raw resolver output, raw rows, raw
  documents, raw extracted facts, raw catalog hints, raw PDFs,
  or any PII-sized payload. The request body carries status
  labels + IDs + counts only.
* Stale-state handling (Phase 4H):
  * `stale === true` whenever the displayed data was evaluated
    against an older input fingerprint AND the current request is
    either loading or just failed.
  * The banner uses
    `pickExportRunDraftSourceCopy(source, stale)` to render the
    "Refreshing export draft…" / "Could not refresh export draft"
    variants.
  * The banner ALWAYS shows a `Last evaluated: <localized time>`
    line when a timestamp exists.
  * The body shows a "Showing last evaluated draft…" callout
    above the status row when stale.
* The full operational report (Phase 4G + 4H) includes an
  "Export Run Draft" section with the same hard pins, an
  operator-friendly reason label map, and stale + last-evaluated
  markers when the parent panel is in a stale state.

---

## 7. Safe wording

The contract surfaces (panel, banner, body, full report,
disclaimers) MUST use only diagnostic-honest copy.

### Allowed

* "Draft clear"
* "Diagnostic draft"
* "Production export unavailable"
* "No export file was generated"
* "No finalized export run was created"
* "Showing last evaluated draft…"
* "Refreshing export draft…"
* "Could not refresh export draft"
* "Last evaluated: …"
* Hard-pin negations (`draft_only: Yes`, `finalized: No`,
  `file_generated: No`, `download_available: No`,
  `production_export_ready: No`)

### Forbidden

* "Ready to export"
* "Export now"
* "Download CSV"
* "Download URL"
* "Export ID"
* "Run ID"
* "File ID"
* "Send to ResMan"
* "Post to Yardi"
* "Finalize export"
* "Finalized export"

These phrases are allowed ONLY in:

* documentation (this file) as forbidden examples,
* code comments explaining what the surface AVOIDS,
* hard-pin negations like `finalized: **No**` in the pill row.

If operator-facing UI / report text contains a forbidden phrase,
replace before merging.

---

## 8. Future phases ALLOWED

The following work is acceptable in future phases and was
explicitly scoped out of Phases 4F–4I:

1. **Persisted export run model** — a real `ExportRun` row with a
   server-generated `export_run_id`. Drops
   `no_export_run_persistence` from the always-on reason list.
2. **Approval workflow** — explicit operator approval state
   machine before any external action. Drops `no_final_approval`.
3. **Audit trail** — DB-backed audit rows tied to export runs.
   Drops `no_export_audit_trail`.
4. **Controlled file generation** — CSV / XLSX / PDF generation
   gated on approved export runs only. Drops `no_file_generation`.
5. **Finalized export** — only after approvals + audit + file
   controls land. Drops `diagnostic_only_pipeline`.
6. **External posting** — ResMan / Yardi / AppFolio adapters
   BEHIND the audit + file controls above. Drops
   `no_external_posting`.

When all the always-on reasons are dropped, a future phase can
introduce a NEW status type that includes a "finalized-ready"
verdict and graduate the contract. **Until then, none of these
may exist.**

---

## 9. Future phases FORBIDDEN until explicit export-engine phase

The following are forbidden today on the **stateless evaluator
endpoint** (`/api/v1/export-run-drafts/evaluate`) AND will remain
forbidden as "silent" behaviour even after the export engine
exists:

* **Creating any `export_run_id` flavour from the evaluator
  endpoint.** The evaluator is the diagnostic / preview side; a
  persisted draft / audit `id` lives ONLY on the Phase 5A
  persistence endpoint (`POST /api/v1/export-runs/drafts`). See
  §11.
* **Generating files from the evaluator OR persistence
  endpoint.** No CSV / XLSX / PDF / any other artefact may be
  returned by either endpoint even when `status == "draft_clear"`.
* **Mutating documents, batches, or templates from either
  endpoint.** The draft (stateless or persisted) never owns
  export status; document / batch / template state is read-only
  on these surfaces.
* **Returning download URLs / file IDs / export IDs / export run
  IDs / posting IDs from the evaluator endpoint.** See §4 —
  Phase 3O's `assert_no_export_handles` helper guards this in
  `backend/tests/test_api/test_operational_preview_contract.py`
  and the Phase 4I regression file (see §10). The Phase 5A
  persistence endpoint MUST also avoid these handles, exposing
  only the persisted record `id`.
* **Calling external systems (ResMan / Yardi / AppFolio) from
  either endpoint.** External adapters may exist behind future
  export-engine endpoints, but never the diagnostic ones.
* **Persisting state from the evaluator endpoint.** The
  evaluator MUST stay stateless on the wire. Persistence happens
  ONLY through the explicit Phase 5A persistence endpoint, and
  even then only as a draft / audit row.
* **Background jobs triggered by a draft evaluation OR a draft
  persistence call.** No queue publish, no worker dispatch, no
  scheduled task creation.

If a future task ever asks for any of the above, push back and
clarify before implementing.

---

## 10. Reference

* Backend schema:
  `backend/app/schemas/export_run_draft.py`
* Backend service:
  `backend/app/services/export_run_draft.py`
* Backend route:
  `backend/app/api/v1/export_run_drafts.py`
* Phase 4F service tests:
  `backend/tests/test_services/test_export_run_draft.py`
* Phase 4F API smoke tests:
  `backend/tests/test_api/test_export_run_drafts.py`
* Phase 4I contract regression tests:
  `backend/tests/test_api/test_export_run_draft_contract.py`
* Phase 3O forbidden-handle audit helper:
  `backend/tests/test_api/test_operational_preview_contract.py::assert_no_export_handles`
* Frontend types:
  `frontend/src/types/export-run-draft.ts`
* Frontend API client:
  `frontend/src/lib/api/export-run-drafts.ts`
* Frontend adapter (request builder + context allowlist + count
  normalisation + source-copy bucket):
  `frontend/src/features/invoice-templates/lib/export-run-draft-adapter.ts`
* Frontend hook (debounce + abort + stale fingerprint +
  last-updated timestamp):
  `frontend/src/features/invoice-templates/hooks/useBackendExportRunDraft.ts`
* Frontend panel:
  `frontend/src/features/invoice-templates/components/OperationalResolutionPreviewPanel.tsx`
* Frontend full-report builder:
  `frontend/src/features/invoice-templates/lib/operational-full-report.ts`

---

## 11. Persisted draft audit records (Phase 5A)

> **Phase 5E:** the persisted draft / audit surface has its own
> canonical contract document at
> [`export-run-persistence-contract.md`](./export-run-persistence-contract.md).
> That document covers the `export_runs` table, the
> `/api/v1/export-runs/` endpoint family, the Settings →
> Export Runs UI, the closed Literal vocabularies for
> `status` / `phase` / `source`, the forbidden-key set, and the
> regression tests at
> `backend/tests/test_api/test_export_run_persistence_contract.py`.
> The summary below remains for context; treat the persistence
> contract doc as the source of truth for any persistence-layer
> question.

Until Phase 4I the Export Run Draft contract was 100% stateless:
the diagnostic evaluator endpoint computed a verdict and returned
it without touching the database. Phase 5A introduces an
**explicit, opt-in** persistence layer for the same draft
verdict. The contract shift is narrow and tightly scoped:

### What changed

* The Phase 4F evaluator endpoint
  (`POST /api/v1/export-run-drafts/evaluate`) is **unchanged**.
  It remains stateless. It still MUST NOT return any
  `export_run_id` flavour.
* A new sibling endpoint family lives at
  `/api/v1/export-runs/`:
  * `POST /api/v1/export-runs/drafts` — persist a draft / audit
    row.
  * `GET  /api/v1/export-runs` — list persisted draft / audit
    rows.
  * `GET  /api/v1/export-runs/{id}` — read one record.
  * `PATCH /api/v1/export-runs/{id}` — notes-only update.
* Persisted rows live in the `export_runs` table
  (`backend/app/models/export_run.py`,
  `backend/alembic/versions/a7b8c9d0e1f2_add_export_runs_table.py`).
* Every persisted row carries `phase="draft"`.

### What `id` means

* `id` is a **draft / audit record id**.
* `id` is NOT a finalised export id.
* `id` is NOT a file id.
* `id` is NOT proof of export.
* `id` does NOT imply file generation.
* `id` does NOT imply document / batch / template mutation.
* `id` does NOT imply external posting.
* The persistence endpoint deliberately uses the field name
  `id` — not `export_run_id` — to keep the Phase 3O / 4I
  forbidden-handle audit sharp on every other surface.

### Hard pins on persisted rows

The management service
(`backend/app/services/export_run_management.py`) ALWAYS:

* Re-evaluates the verdict locally via
  `build_export_run_draft_from_input` so the persisted snapshot
  cannot be poisoned by a stale / forged caller-supplied
  verdict.
* Asserts the snapshot carries `draft_only=True`,
  `finalized=False`, `file_generated=False`,
  `download_available=False`, `production_export_ready=False`
  before write. The Pydantic `Literal[…]` types already enforce
  this; the service re-checks the serialised dict so a future
  Pydantic regression cannot silently widen the contract.
* Walks the snapshot recursively for forbidden export / file /
  posting / finalisation handle keys (see
  `FORBIDDEN_SNAPSHOT_KEYS` in
  `app.schemas.export_run_persistence`). Any hit is rejected as
  HTTP 422.
* Pins `phase="draft"`. Phase 5A does NOT expose status / phase
  / snapshot mutation through PATCH. A future approval phase
  may add explicit transition endpoints behind explicit
  export-engine work.
* Maps the Phase 4F evaluator's `not_available` status to
  persisted `"blocked"` so the persistence vocabulary stays
  closed (`draft_clear` / `needs_review` / `blocked`).

### What persistence does NOT do

* Does NOT generate a file.
* Does NOT create a download URL.
* Does NOT mark a document, batch, or template as exported.
* Does NOT mutate documents, batches, templates, or any other
  table.
* Does NOT call external systems.
* Does NOT trigger background jobs.
* Does NOT count as a finalised export.

### Future phases

The "Future phases ALLOWED" list in §8 still applies — Phase 5A
is the persistence foundation, not the export engine. The
following are still required before any actual export can be
finalised:

1. Approval workflow.
2. Audit trail expansion.
3. Controlled file generation.
4. Finalised export run transition (a separate phase column
   value or a separate table).
5. External posting BEHIND the audit + file controls.

### Reference

* Backend model:
  `backend/app/models/export_run.py`
* Backend migration:
  `backend/alembic/versions/a7b8c9d0e1f2_add_export_runs_table.py`
* Backend persistence schemas:
  `backend/app/schemas/export_run_persistence.py`
* Backend repository:
  `backend/app/repositories/export_run_repo.py`
* Backend management service:
  `backend/app/services/export_run_management.py`
* Backend API:
  `backend/app/api/v1/export_runs.py`
* Phase 5A service tests:
  `backend/tests/test_services/test_export_run_management.py`
* Phase 5A API tests:
  `backend/tests/test_api/test_export_runs_drafts.py`
* Phase 5E persistence contract regression tests:
  `backend/tests/test_api/test_export_run_persistence_contract.py`
* Phase 5E persistence contract document:
  [`export-run-persistence-contract.md`](./export-run-persistence-contract.md)
