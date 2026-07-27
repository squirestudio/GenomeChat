"""
MyDNA API - Example Client
Run: python examples.py
Requires backend running: docker-compose up -d

Uses the same endpoints the app itself uses. The old /execute-query,
/interpret-query and /batch-query routes this script previously called have been
removed — they had no authentication and no query quota, so anyone could spend
the shared Anthropic key through them.
"""
import json

import httpx

BASE_URL = "http://localhost:8000"

# Most endpoints work anonymously; set a JWT here to exercise the ones that need
# an account (cache management, billing, stored API keys).
TOKEN = ""


def headers() -> dict:
    return {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}


def print_result(label: str, data: dict):
    print(f"\n{'='*60}")
    print(f"  {label}")
    print('='*60)
    print(json.dumps(data, indent=2, default=str))


def health_check():
    r = httpx.get(f"{BASE_URL}/health", timeout=30)
    print_result("Health Check", r.json())


def ask(question: str):
    """Ask a question the way the app does — streamed, staged, metered."""
    print(f"\n{'='*60}")
    print(f"  {question}")
    print('='*60)

    event = None
    answer = []
    with httpx.stream(
        "POST", f"{BASE_URL}/chat/stream",
        json={"message": question},
        headers={"Content-Type": "application/json", **headers()},
        timeout=180,
    ) as r:
        if r.status_code == 402:
            print("  Out of queries — this account needs credits or a subscription.")
            return
        for line in r.iter_lines():
            if line.startswith("event: "):
                event = line[7:].strip()
            elif line.startswith("data: "):
                payload = json.loads(line[6:])
                if event == "status":
                    print(f"  ... {payload.get('stage')}")
                elif event == "data":
                    d = payload.get("data") or {}
                    print(f"  sources: {', '.join(payload.get('sources') or [])}")
                    print(f"  results: {payload.get('result_count', 0)}")
                    pending = d.get("pending_sections") or []
                    if pending:
                        print(f"  {len(pending)} more datasets available on request")
                elif event == "token":
                    answer.append(payload.get("text", ""))
                elif event == "error":
                    print(f"  ERROR: {payload.get('message')}")

    text = "".join(answer).strip()
    if text:
        print("\n" + "\n".join("  " + l for l in text.splitlines()[:14]))
        if len(text.splitlines()) > 14:
            print("  ...")


def load_section(gene: str, section: str):
    """Pull one of the deferred datasets. Costs a credit only if data comes back."""
    r = httpx.post(
        f"{BASE_URL}/gene/section",
        json={"gene": gene, "section": section},
        headers={"Content-Type": "application/json", **headers()},
        timeout=120,
    )
    if r.status_code != 200:
        print(f"  {section}: HTTP {r.status_code}")
        return
    d = r.json()
    state = "empty" if d.get("empty") else "has data"
    print(f"  {gene} / {section}: {state}, charged={d.get('charged')}, cached={d.get('cached')}")


def prices():
    r = httpx.get(f"{BASE_URL}/billing/prices", headers=headers(), timeout=30)
    data = r.json()
    print(f"\n{'='*60}")
    print("  Pricing")
    print('='*60)
    for key in ("unlock", "credits", "byok"):
        p = data.get(key)
        print(f"  {key:8} {p['label'] if p else 'not configured'}")


def cache_stats():
    """Requires an account — the cache endpoints are no longer anonymous."""
    r = httpx.get(f"{BASE_URL}/cache-stats", headers=headers(), timeout=30)
    if r.status_code == 401:
        print("\n  Cache stats need a signed-in account. Set TOKEN at the top of this file.")
        return
    print_result("Cache Stats", r.json())


if __name__ == "__main__":
    print("\nMyDNA API — Example Queries")
    print("Make sure docker-compose is running: docker compose up -d\n")

    health_check()
    prices()

    ask("What are the pathogenic variants in BRCA1?")
    ask("Which genes are associated with Parkinson's disease?")

    print(f"\n{'='*60}")
    print("  Deferred datasets")
    print('='*60)
    load_section("BRCA1", "pathways")
    load_section("BRCA1", "expression")

    cache_stats()
