"""
Shared test fixtures.

Tests run against a Postgres test database (matches dev/prod backends and
exercises JSONB / NUMERIC / UUID semantics). Spin one up locally with:

    createdb bills_test

Override TEST_DATABASE_URL via the environment to point elsewhere.

Test uploads use image MIME bytes so they route to scanned_or_image and the
OCR stub adapter, which returns deterministic empty data without needing a
real PDF parser. The native_pdf path is exercised by routing tests separately.
"""

import os

import pytest
from httpx import ASGITransport, AsyncClient
from jose import jwt
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.database import get_db
from app.main import app
from app.models import Base

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://bills_user:bills_pass@localhost:5432/bills_test",
)

_test_engine = create_async_engine(TEST_DATABASE_URL, echo=False)
_TestSession = async_sessionmaker(_test_engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture(scope="session", autouse=True)
async def setup_test_db(tmp_path_factory):
    tmp_storage = tmp_path_factory.mktemp("storage")
    settings.LOCAL_STORAGE_PATH = str(tmp_storage)

    async with _test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with _test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest.fixture
async def db_session():
    async with _TestSession() as session:
        yield session
        await session.rollback()


@pytest.fixture
async def client(db_session: AsyncSession):
    async def override_get_db():
        yield db_session
        await db_session.commit()

    app.dependency_overrides[get_db] = override_get_db

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.fixture
def user_id() -> str:
    return "00000000-0000-0000-0000-000000000001"


@pytest.fixture
def auth_headers(user_id: str) -> dict[str, str]:
    token = jwt.encode(
        {"sub": user_id, "email": "test@bills.local"},
        settings.SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def image_bytes() -> bytes:
    """A short opaque image payload — enough to route as scanned_or_image."""
    return b"\x89PNG\r\n\x1a\n" + b"fake-png-data-for-tests"
