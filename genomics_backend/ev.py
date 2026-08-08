import asyncio
from services.genomics_api_real import fetch_pubmed_abstracts
from services.ai_explainer import explain_evidence

VERDICTS = [
    {"submitter": "ClinGen", "classification": "Definitive", "date": "2023-09-28",
     "pmids": ["15864348", "34272483"]},
    {"submitter": "Orphanet", "classification": "Supportive", "date": "2021-09-14",
     "pmids": ["22855962"]},
    {"submitter": "Ambry Genetics", "classification": "Moderate", "date": "2023-03-03", "pmids": []},
]

async def main():
    pmids = [p for v in VERDICTS for p in v["pmids"]]
    papers = await fetch_pubmed_abstracts(pmids)
    print(f"papers with abstracts: {sum(1 for d in papers.values() if d.get('abstract'))}/{len(papers)}\n")
    out = await explain_evidence("Caffey disease", "COL1A1", VERDICTS, papers)
    print(out or "(no summary — no API key?)")
asyncio.run(main())
