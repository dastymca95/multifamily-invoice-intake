# Operational Preview Contract

> **Status:** frozen as of Phase 3O (Phases 3A–3N delivered).
> **Scope:** diagnostic only. No production export exists.
>
> This document is the canonical reference for any future phase that
> touches the Operational Preview surfaces. It defines what the
> contract IS, what it explicitly is NOT, and which boundaries
> future engine work must continue to honour.

---

## 1. Purpose

The **Operational Preview** is a diagnostic pipeline that lets
operators rehearse the future production-shaped invoice processing
flow before any export engine exists.

It composes:

* the existing dry-run import-template resolver,
* the Phase 2A invoice-pattern → resolver bridge,
* operational metadata (document/batch/template ids and labels),
* the resolver result + review diagnostics,
* an export-style rows preview,
* an export profile check (local + backend-verified),
* a parity audit (local vs backend),
* an explicit export readiness boundary (local + backend-verified),
* a consolidated full report,

and surfaces them in one panel that the operator can launch from
the Import Builder, the Invoice Template Health Map, the Review
Queue document context, or a Batch Detail.

**It is a rehearsal surface — not an export surface.**

---

## 2. Non-goals / hard boundaries

The Operational Preview pipeline must NEVER, in any phase up to and
including 3O:

* Run OCR or AI extraction.
* Parse PDFs.
* Generate CSV, XLSX, PDF, or any other file artefact.
* Trigger a download.
* Persist export records, export batches, export runs, or export
  audit rows.
* Persist Review Queue records.
* Mutate document, batch, template, or reference-data status.
* Post anything to ResMan, Yardi, AppFolio, or any other external
  system.
* Run background processing.
* Claim production export readiness through any field, any UI
  string, or any report copy.

If a future phase needs any of these, it MUST land behind explicit
export-engine work — see §7 / §8.

---

## 3. Backend contracts

Three diagnostic-only endpoints back the Operational Preview
surfaces. All three are read-only with respect to persisted state
and all three carry the `diagnostic_only` flag in their response.

### 3.1 `POST /api/v1/operational-resolution/run` (Phase 3A)

* Accepts a small request body — `template_id` is the only required
  field; `pattern_id`, `document_id`, `batch_id`, extracted facts,
  catalog hints, document metadata, runtime options are all
  optional.
* `diagnostic_only` is hard-True in the response (Pydantic default).
* Returns `resolver_input` + `resolver_result` + `operational_summary`
  + `review_diagnostics`.
* Read-only: no `flush`, `commit`, or `refresh` against any record.
* No OCR / AI / PDF parsing.
* No export, no Review Queue records, no document/batch mutation.

### 3.2 `POST /api/v1/export-profiles/validate-preview` (Phase 3I)

* Accepts a caller-supplied `profile` + `preview` payload + optional
  `context`.
* `diagnostic_only=true` in the response regardless of what the
  caller sends on the request.
* Returns deterministic `status` (`clear` | `needs_review` |
  `blocked` | `conflict`) + `summary` + `issues[]` +
  `column_results[]` + `row_results[]`.
* No DB lookup — the profile is supplied in-line. No persistence,
  no export records, no file generation.
* See `backend/app/services/export_profile_validation.py` for the
  exhaustive validation rules. 0 and `false` are NEVER treated as
  missing values.

### 3.3 `POST /api/v1/export-readiness-boundary/evaluate` (Phase 3M)

* Accepts a small diagnostic-state snapshot
  (`ExportReadinessBoundaryInput`) — every field is optional.
* `diagnostic_only` is `Literal[True]` in the response — Pydantic
  refuses to construct anything else.
* `production_export_ready` is `Literal[False]` — Pydantic refuses
  to construct anything else.
* `production_export_status` is hard-coded to `"unavailable"`. The
  Pydantic Literal type does NOT include `"ready"` so the contract
  cannot return it by mistake.
* Returns the diagnostic status + reasons + operator/developer
  messaging + next steps + disclaimers. Frozen wording — see the
  Phase 3M spec.

---

## 4. Frontend diagnostic surfaces

All surfaces live inside `OperationalResolutionPreviewPanel` and
its sub-components:

| Surface | Phase | What it does |
| --- | --- | --- |
| Operational Summary | 3B | Coarse status + counts for the whole run |
| Copy full report | 3G | Markdown blob covering every section |
| Review Diagnostics | 3D | Operator-friendly grouped exception cards |
| Export-style Rows Preview | 3E | Diagnostic table mimicking future export rows |
| Export Profile Check | 3F | Validates preview against built-in profiles |
| Backend validation source banner | 3J | Backend verified vs local estimate |
| Validation Source Audit | 3K | Local-vs-backend parity diff (collapsed) |
| Export Readiness Boundary | 3L | Explicit gap to a future production engine |
| Backend boundary source banner | 3N | Backend boundary verified vs local fallback |

All surfaces are diagnostic only, all carry plain "no export file
generated" copy, and none of them are gated behind any user role
that resembles "approver" or "exporter".

The launchers — Import Builder toolbar, Health Map, Review Queue
document context, Batch Detail — produce the same panel and obey
the same contract. The launch context is metadata only; none of it
mutates the document / batch / template behind the scenes.

---

## 5. Source of truth / fallback model

When the backend is reachable, the backend response is the active
verdict surfaced in the UI and the Markdown reports.

The local helpers (Phase 3F validator, Phase 3L boundary) remain in
the codebase and are used as fallbacks ONLY in three cases:

1. **Loading** — backend request in flight, no prior data yet.
2. **Failure** — backend returned an error; UI shows the local
   estimate plus a Retry control.
3. **Unavailable** — disabled / no result yet to evaluate.

The four-value `validationSource` and `boundarySource` enums
(`backend` | `loading` | `local` | `unavailable`) drive both:

* The small banners in the panel.
* The `Validation source:` and `Boundary source:` markers embedded
  in the Markdown reports so a paste-into-Slack workflow makes
  provenance visible.

When backend and local disagree, the **backend remains truth**. The
parity audit (Phase 3K) surfaces drift in a secondary, collapsed
section but never overrides the displayed verdict.

---

## 6. Export readiness boundary

Even when every diagnostic check is green, the contract is:

* `production_export_ready === false` — always.
* `production_export_status === "unavailable"` — always (the type
  doesn't include `"ready"`).
* `diagnostic_only === true` — always.

Specifically:

* **diagnostic_clear ≠ production_export_ready.** A clear
  diagnostic means "the resolver didn't block this preview"; it
  does not authorise an export.
* **backend_profile_clear ≠ production_export_ready.** The backend
  profile validator confirms the preview shape against a profile
  contract; that is not the same thing as creating an export.
* **operational_preview_passed ≠ safe_to_post_or_export.** The
  preview never posts anywhere.
* **backend_boundary_verified ≠ production export enabled.** The
  Phase 3M endpoint exists precisely to confirm production export
  is intentionally unavailable. A "Backend boundary verified" pill
  is the contract working — not a green light.

The boundary panel + reports always surface the explicit reasons
(`no_export_engine`, `no_export_profile_persistence`,
`no_export_batch_model`, `no_file_generation`,
`no_final_approval_workflow`, `no_export_audit_trail`,
`no_external_posting`, `diagnostic_only_pipeline`) so future
phases must remove a reason from this list before claiming the
corresponding capability.

---

## 7. Future phases ALLOWED

The following work is acceptable in future phases and was
explicitly scoped out of Phases 3A–3O:

1. **Persisted export profiles** — a profile catalog model
   (`ExportProfileRecord`?) plus CRUD endpoints. Drops
   `no_export_profile_persistence` from the boundary reasons when
   `has_persisted_profile=true`.
2. **Export run / audit model** — DB-backed export runs with a full
   audit trail. Drops `no_export_audit_trail` and
   `no_export_batch_model`.
3. **Final approval workflow** — explicit operator approval state
   machine before any external action. Drops
   `no_final_approval_workflow`.
4. **Controlled file generation** — CSV / XLSX / PDF generation
   gated on approved export runs only. Drops `no_file_generation`.
5. **External posting** — ResMan / Yardi / AppFolio adapters BEHIND
   the audit + file controls above. Drops `no_external_posting`.

When all eight reasons are dropped, a future phase can introduce a
NEW production status type that includes `"ready"` and graduate
the boundary contract. **Until then, none of these may exist.**

---

## 8. Future phases FORBIDDEN until explicit export phase

The following are forbidden today AND will remain forbidden as
"silent" behaviour even after the export engine exists:

* **Silent autosave / autoexport.** Any export must be triggered by
  an explicit operator action recorded in the audit trail.
* **Marking documents / batches / templates as exported from a
  preview.** The preview never owns export status.
* **Creating export records as a side effect of a preview /
  validation / boundary call.** All three current endpoints are
  read-only; a future phase may add separate "create export run"
  endpoints, but the diagnostic endpoints must stay pure.
* **Calling external systems from a preview / validation / boundary
  call.** External adapters may exist behind future export-engine
  endpoints, but never the diagnostic ones.
* **Returning fields like `download_url`, `file_id`, `export_id`,
  `export_batch_id`, `export_run_id`, `posted_at`, or
  `external_posting_id` from the operational-resolution,
  export-profile validate-preview, export-readiness-boundary, or
  export-run-drafts/evaluate endpoints.** Phase 3O's regression
  tests assert this for the first three; Phase 4I extends the
  audit to the draft evaluator endpoint — see
  `backend/tests/test_api/test_operational_preview_contract.py`
  and `backend/tests/test_api/test_export_run_draft_contract.py`.
  The Export Run Draft surface has its own contract document at
  [`export-run-draft-contract.md`](./export-run-draft-contract.md).
* **Persistence note (Phase 5A / 5E / 6A).** Export Run Draft
  persistence exists ONLY through the explicit endpoint family
  `/api/v1/export-runs/` introduced in Phase 5A. The persistence
  endpoint exposes a draft / audit record id under the field
  name `id` (NOT `export_run_id`). The diagnostic evaluator
  endpoint above stays stateless and remains forbidden from
  returning any `export_run_id` flavour. The canonical
  persistence contract — closed Literal vocabularies for
  `status` / `phase` / `source` / `approval_status`, the
  forbidden-key set, the notes-only PATCH boundary, the Phase 6A
  approval workflow, and the Phase 5E + 6A regression suites —
  lives at
  [`export-run-persistence-contract.md`](./export-run-persistence-contract.md).
  The
  [`export-run-draft-contract.md`](./export-run-draft-contract.md)
  doc covers the stateless evaluator side. Export run approval is
  audit / workflow metadata only until a future controlled
  file-generation phase exists.

If a future task ever asks for any of the above on the diagnostic
surfaces, push back and clarify before implementing.

---

## Reference

* Backend schemas: `backend/app/schemas/operational_resolution.py`,
  `backend/app/schemas/export_profile.py`,
  `backend/app/schemas/export_readiness_boundary.py`.
* Backend services: `backend/app/services/operational_resolution.py`,
  `backend/app/services/export_profile_validation.py`,
  `backend/app/services/export_readiness_boundary.py`.
* Backend routes: `backend/app/api/v1/operational_resolution.py`,
  `backend/app/api/v1/export_profiles.py`,
  `backend/app/api/v1/export_readiness_boundary.py`.
* Frontend panel:
  `frontend/src/features/invoice-templates/components/OperationalResolutionPreviewPanel.tsx`.
* Frontend boundary helpers:
  `frontend/src/features/invoice-templates/lib/export-readiness-boundary.ts`,
  `frontend/src/features/invoice-templates/lib/export-readiness-boundary-backend-adapter.ts`.
* Phase 3O regression tests:
  `backend/tests/test_api/test_operational_preview_contract.py`.
