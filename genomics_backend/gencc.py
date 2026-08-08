import asyncio, json
from services.genomics_api_real import fetch_gencc_validity

async def main():
    rows = await fetch_gencc_validity("COL1A1")
    print(f"{len(rows)} gencc rows")
    for r in rows[:2]:
        print(f"\n--- {r.get('disease')} disputed={r.get('disputed')} ---")
        print("  row-level pmids:", r.get("pmids"))
        for v in (r.get("verdicts") or [])[:5]:
            print(f"    {v.get('classification'):12} {str(v.get('submitter'))[:28]:28} "
                  f"date={v.get('date')} pmids={v.get('pmids')}")
asyncio.run(main())
