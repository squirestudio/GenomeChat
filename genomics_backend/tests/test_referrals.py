"""Referral credits, and the guards that bound what they cost.

Promoted as "get up to 150 free credits". A credit is $0.0128 of model tokens,
so the cap costs at most $1.92 per account plus up to $0.26 for each referee's
free tier — roughly $2.70 of exposure for someone farming the maximum. The tests
that matter here are the ones pinning that ceiling in place.
"""
import httpx
import pytest

from database.models import User
from services.billing import (
    ensure_referral_code, credit_referral, REFERRAL_CREDITS, REFERRAL_CAP,
)


@pytest.fixture
def referrer(db, make_user):
    u = make_user("referrer@example.com")
    ensure_referral_code(u, db)
    db.refresh(u)
    return u


def _join_via(db, make_user, email, code):
    """A new account arriving with a referral code, as OAuth signup does it."""
    u = make_user(email)
    credit_referral(u, code, db)
    db.refresh(u)
    return u


def test_a_code_is_random_rather_than_derived(db, make_user):
    """A code that encodes an id or an email leaks one when it is shared."""
    a = make_user("code-a@example.com")
    b = make_user("code-b@example.com")
    ca, cb = ensure_referral_code(a, db), ensure_referral_code(b, db)
    assert ca and cb and ca != cb
    for code, u in ((ca, a), (cb, b)):
        assert str(u.id) not in code
        assert u.email.split("@")[0] not in code


def test_the_code_is_stable_once_issued(db, referrer):
    assert ensure_referral_code(referrer, db) == referrer.referral_code


def test_credit_lands_when_the_code_is_used(db, make_user, referrer):
    before = referrer.query_credits or 0
    _join_via(db, make_user, "referee1@example.com", referrer.referral_code)
    db.refresh(referrer)
    assert (referrer.query_credits or 0) == before + REFERRAL_CREDITS
    assert referrer.referrals_converted == 1


def test_nothing_records_who_joined_through_whom(db, make_user, referrer):
    """The property the whole design exists for.

    A durable "A referred B" is a social graph, and in a genomics product that
    is a real inference — people refer family, and genetics is familial. An
    earlier version parked the code on the referee's row until their first
    question; crediting at signup means no column holds it at all.
    """
    referee = _join_via(db, make_user, "referee-graph@example.com", referrer.referral_code)
    db.refresh(referee)
    for column in referee.__table__.columns.keys():
        if column == "referral_code":
            continue  # the referee's own code, not the referrer's
        assert getattr(referee, column) != referrer.referral_code, column


def test_the_cap_holds(db, make_user, referrer):
    """The ceiling on what farming can earn, which is the whole cost control."""
    for i in range(REFERRAL_CAP + 2):
        _join_via(db, make_user, f"capped{i}@example.com", referrer.referral_code)
    db.refresh(referrer)
    assert referrer.referrals_converted == REFERRAL_CAP
    assert (referrer.query_credits or 0) == REFERRAL_CREDITS * REFERRAL_CAP


def test_an_established_account_cannot_claim_a_code(db, make_user, referrer):
    """Sign up, use it for months, then try to attach a friend's code."""
    old = make_user("established@example.com")
    old.total_queries = 7
    db.commit()
    assert credit_referral(old, referrer.referral_code, db) is False
    db.refresh(referrer)
    assert referrer.referrals_converted == 0


def test_nobody_can_refer_themselves(db, make_user, referrer):
    assert credit_referral(referrer, referrer.referral_code, db) is False
    db.refresh(referrer)
    assert (referrer.referrals_converted or 0) == 0


def test_an_unknown_code_is_ignored_rather_than_erroring(db, make_user):
    u = make_user("badcode@example.com")
    assert credit_referral(u, "notarealcode", db) is False
    assert credit_referral(u, "", db) is False


def test_auth_me_publishes_the_code_and_progress(base_url, db, make_user, auth):
    u = make_user("me-referral@example.com")
    r = httpx.get(f"{base_url}/auth/me", headers=auth(u), timeout=30)
    assert r.status_code == 200
    body = r.json()["user"]
    assert body["referral_code"]
    assert body["referrals_converted"] == 0
    assert body["referral_cap"] == REFERRAL_CAP
    assert body["referral_credits"] == REFERRAL_CREDITS
