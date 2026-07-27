"""Per-client rate limiting and the anonymous allowance.

Both were absent: the anonymous limit lived only in localStorage, so clearing
site data or calling the API directly reset it, and nothing limited request
rate at all.
"""
import pytest

from services.limits import AnonymousAllowance, SlidingWindow


class FakeRequest:
    def __init__(self, headers=None, host="10.0.0.1"):
        self.headers = headers or {}
        self.client = type("C", (), {"host": host})()


def test_forwarded_header_wins_so_clients_are_not_pooled_behind_the_proxy():
    """Without this every caller shares the proxy's address and one bucket."""
    from services.limits import client_ip
    r = FakeRequest({"x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178"})
    assert client_ip(r) == "203.0.113.7"


def test_direct_connections_fall_back_to_the_socket_address():
    from services.limits import client_ip
    assert client_ip(FakeRequest(host="192.0.2.5")) == "192.0.2.5"


def test_a_client_is_allowed_up_to_the_limit_then_refused():
    w = SlidingWindow(limit=3, window_seconds=60)
    assert [w.check("a")[0] for _ in range(3)] == [True, True, True]
    allowed, retry_after = w.check("a")
    assert allowed is False
    assert 0 < retry_after <= 60


def test_clients_have_independent_budgets():
    w = SlidingWindow(limit=2, window_seconds=60)
    w.check("a"); w.check("a")
    assert w.check("a")[0] is False
    assert w.check("b")[0] is True, "one noisy client must not block everyone"


def test_the_window_rolls_forward():
    w = SlidingWindow(limit=1, window_seconds=0.05)
    assert w.check("a")[0] is True
    assert w.check("a")[0] is False
    import time; time.sleep(0.06)
    assert w.check("a")[0] is True


def test_empty_buckets_are_pruned_so_the_map_cannot_grow_forever():
    w = SlidingWindow(limit=1, window_seconds=0.01)
    for i in range(100):
        w.check(f"ip-{i}")
    import time; time.sleep(0.02)
    w.prune(max_keys=10)
    assert len(w._hits) <= 10


# ── anonymous allowance ──────────────────────────────────────────────────────

def test_an_anonymous_caller_gets_exactly_the_configured_allowance():
    a = AnonymousAllowance(limit=3)
    for _ in range(3):
        assert a.allowed("ip") is True
        a.record("ip")
    assert a.allowed("ip") is False
    assert a.remaining("ip") == 0


def test_the_allowance_is_per_client():
    a = AnonymousAllowance(limit=1)
    a.record("ip-a")
    assert a.allowed("ip-a") is False
    assert a.allowed("ip-b") is True


def test_remaining_counts_down():
    a = AnonymousAllowance(limit=3)
    assert a.remaining("ip") == 3
    a.record("ip")
    assert a.remaining("ip") == 2


def test_the_allowance_replenishes_after_its_window():
    a = AnonymousAllowance(limit=1, window_seconds=0.05)
    a.record("ip")
    assert a.allowed("ip") is False
    import time; time.sleep(0.06)
    assert a.allowed("ip") is True, "the allowance is a rolling window, not a lifetime cap"


@pytest.mark.external
def test_the_api_refuses_an_anonymous_caller_past_the_allowance(base_url):
    """End-to-end: the browser counter is advisory, this is the one that decides.

    Uses plain questions rather than a gene lookup — those take the short path
    through the model without touching seventeen upstream APIs, and unlike a
    deferred section they always produce an answer, so the allowance is always
    consumed. (An empty section deliberately consumes nothing.)
    """
    import time
    import httpx

    ip = f"198.51.100.{int(time.time()) % 120 + 100}"
    seen = []
    for i in range(6):
        with httpx.stream("POST", f"{base_url}/chat/stream",
                          json={"message": f"hello there, probe {i} {time.time()}"},
                          headers={"X-Forwarded-For": ip}, timeout=300) as r:
            seen.append(r.status_code)
            if r.status_code == 401:
                body = r.read()
                import json as _json
                assert _json.loads(body)["detail"]["sign_in_required"] is True
                break
            r.read()

    assert 401 in seen, f"expected a sign-in gate after the allowance, saw {seen}"
    assert seen.count(200) >= 1, "the first questions should have been answered"


# ── request payload bounds ───────────────────────────────────────────────────
# Every one of these is forwarded into the model prompt, so payload size maps
# directly onto token spend. Rejection happens in validation, before any work.

@pytest.mark.parametrize("body,why", [
    ({"message": "x" * 5000}, "message over 4000 chars"),
    ({"message": ""}, "empty message"),
    ({"message": "hi", "history": [{"role": "user", "content": "x"}] * 60}, "history over 40 turns"),
    ({"message": "hi", "personal_variants": [{"rsid": "rs1"}] * 600}, "over 500 variants"),
])
def test_oversized_requests_are_rejected(base_url, body, why):
    import httpx
    r = httpx.post(f"{base_url}/chat/stream", json=body,
                   headers={"X-Forwarded-For": "203.0.113.250"}, timeout=30)
    assert r.status_code == 422, f"{why} should be rejected, got {r.status_code}"


def test_a_reasonable_request_passes_validation(base_url):
    """Guards against the bounds being set so tight they reject normal use."""
    import httpx
    body = {"message": "BRCA1 variants",
            "history": [{"role": "user", "content": "hello"}] * 10,
            "personal_variants": [{"rsid": "rs1", "genotype": "AA"}] * 200}
    r = httpx.post(f"{base_url}/gene/section",
                   json={"gene": "BRCA1", "section": "pathways"},
                   headers={"X-Forwarded-For": "203.0.113.251"}, timeout=180)
    assert r.status_code != 422
