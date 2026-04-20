from sqlalchemy import Float, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey


class VendorPattern(Base, UUIDPrimaryKey, TimestampMixin):
    """
    Learned extraction hints for a specific vendor.

    After a reviewer corrects extracted fields, the workflow layer derives
    patterns (field X is always in region Y, account_number follows regex Z)
    and stores them here. Future extractions for the same vendor load these
    patterns to improve first-pass accuracy.
    """

    __tablename__ = "vendor_patterns"
    __table_args__ = (UniqueConstraint("vendor_name_normalized", name="uq_vendor_pattern_name"),)

    vendor_name_normalized: Mapped[str] = mapped_column(String(512), nullable=False, index=True)
    vendor_name_display: Mapped[str] = mapped_column(String(512), nullable=False)

    # Arbitrary key/value hints consumed by extraction adapters.
    # Structure is adapter-specific; kept as JSONB for flexibility.
    field_hints: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    # Confidence weight: higher = more corrections reinforced this pattern
    confidence_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    sample_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    def __repr__(self) -> str:
        return f"<VendorPattern vendor={self.vendor_name_normalized!r} score={self.confidence_score:.2f}>"
