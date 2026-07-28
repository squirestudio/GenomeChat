"""Per-client rate limiting and the anonymous query allowance.

State is in-process by default, which is correct for one container and wrong for
two: each would grant every client its own full allowance, and — more seriously
— each would run its own NCBI rate limiter, so together they would exceed the
cap that NCBI enforces. That is what made ClinVar return nothing.

Set REDIS_URL and the counters move to Redis, shared across instances. Nothing
else changes. Scaling out is then a configuration change rather than a silent
correctness change, which is the point: the failure mode of getting this wrong
is invisible, so it should not depend on remembering.
"""
import logging
import os
import time
from collections import defaultdict, deque
from typing import Optional

from fastapi import Request


def client_ip(request: Request) -> str:
    """The caller's address, as seen from behind Railway's proxy.

    request.client.host is the proxy, so every caller would share one bucket.
    X-Forwarded-For is appended to by each hop; the left-most entry is the
    original client. It is spoofable in general, which is why this is a fairness
    measure and a cost brake — not an authentication boundary.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class SlidingWindow:
    """Counts events per key over a rolling window."""

    def __init__(self, limit: int, window_seconds: float):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque] = defaultdict(deque)

    def check(self, key: str) -> tuple[bool, float]:
        """(allowed, seconds_until_retry). Records the hit when allowed."""
        now = time.monotonic()
        hits = self._hits[key]
        cutoff = now - self.window
        while hits and hits[0] < cutoff:
            hits.popleft()
        if len(hits) >= self.limit:
            return False, max(0.0, hits[0] + self.window - now)
        hits.append(now)
        return True, 0.0

    def prune(self, max_keys: int = 50_000) -> None:
        """Drop empty buckets so the map cannot grow without bound."""
        if len(self._hits) <= max_keys:
            return
        now = time.monotonic()
        cutoff = now - self.window
        for key in [k for k, v in self._hits.items() if not v or v[-1] < cutoff]:
            self._hits.pop(key, None)


class AnonymousAllowance:
    """How many questions an unauthenticated caller may ask before signing in.

    The browser keeps its own counter to show the sign-in prompt at the right
    moment, but that lives in localStorage — clearing site data, or calling the
    API directly, resets it. This is the copy that actually decides.
    """

    def __init__(self, limit: int, window_seconds: float = 24 * 3600):
        self.limit = limit
        self.window = window_seconds
        self._used: dict[str, deque] = defaultdict(deque)

    def _current(self, key: str) -> deque:
        used = self._used[key]
        cutoff = time.monotonic() - self.window
        while used and used[0] < cutoff:
            used.popleft()
        return used

    def remaining(self, key: str) -> int:
        return max(0, self.limit - len(self._current(key)))

    def allowed(self, key: str) -> bool:
        return len(self._current(key)) < self.limit

    def record(self, key: str) -> None:
        self._current(key).append(time.monotonic())


# ─── Shared backing store ─────────────────────────────────────────────────────

def _redis_client():
    """A Redis client if REDIS_URL is set and reachable, otherwise None.

    Checked once at import. A Redis that disappears later degrades to
    per-process counting rather than failing requests — a limiter that takes
    the site down when its store blinks is worse than one that briefly counts
    per instance.
    """
    url = os.environ.get("REDIS_URL", "").strip()
    if not url:
        return None
    try:
        import redis  # optional dependency; absent unless someone installs it
        client = redis.Redis.from_url(url, socket_timeout=2, socket_connect_timeout=2)
        client.ping()
        logging.getLogger(__name__).info("Limits: using Redis at %s", url.split("@")[-1])
        return client
    except Exception as e:
        logging.getLogger(__name__).warning(
            "Limits: REDIS_URL set but unusable (%s) — counting per process", e)
        return None


_redis = _redis_client()


def shared_backend_active() -> bool:
    """True when counters are shared across instances."""
    return _redis is not None


class SharedWindow:
    """A sliding window backed by Redis, for multi-instance deployments.

    Falls back to the local window on any Redis error, so an outage in the
    counter store degrades fairness rather than availability.
    """

    def __init__(self, limit: int, window_seconds: float, namespace: str):
        self.limit = limit
        self.window = window_seconds
        self.namespace = namespace
        self._local = SlidingWindow(limit, window_seconds)

    def check(self, key: str) -> tuple[bool, float]:
        if _redis is None:
            return self._local.check(key)
        try:
            full_key = f"{self.namespace}:{key}"
            count = _redis.incr(full_key)
            if count == 1:
                _redis.expire(full_key, int(self.window) + 1)
            if count > self.limit:
                return False, float(_redis.ttl(full_key) or self.window)
            return True, 0.0
        except Exception:
            return self._local.check(key)

    def prune(self, max_keys: int = 50_000) -> None:
        self._local.prune(max_keys)   # Redis expires its own keys
