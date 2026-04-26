import time
import logging
from contextlib import asynccontextmanager
from typing import Optional, Any
from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session

from config import get_settings
from models import QueryRequest, QueryResponse, BatchQueryRequest, HealthResponse, QueryType
from services.query_interpreter import interpret_query
from services.genomics_api_real import run_gene_pipeline, run_disease_pipeline
from services.ai_explainer import explain_results, explain_comparison, answer_followup
from services.cache import cache
from database.models import create_tables, get_db, Query as QueryModel
from database.routes import router as projects_router, share_router
from auth import router as auth_router, get_current_user
from database.models import User

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

settings = get_settings()


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    project_id: Optional[int] = None


class ChatResponse(BaseModel):
    content: str
    data: Optional[dict] = None
    query_type: Optional[str] = None
    target: Optional[str] = None
    sources: list[str] = []
    result_count: int = 0
    query_id: Optional[int] = None
    cached: bool = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting GenomeChat API...")
    try:
        create_tables()
        logger.info("Database tables created/verified.")
    except Exception as e:
        logger.warning(f"Database init failed (continuing without DB): {e}")
    yield
    logger.info("Shutting down.")


app = FastAPI(
    title="GenomeChat API",
    description="Natural language genomics research platform powered by Claude AI",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects_router)
app.include_router(share_router)
app.include_router(auth_router)


@app.get("/health", response_model=HealthResponse)
async def health_check():
    db_status = "connected"
    try:
        db_gen = get_db()
        db = next(db_gen)
        db.execute(__import__("sqlalchemy").text("SELECT 1"))
        db.close()
    except Exception:
        db_status = "unavailable"
    return HealthResponse(status="healthy", database=db_status, cache_size=cache.size())


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest, db: Session = Depends(get_db), current_user: Optional[User] = Depends(get_current_user)):
    """
    Primary chat endpoint. Interprets the message, fetches genomics data if needed,
    then has Claude explain the results with full conversation context.
    """
    history_dicts = [{"role": m.role, "content": m.content} for m in request.history]

    # Check cache
    cached = cache.get(request.message)
    if cached:
        return ChatResponse(**{**cached, "cached": True})

    # Try to interpret as genomics query
    interpreted = await interpret_query(request.message)

    if interpreted.query_type == QueryType.UNKNOWN:
        # Not a genomics query — treat as follow-up conversation
        content = await answer_followup(request.message, history_dicts)
        return ChatResponse(content=content)

    # Fetch genomics data
    try:
        import asyncio as _asyncio
        if interpreted.query_type == QueryType.COMPARISON_QUERY:
            gene_a = interpreted.filters.get("gene_a", "")
            gene_b = interpreted.filters.get("gene_b", "")
            if not gene_a or not gene_b:
                parts = interpreted.target.split(" vs ")
                gene_a, gene_b = parts[0].strip(), parts[1].strip() if len(parts) > 1 else parts[0]
            data_a, data_b = await _asyncio.gather(
                run_gene_pipeline(gene_a),
                run_gene_pipeline(gene_b),
            )
            pipeline_result = {
                "gene_a": gene_a, "gene_b": gene_b,
                "data_a": data_a, "data_b": data_b,
                "sources": list(set((data_a.get("sources") or []) + (data_b.get("sources") or []))),
            }
            raw_results = []
            sources = pipeline_result["sources"]
        elif interpreted.query_type == QueryType.GENE_QUERY:
            pipeline_result = await run_gene_pipeline(
                interpreted.target,
                population=interpreted.population,
            )
            raw_results = pipeline_result.get("variants", [])
            sources = pipeline_result.get("sources", [])
        else:
            pipeline_result = await run_disease_pipeline(interpreted.target)
            raw_results = pipeline_result.get("genes", [])
            sources = pipeline_result.get("sources", [])
    except Exception as e:
        logger.error(f"Pipeline failed: {e}")
        raise HTTPException(status_code=500, detail=f"Data fetch failed: {e}")

    # Have Claude explain the results
    if interpreted.query_type == QueryType.COMPARISON_QUERY:
        explanation = await explain_comparison(
            gene_a=pipeline_result["gene_a"],
            gene_b=pipeline_result["gene_b"],
            data_a=pipeline_result["data_a"],
            data_b=pipeline_result["data_b"],
            conversation_history=history_dicts,
        )
    else:
        explanation = await explain_results(
            query=request.message,
            query_type=interpreted.query_type.value,
            data=pipeline_result,
            conversation_history=history_dicts,
        )

    # Save to DB — store full response so history can replay it
    query_id = None
    try:
        stored_results = {
            "content": explanation,
            "data": pipeline_result,
            "query_type": interpreted.query_type.value,
            "target": interpreted.target,
            "sources": sources,
            "result_count": len(raw_results),
        }
        db_query = QueryModel(
            project_id=request.project_id,
            user_id=current_user.id if current_user else None,
            query_text=request.message,
            query_type=interpreted.query_type.value,
            target=interpreted.target,
            results=stored_results,
            result_count=len(raw_results),
            sources=sources,
            cached=0,
        )
        db.add(db_query)
        db.commit()
        db.refresh(db_query)
        query_id = db_query.id
    except Exception as e:
        logger.warning(f"DB save failed: {e}")

    response_data = {
        "content": explanation,
        "data": pipeline_result,
        "query_type": interpreted.query_type.value,
        "target": interpreted.target,
        "sources": sources,
        "result_count": len(raw_results),
        "query_id": query_id,
        "cached": False,
    }

    cache.set(request.message, {k: v for k, v in response_data.items() if k != "cached"})

    return ChatResponse(**response_data)


# Keep legacy endpoints for backwards compatibility
@app.post("/execute-query", response_model=QueryResponse)
async def execute_query(request: QueryRequest, db: Session = Depends(get_db)):
    cached = cache.get(request.text)
    if cached:
        cached["cached"] = True
        return QueryResponse(**cached)

    interpreted = await interpret_query(request.text)
    if interpreted.query_type == QueryType.UNKNOWN:
        raise HTTPException(status_code=422, detail=f"Could not interpret: '{request.text}'")

    if interpreted.query_type == QueryType.GENE_QUERY:
        pipeline_result = await run_gene_pipeline(interpreted.target, population=interpreted.population)
        results = pipeline_result.get("variants", [])
        sources = pipeline_result.get("sources", [])
    else:
        pipeline_result = await run_disease_pipeline(interpreted.target)
        results = pipeline_result.get("genes", [])
        sources = pipeline_result.get("sources", [])

    return QueryResponse(
        query=request.text,
        interpreted=interpreted,
        results=results,
        result_count=len(results),
        sources=sources,
    )


@app.post("/interpret-query")
async def interpret_only(request: QueryRequest):
    interpreted = await interpret_query(request.text)
    return {"query": request.text, "interpreted": interpreted.dict()}


@app.post("/batch-query")
async def batch_query(request: BatchQueryRequest, db: Session = Depends(get_db)):
    import asyncio
    tasks = [execute_query(QueryRequest(text=item, project_id=request.project_id), db)
             for item in request.genes_or_diseases]
    responses = await asyncio.gather(*tasks, return_exceptions=True)
    results = []
    for item, resp in zip(request.genes_or_diseases, responses):
        if isinstance(resp, Exception):
            results.append({"query": item, "error": str(resp)})
        else:
            results.append(resp)
    return {"queries": results, "total": len(results)}


@app.get("/cache-stats")
async def cache_stats():
    return cache.stats()


@app.delete("/cache")
async def clear_cache():
    cache.clear()
    return {"message": "Cache cleared"}
