from pydantic_settings import BaseSettings
from functools import lru_cache
import logging
import secrets

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    anthropic_api_key: str = ""
    # Free from an NCBI account, and it moves the E-utilities cap from 3 to 10
    # requests/sec. Declared here even though `genomics_api_real` reads it from
    # os.environ directly: Settings forbids extras, and pydantic pulls only
    # *declared* fields from OS env vars but loads **every** key out of a .env
    # file — so an undeclared variable is invisible in production and crashes
    # the app on boot the moment someone adds it locally.
    ncbi_api_key: str = ""

    # Declared for the same reason, and found by the test that followed from it:
    # both are read via os.environ elsewhere, both are documented as real
    # settings, and both would have taken the app down the first time anyone
    # wrote them into a .env rather than the platform's variable panel.
    redis_url: str = ""
    query_payload_retention_days: int = 90
    database_url: str = "postgresql://genomechat:genomechat@localhost:5432/genomechat"
    # No "*" here: the CORS middleware runs with allow_credentials=True, and a
    # wildcard in that mode makes Starlette echo back whatever Origin it is
    # given. Add real deploy origins via the CORS_ORIGINS env var.
    #
    # Every browser-facing origin must be listed explicitly, including both the
    # apex and www forms of a custom domain — a visitor on the wrong one gets a
    # site that loads but whose every API call is blocked by CORS. The old
    # vercel.app origin stays so existing links keep working.
    cors_origins: list[str] = [
        "http://localhost:3000", "http://localhost:3333",
        "http://localhost:5173", "http://localhost:5174",
        "https://genomechat.vercel.app",
        "https://mydna.chat", "https://www.mydna.chat",
    ]
    # Anonymous callers get this many questions before signing in. The browser
    # shows the prompt at the same number; this is the copy that enforces it.
    anon_query_limit: int = 3
    # Per-IP request ceilings. The expensive figure covers anything that reaches
    # an upstream API or a model; the default covers everything else.
    rate_limit_expensive_per_min: int = 20
    rate_limit_default_per_min: int = 120

    cache_ttl_hours: int = 24
    cache_max_size: int = 1000
    request_timeout: int = 30
    max_retries: int = 3
    log_level: str = "INFO"
    # Google OAuth
    google_client_id: str = ""
    google_client_secret: str = ""
    # Empty means "unset"; get_settings() substitutes a random per-process
    # secret. There is deliberately no fixed placeholder default — a shipped
    # constant is a publicly known signing key, and anyone holding it can mint
    # a token for any user_id. Sessions that don't survive a restart are a far
    # better failure mode than silent impersonation.
    jwt_secret: str = ""
    jwt_algorithm: str = "HS256"
    jwt_expire_hours: int = 168  # 7 days
    frontend_url: str = "http://localhost:3333"
    # Explicit backend URL — avoids Railway proxy stripping https from request.base_url
    # Set BACKEND_URL=https://your-service.railway.app in Railway env vars
    backend_url: str = ""
    # Stripe billing
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_unlock: str = ""   # unlimited access, currently $10/month recurring
    stripe_price_credits: str = ""  # query credit pack, currently $5 for CREDITS_PER_PACK
    stripe_price_byok: str = ""     # one-time "bring your own key" Price ID

    # ── Test-mode allowlist ───────────────────────────────────────────────────
    # Lets specific accounts run test-mode checkout against the *production*
    # deployment, so billing can be exercised end to end with 4242 cards without
    # a separate environment and without affecting anyone else. Every other user
    # continues to get live keys. Empty list = nobody, which is the safe default.
    stripe_test_emails: str = ""            # comma-separated
    stripe_test_secret_key: str = ""
    stripe_test_webhook_secret: str = ""
    stripe_test_price_unlock: str = ""
    stripe_test_price_credits: str = ""
    stripe_test_price_byok: str = ""

    # Accounts that bypass the query quota entirely — your own team, without
    # buying credits or storing a key. Deliberately separate from
    # stripe_test_emails: an account that never hits the paywall can never
    # exercise the purchase flow, so the two lists must be independently
    # toggleable. Empty = nobody.
    unlimited_emails: str = ""              # comma-separated

    def test_mode_emails(self) -> set[str]:
        return {e.strip().lower() for e in self.stripe_test_emails.split(",") if e.strip()}

    def unlimited_access_emails(self) -> set[str]:
        return {e.strip().lower() for e in self.unlimited_emails.split(",") if e.strip()}

    def test_mode_configured(self) -> bool:
        return bool(
            self.stripe_test_secret_key
            and self.stripe_test_price_unlock
            and self.stripe_test_price_credits
        )
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
    settings = Settings()
    # Checked on the loaded value, not os.environ — pydantic-settings also
    # reads .env, and looking only at the environment reports a false alarm
    # whenever the secret is supplied through the file.
    if not settings.jwt_secret:
        settings.jwt_secret = secrets.token_urlsafe(64)
        logger.warning(
            "JWT_SECRET is not set — using a random per-process secret. Sessions "
            "will be invalidated on every restart and will not work across "
            "multiple instances. Set JWT_SECRET in your deployment environment."
        )
    return settings
