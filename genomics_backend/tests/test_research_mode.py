"""Research mode is gated, and fails closed.

The mode produces open-ended, generated commentary over computed findings. That
is appropriate for a researcher who has been told what they are looking at, and
not for someone who wandered in — so the gate matters more than it would for an
ordinary feature.
"""
import httpx
import pytest

from config import get_settings


def _unlock(base_url, headers, password):
    return httpx.post(f"{base_url}/research/unlock", headers=headers,
                      json={"password": password}, timeout=30)


def test_unlocking_requires_an_account(base_url):
    """Anonymous callers cannot reach it at all."""
    assert _unlock(base_url, None, "anything").status_code in (401, 403)


def test_a_wrong_password_does_not_unlock(base_url, make_user, auth):
    u = make_user("research-wrong@example.com")
    r = _unlock(base_url, auth(u), "definitely-not-the-password")
    assert r.status_code in (403, 501)


def test_findings_are_open_to_any_signed_in_account(base_url, make_user, auth):
    """Ungated on 8 Aug 2026, deliberately.

    Every finding is computed from named sources and links the records behind
    it — the same contract as every other panel — and it makes the underlying
    research easier to reach rather than harder. Someone reading about their own
    condition has as much business knowing that experts disagree as a researcher
    does, and hiding it would be paternalistic.

    What stays behind the gate is the other half: open-ended commentary and
    anything resembling a hypothesis.
    """
    u = make_user("research-open@example.com")
    assert not u.research_unlocked
    r = httpx.get(f"{base_url}/research/findings", params={"gene": "NOTAGENE"},
                  headers=auth(u), timeout=30)
    assert r.status_code != 403


def test_an_unset_password_fails_closed(base_url, make_user, auth):
    """The default is empty, and empty must mean unreachable rather than open.

    The failure mode of the other choice is shipping open-ended AI analysis to
    everyone by forgetting an environment variable.
    """
    if get_settings().research_mode_password:
        pytest.skip("a password is configured on this server")
    u = make_user("research-unset@example.com")
    assert _unlock(base_url, auth(u), "").status_code == 501
    assert _unlock(base_url, auth(u), "guess").status_code == 501


def test_a_bad_gene_symbol_is_rejected_before_any_fetch(base_url, db, make_user, auth):
    u = make_user("research-badgene@example.com")
    u.research_unlocked = True
    db.commit()
    for junk in ("", "not a gene!", "../../etc/passwd"):
        r = httpx.get(f"{base_url}/research/findings", params={"gene": junk},
                      headers=auth(u), timeout=30)
        assert r.status_code in (400, 422), junk


def test_unlocking_is_recorded_on_the_account(db, make_user):
    """The flag is per-account, so sharing the password does not share access —
    each person still signs in and unlocks their own."""
    u = make_user("research-flag@example.com")
    assert not u.research_unlocked
    u.research_unlocked = True
    db.commit()
    db.refresh(u)
    assert u.research_unlocked is True
