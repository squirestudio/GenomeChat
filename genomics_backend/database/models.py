from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, ForeignKey, JSON, Float, Boolean
from sqlalchemy.orm import DeclarativeBase, relationship, sessionmaker
import os
from datetime import datetime
from config import get_settings


class Base(DeclarativeBase):
    pass


settings = get_settings()
# lock_timeout bounds how long a statement will wait for a lock it cannot get.
# Startup runs ALTER TABLE migrations, and during a rolling deploy the previous
# container still holds connections to these tables — without a timeout the new
# container waits forever, never becomes healthy, and the platform rolls it
# back, so every later deploy fails the same way. Failing fast is correct: the
# migrations are idempotent and will apply on the next start.
engine = create_engine(
    settings.get_database_url(),
    pool_pre_ping=True,
    connect_args={"options": "-c lock_timeout=5000"},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    name = Column(String(255))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    # ── Entitlements ──────────────────────────────────────────────────────────
    # Two separate products, deliberately not one flag:
    #   byok_unlocked   — the Unlimited subscription is currently active. Named
    #                     for the one-time "unlock" it used to be; kept rather
    #                     than renamed because a live column rename is a data
    #                     migration for cosmetic gain. Granted and REVOKED by
    #                     subscription lifecycle events.
    #   byok_purchased  — the one-time right to store your own Anthropic key.
    #                     Permanent; a lapsed subscription does not remove it.
    byok_unlocked = Column(Boolean, default=False)
    query_credits = Column(Integer, default=0)        # purchased query credits remaining
    total_queries = Column(Integer, default=0)        # lifetime query count
    # Encrypted Anthropic API key (Fernet AES-256); never returned to frontend
    byok_purchased = Column(Boolean, default=False)
    # Needed to open Stripe's customer portal, which is how a subscriber
    # cancels or updates their card without contacting us.
    stripe_customer_id = Column(String(255), nullable=True, index=True)
    encrypted_api_key = Column(Text, nullable=True)
    # When this account last accepted the genetic-data consent notice.
    #
    # Genetic data is special category under GDPR Article 9, processed here on
    # explicit consent, and a controller must be able to *demonstrate* that
    # consent was given. The consent screen already gated the upload, but
    # nothing recorded it, so there was no evidence — only a claim.
    #
    # Deliberately a bare timestamp: no variants, no file, no content. It
    # records that consent happened, which is the whole obligation, and nothing
    # about what the person then looked at. Nothing is recorded for signed-out
    # visitors, who have no account to attach it to.
    dna_consent_at = Column(DateTime, nullable=True)

    projects = relationship("Project", back_populates="user", cascade="all, delete-orphan")
    audit_logs = relationship("AuditLog", back_populates="user")


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="projects")
    # **No delete-orphan, deliberately.** This carried `cascade="all,
    # delete-orphan"`, so deleting a project destroyed every query filed in it —
    # tolerable while nothing could be filed after the fact, and a real
    # data-loss risk the moment queries became movable. SQLAlchemy's default on
    # parent delete is to null the child's FK, which is what we want: the
    # queries survive and reappear under "All queries".
    #
    # Account deletion is unaffected. It removes the user's queries explicitly
    # before it touches projects, so nothing depended on this cascade.
    queries = relationship("Query", back_populates="project")


class Query(Base):
    __tablename__ = "queries"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    query_text = Column(Text, nullable=False)
    query_type = Column(String(50))
    target = Column(String(255))
    results = Column(JSON)
    result_count = Column(Integer, default=0)
    sources = Column(JSON, default=list)
    execution_time_ms = Column(Float)
    cached = Column(Integer, default=0)
    share_token = Column(String(64), unique=True, nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    project = relationship("Project", back_populates="queries")


class ProcessedStripeEvent(Base):
    """Ledger of Stripe event ids already applied.

    Stripe guarantees at-least-once delivery, not exactly-once: it retries
    failed deliveries for up to 3 days, and events can be resent by hand. The
    entitlement grants are additive (query_credits += N), so replaying one
    event would hand out the credits again for a single payment. The primary
    key makes a second apply impossible.
    """
    __tablename__ = "processed_stripe_events"

    event_id = Column(String(255), primary_key=True)
    event_type = Column(String(100))
    processed_at = Column(DateTime, default=datetime.utcnow)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    action = Column(String(100), nullable=False)
    resource_type = Column(String(50))
    resource_id = Column(Integer)
    details = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="audit_logs")


# Stored answers are kept so chat history can replay without re-fetching. The
# JSON payload grows with every source added, so this caps how far back that
# convenience reaches. Rows older than this lose only their cached payload —
# the question, target and sources stay, so history still lists them.
QUERY_PAYLOAD_RETENTION_DAYS = int(os.environ.get("QUERY_PAYLOAD_RETENTION_DAYS", "90"))


def prune_old_query_payloads() -> int:
    """Drop the stored results of answers older than the retention window.

    Deliberately not deleting the rows: a user's history is theirs, and the
    lightweight columns cost almost nothing. It is the replay payload that
    grows, and it is the least valuable part once an answer is months old and
    the underlying databases have moved on anyway.
    """
    import logging as _logging
    import sqlalchemy as _sa
    log = _logging.getLogger(__name__)
    try:
        with engine.connect() as conn:
            conn.execute(_sa.text("SET lock_timeout = '5s'"))
            result = conn.execute(_sa.text(
                "UPDATE queries SET results = NULL "
                "WHERE results IS NOT NULL "
                f"AND created_at < now() - interval '{QUERY_PAYLOAD_RETENTION_DAYS} days'"
            ))
            conn.commit()
            if result.rowcount:
                log.info("Pruned stored payloads from %s queries older than %s days",
                         result.rowcount, QUERY_PAYLOAD_RETENTION_DAYS)
            return result.rowcount or 0
    except Exception as e:
        log.warning("Payload pruning skipped (%s)", e)
        return 0


def create_tables():
    Base.metadata.create_all(bind=engine)
    # Run additive column migrations that create_all won't apply to existing tables
    _run_migrations()


def create_tables_safe() -> None:
    """Schema init that can never stall startup.

    Every statement is bounded by lock_timeout, and any failure is logged
    rather than raised: the migrations are idempotent, the tables already
    exist in any deployed environment, and refusing to serve traffic because
    a lock was busy is worse than trying again next boot.
    """
    import logging as _logging
    log = _logging.getLogger(__name__)
    try:
        create_tables()
        log.info("Database tables created/verified.")
    except Exception as e:
        log.warning(f"Schema init skipped ({type(e).__name__}: {e}) — retrying on next start")


def _run_migrations():
    """Apply ALTER TABLE migrations that are safe to run repeatedly (IF NOT EXISTS)."""
    migrations = [
        "ALTER TABLE queries ADD COLUMN IF NOT EXISTS share_token VARCHAR(64) UNIQUE",
        "ALTER TABLE queries ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS byok_unlocked BOOLEAN DEFAULT FALSE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS query_credits INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS total_queries INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS encrypted_api_key TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS byok_purchased BOOLEAN DEFAULT FALSE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS dna_consent_at TIMESTAMP",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255)",
        # Columns added by ALTER TABLE do not get the index the model declares,
        # so these were never created and every history load and ownership check
        # was a sequential scan. The composite matches how the rows are actually
        # read: filtered by owner, newest first.
        "CREATE INDEX IF NOT EXISTS ix_queries_user_created ON queries (user_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS ix_projects_user_id ON projects (user_id)",
        # Anyone who already stored a key did so when it was free — keep them.
        "UPDATE users SET byok_purchased = TRUE WHERE encrypted_api_key IS NOT NULL AND byok_purchased IS NOT TRUE",
    ]
    import sqlalchemy as _sa
    with engine.connect() as conn:
        # Belt and braces — also bound each individual statement.
        try:
            conn.execute(_sa.text("SET lock_timeout = '5s'"))
            conn.commit()
        except Exception:
            pass
        for sql in migrations:
            try:
                conn.execute(_sa.text(sql))
                conn.commit()
            except Exception as e:
                # Column may already exist or DB may not support IF NOT EXISTS — skip
                import logging
                logging.getLogger(__name__).debug(f"Migration skipped: {e}")
