import asyncio
import json
import stripe
import time
import logging
from contextlib import asynccontextmanager
from typing import Optional, Any
from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from config import get_settings
from models import QueryRequest, QueryResponse, BatchQueryRequest, HealthResponse, QueryType
from services.query_interpreter import interpret_query
from services.genomics_api_real import run_gene_pipeline, run_disease_pipeline, fetch_gene_section, fetch_dbsnp_annotations, fetch_vep_predictions, fetch_pubmed_titles, section_has_data, section_cache_key, EMPTY_SECTION_TTL_HOURS
from services.ai_explainer import explain_results, explain_comparison, answer_followup, stream_explanation, stream_followup, transcribe_pages
from services.cache import cache
from services.limits import AnonymousAllowance, SharedWindow, SlidingWindow, client_ip, shared_backend_active
from database.models import create_tables_safe, prune_old_query_payloads, get_db, SessionLocal, Query as QueryModel, ProcessedStripeEvent, Project, AuditLog
from database.routes import router as projects_router, queries_router
from auth import router as auth_router, get_current_user, require_user
from services.billing import create_checkout_session, create_support_session, SUPPORT_AMOUNTS, verify_webhook, user_can_query, consume_query, is_test_mode_user, is_unlimited_user, get_price_display, create_portal_session, stripe_credentials_for, FREE_QUERY_LIMIT, CREDITS_PER_PACK, SCAN_CREDITS
from services.encryption import encrypt_key, try_decrypt_key, is_configured as encryption_is_configured
from database.models import User
from datetime import datetime

logging.basicConfig(level=logging.INFO)
# The Stripe SDK logs every HTTP request/response at INFO, which buries our own
# startup diagnostics. Warnings and errors from it still come through.
logging.getLogger("stripe").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

settings = get_settings()


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str = Field(max_length=20000)


class ChatRequest(BaseModel):
    # Bounded because every one of these is forwarded into the model prompt, so
    # payload size maps directly onto token spend — and because nothing else
    # stopped a caller sending an arbitrarily large body.
    message: str = Field(min_length=1, max_length=4000)
    history: list[ChatMessage] = Field(default=[], max_length=40)
    project_id: Optional[int] = None
    # [{rsid, genotype, chromosome?}] — session only, never stored. The UI sends
    # at most 200; the ceiling is here so that stays true of every caller.
    personal_variants: Optional[list[dict]] = Field(default=None, max_length=500)
    # [{title, citation?, passages: [str]}] — the reader's own uploaded papers.
    # Held to exactly the same rule as personal_variants: forwarded into the
    # prompt for this one request and never written to the database. That is
    # both the privacy commitment and the copyright position — MyDNA has no
    # licence to hold a publisher's text, and does not need one to help someone
    # read their own lawful copy. Bounded for the same token-spend reason.
    personal_documents: Optional[list[dict]] = Field(default=None, max_length=10)
    response_detail: Optional[str] = "standard"     # concise | standard | detailed (how much)
    # How hard the words are, which is a different axis from how much is said.
    # Defaults to plain: most readers are here about their own health, not to
    # review a paper, and the previous prompt aimed at "a research scientist".
    reading_level: Optional[str] = "plain"          # plain | standard | technical
    staged: bool = True                             # core data first; sections on demand
    user_api_key: Optional[str] = None              # user-supplied Anthropic key; never logged or stored


class ChatResponse(BaseModel):
    content: str
    data: Optional[dict] = None
    query_type: Optional[str] = None
    target: Optional[str] = None
    sources: list[str] = []
    result_count: int = 0
    query_id: Optional[int] = None
    cached: bool = False


def _log_feature_status() -> None:
    """Report which optional features are live, at boot rather than on first use.

    Each of these degrades quietly — a missing key surfaces as a 501 or a
    disabled button that nobody notices until a user hits it. Saying so once at
    startup makes a misconfigured deploy visible in the deploy log.
    """
    from services.encryption import is_configured as _enc_ok
    from services.genomics_api_real import NCBI_API_KEY, _NCBI_RATE

    checks = [
        ("Claude API (shared server key)", bool(settings.anthropic_api_key)),
        ("Google OAuth sign-in", bool(settings.google_client_id and settings.google_client_secret)),
        ("Stripe billing", bool(settings.stripe_secret_key and settings.stripe_webhook_secret)),
        ("Stripe price IDs", bool(settings.stripe_price_unlock and settings.stripe_price_credits)),
        ("Stored user API keys (ENCRYPTION_KEY)", _enc_ok()),
    ]

    # Not a feature toggle — a throughput ceiling. Anonymous NCBI access caps at
    # 3 req/sec, and one gene query issues enough calls for that to dominate
    # response time, so it is worth stating which regime we are in.
    logger.info(
        "Limits: %s",
        "shared via Redis — safe to run more than one instance" if shared_backend_active()
        else "per process — running a second instance would double every allowance "
             "and exceed the NCBI rate cap; set REDIS_URL first",
    )
    logger.info(
        "NCBI E-utilities: %s (%.1f req/sec)",
        "API key configured" if NCBI_API_KEY else "ANONYMOUS — set NCBI_API_KEY to raise the limit",
        _NCBI_RATE,
    )
    enabled = [name for name, ok in checks if ok]
    disabled = [name for name, ok in checks if not ok]

    for name in enabled:
        logger.info("Feature enabled:  %s", name)
    for name in disabled:
        logger.warning("Feature DISABLED: %s — related endpoints will return 501", name)


def _validate_stripe_wiring() -> None:
    """Check the Stripe key, price IDs, and webhook endpoint agree with each other.

    A mismatch here is invisible in normal operation: checkout opens fine, the
    customer pays, the charge lands in whichever account the API key belongs to
    — and if the webhook endpoint was created in a *different* account, no event
    is ever delivered and no entitlement is granted. The money arrives and the
    user gets nothing, with no error anywhere. Verifying at boot turns that into
    a log line. Never raises: Stripe being unreachable must not stop the app.
    """
    if not settings.stripe_secret_key:
        return
    try:
        import stripe
        stripe.api_key = settings.stripe_secret_key

        mode = "TEST" if settings.stripe_secret_key.startswith("sk_test_") else "LIVE"
        account = stripe.Account.retrieve()
        acct_id = account.get("id")
        acct_name = (account.get("business_profile") or {}).get("name") or acct_id
        # Mode is worth stating outright: a deploy silently running test keys
        # takes fake cards, and a dev box on live keys takes real ones.
        logger.info("Stripe account: %s (%s) — %s MODE", acct_name, acct_id, mode)

        for label, price_id in (
            ("STRIPE_PRICE_UNLOCK", settings.stripe_price_unlock),
            ("STRIPE_PRICE_CREDITS", settings.stripe_price_credits),
        ):
            if not price_id:
                continue
            try:
                stripe.Price.retrieve(price_id)
            except Exception as e:
                logger.error(
                    "Stripe: %s (%s) does not exist in account %s — checkout will "
                    "fail for that product. Is it from a different Stripe account?",
                    label, price_id, acct_id,
                )

        if not settings.backend_url:
            logger.warning("Stripe: BACKEND_URL unset — cannot verify the webhook endpoint.")
            return

        expected = settings.backend_url.rstrip("/") + "/billing/webhook"
        endpoints = stripe.WebhookEndpoint.list(limit=100).get("data", [])
        match = next((e for e in endpoints if (e.get("url") or "").rstrip("/") == expected), None)

        # `stripe listen` forwards over its own channel instead of registering an
        # endpoint, so a local URL having no match is the normal dev setup.
        is_local = expected.startswith(("http://localhost", "http://127.0.0.1", "https://localhost"))

        if not match and is_local:
            logger.info(
                "Stripe: no registered endpoint for %s — expected locally. Run: "
                "stripe listen --forward-to localhost:8000/billing/webhook", expected,
            )
        elif not match:
            logger.error(
                "Stripe: account %s has NO webhook endpoint pointing at %s. Payments "
                "will succeed but credits/unlocks will never be granted. Create the "
                "endpoint in THIS account (endpoints in other accounts never fire).",
                acct_id, expected,
            )
        elif "checkout.session.completed" not in (match.get("enabled_events") or []) \
                and "*" not in (match.get("enabled_events") or []):
            logger.error(
                "Stripe: webhook endpoint %s is not subscribed to "
                "checkout.session.completed (subscribed: %s) — entitlements will "
                "never be granted.", expected, match.get("enabled_events"),
            )
        elif match.get("status") != "enabled":
            logger.error("Stripe: webhook endpoint %s is '%s', not enabled.", expected, match.get("status"))
        else:
            logger.info("Stripe webhook endpoint verified: %s", expected)

    except Exception as e:
        logger.warning("Stripe: wiring check skipped (%s)", e)

    # The same check for test mode. It is easy to forget, and forgetting is
    # silent: allowlisted test purchases complete and grant nothing.
    if settings.test_mode_configured() and settings.test_mode_emails():
        try:
            import stripe as _stripe
            _stripe.api_key = settings.stripe_test_secret_key
            expected = (settings.backend_url or "").rstrip("/") + "/billing/webhook"
            if settings.backend_url and not expected.startswith(("http://localhost", "http://127.0.0.1")):
                eps = _stripe.WebhookEndpoint.list(limit=100).get("data", [])
                match = next((e for e in eps if (e.get("url") or "").rstrip("/") == expected), None)
                if not match:
                    logger.error(
                        "Stripe TEST mode has no webhook endpoint at %s — allowlisted "
                        "test purchases will complete and grant nothing.", expected)
                elif "checkout.session.completed" not in (match.get("enabled_events") or []):
                    logger.error("Stripe TEST endpoint is not subscribed to checkout.session.completed.")
                else:
                    logger.info("Stripe TEST webhook endpoint verified: %s", expected)
        except Exception as e:
            logger.warning("Stripe: test-mode wiring check skipped (%s)", e)

    # Subscription revocation only works if these are delivered.
    try:
        import stripe as _s2
        _s2.api_key = settings.stripe_secret_key
        expected = (settings.backend_url or "").rstrip("/") + "/billing/webhook"
        eps = _s2.WebhookEndpoint.list(limit=100).get("data", [])
        match = next((e for e in eps if (e.get("url") or "").rstrip("/") == expected), None)
        if match:
            evts = set(match.get("enabled_events") or [])
            missing = {"customer.subscription.deleted", "customer.subscription.updated"} - evts
            if missing and "*" not in evts:
                logger.error(
                    "Stripe webhook is not subscribed to %s — a cancelled subscriber "
                    "would keep unlimited access.", ", ".join(sorted(missing)))
    except Exception:
        pass

    # Test-mode allowlist — reported explicitly because it means specific
    # accounts get free entitlements on a live deployment, which should never
    # be a surprise.
    unlimited = settings.unlimited_access_emails()
    if unlimited:
        logger.info("Unlimited-access allowlist active for: %s", ", ".join(sorted(unlimited)))

    emails = settings.test_mode_emails()
    if emails and settings.test_mode_configured():
        logger.info("Stripe TEST-MODE allowlist active for: %s", ", ".join(sorted(emails)))
    elif emails:
        logger.warning(
            "STRIPE_TEST_EMAILS is set (%s) but test keys/prices are missing — "
            "those accounts will fall through to LIVE checkout.", ", ".join(sorted(emails)),
        )


async def _startup_diagnostics() -> None:
    """Config reporting and third-party checks, off the readiness path.

    These are diagnostics, not dependencies: _validate_stripe_wiring makes
    several sequential calls to Stripe, and blocking startup on them means a
    slow or unreachable third party keeps /health from answering at all. The
    platform healthcheck then fails and the deploy is rolled back — an outage
    caused entirely by the reporting.
    """
    try:
        _log_feature_status()
        await asyncio.to_thread(prune_old_query_payloads)
        await asyncio.to_thread(_validate_stripe_wiring)
    except Exception as e:
        logger.warning(f"Startup diagnostics failed (ignored): {e}")


async def _warm_bulk_indexes() -> None:
    """Build the downloaded reference indexes before anyone asks for them."""
    from services.genomics_api_real import fetch_gencc_validity, fetch_orphanet_prevalence
    try:
        # Any gene will do; each call builds its whole index as a side effect.
        # Sequential rather than gathered: four downloads at once on a cold boot
        # competes with the first real requests for bandwidth, and nothing is
        # waiting on these.
        await fetch_gencc_validity("BRCA1")
        await fetch_orphanet_prevalence("COL1A1")
        logger.info("Bulk indexes warmed")
    except Exception as e:
        logger.warning("Bulk index warm-up failed, will rebuild on demand: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting MyDNA API...")
    create_tables_safe()
    # Fire and forget — the app is ready now; diagnostics land in the log when
    # they land. Held in a local so the task is not garbage collected.
    diagnostics = asyncio.create_task(_startup_diagnostics())
    # GenCC arrives as a 26 MB download that takes ~20s to fetch and parse.
    # Built at boot so no reader ever waits for it: the alternative is that
    # whoever opens the panel first on a cold process pays the whole cost and
    # concludes the app is broken. Fire and forget — a failure here must not
    # stop the API starting, and the index degrades to empty on its own.
    warm = asyncio.create_task(_warm_bulk_indexes())
    yield
    diagnostics.cancel()
    warm.cancel()
    logger.info("Shutting down.")


# The interactive docs publish the whole route table to anyone who asks, which
# is how the unmetered legacy endpoints were discoverable. Useful locally,
# unnecessary in production — the only consumer there is our own frontend.
_DOCS_ENABLED = not settings.backend_url or settings.backend_url.startswith(
    ("http://localhost", "http://127.0.0.1")
)

app = FastAPI(
    title="MyDNA API",
    description="Natural language genomics research platform powered by Claude AI",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs" if _DOCS_ENABLED else None,
    redoc_url="/redoc" if _DOCS_ENABLED else None,
    openapi_url="/openapi.json" if _DOCS_ENABLED else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Abuse limits ──────────────────────────────────────────────────────────────
# Paths that reach an upstream API or a model get a tighter ceiling than the
# rest. /health is exempt so a limited client cannot take the healthcheck down
# with it, and /billing/webhook is exempt because Stripe retries in bursts and
# is already authenticated by signature.
EXPENSIVE_PATHS = ("/chat", "/chat/stream", "/gene/section", "/dna/annotate")
UNLIMITED_PATHS = ("/health", "/billing/webhook")

# SharedWindow uses Redis when REDIS_URL is set and falls back to the local
# window otherwise, so a second instance shares one budget instead of handing
# out two.
_expensive_limiter = SharedWindow(settings.rate_limit_expensive_per_min, 60.0, "rl:exp")
_default_limiter = SharedWindow(settings.rate_limit_default_per_min, 60.0, "rl:def")
anon_allowance = AnonymousAllowance(settings.anon_query_limit)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    path = request.url.path
    if path in UNLIMITED_PATHS or request.method == "OPTIONS":
        return await call_next(request)

    limiter = _expensive_limiter if path in EXPENSIVE_PATHS else _default_limiter
    ip = client_ip(request)
    allowed, retry_after = limiter.check(ip)
    if not allowed:
        logger.warning("Rate limit hit by %s on %s", ip, path)
        return JSONResponse(
            status_code=429,
            content={"detail": "Too many requests. Please slow down and try again shortly."},
            headers={"Retry-After": str(max(1, int(retry_after)))},
        )
    _expensive_limiter.prune()
    _default_limiter.prune()
    return await call_next(request)


app.include_router(projects_router)
app.include_router(queries_router)
app.include_router(auth_router)


@app.get("/health", response_model=HealthResponse)
async def health_check():
    db_status = "connected"
    try:
        db_gen = get_db()
        db = next(db_gen)
        db.execute(__import__("sqlalchemy").text("SELECT 1"))
        db.close()
    except Exception:
        db_status = "unavailable"
    return HealthResponse(status="healthy", database=db_status, cache_size=cache.size())



def enforce_anonymous_allowance(request: Request, current_user: Optional[User]) -> Optional[str]:
    """Gate unauthenticated callers, returning the key to charge on success.

    Returns None for signed-in users. Raises 401 once an anonymous caller has
    used their allowance, with a marker the UI turns into the sign-in prompt.
    """
    if current_user:
        return None
    key = client_ip(request)
    if not anon_allowance.allowed(key):
        raise HTTPException(status_code=401, detail={
            "sign_in_required": True,
            "anon_limit": anon_allowance.limit,
            "message": "Sign in to keep asking questions.",
        })
    return key


# There is one chat implementation, /chat/stream, further down. The
# non-streaming /chat that used to sit here was a second copy of the same
# quota check, key resolution, pipeline dispatch, charging, persistence and
# caching — and the copies drifted: the streaming one charged nobody for its
# entire life while this one worked, because the bug lived in only one of
# them. Nothing called it; the frontend and examples.py both stream.

# The legacy /execute-query, /interpret-query and /batch-query endpoints were
# removed. They predated the chat endpoints and were never brought under
# authentication or the query quota, so anyone could spend the shared Anthropic
# key and the NCBI rate budget without an account. /batch-query was the worst of
# them: it fanned out one full pipeline per list item with no cap on list
# length, turning a single anonymous request into dozens of model calls and
# hundreds of upstream fetches. Nothing in the app used them.

@app.get("/cache-stats")
async def cache_stats(current_user: User = Depends(require_user)):
    """Cache occupancy. Operational detail, so it needs an account."""
    return cache.stats()


@app.delete("/cache")
async def clear_cache(current_user: User = Depends(require_user)):
    """Drop every cached answer.

    Requires an account: the cache is what stops repeat questions re-running
    seventeen upstream APIs and a model generation apiece, so an anonymous
    caller emptying it in a loop is both a cost amplifier and a denial of
    service. Entries expire on their own; this is for deliberate invalidation.
    """
    cache.clear()
    logger.info("Cache cleared by user %s", current_user.id)
    return {"message": "Cache cleared"}


# ── Streaming chat ────────────────────────────────────────────────────────────

def _sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload)}\n\n"


@app.post("/chat/stream")
async def chat_stream(request: Request, body: ChatRequest, db: Session = Depends(get_db),
                      current_user: Optional[User] = Depends(get_current_user)):
    """Same pipeline as /chat, delivered as server-sent events.

    Emits progress while interpreting and fetching, then the data payload so
    panels can render, then the explanation token by token. The wait is the
    same length; it stops being a blank one.
    """
    anon_key = enforce_anonymous_allowance(request, current_user)
    history_dicts = [{"role": m.role, "content": m.content} for m in body.history]

    user_api_key = body.user_api_key
    if not user_api_key and current_user:
        user_api_key = try_decrypt_key(current_user.encrypted_api_key)
    has_working_key = bool(user_api_key)

    if current_user:
        allowed, _ = user_can_query(current_user, has_working_key=has_working_key)
        if not allowed:
            raise HTTPException(status_code=402, detail={
                "upgrade_required": True,
                "total_queries": current_user.total_queries or 0,
                "query_credits": current_user.query_credits or 0,
                "free_limit": FREE_QUERY_LIMIT,
                "stored_key_unusable": bool(current_user.encrypted_api_key and not has_working_key),
            })

    # The generator runs after this handler returns, by which point FastAPI has
    # already closed the request-scoped session and detached current_user —
    # mutations on it commit nothing. Everything inside the stream therefore
    # uses its own session and re-reads the user by id.
    user_id_for_stream = current_user.id if current_user else None

    async def events():
        stream_db = SessionLocal() if user_id_for_stream else None

        def charge():
            """Spend a query: a credit for members, an allowance slot otherwise."""
            if anon_key:
                anon_allowance.record(anon_key)
            if not stream_db:
                return
            u = stream_db.query(User).filter(User.id == user_id_for_stream).first()
            if u:
                consume_query(u, stream_db, has_working_key=has_working_key)

        try:
            # Keyed on the answer's shape as well as the question. The cache
            # used to key on the question alone, so the first reader's settings
            # decided everyone's answer for 24 hours: asking for a technical
            # explanation returned whatever plain-language reply happened to be
            # cached, with no way to tell. Same bug for response_detail, which
            # had it silently since the cache was added.
            cache_key = f"{body.message}|{body.response_detail}|{body.reading_level}"
            cached = cache.get(cache_key)
            if cached:
                # A cached answer is still an answer. The cache exists to save
                # upstream calls, not to make questions free — and since it is
                # keyed on the question alone, not the user, leaving it
                # uncharged would make any question already asked by anyone
                # free for everyone for a day.
                charge()
                yield _sse("data", {k: v for k, v in cached.items() if k != "content"})
                yield _sse("token", {"text": cached.get("content", "")})
                yield _sse("done", {"cached": True, "query_id": cached.get("query_id")})
                return

            yield _sse("status", {"stage": "interpreting"})
            interpreted = await interpret_query(body.message)

            if interpreted.query_type == QueryType.UNKNOWN:
                yield _sse("status", {"stage": "thinking"})
                parts = []
                async for chunk in stream_followup(
                    body.message, history_dicts,
                    personal_variants=body.personal_variants,
                    response_detail=body.response_detail,
                    user_api_key=user_api_key,
                    personal_documents=body.personal_documents,
                    reading_level=body.reading_level,
                ):
                    parts.append(chunk)
                    yield _sse("token", {"text": chunk})
                charge()
                yield _sse("done", {"content_length": len("".join(parts))})
                return

            yield _sse("status", {"stage": "fetching", "target": interpreted.target,
                                  "query_type": interpreted.query_type.value})

            if interpreted.query_type == QueryType.GENE_QUERY:
                pipeline_result = await run_gene_pipeline(
                    interpreted.target, population=interpreted.population, staged=body.staged)
                raw_results = pipeline_result.get("variants", [])
            else:
                pipeline_result = await run_disease_pipeline(interpreted.target, staged=body.staged)
                raw_results = pipeline_result.get("genes", [])
            sources = pipeline_result.get("sources", [])

            # Panels render now, before a single token of prose exists.
            yield _sse("data", {
                "data": pipeline_result,
                "query_type": interpreted.query_type.value,
                "target": interpreted.target,
                "sources": sources,
                "result_count": len(raw_results),
            })

            yield _sse("status", {"stage": "explaining"})
            parts = []
            async for chunk in stream_explanation(
                query=body.message,
                query_type=interpreted.query_type.value,
                data=pipeline_result,
                conversation_history=history_dicts,
                personal_variants=body.personal_variants,
                response_detail=body.response_detail,
                user_api_key=user_api_key,
                personal_documents=body.personal_documents,
                reading_level=body.reading_level,
            ):
                parts.append(chunk)
                yield _sse("token", {"text": chunk})

            explanation = "".join(parts)
            charge()

            query_id = None
            stored = {
                "content": explanation, "data": pipeline_result,
                "query_type": interpreted.query_type.value, "target": interpreted.target,
                "sources": sources, "result_count": len(raw_results),
            }
            # Nothing is written for a signed-out visitor. Their questions used
            # to be stored as `user_id IS NULL` rows, which meant MyDNA held a
            # record of what people asked before they had agreed to anything at
            # all — and a question can itself identify someone. History is an
            # account feature; a visitor without an account loses nothing by
            # this, because there was no account to show it in.
            if user_id_for_stream is None:
                logger.debug("Anonymous query not persisted (by policy)")
            else:
                save_db = stream_db or SessionLocal()
                try:
                    row = QueryModel(
                        user_id=user_id_for_stream,
                        query_text=body.message,
                        query_type=interpreted.query_type.value,
                        target=interpreted.target,
                        results=stored, result_count=len(raw_results),
                        sources=sources, cached=0,
                    )
                    # Membership is a link row now, and the project is only
                    # attached once it is confirmed to belong to this user —
                    # project_id arrives from the client and must never be
                    # trusted to name somebody else's project.
                    if body.project_id is not None:
                        proj = (
                            save_db.query(Project)
                            .filter(Project.id == body.project_id,
                                    Project.user_id == user_id_for_stream)
                            .first()
                        )
                        if proj:
                            row.projects = [proj]
                    save_db.add(row); save_db.commit(); save_db.refresh(row)
                    query_id = row.id
                except Exception as e:
                    logger.warning(f"DB save failed: {e}")
                finally:
                    if save_db is not stream_db:
                        save_db.close()

            cache.set(cache_key, {**stored, "query_id": query_id})
            yield _sse("done", {"query_id": query_id, "cached": False})

        except Exception as e:
            logger.error(f"Stream failed: {e}")
            yield _sse("error", {"message": str(e)})
        finally:
            if stream_db:
                stream_db.close()

    return StreamingResponse(events(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",   # keep proxies from buffering the stream
    })


# ── Staged gene sections ──────────────────────────────────────────────────────

class SectionRequest(BaseModel):
    gene: str = Field(min_length=1, max_length=32)
    section: str = Field(min_length=1, max_length=64)
    uniprot_accession: Optional[str] = None
    ensembl_id: Optional[str] = None


@app.post("/gene/section")
async def gene_section(request: Request, body: SectionRequest, db: Session = Depends(get_db),
                       current_user: Optional[User] = Depends(get_current_user)):
    """Fetch one optional section of a gene result, on demand.

    Charged only when the section actually returns something. Whether a source
    holds anything for a given gene cannot be known without asking it, so the
    cost falls on a useful answer rather than on the attempt — and an empty
    result is remembered so the option stops being offered for that gene.
    """
    anon_key = enforce_anonymous_allowance(request, current_user)
    cache_key = section_cache_key(body.gene, body.section)
    cached = cache.get(cache_key)
    if cached is not None:
        # Free for members — someone already paid to fetch this, and re-reading
        # is not a new question. Anonymous callers still spend an allowance
        # slot: that gate is about access, not cost, and serving unlimited
        # cached content would quietly defeat it.
        if anon_key and section_has_data(cached):
            anon_allowance.record(anon_key)
        return {"section": body.section, "data": cached, "cached": True,
                "empty": not section_has_data(cached), "charged": False}

    user_api_key = try_decrypt_key(current_user.encrypted_api_key) if current_user else None
    has_working_key = bool(user_api_key)
    # No quota check: sections cost nothing to produce, so someone out of
    # credits can still open every panel on an answer they already paid for.
    # Refusing them would be charging twice for one question.

    try:
        data = await fetch_gene_section(
            body.gene, body.section,
            uniprot_accession=body.uniprot_accession,
            ensembl_id=body.ensembl_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Section {body.section} failed for {body.gene}: {e}")
        raise HTTPException(status_code=502, detail=f"Could not load {body.section}")

    has_data = section_has_data(data)

    # Sections are free, and that is a correction rather than a promotion.
    # Fetching one makes **no model call at all** — it is public API traffic and
    # a database read — so a credit bought nothing, and charging for it was the
    # one line in the pricing that could not be defended on cost. Measured:
    # a full question costs about $0.013 in tokens, a section costs nothing.
    #
    # The per-IP rate limit is what still protects the upstream sources; a
    # credit was never doing that job.
    charged = False
    if has_data and not current_user and anon_key:
        # Signed-out visitors still count against the anonymous allowance,
        # which is a fairness measure on shared public databases rather than a
        # charge — see the note on ANON_QUERY_LIMIT in CLAUDE.md.
        anon_allowance.record(anon_key)

    # A negative expires sooner than a real answer, so a source that later
    # gains data for this gene surfaces again on its own.
    cache.set(cache_key, data, ttl_hours=None if has_data else EMPTY_SECTION_TTL_HOURS)
    return {"section": body.section, "data": data, "cached": False,
            "empty": not has_data, "charged": charged}


class AnnotateRequest(BaseModel):
    # Capped well below what dbSNP would accept per call. A reader's variants
    # inside one gene number in the tens; a request for thousands is not that.
    rsids: list[str] = Field(min_length=1, max_length=200)


@app.post("/dna/annotate")
async def dna_annotate(request: Request, current_user: Optional[User] = Depends(get_current_user)):
    """Annotate rsIDs with gene, consequence, clinical significance and frequency.

    Deliberately free and uncharged. These are the reader's own variants, and
    the app already made them pay to ask the question that surfaced them —
    charging again to say what they mean would be billing twice for one answer.
    The per-IP rate limit is what keeps it from being used as a bulk dbSNP proxy.

    Privacy: which rsIDs a person carries is personal data. It is passed to
    dbSNP and returned, and is never written to the database or the log. Do not
    add persistence or logging of `rsids` here — see the privacy invariant in
    CLAUDE.md.
    """
    try:
        body = AnnotateRequest(**(await request.json()))
    except Exception:
        raise HTTPException(status_code=400, detail="Expected a list of rsIDs")

    # dbSNP says where a variant is and what has been reported about it; VEP
    # says what it is predicted to do to the protein. Both are triggered by the
    # same explicit action, so pairing them adds no disclosure the reader has
    # not already agreed to — and running them together means one wait rather
    # than two. VEP failing must not lose the dbSNP answer, hence the gather.
    try:
        annotations, predictions = await asyncio.gather(
            fetch_dbsnp_annotations(body.rsids),
            fetch_vep_predictions(body.rsids),
            return_exceptions=True,
        )
        if isinstance(annotations, Exception):
            raise annotations
        if isinstance(predictions, Exception):
            logger.warning("VEP unavailable for this batch: %s", predictions)
            predictions = {}
    except Exception as e:
        # Note the deliberate absence of the rsIDs from this message.
        logger.error(f"dbSNP annotation failed for {len(body.rsids)} variants: {e}")
        raise HTTPException(status_code=502, detail="Could not reach dbSNP")

    for rsid, pred in (predictions or {}).items():
        annotations.setdefault(rsid, {})["prediction"] = pred

    return {"annotations": annotations, "requested": len(body.rsids),
            "resolved": len(annotations),
            "predicted": len(predictions or {}),
            "source": "dbSNP + Ensembl VEP"}


class CitationsRequest(BaseModel):
    # Bounded because each is forwarded to NCBI; forty covers the union of every
    # curator's citations on the most-disputed gene-disease pair in the dataset.
    pmids: list[str] = Field(min_length=1, max_length=40)


@app.post("/citations")
async def citations(body: CitationsRequest):
    """Resolve PMIDs to titles so cited evidence can be read inside MyDNA.

    Deliberately free and uncharged, on the same reasoning as `/dna/annotate`:
    the reader already paid for the answer that surfaced these citations, and a
    list of eight-digit numbers is not an answer. Charging again to say what the
    numbers are would be billing twice for one thing.

    Also deliberately unauthenticated. A PMID is a public identifier and
    reveals nothing about the caller, so there is nothing here to protect — the
    per-IP rate limit is what stops it being used as a bulk PubMed proxy.
    """
    try:
        titles = await fetch_pubmed_titles(body.pmids)
    except Exception as e:
        logger.warning("Citation lookup failed for %d PMIDs: %s", len(body.pmids), e)
        raise HTTPException(status_code=502, detail="Could not reach PubMed")
    return {"citations": titles, "requested": len(body.pmids), "resolved": len(titles)}


class DocumentExtractRequest(BaseModel):
    # Base64 page images, downscaled and re-encoded as JPEG by the browser
    # before they get here. Bounded hard: vision is the costliest call in the app.
    images: list[str] = Field(min_length=1, max_length=8)
    media_type: str = "image/jpeg"


@app.post("/documents/extract")
async def documents_extract(
    body: DocumentExtractRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_user),
):
    """Transcribe photographed or scanned pages so they can be read alongside the data.

    Costs SCAN_CREDITS rather than one: measured at roughly 2-3x a question.

    **Requires sign-in, and that is not a paywall.** A paper someone uploads
    about their own condition is health data in its own right — uploading one on
    osteogenesis imperfecta discloses a suspected diagnosis, which is arguably
    more revealing than the variants themselves. So it is processed on explicit
    consent, and consent must be recorded against somebody. Same reasoning as
    DNA upload; see "Data protection" in CLAUDE.md.

    **Charged, unlike `/dna/annotate`.** A PDF with a text layer is extracted
    entirely in the browser and costs nothing, so it stays free. A scan has no
    text layer, and only a vision model reads a rotated two-column journal page
    reliably — a real per-page cost. Charging for the path that costs money and
    not the one that doesn't is the honest version of both.

    **Nothing is stored.** Not the image, not the transcription, not in the
    database and not in the log. Same rule as `personal_variants`, for the same
    privacy reasons plus one more: MyDNA has no licence to hold a publisher's
    text, and needs none to help someone read their own lawful copy. Do not add
    persistence here.
    """
    if not settings.anthropic_api_key:
        raise HTTPException(status_code=501, detail="Document reading is not configured")

    has_working_key = bool(try_decrypt_key(current_user.encrypted_api_key)) \
        if current_user.encrypted_api_key else False

    allowed, reason = user_can_query(current_user, has_working_key=has_working_key)
    if not allowed:
        raise HTTPException(status_code=402, detail={
            "upgrade_required": True,
            "reason": reason,
            "message": "Reading a scanned page uses one query credit. "
                       "PDFs with selectable text are read in your browser, free.",
        })

    try:
        text = await transcribe_pages(body.images, media_type=body.media_type)
    except Exception as e:
        # Note the deliberate absence of the image and of any transcribed text.
        logger.error("Document transcription failed for %d page(s): %s", len(body.images), e)
        raise HTTPException(status_code=502, detail="Could not read that document")

    # A scanned page costs roughly two to three times a question — Sonnet
    # vision, up to 8,000 output tokens — so it spends two credits rather than
    # one. Priced to cost in both directions: sections became free for the same
    # reason this became dearer.
    for _ in range(SCAN_CREDITS):
        consume_query(current_user, db, has_working_key=has_working_key)
    return {"text": text, "pages": len(body.images),
            "charged": True, "credits": SCAN_CREDITS}


# ── Streaming chat ────────────────────────────────────────────────────────────

def _sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload)}\n\n"


@app.get("/billing/prices")
async def billing_prices(current_user: Optional[User] = Depends(get_current_user)):
    """Live pricing for whichever Stripe mode applies to this caller."""
    test_mode = is_test_mode_user(current_user)
    # Deliberately uncached. The shared cache has a 24h TTL, which for prices
    # means a pricing change stays invisible for up to a day — the same class of
    # bug as hardcoding them, just slower to notice. Two Stripe reads per modal
    # open is a fair price for always telling the customer the truth.
    return get_price_display(test_mode)


class SupportRequest(BaseModel):
    amount_cents: int = Field(ge=200, le=50000)


@app.post("/billing/support")
async def billing_support(body: SupportRequest,
                          current_user: Optional[User] = Depends(get_current_user)):
    """Start a contribution towards running costs.

    Unauthenticated on purpose: someone who finds the project useful should be
    able to chip in without making an account, and there is no entitlement to
    attach to one anyway. The user id is recorded when present only so a
    thank-you can be matched to a person in the log.

    **This grants nothing.** The moment a contribution unlocks a feature it stops
    being support and becomes a sale — see `create_support_session`.
    """
    try:
        url = create_support_session(
            body.amount_cents,
            user_id=current_user.id if current_user else 0,
            test_mode=is_test_mode_user(current_user),
        )
    except ValueError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except Exception as e:
        logger.error("Support session failed: %s", e)
        raise HTTPException(status_code=502, detail="Could not start checkout")
    return {"url": url}


@app.post("/billing/portal")
async def billing_portal(db: Session = Depends(get_db), current_user: User = Depends(require_user)):
    """Open Stripe's customer portal so a subscriber can cancel or update payment."""
    settings = get_settings()
    test_mode = is_test_mode_user(current_user)
    customer_id = current_user.stripe_customer_id

    # Anyone who subscribed before we started recording the customer id still
    # needs a way to cancel. Resolve it from the user_id stamped on their
    # subscriptions — matching on email is unreliable, because the Stripe
    # customer's email comes from whatever they typed at checkout (or from
    # Link), which need not be the address they signed in with.
    if not customer_id:
        secret_key, _ = stripe_credentials_for(test_mode)
        if secret_key:
            stripe.api_key = secret_key
            try:
                hits = stripe.Subscription.search(
                    query=f"metadata['user_id']:'{current_user.id}'", limit=5
                ).get("data", [])
                if hits:
                    # Prefer one that is still active, else any of them.
                    chosen = next((h for h in hits if h.get("status") in ("active", "trialing")), hits[0])
                    customer_id = chosen.get("customer")
            except Exception as e:
                logger.warning("Subscription search failed for user %s: %s", current_user.id, e)

            if not customer_id:
                try:
                    found = stripe.Customer.list(email=current_user.email, limit=1).get("data", [])
                    if found:
                        customer_id = found[0]["id"]
                except Exception as e:
                    logger.warning("Customer lookup by email failed for user %s: %s", current_user.id, e)

            if customer_id:
                current_user.stripe_customer_id = customer_id
                db.commit()
                logger.info("Backfilled Stripe customer %s for user %s", customer_id, current_user.id)

    if not customer_id:
        raise HTTPException(status_code=404, detail={
            "no_subscription": True,
            "message": "No billing account yet — nothing to manage.",
        })
    try:
        url = create_portal_session(customer_id, return_url=settings.frontend_url, test_mode=test_mode)
    except Exception as e:
        logger.error("Portal session failed for user %s: %s", current_user.id, e)
        raise HTTPException(status_code=502, detail="Could not open the billing portal")
    return {"url": url}


class CheckoutRequest(BaseModel):
    type: str  # "unlock" | "credits" | "byok"


@app.post("/billing/checkout")
async def billing_checkout(body: CheckoutRequest, current_user: User = Depends(require_user)):
    # Refuse to sell something the account already has. Nothing stopped a
    # double-click through checkout from creating two subscriptions on two
    # Stripe customers, billing $20/month for one account.
    if body.type == "unlock" and current_user.byok_unlocked:
        raise HTTPException(status_code=409, detail={
            "already_owned": True,
            "manage": True,
            "message": "You already have an active Unlimited subscription.",
        })
    if body.type == "byok" and current_user.byok_purchased:
        raise HTTPException(status_code=409, detail={
            "already_owned": True,
            "message": "You already own Bring Your Own Key.",
        })

    # Allowlisted accounts get test-mode Stripe even on a live deployment, so
    # billing can be exercised with 4242 cards without a separate environment.
    test_mode = is_test_mode_user(current_user)
    try:
        url = create_checkout_session(current_user.id, body.type, test_mode=test_mode)
    except ValueError:
        raise HTTPException(status_code=501, detail="Billing not configured")
    except Exception as e:
        # Bad key, Stripe outage, price removed — anything from their side. The
        # caller gets a clean failure instead of a 500 with a stack trace.
        logger.error("Checkout failed for user %s (%s): %s", current_user.id, body.type, e)
        raise HTTPException(status_code=502, detail="Could not reach the payment provider")
    return {"url": url, "test_mode": test_mode}


@app.post("/billing/webhook")
async def billing_webhook(request: Request, db: Session = Depends(get_db)):
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        # Accepts either the live or the test signing secret — a deployment
        # serving allowlisted test users receives events from both environments.
        event, is_test = verify_webhook(payload, sig)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    event_id = event.get("id")

    # Stripe delivers at-least-once: it retries failures for up to 3 days, and
    # events can be resent by hand. Claim the event id first — the primary key
    # turns a replay into a no-op rather than a second helping of credits.
    if event_id:
        try:
            db.add(ProcessedStripeEvent(event_id=event_id, event_type=event.get("type")))
            db.commit()
        except IntegrityError:
            db.rollback()
            logger.info("Stripe event %s already processed — ignoring replay", event_id)
            return {"received": True, "duplicate": True}

    etype = event["type"]

    # ── Subscription lifecycle ────────────────────────────────────────────────
    # byok_unlocked is a permanent flag, which was correct when Unlimited was a
    # one-time purchase. As a monthly subscription it has to be revoked when the
    # subscription ends, or a cancelled customer keeps unlimited access forever.
    if etype in ("customer.subscription.deleted", "customer.subscription.updated"):
        sub = event["data"]["object"]
        status = sub.get("status")
        # Metadata is copied onto the subscription at checkout (subscription_data).
        user_id = int((sub.get("metadata") or {}).get("user_id", 0))
        active = status in ("active", "trialing")
        if not user_id:
            logger.warning("Stripe %s carried no user_id metadata — nothing to update", etype)
            return {"received": True}
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            logger.error("Stripe %s for unknown user %s", etype, user_id)
            return {"received": True}

        # A customer can hold more than one subscription — double-clicking
        # checkout is enough to do it. Revoking on the first cancellation would
        # cut off someone who is still being billed for another, so only revoke
        # once nothing active remains.
        if not active and sub.get("customer"):
            try:
                stripe.api_key = (get_settings().stripe_test_secret_key if is_test
                                  else get_settings().stripe_secret_key)
                others = stripe.Subscription.list(customer=sub["customer"], status="active", limit=20)
                still_paying = [o for o in others.get("data", []) if o["id"] != sub.get("id")]
                if still_paying:
                    logger.info(
                        "User %s cancelled %s but still holds %d active subscription(s) — access kept",
                        user_id, sub.get("id"), len(still_paying))
                    return {"received": True}
            except Exception as e:
                logger.warning("Could not check for other subscriptions (%s) — revoking", e)

        if user.byok_unlocked != active:
            user.byok_unlocked = active
            db.commit()
            logger.info("User %s unlimited access %s (subscription %s)",
                        user_id, "granted" if active else "REVOKED", status)
        return {"received": True}

    if etype == "checkout.session.completed":
        meta = event["data"]["object"].get("metadata", {})
        user_id = int(meta.get("user_id", 0))
        purchase_type = meta.get("purchase_type", "")

        # A contribution, handled before the user lookup because it needs no
        # user and grants nothing. Anyone can support the project signed out, so
        # a missing account here is normal rather than the paid-but-unmatched
        # emergency the branch below exists to shout about.
        if purchase_type == "support":
            logger.info("Support contribution received%s (user %s)",
                        " [TEST MODE]" if is_test else "", user_id or "anonymous")
            return {"received": True}

        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            # Nothing to grant, but the money moved — this needs a human.
            logger.error(
                "Stripe event %s paid but no user matched metadata %s — entitlement NOT granted",
                event_id, dict(meta),
            )
            return {"received": True}
        # Remember the Stripe customer so the portal can be opened later.
        cust = event["data"]["object"].get("customer")
        if cust and user.stripe_customer_id != cust:
            user.stripe_customer_id = cust

        if purchase_type == "unlock":
            user.byok_unlocked = True
            logger.info("User %s unlocked unlimited access%s", user_id, " [TEST MODE]" if is_test else "")
        elif purchase_type == "byok":
            # Permanent, and independent of the subscription — someone who buys
            # BYOK and never subscribes keeps the right to store their key.
            user.byok_purchased = True
            logger.info("User %s purchased BYOK%s", user_id, " [TEST MODE]" if is_test else "")
        elif purchase_type == "credits":
            user.query_credits = (user.query_credits or 0) + CREDITS_PER_PACK
            logger.info("User %s purchased %s credits%s", user_id, CREDITS_PER_PACK, " [TEST MODE]" if is_test else "")
        else:
            logger.error(
                "Stripe event %s has unrecognized purchase_type %r — nothing granted",
                event_id, purchase_type,
            )
        db.commit()
    return {"received": True}


# ── User API key storage ──────────────────────────────────────────────────────

class ApiKeyRequest(BaseModel):
    api_key: str


@app.post("/user/api-key")
async def save_user_api_key(body: ApiKeyRequest, current_user: User = Depends(require_user), db: Session = Depends(get_db)):
    key = body.api_key.strip()
    if not key or not key.startswith("sk-"):
        raise HTTPException(status_code=400, detail="Invalid API key format")
    # Checks the key is actually usable, not merely non-empty — a malformed
    # ENCRYPTION_KEY would otherwise pass here and fail inside encrypt_key().
    if not encryption_is_configured():
        raise HTTPException(status_code=501, detail="Key storage not configured — set ENCRYPTION_KEY")

    # Bring-your-own-key is a separate one-time product. Allowlisted unlimited
    # accounts skip it; anyone who stored a key while it was free was
    # grandfathered by the migration and still passes.
    if not current_user.byok_purchased and not is_unlimited_user(current_user):
        raise HTTPException(status_code=402, detail={
            "byok_required": True,
            "message": "Storing your own API key is a one-time purchase.",
        })
    current_user.encrypted_api_key = encrypt_key(key)
    db.commit()
    return {"stored": True}


@app.delete("/user/api-key")
async def delete_user_api_key(current_user: User = Depends(require_user), db: Session = Depends(get_db)):
    current_user.encrypted_api_key = None
    db.commit()
    return {"removed": True}


@app.post("/user/dna-consent")
async def record_dna_consent(current_user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Record that this account accepted the genetic-data consent notice.

    Genetic data is special category under GDPR Article 9 and is processed here
    on explicit consent, which a controller must be able to demonstrate rather
    than merely assert. This stores a timestamp and nothing else — no variants,
    no file, no indication of what was then looked at.

    Signed-out visitors are not recorded, having no account to attach it to.
    The consent screen still gates the upload for them; what differs is only
    that MyDNA keeps no record of it.
    """
    current_user.dna_consent_at = datetime.utcnow()
    db.commit()
    return {"recorded": True, "at": current_user.dna_consent_at.isoformat()}


@app.get("/user/export")
async def export_user_data(current_user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Everything held about this account, in one portable JSON document.

    GDPR Article 15 (access) and Article 20 (portability), and the CCPA right
    to know. Written as a real endpoint rather than a promise fulfilled by
    hand, because a right that depends on someone remembering to run SQL is not
    much of a right.

    The stored Anthropic key is deliberately excluded: it is the reader's
    credential, it is held encrypted, and returning it would turn a data
    export into a secret-disclosure route.
    """
    queries = (
        db.query(QueryModel)
        .filter(QueryModel.user_id == current_user.id)
        .order_by(QueryModel.created_at.desc())
        .all()
    )
    projects = db.query(Project).filter(Project.user_id == current_user.id).all()

    return {
        "exported_at": datetime.utcnow().isoformat(),
        "account": {
            "email": current_user.email,
            "name": current_user.name,
            "created_at": current_user.created_at.isoformat() if current_user.created_at else None,
            "dna_consent_at": current_user.dna_consent_at.isoformat() if current_user.dna_consent_at else None,
            "total_queries": current_user.total_queries or 0,
            "query_credits": current_user.query_credits or 0,
            "subscription_active": bool(current_user.byok_unlocked),
            "byok_purchased": bool(current_user.byok_purchased),
            "has_stored_api_key": bool(current_user.encrypted_api_key),
        },
        "projects": [
            {"id": p.id, "name": p.name, "description": p.description,
             "created_at": p.created_at.isoformat() if p.created_at else None}
            for p in projects
        ],
        "queries": [
            {"id": q.id, "question": q.query_text, "type": q.query_type,
             "target": q.target, "sources": q.sources,
             "answer": q.results,
             "created_at": q.created_at.isoformat() if q.created_at else None}
            for q in queries
        ],
        "note": (
            "Genetic data you uploaded is not included because it is never "
            "stored — it is read in your browser and discarded."
        ),
    }


@app.delete("/user/account")
async def delete_user_account(current_user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Erase this account and everything attached to it.

    GDPR Article 17 and the CCPA right to delete. Irreversible and immediate.

    Projects cascade to their queries via the ORM relationship, but queries
    attached directly to the account without a project do not, so they are
    removed explicitly — a partial delete would leave exactly the records
    someone asked to be rid of.

    An active Stripe subscription is not cancelled from here. Deleting the
    account removes our record of it, and a subscription that keeps billing
    after the account is gone would be the worse failure; the caller is told so
    plainly, and the customer portal remains the route.
    """
    user_id = current_user.id
    had_subscription = bool(current_user.byok_unlocked)

    db.query(QueryModel).filter(QueryModel.user_id == user_id).delete(synchronize_session=False)
    db.query(AuditLog).filter(AuditLog.user_id == user_id).delete(synchronize_session=False)
    # Projects cascade to any remaining queries through the relationship.
    for project in db.query(Project).filter(Project.user_id == user_id).all():
        db.delete(project)
    db.delete(current_user)
    db.commit()

    logger.info("Account %s deleted at the user's request", user_id)
    return {
        "deleted": True,
        "subscription_needs_cancelling": had_subscription,
        "note": (
            "Cancel any active subscription through Stripe as well — deleting "
            "the account removes our record of it but does not stop billing."
            if had_subscription else None
        ),
    }
