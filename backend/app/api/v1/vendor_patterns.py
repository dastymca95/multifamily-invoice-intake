import uuid

from fastapi import APIRouter, HTTPException

from app.dependencies import DB, CurrentUser
from app.repositories.vendor_pattern_repo import VendorPatternRepository
from app.schemas.vendor_pattern import VendorPatternOut, VendorPatternUpdate

router = APIRouter(prefix="/vendor-patterns", tags=["vendor-patterns"])


@router.get("", response_model=list[VendorPatternOut])
async def list_vendor_patterns(
    db: DB, user: CurrentUser, q: str | None = None, limit: int = 50
) -> list[VendorPatternOut]:
    repo = VendorPatternRepository(db)
    if q:
        patterns = await repo.search(q, limit=limit)
    else:
        patterns = await repo.list(limit=limit)
    return [VendorPatternOut.model_validate(p) for p in patterns]


@router.get("/{pattern_id}", response_model=VendorPatternOut)
async def get_vendor_pattern(pattern_id: uuid.UUID, db: DB, user: CurrentUser) -> VendorPatternOut:
    repo = VendorPatternRepository(db)
    pattern = await repo.get(pattern_id)
    if pattern is None:
        raise HTTPException(status_code=404, detail="Vendor pattern not found")
    return VendorPatternOut.model_validate(pattern)


@router.patch("/{pattern_id}", response_model=VendorPatternOut)
async def update_vendor_pattern(
    pattern_id: uuid.UUID, body: VendorPatternUpdate, db: DB, user: CurrentUser
) -> VendorPatternOut:
    repo = VendorPatternRepository(db)
    pattern = await repo.get_or_raise(pattern_id)
    pattern.field_hints = {**pattern.field_hints, **body.field_hints}
    pattern = await repo.save(pattern)
    return VendorPatternOut.model_validate(pattern)


@router.delete("/{pattern_id}", status_code=204)
async def delete_vendor_pattern(pattern_id: uuid.UUID, db: DB, user: CurrentUser) -> None:
    repo = VendorPatternRepository(db)
    pattern = await repo.get_or_raise(pattern_id)
    await repo.delete(pattern)
