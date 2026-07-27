"""The two email allowlists, and the fact that neither leaks into the other.

UNLIMITED_EMAILS bypasses the quota; STRIPE_TEST_EMAILS switches checkout to
Stripe test mode. They are separate because an account that never reaches the
paywall can never exercise the purchase flow.
"""
import pytest

import config
from config import Settings
from services import billing


class FakeUser:
    def __init__(self, email, **kw):
        self.email = email
        self.byok_unlocked = False
        self.byok_purchased = False
        self.encrypted_api_key = None
        self.query_credits = 0
        self.total_queries = 0
        self.__dict__.update(kw)


class FakeDB:
    def commit(self):
        pass


@pytest.fixture
def configure(monkeypatch):
    """Swap in a Settings instance without touching the real environment."""
    def _configure(**kw):
        base = dict(
            stripe_secret_key="sk_live_x", stripe_webhook_secret="whsec_live",
            stripe_price_unlock="price_live_u", stripe_price_credits="price_live_c",
            stripe_test_secret_key="sk_test_x", stripe_test_webhook_secret="whsec_test",
            stripe_test_price_unlock="price_test_u", stripe_test_price_credits="price_test_c",
            stripe_test_emails="", unlimited_emails="",
        )
        base.update(kw)
        s = Settings(**base)
        monkeypatch.setattr(config, "get_settings", lambda: s)
        monkeypatch.setattr(billing, "get_settings", lambda: s)
        return s
    return _configure


# ── test-mode allowlist ──────────────────────────────────────────────────────

@pytest.mark.parametrize("email,expected", [
    ("me@example.com", True),
    ("ME@Example.COM", True),          # case
    ("  me@example.com  ", True),      # whitespace
    ("other@example.com", True),       # second entry
    ("customer@example.com", False),
    ("notme@example.com", False),      # must not substring-match
])
def test_test_mode_matching(configure, email, expected):
    configure(stripe_test_emails="me@example.com, other@example.com")
    assert billing.is_test_mode_user(FakeUser(email)) is expected


def test_no_user_is_never_test_mode(configure):
    configure(stripe_test_emails="me@example.com")
    assert billing.is_test_mode_user(None) is False
    assert billing.is_test_mode_user(FakeUser(None)) is False


def test_empty_allowlist_means_nobody(configure):
    configure(stripe_test_emails="")
    assert billing.is_test_mode_user(FakeUser("me@example.com")) is False


@pytest.mark.parametrize("missing", ["stripe_test_secret_key", "stripe_test_price_credits"])
def test_allowlisted_but_unconfigured_falls_back_to_live(configure, missing):
    """A broken test setup must not produce a broken checkout."""
    configure(stripe_test_emails="me@example.com", **{missing: ""})
    assert billing.is_test_mode_user(FakeUser("me@example.com")) is False


def test_credentials_follow_the_mode(configure):
    configure(stripe_test_emails="me@example.com")
    key, prices = billing.stripe_credentials_for(False)
    assert (key, prices["unlock"]) == ("sk_live_x", "price_live_u")
    key, prices = billing.stripe_credentials_for(True)
    assert (key, prices["unlock"]) == ("sk_test_x", "price_test_u")


# ── unlimited allowlist ──────────────────────────────────────────────────────

def test_allowlisted_account_bypasses_the_quota(configure):
    configure(unlimited_emails="me@example.com")
    allowed, reason = billing.user_can_query(FakeUser("me@example.com", total_queries=99999))
    assert (allowed, reason) == (True, "unlimited")


def test_ordinary_over_quota_account_is_blocked(configure):
    configure(unlimited_emails="me@example.com")
    allowed, reason = billing.user_can_query(FakeUser("customer@example.com", total_queries=99999))
    assert (allowed, reason) == (False, "blocked")


def test_allowlisted_accounts_do_not_spend_credits(configure):
    configure(unlimited_emails="me@example.com")
    u = FakeUser("me@example.com", query_credits=5)
    billing.consume_query(u, FakeDB())
    assert u.query_credits == 5
    assert u.total_queries == 1, "usage is still recorded"


def test_ordinary_accounts_do_spend_credits(configure):
    configure(unlimited_emails="me@example.com")
    u = FakeUser("customer@example.com", query_credits=5)
    billing.consume_query(u, FakeDB())
    assert u.query_credits == 4


def test_the_two_lists_are_independent(configure):
    configure(stripe_test_emails="me@example.com", unlimited_emails="")
    assert billing.is_unlimited_user(FakeUser("me@example.com")) is False
    configure(unlimited_emails="me@example.com", stripe_test_emails="")
    assert billing.is_test_mode_user(FakeUser("me@example.com")) is False


# ── webhook signature acceptance ─────────────────────────────────────────────

def test_either_signing_secret_verifies_but_forgery_does_not(configure):
    import hashlib, hmac, json, time
    configure()
    body = json.dumps({"id": "evt_1", "type": "checkout.session.completed"})

    def signed(secret):
        ts = int(time.time())
        sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
        return f"t={ts},v1={sig}"

    event, is_test = billing.verify_webhook(body.encode(), signed("whsec_live"))
    assert (event["id"], is_test) == ("evt_1", False)
    event, is_test = billing.verify_webhook(body.encode(), signed("whsec_test"))
    assert (event["id"], is_test) == ("evt_1", True)
    with pytest.raises(Exception):
        billing.verify_webhook(body.encode(), signed("whsec_wrong"))
