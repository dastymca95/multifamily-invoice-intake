from fastapi import APIRouter

from app.api.v1 import (
    auth,
    batches,
    documents,
    export_profiles,
    export_readiness_boundary,
    export_run_drafts,
    export_runs,
    exports,
    gl_catalogs,
    import_configs,
    invoice_patterns,
    invoice_templates,
    operational_resolution,
    property_catalogs,
    reference_data,
    review,
    vendor_catalogs,
    vendor_patterns,
)

api_router = APIRouter()

api_router.include_router(auth.router)
api_router.include_router(batches.router)
api_router.include_router(documents.router)
api_router.include_router(review.router)
api_router.include_router(exports.router)
api_router.include_router(vendor_patterns.router)
api_router.include_router(reference_data.router)
api_router.include_router(import_configs.router)
api_router.include_router(invoice_templates.router)
api_router.include_router(invoice_patterns.router)
api_router.include_router(gl_catalogs.router)
api_router.include_router(property_catalogs.router)
api_router.include_router(vendor_catalogs.router)
# Phase 3A — Operational Resolution Pipeline. Diagnostic-only
# composer over the existing dry-run resolver + Phase 2A bridge.
api_router.include_router(operational_resolution.router)
# Phase 3I — Export Profile validation. Diagnostic-only validator
# that checks an export-style preview against an export profile;
# no file generation, no profile persistence, no export records.
api_router.include_router(export_profiles.router)
# Phase 3M — Export Readiness Boundary. Diagnostic-only contract
# that explicitly says "production_export_ready=false" regardless
# of input — no engine, no file, no records, no posting.
api_router.include_router(export_readiness_boundary.router)
# Phase 4F — Export Run Draft. Diagnostic-only contract that
# evaluates "what would an export run look like" without any
# persistence, file generation, finalisation, or external posting.
# Hard-pinned ``draft_only=True`` / ``finalized=False`` /
# ``file_generated=False`` / ``download_available=False`` /
# ``production_export_ready=False`` regardless of input.
api_router.include_router(export_run_drafts.router)
# Phase 5A — Export Run Draft persistence. Sibling to the Phase 4F
# stateless evaluator above. Persists a draft / audit row and
# exposes ``id`` (NOT ``export_run_id``). Phase 3O / 4I forbid the
# evaluator endpoint above from returning any flavour of
# ``export_run_id``; this endpoint family carries the persisted
# id. Hard pins on the embedded draft snapshot are preserved by
# the management service (re-evaluates the verdict locally on
# every write). Phase=draft always; no finalised export, no file
# generation, no document/batch/template mutation, no external
# posting.
api_router.include_router(export_runs.router)
