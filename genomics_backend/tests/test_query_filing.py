"""Existing queries can be filed into a project after the fact.

Attribution used to be fixed at ask-time — whatever project was selected when
the question was sent, forever. Everything asked before a project existed could
never be organised into one, which is most of what a reader accumulates before
they think to make a project at all.
"""
import httpx
import pytest

from database.models import Project, Query as QueryModel


@pytest.fixture
def filing_setup(db, make_user, auth):
    user = make_user("filing@example.com")
    headers = auth(user)
    project = Project(name="Filing target", user_id=user.id)
    db.add(project)
    db.commit()
    q1 = QueryModel(query_text="BRCA1", user_id=user.id)
    q2 = QueryModel(query_text="TP53", user_id=user.id)
    db.add_all([q1, q2])
    db.commit()
    for row in (project, q1, q2):
        db.refresh(row)
    return headers, project, q1, q2


def _assign(base_url, headers, ids, project_id, member=True):
    return httpx.patch(
        f"{base_url}/projects/queries/assign",
        headers=headers,
        json={"query_ids": ids, "project_id": project_id, "member": member},
        timeout=30,
    )


def _project_ids(db, query_id):
    from database.models import Query as QM
    db.expire_all()
    return {p.id for p in db.query(QM).get(query_id).projects}


def test_an_old_query_can_be_filed_into_a_project(base_url, db, filing_setup):
    headers, project, q1, _q2 = filing_setup
    r = _assign(base_url, headers, [q1.id], project.id)
    assert r.status_code == 200 and r.json()["changed"] == 1
    assert _project_ids(db, q1.id) == {project.id}


def test_several_move_in_one_call(base_url, db, filing_setup):
    """The reason bulk exists: a reader files the backlog they already have."""
    headers, project, q1, q2 = filing_setup
    r = _assign(base_url, headers, [q1.id, q2.id], project.id)
    assert r.json()["changed"] == 2
    assert _project_ids(db, q1.id) == {project.id}
    assert _project_ids(db, q2.id) == {project.id}


def test_null_unfiles_without_deleting(base_url, db, filing_setup):
    headers, project, q1, _q2 = filing_setup
    _assign(base_url, headers, [q1.id], project.id)
    r = _assign(base_url, headers, [q1.id], None)
    assert r.status_code == 200
    db.expire_all()
    assert db.query(QueryModel).get(q1.id) is not None
    assert _project_ids(db, q1.id) == set()


def test_cannot_move_someone_elses_query(base_url, db, make_user, auth, filing_setup):
    """Silently skipped rather than moved — and definitely not a 500.

    Filed first, so "unfile it" is a real change rather than a no-op. Asserting
    against a query that was already unfiled would pass whether the guard worked
    or not.
    """
    headers, project, q1, _q2 = filing_setup
    _assign(base_url, headers, [q1.id], project.id)

    intruder = make_user("intruder-filing@example.com")
    r = _assign(base_url, auth(intruder), [q1.id], None)
    assert r.status_code == 200 and r.json()["changed"] == 0

    assert _project_ids(db, q1.id) == {project.id}


def test_cannot_file_into_someone_elses_project(base_url, db, make_user, auth, filing_setup):
    """The check that is easy to forget: the *destination* needs an owner test.

    Filtering only the queries would still let a valid id of someone else's
    project be used as the destination, quietly filing your rows into it.
    """
    _headers, project, _q1, _q2 = filing_setup
    intruder = make_user("intruder-dest@example.com")
    mine = QueryModel(query_text="mine", user_id=intruder.id)
    db.add(mine)
    db.commit()
    db.refresh(mine)

    r = _assign(base_url, auth(intruder), [mine.id], project.id)
    assert r.status_code == 404
    assert _project_ids(db, mine.id) == set()


def test_deleting_a_project_no_longer_destroys_its_queries(base_url, db, filing_setup):
    """This cascade was live: filing research in made it deletable in one click."""
    headers, project, q1, q2 = filing_setup
    _assign(base_url, headers, [q1.id, q2.id], project.id)

    r = httpx.delete(f"{base_url}/projects/{project.id}", headers=headers, timeout=30)
    assert r.status_code == 204

    db.expire_all()
    for q in (q1, q2):
        row = db.query(QueryModel).get(q.id)
        assert row is not None, "deleting a project must not delete the research in it"
        assert _project_ids(db, q.id) == set()


# ─── Membership is a set ──────────────────────────────────────────────────────

def test_a_query_can_be_in_two_projects_at_once(base_url, db, make_user, auth):
    """The whole point. BRCA1 belongs under breast cancer *and* DNA repair."""
    user = make_user("multi@example.com")
    headers = auth(user)
    a = Project(name="Breast cancer", user_id=user.id)
    b = Project(name="DNA repair", user_id=user.id)
    db.add_all([a, b])
    db.commit()
    q = QueryModel(query_text="BRCA1", user_id=user.id)
    db.add(q)
    db.commit()
    for row in (a, b, q):
        db.refresh(row)

    _assign(base_url, headers, [q.id], a.id)
    _assign(base_url, headers, [q.id], b.id)
    assert _project_ids(db, q.id) == {a.id, b.id}

    # And it shows up under each.
    for proj in (a, b):
        r = httpx.get(f"{base_url}/projects/queries/recent", headers=headers,
                      params={"project_id": proj.id}, timeout=30)
        assert q.id in {x["id"] for x in r.json()}


def test_removing_from_one_project_leaves_the_others(base_url, db, make_user, auth):
    user = make_user("multi-remove@example.com")
    headers = auth(user)
    a = Project(name="Keep", user_id=user.id)
    b = Project(name="Drop", user_id=user.id)
    db.add_all([a, b])
    db.commit()
    q = QueryModel(query_text="BRCA1", user_id=user.id)
    db.add(q)
    db.commit()
    for row in (a, b, q):
        db.refresh(row)

    _assign(base_url, headers, [q.id], a.id)
    _assign(base_url, headers, [q.id], b.id)
    r = _assign(base_url, headers, [q.id], b.id, member=False)
    assert r.json()["changed"] == 1
    assert _project_ids(db, q.id) == {a.id}


def test_toggling_is_idempotent(base_url, db, filing_setup):
    """The UI toggles, and a toggle that errors on a double-click is a worse UI."""
    headers, project, q1, _q2 = filing_setup
    assert _assign(base_url, headers, [q1.id], project.id).json()["changed"] == 1
    assert _assign(base_url, headers, [q1.id], project.id).json()["changed"] == 0
    assert _project_ids(db, q1.id) == {project.id}

    assert _assign(base_url, headers, [q1.id], project.id, member=False).json()["changed"] == 1
    assert _assign(base_url, headers, [q1.id], project.id, member=False).json()["changed"] == 0
    assert _project_ids(db, q1.id) == set()


def test_recent_returns_every_project_a_query_is_in(base_url, db, make_user, auth):
    """The sidebar menu ticks from this; one id would tick only one box."""
    user = make_user("multi-list@example.com")
    headers = auth(user)
    a = Project(name="A", user_id=user.id)
    b = Project(name="B", user_id=user.id)
    db.add_all([a, b])
    db.commit()
    q = QueryModel(query_text="BRCA1", user_id=user.id)
    db.add(q)
    db.commit()
    for row in (a, b, q):
        db.refresh(row)

    _assign(base_url, headers, [q.id], a.id)
    _assign(base_url, headers, [q.id], b.id)

    rows = httpx.get(f"{base_url}/projects/queries/recent", headers=headers, timeout=30).json()
    row = next(x for x in rows if x["id"] == q.id)
    assert set(row["project_ids"]) == {a.id, b.id}
