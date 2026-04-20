from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_ENV: Literal["development", "staging", "production"] = "development"

    # Auth
    SECRET_KEY: str = "insecure-dev-key-replace-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 480

    # Database
    DATABASE_URL: str = "postgresql+asyncpg://bills_user:bills_pass@localhost:5432/bills_db"
    DATABASE_SYNC_URL: str = "postgresql://bills_user:bills_pass@localhost:5432/bills_db"

    # Redis / Celery
    REDIS_URL: str = "redis://localhost:6379/0"
    CELERY_BROKER_URL: str = "redis://localhost:6379/0"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/1"

    # Storage
    STORAGE_BACKEND: Literal["local", "s3"] = "local"
    LOCAL_STORAGE_PATH: str = "./storage/uploads"

    S3_ENDPOINT_URL: str | None = None
    S3_ACCESS_KEY_ID: str | None = None
    S3_SECRET_ACCESS_KEY: str | None = None
    S3_BUCKET_NAME: str = "bills"
    S3_REGION: str = "us-east-1"

    # Extraction
    EXTRACTION_BACKEND: str = "native_pdf"
    # Phase 1: extraction runs synchronously inside the upload request.
    # Set to True once Celery infrastructure is operational.
    EXTRACTION_USE_CELERY: bool = False

    # Upload limits
    MAX_FILE_SIZE_MB: int = 25
    ALLOWED_MIME_TYPES: list[str] = [
        "application/pdf",
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/tiff",
        "image/webp",
    ]

    # Logging
    LOG_LEVEL: str = "INFO"

    @property
    def is_production(self) -> bool:
        return self.APP_ENV == "production"

    @property
    def max_file_size_bytes(self) -> int:
        return self.MAX_FILE_SIZE_MB * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
