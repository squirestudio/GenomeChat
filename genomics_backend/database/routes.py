import secrets
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, Any
from datetime import datetime
from .models import get_db, Project, Query, AuditLog, User
from auth import get_current_user

router = APIRouter(prefix="/projects", tags=["projects"])
share_router = APIRouter(tags=["sharing"])


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
    project_id: Optional[int]
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
            project_id=q.project_id,
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
        project_id=project_id,
        user_id=current_user.id if current_user else None,
        query_text=query_data.get("query_text", ""),
        query_type=query_data.get("query_type"),
        target=query_data.get("target"),
        results=query_data.get("results"),
        result_count=query_data.get("result_count", 0),
        sources=query_data.get("sources", []),
        cached=0,
    )
    db.add(query)
    project.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(query)
    return QueryResponse(
        id=query.id,
        project_id=query.project_id,
        query_text=query.query_text,
        query_type=query.query_type,
        target=query.target,
        results=query.results,
        result_count=query.result_count or 0,
        sources=query.sources or [],
        cached=bool(query.cached),
        created_at=query.created_at
    )


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
        q = q.filter(Query.project_id == project_id)
    queries = q.limit(limit).all()
    result = []
    for q in queries:
        stored = q.results if isinstance(q.results, dict) else {}
        result.append({
            "id": q.id,
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
def delete_query(
    project_id: int,
    query_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    query = db.query(Query).filter(
        Query.id == query_id,
        Query.project_id == project_id,
        _owned_by(Query, current_user),
    ).first()
    if not query:
        raise HTTPException(status_code=404, detail="Query not found")
    db.delete(query)
    db.commit()


# ─── Shared link endpoints (no /projects prefix) ─────────────────────────────

@share_router.delete("/queries/{query_id}", status_code=204)
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


@share_router.post("/queries/{query_id}/share")
def create_share_link(
    query_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    """Generate or return existing share token for a query the caller owns.

    Without the ownership filter this was a read primitive for the whole table:
    query ids are sequential, so anyone could mint a token for any id and then
    fetch the full stored response through GET /share/{token}.
    """
    query = db.query(Query).filter(
        Query.id == query_id,
        _owned_by(Query, current_user),
    ).first()
    if not query:
        raise HTTPException(status_code=404, detail="Query not found")
    if not query.share_token:
        query.share_token = secrets.token_urlsafe(16)
        db.commit()
        db.refresh(query)
    return {"token": query.share_token, "query_id": query_id}


@share_router.get("/share/{token}")
def get_shared_query(token: str, db: Session = Depends(get_db)):
    """Return full stored response for a shared query token."""
    query = db.query(Query).filter(Query.share_token == token).first()
    if not query:
        raise HTTPException(status_code=404, detail="Shared link not found or expired")
    stored = query.results if isinstance(query.results, dict) else {}
    return {
        "query_text": query.query_text,
        "query_type": query.query_type,
        "target": query.target,
        "sources": query.sources or [],
        "result_count": query.result_count or 0,
        "created_at": query.created_at.isoformat() if query.created_at else None,
        "content": stored.get("content"),
        "data": stored.get("data"),
    }
