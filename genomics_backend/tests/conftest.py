"""Shared fixtures.

Three kinds of test live here:

  unit      pure logic, no database, no server        — always runnable
  service   needs the app and Postgres, no internet   — runnable in CI
  external  reaches real upstream APIs (NCBI, Ensembl, Anthropic)

Only `external` is excluded by default, because those tests are as slow and as
flaky as the sources they call. Everything else runs on every push.
"""
import hashlib
import hmac
import json
import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("MYDNA_TEST_BASE_URL", "http://localhost:8000")


def pytest_configure(config):
    config.addinivalue_line("markers", "external: reaches real upstream APIs; slow and networked")


@pytest.fixture(scope="session")
def base_url():
    """The running API. Skips the whole session if nothing is listening."""
    try:
        r = httpx.get(f"{BASE_URL}/health", timeout=5)
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001 - any failure means "no server"
        pytest.skip(f"API not reachable at {BASE_URL} ({e})")
    return BASE_URL


@pytest.fixture(scope="session")
def settings():
    from config import get_settings
    return get_settings()


@pytest.fixture
def db():
    from database.models import SessionLocal
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def make_user(db):
    """Create throwaway accounts, and clean them up even if a test fails."""
    from database.models import User, Query as QueryModel, ProcessedStripeEvent
    created = []

    def _make(email=None, **fields):
        from database.models import User as U
        email = email or f"pytest-{int(time.time()*1000)}-{len(created)}@test.local"
        user = db.query(U).filter(U.email == email).first()
        if not user:
            user = U(email=email, name="pytest")
            db.add(user)
            db.commit()
            db.refresh(user)
        defaults = dict(byok_unlocked=False, byok_purchased=False, encrypted_api_key=None,
                        query_credits=0, total_queries=0, stripe_customer_id=None)
        for k, v in {**defaults, **fields}.items():
            setattr(user, k, v)
        db.commit()
        created.append(user.id)
        return user

    yield _make

    for uid in created:
        db.query(QueryModel).filter(QueryModel.user_id == uid).delete(synchronize_session=False)
        db.query(ProcessedStripeEvent).filter(
            ProcessedStripeEvent.event_id.like(f"evt_pytest_{uid}_%")
        ).delete(synchronize_session=False)
        db.commit()
        row = db.query(User).filter(User.id == uid).first()
        if row:
            db.delete(row)
    db.commit()


@pytest.fixture
def auth():
    """Bearer headers for a user."""
    from auth import create_jwt

    def _auth(user):
        return {"Authorization": f"Bearer {create_jwt(user.id, user.email)}"}

    return _auth


@pytest.fixture
def fresh(db):
    """Re-read a user, discarding anything the session has cached."""
    from database.models import User

    def _fresh(user):
        db.expire_all()
        return db.query(User).filter(User.id == user.id).first()

    return _fresh


@pytest.fixture
def send_webhook(base_url, settings):
    """Post a correctly signed Stripe event, exactly as Stripe would."""

    def _send(event_id, event_type, obj):
        payload = json.dumps({"id": event_id, "type": event_type, "data": {"object": obj}})
        ts = int(time.time())
        sig = hmac.new(
            settings.stripe_webhook_secret.encode(),
            f"{ts}.{payload}".encode(),
            hashlib.sha256,
        ).hexdigest()
        return httpx.post(
            f"{base_url}/billing/webhook",
            content=payload,
            headers={"Content-Type": "application/json", "stripe-signature": f"t={ts},v1={sig}"},
            timeout=30,
        )

    return _send


@pytest.fixture
def grant(send_webhook):
    """Grant an entitlement the way a completed checkout does."""

    def _grant(user, purchase_type, event_id=None):
        eid = event_id or f"evt_pytest_{user.id}_{purchase_type}_{int(time.time()*1000)}"
        return send_webhook(eid, "checkout.session.completed",
                            {"metadata": {"user_id": str(user.id), "purchase_type": purchase_type}})

    return _grant
