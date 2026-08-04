"""Unlimited, credits and BYOK are three separate things.

byok_unlocked once did double duty — it granted unlimited queries and, by its
name, implied the right to store a key. In practice nothing gated key storage at
all, so the $25 product was being given away.
"""
import httpx
import pytest

from services.billing import CREDITS_PER_PACK


@pytest.fixture
def user(make_user):
    return make_user("pytest-entitlements@test.local")


def test_key_storage_is_refused_before_purchase(base_url, user, auth):
    r = httpx.post(f"{base_url}/user/api-key", json={"api_key": "sk-ant-fake"},
                   headers=auth(user), timeout=30)
    assert r.status_code == 402
    assert r.json()["detail"]["byok_required"] is True


def test_subscribing_does_not_grant_key_storage(base_url, user, auth, grant, fresh):
    grant(user, "unlock")
    assert fresh(user).byok_unlocked is True
    assert fresh(user).byok_purchased is False
    r = httpx.post(f"{base_url}/user/api-key", json={"api_key": "sk-ant-fake"},
                   headers=auth(user), timeout=30)
    assert r.status_code == 402, "a subscription must not unlock BYOK"


def test_buying_byok_enables_key_storage(base_url, user, auth, grant, fresh):
    grant(user, "byok")
    assert fresh(user).byok_purchased is True
    r = httpx.post(f"{base_url}/user/api-key", json={"api_key": "sk-ant-wellformed"},
                   headers=auth(user), timeout=30)
    assert r.status_code == 200
    assert fresh(user).encrypted_api_key is not None


def test_cancelling_a_subscription_does_not_revoke_byok(user, grant, send_webhook, fresh):
    grant(user, "unlock")
    grant(user, "byok")
    send_webhook(f"evt_pytest_{user.id}_cancel", "customer.subscription.deleted",
                 {"status": "canceled", "metadata": {"user_id": str(user.id)}})
    assert fresh(user).byok_unlocked is False, "subscription should end"
    assert fresh(user).byok_purchased is True, "a one-time purchase is permanent"


def test_credits_are_independent_of_both(user, grant, fresh):
    grant(user, "credits")
    assert fresh(user).query_credits == CREDITS_PER_PACK


def test_auth_me_reports_each_entitlement_separately(base_url, user, auth, grant):
    grant(user, "byok")
    me = httpx.get(f"{base_url}/auth/me", headers=auth(user), timeout=30).json()["user"]
    assert me["byok_purchased"] is True
    assert me["byok_unlocked"] is False


# ── refusing to sell what is already owned ───────────────────────────────────

# Creating a session calls Stripe, so the tests asserting success are marked
# external. The refusals are pure application logic — the 409 is raised before
# Stripe is touched — so those keep running in CI, which is where the value is.
def checkout(base_url, user, auth, kind):
    return httpx.post(f"{base_url}/billing/checkout", json={"type": kind},
                      headers=auth(user), timeout=60)


@pytest.mark.external
def test_both_products_are_purchasable_when_unowned(base_url, user, auth):
    assert checkout(base_url, user, auth, "unlock").status_code == 200
    assert checkout(base_url, user, auth, "byok").status_code == 200


def test_a_second_subscription_is_refused(base_url, user, auth, grant):
    """Double-clicking checkout produced two live subscriptions on one account."""
    grant(user, "unlock")
    r = checkout(base_url, user, auth, "unlock")
    assert r.status_code == 409
    assert r.json()["detail"]["already_owned"] is True


def test_a_second_byok_purchase_is_refused(base_url, user, auth, grant):
    grant(user, "byok")
    assert checkout(base_url, user, auth, "byok").status_code == 409


@pytest.mark.external
def test_credits_stay_repeatable(base_url, user, auth, grant):
    grant(user, "unlock")
    grant(user, "byok")
    assert checkout(base_url, user, auth, "credits").status_code == 200, "credits are consumable"


@pytest.mark.external
def test_resubscribing_is_allowed_after_cancellation(base_url, user, auth, grant, send_webhook):
    grant(user, "unlock")
    send_webhook(f"evt_pytest_{user.id}_recancel", "customer.subscription.deleted",
                 {"status": "canceled", "metadata": {"user_id": str(user.id)}})
    assert checkout(base_url, user, auth, "unlock").status_code == 200


def test_the_pack_size_is_published_with_the_prices(base_url):
    """The purchase card reads the pack size from here rather than hardcoding
    it. It was hardcoded, and said "50 Queries" for a while after the pack
    became 200 — the card and the receipt disagreeing, with nothing to catch it.
    Same reasoning as reading prices from Stripe instead of typing them in."""
    r = httpx.get(f"{base_url}/billing/prices", timeout=30)
    assert r.status_code == 200
    assert r.json()["credits_per_pack"] == CREDITS_PER_PACK
