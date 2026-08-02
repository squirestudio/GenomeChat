"""Reference data that arrives as a file rather than an API.

A few sources publish everything as one download and offer no per-gene
endpoint. GenCC is the first; Orphanet's gene product would be the second if it
is ever wanted. Both want the same handling, so this is the mechanism rather
than a loader bolted onto one fetcher.

Three things it has to get right:

**Fetch once.** The download is tens of megabytes. A cold process serving three
simultaneous requests must not start three downloads, hence the lock — and the
second and third callers wait for the first rather than each paying the cost.

**Keep only what is used.** The GenCC export is 26 MB across thirty columns; the
five that matter are a few megabytes once parsed, and interning the repeated
ones (nineteen submitters, nine classifications across thirty thousand rows)
takes it lower again. The file size is a bad estimate of the resident cost, and
was the reason this looked more expensive than it is.

**Fail like a fetcher.** Same contract as everything in genomics_api_real: an
unreachable source returns empty and the answer is still well-formed. A missing
index must never be the reason a gene query fails.

The index is per-process and dies on redeploy, exactly like the answer cache.
That is a rebuild on the next cold request, not a correctness problem.
"""
import asyncio
import csv
import io
import logging
import time
from typing import Callable, Optional

import httpx

logger = logging.getLogger(__name__)

# Generous: this is a multi-megabyte download on a cold process, and giving up
# early just means every later request retries it.
DOWNLOAD_TIMEOUT = 120.0

# Long, because these are curated releases that change on the order of weeks,
# and short enough that a months-old process is not serving stale science.
DEFAULT_TTL_SECONDS = 7 * 24 * 3600


class BulkIndex:
    """A lazily-fetched, gene-keyed index over a downloaded table."""

    def __init__(self, name: str, url: str, build: Callable[[str], dict],
                 ttl_seconds: float = DEFAULT_TTL_SECONDS):
        self.name = name
        self.url = url
        self._build = build
        self._ttl = ttl_seconds
        self._data: Optional[dict] = None
        self._loaded_at = 0.0
        self._lock = asyncio.Lock()
        self._failed_at = 0.0

    @property
    def loaded(self) -> bool:
        return self._data is not None and (time.time() - self._loaded_at) < self._ttl

    async def get(self, key: str) -> list:
        """Rows for one key, or [] — including when the source is unreachable."""
        data = await self._ensure()
        return data.get(key.strip().upper(), []) if data else []

    async def _ensure(self) -> Optional[dict]:
        if self.loaded:
            return self._data
        # A failed download is not retried immediately: a source that is down
        # stays down for a few minutes, and hammering it on every query turns
        # one outage into a self-inflicted second one.
        if self._failed_at and time.time() - self._failed_at < 300:
            return self._data
        async with self._lock:
            # Re-check: another request may have finished while this one waited,
            # which is the entire point of the lock.
            if self.loaded:
                return self._data
            try:
                started = time.time()
                async with httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
                    r = await client.get(self.url)
                    r.raise_for_status()
                    text = r.text
                self._data = self._build(text)
                self._loaded_at = time.time()
                self._failed_at = 0.0
                logger.info("%s index built: %d keys, %.1f MB downloaded, %.1fs",
                            self.name, len(self._data), len(text) / 1e6, time.time() - started)
            except Exception as e:
                self._failed_at = time.time()
                logger.warning("%s index unavailable: %s", self.name, e)
        return self._data


def index_tsv_by(text: str, key_column: str, keep: tuple[str, ...]) -> dict:
    """Group a TSV into {KEY: [dict of kept columns]}, interning repeated values.

    Interning matters more than it looks: across thirty thousand rows there are
    nineteen distinct submitters and nine distinct classifications, so without
    it the index holds thirty thousand copies of the same handful of strings.
    """
    out: dict[str, list] = {}
    pool: dict[str, str] = {}

    def intern(v: str) -> str:
        got = pool.get(v)
        if got is None:
            pool[v] = v
            return v
        return got

    reader = csv.DictReader(io.StringIO(text), delimiter="\t")
    for row in reader:
        key = (row.get(key_column) or "").strip().upper()
        if not key:
            continue
        out.setdefault(key, []).append({c: intern((row.get(c) or "").strip()) for c in keep})
    return out
