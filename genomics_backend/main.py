import asyncio
import json
import stripe
import time
import logging
from contextlib import asynccontextmanager
from typing import Optional, Any
from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from config import get_settings
from models import QueryRequest, QueryResponse, BatchQueryRequest, HealthResponse, QueryType
from services.query_interpreter import interpret_query
from services.genomics_api_real import run_gene_pipeline, run_disease_pipeline, fetch_gene_section
from services.ai_explainer import explain_results, explain_comparison, answer_followup, stream_explanation, stream_followup
from services.cache import cache
from database.models import create_tables_safe, get_db, Query as QueryModel, ProcessedStripeEvent
from database.routes import router as projects_router, share_router
from auth import router as auth_router, get_current_user, require_user
from services.billing import create_checkout_session, verify_webhook, user_can_query, consume_query, is_test_mode_user, is_unlimited_user, get_price_display, create_portal_session, stripe_credentials_for, FREE_QUERY_LIMIT, CREDITS_PER_PACK
from services.encryption import encrypt_key, try_decrypt_key, is_configured as encryption_is_configured
from database.models import User

logging.basicConfig(level=logging.INFO)
# The Stripe SDK logs every HTTP request/response at INFO, which buries our own
# startup diagnostics. Warnings and errors from it still come through.
logging.getLogger("stripe").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

settings = get_settings()


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    project_id: Optional[int] = None
    personal_variants: Optional[list[dict]] = None  # [{rsid, genotype, chromosome?}] — session only, never stored
    response_detail: Optional[str] = "standard"     # concise | standard | detailed
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
        await asyncio.to_thread(_validate_stripe_wiring)
    except Exception as e:
        logger.warning(f"Startup diagnostics failed (ignored): {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting MyDNA API...")
    create_tables_safe()
    # Fire and forget — the app is ready now; diagnostics land in the log when
    # they land. Held in a local so the task is not garbage collected.
    diagnostics = asyncio.create_task(_startup_diagnostics())
    yield
    diagnostics.cancel()
    logger.info("Shutting down.")


app = FastAPI(
    title="MyDNA API",
    description="Natural language genomics research platform powered by Claude AI",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects_router)
app.include_router(share_router)
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


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest, db: Session = Depends(get_db), current_user: Optional[User] = Depends(get_current_user)):
    """
    Primary chat endpoint. Interprets the message, fetches genomics data if needed,
    then has Claude explain the results with full conversation context.
    """
    history_dicts = [{"role": m.role, "content": m.content} for m in request.history]

    # Resolve API key first: request body → server-stored → shared server key.
    # This has to happen before the quota check, because "is this user on their
    # own key?" is what decides whether the quota applies at all. A stored key
    # that fails to decrypt counts as no key — try_decrypt_key logs the reason.
    user_api_key = request.user_api_key
    if not user_api_key and current_user:
        user_api_key = try_decrypt_key(current_user.encrypted_api_key)
    # Only a user-supplied key exempts from quota; the shared server key does not.
    has_working_key = bool(user_api_key)

    # Enforce query limit for authenticated users
    if current_user:
        allowed, reason = user_can_query(current_user, has_working_key=has_working_key)
        if not allowed:
            raise HTTPException(status_code=402, detail={
                "upgrade_required": True,
                "total_queries": current_user.total_queries or 0,
                "query_credits": current_user.query_credits or 0,
                "free_limit": FREE_QUERY_LIMIT,
                # Set when the user believes they are on BYOK but their stored
                # key is unusable, so the UI can prompt a re-entry.
                "stored_key_unusable": bool(
                    current_user.encrypted_api_key and not has_working_key
                ),
            })

    # Check cache
    cached = cache.get(request.message)
    if cached:
        return ChatResponse(**{**cached, "cached": True})

    # Try to interpret as genomics query
    interpreted = await interpret_query(request.message)

    if interpreted.query_type == QueryType.UNKNOWN:
        content = await answer_followup(request.message, history_dicts, personal_variants=request.personal_variants, response_detail=request.response_detail, user_api_key=user_api_key)
        if current_user:
            consume_query(current_user, db, has_working_key=has_working_key)
        return ChatResponse(content=content)

    # Fetch genomics data
    try:
        import asyncio as _asyncio
        if interpreted.query_type == QueryType.COMPARISON_QUERY:
            gene_a = interpreted.filters.get("gene_a", "")
            gene_b = interpreted.filters.get("gene_b", "")
            if not gene_a or not gene_b:
                parts = interpreted.target.split(" vs ")
                gene_a, gene_b = parts[0].strip(), parts[1].strip() if len(parts) > 1 else parts[0]
            data_a, data_b = await _asyncio.gather(
                run_gene_pipeline(gene_a),
                run_gene_pipeline(gene_b),
            )
            pipeline_result = {
                "gene_a": gene_a, "gene_b": gene_b,
                "data_a": data_a, "data_b": data_b,
                "sources": list(set((data_a.get("sources") or []) + (data_b.get("sources") or []))),
            }
            raw_results = []
            sources = pipeline_result["sources"]
        elif interpreted.query_type == QueryType.GENE_QUERY:
            pipeline_result = await run_gene_pipeline(
                interpreted.target,
                population=interpreted.population,
                staged=request.staged,
            )
            raw_results = pipeline_result.get("variants", [])
            sources = pipeline_result.get("sources", [])
        else:
            pipeline_result = await run_disease_pipeline(interpreted.target)
            raw_results = pipeline_result.get("genes", [])
            sources = pipeline_result.get("sources", [])
    except Exception as e:
        logger.error(f"Pipeline failed: {e}")
        raise HTTPException(status_code=500, detail=f"Data fetch failed: {e}")

    # Have Claude explain the results
    if interpreted.query_type == QueryType.COMPARISON_QUERY:
        explanation = await explain_comparison(
            gene_a=pipeline_result["gene_a"],
            gene_b=pipeline_result["gene_b"],
            data_a=pipeline_result["data_a"],
            data_b=pipeline_result["data_b"],
            conversation_history=history_dicts,
            user_api_key=user_api_key,
        )
    else:
        explanation = await explain_results(
            query=request.message,
            query_type=interpreted.query_type.value,
            data=pipeline_result,
            conversation_history=history_dicts,
            personal_variants=request.personal_variants,
            response_detail=request.response_detail,
            user_api_key=user_api_key,
        )

    # Count the query against the user's limit
    if current_user:
        consume_query(current_user, db, has_working_key=has_working_key)

    # Save to DB — store full response so history can replay it
    query_id = None
    try:
        stored_results = {
            "content": explanation,
            "data": pipeline_result,
            "query_type": interpreted.query_type.value,
            "target": interpreted.target,
            "sources": sources,
            "result_count": len(raw_results),
        }
        db_query = QueryModel(
            project_id=request.project_id,
            user_id=current_user.id if current_user else None,
            query_text=request.message,
            query_type=interpreted.query_type.value,
            target=interpreted.target,
            results=stored_results,
            result_count=len(raw_results),
            sources=sources,
            cached=0,
        )
        db.add(db_query)
        db.commit()
        db.refresh(db_query)
        query_id = db_query.id
    except Exception as e:
        logger.warning(f"DB save failed: {e}")

    response_data = {
        "content": explanation,
        "data": pipeline_result,
        "query_type": interpreted.query_type.value,
        "target": interpreted.target,
        "sources": sources,
        "result_count": len(raw_results),
        "query_id": query_id,
        "cached": False,
    }

    cache.set(request.message, {k: v for k, v in response_data.items() if k != "cached"})

    return ChatResponse(**response_data)


# Keep legacy endpoints for backwards compatibility
@app.post("/execute-query", response_model=QueryResponse)
async def execute_query(request: QueryRequest, db: Session = Depends(get_db)):
    cached = cache.get(request.text)
    if cached:
        cached["cached"] = True
        return QueryResponse(**cached)

    interpreted = await interpret_query(request.text)
    if interpreted.query_type == QueryType.UNKNOWN:
        raise HTTPException(status_code=422, detail=f"Could not interpret: '{request.text}'")

    if interpreted.query_type == QueryType.GENE_QUERY:
        pipeline_result = await run_gene_pipeline(interpreted.target, population=interpreted.population)
        results = pipeline_result.get("variants", [])
        sources = pipeline_result.get("sources", [])
    else:
        pipeline_result = await run_disease_pipeline(interpreted.target)
        results = pipeline_result.get("genes", [])
        sources = pipeline_result.get("sources", [])

    return QueryResponse(
        query=request.text,
        interpreted=interpreted,
        results=results,
        result_count=len(results),
        sources=sources,
    )


@app.post("/interpret-query")
async def interpret_only(request: QueryRequest):
    interpreted = await interpret_query(request.text)
    return {"query": request.text, "interpreted": interpreted.dict()}


@app.post("/batch-query")
async def batch_query(request: BatchQueryRequest, db: Session = Depends(get_db)):
    import asyncio
    tasks = [execute_query(QueryRequest(text=item, project_id=request.project_id), db)
             for item in request.genes_or_diseases]
    responses = await asyncio.gather(*tasks, return_exceptions=True)
    results = []
    for item, resp in zip(request.genes_or_diseases, responses):
        if isinstance(resp, Exception):
            results.append({"query": item, "error": str(resp)})
        else:
            results.append(resp)
    return {"queries": results, "total": len(results)}


@app.get("/cache-stats")
async def cache_stats():
    return cache.stats()


@app.delete("/cache")
async def clear_cache():
    cache.clear()
    return {"message": "Cache cleared"}


# ── Streaming chat ────────────────────────────────────────────────────────────

def _sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload)}\n\n"


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest, db: Session = Depends(get_db),
                      current_user: Optional[User] = Depends(get_current_user)):
    """Same pipeline as /chat, delivered as server-sent events.

    Emits progress while interpreting and fetching, then the data payload so
    panels can render, then the explanation token by token. The wait is the
    same length; it stops being a blank one.
    """
    history_dicts = [{"role": m.role, "content": m.content} for m in request.history]

    user_api_key = request.user_api_key
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

    async def events():
        try:
            cached = cache.get(request.message)
            if cached:
                yield _sse("data", {k: v for k, v in cached.items() if k != "content"})
                yield _sse("token", {"text": cached.get("content", "")})
                yield _sse("done", {"cached": True, "query_id": cached.get("query_id")})
                return

            yield _sse("status", {"stage": "interpreting"})
            interpreted = await interpret_query(request.message)

            if interpreted.query_type == QueryType.UNKNOWN:
                yield _sse("status", {"stage": "thinking"})
                parts = []
                async for chunk in stream_followup(
                    request.message, history_dicts,
                    personal_variants=request.personal_variants,
                    response_detail=request.response_detail,
                    user_api_key=user_api_key,
                ):
                    parts.append(chunk)
                    yield _sse("token", {"text": chunk})
                if current_user:
                    consume_query(current_user, db, has_working_key=has_working_key)
                yield _sse("done", {"content_length": len("".join(parts))})
                return

            yield _sse("status", {"stage": "fetching", "target": interpreted.target,
                                  "query_type": interpreted.query_type.value})

            if interpreted.query_type == QueryType.GENE_QUERY:
                pipeline_result = await run_gene_pipeline(
                    interpreted.target, population=interpreted.population, staged=request.staged)
                raw_results = pipeline_result.get("variants", [])
            else:
                pipeline_result = await run_disease_pipeline(interpreted.target)
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
                query=request.message,
                query_type=interpreted.query_type.value,
                data=pipeline_result,
                conversation_history=history_dicts,
                personal_variants=request.personal_variants,
                response_detail=request.response_detail,
                user_api_key=user_api_key,
            ):
                parts.append(chunk)
                yield _sse("token", {"text": chunk})

            explanation = "".join(parts)
            if current_user:
                consume_query(current_user, db, has_working_key=has_working_key)

            query_id = None
            stored = {
                "content": explanation, "data": pipeline_result,
                "query_type": interpreted.query_type.value, "target": interpreted.target,
                "sources": sources, "result_count": len(raw_results),
            }
            try:
                row = QueryModel(
                    project_id=request.project_id,
                    user_id=current_user.id if current_user else None,
                    query_text=request.message,
                    query_type=interpreted.query_type.value,
                    target=interpreted.target,
                    results=stored, result_count=len(raw_results),
                    sources=sources, cached=0,
                )
                db.add(row); db.commit(); db.refresh(row)
                query_id = row.id
            except Exception as e:
                logger.warning(f"DB save failed: {e}")

            cache.set(request.message, {**stored, "query_id": query_id})
            yield _sse("done", {"query_id": query_id, "cached": False})

        except Exception as e:
            logger.error(f"Stream failed: {e}")
            yield _sse("error", {"message": str(e)})

    return StreamingResponse(events(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",   # keep proxies from buffering the stream
    })


# ── Staged gene sections ──────────────────────────────────────────────────────

class SectionRequest(BaseModel):
    gene: str
    section: str
    uniprot_accession: Optional[str] = None
    ensembl_id: Optional[str] = None


@app.post("/gene/section")
async def gene_section(body: SectionRequest, db: Session = Depends(get_db),
                       current_user: Optional[User] = Depends(get_current_user)):
    """Fetch one optional section of a gene result, on demand.

    Counts against the query quota: each section is a separate round of
    upstream fetching, and choosing to pull one is a deliberate act of asking
    for more. Cached repeats are free — re-reading something already fetched
    is not a new question.
    """
    cache_key = f"__section__:{body.gene}:{body.section}"
    cached = cache.get(cache_key)
    if cached:
        return {"section": body.section, "data": cached, "cached": True}

    user_api_key = try_decrypt_key(current_user.encrypted_api_key) if current_user else None
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

    # Charged only after the fetch succeeds — a failed lookup costs nothing.
    if current_user:
        consume_query(current_user, db, has_working_key=has_working_key)

    cache.set(cache_key, data)
    return {"section": body.section, "data": data, "cached": False}


# ── Billing ───────────────────────────────────────────────────────────────────

class CheckoutRequest(BaseModel):
    type: str  # "unlock" | "credits" | "byok"


@app.get("/billing/prices")
async def billing_prices(current_user: Optional[User] = Depends(get_current_user)):
    """Live pricing for whichever Stripe mode applies to this caller."""
    test_mode = is_test_mode_user(current_user)
    # Deliberately uncached. The shared cache has a 24h TTL, which for prices
    # means a pricing change stays invisible for up to a day — the same class of
    # bug as hardcoding them, just slower to notice. Two Stripe reads per modal
    # open is a fair price for always telling the customer the truth.
    return get_price_display(test_mode)


@app.post("/billing/portal")
async def billing_portal(db: Session = Depends(get_db), current_user: User = Depends(require_user)):
    """Open Stripe's customer portal so a subscriber can cancel or update payment."""
    settings = get_settings()
    test_mode = is_test_mode_user(current_user)
    customer_id = current_user.stripe_customer_id

    # Anyone who subscribed before we started recording the customer id still
    # needs a way to cancel, so fall back to looking them up by email.
    if not customer_id:
        try:
            secret_key, _ = stripe_credentials_for(test_mode)
            if secret_key:
                stripe.api_key = secret_key
                found = stripe.Customer.list(email=current_user.email, limit=1).get("data", [])
                if found:
                    customer_id = found[0]["id"]
                    current_user.stripe_customer_id = customer_id
                    db.commit()
                    logger.info("Backfilled Stripe customer %s for user %s", customer_id, current_user.id)
        except Exception as e:
            logger.warning("Customer lookup by email failed for user %s: %s", current_user.id, e)

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


@app.post("/billing/checkout")
async def billing_checkout(body: CheckoutRequest, current_user: User = Depends(require_user)):
    # Allowlisted accounts get test-mode Stripe even on a live deployment, so
    # billing can be exercised with 4242 cards without a separate environment.
    test_mode = is_test_mode_user(current_user)
    try:
        url = create_checkout_session(current_user.id, body.type, test_mode=test_mode)
    except ValueError:
        raise HTTPException(status_code=501, detail="Billing not configured")
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
