"""Every answered query is metered, including cached ones.

Marked external because it drives the real pipeline. This is the suite that
would have caught the bug where no authenticated user was ever charged: the
streaming generator ran after FastAPI closed the request session, so
consume_query mutated a detached object and committed nothing.
"""
import json
import time

import httpx
import pytest

pytestmark = pytest.mark.external


@pytest.fixture
def user(make_user):
    return make_user("pytest-metering@test.local", query_credits=10)


def ask(base_url, headers, message):
    """Drive /chat/stream to completion; returns whether it was served from cache."""
    was_cached, event = None, None
    with httpx.stream("POST", f"{base_url}/chat/stream", json={"message": message},
                      headers=headers, timeout=300) as r:
        assert r.status_code == 200
        for line in r.iter_lines():
            if line.startswith("event: "):
                event = line[7:].strip()
            elif line.startswith("data: ") and event == "done":
                was_cached = json.loads(line[6:]).get("cached")
    return was_cached


def test_a_query_is_charged_and_counted_once_fresh_and_once_cached(base_url, user, auth, fresh):
    headers = auth(user)
    question = f"BRCA1 pathogenic variants metering probe {int(time.time())}"

    assert ask(base_url, headers, question) is False
    assert fresh(user).query_credits == 9
    assert fresh(user).total_queries == 1

    assert ask(base_url, headers, question) is True, "the same question should now be cached"
    assert fresh(user).query_credits == 8, "a cached answer is still an answer"
    assert fresh(user).total_queries == 2


def test_a_subscriber_is_not_charged_but_usage_is_recorded(base_url, user, auth, grant, fresh, db):
    grant(user, "unlock")
    headers = auth(user)
    before = fresh(user).query_credits
    ask(base_url, headers, f"TP53 variants metering probe {int(time.time())}")
    assert fresh(user).query_credits == before
    assert fresh(user).total_queries >= 1
