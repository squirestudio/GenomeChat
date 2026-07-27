"""Stripe delivers at-least-once; grants are additive, so replays must not stack."""
import time

import httpx
import pytest


@pytest.fixture
def user(make_user):
    return make_user("pytest-idempotency@test.local")


def test_one_event_grants_once_no_matter_how_often_it_arrives(user, grant, fresh):
    eid = f"evt_pytest_{user.id}_replay"
    first = grant(user, "credits", event_id=eid)
    assert first.status_code == 200
    assert first.json().get("duplicate") is not True
    assert fresh(user).query_credits == 50

    for _ in range(3):
        again = grant(user, "credits", event_id=eid)
        assert again.status_code == 200, "Stripe must not see an error, or it keeps retrying"
        assert again.json()["duplicate"] is True
    assert fresh(user).query_credits == 50, "replays must not stack"


def test_a_genuinely_new_event_grants_again(user, grant, fresh):
    grant(user, "credits", event_id=f"evt_pytest_{user.id}_a")
    grant(user, "credits", event_id=f"evt_pytest_{user.id}_b")
    assert fresh(user).query_credits == 100


def test_an_event_for_an_unknown_user_still_returns_200(base_url, send_webhook):
    """A non-2xx would make Stripe retry an event that can never succeed."""
    r = send_webhook(f"evt_pytest_ghost_{int(time.time())}", "checkout.session.completed",
                     {"metadata": {"user_id": "99999999", "purchase_type": "credits"}})
    assert r.status_code == 200


def test_a_forged_signature_is_rejected(base_url):
    r = httpx.post(f"{base_url}/billing/webhook", content='{"id":"evt_bad","type":"x"}',
                   headers={"Content-Type": "application/json", "stripe-signature": "t=1,v1=bad"},
                   timeout=30)
    assert r.status_code == 400
