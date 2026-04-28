from fastapi import APIRouter

from app.api.v1 import (
    auth,
    batches,
    documents,
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
