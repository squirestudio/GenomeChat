"""Per-client rate limiting and the anonymous query allowance.

Both are in-process, which is deliberate for a single instance and a known
limitation for more than one: a second container would grant each client its own
allowance. Moving to Redis is the fix when that day comes, and the interfaces
here are shaped to make that swap a substitution rather than a rewrite.
"""
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
