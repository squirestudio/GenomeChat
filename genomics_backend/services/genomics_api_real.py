import httpx
import asyncio
import contextvars
import csv
import io
import logging
import os
import re
import time
from typing import Optional
from models import VariantResult, GeneResult

logger = logging.getLogger(__name__)

ENSEMBL_BASE = "https://rest.ensembl.org"
# Consumer DNA files (23andMe, AncestryDNA) are reported against GRCh37, while
# Ensembl's main REST endpoint serves GRCh38. The two differ by ~1.85 Mb at
# BRCA1, so intersecting a user's variant positions against a GRCh38 locus does
# not merely blur the result — it lands in an entirely different gene. Anything
# compared against uploaded coordinates must come from this endpoint.
ENSEMBL_GRCH37_BASE = "https://grch37.rest.ensembl.org"
CLINVAR_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
GNOMAD_BASE = "https://gnomad.broadinstitute.org/api"
UNIPROT_BASE = "https://rest.uniprot.org/uniprotkb"
NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
REACTOME_BASE = "https://reactome.org/ContentService"
GTEX_BASE = "https://gtexportal.org/api/v2"
STRING_BASE = "https://string-db.org/api"
OPENTARGETS_BASE = "https://api.platform.opentargets.org/api/v4/graphql"
PHARMGKB_BASE = "https://api.clinpgx.org/v1"   # api.pharmgkb.org no longer resolves
GDC_BASE = "https://api.gdc.cancer.gov"
CLINGEN_BASE = "https://search.clinicalgenome.org/kb"
GWAS_BASE = "https://www.ebi.ac.uk/gwas/rest/api"
HPO_BASE = "https://hpo.jax.org/api/hpo"          # retired — serves 404 HTML
HPO_ANNOTATION_BASE = "https://ontology.jax.org/api"
MONARCH_BASE = "https://api-v3.monarchinitiative.org/v3/api"
MEDLINEPLUS_BASE = "https://medlineplus.gov/download/genetics"
CTGOV_BASE = "https://clinicaltrials.gov/api/v2"
PANELAPP_BASE = "https://panelapp.genomicsengland.co.uk/api/v1"

HEADERS = {"Content-Type": "application/json", "Accept": "application/json"}
TIMEOUT = 30
MAX_RETRIES = 3

# ─── NCBI rate limiting ───────────────────────────────────────────────────────
# E-utilities allows 3 requests/sec anonymously, 10/sec with a free API key.
# A single gene pipeline issues ~20 NCBI calls (ClinVar, PubMed count, twelve
# PubMed timeline year-queries, OMIM, HPO, gene lookups), and firing them
# concurrently earns 429s. The retry backoff then turns a 0.5s call into 8s —
# and at full concurrency ClinVar returns nothing at all, so a BRCA1 query
# silently reports zero variants. Pacing requests is both faster and correct.
NCBI_HOST = "eutils.ncbi.nlm.nih.gov"
NCBI_API_KEY = os.environ.get("NCBI_API_KEY", "").strip()
_NCBI_RATE = 9.0 if NCBI_API_KEY else 2.5   # headroom under the documented cap


class _RateLimiter:
    """Spaces calls so bursts stay under a per-second cap."""

    def __init__(self, per_second: float):
        self._min_interval = 1.0 / per_second
        self._lock = asyncio.Lock()
        self._next_at = 0.0

    async def acquire(self) -> None:
        async with self._lock:
            now = asyncio.get_event_loop().time()
            wait = self._next_at - now
            if wait > 0:
                await asyncio.sleep(wait)
                now = asyncio.get_event_loop().time()
            self._next_at = max(now, self._next_at) + self._min_interval


_ncbi_limiter = _RateLimiter(_NCBI_RATE)


# ─── Which sources actually failed ────────────────────────────────────────────
# Every fetcher tolerates its own upstream failing and returns nothing, which is
# right — one dead source must not take the answer down. But "returned nothing"
# and "could not be reached" then look identical, and that is how ClinVar
# reporting zero variants for BRCA1 went unnoticed: the rate limiter was
# refusing the calls and the gene simply appeared to have no variants.
#
# The HTTP layer records failures here instead, so the pipeline can report them
# without every fetcher needing to change. A ContextVar keeps it per-request:
# concurrent requests do not see each other's failures.
_failed_sources: contextvars.ContextVar[Optional[set]] = contextvars.ContextVar(
    "failed_sources", default=None
)

SOURCE_BY_HOST = {
    "eutils.ncbi.nlm.nih.gov": "NCBI",
    "grch37.rest.ensembl.org": "Ensembl",
    "rest.ensembl.org": "Ensembl",
    "gnomad.broadinstitute.org": "gnomAD",
    "rest.uniprot.org": "UniProt",
    "alphafold.ebi.ac.uk": "AlphaFold",
    "reactome.org": "Reactome",
    "gtexportal.org": "GTEx",
    "string-db.org": "STRING",
    "api.platform.opentargets.org": "OpenTargets",
    "api.pharmgkb.org": "PharmGKB",
    "api.gdc.cancer.gov": "NCI GDC",
    "search.clinicalgenome.org": "ClinGen",
    "www.ebi.ac.uk": "GWAS Catalog",
    "hpo.jax.org": "HPO",
    "ontology.jax.org": "HPO",
    "api-v3.monarchinitiative.org": "Monarch",
}


def _source_for(url: str) -> str:
    for host, name in SOURCE_BY_HOST.items():
        if host in url:
            return name
    return "upstream"


def begin_source_tracking() -> set:
    """Start recording upstream failures for this request."""
    failures: set = set()
    _failed_sources.set(failures)
    return failures


def record_source_failure(url: str, reason: str) -> None:
    failures = _failed_sources.get()
    source = _source_for(url)
    logger.error("Upstream %s failed: %s (%s)", source, reason, url.split("?")[0])
    if failures is not None:
        failures.add(source)


async def _get(client: httpx.AsyncClient, url: str, params: dict = None) -> dict | list | None:
    is_ncbi = NCBI_HOST in url
    if is_ncbi and NCBI_API_KEY:
        params = {**(params or {}), "api_key": NCBI_API_KEY}
    for attempt in range(MAX_RETRIES):
        if is_ncbi:
            await _ncbi_limiter.acquire()
        try:
            response = await client.get(url, params=params, timeout=TIMEOUT, headers=HEADERS)
            if response.status_code == 200:
                return response.json()
            elif response.status_code == 429:
                await asyncio.sleep(2 ** attempt)
            elif response.status_code == 404:
                return None          # legitimately absent, not a failure
            else:
                record_source_failure(url, f"HTTP {response.status_code}")
                return None
        except httpx.TimeoutException:
            logger.warning(f"Timeout on attempt {attempt + 1} for {url}")
            await asyncio.sleep(1)
        except Exception as e:
            record_source_failure(url, f"{type(e).__name__}: {e}")
            return None
    # Retries exhausted — almost always sustained 429s or timeouts.
    record_source_failure(url, f"no response after {MAX_RETRIES} attempts")
    return None


async def lookup_gene_ensembl(gene_symbol: str) -> Optional[dict]:
    async with httpx.AsyncClient() as client:
        url = f"{ENSEMBL_BASE}/lookup/symbol/homo_sapiens/{gene_symbol}"
        data = await _get(client, url, {"expand": 1})
        if data:
            return {
                "id": data.get("id"),
                "symbol": data.get("display_name"),
                "chromosome": data.get("seq_region_name"),
                "start": data.get("start"),
                "end": data.get("end"),
                "strand": data.get("strand"),
                "description": data.get("description", "").split(" [")[0],
                "biotype": data.get("biotype"),
            }
    return None


def _as_dict(value) -> dict:
    """A dict, or an empty one — so `.get()` chains can't trip on None.

    Upstream records routinely carry a key whose value is `null` or `{}` rather
    than omitting it, and `item.get(key, {})` returns None in the first case
    because the key does exist. That difference is what made ClinVar's
    superseded `clinical_significance` field silently win over the field that
    replaced it.
    """
    return value if isinstance(value, dict) else {}


# How many variants to take from each significance band.
#
# Asking ClinVar only for pathogenic variants — which this did — returns a set
# that is 100% Pathogenic for every gene, so the variant map's colour channel
# carries no information and a reader cannot tell a gene whose damage clusters
# in one domain from one where it is scattered. Dropping the filter entirely
# fails the other way: RYR1 unfiltered is 33/40 uncertain-significance, which is
# noise. A lollipop plot earns its keep by showing pathogenic variants *against*
# benign ones, so the bands are sampled deliberately.
#
# Pathogenic still dominates because it is what a reader came for, and the
# ordering below keeps it first in the table.
CLINVAR_BANDS = (
    ("pathogenic", "clinsig_pathogenic[Properties] OR clinsig_likely_pathogenic[Properties]", 20),
    ("uncertain", "clinsig_vus[Properties]", 10),
    ("benign", "clinsig_benign[Properties] OR clinsig_likely_benign[Properties]", 10),
)


# Clinical severity order, mirrored by SIGNIFICANCE in frontend/src/lollipop.js.
CLINVAR_SEVERITY = {
    "Pathogenic": 0,
    "Likely pathogenic": 1,
    "Conflicting classifications of pathogenicity": 2,
    "Uncertain significance": 3,
    "Likely benign": 4,
    "Benign": 5,
}


async def _clinvar_band_ids(client: httpx.AsyncClient, gene_symbol: str,
                            expression: str, limit: int) -> list[str]:
    data = await _get(client, f"{CLINVAR_BASE}/esearch.fcgi", {
        "db": "clinvar",
        "term": f"{gene_symbol}[gene] AND ({expression})",
        "retmax": limit,
        "retmode": "json",
    })
    return (data or {}).get("esearchresult", {}).get("idlist", []) or []


async def fetch_clinvar_variants(gene_symbol: str, max_results: int = 50) -> list[VariantResult]:
    variants = []
    async with httpx.AsyncClient() as client:
        # Sequential rather than gathered: these are NCBI calls sharing one
        # rate limiter, and firing them together only queues them anyway.
        ids = []
        for _, expression, limit in CLINVAR_BANDS:
            ids.extend(await _clinvar_band_ids(client, gene_symbol, expression, limit))

        # Deduplicate while preserving band order — a variant classified in two
        # bands belongs to the more severe one, which came first.
        seen = set()
        ids = [i for i in ids if not (i in seen or seen.add(i))]

        if not ids:
            # A gene with no classified variants at all still deserves its map.
            data = await _get(client, f"{CLINVAR_BASE}/esearch.fcgi", {
                "db": "clinvar", "term": f"{gene_symbol}[gene]",
                "retmax": max_results, "retmode": "json",
            })
            ids = (data or {}).get("esearchresult", {}).get("idlist", []) or []

        if not ids:
            return variants

        fetch_url = f"{CLINVAR_BASE}/esummary.fcgi"
        fetch_params = {
            "db": "clinvar",
            "id": ",".join(ids[:max_results]),
            "retmode": "json",
        }
        fetch_data = await _get(client, fetch_url, fetch_params)
        if not fetch_data:
            return variants

        result = fetch_data.get("result", {})
        uids = result.get("uids", [])

        for uid in uids:
            item = result.get(uid, {})
            if not item:
                continue

            # ClinVar split its single `clinical_significance` field into
            # separate germline / somatic / oncogenicity classifications. The
            # old key is still present but empty, which is the trap: it arrives
            # as `{}` or `null` depending on the record, so a check shaped like
            # `if isinstance(x, dict)` takes the legacy branch, finds no
            # description, and reports "Unknown" — for every variant, including
            # the pathogenic BRCA1 ones the search explicitly asked for. Read
            # the current field first and treat any empty value as absent.
            germline = _as_dict(item.get("germline_classification"))
            legacy = _as_dict(item.get("clinical_significance"))
            oncogenicity = _as_dict(item.get("oncogenicity_classification"))

            significance = (
                germline.get("description")
                or legacy.get("description")
                or oncogenicity.get("description")
                or (item.get("clinical_significance") if isinstance(item.get("clinical_significance"), str) else None)
                or "Unknown"
            )

            title = item.get("title", "")

            # The conditions moved with the classification, into its trait_set.
            traits = germline.get("trait_set") or legacy.get("trait_set") or item.get("trait_set") or []
            condition_names = [
                t.get("trait_name") for t in traits
                if isinstance(t, dict) and t.get("trait_name")
            ]
            condition_name = condition_names[0] if condition_names else "Unknown"

            # The real molecular consequence, rather than the transcript HGVS
            # that used to be put in this field. This is the axis a reader
            # actually reasons about — a nonsense variant truncates the protein,
            # a missense swaps one residue — so it drives shape and colour in
            # the variant map.
            consequences = [
                c for c in (item.get("molecular_consequence_list") or []) if c
            ]
            # "intron variant" rides along on almost every record and says
            # nothing about impact; prefer any consequence that does.
            primary = next((c for c in consequences if c != "intron variant"), None)
            consequence = primary or (consequences[0] if consequences else None)

            # Extract HGVS protein change and position from title
            # Title format: "NM_000059.4(BRCA2):c.5946delT (p.Ser1982ArgfsTer22)"
            hgvs = None
            protein_position = None
            p_match = re.search(r'\(p\.([^)]+)\)', title)
            if p_match:
                hgvs = f"p.{p_match.group(1)}"
                pos_match = re.search(r'[A-Za-z*]+(\d+)', p_match.group(1))
                if pos_match:
                    protein_position = int(pos_match.group(1))

            # How much evidence stands behind the classification — the
            # difference between one submitter's opinion and an expert panel.
            review_status = germline.get("review_status") or legacy.get("review_status") or None

            # ClinVar no longer publishes dbSNP cross-references in esummary —
            # `variation_xrefs` is empty for every record now, including common
            # variants that certainly have rsIDs, and elink to dbSNP returns
            # nothing either. Kept because it costs nothing and may come back,
            # but nothing may depend on it being populated.
            rsid = None
            for vs in item.get("variation_set", []):
                for xref in vs.get("variation_xrefs", []):
                    if xref.get("db_source") == "dbSNP":
                        db_id = xref.get("db_id", "")
                        if db_id:
                            rsid = f"rs{db_id}" if not str(db_id).startswith("rs") else db_id
                        break
                if rsid:
                    break

            # Genomic position on GRCh37, which is what a 23andMe or AncestryDNA
            # file reports. This is what actually ties a ClinVar record to a
            # reader's own genotype now that rsIDs are gone. GRCh38 is
            # deliberately not used as a fallback: the builds disagree by
            # ~1.85 Mb at BRCA1, so a position from the wrong one would match
            # some unrelated variant rather than simply failing to match.
            chromosome = None
            position_grch37 = None
            for vs in item.get("variation_set", []):
                for loc in vs.get("variation_loc") or []:
                    if loc.get("assembly_name") == "GRCh37" and loc.get("start"):
                        chromosome = str(loc.get("chr") or "") or None
                        try:
                            position_grch37 = int(loc["start"])
                        except (TypeError, ValueError):
                            position_grch37 = None
                        break
                if position_grch37:
                    break

            variants.append(VariantResult(
                variant_id=f"VCV{uid}",
                gene=gene_symbol,
                rsid=rsid,
                clinical_significance=significance,
                condition=condition_name,
                consequence=consequence,
                hgvs=hgvs,
                protein_position=protein_position,
                review_status=review_status,
                chromosome=chromosome,
                position_grch37=position_grch37,
                source="ClinVar"
            ))

    # Most severe first, then by position along the protein. The variant table
    # renders in this order, so a reader still meets the pathogenic variants
    # before the benign ones now that both are fetched.
    variants.sort(key=lambda v: (
        CLINVAR_SEVERITY.get((v.clinical_significance or "").split("/")[0].strip(), 99),
        v.protein_position if v.protein_position is not None else 10**9,
    ))
    return variants


async def fetch_gnomad_frequencies(gene_symbol: str, population: Optional[str] = None) -> list[dict]:
    query = """
    query GeneVariants($geneSymbol: String!, $datasetId: DatasetId!) {
      gene(gene_symbol: $geneSymbol, reference_genome: GRCh38) {
        variants(dataset: $datasetId) {
          variant_id
          consequence
          exome {
            ac
            an
            af
            populations {
              id
              ac
              an
              af
            }
          }
          genome {
            ac
            an
            af
          }
        }
      }
    }
    """
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                GNOMAD_BASE,
                json={"query": query, "variables": {"geneSymbol": gene_symbol, "datasetId": "gnomad_r4"}},
                timeout=TIMEOUT,
            )
            if response.status_code != 200:
                return []
            data = response.json()
            variants_raw = data.get("data", {}).get("gene", {}).get("variants", []) or []

            POP_LABELS = {
                "afr": "AFR", "amr": "AMR", "asj": "ASJ",
                "eas": "EAS", "fin": "FIN", "nfe": "NFE", "sas": "SAS", "mid": "MID",
            }
            pop_map = {"european": "nfe", "african": "afr", "east asian": "eas", "south asian": "sas"}
            pop_key = pop_map.get((population or "").lower())

            results = []
            for v in variants_raw[:30]:
                exome = v.get("exome") or {}
                genome = v.get("genome") or {}
                af = exome.get("af") or genome.get("af")

                # Build full per-population AF dict
                all_pop_freq = {}
                pop_filter = None
                for pop in (exome.get("populations") or []):
                    pid = pop.get("id", "").lower()
                    if pid in POP_LABELS:
                        all_pop_freq[POP_LABELS[pid]] = pop.get("af")
                    if pop_key and pid == pop_key:
                        pop_filter = pop.get("af")

                results.append({
                    "variant_id": v.get("variant_id"),
                    "consequence": v.get("consequence"),
                    "allele_frequency": af,
                    "population_frequency": pop_filter,
                    "all_population_frequencies": all_pop_freq,
                    "population": population,
                    "source": "gnomAD"
                })
            return results
    except Exception as e:
        logger.warning(f"gnomAD query failed for {gene_symbol}: {e}")
        return []


async def fetch_alphafold_structure(uniprot_accession: str) -> Optional[dict]:
    if not uniprot_accession:
        return None
    async with httpx.AsyncClient() as client:
        url = f"https://alphafold.ebi.ac.uk/api/prediction/{uniprot_accession}"
        data = await _get(client, url, {})
        if not data or not isinstance(data, list) or not data[0]:
            return None
        entry = data[0]
        return {
            "pdb_url": entry.get("pdbUrl"),
            "entry_id": entry.get("entryId"),
            "gene": entry.get("gene"),
            "uniprot_accession": uniprot_accession,
            "source": "AlphaFold"
        }


async def fetch_uniprot_info(gene_symbol: str) -> Optional[dict]:
    async with httpx.AsyncClient() as client:
        params = {
            "query": f"gene:{gene_symbol} AND organism_id:9606 AND reviewed:true",
            "fields": "gene_names,protein_name,cc_function,length,mass",
            "format": "json",
            "size": 1,
        }
        data = await _get(client, UNIPROT_BASE + "/search", params)
        if not data or not data.get("results"):
            return None
        entry = data["results"][0]
        protein_name = entry.get("proteinDescription", {}).get("recommendedName", {})
        full_name = protein_name.get("fullName", {}).get("value", "Unknown")
        function_comments = [
            c.get("texts", [{}])[0].get("value", "")
            for c in entry.get("comments", [])
            if c.get("commentType") == "FUNCTION"
        ]
        return {
            "protein_name": full_name,
            "function": function_comments[0][:300] if function_comments else None,
            "length": entry.get("sequence", {}).get("length"),
            "accession": entry.get("primaryAccession"),
            "source": "UniProt"
        }


async def fetch_protein_domains(uniprot_accession: str) -> list[dict]:
    """Fetch protein domain and region annotations from UniProt."""
    IMPORTANT_TYPES = {"Domain", "Region", "Motif"}
    try:
        async with httpx.AsyncClient() as client:
            data = await _get(client, f"{UNIPROT_BASE}/{uniprot_accession}", {"format": "json"})
            if not data:
                return []
            features = data.get("features", [])
            domains = []
            for feat in features:
                ftype = feat.get("type", "")
                if ftype not in IMPORTANT_TYPES:
                    continue
                loc = feat.get("location", {})
                start = (loc.get("start") or {}).get("value")
                end = (loc.get("end") or {}).get("value")
                if start is None or end is None or end <= start:
                    continue
                domains.append({
                    "name": feat.get("description", ftype),
                    "type": ftype,
                    "start": start,
                    "end": end,
                })
            return domains
    except Exception as e:
        logger.warning(f"UniProt domain fetch failed for {uniprot_accession}: {e}")
        return []


async def fetch_pubmed_count(gene_symbol: str) -> int:
    async with httpx.AsyncClient() as client:
        params = {
            "db": "pubmed",
            "term": f"{gene_symbol}[TIAB] AND genomics[MeSH]",
            "retmode": "json",
            "rettype": "count",
        }
        data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", params)
        if data:
            return int(data.get("esearchresult", {}).get("count", 0))
    return 0


async def fetch_pubmed_timeline(gene_symbol: str, years: int = 12) -> list[dict]:
    """Fetch PubMed publication counts per year for the last N years."""
    import datetime as dt
    current_year = dt.datetime.utcnow().year
    year_list = list(range(current_year - years + 1, current_year + 1))

    async def count_year(client: httpx.AsyncClient, year: int) -> dict:
        params = {
            "db": "pubmed",
            "term": f"{gene_symbol}[Gene Name]",
            "retmode": "json",
            "rettype": "count",
            "datetype": "pdat",
            "mindate": f"{year}/01/01",
            "maxdate": f"{year}/12/31",
        }
        data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", params)
        count = 0
        if data:
            count = int(data.get("esearchresult", {}).get("count", 0))
        return {"year": year, "count": count}

    async with httpx.AsyncClient() as client:
        tasks = [count_year(client, y) for y in year_list]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    return [r for r in results if isinstance(r, dict)]


def _normalize_disease_name(name: str) -> str:
    """Normalize disease name for NCBI search (remove apostrophes, trailing 's)."""
    return name.replace("'s", "").replace("'s", "").strip()


async def _fetch_genes_from_clinvar(disease_name: str, client: httpx.AsyncClient) -> list[str]:
    """Search ClinVar by disease name and extract unique gene symbols."""
    gene_symbols = []
    norm = _normalize_disease_name(disease_name)

    for term in [
        f'"{disease_name}"[dis] AND "pathogenic"[clinsig] AND "homo sapiens"[orgn]',
        f'"{norm}"[dis] AND "homo sapiens"[orgn]',
        f'{norm}[dis] AND "homo sapiens"[orgn]',
    ]:
        search_params = {
            "db": "clinvar",
            "term": term,
            "retmax": 100,
            "retmode": "json",
        }
        search_data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", search_params)
        ids = (search_data or {}).get("esearchresult", {}).get("idlist", [])
        if ids:
            break

    if not ids:
        return gene_symbols

    fetch_params = {
        "db": "clinvar",
        "id": ",".join(ids[:40]),
        "retmode": "json",
    }
    fetch_data = await _get(client, f"{NCBI_BASE}/esummary.fcgi", fetch_params)
    if not fetch_data:
        return gene_symbols

    result = fetch_data.get("result", {})
    seen = set()
    for uid in result.get("uids", []):
        item = result.get(uid, {})
        genes = item.get("genes", [])
        for g in genes:
            sym = g.get("symbol", "")
            if sym and sym not in seen and len(sym) <= 12:
                seen.add(sym)
                gene_symbols.append(sym)

    return gene_symbols


async def _fetch_gene_details(gene_symbols: list[str], disease_name: str, client: httpx.AsyncClient) -> list[GeneResult]:
    """Given a list of gene symbols, fetch NCBI Gene details for each."""
    if not gene_symbols:
        return []

    # Search for gene IDs by symbol
    term = " OR ".join(f'"{s}"[Gene Symbol]' for s in gene_symbols[:20])
    search_data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", {
        "db": "gene",
        "term": f'({term}) AND "Homo sapiens"[Organism] AND alive[property]',
        "retmax": 25,
        "retmode": "json",
    })
    ids = (search_data or {}).get("esearchresult", {}).get("idlist", [])
    if not ids:
        return []

    fetch_data = await _get(client, f"{NCBI_BASE}/esummary.fcgi", {
        "db": "gene",
        "id": ",".join(ids[:20]),
        "retmode": "json",
    })
    if not fetch_data:
        return []

    result = fetch_data.get("result", {})
    usable = []
    for uid in result.get("uids", []):
        item = result.get(uid, {})
        if not item or item.get("status") == "discontinued":
            continue
        symbol = item.get("name", "")
        if not symbol or symbol == "1":
            continue
        usable.append((uid, item, symbol))

    # Publication counts in parallel. Awaiting one per gene inside the loop made
    # a twenty-gene disease twenty sequential NCBI round trips, each additionally
    # paced by the shared rate limiter. The limiter still enforces the cap; it
    # just no longer has a serial queue in front of it.
    counts = await asyncio.gather(
        *[fetch_pubmed_count(sym) for _, _, sym in usable],
        return_exceptions=True,
    )

    return [
        GeneResult(
            gene_symbol=symbol,
            gene_id=uid,
            disease_association=disease_name,
            description=item.get("description", ""),
            publication_count=count if isinstance(count, int) else 0,
            chromosome=item.get("chromosome", ""),
            source="NCBI",
        )
        for (uid, item, symbol), count in zip(usable, counts)
    ]


async def fetch_disease_genes(disease_name: str) -> list[GeneResult]:
    async with httpx.AsyncClient() as client:
        # Step 1: get gene symbols from ClinVar disease index
        gene_symbols = await _fetch_genes_from_clinvar(disease_name, client)

        # Step 2: if ClinVar returned symbols, fetch their NCBI Gene details
        if gene_symbols:
            genes = await _fetch_gene_details(gene_symbols, disease_name, client)
            if genes:
                return sorted(genes, key=lambda g: g.publication_count or 0, reverse=True)

        # Step 3: fallback — NCBI Gene free-text search with better query
        norm = _normalize_disease_name(disease_name)
        for term in [
            f'"{norm}"[Text Word] AND "Homo sapiens"[Organism] AND alive[property]',
            f'{norm}[Text Word] AND "Homo sapiens"[Organism] AND alive[property]',
        ]:
            search_data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", {
                "db": "gene",
                "term": term,
                "retmax": 20,
                "retmode": "json",
            })
            ids = (search_data or {}).get("esearchresult", {}).get("idlist", [])
            if ids:
                break

        if not ids:
            return []

        fetch_data = await _get(client, f"{NCBI_BASE}/esummary.fcgi", {
            "db": "gene",
            "id": ",".join(ids[:15]),
            "retmode": "json",
        })
        if not fetch_data:
            return []

        result = fetch_data.get("result", {})
        usable = []
        for uid in result.get("uids", []):
            item = result.get(uid, {})
            if not item or item.get("status") == "discontinued":
                continue
            symbol = item.get("name", "")
            if not symbol or symbol == "1":
                continue
            usable.append((uid, item, symbol))

        # Same parallelisation as the primary path above.
        counts = await asyncio.gather(
            *[fetch_pubmed_count(sym) for _, _, sym in usable],
            return_exceptions=True,
        )
        genes = [
            GeneResult(
                gene_symbol=symbol,
                gene_id=uid,
                disease_association=disease_name,
                description=item.get("description", ""),
                publication_count=count if isinstance(count, int) else 0,
                chromosome=item.get("chromosome", ""),
                source="NCBI",
            )
            for (uid, item, symbol), count in zip(usable, counts)
        ]
        return sorted(genes, key=lambda g: g.publication_count or 0, reverse=True)


async def fetch_reactome_pathways(gene_symbol: str, uniprot_accession: Optional[str] = None) -> list[dict]:
    """Biological pathways containing this gene's protein, from Reactome.

    Goes through Reactome's UniProt mapping rather than its search index. The
    previous route searched for a Protein entity and then asked
    `/data/pathways/low/entity/{stId}/allForms`, a path that now 404s — so this
    returned an empty pathway list for every gene, which is indistinguishable
    from a gene genuinely being in no pathways.
    """
    async with httpx.AsyncClient() as client:
        accession = uniprot_accession
        if not accession:
            info = await fetch_uniprot_info(gene_symbol)
            accession = (info or {}).get("accession")
        if not accession:
            return []

        pathways_raw = await _get(
            client, f"{REACTOME_BASE}/data/mapping/UniProt/{accession}/pathways",
            {"species": "9606"},
        )
        if not pathways_raw or not isinstance(pathways_raw, list):
            return []

        pathways = []
        seen = set()
        for p in pathways_raw:
            name = p.get("displayName") or p.get("name", "")
            st_id = p.get("stId", "")
            if not name or name in seen:
                continue
            seen.add(name)
            pathways.append({
                "name": name,
                "pathway_id": st_id,
                "species": p.get("speciesName", "Homo sapiens"),
                "url": f"https://reactome.org/PathwayBrowser/#/{st_id}",
                "source": "Reactome",
            })

        return pathways[:20]


async def fetch_gtex_expression(gene_symbol: str) -> list[dict]:
    """Median expression per tissue, from GTEx.

    Two steps, both required. GTEx keys expression on a *version-pinned* GENCODE
    id (`ENSG00000012048.20`), not on a gene symbol and not on a bare Ensembl
    id, so the symbol must be resolved first — the previous single call passed
    `geneSymbol` with an empty `gencodeId` and earned an HTTP 422 every time.
    The version suffix is why it is looked up rather than derived from the
    Ensembl id we already hold: it changes between GENCODE releases.
    """
    async with httpx.AsyncClient() as client:
        ref = await _get(client, f"{GTEX_BASE}/reference/gene", {"geneId": gene_symbol})
        entries = (ref or {}).get("data") or []
        gencode_id = next(
            (e.get("gencodeId") for e in entries
             if e.get("gencodeId") and str(e.get("geneSymbol", "")).upper() == gene_symbol.upper()),
            None,
        ) or next((e.get("gencodeId") for e in entries if e.get("gencodeId")), None)
        if not gencode_id:
            return []

        # v10 exists but returns nothing for these ids; v8 is the populated set.
        data = await _get(client, f"{GTEX_BASE}/expression/medianGeneExpression", {
            "gencodeId": gencode_id,
            "datasetId": "gtex_v8",
        })
        if not data:
            return []

        expressions = data.get("data", []) if isinstance(data, dict) else []
        results = []
        for item in expressions:
            # medianGeneExpression reports the tissue as an id
            # ("Adipose_Subcutaneous"); make it readable.
            tissue = item.get("tissueSiteDetail") or str(item.get("tissueSiteDetailId", "")).replace("_", " ")
            median = item.get("median")
            if tissue and median is not None:
                results.append({
                    "tissue": tissue,
                    "median_tpm": round(float(median), 2),
                    "unit": "TPM",
                    "source": "GTEx",
                })

        return sorted(results, key=lambda x: x["median_tpm"], reverse=True)[:20]


async def fetch_string_interactions(gene_symbol: str, species: int = 9606, limit: int = 15) -> list[dict]:
    """Fetch protein-protein interactions from STRING DB."""
    async with httpx.AsyncClient() as client:
        # Get STRING IDs for the gene
        map_url = f"{STRING_BASE}/json/get_string_ids"
        map_data = await _get(client, map_url, {
            "identifiers": gene_symbol,
            "species": species,
            "limit": 1,
            "caller_identity": "mydna.chat",
        })
        if not map_data or not isinstance(map_data, list):
            return []

        string_id = map_data[0].get("stringId")
        if not string_id:
            return []

        # Get interactions
        interact_url = f"{STRING_BASE}/json/interaction_partners"
        partners = await _get(client, interact_url, {
            "identifiers": string_id,
            "species": species,
            "limit": limit,
            "caller_identity": "mydna.chat",
        })
        if not partners or not isinstance(partners, list):
            return []

        results = []
        for p in partners:
            partner_name = p.get("preferredName_B") or p.get("stringId_B", "")
            score = p.get("score", 0)
            if partner_name and partner_name != gene_symbol:
                results.append({
                    "gene": partner_name,
                    "interaction_score": round(score, 3),
                    "score_pct": round(score * 100, 1),
                    "source": "STRING",
                })

        return sorted(results, key=lambda x: x["interaction_score"], reverse=True)


# Open Targets renamed `knownDrugs` to `drugAndClinicalCandidates` and dropped
# the per-row `phase`, `status`, `mechanismOfAction` and `disease` fields along
# with `Drug.isApproved`. A GraphQL server rejects the whole query when one
# field is unknown, so the old query returned an errors array and no data — and
# the code read the absent `data.target.knownDrugs` as "no drugs target this
# gene". Clinical stage now arrives as an enum string rather than a number.
OPENTARGETS_STAGE_RANK = {
    "APPROVAL": 5, "PHASE_4": 4, "PHASE_3": 3, "PHASE_2": 2, "PHASE_1": 1,
    "EARLY_PHASE_1": 0, "PRECLINICAL": -1,
}

# What to call each stage, decided here rather than in the frontend. The UI's
# own scale tops out at "Approved", so a phase 4 trial — which is a
# post-approval study, not an approval — would otherwise be labelled as one.
OPENTARGETS_STAGE_LABEL = {
    "APPROVAL": "Approved", "PHASE_4": "Phase IV", "PHASE_3": "Phase III",
    "PHASE_2": "Phase II", "PHASE_1": "Phase I", "EARLY_PHASE_1": "Early Phase I",
    "PRECLINICAL": "Preclinical",
}
# Severity band for colour, on the 0–4 scale the UI already uses.
OPENTARGETS_STAGE_BAND = {
    "APPROVAL": 4, "PHASE_4": 4, "PHASE_3": 3, "PHASE_2": 2, "PHASE_1": 1,
    "EARLY_PHASE_1": 1, "PRECLINICAL": 0,
}


async def fetch_open_targets_drugs(ensembl_id: str) -> list[dict]:
    """Approved and investigational drugs targeting a gene, via Open Targets.

    An empty list is a real answer for most genes: a tumour suppressor like
    BRCA1 has none, because a loss of function is not a drug target.
    """
    if not ensembl_id:
        return []
    query = """
    query DrugCandidates($ensemblId: String!) {
      target(ensemblId: $ensemblId) {
        drugAndClinicalCandidates {
          count
          rows {
            maxClinicalStage
            drug {
              id
              name
              drugType
              maximumClinicalStage
              mechanismsOfAction { rows { mechanismOfAction } }
            }
          }
        }
      }
    }
    """
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                OPENTARGETS_BASE,
                json={"query": query, "variables": {"ensemblId": ensembl_id}},
                headers=HEADERS,
                timeout=TIMEOUT,
            )
            if response.status_code != 200:
                record_source_failure(OPENTARGETS_BASE, f"HTTP {response.status_code}")
                return []
            data = response.json()
            # GraphQL answers 200 with an errors array; without this a schema
            # change is indistinguishable from a gene having no drugs.
            if data.get("errors"):
                record_source_failure(OPENTARGETS_BASE, str(data["errors"][:1]))
                return []

            target = (data.get("data") or {}).get("target") or {}
            rows = (target.get("drugAndClinicalCandidates") or {}).get("rows") or []

            seen = set()
            drugs = []
            for row in rows:
                drug = row.get("drug") or {}
                name = (drug.get("name") or "").strip()
                if not name or name in seen:
                    continue
                seen.add(name)
                stage = row.get("maxClinicalStage") or drug.get("maximumClinicalStage")
                mechanisms = [
                    m.get("mechanismOfAction")
                    for m in ((drug.get("mechanismsOfAction") or {}).get("rows") or [])
                    if m.get("mechanismOfAction")
                ]
                drugs.append({
                    "name": name,
                    "drug_type": drug.get("drugType") or "",
                    "stage": stage,
                    "phase": OPENTARGETS_STAGE_BAND.get(stage, 0),
                    "phase_label": OPENTARGETS_STAGE_LABEL.get(stage, "Unknown stage"),
                    "is_approved": stage == "APPROVAL",
                    "mechanism": mechanisms[0] if mechanisms else "",
                    "source": "Open Targets",
                })
            # Uncapped and sorted. The caller decides how many to show, which
            # is what lets the stage counts below be taken from everything
            # rather than from a truncated, approved-first slice — EGFR has 82
            # candidates and the first 25 are all approved, so a pipeline drawn
            # from the visible list would report no trials at all.
            return sorted(
                drugs,
                key=lambda d: -OPENTARGETS_STAGE_RANK.get(d["stage"], -99),
            )
    except Exception as e:
        logger.warning(f"Open Targets drug query failed for {ensembl_id}: {e}")
        return []


async def fetch_gnomad_population_summary(gene_symbol: str) -> list[dict]:
    """Fetch per-ancestry allele frequency summary for a gene from gnomAD."""
    POP_LABELS = {
        "afr": "African/African Am.",
        "amr": "Admixed American",
        "asj": "Ashkenazi Jewish",
        "eas": "East Asian",
        "fin": "Finnish",
        "nfe": "Non-Finnish Eur.",
        "sas": "South Asian",
        "mid": "Middle Eastern",
    }
    query = """
    query PopSummary($geneSymbol: String!) {
      gene(gene_symbol: $geneSymbol, reference_genome: GRCh38) {
        variants(dataset: gnomad_r4) {
          exome {
            ac
            an
            populations {
              id
              ac
              an
            }
          }
        }
      }
    }
    """
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                GNOMAD_BASE,
                json={"query": query, "variables": {"geneSymbol": gene_symbol}},
                headers=HEADERS,
                timeout=TIMEOUT,
            )
            if response.status_code != 200:
                return []
            data = response.json()
            variants_raw = (data.get("data", {}).get("gene", {}) or {}).get("variants", []) or []

            # Aggregate allele counts per population across all variants
            pop_ac: dict[str, int] = {}
            pop_an: dict[str, int] = {}
            for v in variants_raw:
                exome = v.get("exome") or {}
                for pop in exome.get("populations") or []:
                    pid = pop.get("id", "").lower()
                    if pid not in POP_LABELS:
                        continue
                    pop_ac[pid] = pop_ac.get(pid, 0) + (pop.get("ac") or 0)
                    pop_an[pid] = pop_an.get(pid, 0) + (pop.get("an") or 0)

            summary = []
            for pid, label in POP_LABELS.items():
                an = pop_an.get(pid, 0)
                ac = pop_ac.get(pid, 0)
                if an == 0:
                    continue
                summary.append({
                    "population_id": pid,
                    "population": label,
                    "allele_count": ac,
                    "allele_number": an,
                    "allele_frequency": round(ac / an, 8) if an > 0 else 0,
                })
            return sorted(summary, key=lambda x: x["allele_frequency"], reverse=True)
    except Exception as e:
        logger.warning(f"gnomAD population summary failed for {gene_symbol}: {e}")
        return []


# OMIM encodes an entry's kind as a prefix symbol on its `oid` ("*113705").
# The numeric `mimtype` field this code used to read no longer appears in the
# esummary at all, so every entry fell through to an "unknown type" branch and
# BRCA1 — which has a gene entry and four phenotypes — reported neither.
OMIM_PREFIX_KIND = {
    "*": "gene",        # gene of known sequence
    "+": "gene",        # gene of known sequence and phenotype
    "#": "phenotype",   # phenotype, molecular basis known
    "%": "phenotype",   # phenotype or locus, molecular basis unknown
    "^": "removed",     # moved or removed
}


async def fetch_omim_data(gene_symbol: str) -> dict:
    """OMIM gene entry and the disease phenotypes linked to it.

    Reached by elink from the NCBI Gene UID rather than by searching OMIM for
    the symbol: the search returns only the gene entry itself, while the link
    returns the gene together with the phenotypes curators have tied to it,
    which is the part a reader wants.
    """
    INHERITANCE_MAP = {
        "AUTOSOMAL DOMINANT": "AD",
        "AUTOSOMAL RECESSIVE": "AR",
        "X-LINKED DOMINANT": "XLD",
        "X-LINKED RECESSIVE": "XLR",
        "X-LINKED": "XL",
        "MITOCHONDRIAL": "MT",
        "SOMATIC": "SMT",
        "DIGENIC": "DG",
    }

    def detect_inheritance(title: str) -> Optional[str]:
        t = title.upper()
        for phrase, code in INHERITANCE_MAP.items():
            if phrase in t:
                return code
        return None

    try:
        async with httpx.AsyncClient() as client:
            gene_id = await resolve_ncbi_gene_id(gene_symbol, client)
            ids: list[str] = []
            if gene_id:
                ids = await elink_ids("gene", "omim", gene_id, client, limit=25)

            if not ids:
                # Fall back to a direct search, which at least finds the gene
                # entry for a symbol NCBI Gene does not resolve.
                search = await _get(client, f"{NCBI_BASE}/esearch.fcgi", {
                    "db": "omim", "term": f'"{gene_symbol}"[Gene/Locus Symbol]',
                    "retmax": 20, "retmode": "json",
                })
                ids = (search or {}).get("esearchresult", {}).get("idlist", [])

            if not ids:
                return {}

            summary = await _get(client, f"{NCBI_BASE}/esummary.fcgi", {
                "db": "omim", "id": ",".join(ids[:25]), "retmode": "json",
            })
            result = (summary or {}).get("result", {})

            gene_entry = None
            phenotypes = []

            for uid in result.get("uids", []):
                entry = result.get(str(uid)) or {}
                title = (entry.get("title") or "").strip()
                if not title:
                    continue
                oid = str(entry.get("oid") or "")
                prefix = oid[0] if oid and not oid[0].isdigit() else ""
                kind = OMIM_PREFIX_KIND.get(prefix, "phenotype")
                if kind == "removed":
                    continue

                mim = oid.lstrip("*+#%^") or str(uid)
                item = {
                    "mim_number": mim,
                    "title": title,
                    "url": f"https://omim.org/entry/{mim}",
                    "inheritance": detect_inheritance(title),
                }

                if kind == "gene" and gene_entry is None:
                    gene_entry = item
                elif kind == "phenotype":
                    phenotypes.append(item)

            if not gene_entry and not phenotypes:
                return {}

            return {
                "gene_entry": gene_entry,
                "phenotypes": phenotypes[:12],
                "source": "OMIM",
            }
    except Exception as e:
        logger.warning(f"OMIM fetch failed for {gene_symbol}: {e}")
        return {}


async def fetch_pharmgkb_data(gene_symbol: str) -> dict:
    """Pharmacogenomics: which drugs this gene's variants affect, and how well
    established each link is.

    PharmGKB became ClinPGx and `api.pharmgkb.org` no longer resolves at all —
    a DNS failure, so every call raised before reaching a status code. The API
    shape survived the move; the host and a couple of parameter names did not.
    Drugs now come from the clinical annotations rather than from the gene
    record, which no longer carries `relatedChemicals`.
    """
    LEVEL_LABELS = {
        "1A": "Highest evidence (guideline-supported)",
        "1B": "High evidence",
        "2A": "Moderate evidence (guideline gene)",
        "2B": "Moderate evidence",
        "3": "Limited evidence",
        "4": "Case reports only",
    }
    LEVEL_ORDER = ["1A", "1B", "2A", "2B", "3", "4"]

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            gene_data = await _get(client, f"{PHARMGKB_BASE}/data/gene",
                                   {"symbol": gene_symbol, "view": "max"})
            gene_list = (gene_data or {}).get("data") or []
            gene = (gene_list[0] if isinstance(gene_list, list) else gene_list) or {}
            gene_id = gene.get("id", "")

            # `view=max` is required — the annotations carry no evidence level
            # or drug list without it, and `view=base` is rejected outright.
            ann_data = await _get(client, f"{PHARMGKB_BASE}/data/clinicalAnnotation",
                                  {"location.genes.symbol": gene_symbol, "view": "max"})
            annotations_raw = (ann_data or {}).get("data") or []

            annotations = []
            drug_names: dict[str, str] = {}
            for ann in annotations_raw:
                level = str(((ann.get("levelOfEvidence") or {}).get("term") or "")).strip()
                chemicals = [
                    c.get("name") for c in (ann.get("relatedChemicals") or []) if c.get("name")
                ]
                def strength(lvl):
                    """Lower is stronger; anything unrated sorts last."""
                    return LEVEL_ORDER.index(lvl) if lvl in LEVEL_ORDER else 99

                for name in chemicals:
                    # A drug can appear in several annotations; keep the
                    # strongest evidence any of them carries.
                    current = drug_names.get(name)
                    if current is None or strength(level) < strength(current):
                        drug_names[name] = level

                accession = ann.get("accessionId") or ann.get("id")

                # The genotype-specific interpretations, which are the whole
                # point of a pharmacogenomic annotation: "patients with the CC
                # genotype may have increased risk of X on drug Y". These were
                # being fetched and then dropped, so the only way to read them
                # was to follow the link out to ClinPGx — whose own page for
                # some accessions renders an error. Keeping the allele attached
                # is what lets the panel match them against an uploaded DNA
                # file, which no external site can do.
                allele_phenotypes = [
                    {
                        "allele": (p.get("allele") or "").strip(),
                        "phenotype": (p.get("phenotype") or "").strip(),
                        "limited_evidence": bool(p.get("limitedEvidence")),
                    }
                    for p in (ann.get("allelePhenotypes") or [])
                    if p.get("phenotype")
                ]

                location = ann.get("location") or {}
                annotations.append({
                    "level": level,
                    "level_label": LEVEL_LABELS.get(level, f"Level {level}" if level else "Unrated"),
                    "drugs": chemicals[:6],
                    # A one-line human summary ClinPGx already composes, e.g.
                    # "rs429358 (APOE); warfarin; Hemorrhage (level 3 Toxicity)".
                    "summary": (ann.get("name") or "").strip() or None,
                    # Either an rsID ("rs429358") or a star-allele list
                    # ("SLCO1B1*1, *5, *15") — ClinPGx uses one field for both,
                    # so the name here has to be the general one.
                    "variant": (location.get("displayName") or "").strip() or None,
                    # Pulled out separately: only an rsID can be matched against
                    # an uploaded DNA file, and only then does the allele column
                    # ("CC", "CT") mean a genotype the reader might carry.
                    "rsids": re.findall(r"rs\d+", location.get("displayName") or ""),
                    "assembly": (location.get("buildVersion") or "").strip() or None,
                    "allele_phenotypes": allele_phenotypes[:12],
                    "types": [t for t in (ann.get("types") or []) if isinstance(t, str)][:3],
                    "has_guideline": bool(ann.get("relatedGuidelines")),
                    "url": f"https://www.clinpgx.org/clinicalAnnotation/{accession}" if accession else None,
                })

            def level_key(item):
                lvl = item.get("level") or ""
                return LEVEL_ORDER.index(lvl) if lvl in LEVEL_ORDER else 99

            annotations.sort(key=level_key)

            related_drugs = [
                {"name": name, "level": lvl,
                 "level_label": LEVEL_LABELS.get(lvl, f"Level {lvl}" if lvl else "Unrated")}
                for name, lvl in sorted(
                    drug_names.items(),
                    key=lambda kv: (LEVEL_ORDER.index(kv[1]) if kv[1] in LEVEL_ORDER else 99, kv[0]),
                )
            ][:20]

            if not related_drugs and not annotations:
                return {}

            return {
                "gene_symbol": gene_symbol,
                "related_drugs": related_drugs,
                "clinical_annotations": annotations[:15],
                "annotation_total": len(annotations),
                "url": f"https://www.clinpgx.org/gene/{gene_id}" if gene_id
                       else f"https://www.clinpgx.org/search?query={gene_symbol}",
                "source": "ClinPGx (formerly PharmGKB)",
            }
    except Exception as e:
        logger.warning(f"PharmGKB/ClinPGx fetch failed for {gene_symbol}: {e}")
        return {}


TCGA_NAMES = {
    "TCGA-BRCA": "Breast Cancer", "TCGA-OV": "Ovarian Cancer", "TCGA-PRAD": "Prostate Cancer",
    "TCGA-LUAD": "Lung Adenocarcinoma", "TCGA-LUSC": "Lung Squamous Cell", "TCGA-COAD": "Colon Cancer",
    "TCGA-READ": "Rectal Cancer", "TCGA-UCEC": "Endometrial Cancer", "TCGA-STAD": "Stomach Cancer",
    "TCGA-BLCA": "Bladder Cancer", "TCGA-LIHC": "Liver Cancer", "TCGA-KIRC": "Kidney Clear Cell",
    "TCGA-KIRP": "Kidney Papillary", "TCGA-HNSC": "Head & Neck Cancer", "TCGA-GBM": "Glioblastoma",
    "TCGA-LGG": "Lower Grade Glioma", "TCGA-THCA": "Thyroid Cancer", "TCGA-SKCM": "Melanoma",
    "TCGA-PAAD": "Pancreatic Cancer", "TCGA-CESC": "Cervical Cancer", "TCGA-SARC": "Sarcoma",
    "TCGA-LAML": "Acute Myeloid Leukemia", "TCGA-MESO": "Mesothelioma", "TCGA-TGCT": "Testicular GCT",
    "TCGA-DLBC": "Diffuse Large B-Cell Lymphoma", "TCGA-UVM": "Uveal Melanoma",
    "TCGA-ACC": "Adrenocortical Carcinoma", "TCGA-PCPG": "Pheochromocytoma",
    "TCGA-KICH": "Kidney Chromophobe", "TCGA-THYM": "Thymoma", "TCGA-CHOL": "Cholangiocarcinoma",
    "TCGA-ESCA": "Esophageal Cancer", "TCGA-UCS": "Uterine Carcinosarcoma",
    # GDC now carries non-TCGA programmes too; these are the ones that surface
    # most often, so a reader is not left decoding a bare project code.
    "CPTAC-3": "CPTAC-3 (multi-cancer proteogenomics)",
    "ALCHEMIST-ALCH": "ALCHEMIST (early-stage lung)",
    "MMRF-COMMPASS": "Multiple Myeloma (MMRF)",
    "TARGET-ALL-P2": "Paediatric Acute Lymphoblastic Leukaemia",
    "BEATAML1.0-COHORT": "Acute Myeloid Leukaemia (Beat AML)",
}


async def fetch_cancer_mutations(gene_symbol: str) -> dict:
    """Somatic mutations in this gene across cancer projects, from NCI GDC.

    Counts come from `/ssm_occurrences` rather than `/ssms`: an occurrence is
    one mutation seen in one case, which is what makes a per-project tally
    meaningful. `/ssms` does not expose `case.project.project_id` as a facet at
    all — it answered 200 while reporting `unrecognized values` in a `warnings`
    key nothing read, so the panel was empty for every gene while the request
    looked successful.
    """
    gene_filter = {
        "op": "=",
        "content": {"field": "ssm.consequence.transcript.gene.symbol", "value": gene_symbol},
    }

    async def facet(name: str) -> list[dict]:
        try:
            async with httpx.AsyncClient(timeout=90) as client:
                resp = await client.post(
                    f"{GDC_BASE}/ssm_occurrences",
                    json={"filters": gene_filter, "facets": name, "size": 0},
                    headers={"Content-Type": "application/json", "Accept": "application/json"},
                )
                if resp.status_code != 200:
                    record_source_failure(f"{GDC_BASE}/ssm_occurrences", f"HTTP {resp.status_code}")
                    return []
                payload = resp.json()
                # GDC reports a rejected facet here rather than as an error.
                warning = (payload.get("warnings") or {}).get("facets")
                if warning:
                    record_source_failure(f"{GDC_BASE}/ssm_occurrences", f"facet rejected: {warning}")
                    return []
                aggs = (payload.get("data") or {}).get("aggregations") or {}
                return (aggs.get(name) or {}).get("buckets") or []
        except Exception as e:
            record_source_failure(f"{GDC_BASE}/ssm_occurrences", str(e))
            return []

    try:
        project_buckets, consequence_buckets = await asyncio.gather(
            facet("case.project.project_id"),
            facet("ssm.consequence.transcript.consequence_type"),
        )

        cancer_types = [
            {
                "project_id": b.get("key", ""),
                "cancer_type": TCGA_NAMES.get(b.get("key", ""), b.get("key", "")),
                "mutation_count": b.get("doc_count", 0),
            }
            for b in sorted(project_buckets, key=lambda x: x.get("doc_count", 0), reverse=True)[:15]
            if b.get("key")
        ]

        consequence_types = [
            {
                "type": str(b.get("key", "")).replace("_variant", "").replace("_", " ").title(),
                "count": b.get("doc_count", 0),
            }
            for b in sorted(consequence_buckets, key=lambda x: x.get("doc_count", 0), reverse=True)[:8]
            if b.get("key")
        ]

        if not cancer_types:
            return {}

        return {
            "cancer_types": cancer_types,
            "consequence_types": consequence_types,
            # The tally across every project, not just the fifteen shown.
            "total_mutations": sum(b.get("doc_count", 0) for b in project_buckets),
            "project_count": len(project_buckets),
            "source": "NCI GDC / TCGA",
        }
    except Exception as e:
        logger.warning(f"GDC cancer mutation fetch failed for {gene_symbol}: {e}")
        return {}


CLINGEN_VALIDITY_ORDER = ["Definitive", "Strong", "Moderate", "Limited", "Disputed", "Refuted", "No Reported Evidence"]


# ClinGen publishes no per-gene JSON API. `search.clinicalgenome.org/kb` is a
# web application: it answered every request with 200 and 176 KB of HTML, which
# the old code fed to `resp.json()` — so every gene raised a JSON decode error
# and reported no curations at all, including genes with Definitive ones.
#
# The machine-readable route is a CSV of the entire corpus (~1.1 MB). Fetching
# that per query would be absurd, so it is loaded once and indexed by symbol.
CLINGEN_CSV_URL = "https://search.clinicalgenome.org/kb/gene-validity/download"
CLINGEN_TTL_SECONDS = 24 * 3600

_clingen_table: dict[str, list[dict]] = {}
_clingen_loaded_at = 0.0
_clingen_lock = asyncio.Lock()


def _parse_clingen_csv(text: str) -> dict[str, list[dict]]:
    """Index the ClinGen dump by gene symbol.

    The file carries a title preamble and rows of `+++++` used as visual rules,
    so rows are located by finding the header rather than by skipping a fixed
    count — a preamble that grows by a line would otherwise silently shift
    every field by one column.
    """
    rows = list(csv.reader(io.StringIO(text)))
    header_idx = next(
        (i for i, r in enumerate(rows) if r and r[0].strip().upper() == "GENE SYMBOL"),
        None,
    )
    if header_idx is None:
        return {}
    header = [c.strip().upper() for c in rows[header_idx]]

    def col(name):
        try:
            return header.index(name)
        except ValueError:
            return None

    idx = {k: col(v) for k, v in {
        "gene": "GENE SYMBOL", "disease": "DISEASE LABEL", "mondo": "DISEASE ID (MONDO)",
        "moi": "MOI", "classification": "CLASSIFICATION", "report": "ONLINE REPORT",
        "date": "CLASSIFICATION DATE", "gcep": "GCEP",
    }.items()}
    if idx["gene"] is None or idx["classification"] is None:
        return {}

    def get(row, key):
        i = idx.get(key)
        return row[i].strip() if i is not None and i < len(row) else ""

    table: dict[str, list[dict]] = {}
    for row in rows[header_idx + 1:]:
        if not row or not row[0].strip() or set(row[0].strip()) == {"+"}:
            continue
        symbol = get(row, "gene").upper()
        classification = get(row, "classification")
        if not symbol or not classification:
            continue
        table.setdefault(symbol, []).append({
            "disease": get(row, "disease") or "Unknown",
            # MONDO ties this disease to the same one in HPO, Monarch and OMIM.
            "mondo_id": get(row, "mondo") or None,
            "classification": classification,
            "moi": get(row, "moi"),
            "gcep": get(row, "gcep"),
            "classified_on": get(row, "date") or None,
            "url": get(row, "report") or "https://search.clinicalgenome.org/kb/gene-validity",
        })
    return table


async def _ensure_clingen_table() -> dict[str, list[dict]]:
    global _clingen_table, _clingen_loaded_at
    now = time.time()
    if _clingen_table and now - _clingen_loaded_at < CLINGEN_TTL_SECONDS:
        return _clingen_table
    async with _clingen_lock:
        # Re-check: another request may have loaded it while we waited.
        if _clingen_table and time.time() - _clingen_loaded_at < CLINGEN_TTL_SECONDS:
            return _clingen_table
        try:
            async with httpx.AsyncClient(timeout=90) as client:
                resp = await client.get(CLINGEN_CSV_URL, follow_redirects=True)
                resp.raise_for_status()
                parsed = _parse_clingen_csv(resp.text)
            if parsed:
                _clingen_table = parsed
                _clingen_loaded_at = time.time()
                logger.info("ClinGen validity table loaded: %d genes", len(parsed))
            else:
                record_source_failure(CLINGEN_CSV_URL, "table parsed to nothing")
        except Exception as e:
            record_source_failure(CLINGEN_CSV_URL, str(e))
            logger.warning(f"ClinGen table load failed: {e}")
    return _clingen_table


async def fetch_clingen_validity(gene_symbol: str) -> list[dict]:
    """Expert-panel gene-disease validity classifications for one gene."""
    try:
        table = await _ensure_clingen_table()
        results = list(table.get(gene_symbol.upper(), []))

        def sort_key(r):
            try:
                return CLINGEN_VALIDITY_ORDER.index(r["classification"])
            except ValueError:
                return 99

        return sorted(results, key=sort_key)[:15]
    except Exception as e:
        logger.warning(f"ClinGen validity fetch failed for {gene_symbol}: {e}")
        return []


# The GWAS Catalog has no gene-keyed association endpoint — `associations/
# search/findByGene` 404s, which the old code read as "this gene has no trait
# associations". Associations hang off SNPs, so the route is gene -> SNPs ->
# associations. Capped because that second step is one request per SNP.
GWAS_MAX_SNPS = 15


async def _gwas_associations_for_snp(client: httpx.AsyncClient, rs_id: str) -> list[dict]:
    data = await _get(client, f"{GWAS_BASE}/singleNucleotidePolymorphisms/{rs_id}/associations",
                      {"projection": "associationBySnp"})
    out = []
    for a in ((data or {}).get("_embedded") or {}).get("associations", []) or []:
        traits = [t.get("trait") for t in (a.get("efoTraits") or []) if t.get("trait")]
        if not traits:
            continue

        p_value = None
        mantissa, exponent = a.get("pvalueMantissa"), a.get("pvalueExponent")
        if mantissa is not None and exponent is not None:
            try:
                p_value = float(mantissa) * (10 ** int(exponent))
            except (TypeError, ValueError):
                p_value = None

        risk_allele, risk_frequency = None, None
        for locus in a.get("loci") or []:
            for allele in locus.get("strongestRiskAlleles") or []:
                risk_allele = allele.get("riskAlleleName")
                risk_frequency = allele.get("riskFrequency")
                break
            if risk_allele:
                break

        for trait in traits:
            out.append({
                "trait": trait,
                "rsid": rs_id,
                "p_value": p_value,
                # Odds ratio and beta are different measures and must not be
                # merged into one number: an OR of 1.2 and a beta of 1.2 mean
                # entirely different things.
                "odds_ratio": a.get("orPerCopyNum"),
                "beta": a.get("betaNum"),
                "beta_unit": a.get("betaUnit"),
                "beta_direction": a.get("betaDirection"),
                "risk_allele": risk_allele,
                "risk_frequency": risk_frequency,
                "url": f"https://www.ebi.ac.uk/gwas/variants/{rs_id}",
                "source": "GWAS Catalog",
            })
    return out


async def fetch_gwas_associations(gene_symbol: str) -> list[dict]:
    """Genome-wide association study hits for variants mapped to this gene."""
    try:
        async with httpx.AsyncClient() as client:
            snp_data = await _get(client, f"{GWAS_BASE}/singleNucleotidePolymorphisms/search/findByGene",
                                  {"geneName": gene_symbol, "size": 50})
            snps = ((snp_data or {}).get("_embedded") or {}).get("singleNucleotidePolymorphisms", []) or []
            rs_ids = [s.get("rsId") for s in snps if s.get("rsId")][:GWAS_MAX_SNPS]
            if not rs_ids:
                return []

            batches = await asyncio.gather(
                *[_gwas_associations_for_snp(client, rs) for rs in rs_ids],
                return_exceptions=True,
            )

            results = []
            for batch in batches:
                if isinstance(batch, Exception):
                    continue
                results.extend(batch)

            # One trait can be reported by many studies; keep the strongest
            # result per trait so the panel reads as a list of findings rather
            # than a list of papers.
            best: dict[str, dict] = {}
            for r in results:
                current = best.get(r["trait"])
                if current is None or (r["p_value"] is not None and
                                       (current["p_value"] is None or r["p_value"] < current["p_value"])):
                    best[r["trait"]] = r

            return sorted(best.values(), key=lambda r: (r["p_value"] is None, r["p_value"] or 0))[:20]
    except Exception as e:
        logger.warning(f"GWAS fetch failed for {gene_symbol}: {e}")
        return []


async def fetch_hpo_terms(gene_symbol: str, ncbi_gene_id: Optional[str] = None) -> dict:
    """Fetch HPO phenotype terms associated with a gene."""
    try:
        async with httpx.AsyncClient() as client:
            # Resolve NCBI gene ID if not provided — search by symbol
            gene_id = ncbi_gene_id
            if not gene_id:
                search_url = f"{NCBI_BASE}/esearch.fcgi"
                params = {"db": "gene", "term": f"{gene_symbol}[gene] AND Homo sapiens[orgn]",
                          "retmode": "json", "retmax": 1}
                data = await _get(client, search_url, params)
                ids = (data or {}).get("esearchresult", {}).get("idlist", [])
                gene_id = ids[0] if ids else None

            if not gene_id:
                return {}

            # HPO retired the hpo.jax.org/api/hpo API — it now serves a 404 HTML
            # page, which the old code read as "this gene has no phenotypes".
            # The replacement is the ontology service, keyed by CURIE.
            data = await _get(client, f"{HPO_ANNOTATION_BASE}/network/annotation/NCBIGene:{gene_id}")
            if not isinstance(data, dict):
                return {}

            terms = [
                {
                    "id": t.get("id", ""),
                    "name": t.get("name", ""),
                    "definition": t.get("definition") or "",
                    "url": f"https://hpo.jax.org/browse/term/{t.get('id', '')}",
                }
                for t in (data.get("phenotypes") or []) if t.get("id")
            ]

            diseases = [
                {
                    "id": d.get("id", ""),
                    "name": d.get("name", ""),
                    "db": d.get("id", "").split(":")[0] if ":" in (d.get("id") or "") else "",
                    # MONDO is the identifier that lets a disease here be tied
                    # to the same disease in MedGen, Monarch and OMIM.
                    "mondo_id": d.get("mondoId"),
                }
                for d in (data.get("diseases") or []) if d.get("id")
            ]

            if not terms and not diseases:
                return {}

            return {
                "gene_symbol": gene_symbol,
                "ncbi_gene_id": gene_id,
                "phenotype_terms": terms[:40],
                "phenotype_total": len(terms),
                "disease_associations": diseases[:20],
            }
    except Exception as e:
        logger.warning(f"HPO fetch failed for {gene_symbol}: {e}")
        return {}


# Monarch keys human genes on HGNC. An NCBI Gene id — which is what the rest of
# this module resolves — returns `total: 0` with HTTP 200, so the old code read
# a namespace mismatch as "this gene has no associations". BRCA1 has 5,629.
MONARCH_DISEASE_CATEGORIES = (
    "biolink:CausalGeneToDiseaseAssociation",
    "biolink:CorrelatedGeneToDiseaseAssociation",
)
MONARCH_PHENOTYPE_CATEGORY = "biolink:GeneToPhenotypicFeatureAssociation"


async def _monarch_hgnc_id(client: httpx.AsyncClient, gene_symbol: str) -> Optional[str]:
    """Resolve a gene symbol to the HGNC CURIE Monarch indexes on."""
    data = await _get(client, f"{MONARCH_BASE}/search",
                      {"q": gene_symbol, "category": "biolink:Gene", "limit": 10})
    items = (data or {}).get("items") or []
    exact = [
        i for i in items
        if str(i.get("name", "")).upper() == gene_symbol.upper()
        and str(i.get("id", "")).startswith("HGNC:")
    ]
    if exact:
        return exact[0]["id"]
    return next((i["id"] for i in items if str(i.get("id", "")).startswith("HGNC:")), None)


async def _monarch_items(client: httpx.AsyncClient, hgnc_id: str, category: str, limit: int) -> list[dict]:
    data = await _get(client, f"{MONARCH_BASE}/association",
                      {"entity": hgnc_id, "category": category, "limit": limit})
    return (data or {}).get("items") or []


async def fetch_monarch_associations(gene_symbol: str, ncbi_gene_id: Optional[str] = None) -> dict:
    """Diseases and phenotypes linked to a gene, from the Monarch Initiative."""
    try:
        async with httpx.AsyncClient() as client:
            hgnc_id = await _monarch_hgnc_id(client, gene_symbol)
            if not hgnc_id:
                return {}

            batches = await asyncio.gather(
                *[_monarch_items(client, hgnc_id, c, 25) for c in MONARCH_DISEASE_CATEGORIES],
                _monarch_items(client, hgnc_id, MONARCH_PHENOTYPE_CATEGORY, 40),
                return_exceptions=True,
            )
            *disease_batches, phenotype_batch = [
                b if not isinstance(b, Exception) else [] for b in batches
            ]

            def entry(item, causal=None):
                out = {
                    "id": item.get("object"),
                    "name": item.get("object_label") or item.get("object"),
                    "url": f"https://monarchinitiative.org/{item.get('object')}",
                }
                if causal is not None:
                    # Whether the gene causes the disease or is merely
                    # associated with it is the whole difference between the
                    # two categories, and must not be flattened away.
                    out["causal"] = causal
                return out

            diseases, seen = [], set()
            for batch, category in zip(disease_batches, MONARCH_DISEASE_CATEGORIES):
                for item in batch:
                    if not item.get("object") or item["object"] in seen:
                        continue
                    seen.add(item["object"])
                    diseases.append(entry(item, causal="Causal" in category))

            phenotypes, seen_p = [], set()
            for item in phenotype_batch:
                if not item.get("object") or item["object"] in seen_p:
                    continue
                seen_p.add(item["object"])
                phenotypes.append(entry(item))

            if not diseases and not phenotypes:
                return {}

            return {
                "gene_symbol": gene_symbol,
                "monarch_id": hgnc_id,
                # Causal associations first — they are the ones that answer
                # "does this gene cause a disease".
                "diseases": sorted(diseases, key=lambda d: not d.get("causal"))[:20],
                "phenotypes": phenotypes[:30],
                "source": "Monarch",
            }
    except Exception as e:
        logger.warning(f"Monarch fetch failed for {gene_symbol}: {e}")
        return {}


async def resolve_ncbi_gene_id(gene_symbol: str, client: httpx.AsyncClient = None) -> Optional[str]:
    """NCBI Gene UID for a human gene symbol, or None."""
    async def _lookup(c):
        data = await _get(c, f"{NCBI_BASE}/esearch.fcgi", {
            "db": "gene",
            "term": f"{gene_symbol}[gene] AND Homo sapiens[orgn]",
            "retmode": "json", "retmax": 1,
        })
        ids = (data or {}).get("esearchresult", {}).get("idlist", [])
        return ids[0] if ids else None

    try:
        if client is not None:
            return await _lookup(client)
        async with httpx.AsyncClient() as c:
            return await _lookup(c)
    except Exception as e:
        logger.warning(f"NCBI gene id lookup failed for {gene_symbol}: {e}")
        return None


async def elink_ids(dbfrom: str, db: str, uid: str, client: httpx.AsyncClient,
                    limit: int = 200) -> list[str]:
    """UIDs in `db` linked to `uid` in `dbfrom`.

    Note the explicit `db`: an elink call that omits it returns PubMed links
    only, which looks like a working call that simply found nothing elsewhere.
    """
    try:
        data = await _get(client, f"{NCBI_BASE}/elink.fcgi", {
            "dbfrom": dbfrom, "db": db, "id": uid, "retmode": "json",
        })
        out = []
        for linkset in (data or {}).get("linksets", []):
            for linksetdb in linkset.get("linksetdbs") or []:
                for link in linksetdb.get("links") or []:
                    out.append(str(link))
                    if len(out) >= limit:
                        return out
        return out
    except Exception as e:
        logger.warning(f"elink {dbfrom}->{db} failed for {uid}: {e}")
        return []


async def fetch_gene_locus_grch37(gene_symbol: str) -> Optional[dict]:
    """Gene coordinates on GRCh37, the build consumer DNA files are reported in.

    Kept separate from `lookup_gene_ensembl` (GRCh38) precisely so the two can
    never be confused at the call site — see the note on ENSEMBL_GRCH37_BASE.
    """
    try:
        async with httpx.AsyncClient() as client:
            data = await _get(
                client, f"{ENSEMBL_GRCH37_BASE}/lookup/symbol/homo_sapiens/{gene_symbol}",
                {"expand": 0},
            )
            if not data or not data.get("seq_region_name"):
                return None
            return {
                "chromosome": str(data.get("seq_region_name")),
                "start": data.get("start"),
                "end": data.get("end"),
                "assembly": data.get("assembly_name") or "GRCh37",
            }
    except Exception as e:
        logger.warning(f"GRCh37 locus lookup failed for {gene_symbol}: {e}")
        return None


def _parse_maf(entry: dict) -> Optional[float]:
    """Highest-quality global minor allele frequency dbSNP reports, if any.

    `global_mafs` is a list of per-study strings shaped like "A=0.161342/808".
    1000Genomes is preferred when present because it is the study most readers
    will have seen quoted elsewhere.
    """
    mafs = entry.get("global_mafs") or []
    chosen = next((m for m in mafs if m.get("study") == "1000Genomes"), None) or (mafs[0] if mafs else None)
    if not chosen:
        return None
    freq = str(chosen.get("freq", ""))
    if "=" not in freq:
        return None
    try:
        return float(freq.split("=", 1)[1].split("/", 1)[0])
    except (ValueError, IndexError):
        return None


# dbSNP accepts many ids per esummary call; batching keeps a lookup of a
# reader's matched variants to one or two requests against the shared NCBI
# budget rather than one per variant.
DBSNP_BATCH = 100

# Conventional lower bound for calling something a structural variant.
SV_MIN_SPAN_BP = 50


async def fetch_dbsnp_annotations(rsids: list[str]) -> dict:
    """Annotate rsIDs with gene, consequence, clinical significance and frequency.

    Keyed by rsID with the `rs` prefix intact, so callers can look up the same
    string they hold. Unknown rsIDs are simply absent.
    """
    clean = []
    for r in rsids:
        digits = str(r).strip().lower().lstrip("rs")
        if digits.isdigit():
            clean.append(digits)
    if not clean:
        return {}

    out = {}
    try:
        async with httpx.AsyncClient() as client:
            for i in range(0, len(clean), DBSNP_BATCH):
                batch = clean[i:i + DBSNP_BATCH]
                data = await _get(client, f"{NCBI_BASE}/esummary.fcgi", {
                    "db": "snp", "id": ",".join(batch), "retmode": "json",
                })
                result = (data or {}).get("result", {})
                for uid in result.get("uids", []):
                    entry = result.get(str(uid)) or {}
                    # An unknown rsID comes back as a record carrying an error
                    # rather than as an omission. Passing it through would tell
                    # a reader their variant exists and means nothing, when in
                    # fact dbSNP has never heard of it.
                    if entry.get("error") or not entry.get("snp_id"):
                        continue
                    genes = [g.get("name") for g in (entry.get("genes") or []) if g.get("name")]
                    sig = (entry.get("clinical_significance") or "").strip()
                    fxn = (entry.get("fxn_class") or "").strip()
                    out[f"rs{uid}"] = {
                        "rsid": f"rs{uid}",
                        "genes": genes,
                        # Both fields arrive comma-joined and unordered.
                        "clinical_significance": [s for s in sig.split(",") if s] or [],
                        "consequences": sorted({s for s in fxn.split(",") if s}),
                        "chrpos": entry.get("chrpos") or None,
                        "chrpos_grch37": entry.get("chrpos_prev_assembly") or None,
                        "maf": _parse_maf(entry),
                        "url": f"https://www.ncbi.nlm.nih.gov/snp/rs{uid}",
                    }
    except Exception as e:
        logger.warning(f"dbSNP annotation failed: {e}")
    return out


async def fetch_genetic_tests(gene_symbol: str) -> dict:
    """Clinically available genetic tests for a gene, from NCBI's GTR."""
    try:
        async with httpx.AsyncClient() as client:
            data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", {
                "db": "gtr", "term": f"{gene_symbol}[gene]",
                "retmode": "json", "retmax": 25,
            })
            search = (data or {}).get("esearchresult", {})
            ids = search.get("idlist", [])
            if not ids:
                return {}

            summary = await _get(client, f"{NCBI_BASE}/esummary.fcgi", {
                "db": "gtr", "id": ",".join(ids[:25]), "retmode": "json",
            })
            result = (summary or {}).get("result", {})

            tests = []
            for uid in result.get("uids", []):
                entry = result.get(str(uid)) or {}
                name = (entry.get("testname") or "").strip()
                if not name:
                    continue
                conditions = [c.get("name") for c in (entry.get("conditionlist") or []) if c.get("name")]
                analytes = [a.get("name") for a in (entry.get("analytes") or []) if a.get("name")]
                tests.append({
                    "id": str(uid),
                    "name": name,
                    "lab": (entry.get("labname") or "").strip() or None,
                    "test_type": (entry.get("testtype") or "").strip() or None,
                    "conditions": conditions[:5],
                    "genes_tested": analytes[:12],
                    "url": f"https://www.ncbi.nlm.nih.gov/gtr/tests/{uid}/",
                })

            if not tests:
                return {}
            return {
                # The count from the search, not the page — "25 of 450" is the
                # honest framing, and the reader needs the real total to judge.
                "total": int(search.get("count") or len(tests)),
                "tests": tests,
                "registry_url": f"https://www.ncbi.nlm.nih.gov/gtr/all/tests/?term={gene_symbol}",
                "source": "GTR",
            }
    except Exception as e:
        logger.warning(f"GTR fetch failed for {gene_symbol}: {e}")
        return {}


async def fetch_structural_variants(gene_symbol: str) -> dict:
    """Pathogenic structural variants from dbVar.

    ClinVar covers SNVs and small indels; whole-exon deletions and duplications
    live in dbVar and are otherwise invisible to this app. Restricted to
    pathogenic interpretations because the unfiltered set is mostly common
    insertions of no clinical interest.
    """
    try:
        async with httpx.AsyncClient() as client:
            data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", {
                "db": "dbvar",
                "term": f"{gene_symbol}[gene] AND pathogenic[Clinical_Interpretation]",
                "retmode": "json", "retmax": 25,
            })
            search = (data or {}).get("esearchresult", {})
            ids = search.get("idlist", [])
            if not ids:
                return {}

            summary = await _get(client, f"{NCBI_BASE}/esummary.fcgi", {
                "db": "dbvar", "id": ",".join(ids[:25]), "retmode": "json",
            })
            result = (summary or {}).get("result", {})

            variants = []
            for uid in result.get("uids", []):
                entry = result.get(str(uid)) or {}
                accession = entry.get("sv") or entry.get("st")
                if not accession:
                    continue
                # GRCh37 on purpose, not whichever placement happened to come
                # first. dbVar returns both builds for most records — and
                # BRCA1 sits ~1.85 Mb apart between them — so drawing a mix of
                # assemblies on one axis would scatter variants across a region
                # they do not occupy. GRCh37 is the complete set here (every
                # record carries it, only some carry GRCh38), it matches
                # `gene_locus_grch37`, and it is the build consumer DNA files
                # use, so a reader's own variants can share the axis later.
                # Assembly strings carry patch suffixes ("GRCh38.p12"), hence
                # the prefix match.
                placements = [p for p in (entry.get("dbvarplacementlist") or []) if p.get("chr")]
                placement = next(
                    (p for p in placements if str(p.get("assembly", "")).startswith("GRCh37")),
                    None,
                )
                if placement is None:
                    # Nothing to draw against, but the variant is still real —
                    # it is reported without coordinates rather than dropped.
                    placement = placements[0] if placements else {}
                start, end = placement.get("chr_start"), placement.get("chr_end")
                span = (end - start + 1) if isinstance(start, int) and isinstance(end, int) else None
                vtype = (entry.get("dbvarvarianttypelist") or [None])[0]
                # dbVar's clinical filter admits single-base events, and a 1 bp
                # insertion under a heading that promises deletions and
                # duplications is simply wrong. 50 bp is the conventional lower
                # bound for a structural variant; copy-number calls qualify on
                # type regardless of the span recorded.
                is_copy_number = vtype and ("copy number" in vtype.lower() or "duplication" in vtype.lower())
                if not is_copy_number and (span is None or span < SV_MIN_SPAN_BP):
                    continue
                variants.append({
                    "accession": accession,
                    "variant_type": (entry.get("dbvarvarianttypelist") or [None])[0],
                    "clinical_significance": entry.get("dbvarclinicalsignificancelist") or [],
                    "chromosome": placement.get("chr"),
                    "start": start,
                    "end": end,
                    "assembly": placement.get("assembly"),
                    # What a reader actually wants from a structural variant:
                    # how much of the gene it removes or duplicates.
                    "span_bp": span,
                    "url": f"https://www.ncbi.nlm.nih.gov/dbvar/variants/{accession}/",
                })

            if not variants:
                return {}
            variants.sort(key=lambda v: v.get("span_bp") or 0, reverse=True)
            return {
                # The search total counts what dbVar matched before the size
                # filter above, so report the kept count as the honest figure.
                "total": len(variants),
                "matched": int(search.get("count") or len(variants)),
                "variants": variants,
                "source": "dbVar",
            }
    except Exception as e:
        logger.warning(f"dbVar fetch failed for {gene_symbol}: {e}")
        return {}


# How many diseases to expand into their phenotypes and gene lists. Each costs
# one request, and past half a dozen the picture stops being legible anyway.
DISEASE_NETWORK_MAX = 6
# Phenotypes per disease. HPO annotates some diseases with well over a hundred
# terms, most of them rare; the frequency ordering below puts the ones that
# actually characterise the condition first.
DISEASE_PHENOTYPE_MAX = 14

# HPO frequency vocabulary, most common first. A phenotype seen in nearly every
# patient and one seen occasionally are very different claims, and sorting on
# this is what keeps the common ones visible.
HPO_FREQUENCY_ORDER = {
    "Obligate": 0, "Very frequent": 1, "Frequent": 2,
    "Occasional": 3, "Very rare": 4, "Excluded": 5,
}


async def _hpo_annotation(client: httpx.AsyncClient, curie: str) -> dict:
    data = await _get(client, f"{HPO_ANNOTATION_BASE}/network/annotation/{curie}")
    return data if isinstance(data, dict) else {}


async def fetch_disease_network(gene_symbol: str) -> dict:
    """The gene's diseases, the phenotypes those cause, and the other genes
    behind the same conditions.

    This is the one fetcher that assembles a *graph* rather than a list, and it
    only became possible once HPO, Monarch and ClinGen were repaired. They all
    speak MONDO, which is the join that lets a disease named by one source be
    recognised as the same disease by another — without it this would be string
    matching on disease names, which is how "Breast cancer" and
    "BREAST-OVARIAN CANCER, FAMILIAL, SUSCEPTIBILITY TO, 1" become two things.

    The genuinely non-obvious edge is disease -> gene: the other genes causing a
    condition this gene causes. For BRCA1 that surfaces ATM, RAD51C and PTEN,
    which is a real clinical grouping and not something any single-gene view
    shows.
    """
    try:
        async with httpx.AsyncClient() as client:
            gene_id = await resolve_ncbi_gene_id(gene_symbol, client)
            if not gene_id:
                return {}

            root = await _hpo_annotation(client, f"NCBIGene:{gene_id}")
            diseases = [d for d in (root.get("diseases") or []) if d.get("id")]
            if not diseases:
                return {}

            # ClinGen supplies the evidence strength and inheritance mode, keyed
            # by MONDO. Fetched once and joined, rather than per disease.
            validity = {}
            for curation in await fetch_clingen_validity(gene_symbol):
                if curation.get("mondo_id"):
                    validity[curation["mondo_id"]] = curation

            # Rank before capping, or the cap decides the answer. HPO returns
            # diseases in no useful order: for CFTR it lists hereditary
            # pancreatitis and aquagenic keratoderma ahead of cystic fibrosis,
            # so taking the first six omitted the condition the gene is known
            # for. Expert-curated gene-disease pairs come first, strongest
            # evidence leading, and everything else keeps its original order
            # behind them.
            def rank(disease):
                curated = validity.get(disease.get("mondoId"))
                if not curated:
                    return (1, 99)
                try:
                    return (0, CLINGEN_VALIDITY_ORDER.index(curated["classification"]))
                except ValueError:
                    return (0, 98)

            diseases.sort(key=rank)

            # One condition reaches HPO through several nomenclatures — CFTR
            # arrives with both an OMIM and an Orphanet entry for cystic
            # fibrosis, which is exactly the duplication MONDO exists to
            # resolve. Dedupe on it, keeping the higher-ranked entry, and fall
            # back to the name where no MONDO id is offered.
            seen_disease = set()
            unique = []
            for d in diseases:
                key = d.get("mondoId") or (d.get("name") or "").strip().lower()
                if not key or key in seen_disease:
                    continue
                seen_disease.add(key)
                unique.append(d)
            diseases = unique

            expanded = await asyncio.gather(
                *[_hpo_annotation(client, d["id"]) for d in diseases[:DISEASE_NETWORK_MAX]],
                return_exceptions=True,
            )

            out_diseases = []
            gene_hits: dict[str, list[str]] = {}

            for disease, detail in zip(diseases[:DISEASE_NETWORK_MAX], expanded):
                if isinstance(detail, Exception):
                    detail = {}
                mondo = disease.get("mondoId")
                curated = validity.get(mondo) or {}

                phenotypes = []
                for category, terms in (detail.get("categories") or {}).items():
                    for term in terms or []:
                        if not term.get("id"):
                            continue
                        frequency = ((term.get("metadata") or {}).get("frequency") or "").strip()
                        phenotypes.append({
                            "id": term["id"],
                            "name": term.get("name") or term["id"],
                            "category": category,
                            "frequency": frequency or None,
                        })
                phenotypes.sort(key=lambda p: (
                    HPO_FREQUENCY_ORDER.get(p["frequency"], 9), p["name"],
                ))

                others = []
                for g in (detail.get("genes") or []):
                    symbol = (g.get("name") or "").strip()
                    if not symbol or symbol.upper() == gene_symbol.upper():
                        continue
                    others.append(symbol)
                    gene_hits.setdefault(symbol, []).append(
                        disease.get("name") or disease["id"]
                    )

                out_diseases.append({
                    "id": disease["id"],
                    "mondo_id": mondo,
                    "name": disease.get("name") or disease["id"],
                    "description": (detail.get("disease") or {}).get("description"),
                    # Present only where ClinGen has curated this gene-disease
                    # pair; absent is meaningfully different from "no evidence".
                    "classification": curated.get("classification"),
                    "inheritance": curated.get("moi"),
                    "phenotypes": phenotypes[:DISEASE_PHENOTYPE_MAX],
                    "phenotype_total": len(phenotypes),
                    "genes": sorted(others)[:20],
                    "gene_total": len(others),
                    "url": f"https://hpo.jax.org/browse/disease/{disease['id']}",
                })

            related = [
                {"symbol": symbol, "shared_diseases": names, "count": len(names)}
                for symbol, names in gene_hits.items()
            ]
            related.sort(key=lambda g: (-g["count"], g["symbol"]))

            # Conditions beyond the ones expanded above. Named but not detailed,
            # so consolidating this section with the old phenotypes panel does
            # not quietly narrow what a reader is told exists.
            also = [
                {"id": d["id"], "name": d.get("name") or d["id"], "mondo_id": d.get("mondoId")}
                for d in diseases[DISEASE_NETWORK_MAX:]
            ]

            if not out_diseases:
                return {}
            return {
                "gene": gene_symbol,
                "diseases": out_diseases,
                "also_linked": also[:20],
                "disease_total": len(diseases),
                "related_genes": related[:24],
                "source": "HPO / ClinGen",
            }
    except Exception as e:
        logger.warning(f"Disease network fetch failed for {gene_symbol}: {e}")
        return {}


async def fetch_medgen_concepts(gene_symbol: str) -> dict:
    """Curated medical-genetics concepts linked to a gene, from MedGen.

    Reached by elink rather than a text search: a search for "BRCA1" matches
    concepts that merely mention it, while the link is the curated assertion.
    """
    try:
        async with httpx.AsyncClient() as client:
            gene_id = await resolve_ncbi_gene_id(gene_symbol, client)
            if not gene_id:
                return {}
            ids = await elink_ids("gene", "medgen", gene_id, client, limit=20)
            if not ids:
                return {}

            summary = await _get(client, f"{NCBI_BASE}/esummary.fcgi", {
                "db": "medgen", "id": ",".join(ids[:20]), "retmode": "json",
            })
            result = (summary or {}).get("result", {})

            concepts = []
            for uid in result.get("uids", []):
                entry = result.get(str(uid)) or {}
                title = entry.get("title")
                # Both fields arrive either as a plain string or as
                # {"value": ...} depending on the record.
                if isinstance(title, dict):
                    title = title.get("value")
                definition = entry.get("definition")
                if isinstance(definition, dict):
                    definition = definition.get("value")
                if not title:
                    continue
                cui = entry.get("conceptid")
                concepts.append({
                    "concept_id": cui,
                    "name": str(title).strip(),
                    "definition": (str(definition).strip() or None) if definition else None,
                    "semantic_type": entry.get("semantictype") or None,
                    "url": f"https://www.ncbi.nlm.nih.gov/medgen/{uid}",
                })

            if not concepts:
                return {}
            return {"concepts": concepts, "source": "MedGen"}
    except Exception as e:
        logger.warning(f"MedGen fetch failed for {gene_symbol}: {e}")
        return {}


async def fetch_pmc_articles(gene_symbol: str, limit: int = 10) -> dict:
    """Recent open-access full-text articles from PubMed Central.

    PubMed gives abstracts behind a mix of paywalls; PMC entries are readable
    in full, which is the difference that matters to someone following up.
    """
    try:
        async with httpx.AsyncClient() as client:
            data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", {
                "db": "pmc", "term": f"{gene_symbol}[title]",
                "retmode": "json", "retmax": limit, "sort": "pub_date",
            })
            search = (data or {}).get("esearchresult", {})
            ids = search.get("idlist", [])
            if not ids:
                return {}

            summary = await _get(client, f"{NCBI_BASE}/esummary.fcgi", {
                "db": "pmc", "id": ",".join(ids[:limit]), "retmode": "json",
            })
            result = (summary or {}).get("result", {})

            articles = []
            for uid in result.get("uids", []):
                entry = result.get(str(uid)) or {}
                title = (entry.get("title") or "").strip()
                if not title:
                    continue
                authors = [a.get("name") for a in (entry.get("authors") or []) if a.get("name")]
                articles.append({
                    "pmcid": f"PMC{uid}",
                    "title": title,
                    "journal": entry.get("fulljournalname") or entry.get("source") or None,
                    "pubdate": entry.get("pubdate") or entry.get("epubdate") or None,
                    "authors": authors[:4],
                    "author_count": len(authors),
                    "url": f"https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{uid}/",
                })

            if not articles:
                return {}
            return {
                "total": int(search.get("count") or len(articles)),
                "articles": articles,
                "source": "PMC",
            }
    except Exception as e:
        logger.warning(f"PMC fetch failed for {gene_symbol}: {e}")
        return {}


# OMIM is deliberately absent — see DISCONNECTED_SECTIONS below.
OPTIONAL_SECTIONS = {
    "pathways":             "Biological pathways",
    "expression":           "Tissue expression",
    "interactions":         "Protein interactions",
    "drugs":                "Drugs & clinical trials",
    "pharmgkb":             "Pharmacogenomics",
    "cancer_mutations":     "Somatic cancer mutations",
    "clingen":              "ClinGen gene-disease validity",
    "publication_timeline": "Publication trend",
    "gwas":                 "GWAS trait associations",
    "structural_variants":  "Structural variants (deletions & duplications)",
    "genetic_tests":        "Available clinical tests",
    "medgen":               "Medical genetics concepts",
    "full_text":            "Open-access full-text papers",
    "disease_network":      "Diseases, phenotypes & related genes",
    "clinical_trials":      "Clinical trials naming this gene",
    "panels":               "Diagnostic gene panels (NHS)",
}

# Sections whose fetcher returns a dict rather than a list. Getting this wrong
# hands the frontend `[]` where it expects `{}`, which renders as a silently
# missing panel rather than an error, so it is kept next to the registry.
DICT_SECTIONS = {
    "omim", "pharmgkb", "cancer_mutations",
    "structural_variants", "genetic_tests", "medgen", "full_text",
    "disease_network",
}

# Sources fetched by this module but not offered to readers.
#
# `omim` is disconnected over commercial licensing, not quality: OMIM is free
# for academic and research use, and a paid product plausibly needs a licence
# from Johns Hopkins. See legal/data-source-licensing.md.
#
# Measured before removing it, so the cost is known rather than assumed: across
# BRCA1, CFTR, LDLR, HFE, TP53 and RYR1, OMIM named three disease terms that
# ClinGen, Monarch, HPO and MedGen did not already cover between them, and
# populated an inheritance mode for 2 of 30 phenotypes where ClinGen supplied
# one for every gene. What is actually lost is MIM numbers as identifiers.
#
# `fetch_omim_data` and its tests are kept intact. Re-enabling means restoring
# two things, both in this file: the key in OPTIONAL_SECTIONS and the entry in
# the `simple` dispatch map inside fetch_gene_section. The frontend is left
# untouched on purpose — its panel and section key still exist so that answers
# already stored in the database, which contain OMIM data, keep replaying.
DISCONNECTED_SECTIONS = {"omim", "phenotypes"}


def _safe(val):
    return val if not isinstance(val, Exception) and val is not None else None


async def fetch_gene_section(gene_symbol: str, section: str, uniprot_accession: Optional[str] = None,
                             ensembl_id: Optional[str] = None) -> dict:
    """Fetch one optional section. Returns the keys that section contributes."""
    if section == "structure":
        if not uniprot_accession:
            info = await fetch_uniprot_info(gene_symbol)
            uniprot_accession = (info or {}).get("accession")
        if not uniprot_accession:
            return {"alphafold": None, "domains": []}
        af, dom = await asyncio.gather(
            fetch_alphafold_structure(uniprot_accession),
            fetch_protein_domains(uniprot_accession),
            return_exceptions=True,
        )
        return {"alphafold": _safe(af), "domains": _safe(dom) or []}

    if section == "drugs":
        if not ensembl_id:
            info = await lookup_gene_ensembl(gene_symbol)
            ensembl_id = (info or {}).get("id", "")
        all_drugs = _safe(await fetch_open_targets_drugs(ensembl_id)) or []
        stages: dict[str, int] = {}
        for d in all_drugs:
            stages[d["phase_label"]] = stages.get(d["phase_label"], 0) + 1
        # `drugs` stays a list so answers already in the database still render.
        return {"drugs": all_drugs[:25], "drug_stages": stages, "drug_total": len(all_drugs)}

    # "phenotypes" is deliberately unreachable: it drew on the same HPO data
    # that `disease_network` now presents organised by disease, so offering
    # both charged twice for one body of evidence. fetch_hpo_terms and
    # fetch_monarch_associations remain, tested, for whenever they are wanted
    # again; the frontend panel is likewise left in place so stored answers
    # containing hpo/monarch data still replay.

    simple = {
        "pathways": fetch_reactome_pathways,
        "expression": fetch_gtex_expression,
        "interactions": fetch_string_interactions,
        # "omim": fetch_omim_data — withheld here as well as from
        # OPTIONAL_SECTIONS, so /gene/section cannot reach it by being asked
        # directly. Restoring this line and the registry key re-enables it.
        "pharmgkb": fetch_pharmgkb_data,
        "cancer_mutations": fetch_cancer_mutations,
        "clingen": fetch_clingen_validity,
        "publication_timeline": fetch_pubmed_timeline,
        "gwas": fetch_gwas_associations,
        "structural_variants": fetch_structural_variants,
        "genetic_tests": fetch_genetic_tests,
        "medgen": fetch_medgen_concepts,
        "full_text": fetch_pmc_articles,
        "disease_network": fetch_disease_network,
        "clinical_trials": fetch_clinical_trials,
        "panels": fetch_gene_panels,
    }
    fn = simple.get(section)
    if not fn:
        raise ValueError(f"Unknown section: {section}")
    try:
        result = await fn(gene_symbol)
    except Exception as e:
        logger.warning(f"Section {section} failed for {gene_symbol}: {e}")
        result = None
    empty = {} if section in DICT_SECTIONS else []
    return {section: result if result is not None else empty}


def section_has_data(payload: dict) -> bool:
    """True if a fetched section actually contains anything worth showing."""
    for v in (payload or {}).values():
        if isinstance(v, (list, tuple, dict)):
            if len(v) > 0:
                return True
        elif v:
            return True
    return False


SECTION_SOURCE = {
    "structure": "AlphaFold", "pathways": "Reactome", "expression": "GTEx",
    "interactions": "STRING", "drugs": "OpenTargets", "omim": "OMIM",
    "pharmgkb": "ClinPGx", "cancer_mutations": "COSMIC/GDC", "clingen": "ClinGen",
    "publication_timeline": "PubMed", "gwas": "GWAS Catalog", "phenotypes": "HPO",
    "structural_variants": "dbVar", "genetic_tests": "GTR", "medgen": "MedGen",
    "full_text": "PMC", "disease_network": "HPO / ClinGen",
    "clinical_trials": "ClinicalTrials.gov", "panels": "Genomics England PanelApp",
}


# How long a "this source had nothing for this gene" result is trusted before
# the option is offered again. Upstream databases gain entries over time, so a
# negative must expire — otherwise a section that later acquires data stays
# hidden forever. Short enough to recover quickly, long enough that a reader
# clicking around does not keep meeting the same dead card.
EMPTY_SECTION_TTL_HOURS = 6


def section_cache_key(gene_symbol: str, section: str) -> str:
    return f"__section__:{gene_symbol.upper()}:{section}"


def empty_sections_for(gene_symbol: str) -> set:
    """Sections known — recently — to hold nothing for this gene.

    Derived from the section cache rather than a separate registry, so there is
    one expiry to reason about and a negative cannot outlive its own evidence.
    """
    from services.cache import cache
    out = set()
    for key in OPTIONAL_SECTIONS:
        cached = cache.get(section_cache_key(gene_symbol, key))
        if cached is not None and not section_has_data(cached):
            out.add(key)
    return out


async def run_gene_pipeline(gene_symbol: str, population: Optional[str] = None,
                            staged: bool = False) -> dict:
    """Fetch gene data.

    staged=True returns only the core sections and advertises the rest in
    `pending_sections`, for the caller to request individually.
    """
    failures = begin_source_tracking()
    ensembl_info, variants, frequencies, uniprot_info, pub_count = await asyncio.gather(
        lookup_gene_ensembl(gene_symbol),
        fetch_clinvar_variants(gene_symbol),
        fetch_gnomad_frequencies(gene_symbol, population),
        fetch_uniprot_info(gene_symbol),
        fetch_pubmed_count(gene_symbol),
        return_exceptions=True
    )

    def safe(val):
        return val if not isinstance(val, Exception) else None

    results = []
    variant_list = safe(variants) or []
    freq_list = safe(frequencies) or []

    freq_map = {f["variant_id"]: f for f in freq_list if f.get("variant_id")}
    for v in variant_list:
        v_dict = v.dict()
        if v.variant_id in freq_map:
            freq_entry = freq_map[v.variant_id]
            v_dict["frequency"] = freq_entry.get("allele_frequency")
            v_dict["population_frequency"] = freq_entry.get("population_frequency")
            v_dict["all_population_frequencies"] = freq_entry.get("all_population_frequencies", {})
        results.append(v_dict)

    if not results and freq_list:
        for f in freq_list:
            results.append({
                "variant_id": f.get("variant_id"),
                "gene": gene_symbol,
                "consequence": f.get("consequence"),
                "frequency": f.get("allele_frequency"),
                "source": "gnomAD"
            })

    uniprot_safe = safe(uniprot_info)
    ensembl_safe = safe(ensembl_info)
    ensembl_id = (ensembl_safe or {}).get("id", "")
    accession = (uniprot_safe or {}).get("accession")

    # AlphaFold + domains ride along in core: neither touches NCBI, so they add
    # no rate-limit pressure, and the 3D view is what the reader most wants to see.
    # The GRCh37 locus rides along for the same reason: it is an Ensembl call,
    # and it is what lets the browser work out which of a reader's own uploaded
    # variants fall inside this gene without any of them leaving the device.
    #
    # MedlinePlus and the gnomAD constraint ride along too, for a different
    # reason: both are cheap, and both exist to be *in the prompt* rather than
    # only on the page. The plain-language summary gives the explanation an
    # authoritative wording to build on instead of inventing one, and the
    # constraint reframes every variant below it — "pathogenic" means something
    # different in a gene the population cannot afford to break.
    pop_summary, structure, locus37, plain, constraint = await asyncio.gather(
        _gather_one(fetch_gnomad_population_summary(gene_symbol)),
        _gather_one(fetch_gene_section(gene_symbol, "structure", accession, ensembl_id)),
        _gather_one(fetch_gene_locus_grch37(gene_symbol)),
        _gather_one(fetch_medlineplus_summary(gene_symbol)),
        _gather_one(fetch_gnomad_constraint(gene_symbol)),
        return_exceptions=True,
    )
    pop_summary = safe(pop_summary) or []
    structure = safe(structure) or {}
    locus37 = safe(locus37)
    plain = safe(plain) or {}
    constraint = safe(constraint) or {}

    core = {
        "gene_info": ensembl_safe,
        "protein_info": uniprot_safe,
        "publication_count": safe(pub_count) or 0,
        "variants": results,
        "population_summary": pop_summary,
        "alphafold": structure.get("alphafold"),
        "domains": structure.get("domains", []),
        # GRCh37 — the build 23andMe and AncestryDNA report in. Named for the
        # assembly so no caller can mistake it for the GRCh38 coordinates in
        # `gene_info`, which are ~1.85 Mb away at BRCA1.
        "gene_locus_grch37": locus37,
        # Plain-language gene description, written for patients by the NLM.
        "plain_summary": plain,
        # How badly the population tolerates this gene being broken.
        "constraint": constraint,
        # identifiers the section endpoint needs, so it need not re-resolve them
        "_uniprot_accession": accession,
        "_ensembl_id": ensembl_id,
        "gene_symbol": gene_symbol,
    }
    core_sources = list(filter(None, [
        "AlphaFold" if structure.get("alphafold") else None,
        "MedlinePlus" if plain else None,
        "gnomAD constraint" if constraint else None,
        "Ensembl" if ensembl_safe else None,
        "ClinVar" if variant_list else None,
        "gnomAD" if (freq_list or pop_summary) else None,
        "UniProt" if uniprot_safe else None,
        "PubMed",
    ]))

    if staged:
        core["sources"] = core_sources
        # Which upstreams could not be reached, so a caller can tell "this gene
        # has no variants" from "ClinVar was down when we asked".
        core["unavailable_sources"] = sorted(failures)
        # Sections already discovered to be empty for this gene are not offered
        # again — a card that costs a credit and returns nothing is worse than
        # no card at all.
        known_empty = empty_sections_for(gene_symbol)
        core["pending_sections"] = [
            {"key": k, "label": v, "source": SECTION_SOURCE.get(k, "")}
            for k, v in OPTIONAL_SECTIONS.items()
            if k not in known_empty
        ]
        return core

    # Unstaged: fetch everything, preserving the original response shape.
    keys = list(OPTIONAL_SECTIONS)
    fetched = await asyncio.gather(
        *[fetch_gene_section(gene_symbol, k, accession, ensembl_id) for k in keys],
        return_exceptions=True,
    )
    merged = dict(core)
    extra_sources = []
    for key, res in zip(keys, fetched):
        if isinstance(res, Exception):
            continue
        merged.update(res)
        if any(res.values()):
            src = SECTION_SOURCE.get(key)
            if src:
                extra_sources.append(src)
    merged.setdefault("hpo", {})
    merged.setdefault("monarch", {})
    merged["sources"] = core_sources + [s for s in extra_sources if s not in core_sources]
    merged["unavailable_sources"] = sorted(failures)
    merged["pending_sections"] = []
    return merged


async def _gather_one(coro):
    try:
        return await coro
    except Exception:
        return None


# How many genes to offer as follow-ups. The list is already ranked by
# publication volume, so the first few are the ones worth reading about.
DISEASE_FOLLOWUP_GENES = 6


async def run_disease_pipeline(disease_name: str, staged: bool = False) -> dict:
    failures = begin_source_tracking()
    genes = await fetch_disease_genes(disease_name)
    gene_dicts = [g.dict() for g in genes]

    result = {
        "disease": disease_name,
        "genes": gene_dicts,
        "gene_count": len(gene_dicts),
        "sources": ["NCBI", "PubMed"] if gene_dicts else [],
        "unavailable_sources": sorted(failures),
        "pending_sections": [],
    }

    if not staged:
        return result

    # A disease answer has no eleven datasets to defer — it has a list of genes,
    # and the useful next step is reading about one of them. These are offered as
    # follow-up questions rather than data fetches: asking about a gene runs the
    # whole gene pipeline and renders through the path that already exists, which
    # is both better than a cut-down inline panel and far less code.
    result["pending_sections"] = [
        {
            "key": f"ask:{g['gene_symbol']}",
            "label": f"{g['gene_symbol']} in depth",
            "source": f"{g['publication_count']:,} publications" if g.get("publication_count")
                      else (g.get("description") or "")[:48],
            "ask": f"{g['gene_symbol']} variants",
        }
        for g in gene_dicts[:DISEASE_FOLLOWUP_GENES]
    ]
    return result


# ── MedlinePlus Genetics ──────────────────────────────────────────────────────

async def fetch_medlineplus_summary(gene_symbol: str) -> dict:
    """A plain-language description of the gene, written for patients by the NLM.

    The one source here that is not aimed at specialists. Everything else —
    ClinVar, gnomAD, UniProt — describes a gene to someone who already knows
    what a gene is. MedlinePlus writes "the BRCA1 gene provides instructions for
    making a protein that acts as a tumor suppressor", which is the register
    MyDNA wants and cannot reliably get by asking a model to simplify: a
    paraphrase is the model's words, and this is a citable source's.

    Fetched into the core response rather than offered as an optional section,
    because its main job is to be *in the prompt* — giving the explanation an
    authoritative plain phrasing to build on instead of inventing one. One fast
    call, typically under 300 ms.

    Coverage is partial. MedlinePlus writes these by hand for genes with
    established clinical relevance, so a gene with no page is normal and not an
    error; the pipeline simply carries no summary for it.
    """
    url = f"{MEDLINEPLUS_BASE}/gene/{gene_symbol.strip().lower()}.json"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            data = await _get(client, url)
        if not isinstance(data, dict) or not data.get("text-list"):
            return {}

        # The prose arrives as HTML. Tags are stripped rather than rendered:
        # this text goes into a prompt and into a plain paragraph, and letting
        # source markup through either would be a needless injection surface.
        chunks = []
        for entry in data.get("text-list") or []:
            html = ((entry or {}).get("text") or {}).get("html") or ""
            text = re.sub(r"<[^>]+>", " ", html)
            text = re.sub(r"&[a-z]+;", " ", text)
            text = re.sub(r"\s+", " ", text).strip()
            if text:
                chunks.append(text)
        summary = "\n\n".join(chunks)
        if not summary:
            return {}

        conditions = []
        for item in data.get("related-health-condition-list") or []:
            c = (item or {}).get("related-health-condition") or {}
            if c.get("name"):
                conditions.append({"name": c["name"], "url": c.get("ghr-page")})

        return {
            "gene_symbol": gene_symbol,
            "full_name": data.get("name"),
            "summary": summary[:6000],
            "conditions": conditions[:12],
            "url": data.get("ghr-page") or f"https://medlineplus.gov/genetics/gene/{gene_symbol.lower()}/",
            "source": "MedlinePlus Genetics (NLM)",
        }
    except Exception as e:
        logger.warning(f"MedlinePlus fetch failed for {gene_symbol}: {e}")
        return {}


# ── gnomAD constraint ─────────────────────────────────────────────────────────

async def fetch_gnomad_constraint(gene_symbol: str) -> dict:
    """How badly this gene tolerates being broken, across ~800k people.

    One number that reframes everything else on the page. A LOEUF of 0.2 says
    loss-of-function variants are almost absent from the population, so the gene
    is probably essential and a truncating variant in it is a big deal. A LOEUF
    near 1 says the population carries them freely, and the same variant means
    much less.

    Without this a reader sees "pathogenic" and "uncertain significance" with no
    sense of the gene's baseline. It costs one GraphQL call against a host the
    pipeline already uses.

    pLI is kept because it is what most literature quotes, but LOEUF is the
    better measure and gnomAD says so: pLI saturates at 1 for anything even
    moderately constrained, while LOEUF stays continuous and carries a
    confidence interval.
    """
    query = """
    query Constraint($symbol: String!) {
      gene(gene_symbol: $symbol, reference_genome: GRCh38) {
        gnomad_constraint { pli oe_lof oe_lof_upper oe_mis exp_lof obs_lof }
      }
    }"""
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await client.post(GNOMAD_BASE, json={"query": query, "variables": {"symbol": gene_symbol}},
                                  timeout=TIMEOUT, headers=HEADERS)
            if r.status_code != 200:
                return {}
            payload = r.json()
        # GraphQL answers 200 with an errors array; see the upstream-drift note.
        if payload.get("errors"):
            logger.warning("gnomAD constraint errors for %s: %s", gene_symbol, payload["errors"][:1])
            return {}
        c = (((payload.get("data") or {}).get("gene") or {}).get("gnomad_constraint")) or {}
        loeuf = c.get("oe_lof_upper")
        if loeuf is None and c.get("pli") is None:
            return {}

        # gnomAD's own guidance: the most constrained decile is LOEUF < 0.35.
        if loeuf is None:
            tolerance = None
        elif loeuf < 0.35:
            tolerance = "highly intolerant"
        elif loeuf < 0.6:
            tolerance = "intolerant"
        elif loeuf < 1.0:
            tolerance = "moderately tolerant"
        else:
            tolerance = "tolerant"

        return {
            "gene_symbol": gene_symbol,
            "pli": c.get("pli"),
            "loeuf": loeuf,
            "oe_lof": c.get("oe_lof"),
            "oe_mis": c.get("oe_mis"),
            "observed_lof": c.get("obs_lof"),
            "expected_lof": c.get("exp_lof"),
            "tolerance": tolerance,
            "source": "gnomAD v4 constraint",
        }
    except Exception as e:
        logger.warning(f"gnomAD constraint failed for {gene_symbol}: {e}")
        return {}


# ── ClinicalTrials.gov ────────────────────────────────────────────────────────

_TRIAL_STATUS_ORDER = {
    "RECRUITING": 0, "NOT_YET_RECRUITING": 1, "ENROLLING_BY_INVITATION": 2,
    "ACTIVE_NOT_RECRUITING": 3, "COMPLETED": 4,
}


async def fetch_clinical_trials(gene_symbol: str) -> list[dict]:
    """Trials that name this gene, recruiting ones first.

    The most actionable thing on the page and the only section that points at
    something a reader can actually do. Deliberately ordered by whether
    enrolment is open: a completed 2011 trial and one recruiting this month are
    not the same information, and sorting by relevance would mix them.

    No API key and no registration — the v2 API is open. Note the trap in v1's
    retirement: the old `/api/query/study_fields` endpoints are gone, and the
    field selector below is v2's `fields` parameter, which silently returns the
    full record if you name a field that does not exist.
    """
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            data = await _get(client, f"{CTGOV_BASE}/studies", {
                "query.term": gene_symbol,
                "pageSize": 40,
                "countTotal": "true",
            })
        studies = (data or {}).get("studies") or []
        out = []
        for st in studies:
            proto = (st or {}).get("protocolSection") or {}
            ident = proto.get("identificationModule") or {}
            status = (proto.get("statusModule") or {}).get("overallStatus") or ""
            design = proto.get("designModule") or {}
            conds = (proto.get("conditionsModule") or {}).get("conditions") or []
            nct = ident.get("nctId")
            if not nct:
                continue
            out.append({
                "nct_id": nct,
                "title": ident.get("briefTitle") or ident.get("officialTitle") or nct,
                "status": status.replace("_", " ").title(),
                "recruiting": status in ("RECRUITING", "NOT_YET_RECRUITING", "ENROLLING_BY_INVITATION"),
                "phase": ", ".join((design.get("phases") or [])) or None,
                "conditions": conds[:3],
                "enrollment": ((design.get("enrollmentInfo") or {}).get("count")),
                "url": f"https://clinicaltrials.gov/study/{nct}",
            })
        out.sort(key=lambda t: _TRIAL_STATUS_ORDER.get(
            t["status"].upper().replace(" ", "_"), 9))
        return out[:20]
    except Exception as e:
        logger.warning(f"ClinicalTrials.gov fetch failed for {gene_symbol}: {e}")
        return []


# ── Genomics England PanelApp ─────────────────────────────────────────────────

_PANEL_CONFIDENCE = {"3": "Green", "2": "Amber", "1": "Red", "0": "Red"}


async def fetch_gene_panels(gene_symbol: str) -> list[dict]:
    """Which diagnostic panels actually use this gene, and how confidently.

    Distinct from everything else here: ClinVar says a variant was seen and
    ClinGen says a gene–disease link is valid, but PanelApp says a health
    service *tests* this gene for that condition today. That is the difference
    between an association in the literature and one trusted in a clinic.

    Confidence is Genomics England's traffic light. Green means diagnostic-grade
    and reportable; amber and red are borderline or rejected, and are kept
    rather than filtered because "considered and not adopted" is a real answer
    to "is this gene used clinically".
    """
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            data = await _get(client, f"{PANELAPP_BASE}/genes/", {"entity_name": gene_symbol})
        results = (data or {}).get("results") or []
        out = []
        for entry in results:
            panel = (entry or {}).get("panel") or {}
            name = panel.get("name")
            if not name:
                continue
            conf = str(entry.get("confidence_level") or "")
            out.append({
                "panel": name,
                "panel_id": panel.get("id"),
                "confidence": _PANEL_CONFIDENCE.get(conf, "Unknown"),
                "diagnostic": conf == "3",
                "moi": entry.get("mode_of_inheritance") or None,
                "phenotypes": [p for p in (entry.get("phenotypes") or []) if p][:3],
                "version": (panel.get("version") or None),
                "url": f"https://panelapp.genomicsengland.co.uk/panels/{panel.get('id')}/" if panel.get("id") else None,
            })
        # Diagnostic-grade first; a green entry is the one that answers the
        # question a reader is really asking.
        out.sort(key=lambda p: (not p["diagnostic"], p["panel"]))
        return out[:20]
    except Exception as e:
        logger.warning(f"PanelApp fetch failed for {gene_symbol}: {e}")
        return []
