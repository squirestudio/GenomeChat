"""Access follows the subscription's status, both ways."""
import pytest


@pytest.fixture
def subscriber(make_user, grant, fresh):
    u = make_user("pytest-subscriber@test.local")
    grant(u, "unlock")
    assert fresh(u).byok_unlocked is True
    return u


def sub_event(send_webhook, user, status, suffix, customer=None):
    obj = {"status": status, "metadata": {"user_id": str(user.id)}}
    if customer:
        obj["customer"] = customer
    etype = "customer.subscription.deleted" if status == "canceled" else "customer.subscription.updated"
    return send_webhook(f"evt_pytest_{user.id}_{suffix}", etype, obj)


def test_an_active_subscription_keeps_access(subscriber, send_webhook, fresh):
    sub_event(send_webhook, subscriber, "active", "active")
    assert fresh(subscriber).byok_unlocked is True


def test_cancellation_revokes_access(subscriber, send_webhook, fresh):
    r = sub_event(send_webhook, subscriber, "canceled", "cancel")
    assert r.status_code == 200
    assert fresh(subscriber).byok_unlocked is False


def test_past_due_revokes_access(subscriber, send_webhook, fresh):
    sub_event(send_webhook, subscriber, "past_due", "pastdue")
    assert fresh(subscriber).byok_unlocked is False


def test_reactivation_restores_access(subscriber, send_webhook, fresh):
    sub_event(send_webhook, subscriber, "canceled", "cancel2")
    sub_event(send_webhook, subscriber, "active", "reactivate")
    assert fresh(subscriber).byok_unlocked is True


def test_an_event_without_metadata_changes_nothing(subscriber, send_webhook, fresh):
    """Stripe's own test fixtures carry empty metadata; that must not revoke anyone."""
    before = fresh(subscriber).byok_unlocked
    r = send_webhook(f"evt_pytest_{subscriber.id}_nometa", "customer.subscription.deleted",
                     {"status": "canceled", "metadata": {}})
    assert r.status_code == 200
    assert fresh(subscriber).byok_unlocked is before
