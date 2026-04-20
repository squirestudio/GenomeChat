"""
GenomeChat API - Example Client
Run: python examples.py
Requires backend running: docker-compose up -d
"""
import httpx
import json

BASE_URL = "http://localhost:8000"


def print_result(label: str, data: dict):
    print(f"\n{'='*60}")
    print(f"  {label}")
    print('='*60)
    print(json.dumps(data, indent=2, default=str))


def health_check():
    r = httpx.get(f"{BASE_URL}/health")
    print_result("Health Check", r.json())


def gene_query(text: str):
    r = httpx.post(
        f"{BASE_URL}/execute-query",
        json={"text": text},
        timeout=60,
    )
    data = r.json()
    print(f"\n{'='*60}")
    print(f"  Query: {text}")
    print('='*60)
    print(f"  Type     : {data.get('interpreted', {}).get('query_type')}")
    print(f"  Target   : {data.get('interpreted', {}).get('target')}")
    print(f"  Results  : {data.get('result_count')} items")
    print(f"  Sources  : {', '.join(data.get('sources', []))}")
    print(f"  Cached   : {data.get('cached')}")
    if data.get("results"):
        print(f"\n  First result:")
        print(f"  {json.dumps(data['results'][0], indent=4, default=str)}")


def batch_query(items: list[str]):
    r = httpx.post(
        f"{BASE_URL}/batch-query",
        json={"genes_or_diseases": items},
        timeout=120,
    )
    data = r.json()
    print(f"\n{'='*60}")
    print(f"  Batch Query ({len(items)} items)")
    print('='*60)
    for q in data.get("queries", []):
        if "error" in q:
            print(f"  {q.get('query')}: ERROR - {q['error']}")
        else:
            print(f"  {q.get('query')}: {q.get('result_count')} results")


def create_project(name: str, description: str = "") -> int:
    r = httpx.post(
        f"{BASE_URL}/projects",
        json={"name": name, "description": description},
    )
    data = r.json()
    print_result(f"Created Project: {name}", data)
    return data["id"]


def list_projects():
    r = httpx.get(f"{BASE_URL}/projects")
    data = r.json()
    print(f"\n{'='*60}")
    print(f"  Projects ({len(data)} total)")
    print('='*60)
    for p in data:
        print(f"  [{p['id']}] {p['name']} — {p['query_count']} queries")


def cache_stats():
    r = httpx.get(f"{BASE_URL}/cache-stats")
    print_result("Cache Stats", r.json())


if __name__ == "__main__":
    print("\nGenomeChat API — Example Queries")
    print("Make sure docker-compose is running: docker-compose up -d\n")

    health_check()

    print("\n--- Gene Queries ---")
    gene_query("What are the pathogenic variants in BRCA1?")
    gene_query("Show me BRCA2 variants in European populations")
    gene_query("TP53 variants")

    print("\n--- Disease Queries ---")
    gene_query("Which genes are associated with early-onset Alzheimer's?")
    gene_query("What genes cause hereditary breast cancer?")

    print("\n--- Batch Query ---")
    batch_query(["BRCA1", "TP53", "EGFR"])

    print("\n--- Project Management ---")
    project_id = create_project("BRCA Research", "Variants in BRCA genes")
    list_projects()

    print("\n--- Cache Stats ---")
    cache_stats()

    print("\nDone! Visit http://localhost:8000/docs to explore the full API.")
