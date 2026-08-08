import asyncio, json
from services.genomics_api_real import run_gene_pipeline
from services.research import research_findings

GENES = ["BRCA1", "COL1A1", "SCN1A", "MTHFR", "RYR1", "CYP2C19"]

async def main():
    for g in GENES:
        try:
            data = await run_gene_pipeline(g)
            r = research_findings(data)
            print(f"\n=== {g} — {len(r['findings'])} findings ===")
            for f in r["findings"]:
                print(f"  [{f['severity']:6}] {f['kind']:24} {f['headline'][:70]}")
            print(f"  ran: {', '.join(r['checked']) or 'none'}")
            print(f"  could not run: {', '.join(r['skipped']) or 'none'}")
            # What data was actually there to analyse?
            print(f"  inputs: variants={len(data.get('variants') or [])} "
                  f"gencc={len(data.get('gencc') or [])} "
                  f"clingen={len(data.get('clingen') or [])} "
                  f"prevalence={len(data.get('prevalence') or [])} "
                  f"loeuf={(data.get('constraint') or {}).get('loeuf')}")
        except Exception as e:
            print(f"\n=== {g} FAILED: {e}")

asyncio.run(main())
