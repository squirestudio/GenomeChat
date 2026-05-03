from pydantic_settings import BaseSettings
from functools import lru_cache
import os


class Settings(BaseSettings):
    anthropic_api_key: str = ""
    database_url: str = "postgresql://genomechat:genomechat@localhost:5432/genomechat"
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:3333", "http://localhost:5173", "http://localhost:5174", "https://genomechat.vercel.app", "*"]
    cache_ttl_hours: int = 24
    cache_max_size: int = 1000
    request_timeout: int = 30
    max_retries: int = 3
    log_level: str = "INFO"
    # Google OAuth
    google_client_id: str = ""
    google_client_secret: str = ""
    jwt_secret: str = "change-this-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_hours: int = 168  # 7 days
    frontend_url: str = "http://localhost:3333"
    # Explicit backend URL — avoids Railway proxy stripping https from request.base_url
    # Set BACKEND_URL=https://your-service.railway.app in Railway env vars
    backend_url: str = ""
    # Stripe billing
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_unlock: str = ""   # $5 one-time unlimited unlock Price ID
    stripe_price_credits: str = ""  # $3 fifty-query credits pack Price ID
    # AES-256 encryption key for stored user API keys (Fernet — generate with Fernet.generate_key())
    encryption_key: str = ""

    def get_database_url(self) -> str:
        # Railway provides DATABASE_URL as postgres:// but SQLAlchemy needs postgresql://
        url = self.database_url
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql://", 1)
        return url

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
