# Export Run Persistence Contract

> **Status:** frozen as of Phase 5E (Phases 5A–5D delivered).
> Extended in Phase 6A with the approval workflow foundation —
> see §6.1.
> **Scope:** persisted draft / audit records only. No production
> export, no file generation, no external posting, no document /
> batch / template mutation, no background processing. Phase 6A
> adds approval-workflow metadata; the workflow gate
> ``approved_for_file_generation`` is a metadata-only state and
> does NOT generate a file or finalise an export.
>
> This document is the canonical reference for any future phase
> that touches the **persisted** Export Run surface (the
> `export_runs` table + the `/api/v1/export-runs/` endpoint
> family + the Settings → Export Runs UI). It is the persistence
> companion to the stateless evaluator contract at
> [`export-run-draft-contract.md`](./export-run-draft-contract.md)
> and sits under the broader Operational Preview boundary at
> [`operational-preview-contract.md`](./operational-preview-contract.md)
> §8.

---

## 1. Purpose

The `export_runs` table stores a **draft / audit record** of one
intentional save of a diagnostic Phase 4F draft verdict. Saving a
record creates an audit trail entry that an operator can review,
filter, and annotate later. The persistence layer:

* Captures the operator's intent ("I am keeping this verdict for
  the audit trail").
* Captures the diagnostic snapshot that produced the verdict.
* Captures small operator-supplied notes.
* Surfaces the persisted record through the Settings → Export
  Runs audit list and detail panel.

**It does not create a production export.**

It does not generate a file, create a download URL, finalise an
export run, mark a document / batch / template as exported, or
post anything externally.

---

## 2. What a persisted record means

A persisted `export_runs` row means **all** of the following:

* An operator (or a programmatic API caller) explicitly clicked
  "Save draft audit record" — Phase 5A / 5B intentionally do NOT
  expose any auto-save / background-save / scheduled-save path.
* The Phase 4F evaluator was re-run server-side against the
  caller-supplied diagnostic input
  (`build_export_run_draft_from_input`) so the persisted snapshot
  is the canonical verdict, not a stale / forged caller-supplied
  one.
* The verdict's hard-pinned literals (`draft_only=True`,
  `finalized=False`, `file_generated=False`,
  `download_available=False`, `production_export_ready=False`)
  were re-validated through Pydantic `Literal[…]` AND a
  hand-rolled walker before the row was written.
* The `request_snapshot` and `draft_snapshot` JSONB blobs were
  walked recursively for forbidden export / file / posting /
  finalisation handle keys; any hit rejected the write as HTTP
  422.
* The row's `phase` is `"draft"`. Phase 5A locks this column to
  `"draft"` for every persisted row.

A persisted record is therefore an **audit trail entry**, not a
production export.

---

## 3. What a persisted record does NOT mean

A persisted `export_runs` row means **none** of the following:

* No finalised export run has been created.
* No CSV / XLSX / PDF / any other file has been generated.
* No download URL has been issued.
* No document, batch, or template was marked exported.
* No `documents` / `batches` / `invoice_templates` /
  `export_profiles` row was modified as a side effect.
* No external accounting system (ResMan / Yardi / AppFolio) was
  contacted, queried, or updated.
* No export batch was created.
* No Review Queue record was created.
* No background job was scheduled.

The persisted record's `id` is a **draft / audit record id**. It
is NOT an export id, NOT a file id, NOT proof of export, and NOT
a downstream finalisation handle.

---

## 4. Field semantics

### `ExportRunRecord` columns
(from `backend/app/models/export_run.py`)

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | UUID PK | Audit record id. NOT an export id. |
| `status` | string(32) | `draft_clear` / `needs_review` / `blocked`. Closed Literal at the schema layer. The Phase 4F `not_available` evaluator outcome is mapped to `"blocked"` on the persistence side. |
| `phase` | string(32) | Always `"draft"` in this phase. Forward-compat at the column type level (free-text), but the management service hard-locks the value. |
| `source` | string(32) | `operational_preview` / `api` / `manual`. Closed Literal. |
| `export_profile_id` | UUID nullable | Soft FK to `export_profiles.id`. Never coerced from a built-in / inline / non-UUID id. |
| `export_profile_name` / `_version` | string / int nullable | Snapshot copies of the profile metadata so the audit row remains readable if the profile is later renamed / deactivated. |
| `template_id` / `document_id` / `batch_id` | UUID nullable | Soft FKs. Echoed for provenance only; never loaded. |
| `target_system` | string(32) nullable | `custom_csv` / `resman` / `yardi` / `appfolio`. Closed Literal at the service layer. |
| `row_count` / `blocked_row_count` / `warning_row_count` / `issue_count` | int default 0 | Captured from the locally re-evaluated Phase 4F verdict. |
| `draft_snapshot` | JSONB | The full `BackendExportRunDraftResult` serialised. Hard pins re-validated on write. |
| `request_snapshot` | JSONB nullable | The diagnostic request input + caller-supplied extension keys. Sanitised on write. |
| `notes` | text nullable | Operator-only notes. The PATCH endpoint accepts ONLY this field. |
| `created_by_user_id` / `updated_by_user_id` | UUID nullable | Soft FKs to the actor. Never enforced. |
| `created_at` / `updated_at` | timestamptz | Standard `TimestampMixin`. |

### Closed Literal vocabularies
(from `backend/app/schemas/export_run_persistence.py`)

* `ExportRunRecordStatus` = `Literal["draft_clear", "needs_review", "blocked"]`.
* `ExportRunRecordPhase` = `Literal["draft"]`.
* `ExportRunRecordSource` = `Literal["operational_preview", "api", "manual"]`.

A future approval / finalisation phase that needs an additional
status / phase / source MUST extend the Literal AND update this
document AND extend the regression tests. It must NEVER widen the
contract by accepting raw strings.

---

## 5. Forbidden fields and handles

The following keys MUST NOT appear:

* in any `ExportRunRecord` column,
* in any `PersistedExportRun*` Pydantic schema,
* in any wire payload (request OR response) of the
  `/api/v1/export-runs/` endpoint family,
* in any nested level of the `draft_snapshot` /
  `request_snapshot` JSONB blobs.

```
download_url
file_url
file_id
export_id
export_run_id
export_batch_id
posted_at
external_posting_id
finalized_at
exported_at
external_system_id
```

`id` is allowed (it IS the audit record id). `selected_profile_id`
is allowed (it is a profile catalog reference). `export_profile_id`
is allowed (same reason). The Phase 5E regression suite asserts
the model column set and wire-shape walker enforce this.

---

## 6. Endpoints

| Method | Path | Behavior | Schema |
| --- | --- | --- | --- |
| POST | `/api/v1/export-runs/drafts` | Persist a new draft / audit row from a diagnostic snapshot. Re-evaluates the verdict locally; rejects forbidden snapshot keys; 201 on success. | Body `ExportRunCreate`; response `ExportRunRead`. |
| GET | `/api/v1/export-runs` | List newest-first. Filter params: `status_` (FastAPI shadow-name for status), `phase` (defaults `"draft"`; non-draft → 422), `source`, `export_profile_id`, `target_system`, `document_id`, `batch_id`, `limit`, `offset`. | Response `ExportRunListResponse` (items: `ExportRunSummary[]`). |
| GET | `/api/v1/export-runs/{run_id}` | Read one record. 404 on missing. | Response `ExportRunRead`. |
| PATCH | `/api/v1/export-runs/{run_id}` | **Notes-only** update. The `ExportRunUpdate` schema uses `extra="forbid"` so any other field 422s. | Body `ExportRunUpdate`; response `ExportRunRead`. |

The persistence endpoint family deliberately exposes the record
id under the field name `id` — never `export_run_id` — so the
Phase 3O / 4I forbidden-handle audit stays sharp on every other
surface.

---

## 6.1 Approval workflow foundation (Phase 6A)

Phase 6A adds an explicit, narrowly-scoped **approval workflow**
on top of the Phase 5A persistence layer. The workflow lives
behind three new endpoints; the existing PATCH endpoint REMAINS
notes-only.

### Approval status vocabulary

`ExportRunApprovalStatus` (closed Literal in
`backend/app/schemas/export_run_persistence.py`):

| Value | Meaning |
| --- | --- |
| `not_requested` | Default for every new persisted row. |
| `pending_review` | An operator has explicitly requested approval. |
| `approved_for_file_generation` | A reviewer has explicitly approved the record. **Workflow gate ONLY — see hard contract below.** |
| `rejected` | A reviewer has explicitly rejected the record; `rejection_reason` is required and persisted. |

### Transition endpoints

| Method | Path | Allowed source state(s) | Body | Response | Conflict |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/export-runs/{id}/request-approval` | `not_requested`, `rejected` | `ExportRunRequestApproval` (optional `approval_notes`) | `ExportRunRead` | 409 from any other source state. |
| POST | `/api/v1/export-runs/{id}/approve-for-file-generation` | `pending_review` AND `status == "draft_clear"` | `ExportRunApproveForFileGeneration` (optional `approval_notes`) | `ExportRunRead` | 409 if not pending review, OR if the draft `status` is `blocked` / `needs_review`. |
| POST | `/api/v1/export-runs/{id}/reject-approval` | `pending_review` | `ExportRunRejectApproval` (REQUIRED non-empty `rejection_reason`, optional `approval_notes`) | `ExportRunRead` | 409 from any other source state. 422 if `rejection_reason` is missing / empty. |

All three request schemas use `extra="forbid"` so a forged body
cannot smuggle a status / phase / snapshot field through the
transition endpoint. The Phase 5A PATCH endpoint
(`PATCH /api/v1/export-runs/{run_id}`) STILL refuses any field
other than `notes`; the Phase 5E regression suite + a new Phase
6A regression block enforce this.

### Re-request after rejection

`request-approval` accepts `rejected` as a source state. On the
re-request, the service:

* Sets `approval_status = "pending_review"`.
* Sets fresh `approval_requested_at` / `approval_requested_by_user_id`.
* Clears `approved_at` / `approved_by_user_id` / `rejected_at` /
  `rejected_by_user_id` / `rejection_reason` so the audit trail
  reflects the freshest request only.

### Hard contract — even when approved

When `approval_status == "approved_for_file_generation"`:

* `phase` remains `"draft"` (Phase 5A lock holds).
* `status` is unchanged (Phase 5A vocabulary).
* `draft_snapshot.draft_only` / `finalized` / `file_generated` /
  `download_available` / `production_export_ready` are unchanged
  (Phase 4F hard pins hold).
* No file is generated, no download URL issued, no document /
  batch / template mutated, no external system contacted, no
  export batch created, no Review Queue record created.
* The endpoint name calls out the future gate explicitly so a
  paste-into-Slack reader or an API consumer sees the intent —
  but the wire shape carries no file / download / posting /
  finalisation handle.

A future controlled file-generation phase MAY use
`approval_status == "approved_for_file_generation"` as a
prerequisite for a NEW `POST /api/v1/export-runs/{id}/generate-file`
endpoint. That endpoint does NOT exist today.

### Approval notes vs. notes

The `notes` column (Phase 5A) is the operator's general audit
notes. The `approval_notes` column (Phase 6A) is workflow-time
context (request / approve / reject). They live in separate
columns so the audit trail keeps both intact:

* `PATCH /api/v1/export-runs/{id}` writes `notes` only.
* The three transition endpoints write `approval_notes` only.
* Neither endpoint family touches the other's column.

### Forbidden additions

The following remain forbidden on the persistence surface even
with the approval foundation in place:

* No `finalized_at` / `exported_at` / `file_generated_at` /
  `file_id` / `file_url` / `download_url` / `posted_at` /
  `external_posting_id` / `external_system_id` columns. Phase 5E
  forbidden-handle audit covers this.
* No `POST /finalize` / `POST /generate-file` / `GET /file` /
  `POST /post` / `POST /mark-exported` endpoints. The §7 forbidden
  list still applies.
* No silent transitions (e.g. PATCH that flips
  `approval_status`). Approval state changes ONLY through the
  three explicit POST endpoints above.
* No automatic transitions (e.g. background job that auto-approves
  `draft_clear` records). Every transition is operator-driven.
* No revoke / rollback transitions today —
  `approved_for_file_generation` is terminal-for-this-phase. A
  future phase MAY add an explicit revoke endpoint with its own
  contract update.

---

## 7. Endpoints explicitly forbidden until future phases

The following endpoints / actions DO NOT EXIST today AND must
NOT exist on the persistence surface until an explicit
export-engine phase introduces them with their own contract,
audit trail, and approval machinery:

* `POST /api/v1/export-runs/{id}/finalize`
* `POST /api/v1/export-runs/{id}/generate-file`
* `GET  /api/v1/export-runs/{id}/file` / any download endpoint
* `POST /api/v1/export-runs/{id}/post`
* `POST /api/v1/export-runs/{id}/mark-exported`
* `DELETE /api/v1/export-runs/{id}` (hard delete) and any
  archival flow that mutates the row in place without an
  explicit, separate state column.

PATCH must NOT extend beyond `notes`. Status / phase /
draft_snapshot / export_profile_id / row counts are read-only on
this surface today.

---

## 8. Frontend surfaces

Two frontend surfaces consume the persistence layer:

### 8.1 Operational Preview — Save draft audit record (Phase 5B)

* `OperationalResolutionPreviewPanel.tsx` adds a "Save draft
  audit record" button inside the Export Run Draft section.
* Manual click only. No `useEffect` auto-save. No retry on
  mount.
* On success: cyan/blue (NEVER green) success card with the
  saved record id, phase, status, created_at + the disclaimer
  block.
* Stale-after-save fingerprint comparison surfaces a yellow
  notice when the diagnostic preview drifts after save.
* The full operational report gains a "Persisted Draft Audit
  Record" section when a record exists; uses the term
  "Audit record id" never `export_run_id`.

### 8.2 Settings → Export Runs (Phase 5C + 5D)

* `/settings/export-runs` → `ExportRunsPage.tsx` →
  `ExportRunDetailPanel.tsx`.
* Lists persisted records newest-first with status / target
  system filters and Load More pagination.
* Detail modal shows identity / counts / hard pins / operator
  fields / disclaimers / notes editor / collapsible technical
  snapshot.
* Notes-only PATCH; Save button disabled when nothing changed
  (whitespace-only normalised); character-count near the cap;
  in-place row update after a successful save.
* Forward-compat unknown values render with neutral tones — an
  unknown status is never coloured cyan.
* Technical snapshot uses `safeStringifySnapshot` with a 20,000
  char cap, JSON.stringify error handling, and missing-payload
  copy.

### Safe wording (allowed on both surfaces)

* "Audit record id"
* "Draft audit record"
* "Persisted draft record"
* "Notes only"
* "No export file generated" / "No export file was generated"
* "Not finalized" / "No finalized export run was created"
* "Production export unavailable"

### Forbidden wording (must not appear in operator-facing UI)

* "Export now"
* "Finalize export"
* "Finalized export"
* "Download CSV"
* "Download file"
* "Download URL"
* "Send to ResMan"
* "Post to Yardi"
* "Mark exported"
* "Generate file"
* "Save export"
* "Create export"

These phrases are allowed ONLY in:

* documentation (this file, `export-run-draft-contract.md`,
  `operational-preview-contract.md`) as forbidden examples,
* code comments explaining what the surface AVOIDS,
* hard-pin negations like `finalized: **No**` in pill rows.

---

## 9. Future phases ALLOWED

These extensions are acceptable in future phases but were
explicitly scoped out of Phases 5A–5E:

1. **Archive flow.** A separate `is_archived` column or a
   distinct `archived` phase, with explicit transition endpoints
   and operator UI. No hard delete.
2. **Approval workflow.** A per-row state machine that flips
   from `phase="draft"` to `phase="approved"` only after explicit
   operator approval is recorded in an audit table. The PATCH
   endpoint does NOT cover this.
3. **Finalised export transition.** A separate phase value
   (`phase="finalized"`) gated on approval + audit + file
   controls. Either extend `phase` or create a separate
   `export_runs_finalized` table.
4. **Controlled file generation.** A new endpoint (e.g.
   `POST /api/v1/export-runs/{id}/generate-file`) that creates
   a file artefact ONLY for finalised rows. The
   `/api/v1/export-runs/drafts` endpoint continues NOT to
   generate files.
5. **Export batch model.** A new `export_batches` table that
   groups finalised exports. No FK from `export_runs` to such a
   table is added today.
6. **External posting** — ResMan / Yardi / AppFolio adapters
   BEHIND the audit + file controls above. Never invoked from
   the draft / persistence surface.

When all the always-on Phase 4F architectural reasons
(`diagnostic_only_pipeline`, `no_export_engine`, etc.) are
dropped from the verdict, a future phase can graduate the
contract — until then they remain in the verdict + report.

---

## 10. Future phases FORBIDDEN without an explicit contract update

The following are forbidden today AND will remain forbidden as
"silent" behaviour even after an export engine exists. Any of
them requires an explicit update to this document, the
`export-run-draft-contract.md` doc, AND new regression tests:

* **Auto-save export runs.** Every persisted row must come from
  an explicit operator click recorded in the audit trail.
* **Silently finalising a record** by flipping `phase` /
  `status` from any endpoint other than an explicit
  approval-workflow endpoint.
* **Generating files from the audit page.** Settings →
  Export Runs is read-only with notes-only PATCH; any file
  generation belongs to a future, separate endpoint surface.
* **Adding download buttons to draft records.** The detail
  modal must never expose a download.
* **Mutating documents / batches / templates from a draft
  record.** Soft FKs are echo-only; the persistence layer never
  writes to those tables.
* **Calling external systems from a draft record.** No
  ResMan / Yardi / AppFolio calls from the
  `/api/v1/export-runs/` endpoint family.
* **Background jobs** triggered by save / list / read / patch.
* **Hard delete** without an explicit archival design.
* **Auto-refresh / polling** loops on the audit list page.

If a future task ever asks for any of the above on the draft
persistence surface, push back and clarify before implementing.

---

## 11. Reference

### Backend

* Model: `backend/app/models/export_run.py`
* Migration: `backend/alembic/versions/a7b8c9d0e1f2_add_export_runs_table.py`
* Persistence schemas: `backend/app/schemas/export_run_persistence.py`
* Repository: `backend/app/repositories/export_run_repo.py`
* Management service: `backend/app/services/export_run_management.py`
* API: `backend/app/api/v1/export_runs.py`

### Backend tests

* Service tests (Phase 5A): `backend/tests/test_services/test_export_run_management.py`
* API smoke tests (Phase 5A): `backend/tests/test_api/test_export_runs_drafts.py`
* **Persistence contract regression (Phase 5E):**
  `backend/tests/test_api/test_export_run_persistence_contract.py`
* Phase 3O forbidden-handle audit helper:
  `backend/tests/test_api/test_operational_preview_contract.py::assert_no_export_handles`
* Phase 4I draft contract regression:
  `backend/tests/test_api/test_export_run_draft_contract.py`

### Frontend

* Types: `frontend/src/types/export-run-persistence.ts`
* API client: `frontend/src/lib/api/export-runs.ts`
* Operational Preview save action (Phase 5B):
  `frontend/src/features/invoice-templates/components/OperationalResolutionPreviewPanel.tsx`
* Operational Preview persistence adapter (Phase 5B):
  `frontend/src/features/invoice-templates/lib/export-run-persistence-adapter.ts`
* Operational Preview persistence hook (Phase 5B):
  `frontend/src/features/invoice-templates/hooks/usePersistExportRunDraft.ts`
* Audit list page (Phase 5C + 5D):
  `frontend/src/app/(app)/settings/export-runs/page.tsx`
* Audit list / detail components (Phase 5C + 5D):
  `frontend/src/features/export-runs/components/`
* Audit list / detail hooks (Phase 5C + 5D):
  `frontend/src/features/export-runs/hooks/`
* Audit list display helpers (Phase 5C + 5D):
  `frontend/src/features/export-runs/lib/export-run-display.ts`

### Related docs

* [`export-run-draft-contract.md`](./export-run-draft-contract.md)
  — stateless evaluator contract (Phase 4F–4I).
* [`operational-preview-contract.md`](./operational-preview-contract.md)
  — the broader Operational Preview hard boundaries.
