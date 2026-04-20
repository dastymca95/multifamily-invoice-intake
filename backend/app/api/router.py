from fastapi import APIRouter

from app.api.v1 import auth, batches, documents, exports, review, vendor_patterns

api_router = APIRouter()

api_router.include_router(auth.router)
api_router.include_router(batches.router)
api_router.include_router(documents.router)
api_router.include_router(review.router)
api_router.include_router(exports.router)
api_router.include_router(vendor_patterns.router)
