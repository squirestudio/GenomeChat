import asyncio
from services.genomics_api_real import fetch_pubmed_abstracts

async def main():
    # Two ClinGen cited for Caffey disease, one Orphanet cited, one bogus.
    out = await fetch_pubmed_abstracts(["15864348", "34272483", "22855962", "99999999"])
    print(f"resolved {len(out)} of 4\n")
    for pmid, d in out.items():
        a = d.get("abstract")
        print(f"{pmid}  {d.get('year')}  {(d.get('journal') or '')[:24]:24} abstract={len(a) if a else 0} chars")
        print(f"   {(d.get('title') or '')[:88]}")
        if a: print(f"   {a[:150]}…\n")
asyncio.run(main())
