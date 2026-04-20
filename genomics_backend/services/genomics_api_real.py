import httpx
import asyncio
import logging
from typing import Optional
from models import VariantResult, GeneResult

logger = logging.getLogger(__name__)

ENSEMBL_BASE = "https://rest.ensembl.org"
CLINVAR_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
GNOMAD_BASE = "https://gnomad.broadinstitute.org/api"
UNIPROT_BASE = "https://rest.uniprot.org/uniprotkb"
NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

HEADERS = {"Content-Type": "application/json", "Accept": "application/json"}
TIMEOUT = 30
MAX_RETRIES = 3


async def _get(client: httpx.AsyncClient, url: str, params: dict = None) -> dict | list | None:
    for attempt in range(MAX_RETRIES):
        try:
            response = await client.get(url, params=params, timeout=TIMEOUT, headers=HEADERS)
            if response.status_code == 200:
                return response.json()
            elif response.status_code == 429:
                await asyncio.sleep(2 ** attempt)
            elif response.status_code == 404:
                return None
            else:
                logger.warning(f"HTTP {response.status_code} for {url}")
                return None
        except httpx.TimeoutException:
            logger.warning(f"Timeout on attempt {attempt + 1} for {url}")
            await asyncio.sleep(1)
        except Exception as e:
            logger.error(f"Request error for {url}: {e}")
            return None
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


async def fetch_clinvar_variants(gene_symbol: str, max_results: int = 50) -> list[VariantResult]:
    variants = []
    async with httpx.AsyncClient() as client:
        search_url = f"{CLINVAR_BASE}/esearch.fcgi"
        search_params = {
            "db": "clinvar",
            "term": f"{gene_symbol}[gene] AND clinsig_pathogenic[Properties]",
            "retmax": max_results,
            "retmode": "json",
        }
        search_data = await _get(client, search_url, search_params)
        if not search_data:
            return variants

        ids = search_data.get("esearchresult", {}).get("idlist", [])
        if not ids:
            search_params["term"] = f"{gene_symbol}[gene]"
            search_data = await _get(client, search_url, search_params)
            ids = search_data.get("esearchresult", {}).get("idlist", []) if search_data else []

        if not ids:
            return variants

        fetch_url = f"{CLINVAR_BASE}/esummary.fcgi"
        fetch_params = {
            "db": "clinvar",
            "id": ",".join(ids[:20]),
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

            clinsig = item.get("clinical_significance", {})
            if isinstance(clinsig, dict):
                significance = clinsig.get("description", "Unknown")
            else:
                significance = str(clinsig)

            title = item.get("title", "")
            condition = item.get("trait_set", [{}])
            if isinstance(condition, list) and condition:
                condition_name = condition[0].get("trait_name", "Unknown")
            else:
                condition_name = "Unknown"

            variants.append(VariantResult(
                variant_id=f"VCV{uid}",
                gene=gene_symbol,
                clinical_significance=significance,
                condition=condition_name,
                consequence=title.split(" ")[0] if title else None,
                source="ClinVar"
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

            results = []
            for v in variants_raw[:30]:
                exome = v.get("exome") or {}
                genome = v.get("genome") or {}
                af = exome.get("af") or genome.get("af")

                pop_filter = None
                if population and exome.get("populations"):
                    pop_map = {"european": "nfe", "african": "afr", "east asian": "eas", "south asian": "sas"}
                    pop_key = pop_map.get(population.lower())
                    if pop_key:
                        for pop in exome["populations"]:
                            if pop["id"] == pop_key:
                                pop_filter = pop.get("af")

                results.append({
                    "variant_id": v.get("variant_id"),
                    "consequence": v.get("consequence"),
                    "allele_frequency": af,
                    "population_frequency": pop_filter,
                    "population": population,
                    "source": "gnomAD"
                })
            return results
    except Exception as e:
        logger.warning(f"gnomAD query failed for {gene_symbol}: {e}")
        return []


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

    results = []
    result = fetch_data.get("result", {})
    for uid in result.get("uids", []):
        item = result.get(uid, {})
        if not item or item.get("status") == "discontinued":
            continue
        symbol = item.get("name", "")
        if not symbol or symbol == "1":
            continue
        pub_count = await fetch_pubmed_count(symbol)
        results.append(GeneResult(
            gene_symbol=symbol,
            gene_id=uid,
            disease_association=disease_name,
            description=item.get("description", ""),
            publication_count=pub_count,
            chromosome=item.get("chromosome", ""),
            source="NCBI"
        ))
    return results


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

        genes = []
        result = fetch_data.get("result", {})
        for uid in result.get("uids", []):
            item = result.get(uid, {})
            if not item or item.get("status") == "discontinued":
                continue
            symbol = item.get("name", "")
            if not symbol or symbol == "1":
                continue
            pub_count = await fetch_pubmed_count(symbol)
            genes.append(GeneResult(
                gene_symbol=symbol,
                gene_id=uid,
                disease_association=disease_name,
                description=item.get("description", ""),
                publication_count=pub_count,
                chromosome=item.get("chromosome", ""),
                source="NCBI"
            ))
        return sorted(genes, key=lambda g: g.publication_count or 0, reverse=True)


async def run_gene_pipeline(gene_symbol: str, population: Optional[str] = None) -> dict:
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
            v_dict["frequency"] = freq_map[v.variant_id].get("allele_frequency")
            v_dict["population_frequency"] = freq_map[v.variant_id].get("population_frequency")
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

    return {
        "gene_info": safe(ensembl_info),
        "protein_info": safe(uniprot_info),
        "publication_count": safe(pub_count) or 0,
        "variants": results,
        "sources": list(filter(None, [
            "Ensembl" if safe(ensembl_info) else None,
            "ClinVar" if variant_list else None,
            "gnomAD" if freq_list else None,
            "UniProt" if safe(uniprot_info) else None,
            "PubMed"
        ]))
    }


async def run_disease_pipeline(disease_name: str) -> dict:
    genes = await fetch_disease_genes(disease_name)
    gene_dicts = [g.dict() for g in genes]

    return {
        "disease": disease_name,
        "genes": gene_dicts,
        "gene_count": len(gene_dicts),
        "sources": ["NCBI", "PubMed"] if gene_dicts else []
    }
