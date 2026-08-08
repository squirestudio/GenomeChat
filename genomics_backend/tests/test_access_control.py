"""Ownership is derived from the token, never from client input.

Every one of these passed only after the routes were rewritten; before that a
non-owner could read, rename, delete and share other people's work.
"""
import httpx
import pytest


@pytest.fixture
def two_users(make_user, auth):
    a = make_user("pytest-owner-a@test.local")
    b = make_user("pytest-owner-b@test.local")
    return a, auth(a), b, auth(b)


@pytest.fixture
def a_project(base_url, two_users):
    a, ha, _, _ = two_users
    r = httpx.post(f"{base_url}/projects", json={"name": "A private project"}, headers=ha, timeout=30)
    assert r.status_code == 201
    return r.json()


def ids(resp):
    return {p["id"] for p in resp.json()}


def test_created_project_is_owned_by_its_creator(a_project, two_users):
    a, *_ = two_users
    assert a_project["user_id"] == a.id


def test_other_user_does_not_see_it_in_their_list(base_url, a_project, two_users):
    _, _, _, hb = two_users
    assert a_project["id"] not in ids(httpx.get(f"{base_url}/projects", headers=hb, timeout=30))


def test_anonymous_does_not_see_it(base_url, a_project):
    assert a_project["id"] not in ids(httpx.get(f"{base_url}/projects", timeout=30))


def test_user_id_query_param_cannot_be_used_to_impersonate(base_url, a_project, two_users):
    """The parameter was the original hole: ?user_id=N returned that user's projects."""
    a, *_ = two_users
    r = httpx.get(f"{base_url}/projects?user_id={a.id}", timeout=30)
    assert a_project["id"] not in ids(r)


@pytest.mark.parametrize("method,expect", [("get", 404), ("put", 404), ("delete", 404)])
def test_other_user_cannot_touch_it(base_url, a_project, two_users, method, expect):
    _, _, _, hb = two_users
    url = f"{base_url}/projects/{a_project['id']}"
    kwargs = {"headers": hb, "timeout": 30}
    if method == "put":
        kwargs["json"] = {"name": "pwned"}
    assert getattr(httpx, method)(url, **kwargs).status_code == expect


def test_owner_retains_full_access(base_url, a_project, two_users):
    _, ha, _, _ = two_users
    assert httpx.get(f"{base_url}/projects/{a_project['id']}", headers=ha, timeout=30).status_code == 200


def test_a_failed_delete_leaves_the_project_intact(base_url, a_project, two_users):
    _, ha, _, hb = two_users
    httpx.delete(f"{base_url}/projects/{a_project['id']}", headers=hb, timeout=30)
    assert httpx.get(f"{base_url}/projects/{a_project['id']}", headers=ha, timeout=30).status_code == 200


# ── queries and share links ──────────────────────────────────────────────────

@pytest.fixture
def a_query(db, two_users):
    from database.models import Query as QueryModel
    a, *_ = two_users
    q = QueryModel(user_id=a.id, query_text="A private query", query_type="gene_query",
                   target="BRCA1", results={"content": "SECRET"}, result_count=1, sources=["ClinVar"])
    db.add(q); db.commit(); db.refresh(q)
    return q


def test_sharing_is_gone(base_url, a_query, two_users):
    """Removed 8 Aug 2026 — see the note in database/routes.py.

    Asserted rather than merely deleted, because the failure mode of putting it
    back is silent: the route would resolve for anyone holding a token, with no
    revocation and no expiry, and nothing else in the suite would notice.
    """
    _, ha, _, _ = two_users
    assert httpx.post(f"{base_url}/queries/{a_query.id}/share", headers=ha, timeout=30).status_code == 404
    assert httpx.get(f"{base_url}/share/anything", timeout=30).status_code == 404


def test_no_query_retains_a_share_token(base_url, db, a_query):
    """Old tokens are nulled at boot rather than left in the table.

    Keeping secrets for a feature that no longer exists is retention without a
    purpose, and a token left behind is one route away from working again.
    """
    from database.models import Query as QueryModel
    db.expire_all()
    assert db.query(QueryModel).filter(QueryModel.share_token.isnot(None)).count() == 0


def test_anonymous_cannot_delete_someone_elses_query(base_url, a_query, db):
    """The old guard read `if current_user and ...`, which an anonymous caller skipped."""
    from database.models import Query as QueryModel
    assert httpx.delete(f"{base_url}/queries/{a_query.id}", timeout=30).status_code == 404
    db.expire_all()
    assert db.query(QueryModel).filter(QueryModel.id == a_query.id).first() is not None


def test_recent_queries_are_scoped_to_the_caller(base_url, a_query, two_users):
    _, ha, _, hb = two_users
    mine = {x["id"] for x in httpx.get(f"{base_url}/projects/queries/recent", headers=ha, timeout=30).json()}
    theirs = {x["id"] for x in httpx.get(f"{base_url}/projects/queries/recent", headers=hb, timeout=30).json()}
    anon = {x["id"] for x in httpx.get(f"{base_url}/projects/queries/recent", timeout=30).json()}
    assert a_query.id in mine
    assert a_query.id not in theirs
    assert a_query.id not in anon
