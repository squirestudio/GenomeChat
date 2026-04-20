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
        value, timestamp = self._cache[key]
        if datetime.utcnow() - timestamp > self.ttl:
            del self._cache[key]
            return None
        self._cache.move_to_end(key)
        return value

    def set(self, query: str, value: Any) -> None:
        key = self._make_key(query)
        if key in self._cache:
            self._cache.move_to_end(key)
        self._cache[key] = (value, datetime.utcnow())
        if len(self._cache) > self.max_size:
            self._cache.popitem(last=False)

    def size(self) -> int:
        return len(self._cache)

    def clear(self) -> None:
        self._cache.clear()

    def stats(self) -> dict:
        now = datetime.utcnow()
        valid = sum(
            1 for _, (_, ts) in self._cache.items()
            if now - ts <= self.ttl
        )
        return {
            "total_entries": len(self._cache),
            "valid_entries": valid,
            "expired_entries": len(self._cache) - valid,
            "max_size": self.max_size,
            "ttl_hours": self.ttl.seconds // 3600,
        }


cache = LRUCache()
