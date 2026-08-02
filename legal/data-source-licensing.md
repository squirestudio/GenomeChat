# Data source licensing

MyDNA is a **paid product** built on public research databases. Most permit that
freely with attribution. A few do not, or are ambiguous. This file records which
is which, so the question is answered once rather than rediscovered.

**Status of this file:** a developer's reading of published terms, not legal
advice. Where money is involved, confirm before relying on it.

---

## Disconnected — commercial licence required

### OMIM — *disconnected 2026-07-30*

- **Terms:** free for academic and research use. **Commercial use requires a
  licence** from Johns Hopkins University (omim.org/help/agreement). A paid
  subscription product plausibly falls on the commercial side.
- **What it gave us:** gene and phenotype entries with MIM numbers, reached by
  elink from the NCBI Gene UID.
- **What disconnecting cost**, measured across BRCA1, CFTR, LDLR, HFE, TP53 and
  RYR1 before removing it:
  - **Disease names: almost entirely redundant.** Three terms across six genes
    that ClinGen, Monarch, HPO and MedGen did not already cover between them.
    For four of the six, nothing at all was unique.
  - **Inheritance mode: negligible.** OMIM populated it for 2 of 30 phenotypes;
    ClinGen supplied a mode for every gene tested, and more reliably.
  - **Genuinely lost: MIM numbers** as canonical identifiers, links to
    omim.org, and OMIM's very precise phenotype nomenclature.
- **Re-enabling:** `fetch_omim_data` and its tests are intact. Restore the
  `omim` key in `OPTIONAL_SECTIONS` and the entry in the `simple` dispatch map,
  both in `services/genomics_api_real.py`. The frontend was left untouched so
  stored answers containing OMIM data still replay.
- **Worth revisiting if:** a licence is obtained, or MyDNA becomes
  non-commercial. MONDO ids from ClinGen and CUIs from MedGen already
  cross-reference to OMIM without querying it.

---

## Connected, with conditions worth knowing

### ClinPGx (formerly PharmGKB)

- **Terms:** parts of the data are CC-BY-SA, with restrictions on commercial
  redistribution. Share-alike is the awkward part for a commercial product.
- **Assessment:** MyDNA *displays* pharmacogenomic annotations with attribution
  rather than redistributing a dataset, which is the ordinary reading of fair
  use of an attributed source. Not clear-cut.
- **Action:** confirm before pharmacogenomics becomes a headline feature. It is
  currently one deferred section among fourteen.

### NCI GDC / TCGA

- Open access data is unrestricted; **controlled access** tiers exist and are
  not touched. MyDNA queries aggregate mutation counts only, which sit in the
  open tier.

---

## Connected, no commercial restriction

Attribution is expected and is given — in the app footer, on `/about`, and in
each answer's source list.

| Source | Terms |
|---|---|
| **ClinVar, dbSNP, dbVar, MedGen, GTR, PubMed, PMC** (NCBI) | US Government work, public domain. Subject to NCBI usage policies — respect rate limits, use an API key |
| **Ensembl** | Apache 2.0 / open, free for all uses |
| **gnomAD** | Free, no restriction on use; citation requested |
| **UniProt** | CC-BY 4.0 |
| **AlphaFold** (EMBL-EBI/DeepMind) | CC-BY 4.0 |
| **Reactome** | CC0 |
| **MedlinePlus Genetics** (NLM) | US Government work, public domain. NLM asks that content not be presented so as to imply NLM endorsement — so it is quoted and attributed, never rebranded |
| **ClinicalTrials.gov** (NLM) | US Government work, public domain. Listings are informational; presenting one as a recommendation would misrepresent it |
| **Genomics England PanelApp** | Open, no commercial restriction; attribution requested. Panels are NHS clinical policy, so they are reproduced as-is rather than reinterpreted |
| **HGNC** (genenames.org) | Free for all uses, no restriction; citation requested |
| **GTEx** | Open access summary data unrestricted |
| **STRING** | CC-BY 4.0 |
| **Open Targets** | CC0 for the platform data |
| **GWAS Catalog** (EMBL-EBI) | Free, citation requested |
| **ClinGen** | Free and open; CC0 on the gene-validity dump |
| **HPO** | Free for any use, with a licence notice |
| **Monarch Initiative** | Open, BSD-3 |

---

## Standing obligations

- **Attribution stays.** Several of the above require it, and every source list
  in the product is part of meeting that, not decoration.
- **Respect rate limits.** `NCBI_API_KEY` raises the E-utilities cap from 3 to
  10 requests/second and is set in production. Hammering a public resource
  through MyDNA is both an abuse-of-service issue and a term of use for several
  sources.
- **Do not redistribute in bulk.** Answering a reader's question is a different
  activity from republishing a database, and the terms of use forbid using
  MyDNA as a bulk proxy partly for this reason.
- **Re-check on any commercial change.** Moving to enterprise pricing, an API
  product, or anything that redistributes data rather than displaying it changes
  the analysis for several sources above.
