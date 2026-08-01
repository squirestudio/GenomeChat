"""`POST /documents/extract` — the one path where an uploaded file leaves the device.

Three things make this endpoint worth its own file. It is **gated**, because a
document about someone's condition is health data and consent has to be
recorded against an account. It is **charged**, unlike everything else the
reader's own data touches, because a vision call costs real money per page. And
it is **the exception to "nothing leaves your browser"** — a PDF with a text
layer never leaves, a photograph does, and the upload copy says which.

The success path is marked `external`: it makes a real vision call, and the
contract is what is asserted — status, shape, and that exactly one credit is
spent. Transcription *quality* is not testable here and is not attempted;
that was verified by hand against a photographed journal page.
"""
import struct
import zlib

import httpx
import pytest

from services.billing import FREE_QUERY_LIMIT

TIMEOUT = 120


def _png(width=120, height=60):
    """A small valid PNG, built here so the suite carries no binary fixture."""
    raw = b"".join(b"\x00" + b"\xff\xff\xff" * width for _ in range(height))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


@pytest.fixture
def page_image():
    import base64
    return base64.b64encode(_png()).decode()


def extract(base_url, headers=None, **body):
    return httpx.post(f"{base_url}/documents/extract", json=body,
                      headers=headers or {}, timeout=TIMEOUT)


# ── the gate ─────────────────────────────────────────────────────────────────

def test_a_signed_out_visitor_cannot_extract(base_url, page_image):
    """Not a paywall. A paper about someone's own condition is health data,
    processed on explicit consent, and consent needs an account to attach to —
    the same reasoning as DNA upload."""
    assert extract(base_url, images=[page_image]).status_code == 401


# ── the bounds ───────────────────────────────────────────────────────────────

def _exhausted(make_user):
    return make_user(total_queries=FREE_QUERY_LIMIT, query_credits=0, byok_unlocked=False)


def test_an_empty_request_is_refused(base_url, make_user, auth):
    user = make_user()
    assert extract(base_url, auth(user), images=[]).status_code == 422


def test_more_pages_than_the_ceiling_are_refused(base_url, make_user, auth, page_image):
    """Vision is the costliest call in the app, so the page count is bounded in
    the schema rather than trusted from the client."""
    user = make_user()
    r = extract(base_url, auth(user), images=[page_image] * 9)
    assert r.status_code == 422


def test_the_ceiling_itself_is_allowed(base_url, make_user, auth, page_image):
    """Eight pages must not 422 — a bound that rejects its own limit is an
    off-by-one nobody notices until a reader uploads a long article.

    Deliberately run on an account with no quota left. Pydantic validates the
    body before the handler runs, so a 402 proves the schema accepted eight
    pages; using a funded account here would have this CI test quietly make a
    real eight-page vision call every push."""
    user = _exhausted(make_user)
    r = extract(base_url, auth(user), images=[page_image] * 8)
    assert r.status_code == 402


# ── the charge ───────────────────────────────────────────────────────────────

def test_an_account_out_of_quota_is_refused(base_url, make_user, auth, page_image):
    r = extract(base_url, auth(_exhausted(make_user)), images=[page_image])
    assert r.status_code == 402
    assert r.json()["detail"]["upgrade_required"] is True


def test_the_refusal_names_the_free_alternative(base_url, make_user, auth, page_image):
    """Someone out of credits should be told that a text PDF still costs
    nothing, rather than concluding the whole feature is behind the paywall."""
    r = extract(base_url, auth(_exhausted(make_user)), images=[page_image])
    assert "free" in r.json()["detail"]["message"].lower()


def test_a_refused_extraction_charges_nothing(base_url, make_user, auth, fresh, page_image):
    """The quota check runs before the vision call, so a blocked request must
    cost neither money nor a credit."""
    user = make_user(total_queries=FREE_QUERY_LIMIT, query_credits=0)
    extract(base_url, auth(user), images=[page_image])
    after = fresh(user)
    assert after.total_queries == FREE_QUERY_LIMIT
    assert (after.query_credits or 0) == 0


# ── the real call ────────────────────────────────────────────────────────────

@pytest.mark.external
def test_a_page_is_transcribed_and_charged_once(base_url, make_user, auth, fresh, page_image):
    user = make_user(query_credits=5, total_queries=0)
    r = extract(base_url, auth(user), images=[page_image], media_type="image/png")
    assert r.status_code == 200, r.text

    body = r.json()
    assert body["pages"] == 1
    assert body["charged"] is True
    assert isinstance(body["text"], str)

    after = fresh(user)
    assert after.query_credits == 4, "exactly one credit per call"
    assert after.total_queries == 1


@pytest.mark.external
def test_the_image_is_not_echoed_back(base_url, make_user, auth, page_image):
    """The response carries the transcription and nothing else. An endpoint
    that returns the upload is one refactor away from logging it."""
    user = make_user(query_credits=2)
    r = extract(base_url, auth(user), images=[page_image], media_type="image/png")
    assert r.status_code == 200
    assert set(r.json()) == {"text", "pages", "charged"}
    assert page_image not in r.text
