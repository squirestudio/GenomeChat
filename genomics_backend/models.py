from pydantic import BaseModel
from typing import Optional, Any
from enum import Enum


class QueryType(str, Enum):
    GENE_QUERY = "gene_query"
    DISEASE_QUERY = "disease_query"
    COMPARISON_QUERY = "comparison_query"
    UNKNOWN = "unknown"


class QueryRequest(BaseModel):
    text: str
    project_id: Optional[int] = None
    user_id: Optional[int] = None


class BatchQueryRequest(BaseModel):
    genes_or_diseases: list[str]
    project_id: Optional[int] = None


class InterpretedQuery(BaseModel):
    query_type: QueryType
    target: str
    population: Optional[str] = None
    filters: dict[str, Any] = {}
    confidence: float = 1.0


class VariantResult(BaseModel):
    variant_id: str
    gene: str
    rsid: Optional[str] = None
    clinical_significance: Optional[str] = None
    condition: Optional[str] = None
    frequency: Optional[float] = None
    population: Optional[str] = None
    consequence: Optional[str] = None
    hgvs: Optional[str] = None
    protein_position: Optional[int] = None
    review_status: Optional[str] = None
    source: str = "ClinVar"


class GeneResult(BaseModel):
    gene_symbol: str
    gene_id: Optional[str] = None
    disease_association: Optional[str] = None
    description: Optional[str] = None
    publication_count: Optional[int] = None
    chromosome: Optional[str] = None
    source: str = "NCBI"


class QueryResponse(BaseModel):
    query: str
    interpreted: InterpretedQuery
    results: list[Any]
    result_count: int
    sources: list[str]
    cached: bool = False
    query_id: Optional[int] = None
    error: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    database: str
    cache_size: int
    version: str = "1.0.0"
