"""Data-protection obligations, as behaviour rather than as prose.

The privacy policy makes promises: signed-out visitors are not recorded,
consent is demonstrable, an account can be exported and erased. Each of those
is a legal commitment, so each is asserted here — a policy whose claims are not
tested is a policy that drifts away from the software it describes.
"""
import httpx
import pytest

from database.models import Query as QueryModel, Project


# ── Signed-out visitors leave no record ──────────────────────────────────────


@pytest.mark.external
def test_a_signed_out_question_is_not_stored(base_url, db):
    """Questions from visitors without an account used to be written as
    `user_id IS NULL` rows — a record of what someone asked before they had
    agreed to anything. A question can identify its asker."""
    before = db.query(QueryModel).filter(QueryModel.user_id.is_(None)).count()
    r = httpx.post(f"{base_url}/chat/stream",
                   json={"message": "BRCA1 variants", "staged": True}, timeout=180)
    assert r.status_code in (200, 402, 429)
    after = db.query(QueryModel).filter(QueryModel.user_id.is_(None)).count()
    assert after == before, "an anonymous query was persisted"


# ── Consent is recorded, and is only a timestamp ─────────────────────────────


def test_consent_is_recorded_against_the_account(base_url, make_user, auth, fresh):
    user = make_user("pytest-consent@test.local")
    assert fresh(user).dna_consent_at is None

    r = httpx.post(f"{base_url}/user/dna-consent", headers=auth(user), timeout=30)
    assert r.status_code == 200
    assert r.json()["recorded"] is True
    assert fresh(user).dna_consent_at is not None


def test_consent_requires_an_account(base_url):
    """Nothing is recorded for signed-out visitors: there is no account to
    attach it to, and the consent screen still gates the upload for them."""
    assert httpx.post(f"{base_url}/user/dna-consent", timeout=30).status_code == 401


# ── Export ───────────────────────────────────────────────────────────────────


def test_export_returns_the_account_and_its_queries(base_url, make_user, auth, db):
    user = make_user("pytest-export@test.local", query_credits=7)
    db.add(QueryModel(user_id=user.id, query_text="BRCA1 variants",
                      query_type="gene_query", target="BRCA1",
                      results={"content": "..."}, sources=["ClinVar"]))
    db.commit()

    body = httpx.get(f"{base_url}/user/export", headers=auth(user), timeout=30).json()
    assert body["account"]["email"] == "pytest-export@test.local"
    assert body["account"]["query_credits"] == 7
    assert any(q["question"] == "BRCA1 variants" for q in body["queries"])


def test_export_never_returns_the_stored_api_key(base_url, make_user, auth, db):
    """It is the reader's credential, held encrypted. An export must not become
    a route for reading secrets back out."""
    user = make_user("pytest-export-key@test.local")
    user.encrypted_api_key = "gAAAAABmock_ciphertext"
    db.commit()

    body = httpx.get(f"{base_url}/user/export", headers=auth(user), timeout=30).json()
    assert body["account"]["has_stored_api_key"] is True
    assert "gAAAAABmock_ciphertext" not in httpx.get(
        f"{base_url}/user/export", headers=auth(user), timeout=30).text


def test_export_shows_only_your_own_data(base_url, make_user, auth, db):
    mine = make_user("pytest-export-mine@test.local")
    theirs = make_user("pytest-export-theirs@test.local")
    db.add(QueryModel(user_id=theirs.id, query_text="their private question",
                      query_type="gene_query", target="TP53", results={}))
    db.commit()

    text = httpx.get(f"{base_url}/user/export", headers=auth(mine), timeout=30).text
    assert "their private question" not in text


def test_export_requires_an_account(base_url):
    assert httpx.get(f"{base_url}/user/export", timeout=30).status_code == 401


# ── Erasure ──────────────────────────────────────────────────────────────────


def test_deleting_an_account_removes_its_queries_too(base_url, make_user, auth, db):
    """A partial delete would leave behind exactly the records someone asked to
    be rid of. Queries without a project do not cascade, so they are removed
    explicitly — this is the assertion that catches it if that is ever lost."""
    from database.models import User
    user = make_user("pytest-erase@test.local")
    user_id = user.id
    db.add(QueryModel(user_id=user_id, query_text="a question", query_type="gene_query",
                      target="BRCA1", results={}))
    db.commit()
    assert db.query(QueryModel).filter(QueryModel.user_id == user_id).count() == 1

    r = httpx.delete(f"{base_url}/user/account", headers=auth(user), timeout=30)
    assert r.status_code == 200
    assert r.json()["deleted"] is True

    db.expire_all()
    assert db.query(User).filter(User.id == user_id).first() is None
    assert db.query(QueryModel).filter(QueryModel.user_id == user_id).count() == 0


def test_deleting_an_account_removes_its_projects(base_url, make_user, auth, db):
    from database.models import User
    user = make_user("pytest-erase-proj@test.local")
    user_id = user.id
    project = Project(name="A project", user_id=user_id)
    db.add(project)
    db.commit()
    db.add(QueryModel(user_id=user_id, project_id=project.id, query_text="q",
                      query_type="gene_query", target="BRCA1", results={}))
    db.commit()

    assert httpx.delete(f"{base_url}/user/account", headers=auth(user), timeout=30).status_code == 200
    db.expire_all()
    assert db.query(Project).filter(Project.user_id == user_id).count() == 0
    assert db.query(User).filter(User.id == user_id).first() is None


def test_deletion_warns_when_a_subscription_is_still_running(base_url, make_user, auth, db):
    """Removing our record of a subscription does not stop Stripe billing for
    it. Saying nothing would be the worse failure."""
    user = make_user("pytest-erase-sub@test.local")
    user.byok_unlocked = True
    db.commit()

    body = httpx.delete(f"{base_url}/user/account", headers=auth(user), timeout=30).json()
    assert body["subscription_needs_cancelling"] is True
    assert "Stripe" in body["note"]


def test_deletion_does_not_touch_anyone_else(base_url, make_user, auth, db):
    from database.models import User
    victim = make_user("pytest-erase-bystander@test.local")
    victim_id = victim.id
    db.add(QueryModel(user_id=victim_id, query_text="untouched", query_type="gene_query",
                      target="TP53", results={}))
    db.commit()

    doomed = make_user("pytest-erase-self@test.local")
    assert httpx.delete(f"{base_url}/user/account", headers=auth(doomed), timeout=30).status_code == 200

    db.expire_all()
    assert db.query(User).filter(User.id == victim_id).first() is not None
    assert db.query(QueryModel).filter(QueryModel.user_id == victim_id).count() == 1


def test_deletion_requires_an_account(base_url):
    assert httpx.delete(f"{base_url}/user/account", timeout=30).status_code == 401
