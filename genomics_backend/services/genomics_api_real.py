import httpx
import asyncio
import logging
import re
from typing import Optional
from models import VariantResult, GeneResult

logger = logging.getLogger(__name__)

ENSEMBL_BASE = "https://rest.ensembl.org"
CLINVAR_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
GNOMAD_BASE = "https://gnomad.broadinstitute.org/api"
UNIPROT_BASE = "https://rest.uniprot.org/uniprotkb"
NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
REACTOME_BASE = "https://reactome.org/ContentService"
GTEX_BASE = "https://gtexportal.org/api/v2"
STRING_BASE = "https://string-db.org/api"
OPENTARGETS_BASE = "https://api.platform.opentargets.org/api/v4/graphql"
PHARMGKB_BASE = "https://api.pharmgkb.org/v1"
GDC_BASE = "https://api.gdc.cancer.gov"
CLINGEN_BASE = "https://search.clinicalgenome.org/kb"
GWAS_BASE = "https://www.ebi.ac.uk/gwas/rest/api"
HPO_BASE = "https://hpo.jax.org/api/hpo"
MONARCH_BASE = "https://api-v3.monarchinitiative.org/v3/api"

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

            # ClinVar API returns significance in multiple possible locations
            clinsig = item.get("clinical_significance", {})
            if isinstance(clinsig, dict):
                significance = clinsig.get("description") or clinsig.get("review_status") or "Unknown"
            elif isinstance(clinsig, str) and clinsig:
                significance = clinsig
            else:
                # Try germline_classification (newer ClinVar API format)
                germline = item.get("germline_classification", {})
                if isinstance(germline, dict):
                    significance = germline.get("description") or "Unknown"
                else:
                    significance = str(germline) if germline else "Unknown"

            title = item.get("title", "")
            condition = item.get("trait_set", [{}])
            if isinstance(condition, list) and condition:
                condition_name = condition[0].get("trait_name") or condition[0].get("trait_xref", [{}])[0].get("db_name", "Unknown") if condition[0].get("trait_xref") else "Unknown"
            else:
                condition_name = item.get("condition_set", {}).get("trait_set", [{}])[0].get("trait_name", "Unknown") if isinstance(item.get("condition_set"), dict) else "Unknown"

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

            # Review status
            clinsig_obj = item.get("clinical_significance", {})
            review_status = clinsig_obj.get("review_status") if isinstance(clinsig_obj, dict) else None
            if not review_status:
                germline_obj = item.get("germline_classification", {})
                review_status = germline_obj.get("review_status") if isinstance(germline_obj, dict) else None

            variants.append(VariantResult(
                variant_id=f"VCV{uid}",
                gene=gene_symbol,
                clinical_significance=significance,
                condition=condition_name,
                consequence=title.split(" ")[0] if title else None,
                hgvs=hgvs,
                protein_position=protein_position,
                review_status=review_status,
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


async def fetch_reactome_pathways(gene_symbol: str) -> list[dict]:
    """Fetch biological pathways for a gene from Reactome."""
    async with httpx.AsyncClient() as client:
        # Map gene symbol to Reactome identifier
        search_url = f"{REACTOME_BASE}/search/query"
        search_data = await _get(client, search_url, {
            "query": gene_symbol,
            "species": "Homo sapiens",
            "types": "Protein",
            "cluster": "true",
        })
        if not search_data:
            return []

        # Extract UniProt accession from results
        accession = None
        results = search_data.get("results", [])
        for group in results:
            for entry in group.get("entries", []):
                if entry.get("species") == "Homo sapiens":
                    accession = entry.get("stId") or entry.get("id")
                    break
            if accession:
                break

        if not accession:
            return []

        # Get pathways for this entity
        pathway_url = f"{REACTOME_BASE}/data/pathways/low/entity/{accession}/allForms"
        pathways_raw = await _get(client, pathway_url, {})
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
    """Fetch tissue expression data from GTEx."""
    async with httpx.AsyncClient() as client:
        data = await _get(client, f"{GTEX_BASE}/expression/geneExpression", {
            "tissueSiteDetailId": "all",
            "gencodeId": "",
            "geneSymbol": gene_symbol,
            "datasetId": "gtex_v8",
        })
        if not data:
            return []

        expressions = data.get("data", []) if isinstance(data, dict) else []
        results = []
        for item in expressions:
            tissue = item.get("tissueSiteDetail") or item.get("tissueSiteDetailId", "")
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
            "caller_identity": "genomechat",
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
            "caller_identity": "genomechat",
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


async def fetch_open_targets_drugs(ensembl_id: str) -> list[dict]:
    """Fetch approved and investigational drugs targeting a gene via Open Targets."""
    if not ensembl_id:
        return []
    query = """
    query KnownDrugs($ensemblId: String!) {
      target(ensemblId: $ensemblId) {
        knownDrugs {
          count
          rows {
            drug {
              id
              name
              drugType
              maximumClinicalTrialPhase
              isApproved
            }
            mechanismOfAction
            disease {
              name
            }
            phase
            status
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
                return []
            data = response.json()
            rows = (data.get("data", {}).get("target", {}) or {}).get("knownDrugs", {}).get("rows") or []

            seen = set()
            drugs = []
            for row in rows:
                drug = row.get("drug") or {}
                name = drug.get("name", "").strip()
                if not name or name in seen:
                    continue
                seen.add(name)
                drugs.append({
                    "name": name,
                    "drug_type": drug.get("drugType", ""),
                    "phase": row.get("phase") or drug.get("maximumClinicalTrialPhase"),
                    "is_approved": drug.get("isApproved", False),
                    "mechanism": row.get("mechanismOfAction", ""),
                    "indication": (row.get("disease") or {}).get("name", ""),
                    "status": row.get("status", ""),
                })
            return sorted(drugs, key=lambda d: (not d["is_approved"], -(d["phase"] or 0)))
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


async def fetch_omim_data(gene_symbol: str) -> dict:
    """Fetch OMIM gene entry and associated disease phenotypes via NCBI E-utilities."""
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

    def detect_inheritance(title: str) -> str | None:
        t = title.upper()
        for phrase, code in INHERITANCE_MAP.items():
            if phrase in t:
                return code
        return None

    try:
        async with httpx.AsyncClient() as client:
            # Search OMIM for this gene symbol
            search_data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", {
                "db": "omim",
                "term": f'"{gene_symbol}"[Gene/Locus Symbol]',
                "retmax": 20,
                "retmode": "json",
            })
            ids = (search_data or {}).get("esearchresult", {}).get("idlist", [])

            if not ids:
                search_data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", {
                    "db": "omim",
                    "term": f"{gene_symbol}[All Fields]",
                    "retmax": 10,
                    "retmode": "json",
                })
                ids = (search_data or {}).get("esearchresult", {}).get("idlist", [])[:10]

            if not ids:
                return {}

            summary_data = await _get(client, f"{NCBI_BASE}/esummary.fcgi", {
                "db": "omim",
                "id": ",".join(ids[:15]),
                "retmode": "json",
            })
            if not summary_data:
                return {}

            result = summary_data.get("result", {})
            uids = result.get("uids", [])

            gene_entry = None
            phenotypes = []

            for uid in uids:
                entry = result.get(str(uid), {})
                title = entry.get("title", "")
                if not title:
                    continue
                mim = str(entry.get("uid", uid))
                # mimtype: "1"=gene(*), "2"=gene+phenotype(+), "3"=phenotype(#), "4"=phenotype(%), "5"=removed
                mimtype = str(entry.get("mimtype", ""))

                item = {
                    "mim_number": mim,
                    "title": title.strip(),
                    "url": f"https://omim.org/entry/{mim}",
                    "inheritance": detect_inheritance(title),
                }

                if mimtype in ("1", "2") and not gene_entry:
                    gene_entry = item
                elif mimtype in ("3", "4"):
                    phenotypes.append(item)
                elif mimtype not in ("5",):
                    # Unknown type — include as phenotype if title looks like a disease
                    if gene_symbol.upper() not in title.upper()[:20]:
                        phenotypes.append(item)

            return {
                "gene_entry": gene_entry,
                "phenotypes": phenotypes[:12],
                "source": "OMIM",
            }
    except Exception as e:
        logger.warning(f"OMIM fetch failed for {gene_symbol}: {e}")
        return {}


async def fetch_pharmgkb_data(gene_symbol: str) -> dict:
    """Fetch pharmacogenomics data from PharmGKB — drug-gene relationships and clinical annotations."""
    LEVEL_LABELS = {
        "1A": "Highest evidence (guideline-supported)",
        "1B": "High evidence",
        "2A": "Moderate evidence (guideline gene)",
        "2B": "Moderate evidence",
        "3": "Limited evidence",
        "4": "Case reports only",
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            # Fetch gene entry
            gene_resp = await client.get(
                f"{PHARMGKB_BASE}/data/gene",
                params={"symbol": gene_symbol, "view": "max"},
                headers={"Accept": "application/json"},
            )
            if gene_resp.status_code != 200:
                return {}
            gene_json = gene_resp.json()
            gene_list = gene_json.get("data", [])
            if not gene_list:
                return {}
            gene = gene_list[0] if isinstance(gene_list, list) else gene_list
            gene_id = gene.get("id", "")

            # Related drugs from gene entry
            related_drugs = []
            for d in (gene.get("relatedChemicals") or gene.get("relatedDrugs") or [])[:20]:
                name = d.get("name", "").strip()
                if name:
                    related_drugs.append({
                        "name": name,
                        "id": d.get("id", ""),
                        "url": f"https://www.pharmgkb.org/chemical/{d.get('id', '')}",
                    })

            # Clinical annotations for this gene
            ann_resp = await client.get(
                f"{PHARMGKB_BASE}/data/clinicalAnnotation",
                params={"gene.symbol": gene_symbol, "view": "base", "pageSize": 15},
                headers={"Accept": "application/json"},
            )
            annotations = []
            if ann_resp.status_code == 200:
                ann_json = ann_resp.json()
                for ann in (ann_json.get("data") or [])[:15]:
                    drug_names = [c.get("name", "") for c in (ann.get("relatedChemicals") or ann.get("chemicals") or [])]
                    level = str(ann.get("level") or ann.get("evidenceLevel") or "")
                    variant_name = (ann.get("variant") or {}).get("name", "") or (ann.get("genotype") or "")
                    annotations.append({
                        "level": level,
                        "level_label": LEVEL_LABELS.get(level, f"Level {level}"),
                        "drugs": [n for n in drug_names if n],
                        "phenotype": ann.get("phenotypeCategory") or ann.get("phenotype") or "",
                        "variant": variant_name,
                        "url": f"https://www.pharmgkb.org/clinicalAnnotation/{ann.get('id', '')}",
                    })

            if not related_drugs and not annotations:
                return {}

            return {
                "gene_id": gene_id,
                "related_drugs": related_drugs,
                "clinical_annotations": annotations,
                "url": f"https://www.pharmgkb.org/gene/{gene_id}" if gene_id else f"https://www.pharmgkb.org/search?query={gene_symbol}",
            }
    except Exception as e:
        logger.warning(f"PharmGKB fetch failed for {gene_symbol}: {e}")
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
}


async def fetch_cancer_mutations(gene_symbol: str) -> dict:
    """Fetch somatic cancer mutation data from NCI GDC (TCGA)."""
    import json as _json
    gene_filter = {
        "op": "=",
        "content": {"field": "consequence.transcript.gene.symbol", "value": gene_symbol},
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            # Cancer type distribution
            r1 = await client.post(
                f"{GDC_BASE}/ssms",
                json={"filters": gene_filter, "facets": "case.project.project_id", "size": 0},
                headers={"Content-Type": "application/json", "Accept": "application/json"},
            )
            # Consequence type distribution
            r2 = await client.post(
                f"{GDC_BASE}/ssms",
                json={"filters": gene_filter, "facets": "consequence.transcript.consequence_type", "size": 0},
                headers={"Content-Type": "application/json", "Accept": "application/json"},
            )

            if r1.status_code != 200:
                return {}
            d1 = r1.json()

            def get_buckets(data, field):
                aggs = (data.get("data") or {}).get("aggregations") or {}
                return (aggs.get(field) or {}).get("buckets") or []

            proj_buckets = get_buckets(d1, "case.project.project_id")
            cancer_types = []
            for b in sorted(proj_buckets, key=lambda x: x.get("doc_count", 0), reverse=True)[:15]:
                pid = b.get("key", "")
                cancer_types.append({
                    "project_id": pid,
                    "cancer_type": TCGA_NAMES.get(pid, pid),
                    "mutation_count": b.get("doc_count", 0),
                })

            consequence_types = []
            if r2.status_code == 200:
                d2 = r2.json()
                for b in sorted(
                    get_buckets(d2, "consequence.transcript.consequence_type"),
                    key=lambda x: x.get("doc_count", 0), reverse=True
                )[:8]:
                    label = b.get("key", "").replace("_variant", "").replace("_", " ").title()
                    consequence_types.append({"type": label, "count": b.get("doc_count", 0)})

            if not cancer_types:
                return {}

            return {
                "cancer_types": cancer_types,
                "consequence_types": consequence_types,
                "total_mutations": sum(c["mutation_count"] for c in cancer_types),
                "source": "NCI GDC / TCGA",
            }
    except Exception as e:
        logger.warning(f"GDC cancer mutation fetch failed for {gene_symbol}: {e}")
        return {}


CLINGEN_VALIDITY_ORDER = ["Definitive", "Strong", "Moderate", "Limited", "Disputed", "Refuted", "No Reported Evidence"]


async def fetch_clingen_validity(gene_symbol: str) -> list[dict]:
    """Fetch ClinGen gene-disease validity classifications."""
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                f"{CLINGEN_BASE}/gene-validity",
                params={"geneLabel": gene_symbol, "format": "json"},
                headers={"Accept": "application/json"},
            )
            if resp.status_code != 200:
                return []
            data = resp.json()

            # ClinGen returns JSON-LD with @graph array
            entries = data.get("@graph") or data.get("gene_validity_list") or []
            if isinstance(data, list):
                entries = data

            results = []
            for entry in entries:
                classification = (entry.get("classification") or {})
                if isinstance(classification, dict):
                    class_label = classification.get("label") or classification.get("name") or str(classification)
                else:
                    class_label = str(classification)

                disease = entry.get("disease") or entry.get("condition") or {}
                disease_name = (disease.get("label") or disease.get("name") or "Unknown") if isinstance(disease, dict) else str(disease)

                moi = entry.get("moi") or entry.get("modeOfInheritance") or {}
                moi_label = (moi.get("label") or moi.get("name") or "") if isinstance(moi, dict) else str(moi)

                gcep = entry.get("affiliation") or entry.get("gcep") or {}
                gcep_name = (gcep.get("label") or gcep.get("name") or "") if isinstance(gcep, dict) else str(gcep)

                curation_id = entry.get("@id") or entry.get("id") or ""
                url = f"https://search.clinicalgenome.org/kb/gene-validity/{curation_id.split('/')[-1]}" if curation_id else "https://clinicalgenome.org"

                results.append({
                    "disease": disease_name,
                    "classification": class_label,
                    "moi": moi_label,
                    "gcep": gcep_name,
                    "url": url,
                })

            # Sort by classification strength
            def sort_key(r):
                try:
                    return CLINGEN_VALIDITY_ORDER.index(r["classification"])
                except ValueError:
                    return 99

            return sorted(results, key=sort_key)[:15]
    except Exception as e:
        logger.warning(f"ClinGen validity fetch failed for {gene_symbol}: {e}")
        return []


async def fetch_gwas_associations(gene_symbol: str) -> list[dict]:
    """Fetch GWAS Catalog trait associations for a gene."""
    results = []
    try:
        async with httpx.AsyncClient() as client:
            # Search associations by gene name
            url = f"{GWAS_BASE}/associations/search/findByGene"
            params = {"geneName": gene_symbol, "size": 50}
            headers = {"Accept": "application/json"}
            for attempt in range(MAX_RETRIES):
                try:
                    resp = await client.get(url, params=params, headers=headers, timeout=TIMEOUT)
                    if resp.status_code == 200:
                        data = resp.json()
                        break
                    elif resp.status_code == 429:
                        await asyncio.sleep(2 ** attempt)
                    else:
                        return results
                except httpx.TimeoutException:
                    await asyncio.sleep(1)
            else:
                return results

            assocs = (data.get("_embedded") or {}).get("associations", [])
            seen_traits = set()
            for a in assocs:
                # Pull trait(s)
                traits = a.get("efoTraits") or a.get("traitNames") or []
                if isinstance(traits, list):
                    trait_names = [t.get("trait") or t.get("shortForm") or str(t) for t in traits if isinstance(t, dict)]
                else:
                    trait_names = []

                if not trait_names:
                    continue

                pval_mantissa = a.get("pvalueMantissa")
                pval_exponent = a.get("pvalueExponent")
                p_value = None
                if pval_mantissa is not None and pval_exponent is not None:
                    try:
                        p_value = float(pval_mantissa) * (10 ** int(pval_exponent))
                    except Exception:
                        pass

                or_beta = a.get("orPerCopyNum") or a.get("betaNum")
                risk_allele = ""
                loci = a.get("loci") or []
                for locus in loci:
                    for ra in (locus.get("strongestRiskAlleles") or []):
                        risk_allele = ra.get("riskAlleleName", "")
                        break
                    if risk_allele:
                        break

                study = (a.get("study") or {})
                pmid = study.get("publicationInfo", {}).get("pubmedId") if isinstance(study.get("publicationInfo"), dict) else None
                study_accession = study.get("accessionId", "")

                for trait in trait_names:
                    key = (trait, risk_allele)
                    if key in seen_traits:
                        continue
                    seen_traits.add(key)
                    results.append({
                        "trait": trait,
                        "p_value": p_value,
                        "p_value_str": f"{pval_mantissa}×10⁻{abs(int(pval_exponent))}" if pval_mantissa and pval_exponent else "N/A",
                        "or_beta": float(or_beta) if or_beta else None,
                        "risk_allele": risk_allele,
                        "pmid": pmid,
                        "study_accession": study_accession,
                        "url": f"https://www.ebi.ac.uk/gwas/studies/{study_accession}" if study_accession else "https://www.ebi.ac.uk/gwas/",
                    })

            # Sort by p-value ascending (most significant first)
            results.sort(key=lambda x: x["p_value"] if x["p_value"] is not None else 1.0)
            return results[:25]
    except Exception as e:
        logger.warning(f"GWAS Catalog fetch failed for {gene_symbol}: {e}")
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

            url = f"{HPO_BASE}/gene/{gene_id}"
            headers = {"Accept": "application/json"}
            resp = await client.get(url, headers=headers, timeout=TIMEOUT)
            if resp.status_code != 200:
                return {}

            data = resp.json()

            # Collect terms with categories
            terms = []
            for t in (data.get("termAssoc") or []):
                terms.append({
                    "id": t.get("ontologyId", ""),
                    "name": t.get("name", ""),
                    "definition": t.get("definition", ""),
                    "url": f"https://hpo.jax.org/browse/term/{t.get('ontologyId', '')}",
                })

            # Collect disease associations
            diseases = []
            for d in (data.get("diseaseAssoc") or []):
                diseases.append({
                    "id": d.get("diseaseId", ""),
                    "name": d.get("diseaseName", ""),
                    "db": d.get("diseaseId", "").split(":")[0] if ":" in d.get("diseaseId", "") else "",
                })

            return {
                "gene_symbol": gene_symbol,
                "ncbi_gene_id": gene_id,
                "phenotype_terms": terms[:40],
                "disease_associations": diseases[:20],
            }
    except Exception as e:
        logger.warning(f"HPO fetch failed for {gene_symbol}: {e}")
        return {}


async def fetch_monarch_associations(gene_symbol: str, ncbi_gene_id: Optional[str] = None) -> dict:
    """Fetch Monarch Initiative disease + phenotype associations for a gene."""
    try:
        async with httpx.AsyncClient() as client:
            # Resolve NCBI gene ID if needed
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

            monarch_id = f"NCBIGene:{gene_id}"
            headers = {"Accept": "application/json"}

            # Fetch disease associations
            disease_url = f"{MONARCH_BASE}/association"
            disease_params = {
                "subject": monarch_id,
                "category": "biolink:GeneToDiseaseAssociation",
                "limit": 20,
                "offset": 0,
            }
            disease_resp = await client.get(disease_url, params=disease_params, headers=headers, timeout=TIMEOUT)
            diseases = []
            if disease_resp.status_code == 200:
                d_data = disease_resp.json()
                for item in (d_data.get("items") or []):
                    obj = item.get("object") or {}
                    pred = item.get("predicate") or ""
                    diseases.append({
                        "id": obj.get("id", ""),
                        "name": obj.get("label") or obj.get("name", ""),
                        "predicate": pred.replace("biolink:", "").replace("_", " "),
                        "url": f"https://monarchinitiative.org/disease/{obj.get('id', '')}" if obj.get("id") else "",
                    })

            # Fetch phenotype associations
            pheno_params = {
                "subject": monarch_id,
                "category": "biolink:GeneToPhenotypicFeatureAssociation",
                "limit": 30,
                "offset": 0,
            }
            pheno_resp = await client.get(disease_url, params=pheno_params, headers=headers, timeout=TIMEOUT)
            phenotypes = []
            if pheno_resp.status_code == 200:
                p_data = pheno_resp.json()
                for item in (p_data.get("items") or []):
                    obj = item.get("object") or {}
                    phenotypes.append({
                        "id": obj.get("id", ""),
                        "name": obj.get("label") or obj.get("name", ""),
                        "url": f"https://monarchinitiative.org/phenotype/{obj.get('id', '')}" if obj.get("id") else "",
                    })

            return {
                "gene_symbol": gene_symbol,
                "monarch_id": monarch_id,
                "diseases": diseases,
                "phenotypes": phenotypes,
            }
    except Exception as e:
        logger.warning(f"Monarch fetch failed for {gene_symbol}: {e}")
        return {}


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

    # Fetch all enrichment data in parallel
    alphafold_info, pathways, expression, interactions, drugs, pop_summary, omim, domains, pgkb, cancer_muts, clingen, pub_timeline, gwas, hpo, monarch = await asyncio.gather(
        fetch_alphafold_structure(uniprot_safe["accession"]) if uniprot_safe and uniprot_safe.get("accession") else asyncio.sleep(0),
        fetch_reactome_pathways(gene_symbol),
        fetch_gtex_expression(gene_symbol),
        fetch_string_interactions(gene_symbol),
        fetch_open_targets_drugs(ensembl_id),
        fetch_gnomad_population_summary(gene_symbol),
        fetch_omim_data(gene_symbol),
        fetch_protein_domains(uniprot_safe["accession"]) if uniprot_safe and uniprot_safe.get("accession") else asyncio.sleep(0),
        fetch_pharmgkb_data(gene_symbol),
        fetch_cancer_mutations(gene_symbol),
        fetch_clingen_validity(gene_symbol),
        fetch_pubmed_timeline(gene_symbol),
        fetch_gwas_associations(gene_symbol),
        fetch_hpo_terms(gene_symbol),
        fetch_monarch_associations(gene_symbol),
        return_exceptions=True
    )

    def safe2(val):
        return val if not isinstance(val, Exception) and val is not None else None

    return {
        "gene_info": ensembl_safe,
        "protein_info": uniprot_safe,
        "publication_count": safe(pub_count) or 0,
        "variants": results,
        "alphafold": safe2(alphafold_info),
        "pathways": safe2(pathways) or [],
        "expression": safe2(expression) or [],
        "interactions": safe2(interactions) or [],
        "drugs": safe2(drugs) or [],
        "population_summary": safe2(pop_summary) or [],
        "omim": safe2(omim) or {},
        "domains": safe2(domains) or [],
        "pharmgkb": safe2(pgkb) or {},
        "cancer_mutations": safe2(cancer_muts) or {},
        "clingen": safe2(clingen) or [],
        "publication_timeline": safe2(pub_timeline) or [],
        "gwas": safe2(gwas) or [],
        "hpo": safe2(hpo) or {},
        "monarch": safe2(monarch) or {},
        "sources": list(filter(None, [
            "Ensembl" if ensembl_safe else None,
            "ClinVar" if variant_list else None,
            "gnomAD" if freq_list else None,
            "UniProt" if uniprot_safe else None,
            "AlphaFold" if safe2(alphafold_info) else None,
            "Reactome" if safe2(pathways) else None,
            "GTEx" if safe2(expression) else None,
            "STRING" if safe2(interactions) else None,
            "OpenTargets" if safe2(drugs) else None,
            "OMIM" if safe2(omim) else None,
            "PharmGKB" if safe2(pgkb) else None,
            "COSMIC/GDC" if safe2(cancer_muts) else None,
            "ClinGen" if safe2(clingen) else None,
            "GWAS Catalog" if safe2(gwas) else None,
            "HPO" if safe2(hpo) else None,
            "Monarch" if safe2(monarch) else None,
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
