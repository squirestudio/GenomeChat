"""The history list is filterable by project, which is what makes selecting one mean anything.

Every query was already stored against the active project — `project_id` rides
on the chat request and lands on the row. What was missing was any way to read
it back, so the sidebar showed an identical list whichever project was selected
and the feature was invisible in the only place it would have been visible.
"""
import httpx
import pytest

from database.models import Project, Query as QueryModel


@pytest.fixture
def two_projects_with_queries(db, make_user, auth):
    """One user, two projects, one query filed in each, plus one filed in neither."""
    user = make_user("projects@example.com")
    headers = auth(user)

    a = Project(name="Project A", user_id=user.id)
    b = Project(name="Project B", user_id=user.id)
    db.add_all([a, b])
    db.commit()

    in_a = QueryModel(query_text="BRCA1 in A", user_id=user.id)
    in_b = QueryModel(query_text="TP53 in B", user_id=user.id)
    loose = QueryModel(query_text="unfiled", user_id=user.id)
    in_a.projects = [a]
    in_b.projects = [b]
    db.add_all([in_a, in_b, loose])
    db.commit()
    for row in (a, b, in_a, in_b, loose):
        db.refresh(row)
    return headers, a, b, in_a, in_b, loose


def _recent(base_url, headers, **params):
    r = httpx.get(f"{base_url}/projects/queries/recent", headers=headers, params=params, timeout=30)
    assert r.status_code == 200, r.text
    return {x["id"] for x in r.json()}


def test_no_project_id_returns_everything(base_url, two_projects_with_queries):
    """"All queries" has to keep meaning all queries, filed or not."""
    headers, _a, _b, in_a, in_b, loose = two_projects_with_queries
    ids = _recent(base_url, headers)
    assert {in_a.id, in_b.id, loose.id} <= ids


def test_a_project_returns_only_its_own(base_url, two_projects_with_queries):
    headers, a, _b, in_a, in_b, loose = two_projects_with_queries
    ids = _recent(base_url, headers, project_id=a.id)
    assert in_a.id in ids
    assert in_b.id not in ids
    assert loose.id not in ids, "an unfiled query must not appear under a project"


def test_the_project_filter_cannot_reach_another_users_rows(base_url, db, make_user, auth):
    """Ownership comes from the JWT; project_id is a filter, never an authorisation.

    The obvious mistake is to filter on project_id alone and let the row's own
    project decide who sees it, which would make any project id readable by
    anyone who guesses the integer.
    """
    owner = make_user("owner-pf@example.com")
    intruder = make_user("intruder-pf@example.com")

    theirs = Project(name="Private", user_id=owner.id)
    db.add(theirs)
    db.commit()
    secret = QueryModel(query_text="confidential", user_id=owner.id)
    secret.projects = [theirs]
    db.add(secret)
    db.commit()
    db.refresh(secret)
    db.refresh(theirs)

    assert secret.id in _recent(base_url, auth(owner), project_id=theirs.id)
    assert secret.id not in _recent(base_url, auth(intruder), project_id=theirs.id)


def test_an_unknown_project_returns_empty_rather_than_erroring(base_url, two_projects_with_queries):
    """A deleted project selected in a stale tab should show nothing, not a 500."""
    headers, *_ = two_projects_with_queries
    assert _recent(base_url, headers, project_id=99_999_999) == set()
