from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    anthropic_api_key: str = ""
    database_url: str = "postgresql://genomechat:genomechat@localhost:5432/genomechat"
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:5173", "*"]
    cache_ttl_hours: int = 24
    cache_max_size: int = 1000
    request_timeout: int = 30
    max_retries: int = 3
    log_level: str = "INFO"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
