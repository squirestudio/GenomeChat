from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, Any
from datetime import datetime
from .models import get_db, Project, Query, AuditLog

router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None
    user_id: Optional[int] = None


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
def list_projects(user_id: Optional[int] = None, db: Session = Depends(get_db)):
    q = db.query(Project)
    if user_id:
        q = q.filter(Project.user_id == user_id)
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
def create_project(data: ProjectCreate, db: Session = Depends(get_db)):
    project = Project(
        name=data.name,
        description=data.description,
        user_id=data.user_id,
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
def get_project(project_id: int, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
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
def update_project(project_id: int, data: ProjectUpdate, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
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
def delete_project(project_id: int, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    db.delete(project)
    db.commit()


@router.post("/{project_id}/queries", response_model=QueryResponse, status_code=201)
def add_query_to_project(project_id: int, query_data: dict, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    query = Query(
        project_id=project_id,
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


@router.delete("/{project_id}/queries/{query_id}", status_code=204)
def delete_query(project_id: int, query_id: int, db: Session = Depends(get_db)):
    query = db.query(Query).filter(
        Query.id == query_id,
        Query.project_id == project_id
    ).first()
    if not query:
        raise HTTPException(status_code=404, detail="Query not found")
    db.delete(query)
    db.commit()
