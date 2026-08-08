import secrets
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, Any
from datetime import datetime
from .models import get_db, Project, Query, AuditLog, User, query_projects
from auth import get_current_user

router = APIRouter(prefix="/projects", tags=["projects"])
# Was `share_router`. Sharing is gone; this now carries only the top-level
# query routes that do not sit under /projects.
queries_router = APIRouter(tags=["queries"])


# ─── Ownership ────────────────────────────────────────────────────────────────
# Ownership is always derived from the JWT, never from client-supplied input.
# Anonymous callers own the unowned (user_id IS NULL) rows, which is what the
# anonymous /chat path creates. Missing-vs-forbidden is deliberately not
# distinguished — both return 404 so ids cannot be enumerated.

def _owned_by(model, current_user: Optional[User]):
    """SQLAlchemy filter scoping `model` to rows the caller owns."""
    if current_user:
        return model.user_id == current_user.id
    return model.user_id.is_(None)


def _require_owner(row, current_user: Optional[User]):
    """Raise 404 unless the caller owns `row`."""
    caller_id = current_user.id if current_user else None
    if row.user_id != caller_id:
        raise HTTPException(status_code=404, detail="Not found")
    return row


class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class ProjectResponse(BaseModel):
    id: int
    name: str
    description: Optional[str]
    user_id: Optional[int]
    created_at: datetime
    updated_at: datetime
    query_count: int = 0

    class Config:
        from_attributes = True


class QueryResponse(BaseModel):
    id: int
    project_ids: list[int] = []
    query_text: str
    query_type: Optional[str]
    target: Optional[str]
    results: Optional[Any]
    result_count: int
    sources: Optional[list]
    cached: bool
    created_at: datetime

    class Config:
        from_attributes = True


class ProjectWithQueries(ProjectResponse):
    queries: list[QueryResponse] = []


@router.get("", response_model=list[ProjectResponse])
def list_projects(
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    # user_id is intentionally NOT a query parameter — it comes from the token.
    q = db.query(Project).filter(_owned_by(Project, current_user))
    projects = q.order_by(Project.updated_at.desc()).all()
    result = []
    for p in projects:
        d = ProjectResponse(
            id=p.id,
            name=p.name,
            description=p.description,
            user_id=p.user_id,
            created_at=p.created_at,
            updated_at=p.updated_at,
            query_count=len(p.queries)
        )
        result.append(d)
    return result


@router.post("", response_model=ProjectResponse, status_code=201)
def create_project(
    data: ProjectCreate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    project = Project(
        name=data.name,
        description=data.description,
        user_id=current_user.id if current_user else None,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return ProjectResponse(
        id=project.id,
        name=project.name,
        description=project.description,
        user_id=project.user_id,
        created_at=project.created_at,
        updated_at=project.updated_at,
        query_count=0
    )


@router.get("/{project_id}", response_model=ProjectWithQueries)
def get_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _require_owner(project, current_user)
    queries = [
        QueryResponse(
            id=q.id,
            project_ids=[p.id for p in q.projects],
            query_text=q.query_text,
            query_type=q.query_type,
            target=q.target,
            results=q.results,
            result_count=q.result_count or 0,
            sources=q.sources or [],
            cached=bool(q.cached),
            created_at=q.created_at
        )
        for q in project.queries
    ]
    return ProjectWithQueries(
        id=project.id,
        name=project.name,
        description=project.description,
        user_id=project.user_id,
        created_at=project.created_at,
        updated_at=project.updated_at,
        query_count=len(queries),
        queries=queries
    )


@router.put("/{project_id}", response_model=ProjectResponse)
def update_project(
    project_id: int,
    data: ProjectUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _require_owner(project, current_user)
    if data.name is not None:
        project.name = data.name
    if data.description is not None:
        project.description = data.description
    project.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(project)
    return ProjectResponse(
        id=project.id,
        name=project.name,
        description=project.description,
        user_id=project.user_id,
        created_at=project.created_at,
        updated_at=project.updated_at,
        query_count=len(project.queries)
    )


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _require_owner(project, current_user)
    # Only the links go. `query_projects` cascades on the project's deletion at
    # the database level, so the queries survive and reappear under "All
    # queries" — deleting a folder must never delete the research inside it.
    db.delete(project)
    db.commit()


@router.post("/{project_id}/queries", response_model=QueryResponse, status_code=201)
def add_query_to_project(
    project_id: int,
    query_data: dict,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _require_owner(project, current_user)
    query = Query(
        user_id=current_user.id if current_user else None,
        query_text=query_data.get("query_text", ""),
        query_type=query_data.get("query_type"),
        target=query_data.get("target"),
        results=query_data.get("results"),
        result_count=query_data.get("result_count", 0),
        sources=query_data.get("sources", []),
        cached=0,
    )
    query.projects = [project]
    db.add(query)
    project.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(query)
    return QueryResponse(
        id=query.id,
        project_ids=[p.id for p in query.projects],
        query_text=query.query_text,
        query_type=query.query_type,
        target=query.target,
        results=query.results,
        result_count=query.result_count or 0,
        sources=query.sources or [],
        cached=bool(query.cached),
        created_at=query.created_at
    )


class AssignQueries(BaseModel):
    """Add or remove queries from a project.

    `member` decides the direction. `project_id: null` means "remove from every
    project", which is the only operation that does not name one.
    """
    query_ids: list[int]
    project_id: Optional[int] = None
    member: bool = True


@router.patch("/queries/assign")
def assign_queries_to_project(
    body: AssignQueries,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    """File existing queries into a project, or take them out of one.

    Attribution used to be fixed at ask-time: whatever project was selected when
    the question was sent, forever. Anything asked before a project existed
    could never be organised into one, which is most of what a reader
    accumulates before they think to make a project at all.

    Both sides are checked against the caller. The queries are filtered by
    `_owned_by` so someone else's ids are silently skipped rather than moved,
    and the destination project is verified to belong to the caller too —
    without that second check, a valid id of *someone else's* project would file
    your queries into it.

    Membership is a set, so adding twice is not an error and removing something
    that was never there is not either. The UI toggles, and a toggle that can
    fail on a double-click is a worse UI.
    """
    project = None
    if body.project_id is not None:
        project = db.query(Project).filter(Project.id == body.project_id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        _require_owner(project, current_user)

    if not body.query_ids:
        return {"changed": 0, "project_id": body.project_id, "member": body.member}

    owned = (
        db.query(Query)
        .filter(Query.id.in_(body.query_ids))
        .filter(_owned_by(Query, current_user))
        .all()
    )

    changed = 0
    for q in owned:
        if project is None:
            # "Remove from every project" — the multi-project equivalent of the
            # old `project_id: null`.
            if q.projects:
                q.projects = []
                changed += 1
        elif body.member:
            if project not in q.projects:
                q.projects.append(project)
                changed += 1
        else:
            if project in q.projects:
                q.projects.remove(project)
                changed += 1

    if changed:
        db.commit()
    return {"changed": changed, "project_id": body.project_id, "member": body.member}


@router.get("/queries/recent")
def get_recent_queries(
    limit: int = 30,
    project_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    """Recent queries for the current user, optionally limited to one project.

    `project_id` is what makes selecting a project in the sidebar mean anything.
    Without it the history list was identical whichever project was selected —
    every query was already being *stored* against the active project, so the
    feature worked and nothing on screen ever reflected it.

    Filtering here rather than through `GET /projects/{id}` is deliberate: that
    route returns `ProjectWithQueries`, which carries the full `results` payload
    of every query, and the sidebar needs one line each. Same shape as the
    unfiltered list means one component renders both.

    Ownership still comes from `_owned_by` on the JWT, never from this
    parameter — asking for someone else's project id returns their rows only if
    the ownership filter is dropped, so the two filters are kept independent.
    """
    q = (
        db.query(Query)
        .filter(_owned_by(Query, current_user))
        .order_by(Query.created_at.desc())
    )
    if project_id is not None:
        # Through the link table now. `.join` rather than `.any()` because the
        # link table is indexed on project_id and this is the sidebar's hot path.
        q = q.join(query_projects, query_projects.c.query_id == Query.id).filter(
            query_projects.c.project_id == project_id
        )
    queries = q.limit(limit).all()
    result = []
    for q in queries:
        stored = q.results if isinstance(q.results, dict) else {}
        result.append({
            "id": q.id,
            # Needed by the sidebar's file-menu to tick every project a query
            # is already in. Without it they all read as unselected.
            "project_ids": [p.id for p in q.projects],
            "query_text": q.query_text,
            "query_type": q.query_type,
            "target": q.target,
            "sources": q.sources or [],
            "result_count": q.result_count or 0,
            "created_at": q.created_at.isoformat() if q.created_at else None,
            # Full stored response for replay
            "content": stored.get("content"),
            "data": stored.get("data"),
        })
    return result


@router.delete("/{project_id}/queries/{query_id}", status_code=204)
def remove_query_from_project(
    project_id: int,
    query_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    """Take a query out of one project. It stays in any others, and in history.

    This used to delete the row outright, which was defensible when a query
    belonged to exactly one project — "remove from the only place it lives" and
    "delete" were the same act. With membership a set they are not: removing
    BRCA1 from "DNA repair" must leave it under "breast cancer". Deleting a
    query for real is `DELETE /queries/{id}`.
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _require_owner(project, current_user)

    query = (
        db.query(Query)
        .filter(Query.id == query_id)
        .filter(_owned_by(Query, current_user))
        .first()
    )
    if not query:
        raise HTTPException(status_code=404, detail="Query not found")
    if project in query.projects:
        query.projects.remove(project)
        db.commit()


# ─── Shared link endpoints (no /projects prefix) ─────────────────────────────

@queries_router.delete("/queries/{query_id}", status_code=204)
def delete_query_by_id(
    query_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    """Delete a query the caller owns.

    The ownership test is part of the lookup rather than a follow-up check —
    the previous `if current_user and query.user_id and ...` form let an
    unauthenticated caller skip the comparison entirely and delete anything.
    """
    query = db.query(Query).filter(
        Query.id == query_id,
        _owned_by(Query, current_user),
    ).first()
    if not query:
        raise HTTPException(status_code=404, detail="Query not found")
    db.delete(query)
    db.commit()


# ─── Sharing removed, 8 Aug 2026 ─────────────────────────────────────────────
# `POST /queries/{id}/share` minted a token and `GET /share/{token}` served the
# whole stored answer to anyone holding it, with no sign-in. Three things made
# that worse than it looked and none had a fix in place:
#
#   - **No revocation.** The token was set once and never cleared. There was no
#     endpoint to withdraw a link and no control that offered to, so a click was
#     permanent and irreversible.
#   - **It could carry more than the reader expected.** Variants are never
#     stored, but the *model's prose* is, and with a DNA file loaded that prose
#     routinely names a genotype. The question text went too, and questions are
#     often the revealing part.
#   - The 404 said "not found or expired" and nothing ever expired.
#
# Removing the routes revokes every link that was ever minted, which is the
# point. `queries.share_token` is nulled by a migration rather than left lying
# in the table, since keeping secrets for a feature that no longer exists is
# retention without a purpose. The column stays so this is easy to reinstate —
# with revocation and a warning before minting, which is what it needed.

