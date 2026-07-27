from collections import OrderedDict
from datetime import datetime, timedelta
from typing import Any, Optional
import hashlib
import json


class LRUCache:
    def __init__(self, max_size: int = 1000, ttl_hours: int = 24):
        self.max_size = max_size
        self.ttl = timedelta(hours=ttl_hours)
        self._cache: OrderedDict[str, tuple[Any, datetime]] = OrderedDict()

    def _make_key(self, query: str) -> str:
        return hashlib.md5(query.strip().lower().encode()).hexdigest()

    def get(self, query: str) -> Optional[Any]:
        key = self._make_key(query)
        if key not in self._cache:
            return None
        value, timestamp, expiry = self._cache[key]
        if datetime.utcnow() - timestamp > expiry:
            del self._cache[key]
            return None
        self._cache.move_to_end(key)
        return value

    def set(self, query: str, value: Any, ttl_hours: Optional[float] = None) -> None:
        """Store a value. ttl_hours overrides the default for this entry.

        A shorter TTL is useful for negative results: "this source had nothing
        for this gene" should be rechecked sooner than a populated answer needs
        refreshing, because upstream databases gain entries over time and a
        stale negative silently hides something that now exists.
        """
        key = self._make_key(query)
        if key in self._cache:
            self._cache.move_to_end(key)
        expiry = timedelta(hours=ttl_hours) if ttl_hours is not None else self.ttl
        self._cache[key] = (value, datetime.utcnow(), expiry)
        if len(self._cache) > self.max_size:
            self._cache.popitem(last=False)

    def size(self) -> int:
        return len(self._cache)

    def clear(self) -> None:
        self._cache.clear()

    def stats(self) -> dict:
        now = datetime.utcnow()
        valid = sum(
            1 for _, (_, ts, exp) in self._cache.items()
            if now - ts <= exp
        )
        return {
            "total_entries": len(self._cache),
            "valid_entries": valid,
            "expired_entries": len(self._cache) - valid,
            "max_size": self.max_size,
            "ttl_hours": round(self.ttl.total_seconds() / 3600, 1),
        }


cache = LRUCache()
