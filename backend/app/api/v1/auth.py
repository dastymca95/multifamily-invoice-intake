"""
Auth routes — scaffold with static credentials for development.

Replace with a real user store (hashed passwords in DB) before shipping.
The JWT structure is stable; only the credential lookup needs to change.
"""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from jose import jwt

from app.config import settings
from app.schemas.auth import LoginRequest, RegisterRequest, TokenResponse

router = APIRouter(prefix="/auth", tags=["auth"])

# DEV ONLY — replace with DB lookup in production
_DEV_USERS: dict[str, dict] = {
    "admin@bills.local": {
        "id": "00000000-0000-0000-0000-000000000001",
        "password": "devpassword",
        "full_name": "Dev Admin",
    }
}


def _create_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "iat": datetime.now(UTC),
        "exp": datetime.now(UTC) + timedelta(minutes=settings.JWT_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest) -> TokenResponse:
    user = _DEV_USERS.get(body.email)
    if user is None or user["password"] != body.password:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    token = _create_token(user["id"], body.email)
    return TokenResponse(
        access_token=token,
        expires_in=settings.JWT_EXPIRE_MINUTES * 60,
    )


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterRequest) -> TokenResponse:
    # STUB: In production, hash the password and insert into users table.
    # For now, echo back a token for the provided email.
    user_id = str(uuid.uuid4())
    token = _create_token(user_id, body.email)
    return TokenResponse(
        access_token=token,
        expires_in=settings.JWT_EXPIRE_MINUTES * 60,
    )
